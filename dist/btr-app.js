/*
 * BTR-iOS · App 模式  —  1.1.0
 *
 * 让哔哩哔哩 App（国内版 / 国际版）取视频数据时也用上“线程撕裂者”的办法：向多个 CDN 节点并行要
 * 字节块，拼好后交还给 App 的播放器。思路来自开源项目 Bilibili-thread-ripper（MIT）。
 *
 * 真机统计说明 App 的播放器是“一小段一小段地要”（约 1 MB 一次，上一段到手才要下一段）。只把
 * 这一小段拆开并行去取，省不下多少：每个连接都要重新握手、慢启动，反而比 App 自己那条热连接更慢。
 * 所以这里做的是“预读”：
 *   - App 要 [a,b]：把 [a,b] 和后面的几 MB 一起拆成很多块并行去取（一次一批，块数不超过线程数）；
 *     [a,b] 交给 App，多取的部分存进 Loon 的持久化存储（$persistentStore）；
 *   - App 接着要下一段：直接从存储里拿，几乎不用等；
 *   - 存储有上限，播放位置之前的、太旧的都会淘汰；每次预读多少按测得的整体速度自动调整。
 *   - “从 a 一直到文件末尾”（bytes=a-）的请求只答复前面一块（206 少给，Content-Range 写明范围），
 *     播放器读完会从下一个位置接着要；同一位置反复被要 → 保险丝跳闸，改回原样放行。
 *   - 任何一步出错、超时、节点不认这个地址：原样放行（$done({})），App 像没装插件一样工作。
 *
 * 统计页（Safari 打开 https://www.bilibili.com/__btr_app__/ ）还带三个小实验，告诉作者 Loon 在
 * $done 之后还让不让脚本继续跑、脚本自己发的请求会不会再触发脚本、存储能不能装下几 MB。
 *
 * 只读请求头、只搬运视频字节；不读取也不保存账号、Cookie 或播放记录，不向任何第三方发数据。
 * Generated file — edit src/ and run `node build.js` instead.
 */
var BTRA_VERSION = "1.1.0";
var BTRA_STORE_KEY = "btr_ios_app_v2";
var BTRA_CACHE_PREFIX = "btr_ios_app_c:";
var BTRA_STATUS_URL = "https://www.bilibili.com/__btr_app__/";
var BTRA_SPAWN_URL = "https://www.bilibili.com/__btr_app__/spawn";
var BTRA_MAINLAND = [
  "upos-sz-mirrorali.bilivideo.com", "upos-sz-mirrorhw.bilivideo.com", "upos-sz-mirrorbos.bilivideo.com",
  "upos-sz-mirror08c.bilivideo.com", "upos-sz-mirrorbd.bilivideo.com", "upos-sz-mirror14b.bilivideo.com",
  "upos-sz-estgoss.bilivideo.com", "upos-sz-mirrorcos.bilivideo.com"
];
var BTRA_OVERSEAS = [
  "upos-sz-mirrorcosov.bilivideo.com", "upos-sz-mirroraliov.bilivideo.com",
  "cn-hk-eq-01-01.bilivideo.com", "cn-hk-eq-01-03.bilivideo.com"
];
var BTRA_MIN_PIECE = 128 * 1024;
var BTRA_MAX_PIECE = 1024 * 1024;
var BTRA_MAX_REPLY = 8 * 1024 * 1024;
var BTRA_EXACT_LIMIT = 4 * 1024 * 1024;
var BTRA_OPEN_REPLY = 2 * 1024 * 1024;
var BTRA_DEADLINE = 14000;
var BTRA_BATCH_TARGET_MS = 2500;
var BTRA_CACHE_TTL = 10 * 60000;
var BTRA_BEHIND_KEEP = 512 * 1024;

(function btrIosAppMain() {
  "use strict";

  var request = typeof $request !== "undefined" && $request ? $request : {};
  var url = String(request.url || "");
  var startedAt = Date.now();
  var finished = false;

  /* ------------------------------------------------------------ small things */

  function header(headers, name) {
    if (!headers) return "";
    var wanted = name.toLowerCase();
    for (var key in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === wanted) return String(headers[key]);
    }
    return "";
  }

  function megabytes(value, fallback, allowOff) {
    var text = String(value === undefined || value === null ? "" : value);
    if (allowOff && /关|off|none|^0+(?:\.0+)?(?:MB)?$/i.test(text)) return 0;
    var parsed = parseFloat(text);
    return Math.round((parsed >= 0.5 && parsed <= 64 ? parsed : fallback) * 1048576);
  }

  function options() {
    var raw = typeof $argument !== "undefined" ? $argument : null;
    var map = {};
    if (raw && typeof raw === "object") map = raw;
    else if (typeof raw === "string" && raw) {
      var parts = raw.split("&");
      for (var index = 0; index < parts.length; index += 1) {
        var pair = parts[index].split("=");
        if (pair[0]) map[pair[0]] = pair.slice(1).join("=");
      }
    }
    var threads = parseInt(map.threads, 10);
    return {
      threads: threads >= 1 && threads <= 64 ? threads : 32,
      aheadBytes: megabytes(map.ahead, 4, true),
      cacheBytes: megabytes(map.cache, 8, true),
      overseas: /海外|overseas/i.test(String(map.cdn || "")),
      chunkReplies: !/放行|pass/i.test(String(map.openEnded || "")),
      notify: !(map.notify === false || map.notify === "false" || map.notify === 0 || map.notify === "0")
    };
  }

  function parseContentRange(value) {
    var match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(value || "").replace(/^\s+|\s+$/g, ""));
    if (!match) return null;
    return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
  }

  function sizeText(bytes) {
    return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.round(bytes / 1024) + " KB";
  }

  function shortHost(host) {
    return String(host).replace(/\.bilivideo\.com$/, "");
  }

  function pathKeyOf(path) {
    var hash = 2166136261;
    for (var index = 0; index < path.length; index += 1) {
      hash ^= path.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(36) + ":" + path.slice(-16).replace(/[^A-Za-z0-9._-]/g, "");
  }

  /* ------------------------------------------------------------ base64
   * The persistent store keeps strings, so cached bytes travel as base64. Written by hand: the
   * script runtime has neither atob/btoa nor Buffer.
   */

  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var B64_CODES = null;
  var B64_REVERSE = null;

  function b64tables() {
    if (B64_CODES) return;
    B64_CODES = new Uint8Array(64);
    B64_REVERSE = new Uint8Array(256);
    for (var index = 0; index < 64; index += 1) {
      B64_CODES[index] = B64.charCodeAt(index);
      B64_REVERSE[B64.charCodeAt(index)] = index;
    }
  }

  function b64encode(bytes) {
    b64tables();
    var length = bytes.length;
    var full = length - (length % 3);
    var parts = [];
    var codes = [];
    var index = 0;
    while (index < full) {
      var b0 = bytes[index], b1 = bytes[index + 1], b2 = bytes[index + 2];
      codes.push(B64_CODES[b0 >> 2], B64_CODES[((b0 & 3) << 4) | (b1 >> 4)], B64_CODES[((b1 & 15) << 2) | (b2 >> 6)], B64_CODES[b2 & 63]);
      index += 3;
      if (codes.length >= 32768) { parts.push(String.fromCharCode.apply(null, codes)); codes = []; }
    }
    if (index < length) {
      var c0 = bytes[index], c1 = index + 1 < length ? bytes[index + 1] : 0;
      codes.push(B64_CODES[c0 >> 2], B64_CODES[((c0 & 3) << 4) | (c1 >> 4)], index + 1 < length ? B64_CODES[(c1 & 15) << 2] : 61, 61);
    }
    if (codes.length) parts.push(String.fromCharCode.apply(null, codes));
    return parts.join("");
  }

  function b64decode(text) {
    b64tables();
    var length = text.length;
    while (length > 0 && text.charCodeAt(length - 1) === 61) length -= 1;
    var out = new Uint8Array(Math.floor(length * 3 / 4));
    var o = 0;
    var index = 0;
    while (index + 4 <= length) {
      var a = B64_REVERSE[text.charCodeAt(index)], b = B64_REVERSE[text.charCodeAt(index + 1)];
      var c = B64_REVERSE[text.charCodeAt(index + 2)], d = B64_REVERSE[text.charCodeAt(index + 3)];
      out[o] = (a << 2) | (b >> 4);
      out[o + 1] = ((b & 15) << 4) | (c >> 2);
      out[o + 2] = ((c & 3) << 6) | d;
      o += 3;
      index += 4;
    }
    if (index < length) {
      var a2 = B64_REVERSE[text.charCodeAt(index)], b2 = B64_REVERSE[text.charCodeAt(index + 1)];
      out[o] = (a2 << 2) | (b2 >> 4);
      o += 1;
      if (index + 2 < length) { out[o] = ((b2 & 15) << 4) | (B64_REVERSE[text.charCodeAt(index + 2)] >> 2); o += 1; }
    }
    return o === out.length ? out : out.subarray(0, o);
  }

  /* ------------------------------------------------------------ state
   * Several copies of this script run at the same time (picture and sound are separate requests),
   * each in its own JavaScript context. They share one JSON record in Loon's store. A run decides
   * on the snapshot it read at the start, notes every change it makes as an operation, and replays
   * those operations on a freshly read record right before it ends, so that runs do not wipe out
   * each other's counters. Cached bytes live under their own keys; the record only lists them.
   */

  function emptyState() {
    return { v: 2, since: Date.now(), rr: 0, totals: {}, hosts: {}, recent: [], breaker: {}, streaks: {}, notes: {}, stats: {}, cache: [], heads: {}, flags: {} };
  }

  function loadState() {
    try {
      var parsed = JSON.parse($persistentStore.read(BTRA_STORE_KEY) || "null");
      if (parsed && typeof parsed === "object" && parsed.v === 2) {
        var base = emptyState();
        for (var key in base) if (parsed[key] === undefined || parsed[key] === null) parsed[key] = base[key];
        return parsed;
      }
    } catch (_error) {}
    return emptyState();
  }

  function hostRecord(state, host) {
    return state.hosts[host] || (state.hosts[host] = { ok: 0, bad: 0, streak: 0, until: 0, benches: 0, bps: 0 });
  }

  function apply(state, op) {
    var kind = op[0];
    if (kind === "bump") state.stats[op[1]] = (state.stats[op[1]] || 0) + op[2];
    else if (kind === "set") state.stats[op[1]] = op[2];
    else if (kind === "ewma") state.stats[op[1]] = state.stats[op[1]] ? state.stats[op[1]] * 0.7 + op[2] * 0.3 : op[2];
    else if (kind === "rr") state.rr = ((state.rr || 0) + 1) % 1000000;
    else if (kind === "total") state.totals[op[1]] = { size: op[2], t: op[3], type: op[4] || "" };
    else if (kind === "recent") state.recent.push(op[1]);
    else if (kind === "breaker") state.breaker[op[1]] = op[2];
    else if (kind === "streak") state.streaks[op[1]] = op[2] === null ? 0 : (state.streaks[op[1]] || 0) + op[2];
    else if (kind === "note") state.notes[op[1]] = op[2];
    else if (kind === "flag") state.flags[op[1]] = op[2];
    else if (kind === "head") state.heads[op[1]] = { pos: op[2], t: op[3] };
    else if (kind === "cadd") state.cache.push(op[1]);
    else if (kind === "cdel") state.cache = state.cache.filter(function (entry) { return entry.k !== op[1]; });
    else if (kind === "host") {
      var item = hostRecord(state, op[1]);
      if (op[2]) {
        item.ok += 1; item.streak = 0; item.until = 0; item.benches = 0;
        if (op[4] > 0) item.bps = item.bps ? item.bps * 0.7 + op[4] * 0.3 : op[4];
      } else {
        item.bad += 1;
        item.streak += 1;
        // Two failures in a row: rest for 5 minutes, then 15, then an hour while it keeps failing.
        if (item.streak >= 2 && !(item.until > op[3])) {
          item.benches = (item.benches || 0) + 1;
          item.until = op[3] + Math.min(60, 5 * Math.pow(3, item.benches - 1)) * 60000;
        }
      }
    }
  }

  var state = null;
  var ops = [];
  var config = options();

  function change() {
    var op = Array.prototype.slice.call(arguments);
    ops.push(op);
    apply(state, op);
  }

  function evict(fresh, now) {
    var cap = config.cacheBytes;
    var keep = [];
    var dropped = [];
    for (var index = 0; index < fresh.cache.length; index += 1) {
      var entry = fresh.cache[index];
      var head = fresh.heads[entry.p];
      var stale = !(now - entry.t <= BTRA_CACHE_TTL);
      var behind = head && entry.e < head.pos - BTRA_BEHIND_KEEP;
      if (stale || behind || !cap) dropped.push(entry); else keep.push(entry);
    }
    keep.sort(function (a, b) { return a.t - b.t; });
    var total = 0;
    for (var k = 0; k < keep.length; k += 1) total += keep[k].b;
    while (total > cap && keep.length) { var oldest = keep.shift(); total -= oldest.b; dropped.push(oldest); }
    fresh.cache = keep;
    return dropped;
  }

  function commit() {
    if (!ops.length) return;
    try {
      var fresh = loadState();
      for (var index = 0; index < ops.length; index += 1) apply(fresh, ops[index]);
      ops = [];
      var now = Date.now();
      fresh.recent = fresh.recent.filter(function (entry) { return now - entry.t <= 60000; }).slice(-40);
      var names = [];
      for (var key in fresh.totals) names.push(key);
      if (names.length > 80) {
        names.sort(function (a, b) { return fresh.totals[a].t - fresh.totals[b].t; });
        for (var cut = 0; cut < names.length - 60; cut += 1) delete fresh.totals[names[cut]];
      }
      var heads = [];
      for (var headKey in fresh.heads) heads.push(headKey);
      if (heads.length > 24) {
        heads.sort(function (a, b) { return fresh.heads[a].t - fresh.heads[b].t; });
        for (var drop = 0; drop < heads.length - 16; drop += 1) delete fresh.heads[heads[drop]];
      }
      var dropped = evict(fresh, now);
      $persistentStore.write(JSON.stringify(fresh), BTRA_STORE_KEY);
      for (var d = 0; d < dropped.length; d += 1) {
        try { $persistentStore.write("", BTRA_CACHE_PREFIX + dropped[d].k); } catch (_error) {}
      }
    } catch (_error) {}
  }

  function finish(result) {
    if (finished) return;
    finished = true;
    commit();
    $done(result);
  }

  function passThrough(reason) {
    change("bump", "passed", 1);
    if (reason) change("set", "lastPass", reason);
    finish({});
  }

  function notifyOnce(key, everyMs, title, subtitle, body) {
    if (!config.notify) return;
    var now = Date.now();
    if (state.notes[key] && now - state.notes[key] < everyMs) return;
    change("note", key, now);
    try { $notification.post(title, subtitle, body); } catch (_error) {}
  }

  // Direct counters for things that happen after this run has already answered (the experiments).
  function bumpDirect(key) {
    try {
      var fresh = loadState();
      fresh.stats[key] = (fresh.stats[key] || 0) + 1;
      $persistentStore.write(JSON.stringify(fresh), BTRA_STORE_KEY);
    } catch (_error) {}
  }

  /* ------------------------------------------------------------ cache entries */

  function cacheEntries(pathKey, from, to) {
    var list = [];
    for (var index = 0; index < state.cache.length; index += 1) {
      var entry = state.cache[index];
      if (entry.p === pathKey && entry.e >= from && entry.s <= to) list.push(entry);
    }
    list.sort(function (a, b) { return a.s - b.s; });
    return list;
  }

  function readEntry(entry) {
    try {
      var text = $persistentStore.read(BTRA_CACHE_PREFIX + entry.k);
      if (typeof text !== "string" || !text) return null;
      var bytes = b64decode(text);
      if (bytes.length !== entry.b) return null;
      return bytes;
    } catch (_error) { return null; }
  }

  // Splits [from, to] into segments that are in the cache (with their bytes loaded) and gaps.
  function coverage(pathKey, from, to, load) {
    var segments = [];
    var cursor = from;
    var entries = cacheEntries(pathKey, from, to);
    for (var index = 0; index < entries.length && cursor <= to; index += 1) {
      var entry = entries[index];
      if (entry.e < cursor) continue;
      var bytes = null;
      if (load) {
        bytes = readEntry(entry);
        if (!bytes) { change("cdel", entry.k); continue; }
      }
      if (entry.s > cursor) segments.push({ s: cursor, e: Math.min(entry.s - 1, to), entry: null });
      var s = Math.max(entry.s, cursor);
      var e = Math.min(entry.e, to);
      segments.push({ s: s, e: e, entry: entry, bytes: bytes ? bytes.subarray(s - entry.s, e - entry.s + 1) : null });
      cursor = e + 1;
    }
    if (cursor <= to) segments.push({ s: cursor, e: to, entry: null });
    return segments;
  }

  function contiguousCachedEnd(pathKey, from) {
    var cursor = from - 1;
    var entries = cacheEntries(pathKey, from, from + BTRA_MAX_REPLY);
    for (var index = 0; index < entries.length; index += 1) {
      if (entries[index].s > cursor + 1) break;
      if (entries[index].e > cursor) cursor = entries[index].e;
    }
    return cursor;
  }

  function storeEntry(pathKey, start, bytes) {
    var key = Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36);
    var encoded = b64encode(bytes);
    var wrote = $persistentStore.write(encoded, BTRA_CACHE_PREFIX + key);
    if (wrote === false) return false;
    change("cadd", { k: key, p: pathKey, s: start, e: start + bytes.length - 1, b: bytes.length, t: Date.now() });
    return true;
  }

  // Once: can the store take a megabyte, and how long does it take? Decides whether caching is used.
  function storeSelfTest() {
    if (state.flags.storeTest) return;
    var result = { ok: false, at: Date.now() };
    try {
      var probe = new Uint8Array(1048576);
      for (var index = 0; index < probe.length; index += 1) probe[index] = (Math.imul(index, 2654435761) >>> 24) & 255;
      var t0 = Date.now();
      var encoded = b64encode(probe);
      var t1 = Date.now();
      var wrote = $persistentStore.write(encoded, BTRA_CACHE_PREFIX + "selftest");
      var t2 = Date.now();
      var back = $persistentStore.read(BTRA_CACHE_PREFIX + "selftest");
      var t3 = Date.now();
      var decoded = typeof back === "string" && back.length === encoded.length ? b64decode(back) : null;
      var t4 = Date.now();
      var same = !!decoded && decoded.length === probe.length;
      for (var check = 0; same && check < probe.length; check += 4099) if (decoded[check] !== probe[check]) same = false;
      result = { ok: wrote !== false && same, encMs: t1 - t0, writeMs: t2 - t1, readMs: t3 - t2, decMs: t4 - t3, at: Date.now() };
      try { $persistentStore.write("", BTRA_CACHE_PREFIX + "selftest"); } catch (_error) {}
    } catch (error) {
      result.error = String(error && error.message || error);
    }
    change("flag", "storeTest", result);
    if (!result.ok) change("flag", "cacheOff", "存储自检没通过");
  }

  /* ------------------------------------------------------------ status page */

  function escapeHtml(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function average(sum, count) {
    return count ? Math.round(sum / count) : 0;
  }

  function statusPage() {
    if (/[?&]reset=1(?:&|$)/.test(url)) {
      try {
        var old = loadState();
        for (var index = 0; index < old.cache.length; index += 1) $persistentStore.write("", BTRA_CACHE_PREFIX + old.cache[index].k);
        $persistentStore.write(JSON.stringify(emptyState()), BTRA_STORE_KEY);
      } catch (_error) {}
    }
    var current = loadState();
    var stats = current.stats;
    var now = Date.now();
    var breakers = [];
    for (var name in current.breaker) {
      if (current.breaker[name] && current.breaker[name].until > now) {
        breakers.push(escapeHtml(name.replace(/^origin:/, "") + "：" + current.breaker[name].reason + "（还剩 " + Math.ceil((current.breaker[name].until - now) / 60000) + " 分钟）"));
      }
    }
    var hosts = [];
    for (var host in current.hosts) {
      var item = current.hosts[host];
      hosts.push(escapeHtml(shortHost(host) + "：成功 " + (item.ok || 0) + " / 失败 " + (item.bad || 0) + (item.bps ? " · " + Math.round(item.bps * 1000 / 1024) + " KB/s" : "") + (item.until > now ? "（停用中）" : "")));
    }
    var cached = 0;
    for (var c = 0; c < current.cache.length; c += 1) cached += current.cache[c].b;
    var test = current.flags.storeTest;
    var testText = !test ? "还没做" : test.ok ? "通过（1 MB：编码 " + test.encMs + " ms · 写入 " + test.writeMs + " ms · 读取 " + test.readMs + " ms · 解码 " + test.decMs + " ms）" : "没通过" + (test.error ? "：" + test.error : "");
    var misses = stats.misses || 0;
    var hits = stats.hits || 0;
    var hist = "≤256K " + (stats.h256 || 0) + " · ≤1M " + (stats.h1m || 0) + " · ≤2M " + (stats.h2m || 0) + " · ≤4M " + (stats.h4m || 0) + " · >4M " + (stats.hbig || 0);
    var rows = [
      ["版本", escapeHtml(BTRA_VERSION)],
      ["设置", escapeHtml(config.threads + " 线程 · 预读 " + (config.aheadBytes ? sizeText(config.aheadBytes) : "关") + " · 缓存上限 " + (config.cacheBytes ? sizeText(config.cacheBytes) : "关") + " · " + (config.overseas ? "海外 CDN" : "大陆 CDN") + " · 大范围请求：" + (config.chunkReplies ? "分块答复" : "原样放行"))],
      ["统计起点", escapeHtml(new Date(current.since).toLocaleString())],
      ["看到的取流请求", escapeHtml((stats.seen || 0) + " 个（小段 " + (stats.bounded || 0) + " · 开放式 " + (stats.open || 0) + " · 无 Range " + (stats.none || 0) + " · 其他 " + (stats.other || 0) + "）")],
      ["请求大小分布", escapeHtml(hist + " · 重复位置 " + (stats.dups || 0))],
      ["缓存命中", escapeHtml(hits + " 次（平均 " + average(stats.hitMs, hits) + " ms）· 部分命中 " + (stats.partial || 0) + " 次 · 未命中 " + misses + " 次")],
      ["未命中耗时", escapeHtml("平均：准备 " + average(stats.prepMs, misses) + " ms · App 要的部分到手 " + average(stats.mustMs, misses) + " ms · 整批到手 " + average(stats.allMs, misses) + " ms")],
      ["多线程取回", escapeHtml((stats.batches || 0) + " 批 · " + sizeText(stats.fetched || 0) + " · " + (stats.pieces || 0) + " 个子块 · 平均 " + (stats.bps ? Math.round(stats.bps * 1000 / 1024) : 0) + " KB/s（每批）")],
      ["交给 App", escapeHtml(sizeText(stats.served || 0) + "，其中来自缓存 " + sizeText(stats.servedCached || 0) + " · 分块答复 " + (stats.shortReplies || 0) + " 次")],
      ["缓存", escapeHtml(current.cache.length + " 条 · " + sizeText(cached) + " / 上限 " + (config.cacheBytes ? sizeText(config.cacheBytes) : "关") + (current.flags.cacheOff ? " · 已停用：" + current.flags.cacheOff : ""))],
      ["存储自检", escapeHtml(testText)],
      ["原样放行", escapeHtml((stats.passed || 0) + " 次" + (stats.lastPass ? "（最近一次原因：" + stats.lastPass + "）" : ""))],
      ["失败后放行", escapeHtml((stats.failed || 0) + " 次" + (stats.lastError ? "（最近一次：" + stats.lastError + "）" : ""))],
      ["保险丝", breakers.length ? breakers.join("<br>") : "没有跳闸"],
      ["节点", hosts.length ? hosts.join("<br>") : "还没有记录"],
      ["实验（给作者看）", escapeHtml("$done 之后：发出 " + (stats.e1sent || 0) + " · 定时器仍触发 " + (stats.e1timer || 0) + " · 网络回调仍触发 " + (stats.e1http || 0) + " · 迟到的预读块补存 " + (stats.late || 0) + "；自派生运行：发出 " + (stats.e2sent || 0) + " · 收到 " + (stats.e2seen || 0) + " · 3 秒后仍在 " + (stats.e2alive || 0))],
      ["App 标识", escapeHtml(stats.agent || "还没有记录")]
    ];
    var html = "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
      "<title>BTR App 模式</title><style>body{margin:0;padding:16px;font:15px/1.6 -apple-system,'PingFang SC',sans-serif;background:#0e1014;color:#e9ecf2}" +
      "h1{font-size:18px}table{border-collapse:collapse;width:100%}td{padding:8px 6px;border-top:1px solid #2a2f3a;vertical-align:top;word-break:break-word}td:first-child{color:#97a0b0;white-space:nowrap}" +
      "a{color:#4cc2ff}p{color:#97a0b0;font-size:13px}</style></head><body><h1>⚡ BTR App 模式</h1><table>";
    for (var row = 0; row < rows.length; row += 1) html += "<tr><td>" + rows[row][0] + "</td><td>" + rows[row][1] + "</td></tr>";
    html += "</table><p>先在 B 站 App 里看一会儿视频，再回来刷新这个页面。反馈问题时把这一页截图发出来就行。<br><a href=\"?reset=1\">清零统计、缓存和保险丝</a></p></body></html>";
    finished = true;
    $done({ response: { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, body: html } });
  }

  // Experiment 2: a request this script sent to itself. Counted at once, and again 3 s later if
  // the run is still alive by then.
  function spawnProbe() {
    state = loadState();
    change("bump", "e2seen", 1);
    commit();
    var reply = { response: { status: 204, headers: { "Cache-Control": "no-store" }, body: "" } };
    if (typeof setTimeout !== "function") { finish(reply); return; }
    setTimeout(function () { change("bump", "e2alive", 1); finish(reply); }, 3000);
  }

  /* ------------------------------------------------------------ main */

  function main() {
    if (/^https?:\/\/(?:www|m)\.bilibili\.com\/__btr_app__\/spawn(?:[/?#]|$)/i.test(url)) { spawnProbe(); return; }
    if (/^https?:\/\/(?:www|m)\.bilibili\.com\/__btr_app__(?:[/?#]|$)/i.test(url)) { statusPage(); return; }

    var method = String(request.method || "GET").toUpperCase();
    // Requests this script makes itself must never be taken apart again. Requests from a web page
    // (they carry Origin / Sec-Fetch-*) are left alone too: a browser needs the CDN's own CORS
    // headers, and the BTR player page in Safari already does its own multi-threading.
    if (method !== "GET" || header(request.headers, "X-BTR-Sub") || header(request.headers, "Origin") || header(request.headers, "Sec-Fetch-Mode")) {
      finished = true;
      $done({});
      return;
    }
    var parts = /^(https?):\/\/([^/:?#]+)(?::(\d+))?(\/[^?#]*)(\?[^#]*)?/i.exec(url);
    if (!parts || !/^\/upgcxcode\/.+\.m4s$/i.test(parts[4])) { finished = true; $done({}); return; }

    state = loadState();
    var originHost = parts[2].toLowerCase();
    var path = parts[4];
    var query = parts[5] || "";
    var pathKey = pathKeyOf(path);
    var now = Date.now();
    change("bump", "seen", 1);
    change("rr");
    var agent = header(request.headers, "User-Agent").slice(0, 80);
    if (agent && agent !== state.stats.agent) change("set", "agent", agent);

    var rangeHeader = header(request.headers, "Range");
    var bounded = /^bytes=(\d+)-(\d+)$/i.exec(rangeHeader);
    var open = /^bytes=(\d+)-$/i.exec(rangeHeader);
    change("bump", bounded ? "bounded" : open ? "open" : rangeHeader ? "other" : "none", 1);
    // Without a Range the App expects "200 + the whole file"; a partial answer would be wrong.
    if (!bounded && !open) { passThrough(rangeHeader ? "Range 写法不认识" : "请求没有 Range"); return; }

    var start = Number((bounded || open)[1]);
    var wantedEnd = bounded ? Number(bounded[2]) : Infinity;
    if (!(start >= 0) || wantedEnd < start) { passThrough("Range 不合法"); return; }
    if (bounded) {
      var asked = wantedEnd - start + 1;
      change("bump", asked <= 262144 ? "h256" : asked <= 1048576 ? "h1m" : asked <= 2097152 ? "h2m" : asked <= 4194304 ? "h4m" : "hbig", 1);
    }

    var known = state.totals[pathKey];
    var total = known ? known.size : 0;
    var contentType = known ? known.type : "";
    if (total && start >= total) { passThrough("起点超出文件"); return; }
    if (total && wantedEnd > total - 1) wantedEnd = total - 1;

    // The same position asked for again within a minute: a retry after a timeout on the App's side,
    // or a player that does not carry on after a short answer.
    var repeats = 0;
    for (var index = 0; index < state.recent.length; index += 1) {
      var entry = state.recent[index];
      if (now - entry.t <= 60000 && entry.p === pathKey && entry.s === start) repeats += 1;
    }
    change("recent", { p: pathKey, s: start, t: now });
    if (repeats) change("bump", "dups", 1);
    change("head", pathKey, start, now);

    var caching = config.cacheBytes > 0 && !state.flags.cacheOff;
    if (caching) storeSelfTest();
    caching = caching && !state.flags.cacheOff;

    // How much goes into this one answer. A range the App spelled out is answered exactly as long as
    // it fits in memory comfortably. "From here to the end" (or a huge range) gets one block — more
    // when the cache already holds the continuation, so the player needs fewer reconnects.
    var end = wantedEnd;
    var plannedShort = false;
    if (!bounded || wantedEnd - start + 1 > BTRA_EXACT_LIMIT) {
      var replyBytes = start === 0 ? Math.min(BTRA_OPEN_REPLY, 1048576) : BTRA_OPEN_REPLY;
      if (caching) replyBytes = Math.max(replyBytes, Math.min(BTRA_MAX_REPLY, contiguousCachedEnd(pathKey, start) - start + 1));
      end = Math.min(wantedEnd, start + replyBytes - 1);
      plannedShort = end < wantedEnd;
    }
    if (plannedShort) {
      if (!config.chunkReplies) { passThrough("大范围请求按设置原样放行"); return; }
      var trip = state.breaker.shortReply;
      if (trip && trip.until > now) { passThrough("保险丝：" + trip.reason); return; }
      // (A healthy player may well open a file two or three times from the start.)
      if (repeats >= (start === 0 ? 4 : 3)) {
        change("breaker", "shortReply", { until: now + 10 * 60000, reason: "App 播放器不接受分块答复" });
        notifyOnce("breaker-short", 60000, "BTR App 模式已自动让路", "这个 App 的播放器不接受分块答复", "接下来 10 分钟大范围取流请求会原样放行（不加速，但不影响观看）。请把 " + BTRA_STATUS_URL + " 这一页截图发给作者。");
        passThrough("保险丝刚刚跳闸");
        return;
      }
    }
    var originTrip = state.breaker["origin:" + originHost];
    if (originTrip && originTrip.until > now) { passThrough("保险丝：" + originTrip.reason); return; }

    /* ---- what is needed, what is already here, what to read ahead ---- */
    var must = caching && total ? coverage(pathKey, start, end, true) : [{ s: start, e: end, entry: null }];
    var missing = [];
    var cachedBytes = 0;
    for (var m = 0; m < must.length; m += 1) {
      if (must[m].entry) cachedBytes += must[m].e - must[m].s + 1; else missing.push(must[m]);
    }
    var extras = [];
    var mustBytes = 0;
    for (var mb = 0; mb < missing.length; mb += 1) mustBytes += missing[mb].e - missing[mb].s + 1;
    // A small request (the player probing a file header, or a small gap in the cache) is answered
    // quickly on its own; the read-ahead comes with the next real block.
    if (caching && config.aheadBytes && missing.length && mustBytes >= 524288) {
      // At least one full wave of the smallest pieces, so that every thread has something to do;
      // more when the batches seen so far were quick (about BTRA_BATCH_TARGET_MS per batch). A file
      // whose length is still unknown gets a modest first batch.
      var minBatch = config.threads * BTRA_MIN_PIECE;
      var target = state.stats.bps ? Math.round(state.stats.bps * BTRA_BATCH_TARGET_MS) : minBatch;
      var ahead = Math.max(0, Math.min(config.aheadBytes, Math.max(minBatch, target) - mustBytes));
      if (!total) ahead = Math.min(ahead, 1048576);
      var aheadEnd = total ? Math.min(total - 1, end + ahead) : end + ahead;
      if (aheadEnd > end) {
        var region = coverage(pathKey, end + 1, aheadEnd, false);
        for (var r = 0; r < region.length; r += 1) if (!region[r].entry) extras.push(region[r]);
      }
    }

    function assemble() {
      var length = end - start + 1;
      var body = new Uint8Array(length);
      for (var index = 0; index < must.length; index += 1) {
        var segment = must[index];
        if (!segment.bytes || segment.bytes.length !== segment.e - segment.s + 1) return null;
        body.set(segment.bytes, segment.s - start);
      }
      return body;
    }

    function respond(body, fromCacheBytes, pieceCount, elapsed) {
      var isShort = end < wantedEnd;
      change("bump", "served", body.length);
      change("bump", "servedCached", fromCacheBytes);
      if (isShort) change("bump", "shortReplies", 1);
      var headers = {
        "Content-Type": contentType || "video/mp4",
        "Content-Range": "bytes " + start + "-" + end + "/" + total,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "X-BTR-iOS": BTRA_VERSION + "; pieces=" + pieceCount + "; cached=" + fromCacheBytes + "; ms=" + elapsed
      };
      // After a short answer the player has to come back for the rest. On a kept-alive HTTP/1.1
      // connection some players would wait for more bytes instead; closing makes the end explicit.
      if (isShort) headers.Connection = "close";
      finish({ response: { status: 206, headers: headers, body: body } });
    }

    if (!missing.length) {
      // Everything the App wants is in the cache: hand it over at once. (No read-ahead on a hit —
      // it would only hold the answer up; the next miss reads ahead again.)
      var cachedBody = assemble();
      if (cachedBody) {
        change("bump", "hits", 1);
        change("bump", "hitMs", Date.now() - startedAt);
        respond(cachedBody, cachedBody.length, 0, Date.now() - startedAt);
        return;
      }
      missing = must.slice();
      for (var reset = 0; reset < must.length; reset += 1) { must[reset].entry = null; must[reset].bytes = null; }
      cachedBytes = 0;
    }
    change("bump", cachedBytes ? "partial" : "misses", 1);

    /* ---- mirrors ---- */
    var everyMirror = config.overseas ? BTRA_OVERSEAS : BTRA_MAINLAND;
    var pool = everyMirror.filter(function (host) { return !(state.hosts[host] && state.hosts[host].until > now); });
    if (pool.length < 2) pool = everyMirror.slice();
    // Proven fast mirrors first; the ones nobody has measured yet are tried in between.
    var speedOf = function (host) { var record = state.hosts[host]; return record && record.bps ? record.bps : -1; };
    var known_ = pool.filter(function (host) { return speedOf(host) > 0; }).sort(function (a, b) { return speedOf(b) - speedOf(a); });
    var unknown = pool.filter(function (host) { return speedOf(host) <= 0; });
    var ranked = [];
    for (var ki = 0, ui = 0; ki < known_.length || ui < unknown.length;) {
      if (ki < known_.length) ranked.push(known_[ki++]);
      if (ki < known_.length) ranked.push(known_[ki++]);
      if (ui < unknown.length) ranked.push(unknown[ui++]);
    }
    var activeCount = Math.min(ranked.length, Math.max(4, Math.ceil(config.threads / 4)));
    // The batch goes to mirrors that have already proved themselves (the fastest few) whenever
    // enough of them are known; until then, to the first few of the list. Mirrors nobody has
    // measured yet only ever get the occasional read-ahead piece (see pickHost).
    var trusted = known_.length >= 3 ? known_.slice(0, Math.max(activeCount, 3)) : ranked.slice(0, activeCount);
    var rotation = state.rr || 0;
    // Akamai's own token means nothing to the ordinary mirrors.
    var mirrorQuery = query.replace(/([?&])hdnts=[^&]*(&|$)/, function (_all, lead, tail) { return tail ? lead : ""; });

    var forwardHeaders = {};
    for (var name in request.headers) {
      if (!Object.prototype.hasOwnProperty.call(request.headers, name)) continue;
      if (/^(?::|host$|range$|connection$|proxy-connection$|keep-alive$|content-length$|transfer-encoding$|upgrade$|te$|if-range$|if-none-match$|if-modified-since$|accept-encoding$)/i.test(name)) continue;
      forwardHeaders[name] = request.headers[name];
    }
    forwardHeaders["X-BTR-Sub"] = "1";
    forwardHeaders["Accept-Encoding"] = "identity";

    /* ---- pieces ---- */
    var extraBytes = 0;
    for (var ee = 0; ee < extras.length; ee += 1) extraBytes += extras[ee].e - extras[ee].s + 1;
    // A batch without read-ahead (a probe, a small gap) and the first batch of a file (length unknown,
    // the player waiting for the header) are cut finer so that they land sooner; ordinary batches use
    // bigger pieces, which cost less per byte to set up.
    var minPiece = !extras.length ? BTRA_MIN_PIECE / 4 : total ? BTRA_MIN_PIECE : BTRA_MIN_PIECE / 2;
    var pieceSize = Math.max(minPiece, Math.min(BTRA_MAX_PIECE, Math.ceil((mustBytes + extraBytes) / config.threads)));
    // Until a few mirrors have proved themselves, the App's own pieces are asked of two mirrors at
    // once (the first good answer wins): a dead mirror then costs nothing but bandwidth.
    var duplicateMust = known_.length < 3;
    var pieces = [];
    function cut(segments, extra) {
      // Each segment is divided evenly, so there are no tiny leftover pieces.
      for (var index = 0; index < segments.length; index += 1) {
        var bytes = segments[index].e - segments[index].s + 1;
        var count = Math.max(1, Math.ceil(bytes / pieceSize));
        var cursor = segments[index].s;
        for (var n = 0; n < count; n += 1) {
          var pieceEnd = n === count - 1 ? segments[index].e : cursor + Math.floor(bytes / count) + (n < bytes % count ? 1 : 0) - 1;
          pieces.push({ index: pieces.length, start: cursor, end: pieceEnd, extra: extra });
          cursor = pieceEnd + 1;
        }
      }
    }
    cut(missing, false);
    cut(extras, true);
    var mustCount = 0;
    for (var pc = 0; pc < pieces.length; pc += 1) if (!pieces[pc].extra) mustCount += 1;
    // One wave only: read-ahead that would not fit into the thread count is left for next time.
    while (pieces.length + (duplicateMust ? mustCount : 0) > config.threads && pieces[pieces.length - 1].extra) pieces.pop();
    var expectedPieceMs = 800 + pieceSize / Math.max(20 * 1024 / 1000, state.stats.bps ? state.stats.bps / Math.max(1, Math.min(config.threads, pieces.length)) : 60 * 1024 / 1000);

    var failed = false;
    var delivered = false;
    var mustLeft = mustCount;
    var extraLeft = pieces.length - mustCount;
    var launchedAt = 0;
    var mustDoneAt = 0;
    var inflight = 0;
    var queue = pieces.slice();
    var tasks = [];
    var goodHosts = [];
    var results = new Array(pieces.length);
    var fetchedBytes = 0;
    var hedges = 0;

    function giveUp(reason) {
      if (failed || finished) return;
      failed = true;
      change("bump", "failed", 1);
      change("set", "lastError", reason);
      var key = "origin:" + originHost;
      change("streak", key, 1);
      if ((state.streaks[key] || 0) >= 4) {
        change("breaker", key, { until: Date.now() + 5 * 60000, reason: "这类地址在镜像节点上取不到（" + reason + "）" });
        change("streak", key, null);
        notifyOnce("breaker-origin", 5 * 60000, "BTR App 模式暂时让路", originHost, "连续几次没能从镜像节点拿到数据（" + reason + "），先原样放行 5 分钟。");
      }
      storeExtras();
      finish({});
    }

    function requestPiece(host, piece, callback) {
      var headers = {};
      for (var key in forwardHeaders) headers[key] = forwardHeaders[key];
      headers.Range = "bytes=" + piece.start + "-" + piece.end;
      var sentAt = Date.now();
      $httpClient.get({
        url: "https://" + host + path + mirrorQuery,
        headers: headers,
        timeout: Math.round(expectedPieceMs * 3 + 4000),
        "binary-mode": true,
        "auto-cookie": false
      }, function (error, response, data) {
        // Whatever goes wrong in here must end in "let the request through", never in a script that
        // hangs until Loon's timeout while the player waits.
        try {
          var problem = "";
          var range = null;
          if (Object.prototype.toString.call(data) === "[object ArrayBuffer]") data = new Uint8Array(data);
          if (error || !response) problem = "网络错误 " + String(error || "");
          else if (Number(response.status) === 416) {
            // Beyond the end of the file (its length was not known yet): not this mirror's fault.
            var tail = /^bytes\s+\*\/(\d+)$/i.exec(String(header(response.headers, "Content-Range") || "").replace(/^\s+|\s+$/g, ""));
            callback("", null, tail ? Number(tail[1]) : 0, response, Date.now() - sentAt, true);
            return;
          }
          else if (Number(response.status) !== 206) problem = "HTTP " + response.status;
          else if (!data || typeof data.subarray !== "function") problem = "拿到的不是二进制数据";
          else {
            range = parseContentRange(header(response.headers, "Content-Range"));
            if (!range || range.start !== piece.start || range.end > piece.end) problem = "Content-Range 不对";
            else if (range.end < piece.end && range.end !== range.total - 1) problem = "少给了数据";
            else if (data.length !== range.end - range.start + 1) problem = "长度不符";
            else if (total && range.total !== total) problem = "文件总长度不一致";
          }
          callback(problem, data, range, response, Date.now() - sentAt, false);
        } catch (failure) {
          giveUp("脚本内部错误：" + String(failure && failure.message || failure));
        }
      });
    }

    function pickHost(piece, attempt, used) {
      var host = "";
      if (attempt > 0) {
        for (var g = 0; g < goodHosts.length && !host; g += 1) {
          var candidate = goodHosts[(piece.index + attempt + g) % goodHosts.length];
          if (used.indexOf(candidate) < 0) host = candidate;
        }
      }
      // Round robin inside the active set. One read-ahead piece per batch (a few in a big one) is
      // given to a mirror nobody has measured yet, mirrors never tried first: a dead one costs at
      // most one small gap in the cache, and after a few batches every mirror is known.
      var base = trusted;
      var explore = pool.filter(function (candidate) { return base.indexOf(candidate) < 0; });
      explore.sort(function (a, b) { var ra = state.hosts[a], rb = state.hosts[b]; return ((ra ? ra.ok + ra.bad : 0) - (rb ? rb.ok + rb.bad : 0)) || (speedOf(b) - speedOf(a)); });
      var exploring = piece.extra && (piece.index - mustCount) % 16 === 0 && explore.length > 0 && attempt === 0 && known_.length < pool.length;
      if (exploring) piece.exploring = true;
      var order = exploring ? explore.concat(base) : base.concat(explore);
      var span = exploring ? explore.length : base.length;
      var first = (rotation + piece.index + attempt * 3) % span;
      for (var step = 0; step < order.length && !host; step += 1) {
        var next = order[(first + step) % order.length];
        if (used.indexOf(next) < 0) host = next;
      }
      return host;
    }

    function learnTotal(size, response) {
      if (!(size > 0) || total) return;
      total = size;
      contentType = contentType || header(response.headers, "Content-Type");
      change("total", pathKey, total, Date.now(), contentType);
      if (start > total - 1) { passThrough("起点超出文件"); return; }
      if (wantedEnd > total - 1) wantedEnd = total - 1;
      if (end > total - 1) end = total - 1;
      // Pieces beyond the end of the file are pointless: drop them from the queue, trim the one
      // that straddles the end.
      queue = queue.filter(function (piece) {
        if (piece.start > total - 1) { if (piece.extra) extraLeft -= 1; else mustLeft -= 1; return false; }
        if (piece.end > total - 1) piece.end = total - 1;
        return true;
      });
      for (var index = 0; index < must.length; index += 1) if (must[index].e > total - 1) must[index].e = total - 1;
    }

    function pump() {
      while (queue.length && inflight < config.threads && !failed && !finished) {
        var piece = queue.shift();
        if (!launchedAt) launchedAt = Date.now();
        var task = createTask(piece);
        task.launch();
        if (duplicateMust && !piece.extra) task.launch();
      }
    }

    function createTask(piece) {
      var task = { piece: piece, done: false, launched: 0, inflight: 0, used: [] };
      task.launch = function () {
        if (task.done || failed || finished || task.launched >= (piece.extra ? 2 : 3)) return false;
        if (task.launched > 0 && Date.now() - startedAt > BTRA_DEADLINE - 2000) return false;
        var host = pickHost(piece, task.launched, task.used);
        if (!host) return false;
        if (!task.launched) task.launchedAt = Date.now();
        task.launched += 1;
        task.inflight += 1;
        inflight += 1;
        task.used.push(host);
        requestPiece(host, piece, function (problem, data, range, response, ms, eof) {
          task.inflight -= 1;
          inflight -= 1;
          if (finished || failed) {
            if (delivered && !failed && !problem && !eof && piece.extra && !task.done) { task.done = true; lateStore(piece, data); }
            return;
          }
          if (eof) {
            // The file ended before this piece: nothing to store, nobody to blame.
            learnTotal(range, response);
            if (finished) return;
            if (!task.done) { task.done = true; if (piece.extra) extraLeft -= 1; else mustLeft -= 1; }
            if (!mustLeft && !mustDoneAt) mustDoneAt = Date.now();
            pump();
            settle();
            return;
          }
          if (problem) {
            change("host", host, false, Date.now());
            if (!task.done) {
              if (!task.launch() && task.inflight === 0) {
                if (piece.extra) { task.done = true; extraLeft -= 1; settle(); }
                else giveUp(shortHost(host) + "：" + problem);
              }
            }
            pump();
            return;
          }
          change("host", host, true, Date.now(), ms > 0 ? data.length / ms : 0);
          if (goodHosts.indexOf(host) < 0) goodHosts.push(host);
          learnTotal(range ? range.total : 0, response);
          if (finished) return;
          if (task.done) { pump(); return; }
          task.done = true;
          results[piece.index] = { start: piece.start, data: data, extra: piece.extra };
          fetchedBytes += data.length;
          change("bump", "pieces", 1);
          if (piece.extra) extraLeft -= 1;
          else {
            mustLeft -= 1;
            var segment = null;
            for (var index = 0; index < must.length && !segment; index += 1) if (!must[index].entry && must[index].s <= piece.start && must[index].e >= piece.start) segment = must[index];
            if (segment) {
              if (!segment.bytes) segment.bytes = new Uint8Array(segment.e - segment.s + 1);
              segment.bytes.set(data.subarray(0, Math.min(data.length, segment.bytes.length - (piece.start - segment.s))), piece.start - segment.s);
            }
            if (!mustLeft) mustDoneAt = Date.now();
          }
          pump();
          settle();
          hedge(false);
        });
        return true;
      };
      tasks.push(task);
      return task;
    }

    // A mirror that swallows a request without answering would hold the whole reply up until its
    // timeout. When only stragglers are left (or the expected time has long passed), ask a mirror
    // that has just proved itself for the same bytes as well. Only the App's own bytes are worth it.
    function hedge(byTimer) {
      if (failed || finished || !mustLeft) return;
      var open = 0;
      for (var index = 0; index < tasks.length; index += 1) if (!tasks[index].done && !tasks[index].piece.extra) open += 1;
      if (!open) return;
      if (!byTimer && (open > 2 || open === mustCount)) return;
      var budget = 3 - hedges;
      for (var pick = 0; pick < tasks.length && budget > 0; pick += 1) {
        var task = tasks[pick];
        if (!task.done && !task.piece.extra && task.inflight === 1 && task.launched === 1 && task.launch()) { budget -= 1; hedges += 1; }
      }
    }

    function storeExtras() {
      if (!caching) return;
      // Completed read-ahead pieces, merged into contiguous runs; each run becomes one cache entry.
      var list = [];
      for (var index = 0; index < results.length; index += 1) if (results[index] && results[index].extra) list.push(results[index]);
      list.sort(function (a, b) { return a.start - b.start; });
      var run = [];
      var runBytes = 0;
      function flush() {
        if (!run.length) return;
        var bytes = new Uint8Array(runBytes);
        var offset = 0;
        for (var r = 0; r < run.length; r += 1) { bytes.set(run[r].data, offset); offset += run[r].data.length; }
        try { if (!storeEntry(pathKey, run[0].start, bytes)) change("flag", "cacheOff", "写入存储失败"); } catch (_error) { change("flag", "cacheOff", "写入存储出错"); }
        run = [];
        runBytes = 0;
      }
      for (var l = 0; l < list.length; l += 1) {
        if (run.length && run[run.length - 1].start + run[run.length - 1].data.length !== list[l].start) flush();
        run.push(list[l]);
        runBytes += list[l].data.length;
      }
      flush();
    }

    // Experiment 1 in practice: if Loon keeps this run alive after $done, read-ahead pieces that
    // arrive late still go into the cache (bookkeeping straight in the store; the run's own ops are
    // long committed).
    function lateStore(piece, data) {
      if (!caching || data.length !== piece.end - piece.start + 1) return;
      try {
        var key = Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36);
        if ($persistentStore.write(b64encode(data), BTRA_CACHE_PREFIX + key) === false) return;
        var fresh = loadState();
        if (fresh.flags.cacheOff) { $persistentStore.write("", BTRA_CACHE_PREFIX + key); return; }
        fresh.cache.push({ k: key, p: pathKey, s: piece.start, e: piece.end, b: data.length, t: Date.now() });
        fresh.stats.late = (fresh.stats.late || 0) + 1;
        var dropped = evict(fresh, Date.now());
        $persistentStore.write(JSON.stringify(fresh), BTRA_STORE_KEY);
        for (var d = 0; d < dropped.length; d += 1) $persistentStore.write("", BTRA_CACHE_PREFIX + dropped[d].k);
      } catch (_error) {}
    }

    var graceTimer = null;

    function settle() {
      if (failed || finished || delivered || mustLeft) return;
      // Pieces sent to unmeasured mirrors are not waited for: they arrive or they do not.
      var pendingCore = 0;
      for (var pending = 0; pending < tasks.length; pending += 1) if (!tasks[pending].done && tasks[pending].piece.extra && !tasks[pending].piece.exploring) pendingCore += 1;
      if (extraLeft > 0 && !pendingCore) extraLeft = 0;
      if (extraLeft > 0) {
        if (typeof setTimeout !== "function") extraLeft = 0;
        else {
          // Read-ahead pieces are the same size as the App's, so the healthy ones arrive at about
          // the same time; the answer is not held up for long on account of the others.
          if (graceTimer === null) {
            var grace = Math.max(250, Math.min(800, Math.round((mustDoneAt - launchedAt) * 0.2)));
            graceTimer = setTimeout(function () { extraLeft = 0; settle(); }, grace);
          }
          return;
        }
      }
      delivered = true;
      // A mirror that was asked early and still has not answered while the others are long done is
      // the black-holed kind: a strike (two in a row bench it), so it is not asked again soon.
      var lateLine = Date.now() - (mustDoneAt - launchedAt) * 0.75;
      for (var late = 0; late < tasks.length; late += 1) {
        var slow = tasks[late];
        if (!slow.done && slow.inflight > 0 && slow.launchedAt && slow.launchedAt < lateLine) change("host", slow.used[slow.used.length - 1], false, Date.now());
      }
      var body = assemble();
      if (!body) { giveUp("拼装后的长度不符"); return; }
      var elapsed = Math.max(1, Date.now() - startedAt);
      var batchMs = Math.max(1, Date.now() - launchedAt);
      change("bump", "batches", 1);
      change("bump", "fetched", fetchedBytes);
      change("bump", "prepMs", launchedAt - startedAt);
      change("bump", "mustMs", mustDoneAt - startedAt);
      change("bump", "allMs", elapsed);
      // Only batches that keep the threads busy say something about the speed; a small gap filled
      // with a few pieces is bound by latency, not throughput.
      if (pieces.length >= config.threads / 2) change("ewma", "bps", fetchedBytes / batchMs);
      if (state.streaks["origin:" + originHost]) change("streak", "origin:" + originHost, null);
      notifyOnce("working", 6 * 3600000, "BTR App 模式正在加速", config.threads + " 线程 · " + (config.overseas ? "海外 CDN" : "大陆 CDN"), "刚才这一批 " + sizeText(fetchedBytes) + " 用了 " + (batchMs / 1000).toFixed(1) + " 秒（" + pieces.length + " 个子块）。统计页：" + BTRA_STATUS_URL);
      storeExtras();
      experiments();
      respond(body, cachedBytes, pieces.length, elapsed);
    }

    // Experiments 1 and 2, on some of the runs: what happens to work that is still pending when
    // this run answers? Counted directly in the store, since the run is over by then.
    function experiments() {
      if (typeof setTimeout !== "function" || (state.stats.seen || 0) > 400 || !goodHosts.length) return;
      var seen = state.stats.seen || 0;
      if (seen % 5 === 0) {
        change("bump", "e1sent", 1);
        setTimeout(function () { bumpDirect("e1timer"); }, 400);
        var headers = { "X-BTR-Sub": "1", Range: "bytes=0-0" };
        $httpClient.get({ url: "https://" + goodHosts[0] + path + mirrorQuery, headers: headers, timeout: 8000, "binary-mode": true, "auto-cookie": false }, function () { bumpDirect("e1http"); });
      }
      if (seen % 7 === 0) {
        change("bump", "e2sent", 1);
        $httpClient.get({ url: BTRA_SPAWN_URL, headers: { "X-BTR-Sub": "1" }, timeout: 10000, "auto-cookie": false }, function () {});
      }
    }

    if (typeof setTimeout === "function") {
      setTimeout(function () { giveUp("超过 " + Math.round(BTRA_DEADLINE / 1000) + " 秒还没拼齐"); }, BTRA_DEADLINE);
      setTimeout(function () { hedge(true); }, Math.round(expectedPieceMs * 1.7));
      setTimeout(function () { hedge(true); }, Math.round(expectedPieceMs * 2.6));
    }
    pump();
    if (!mustLeft) settle();
  }

  try {
    main();
  } catch (error) {
    try { console.log("BTR App: " + String(error && error.stack || error)); } catch (_error) {}
    if (!finished) { finished = true; $done({}); }
  }
})();
