/*
 * BTR-iOS · App 模式  —  1.5.0
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
 * 1.5.0 起跟进原版（油猴版 2026.9.27.1）下载内核里能用在 App 上的调度规则：
 *   - 自动连接数：8 → 12 → 16 → 24 → 32 → 48，App 等得久了就加一档；每次加档都是一次试验，
 *     10 秒后整体速度没有变快就退回并让这一档休息 90 秒；节点返回 412 / 429（限流）退一档，
 *     3 分钟内不再升到被拒的那一档；
 *   - 测得比最快节点慢 12 倍以上的节点暂时不用，测速过了 90 秒再重新试；
 *   - 节点只拒绝某一个视频（它能给别的视频）时，只停用“这个节点 + 这个视频”，不停整个节点；
 *   - 对冲副本只发给测得快 1.5 倍以上的节点；App 已经等了很久才不挑；
 *   - 太小的子块测出来的速度主要是往返延迟，按大小打折计入，不把节点的测速压下去。
 *
 * 统计页（Safari 打开 https://www.bilibili.com/__btr_app__/ ）还带三个小实验，告诉作者 Loon 在
 * $done 之后还让不让脚本继续跑、脚本自己发的请求会不会再触发脚本、存储能不能装下几 MB。
 *
 * 只读请求头、只搬运视频字节；不读取也不保存账号、Cookie 或播放记录，不向任何第三方发数据。
 * Generated file — edit src/ and run `node build.js` instead.
 */
var BTRA_VERSION = "1.5.0";
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
// Automatic connection count (upstream 0.9.4.0, adapted): the ladder, where it starts, how long
// between steps, how long a step is on trial, how long a fruitless / refused level rests.
var BTRA_AUTO_LADDER = [8, 12, 16, 24, 32, 48];
var BTRA_AUTO_START = 2;
var BTRA_AUTO_STEP_MS = 2500;
var BTRA_AUTO_TRIAL_MS = 10000;
var BTRA_AUTO_WINDOW_MS = 20000;
var BTRA_AUTO_REST_MS = 90000;
var BTRA_AUTO_PUSHBACK_MS = 180000;
var BTRA_AUTO_WAIT_MS = 1500;          // the App waiting longer than this for its bytes is pressure
var BTRA_AUTO_STALL_MS = 3000;         // …longer than this, or asking again, counts as a stall
var BTRA_AUTO_GAIN = 1.1;              // a step is kept only when it made batches at least this much quicker
var BTRA_SLOW_SHARE = 12;              // a mirror under a twelfth of the fastest sits out (upstream)
var BTRA_MEASURE_TTL = 90000;          // …until its measurement is this old; then it is tried again
var BTRA_HEDGE_FASTER = 1.5;           // a hedge copy goes to a mirror measured this much faster
var BTRA_SAMPLE_FULL = 48 * 1024;      // a piece this long measures speed; shorter ones mostly RTT
var BTRA_PAIR_LIMIT = 2;               // refusals of one file before that mirror + file pair is dropped
var BTRA_PAIR_TTL = 20 * 60000;

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
    // "自动" (the default, as upstream) or a fixed number of connections.
    var conns = parseInt(map.conns !== undefined ? map.conns : map.threads, 10);
    var fixed = conns >= 1 && conns <= 64;
    return {
      auto: !fixed,
      conns: fixed ? conns : BTRA_AUTO_LADDER[BTRA_AUTO_START],
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
    return { v: 2, since: Date.now(), rr: 0, totals: {}, hosts: {}, recent: [], breaker: {}, streaks: {}, notes: {}, stats: {}, cache: [], heads: {}, flags: {}, runs: [], auto: {}, autoS: [], pairs: {}, origins: {} };
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
    return state.hosts[host] || (state.hosts[host] = { ok: 0, bad: 0, late: 0, streak: 0, lateStreak: 0, until: 0, benches: 0, bps: 0, at: 0, refused: 0, limited: 0 });
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
    else if (kind === "auto") {
      // op[2]: the version of the record this run's decision was based on (every write gets a new,
      // unique one). If another run (the other stream) wrote in between, its decision stands; this
      // run only adds the levels it rested, and a push-back (op[3] === "down") still lowers the level.
      var current = state.auto || {};
      var incoming = op[1];
      if ((current.v || "") === (op[2] || "")) state.auto = incoming;
      else {
        var merged = { v: incoming.v + "m", lvl: current.lvl, at: current.at, why: current.why, trial: current.trial || null, rest: {}, log: (current.log || []).slice(), steps: current.steps || 0 };
        for (var mine in current.rest || {}) merged.rest[mine] = current.rest[mine];
        for (var theirs in incoming.rest || {}) {
          var had = merged.rest[theirs], add = incoming.rest[theirs];
          if (!had || (add.hard && !had.hard) || (add.hard === had.hard && add.until > had.until)) merged.rest[theirs] = add;
        }
        if (op[3] === "down" && typeof merged.lvl === "number" && incoming.lvl < merged.lvl) {
          merged.lvl = incoming.lvl; merged.trial = null; merged.at = incoming.at; merged.why = incoming.why;
          var lastStep = incoming.log && incoming.log[incoming.log.length - 1];
          if (lastStep) merged.log.push(lastStep);
          while (merged.log.length > 8) merged.log.shift();
          merged.steps += 1;
        }
        state.auto = merged;
      }
    }
    else if (kind === "asample") {
      state.autoS.push(op[1]);
      while (state.autoS.length > 40 || (state.autoS.length && op[1].t - state.autoS[0].t > 60000)) state.autoS.shift();
    }
    else if (kind === "origin") {
      var seenOrigin = state.origins[op[1]];
      state.origins[op[1]] = { n: (seenOrigin && seenOrigin.n || 0) + 1, t: op[2] };
    }
    else if (kind === "refused") {
      // This mirror serves other files but refused this one: only the pair is counted against.
      var refusing = hostRecord(state, op[1]);
      refusing.refused = (refusing.refused || 0) + 1;
      var pairKey = op[1] + " " + op[2];
      var pair = state.pairs[pairKey];
      state.pairs[pairKey] = { n: (pair && op[3] - pair.t < BTRA_PAIR_TTL ? pair.n : 0) + 1, t: op[3] };
    }
    else if (kind === "probe") { var probed = hostRecord(state, op[1]); if (probed.bps > 0) probed.at = op[2]; }
    else if (kind === "limited") {
      // op[3]: how many connections the mirror was carrying for us when it said no — what it
      // tolerates, for a while (0: it refused even a single one).
      var limitedHost = hostRecord(state, op[1]);
      limitedHost.limited = (limitedHost.limited || 0) + 1;
      if (op[3] > 0) { limitedHost.cap = op[3]; limitedHost.capAt = op[2]; }
    }
    else if (kind === "host") {
      var item = hostRecord(state, op[1]);
      if (op[2]) {
        item.ok += 1; item.streak = 0; item.lateStreak = 0; item.until = 0; item.benches = 0;
        // A first sample from a short piece is mostly round trip: it gives a speed to start from, but
        // not one to leave the mirror out on (it stays "old", so a slow-looking mirror is re-probed
        // with an ordinary piece first).
        if (op[5] >= BTRA_SAMPLE_FULL || item.bps > 0 || !(op[5] > 0)) item.at = op[3];
        // A short piece is mostly round trip and would mark the mirror down: its sample counts for
        // less the shorter it is (upstream ignores transfers under 48 KB for the same reason).
        var weight = 0.3 * (op[5] > 0 ? Math.min(1, op[5] / BTRA_SAMPLE_FULL) : 1);
        if (op[4] > 0) item.bps = item.bps ? item.bps * (1 - weight) + op[4] * weight : op[4];
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
      var pairNames = [];
      for (var pairName in fresh.pairs) {
        if (!(now - fresh.pairs[pairName].t < BTRA_PAIR_TTL)) delete fresh.pairs[pairName];
        else pairNames.push(pairName);
      }
      if (pairNames.length > 80) {
        pairNames.sort(function (a, b) { return fresh.pairs[a].t - fresh.pairs[b].t; });
        for (var pairCut = 0; pairCut < pairNames.length - 60; pairCut += 1) delete fresh.pairs[pairNames[pairCut]];
      }
      var originNames = [];
      for (var originName in fresh.origins) {
        if (typeof fresh.origins[originName] !== "object") delete fresh.origins[originName];
        else originNames.push(originName);
      }
      if (originNames.length > 16) {
        // the most recently seen ones stay
        originNames.sort(function (a, b) { return fresh.origins[b].t - fresh.origins[a].t; });
        for (var originCut = 12; originCut < originNames.length; originCut += 1) delete fresh.origins[originNames[originCut]];
      }
      // Fuses and failure streaks are kept per origin host; with every regional node decrypted
      // there can be many of them. Expired fuses and cleared streaks go.
      for (var fuse in fresh.breaker) if (!(fresh.breaker[fuse] && fresh.breaker[fuse].until > now)) delete fresh.breaker[fuse];
      var streakNames = [];
      for (var streakName in fresh.streaks) {
        if (!fresh.streaks[streakName]) delete fresh.streaks[streakName];
        else streakNames.push(streakName);
      }
      for (var streakCut = 0; streakCut < streakNames.length - 40; streakCut += 1) delete fresh.streaks[streakNames[streakCut]];
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

  /* ------------------------------------------------------------ automatic connection count
   * Upstream's rule (0.9.4.0), fed with what an App-mode run can see. The browser version climbs when
   * the player stalls or its buffer stops growing; here the signs are the App waiting for its own
   * bytes (a batch whose App part took over BTRA_AUTO_WAIT_MS is pressure; over BTRA_AUTO_STALL_MS,
   * or the App asking for the same position again while the last answer was slow or still pending,
   * is a stall). Throughput is what full batches delivered per millisecond. It all lives in the
   * shared record, so picture and sound, and every later run, climb the same ladder.
   */

  function autoLevel() {
    var level = state.auto && typeof state.auto.lvl === "number" ? state.auto.lvl : BTRA_AUTO_START;
    return level >= 0 && level < BTRA_AUTO_LADDER.length ? level : BTRA_AUTO_START;
  }

  // A private copy of the automatic state to change and write back as a whole (last writer wins —
  // the two streams would compute the same step anyway).
  function autoCopy(now) {
    var current = state.auto || {};
    var rest = {};
    for (var level in current.rest || {}) if (current.rest[level] && current.rest[level].until > now) rest[level] = current.rest[level];
    var trial = null;
    if (current.trial) trial = { from: current.trial.from, to: current.trial.to, at: current.trial.at, base: current.trial.base, stalled: !!current.trial.stalled };
    return { v: current.v || "", lvl: autoLevel(), at: current.at || 0, why: current.why || "", trial: trial, rest: rest, log: (current.log || []).slice(-7), steps: current.steps || 0 };
  }

  // Writes the automatic state back, noting which version of it this run's decision was based on
  // (see the "auto" op). kind "down": a push-back, which must survive the other stream's write.
  var autoWrites = 0;
  function autoWrite(next, kind) {
    var basedOn = state.auto && state.auto.v || "";
    autoWrites += 1;
    next.v = runId + "." + autoWrites;
    change("auto", next, basedOn, kind || "");
  }

  function autoSet(next, now, why, kind) {
    next.at = now;
    next.why = why;
    next.steps += 1;
    next.log.push({ t: now, n: BTRA_AUTO_LADDER[next.lvl], m: why });
    while (next.log.length > 8) next.log.shift();
    autoWrite(next, kind);
  }

  // Bytes per millisecond that full batches at this level delivered between two moments.
  function autoThroughput(level, from, to) {
    var bytes = 0;
    var ms = 0;
    var count = 0;
    for (var index = 0; index < state.autoS.length; index += 1) {
      var sample = state.autoS[index];
      if (sample.l === level && sample.t >= from && sample.t <= to) { bytes += sample.b; ms += sample.ms; count += 1; }
    }
    return { bps: ms > 0 ? bytes / ms : 0, count: count };
  }

  // Every step up is a trial. After BTRA_AUTO_TRIAL_MS the full batches since must be clearly quicker
  // than the ones before it (BTRA_AUTO_GAIN: batch speeds are noisy, and "as quick as before" would
  // let noise walk the count up the ladder), otherwise the step is taken back and that level rests
  // for a while. Too few full batches meanwhile (the App had enough), or a stall during the trial,
  // prove nothing: the level stays.
  function autoJudge(now) {
    var trial = state.auto && state.auto.trial;
    if (!config.auto || !trial || now - trial.at < BTRA_AUTO_TRIAL_MS) return;
    var next = autoCopy(now);
    next.trial = null;
    var after = autoThroughput(trial.to, trial.at, now);
    if (trial.stalled || after.count < 2 || !(trial.base > 0) || after.bps >= trial.base * BTRA_AUTO_GAIN) { autoWrite(next); return; }
    next.lvl = trial.from;
    next.rest[trial.to] = { until: now + BTRA_AUTO_REST_MS, hard: false };
    autoSet(next, now, BTRA_AUTO_LADDER[trial.to] + " 条没有比 " + BTRA_AUTO_LADDER[trial.from] + " 条更快，退回");
  }

  // One level up. A level resting after a refusal (412 / 429) caps the climb; one resting after a
  // fruitless trial is skipped only on a stall.
  function autoUp(now, why, strong) {
    if (!config.auto) return false;
    var next = autoCopy(now);
    if (strong && next.trial && !next.trial.stalled) next.trial.stalled = true;
    if (now - next.at < BTRA_AUTO_STEP_MS) {
      if (strong && next.trial && !(state.auto.trial && state.auto.trial.stalled)) autoWrite(next);
      return false;
    }
    var here = next.rest[next.lvl];
    if (here && here.hard) return false;
    // Pressure alone moves only a level that has shown what it does (a full batch since it was set),
    // so that every trial has a baseline to beat, and not while a step is still on trial — each step
    // gets judged. A stall moves at once.
    if (!strong && autoThroughput(next.lvl, next.at, now).count < 1) return false;
    if (!strong && next.trial && !next.trial.stalled && now - next.trial.at < BTRA_AUTO_TRIAL_MS) return false;
    var target = next.lvl + 1;
    while (target < BTRA_AUTO_LADDER.length && next.rest[target]) {
      if (next.rest[target].hard || !strong) return false;
      target += 1;
    }
    if (target >= BTRA_AUTO_LADDER.length) return false;
    // The baseline: full batches at this level lately; failing that, any at this level; failing that,
    // the running average over all batches. (A step without a baseline could never be judged.)
    var base = autoThroughput(next.lvl, now - BTRA_AUTO_WINDOW_MS, now).bps || autoThroughput(next.lvl, 0, now).bps || state.stats.bps || 0;
    next.trial = { from: next.lvl, to: target, at: now, base: base, stalled: false };
    next.lvl = target;
    autoSet(next, now, why);
    return true;
  }

  // A mirror refused the load: one level down, and this level rests (hard) for a while.
  function autoPushback(now, status) {
    if (!config.auto) return;
    var next = autoCopy(now);
    next.rest[next.lvl] = { until: now + BTRA_AUTO_PUSHBACK_MS, hard: true };
    next.trial = null;
    if (next.lvl > 0) {
      next.lvl -= 1;
      autoSet(next, now, "节点返回 " + status + "（限流），退一档", "down");
    } else autoWrite(next, "down");
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
    var slowCount = 0;
    var aggBps = 0;
    var topBps = 0;
    for (var fastest in current.hosts) if (!(current.hosts[fastest].until > now) && current.hosts[fastest].bps > topBps) topBps = current.hosts[fastest].bps;
    var hostNames = [];
    for (var hostName in current.hosts) hostNames.push(hostName);
    hostNames.sort(function (a, b) { return (current.hosts[b].bps || 0) - (current.hosts[a].bps || 0); });
    for (var hn = 0; hn < hostNames.length; hn += 1) {
      var host = hostNames[hn];
      var item = current.hosts[host];
      var slow = !(item.until > now) && item.bps > 0 && item.bps < topBps / BTRA_SLOW_SHARE && now - (item.at || 0) < BTRA_MEASURE_TTL;
      if (item.until > now) benchedHosts += 1;
      else if (slow) slowCount += 1;
      else if (item.bps > 0) { liveHosts += 1; aggBps += item.bps; }
      hosts.push(escapeHtml(shortHost(host) + "：成功 " + (item.ok || 0) + " / 失败 " + (item.bad || 0) + " / 迟到 " + (item.late || 0) +
        (item.refused ? " / 拒绝单个视频 " + item.refused : "") + (item.limited ? " / 限流 " + item.limited : "") +
        (item.bps ? " · " + Math.round(item.bps * 1000 / 1024) + " KB/s" : "") + (item.until > now ? "（停用中）" : slow ? "（太慢，暂不用）" : "")));
    }
    var pairCount = 0;
    for (var pairName in current.pairs) if (current.pairs[pairName].n >= BTRA_PAIR_LIMIT && now - current.pairs[pairName].t < BTRA_PAIR_TTL) pairCount += 1;
    var hostSummary = "在用 " + liveHosts + " 个镜像 · 合计约 " + Math.round(aggBps * 1000 / 1024) + " KB/s" + (benchedHosts ? " · 停用 " + benchedHosts + " 个" : "") +
      (slowCount ? " · 太慢暂不用 " + slowCount + " 个" : "") + (pairCount ? " · 只对个别视频停用 " + pairCount + " 对" : "");
    // Automatic connection count: where it is, why, and the last few steps.
    var autoInfo = current.auto || {};
    var autoLvl = typeof autoInfo.lvl === "number" && autoInfo.lvl >= 0 && autoInfo.lvl < BTRA_AUTO_LADDER.length ? autoInfo.lvl : BTRA_AUTO_START;
    var connsText;
    if (!config.auto) connsText = "固定 " + config.conns + " 条（插件参数里选“自动”可以让它自己调）";
    else {
      connsText = "自动 · 现在 " + BTRA_AUTO_LADDER[autoLvl] + " 条" + (autoInfo.why ? "（" + autoInfo.why + "）" : "（起步）");
      if (autoInfo.trial && now - autoInfo.trial.at < BTRA_AUTO_TRIAL_MS * 3) connsText += " · 正在试 " + BTRA_AUTO_LADDER[autoInfo.trial.to] + " 条是否更快";
      var resting = [];
      for (var restLevel in autoInfo.rest || {}) if (autoInfo.rest[restLevel].until > now) resting.push(BTRA_AUTO_LADDER[restLevel] + " 条" + (autoInfo.rest[restLevel].hard ? "（被限流）" : "") + "休息 " + Math.ceil((autoInfo.rest[restLevel].until - now) / 1000) + " 秒");
      if (resting.length) connsText += " · " + resting.join("、");
      var steps = (autoInfo.log || []).slice().reverse();
      for (var st = 0; st < steps.length; st += 1) if (steps[st] && steps[st].t) connsText += "\n" + new Date(steps[st].t).toLocaleTimeString() + " → " + steps[st].n + " 条：" + steps[st].m;
    }
    var originList = [];
    for (var originName in current.origins) originList.push(originName);
    originList = originList.filter(function (name) { return current.origins[name] && typeof current.origins[name] === "object"; });
    originList.sort(function (a, b) { return current.origins[b].n - current.origins[a].n; });
    var originText = originList.slice(0, 8).map(function (name) { return escapeHtml(name + " × " + current.origins[name].n); }).join("<br>");
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
      ["设置", escapeHtml((config.auto ? "自动连接数" : config.conns + " 条连接") + " · 预读 " + (config.aheadBytes ? sizeText(config.aheadBytes) : "关") + " · 缓存上限 " + (config.cacheBytes ? sizeText(config.cacheBytes) : "关") + " · " + (config.overseas ? "海外 CDN" : "大陆 CDN") + " · 大范围请求：" + (config.chunkReplies ? "分块答复" : "原样放行"))],
      ["统计起点", escapeHtml(new Date(current.since).toLocaleString())],
      ["连接数", escapeHtml(connsText).replace(/\n/g, "<br>")],
      ["来源节点", originText || "还没有记录"],
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
      ["限流（412/429）", escapeHtml((stats.limited || 0) + " 次" + (stats.limited ? (config.auto ? "（被拒时开着多条连接的话，自动连接数退一档；那个节点 3 分钟内少给连接）" : "（连接数调小一些，或改成“自动”）") : ""))],
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
    // Refusals are remembered per address: the file plus its signature. A freshly signed address for
    // the same file (after a long pause the old one expires and every mirror refuses it) starts clean.
    var signature = /[?&]upsig=([0-9A-Za-z]{1,12})/.exec(parts[5] || "");
    var addressKey = pathKey + (signature ? "#" + signature[1] : "");
    var now = Date.now();
    change("bump", "seen", 1);
    change("rr");
    change("origin", originHost, now);
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
    // Automatic connection count: judge a step that has had its time; the App asking again because
    // the last answer was slow (or never came) is a stall.
    autoJudge(now);
    if (repeats && previous && (!previous.o || ((previous.o === "ok" || previous.o === "short") && previous.ms > BTRA_AUTO_WAIT_MS))) {
      autoUp(now, "App 又要了一次同一段（上次答得慢）", true);
    }
    if (config.auto) config.conns = BTRA_AUTO_LADDER[autoLevel()];
    var runLevel = autoLevel();
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
    // Left out for this file: a mirror that serves other files but has refused this one (twice,
    // lately — upstream: "只停用这一个组合，不会把整个节点停掉"); within one run a single refusal will do.
    var refusedHere = {};
    function leftOut(host) {
      if (refusedHere[host]) return true;
      var pair = state.pairs[host + " " + addressKey];
      return !!pair && pair.n >= BTRA_PAIR_LIMIT && now - pair.t < BTRA_PAIR_TTL;
    }
    // How many connections a mirror takes at once: BTRA_PER_HOST, or fewer while it is known to turn
    // more away (412 / 429 with some of ours open: it keeps what it had, for BTRA_AUTO_PUSHBACK_MS).
    var capHere = {};
    function hasRoom(host) {
      var cap = capOf(host);
      return (hostInflight[host] || 0) + (cap < BTRA_PER_HOST ? busyCount(host) : 0) < cap;
    }
    function capOf(host) {
      if (capHere[host]) return capHere[host];
      var record = state.hosts[host];
      return record && record.cap > 0 && now - (record.capAt || 0) < BTRA_AUTO_PUSHBACK_MS ? Math.min(BTRA_PER_HOST, record.cap) : BTRA_PER_HOST;
    }
    var allowed = everyMirror.filter(function (host) { return !leftOut(host); });
    // Every mirror has refused this very address lately (an expired signature, content the mirrors do
    // not carry): nothing to try, let the App fetch it itself at once.
    if (!allowed.length) { passThrough("所有镜像都拒绝了这个地址"); return; }
    var pool = allowed.filter(function (host) { return !(state.hosts[host] && state.hosts[host].until > now); });
    if (pool.length < 2) pool = allowed.slice();
    var speedOf = function (host) { var record = state.hosts[host]; return record && record.bps > 0 ? record.bps : 0; };
    var triesOf = function (host) { var record = state.hosts[host]; return record ? (record.ok || 0) + (record.bad || 0) + (record.late || 0) : 0; };
    var measuredAt = function (host) { var record = state.hosts[host]; return record && record.at || 0; };
    var knownHosts = pool.filter(function (host) { return speedOf(host) > 0; }).sort(function (a, b) { return speedOf(b) - speedOf(a); });
    var unknownHosts = pool.filter(function (host) { return speedOf(host) <= 0; }).sort(function (a, b) { return triesOf(a) - triesOf(b); });
    var assumedBps = knownHosts.length ? speedOf(knownHosts[Math.floor(knownHosts.length / 2)]) : BTRA_ASSUMED_BPS;
    var fresh = knownHosts.length < 3;
    // Upstream 0.9.3.0: a mirror measured at under a twelfth of the fastest sits out — whatever it
    // starts has to be rescued anyway, and its connection is better spent on a quick mirror. Once its
    // measurement is BTRA_MEASURE_TTL old it counts as unmeasured again and gets a probe. (Only
    // relative to the fastest: when every mirror crawls, all of them stay in and are summed.)
    var slowHosts = [];
    if (!fresh) {
      var floorBps = speedOf(knownHosts[0]) / BTRA_SLOW_SHARE;
      var quick = [];
      var retry = [];
      for (var kh = 0; kh < knownHosts.length; kh += 1) {
        if (speedOf(knownHosts[kh]) >= floorBps) quick.push(knownHosts[kh]);
        else if (now - measuredAt(knownHosts[kh]) >= BTRA_MEASURE_TTL) retry.push(knownHosts[kh]);
        else slowHosts.push(knownHosts[kh]);
      }
      // Mirrors that did work before are more promising probes than ones that never answered.
      if (quick.length >= 2) { knownHosts = quick; unknownHosts = retry.concat(unknownHosts); }
      else slowHosts = [];
    }
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
      var roomFor = function (host) { return capOf(host) - busyCount(host) - (perHostCount[host] || 0); };
      var pushSlot = function (host, explore) {
        perHostCount[host] = (perHostCount[host] || 0) + 1;
        var bps = speedOf(host) || Math.min(assumedBps, BTRA_ASSUMED_BPS);
        // A mirror re-tried after sitting out is probed with an ordinary piece, as if it were a
        // middling mirror: a tiny one would measure mostly round trip and could never show that it
        // has recovered. Every probe is at least the smallest piece.
        if (explore && speedOf(host) > 0) bps = Math.max(bps, assumedBps);
        if (explore) bps = Math.max(bps, BTRA_MIN_SLOT / BTRA_SLICE_MS);
        slots.push({ host: host, bps: bps, explore: !!explore });
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
    var pushedBack = false;

    function strikePending(reason) {
      // Mirrors whose pieces are still outstanding well after their slice time get a "late" mark —
      // counted only (see the "late" op): it neither lowers their speed nor benches them.
      var lateLine = Date.now() - (BTRA_SLICE_MS + 300);
      var marked = {};
      for (var index = 0; index < tasks.length; index += 1) {
        var task = tasks[index];
        if (task.done || task.inflight <= 0 || !task.launchedAt) continue;
        var lateHost = task.used[task.used.length - 1];
        if (marked[lateHost]) continue;
        // A probe that has not delivered by the end of the batch always gets its mark: that is how a
        // mirror that swallows requests stops being the first one probed every time (its probes are
        // abandoned with the run, so it would never be found out otherwise). One mark per mirror per batch.
        if (task.piece.slot.explore) {
          marked[lateHost] = true;
          change("late", lateHost, Date.now(), reason);
          change("probe", lateHost, Date.now());
        } else if (task.launchedAt < lateLine) { marked[lateHost] = true; change("late", lateHost, Date.now(), reason); }
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
    // been asked for this piece; mirrors that answered in this very run come first. A hedge copy
    // (upstream 0.9.4.1) only goes to a mirror measured BTRA_HEDGE_FASTER times faster than the one
    // it backs up — a copy on an equally slow mirror only takes a connection from the next piece.
    // Once the App has waited long (copy.late) any mirror will do.
    function pickHost(piece, attempt, used, copy) {
      if (attempt === 0 && used.indexOf(piece.slot.host) < 0 && !leftOut(piece.slot.host) && hasRoom(piece.slot.host)) return piece.slot.host;
      var proven = goodHosts.slice().sort(function (a, b) { return speedOf(b) - speedOf(a); });
      var candidates = proven.concat(knownHosts, unknownHosts, pool);
      var floor = copy && !copy.late && used.length ? speedOf(used[used.length - 1]) * BTRA_HEDGE_FASTER : 0;
      var seen = {};
      for (var index = 0; index < candidates.length; index += 1) {
        var host = candidates[index];
        if (seen[host] || used.indexOf(host) >= 0 || leftOut(host)) continue;
        seen[host] = true;
        // (Upstream also allows a mirror not measured yet. Here an unmeasured mirror may well be one
        // that swallows requests — its probes are abandoned when a run ends, so it is never found
        // out — and a copy sent there helps nobody. It gets copies only once the App has waited long.)
        if (floor > 0 && speedOf(host) < floor) continue;
        if (hasRoom(host)) return host;
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

    var waiting = [];
    var hedgeWanted = [];
    function pump() {
      for (var h = 0; h < hedgeWanted.length && !failed && !finished;) {
        var wanted = hedgeWanted[h];
        if (wanted.done || wanted.launched > 2 || wanted.launch({ late: true })) { hedgeWanted.splice(h, 1); continue; }
        h += 1;
      }
      for (var w = 0; w < waiting.length && !failed && !finished;) {
        var parked = waiting[w];
        if (parked.done || parked.inflight > 0) { waiting.splice(w, 1); continue; }
        if (parked.launch()) { waiting.splice(w, 1); continue; }
        if (inflight === 0 || parked.launched >= 4) { giveUp("没有能用的镜像"); return; }
        w += 1;
      }
      while (queue.length && inflight < config.conns && !failed && !finished) {
        var piece = queue[0];
        if (!launchedAt) launchedAt = Date.now();
        var task = createTask(piece);
        if (!task.launch()) {
          // No mirror can take it right now. While connections are open one of them will free up
          // (pump runs again then); with none open there is nowhere to send it at all.
          tasks.pop();
          if (inflight > 0) break;
          queue.shift();
          if (piece.extra) { extraLeft -= 1; continue; }
          giveUp("没有能用的镜像");
          return;
        }
        queue.shift();
        if (duplicateMust && !piece.extra) task.launch();
      }
    }

    function createTask(piece) {
      var task = { piece: piece, done: false, launched: 0, inflight: 0, used: [] };
      task.launch = function (copy) {
        if (task.done || failed || finished || task.launched >= (piece.extra ? 2 : 4)) return false;
        var host = pickHost(piece, task.launched, task.used, copy || null);
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
            var status = response ? Number(response.status) : 0;
            // (The other stream's connections to that mirror count too: it sees them all.)
            var carrying = (hostInflight[host] || 0) + busyCount(host);
            if ((status === 412 || status === 429) && carrying > 0) {
              // Too many connections for this mirror's taste (others to it were still open) — not a
              // broken mirror (upstream 0.9.4.0): one level down on the automatic count; the mirror
              // keeps its place but gets no more connections at once than it was carrying.
              capHere[host] = carrying;
              change("limited", host, Date.now(), carrying);
              change("bump", "limited", 1);
              if (!pushedBack) { pushedBack = true; autoPushback(Date.now(), status); }
              // A refusal like this costs the piece none of its tries, and the mirror stays open to it
              // once it has room again (its cap is now what it carries, and only goes down from here).
              task.launched -= 1;
              var usedAt = task.used.lastIndexOf(host);
              if (usedAt >= 0) task.used.splice(usedAt, 1);
            } else if (status === 412 || status === 429) {
              // Refused although we had no other connection to it: it wants even fewer (other clients,
              // or it has not noticed our last one close), or it refuses us for another reason. One
              // connection at most for a while, and it counts as a failure; this piece looks elsewhere
              // (it keeps the mirror in its list of tried ones), without that costing it a try.
              capHere[host] = 1;
              change("limited", host, Date.now(), 1);
              change("bump", "limited", 1);
              change("host", host, false, Date.now());
              task.launched -= 1;
            } else if (status >= 400 && status < 500 && state.hosts[host] && state.hosts[host].ok > 0) {
              // A mirror that has served before refuses this file: count it against the pair only.
              // One that refuses several different files lately is failing as a whole after all.
              refusedHere[host] = true;
              change("refused", host, addressKey, Date.now());
              var refusedFiles = 0;
              for (var pairName in state.pairs) if (pairName.indexOf(host + " ") === 0 && Date.now() - state.pairs[pairName].t < BTRA_PAIR_TTL) refusedFiles += 1;
              if (refusedFiles >= 3) change("host", host, false, Date.now());
            } else change("host", host, false, Date.now());
            if (!task.done) {
              if (!task.launch() && task.inflight === 0) {
                if (piece.extra) { task.done = true; extraLeft -= 1; settle(); }
                // No mirror has room right now, but connections are still open: it waits for one
                // (pump tries it first); with none open, or its tries used up, the run gives up.
                else if (inflight > 0 && task.launched < 4) waiting.push(task);
                else giveUp(shortHost(host) + "：" + problem);
              }
            }
            pump();
            settle();
            return;
          }
          change("host", host, true, Date.now(), ms > 0 ? data.length / ms : 0, data.length);
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
          hedge(false, false);
        });
        return true;
      };
      tasks.push(task);
      return task;
    }

    // A mirror that swallows a request without answering would hold the whole reply up until its
    // timeout. When only stragglers are left (or the expected time has long passed), ask a mirror
    // that has just proved itself for the same bytes as well. Only the App's own bytes are worth it.
    // `late`: the App has been waiting long enough that any mirror is worth a copy.
    function hedge(byTimer, late) {
      if (failed || finished || !mustLeft) return;
      var open = 0;
      for (var index = 0; index < tasks.length; index += 1) if (!tasks[index].done && !tasks[index].piece.extra) open += 1;
      if (!open) return;
      if (!byTimer && (open > 2 || open === mustCount)) return;
      // Once the App has waited long every stuck piece of its own gets a copy, however many there
      // are (a mirror that went silent may hold several of them).
      var budget = (late ? Math.max(BTRA_HEDGE_BUDGET * 2, hedges + open) : BTRA_HEDGE_BUDGET) - hedges;
      for (var pick = 0; pick < tasks.length && budget > 0; pick += 1) {
        var task = tasks[pick];
        if (inflight >= config.conns + BTRA_HEDGE_BUDGET) break;
        if (task.done || task.piece.extra || task.inflight < 1 || task.launched > 2) continue;
        if (task.launch({ late: !!late })) { budget -= 1; hedges += 1; }
        // Late, and every mirror is at its limit (read-ahead holds the connections): the copy goes
        // out on the next connection that frees up, before any new read-ahead.
        else if (late && hedgeWanted.indexOf(task) < 0) { hedgeWanted.push(task); budget -= 1; hedges += 1; }
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
      var full = pieces.length >= slots.length / 2;
      if (full) change("ewma", "bps", fetchedBytes / batchMs);
      if (full && config.auto) change("asample", { l: runLevel, b: fetchedBytes, ms: batchMs, t: Date.now() });
      // The App waiting for its own bytes is the sign that the connections are too few (a long wait
      // counts as a stall). The level only climbs on it; whether that helped is judged later.
      var waited = mustDoneAt - startedAt;
      // The App asking for its next block as soon as it has the last one, and spending most of the
      // last seconds waiting for this script, says the same as the browser's low, not growing buffer:
      // the downloads are what holds playback back, even when each single answer is quick. (A player
      // with a full buffer pauses between requests, or its requests hit the cache.)
      var busyMs = elapsed;
      var spanFrom = startedAt;
      for (var rc = 0; rc < state.recent.length; rc += 1) {
        var seenRun = state.recent[rc];
        if (seenRun.p !== pathKey || seenRun.t === startedAt || !(seenRun.ms >= 0) || startedAt - seenRun.t > 12000) continue;
        busyMs += seenRun.ms;
        if (seenRun.t < spanFrom) spanFrom = seenRun.t;
      }
      var demand = Date.now() - spanFrom >= 3000 ? busyMs / (Date.now() - spanFrom) : 0;
      if (waited > BTRA_AUTO_STALL_MS) autoUp(Date.now(), "App 等了 " + (waited / 1000).toFixed(1) + " 秒", true);
      else if (waited > BTRA_AUTO_WAIT_MS && full) autoUp(Date.now(), "App 等了 " + (waited / 1000).toFixed(1) + " 秒", false);
      else if (demand > 0.6 && full) autoUp(Date.now(), "App 一直在等数据（最近 " + Math.round(demand * 100) + "% 的时间）", false);
      if (state.streaks["origin:" + originHost]) change("streak", "origin:" + originHost, null);
      notifyOnce("working", 6 * 3600000, "BTR App 模式正在加速", (config.auto ? "自动连接数（现在 " + config.conns + "）" : config.conns + " 连接") + " · " + (config.overseas ? "海外 CDN" : "大陆 CDN"), "刚才这一批 " + sizeText(fetchedBytes) + " 用了 " + (batchMs / 1000).toFixed(1) + " 秒（" + pieces.length + " 个子块）。统计页：" + BTRA_STATUS_URL);
      storeFetched();
      respond(body, cachedBytes, pieces.length, elapsed, { fetched: fetchedBytes, mustMs: mustDoneAt - startedAt, capacity: capacity, slots: slots.length });
    }

    if (typeof setTimeout === "function") {
      setTimeout(function () { giveUp("超过 " + Math.round(BTRA_DEADLINE / 1000) + " 秒还没拼齐"); }, BTRA_DEADLINE);
      setTimeout(function () { hedge(true, false); }, Math.round(BTRA_SLICE_MS * 1.4));
      setTimeout(function () { hedge(true, true); }, Math.round(BTRA_SLICE_MS * 2.2));
      setTimeout(function () { hedge(true, true); }, Math.round(BTRA_SLICE_MS * 3.2));
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
