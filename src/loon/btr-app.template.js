/*
 * BTR-iOS · App 模式  —  __BTRI_VERSION__
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
var BTRA_VERSION = "__BTRI_VERSION__";
var BTRA_STORE_KEY = "btr_ios_app_v2";
var BTRA_CACHE_PREFIX = "btr_ios_app_c:";
var BTRA_STATUS_URL = "https://www.bilibili.com/__btr_app__/";
// Every distinct mirror is an independent route with its own bandwidth, so the way to go faster
// over a congested overseas link is to add more of them together, not to lean on one. A mirror
// that turns out dead or wrong-signed simply fails its probes and is rested; the cost of listing
// one that does not work is a couple of wasted probes.
var BTRA_MAINLAND = [
  "upos-sz-mirrorali.bilivideo.com", "upos-sz-mirrorali02.bilivideo.com", "upos-sz-mirrorhw.bilivideo.com",
  "upos-sz-mirrorhwb.bilivideo.com", "upos-sz-mirrorbos.bilivideo.com", "upos-sz-mirror08c.bilivideo.com",
  "upos-sz-mirror08h.bilivideo.com", "upos-sz-mirrorbd.bilivideo.com", "upos-sz-mirror14b.bilivideo.com",
  "upos-sz-estgoss.bilivideo.com", "upos-sz-mirrorcos.bilivideo.com", "upos-sz-mirrorcosb.bilivideo.com",
  "upos-sz-upcdntx.bilivideo.com", "upos-sz-upcdnbda2.bilivideo.com", "upos-sz-upcdnqn.bilivideo.com",
  "upos-sz-upcdnws.bilivideo.com"
];
var BTRA_OVERSEAS = [
  "upos-sz-mirroraliov.bilivideo.com", "upos-sz-mirrorcosov.bilivideo.com",
  "cn-hk-eq-01-01.bilivideo.com", "cn-hk-eq-01-03.bilivideo.com",
  "cn-hk-eq-bcache-01.bilivideo.com"
];
var BTRA_SLICE_MS = 1000;             // every connection is given what it should deliver in this time
var BTRA_EXTRA_SHARE = 0.8;            // read-ahead pieces are cut a little shorter, so they land first
var BTRA_BUSY_KEY = "btr_ios_app_busy";
var BTRA_BUSY_MS = 2500;               // how long a connection started by another run is assumed to be in use
var BTRA_ASSUMED_BPS = 40;             // bytes per ms assumed for a mirror nobody has measured (≈ 40 KB/s)
var BTRA_PER_HOST = 6;                 // connections to one mirror at a time (iOS queues more than that)
var BTRA_EXPLORE = 4;                  // unmeasured mirrors probed per batch, so a wider pool is learned quickly
var BTRA_MIN_SLOT = 8 * 1024;          // a mirror doing even ~8 KB/s still earns a slot: bandwidth is summed
var BTRA_MAX_PIECE = 1024 * 1024;
var BTRA_MAX_BATCH = 8 * 1024 * 1024;
var BTRA_MAX_REPLY = 8 * 1024 * 1024;
var BTRA_EXACT_LIMIT = 2 * 1024 * 1024;
var BTRA_OPEN_REPLY = 2 * 1024 * 1024;
var BTRA_PIECE_TIMEOUT = 9000;
var BTRA_HEDGE_BUDGET = 4;
var BTRA_DEADLINE = 8000;
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
    var conns = parseInt(map.conns !== undefined ? map.conns : map.threads, 10);
    return {
      conns: conns >= 1 && conns <= 64 ? conns : 32,
      aheadBytes: megabytes(map.ahead, 4, true),
      cacheBytes: megabytes(map.cache, 16, true),
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
    return { v: 2, since: Date.now(), rr: 0, totals: {}, hosts: {}, recent: [], breaker: {}, streaks: {}, notes: {}, stats: {}, cache: [], heads: {}, flags: {}, runs: [] };
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
    return state.hosts[host] || (state.hosts[host] = { ok: 0, bad: 0, late: 0, streak: 0, lateStreak: 0, until: 0, benches: 0, bps: 0 });
  }

  function apply(state, op) {
    var kind = op[0];
    if (kind === "bump") state.stats[op[1]] = (state.stats[op[1]] || 0) + op[2];
    else if (kind === "set") state.stats[op[1]] = op[2];
    else if (kind === "ewma") state.stats[op[1]] = state.stats[op[1]] ? state.stats[op[1]] * 0.7 + op[2] * 0.3 : op[2];
    else if (kind === "rr") state.rr = ((state.rr || 0) + 1) % 1000000;
    else if (kind === "total") state.totals[op[1]] = { size: op[2], t: op[3], type: op[4] || "" };
    else if (kind === "recent") state.recent.push(op[1]);
    else if (kind === "rdone") {
      for (var recentIndex = state.recent.length - 1; recentIndex >= 0; recentIndex -= 1) {
        var seenEntry = state.recent[recentIndex];
        if (seenEntry.p === op[1] && seenEntry.s === op[2] && seenEntry.t === op[3]) { seenEntry.o = op[4]; seenEntry.ms = op[5]; break; }
      }
    }
    else if (kind === "late") {
      // A "late" mark only means this mirror is slow right now — which, over a congested overseas
      // link, is true of nearly all of them. A slow mirror still adds bandwidth, so lateness must
      // never bench it or knock down its measured speed (doing so used to snowball: every mirror
      // slow -> every mirror marked late -> speeds crushed toward zero -> the fastest ones benched
      // -> even less bandwidth). We only count it, for the status page. Real speed is learned from
      // what actually arrives (the "host" op), and only hard failures rest a mirror.
      var lateHost = hostRecord(state, op[1]);
      lateHost.late = (lateHost.late || 0) + 1;
      lateHost.lateStreak = (lateHost.lateStreak || 0) + 1;
    }
    else if (kind === "breaker") state.breaker[op[1]] = op[2];
    else if (kind === "streak") state.streaks[op[1]] = op[2] === null ? 0 : (state.streaks[op[1]] || 0) + op[2];
    else if (kind === "note") state.notes[op[1]] = op[2];
    else if (kind === "flag") state.flags[op[1]] = op[2];
    else if (kind === "run") { state.runs.push(op[1]); while (state.runs.length > 12) state.runs.shift(); }
    else if (kind === "min") state.stats[op[1]] = state.stats[op[1]] ? Math.min(state.stats[op[1]], op[2]) : op[2];
    else if (kind === "max") state.stats[op[1]] = Math.max(state.stats[op[1]] || 0, op[2]);
    else if (kind === "head") state.heads[op[1]] = { pos: op[2], t: op[3] };
    else if (kind === "cadd") state.cache.push(op[1]);
    else if (kind === "cdel") state.cache = state.cache.filter(function (entry) { return entry.k !== op[1]; });
    else if (kind === "host") {
      var item = hostRecord(state, op[1]);
      if (op[2]) {
        item.ok += 1; item.streak = 0; item.lateStreak = 0; item.until = 0; item.benches = 0;
        if (op[4] > 0) item.bps = item.bps ? item.bps * 0.7 + op[4] * 0.3 : op[4];
      } else {
        item.bad += 1;
        item.streak += 1;
        // Only a mirror that keeps failing outright is rested (dead host, wrong signature, 403).
        // Three in a row, because over a congested link the odd timeout is normal and does not mean
        // the mirror is useless. Rest 3 minutes, then 9, capped at half an hour, and one success
        // clears it — we would rather keep a flaky mirror contributing than lose its bandwidth.
        if (item.streak >= 3 && !(item.until > op[3])) {
          item.benches = (item.benches || 0) + 1;
          item.until = op[3] + Math.min(30, 3 * Math.pow(3, item.benches - 1)) * 60000;
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
    busyClear();
    $done(result);
  }

  var currentKey = null;
  var currentStart = 0;
  var currentAsked = 0;
  var runId = startedAt.toString(36) + Math.floor(Math.random() * 1679616).toString(36);
  var busyNoted = false;

  function busyNote(hosts) {
    try {
      var busy = JSON.parse($persistentStore.read(BTRA_BUSY_KEY) || "{}") || {};
      var now = Date.now();
      for (var index = 0; index < hosts.length; index += 1) {
        var stamps = (busy[hosts[index]] || []).filter(function (stamp) { return stamp.r !== runId && now - stamp.t < BTRA_BUSY_MS; });
        stamps.push({ t: now, r: runId });
        busy[hosts[index]] = stamps;
      }
      for (var host in busy) if (!busy[host].length) delete busy[host];
      $persistentStore.write(JSON.stringify(busy), BTRA_BUSY_KEY);
      busyNoted = true;
    } catch (_error) {}
  }

  function busyClear() {
    if (!busyNoted) return;
    try {
      var busy = JSON.parse($persistentStore.read(BTRA_BUSY_KEY) || "{}") || {};
      var now = Date.now();
      for (var host in busy) {
        busy[host] = busy[host].filter(function (stamp) { return stamp.r !== runId && now - stamp.t < BTRA_BUSY_MS; });
        if (!busy[host].length) delete busy[host];
      }
      $persistentStore.write(JSON.stringify(busy), BTRA_BUSY_KEY);
    } catch (_error) {}
  }

  function passThrough(reason) {
    change("bump", "passed", 1);
    if (reason) change("set", "lastPass", reason);
    if (currentKey !== null) change("rdone", currentKey, currentStart, startedAt, "pass", Date.now() - startedAt);
    change("run", { k: "pass", a: currentAsked, ms: Date.now() - startedAt, r: reason || "" });
    finish({});
  }

  function notifyOnce(key, everyMs, title, subtitle, body) {
    if (!config.notify) return;
    var now = Date.now();
    if (state.notes[key] && now - state.notes[key] < everyMs) return;
    change("note", key, now);
    try { $notification.post(title, subtitle, body); } catch (_error) {}
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
    var liveHosts = 0;
    var benchedHosts = 0;
    var aggBps = 0;
    for (var host in current.hosts) {
      var item = current.hosts[host];
      if (item.until > now) benchedHosts += 1;
      else if (item.bps > 0) { liveHosts += 1; aggBps += item.bps; }
      hosts.push(escapeHtml(shortHost(host) + "：成功 " + (item.ok || 0) + " / 失败 " + (item.bad || 0) + " / 迟到 " + (item.late || 0) + (item.bps ? " · " + Math.round(item.bps * 1000 / 1024) + " KB/s" : "") + (item.until > now ? "（停用中）" : "")));
    }
    var hostSummary = "在用 " + liveHosts + " 个镜像 · 合计约 " + Math.round(aggBps * 1000 / 1024) + " KB/s" + (benchedHosts ? " · 停用 " + benchedHosts + " 个" : "");
    var cached = 0;
    for (var c = 0; c < current.cache.length; c += 1) cached += current.cache[c].b;
    var test = current.flags.storeTest;
    var testText = !test ? "还没做" : test.ok ? "通过（1 MB：编码 " + test.encMs + " ms · 写入 " + test.writeMs + " ms · 读取 " + test.readMs + " ms · 解码 " + test.decMs + " ms）" : "没通过" + (test.error ? "：" + test.error : "");
    var misses = stats.misses || 0;
    var hits = stats.hits || 0;
    var runLines = [];
    var kinds = { hit: "命中", part: "部分命中", miss: "未命中", pass: "放行", fail: "失败" };
    for (var ri = current.runs.length - 1; ri >= 0; ri -= 1) {
      var run = current.runs[ri];
      var line = kinds[run.k] + " " + sizeText(run.a || 0);
      if (run.k === "hit") line += " · " + run.ms + " ms";
      else if (run.k === "miss" || run.k === "part") line += " → 取回 " + sizeText(run.f || 0) + " · App 部分 " + run.m + " ms · 全部 " + run.ms + " ms · " + run.p + " 块 / " + run.n + " 条 · 容量 " + sizeText(run.c || 0) + (run.sh ? " · 分块答复" : "");
      else line += " · " + run.ms + " ms · " + (run.r || "");
      runLines.push(escapeHtml(line));
    }
    var hist = "≤256K " + (stats.h256 || 0) + " · ≤1M " + (stats.h1m || 0) + " · ≤2M " + (stats.h2m || 0) + " · ≤4M " + (stats.h4m || 0) + " · >4M " + (stats.hbig || 0);
    var rows = [
      ["版本", escapeHtml(BTRA_VERSION)],
      ["设置", escapeHtml(config.conns + " 条连接 · 预读 " + (config.aheadBytes ? sizeText(config.aheadBytes) : "关") + " · 缓存上限 " + (config.cacheBytes ? sizeText(config.cacheBytes) : "关") + " · " + (config.overseas ? "海外 CDN" : "大陆 CDN") + " · 大范围请求：" + (config.chunkReplies ? "分块答复" : "原样放行"))],
      ["统计起点", escapeHtml(new Date(current.since).toLocaleString())],
      ["看到的取流请求", escapeHtml((stats.seen || 0) + " 个（小段 " + (stats.bounded || 0) + " · 开放式 " + (stats.open || 0) + " · 无 Range " + (stats.none || 0) + " · 其他 " + (stats.other || 0) + "）")],
      ["请求大小分布", escapeHtml(hist + " · 最大 " + sizeText(stats.maxAsked || 0))],
      ["重复位置", escapeHtml((stats.dups || 0) + " 次：上一次答复还没完成 " + (stats.dupPending || 0) + " · 上次答得慢 " + (stats.dupSlow || 0) + " · 上次答得快 " + (stats.dupQuick || 0) + " · 上次是分块答复 " + (stats.dupShort || 0) + " · 上次放行/失败 " + (stats.dupFail || 0) + (stats.dupAfterMinMs ? "（重问之前那次答复用了 " + stats.dupAfterMinMs + "～" + stats.dupAfterMaxMs + " ms）" : ""))],
      ["其他取流方式", escapeHtml((stats.otherMedia || 0) + " 个 MCDN/PCDN 请求（未加速，原样放行）" + (stats.otherHost ? " · 最近：" + stats.otherHost : ""))],
      ["缓存命中", escapeHtml(hits + " 次（平均 " + average(stats.hitMs, hits) + " ms）· 部分命中 " + (stats.partial || 0) + " 次 · 未命中 " + misses + " 次")],
      ["未命中耗时", escapeHtml("平均：准备 " + average(stats.prepMs, stats.batches) + " ms · App 要的部分到手 " + average(stats.mustMs, stats.batches) + " ms · 整批到手 " + average(stats.allMs, stats.batches) + " ms · 超过 4 秒的答复 " + (stats.slowRuns || 0) + " 次")],
      ["多线程取回", escapeHtml((stats.batches || 0) + " 批 · " + sizeText(stats.fetched || 0) + " · " + (stats.pieces || 0) + " 个子块 · 平均 " + (stats.bps ? Math.round(stats.bps * 1000 / 1024) : 0) + " KB/s（每批）· 上一批容量 " + sizeText(stats.lastCapacity || 0) + " / " + (BTRA_SLICE_MS / 1000) + " 秒")],
      ["交给 App", escapeHtml(sizeText(stats.served || 0) + "，其中来自缓存 " + sizeText(stats.servedCached || 0) + " · 分块答复 " + (stats.shortReplies || 0) + " 次")],
      ["缓存", escapeHtml(current.cache.length + " 条 · " + sizeText(cached) + " / 上限 " + (config.cacheBytes ? sizeText(config.cacheBytes) : "关") + (current.flags.cacheOff ? " · 已停用：" + current.flags.cacheOff : ""))],
      ["存储自检", escapeHtml(testText)],
      ["原样放行", escapeHtml((stats.passed || 0) + " 次" + (stats.lastPass ? "（最近一次原因：" + stats.lastPass + "）" : ""))],
      ["失败后放行", escapeHtml((stats.failed || 0) + " 次" + (stats.lastError ? "（最近一次：" + stats.lastError + "）" : ""))],
      ["保险丝", breakers.length ? breakers.join("<br>") : "没有跳闸"],
      ["节点", hosts.length ? hostSummary + "<br>" + hosts.join("<br>") : "还没有记录"],
      ["答复之后才到的块", escapeHtml((stats.late || 0) + " 块补存进了缓存（Loon 通常在答复后立刻结束脚本，所以这个数一般是 0）")],
      ["最近 12 次", runLines.length ? runLines.join("<br>") : "还没有记录"],
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

  /* ------------------------------------------------------------ main */

  function main() {
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
    if (parts && /^\/v1\/resource\/.+\.m4s$/i.test(parts[4])) {
      // Another way the App fetches media (MCDN / PCDN nodes). Not accelerated yet — only counted,
      // so that the status page shows how much of the traffic goes this way.
      state = loadState();
      change("bump", "otherMedia", 1);
      change("set", "otherHost", parts[2].toLowerCase() + (parts[3] ? ":" + parts[3] : ""));
      finish({});
      return;
    }
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
    var previous = null;
    for (var index = 0; index < state.recent.length; index += 1) {
      var entry = state.recent[index];
      if (now - entry.t <= 60000 && entry.p === pathKey && entry.s === start) { repeats += 1; previous = entry; }
    }
    change("recent", { p: pathKey, s: start, t: startedAt });
    currentKey = pathKey;
    currentStart = start;
    currentAsked = bounded ? wantedEnd - start + 1 : 0;
    if (repeats) {
      change("bump", "dups", 1);
      // What did the App get the last time it asked for this very position? That tells whether the
      // repeats are retries after a slow answer, after a partial one, or after a failure.
      change("bump", !previous.o ? "dupPending" : previous.o === "short" ? "dupShort" : previous.o === "fail" || previous.o === "pass" ? "dupFail" : previous.ms > 2500 ? "dupSlow" : "dupQuick", 1);
      // How long had the previous answer taken when the App asked again? The smallest such value
      // is a hint of how long the App is prepared to wait.
      if (previous.o === "ok" && previous.ms) { change("min", "dupAfterMinMs", previous.ms); change("max", "dupAfterMaxMs", previous.ms); }
    }
    if (bounded && wantedEnd - start + 1 > (state.stats.maxAsked || 0)) change("set", "maxAsked", wantedEnd - start + 1);
    change("head", pathKey, start, now);

    var caching = config.cacheBytes > 0 && !state.flags.cacheOff;
    if (caching) storeSelfTest();
    caching = caching && !state.flags.cacheOff;

    /* ---- mirrors: who gets how much ----
     * Mirrors differ twentyfold in what one connection delivers (a phone in Los Angeles measured
     * 12 KB/s on one, 269 KB/s on another). Sharing pieces out evenly would make every batch wait
     * for the slowest. Instead every connection ("slot") gets as many bytes as its mirror is
     * expected to deliver in BTRA_BATCH_TARGET_MS, so the whole batch lands at about the same
     * moment, and the fast mirrors carry most of it. Mirrors nobody has measured get one small
     * read-ahead piece now and then, which is how they become known.
     */
    // Both sets are always candidates — from overseas the mainland mirrors and the Hong Kong /
    // Akamai nodes travel different routes, and using them together is what adds up to real
    // bandwidth. The CDN setting only decides which set is tried first; measured speed then sorts
    // out who actually carries the load. A mirror resting after repeated hard failures is skipped.
    var preferred = config.overseas ? BTRA_OVERSEAS : BTRA_MAINLAND;
    var everyMirror = preferred.concat(BTRA_MAINLAND, BTRA_OVERSEAS).filter(function (host, index, all) { return all.indexOf(host) === index; });
    var pool = everyMirror.filter(function (host) { return !(state.hosts[host] && state.hosts[host].until > now); });
    if (pool.length < 2) pool = everyMirror.slice();
    var speedOf = function (host) { var record = state.hosts[host]; return record && record.bps > 0 ? record.bps : 0; };
    var triesOf = function (host) { var record = state.hosts[host]; return record ? (record.ok || 0) + (record.bad || 0) + (record.late || 0) : 0; };
    var knownHosts = pool.filter(function (host) { return speedOf(host) > 0; }).sort(function (a, b) { return speedOf(b) - speedOf(a); });
    var unknownHosts = pool.filter(function (host) { return speedOf(host) <= 0; }).sort(function (a, b) { return triesOf(a) - triesOf(b); });
    var assumedBps = knownHosts.length ? speedOf(knownHosts[Math.floor(knownHosts.length / 2)]) : BTRA_ASSUMED_BPS;
    var fresh = knownHosts.length < 3;
    // Connections that another run (the other stream) is using right now still occupy the mirror:
    // every run notes its connections under a shared key while it works and takes them out at the end.
    var busy = {};
    try { busy = JSON.parse($persistentStore.read(BTRA_BUSY_KEY) || "{}") || {}; } catch (_error) { busy = {}; }
    function busyCount(host) {
      var stamps = busy[host] || [];
      var count = 0;
      for (var b = 0; b < stamps.length; b += 1) if (stamps[b].r !== runId && now - stamps[b].t < BTRA_BUSY_MS) count += 1;
      return count;
    }
    var slots = [];
    if (fresh) {
      // Nothing much is known yet: everybody gets an even share, and the App's own pieces are asked
      // of two mirrors at once (see duplicateMust) so that a dead one costs nothing but bandwidth.
      // Half the connections, then, so that the doubled requests still fit into one round.
      var order = knownHosts.concat(unknownHosts);
      for (var s = 0; slots.length < Math.max(2, Math.floor(config.conns / 2)) && order.length; s += 1) {
        var candidate = order[s % order.length];
        slots.push({ host: candidate, bps: speedOf(candidate) || assumedBps, explore: false });
      }
    } else {
      // Bandwidth is the sum over mirrors, so first give one connection to EVERY mirror we trust
      // (fastest first) rather than piling several onto the top few. Then probe a handful of
      // unmeasured mirrors so a wide pool is learned. Only then are spare connections handed back to
      // the fastest mirrors, up to BTRA_PER_HOST each, counting whatever the other stream is using.
      var perHostCount = {};
      var roomFor = function (host) { return BTRA_PER_HOST - busyCount(host) - (perHostCount[host] || 0); };
      var pushSlot = function (host, explore) {
        perHostCount[host] = (perHostCount[host] || 0) + 1;
        slots.push({ host: host, bps: speedOf(host) || Math.min(assumedBps, BTRA_ASSUMED_BPS), explore: !!explore });
      };
      for (var k = 0; k < knownHosts.length && slots.length < config.conns; k += 1) {
        if (roomFor(knownHosts[k]) > 0) pushSlot(knownHosts[k], false);
      }
      // Probe unmeasured mirrors hard while the roster is thin (a wide pool must be learned fast),
      // then ease off to a single probe once enough are known, so read-ahead is not crowded out.
      var exploreN = knownHosts.length >= 6 ? 1 : BTRA_EXPLORE;
      for (var u = 0; u < unknownHosts.length && u < exploreN && slots.length < config.conns; u += 1) {
        if (roomFor(unknownHosts[u]) > 0) pushSlot(unknownHosts[u], true);
      }
      var progress = true;
      while (slots.length < config.conns && progress) {
        progress = false;
        for (var f = 0; f < knownHosts.length && slots.length < config.conns; f += 1) {
          if (roomFor(knownHosts[f]) > 0) { pushSlot(knownHosts[f], false); progress = true; break; }
        }
      }
    }
    // Fastest connections first, probes last: the piece loop below hands out the App's own (blocking)
    // bytes from the front of this list and the read-ahead from what remains, so both prefer the
    // quick mirrors and the slow ones only ever pick up the furthest, most disposable read-ahead.
    slots.sort(function (a, b) {
      if (a.explore !== b.explore) return a.explore ? 1 : -1;
      return b.bps - a.bps;
    });
    var duplicateMust = fresh;
    busyNote(slots.map(function (slot) { return slot.host; }));
    // A connection's slice: what its mirror should deliver in BTRA_SLICE_MS. Too slow for even the
    // smallest piece → 0, the connection sits this batch out.
    function slotBytes(slot) {
      var bytes = Math.min(BTRA_MAX_PIECE, Math.round(slot.bps * BTRA_SLICE_MS));
      return bytes >= BTRA_MIN_SLOT ? bytes : 0;
    }
    // What one batch can carry (used to size answers to open-ended requests).
    var capacity = 0;
    for (var cs = 0; cs < slots.length; cs += 1) if (!slots[cs].explore) capacity += slotBytes(slots[cs]);
    if (duplicateMust) capacity = Math.round(capacity / 2);

    // How much goes into this one answer. A range the App spelled out is answered exactly as long as
    // it fits in memory comfortably. "From here to the end" (or a huge range) gets what one batch can
    // carry — more when the cache already holds the continuation, so the player needs fewer
    // reconnects.
    var end = wantedEnd;
    var plannedShort = false;
    if (!bounded || wantedEnd - start + 1 > BTRA_EXACT_LIMIT) {
      var replyBytes = Math.max(start === 0 ? 1048576 : BTRA_OPEN_REPLY, Math.min(BTRA_MAX_REPLY, capacity));
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

    function respond(body, fromCacheBytes, pieceCount, elapsed, detail) {
      var isShort = end < wantedEnd;
      change("bump", "served", body.length);
      change("bump", "servedCached", fromCacheBytes);
      if (isShort) change("bump", "shortReplies", 1);
      if (elapsed > 4000) change("bump", "slowRuns", 1);
      change("rdone", pathKey, start, startedAt, isShort ? "short" : "ok", elapsed);
      var record = { k: pieceCount ? (fromCacheBytes ? "part" : "miss") : "hit", a: currentAsked, s: body.length, ms: elapsed, sh: isShort ? 1 : 0 };
      if (detail) { record.f = detail.fetched; record.m = detail.mustMs; record.p = pieceCount; record.c = detail.capacity; record.n = detail.slots; }
      change("run", record);
      var headers = {
        "Content-Type": contentType || "video/mp4",
        "Content-Range": "bytes " + start + "-" + end + "/" + total,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "X-BTR-iOS": BTRA_VERSION + "; pieces=" + pieceCount + "; cached=" + fromCacheBytes + "; ms=" + elapsed + "; capacity=" + capacity
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

    var mustBytes = 0;
    for (var mb = 0; mb < missing.length; mb += 1) mustBytes += missing[mb].e - missing[mb].s + 1;
    // A small request (the player probing a file header, or a small gap in the cache) is answered
    // quickly on its own; the read-ahead comes with the next real block.
    var extras = [];
    if (caching && config.aheadBytes && mustBytes >= 262144) {
      // Never more than half the cache in one go: the other stream (sound) needs room too.
      var ahead = Math.max(0, Math.min(config.aheadBytes, Math.round(config.cacheBytes / 2) - mustBytes));
      if (total) ahead = Math.min(ahead, Math.max(1048576, Math.round(total / 8)));
      if (!total) ahead = Math.min(ahead, 1048576);
      var aheadEnd = total ? Math.min(total - 1, end + ahead) : end + ahead;
      if (aheadEnd > end) {
        var region = coverage(pathKey, end + 1, aheadEnd, false);
        for (var r = 0; r < region.length; r += 1) if (!region[r].entry) extras.push({ s: region[r].s, e: region[r].e });
      }
    }
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

    /* ---- pieces ----
     * One round: every connection gets one piece, its slice, so the whole batch lands at about the
     * same moment (BTRA_SLICE_MS plus connection set-up). The App's bytes are handed to the fastest
     * connections first, the read-ahead to the rest. A batch without read-ahead (a probe, a small
     * gap, the App's bytes on their own) is cut finer instead: every measured connection takes a
     * share in proportion to its speed, which is the quickest way to get those bytes here.
     */
    var pieces = [];
    var batchBytes = 0;
    var mustQueue = missing.map(function (segment) { return { s: segment.s, e: segment.e }; });
    var extraQueue = extras;
    function take(queue, bytes) {
      if (!queue.length) return null;
      var segment = queue[0];
      var pieceEnd = Math.min(segment.e, segment.s + bytes - 1);
      var range = { start: segment.s, end: pieceEnd };
      if (pieceEnd === segment.e) queue.shift(); else segment.s = pieceEnd + 1;
      return range;
    }
    function addPiece(range, extra, slot) {
      pieces.push({ index: pieces.length, start: range.start, end: range.end, extra: extra, slot: slot });
      batchBytes += range.end - range.start + 1;
    }
    var usable = slots.filter(function (slot) { return !slot.explore && slotBytes(slot) > 0; });
    if (!usable.length) usable = slots.filter(function (slot) { return !slot.explore; });
    if (extraQueue.length) {
      for (var si = 0; si < slots.length; si += 1) {
        var slice = slotBytes(slots[si]);
        if (!slice) continue;
        var range = slots[si].explore ? null : take(mustQueue, slice);
        if (range) { addPiece(range, false, slots[si]); continue; }
        if (batchBytes >= BTRA_MAX_BATCH) break;
        range = take(extraQueue, Math.max(BTRA_MIN_SLOT, Math.min(Math.round(slice * BTRA_EXTRA_SHARE), BTRA_MAX_BATCH - batchBytes)));
        if (range) addPiece(range, true, slots[si]);
      }
    } else {
      var sumBps = 0;
      for (var ub = 0; ub < usable.length; ub += 1) sumBps += usable[ub].bps;
      for (var ws = 0; ws < usable.length && mustQueue.length; ws += 1) {
        var share = Math.max(BTRA_MIN_SLOT, Math.min(BTRA_MAX_PIECE, Math.round(mustBytes * usable[ws].bps / sumBps)));
        var part = take(mustQueue, share);
        if (part) addPiece(part, false, usable[ws]);
      }
    }
    // Whatever is left of the App's bytes (a big request, a slow network): more rounds over the
    // fastest connections; those pieces queue up behind the first ones.
    for (var cycle = 0; mustQueue.length && cycle < 256; cycle += 1) {
      var again = usable[cycle % Math.max(1, Math.min(usable.length, 8))];
      if (!again) break;
      var more = take(mustQueue, Math.max(BTRA_MIN_SLOT, slotBytes(again)));
      if (more) addPiece(more, false, again);
    }
    var mustCount = 0;
    for (var pc = 0; pc < pieces.length; pc += 1) if (!pieces[pc].extra) mustCount += 1;

    var failed = false;
    var delivered = false;
    var mustLeft = mustCount;
    var extraLeft = pieces.length - mustCount;
    var launchedAt = 0;
    var mustDoneAt = 0;
    var inflight = 0;
    var hostInflight = {};
    var queue = pieces.slice();
    var tasks = [];
    var goodHosts = [];
    var results = new Array(pieces.length);
    var fetchedBytes = 0;
    var hedges = 0;

    function strikePending(reason) {
      // Mirrors whose pieces are still outstanding well after their slice time get a "late" mark:
      // their speed estimate drops (smaller pieces next time), and three in a row bench them.
      var lateLine = Date.now() - (BTRA_SLICE_MS + 300);
      var marked = {};
      for (var index = 0; index < tasks.length; index += 1) {
        var task = tasks[index];
        if (task.done || task.inflight <= 0 || !task.launchedAt) continue;
        // An exploration piece gets no margin: a mirror that cannot deliver its small piece in the
        // slice time is not one to explore again soon. One mark per mirror per batch.
        var lateHost = task.used[task.used.length - 1];
        if (marked[lateHost]) continue;
        if (task.launchedAt < lateLine || (task.piece.slot.explore && task.launchedAt < Date.now() - BTRA_SLICE_MS)) { marked[lateHost] = true; change("late", lateHost, Date.now(), reason); }
      }
    }

    function giveUp(reason) {
      if (failed || finished) return;
      failed = true;
      change("bump", "failed", 1);
      change("set", "lastError", reason);
      change("rdone", pathKey, start, startedAt, "fail", Date.now() - startedAt);
      change("run", { k: "fail", a: currentAsked, ms: Date.now() - startedAt, r: reason, f: fetchedBytes, p: pieces.length });
      var key = "origin:" + originHost;
      change("streak", key, 1);
      if ((state.streaks[key] || 0) >= 4) {
        change("breaker", key, { until: Date.now() + 5 * 60000, reason: "这类地址在镜像节点上取不到（" + reason + "）" });
        change("streak", key, null);
        notifyOnce("breaker-origin", 5 * 60000, "BTR App 模式暂时让路", originHost, "连续几次没能从镜像节点拿到数据（" + reason + "），先原样放行 5 分钟。");
      }
      strikePending(reason);
      storeFetched();
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
        timeout: BTRA_PIECE_TIMEOUT,
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

    // Retries and hedges go to the fastest mirror that still has a free connection and has not
    // been asked for this piece; mirrors that answered in this very run count as fastest.
    function pickHost(piece, attempt, used) {
      if (attempt === 0 && used.indexOf(piece.slot.host) < 0) return piece.slot.host;
      var candidates = goodHosts.concat(knownHosts, unknownHosts, pool);
      var seen = {};
      for (var index = 0; index < candidates.length; index += 1) {
        var host = candidates[index];
        if (seen[host] || used.indexOf(host) >= 0) continue;
        seen[host] = true;
        if ((hostInflight[host] || 0) < BTRA_PER_HOST) return host;
      }
      return "";
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
      while (queue.length && inflight < config.conns && !failed && !finished) {
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
        if (task.done || failed || finished || task.launched >= (piece.extra ? 2 : 4)) return false;
        var host = pickHost(piece, task.launched, task.used);
        if (!host) return false;
        if (!task.launched) task.launchedAt = Date.now();
        task.launched += 1;
        task.inflight += 1;
        inflight += 1;
        hostInflight[host] = (hostInflight[host] || 0) + 1;
        task.used.push(host);
        requestPiece(host, piece, function (problem, data, range, response, ms, eof) {
          task.inflight -= 1;
          inflight -= 1;
          hostInflight[host] -= 1;
          if (finished || failed) {
            if (delivered && !failed && !problem && !eof && !task.done) { task.done = true; lateStore(piece, data); }
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
      var budget = BTRA_HEDGE_BUDGET - hedges;
      for (var pick = 0; pick < tasks.length && budget > 0; pick += 1) {
        var task = tasks[pick];
        if (!task.done && !task.piece.extra && task.inflight >= 1 && task.launched <= 2 && task.launch()) { budget -= 1; hedges += 1; }
      }
    }

    function storeFetched() {
      if (!caching) return;
      // Everything fetched (the App's bytes too, for a retry or a step back) merged into contiguous
      // runs; each run becomes one cache entry.
      var list = [];
      for (var index = 0; index < results.length; index += 1) if (results[index]) list.push(results[index]);
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
        if (run.length && (run[run.length - 1].start + run[run.length - 1].data.length !== list[l].start || runBytes + list[l].data.length > 1048576)) flush();
        run.push(list[l]);
        runBytes += list[l].data.length;
      }
      flush();
    }

    // Should Loon keep this run alive after $done (it does not, as far as is known), pieces that
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
      for (var pending = 0; pending < tasks.length; pending += 1) if (!tasks[pending].done && tasks[pending].piece.extra && !tasks[pending].piece.slot.explore) pendingCore += 1;
      if (extraLeft > 0 && !pendingCore) extraLeft = 0;
      if (extraLeft > 0) {
        if (typeof setTimeout !== "function") extraLeft = 0;
        else {
          // The read-ahead pieces were cut shorter than the App's, so the healthy ones are already
          // here; a short wait for the rest, then the answer goes out.
          if (graceTimer === null) {
            var grace = Math.max(150, Math.min(400, launchedAt + BTRA_SLICE_MS + 400 - Date.now()));
            graceTimer = setTimeout(function () { extraLeft = 0; settle(); }, grace);
          }
          return;
        }
      }
      delivered = true;
      strikePending("late");
      var body = assemble();
      if (!body) { giveUp("拼装后的长度不符"); return; }
      var elapsed = Math.max(1, Date.now() - startedAt);
      var batchMs = Math.max(1, Date.now() - launchedAt);
      change("bump", "batches", 1);
      change("bump", "fetched", fetchedBytes);
      change("bump", "prepMs", launchedAt - startedAt);
      change("bump", "mustMs", mustDoneAt - startedAt);
      change("bump", "allMs", elapsed);
      change("set", "lastCapacity", capacity);
      // Only batches that keep the connections busy say something about the speed; a small gap
      // filled with a few pieces is bound by latency, not throughput.
      if (pieces.length >= slots.length / 2) change("ewma", "bps", fetchedBytes / batchMs);
      if (state.streaks["origin:" + originHost]) change("streak", "origin:" + originHost, null);
      notifyOnce("working", 6 * 3600000, "BTR App 模式正在加速", config.conns + " 连接 · " + (config.overseas ? "海外 CDN" : "大陆 CDN"), "刚才这一批 " + sizeText(fetchedBytes) + " 用了 " + (batchMs / 1000).toFixed(1) + " 秒（" + pieces.length + " 个子块）。统计页：" + BTRA_STATUS_URL);
      storeFetched();
      respond(body, cachedBytes, pieces.length, elapsed, { fetched: fetchedBytes, mustMs: mustDoneAt - startedAt, capacity: capacity, slots: slots.length });
    }

    if (typeof setTimeout === "function") {
      setTimeout(function () { giveUp("超过 " + Math.round(BTRA_DEADLINE / 1000) + " 秒还没拼齐"); }, BTRA_DEADLINE);
      setTimeout(function () { hedge(true); }, Math.round(BTRA_SLICE_MS * 1.4));
      setTimeout(function () { hedge(true); }, Math.round(BTRA_SLICE_MS * 2.2));
      setTimeout(function () { hedge(true); }, Math.round(BTRA_SLICE_MS * 3.2));
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
