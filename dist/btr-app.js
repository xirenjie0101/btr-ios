/*
 * BTR-iOS · App 模式  —  1.0.0
 *
 * 让哔哩哔哩 App（国内版 / 国际版）取视频数据时也用上“线程撕裂者”的办法：
 * 把一次取流请求拆成很多个字节块，同时向多个 CDN 节点要，拼好后交还给 App 的播放器。
 * 思路来自开源项目 Bilibili-thread-ripper（MIT）；App 的播放器是原生的，只能站在
 * App 和 CDN 中间（Loon 的 http-request 脚本）来做这件事。
 *
 * 脚本不能“边下边给”，必须把一整个响应攒齐再交出去，所以：
 *   - App 要的是一小段（Range: bytes=a-b）：原样满足，只是改成多线程去拿；
 *   - App 要的是“从 a 一直到文件末尾”（bytes=a-），或者一段很大的范围：只答复前面一块
 *     （HTTP 允许 206 少给，Content-Range 写明实际范围），播放器读完会从下一个位置接着要。
 *     不是每种播放器都接受这种答复，所以有保险丝：同一位置被反复重要 → 自动改回原样放行。
 *   - 任何一步出错、超时、节点不认这个地址：原样放行（$done({})），App 像没装插件一样工作。
 *
 * 只读请求头、只搬运视频字节；不读取也不保存账号、Cookie 或播放记录，不向任何第三方发数据。
 * Generated file — edit src/ and run `node build.js` instead.
 */
var BTRA_VERSION = "1.0.0";
var BTRA_STORE_KEY = "btr_ios_app_v1";
var BTRA_STATUS_URL = "https://www.bilibili.com/__btr_app__/";
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
var BTRA_MAX_REPLY = 8 * 1024 * 1024;
var BTRA_EXACT_LIMIT = 4 * 1024 * 1024;
var BTRA_PIECE_TIMEOUT = 6000;
var BTRA_HEDGE_AFTER = 3500;
var BTRA_DEADLINE = 14000;

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
    var chunk = parseFloat(map.chunk);
    return {
      threads: threads >= 1 && threads <= 32 ? threads : 8,
      chunkBytes: Math.round((chunk >= 0.5 && chunk <= 8 ? chunk : 2) * 1048576),
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

  /* ------------------------------------------------------------ state
   * Several copies of this script run at the same time (picture and sound are separate requests),
   * each in its own JavaScript context. They share one JSON record in Loon's store. A run decides
   * on the snapshot it read at the start, notes every change it makes as an operation, and replays
   * those operations on a freshly read record right before it ends, so that runs do not wipe out
   * each other's counters.
   */

  function emptyState() {
    return { v: 1, since: Date.now(), rr: 0, totals: {}, hosts: {}, recent: [], breaker: {}, streaks: {}, notes: {}, stats: {} };
  }

  function loadState() {
    try {
      var parsed = JSON.parse($persistentStore.read(BTRA_STORE_KEY) || "null");
      if (parsed && typeof parsed === "object" && parsed.v === 1) {
        var base = emptyState();
        for (var key in base) if (parsed[key] === undefined || parsed[key] === null) parsed[key] = base[key];
        return parsed;
      }
    } catch (_error) {}
    return emptyState();
  }

  function apply(state, op) {
    var kind = op[0];
    if (kind === "bump") state.stats[op[1]] = (state.stats[op[1]] || 0) + op[2];
    else if (kind === "set") state.stats[op[1]] = op[2];
    else if (kind === "rr") state.rr = ((state.rr || 0) + 1) % 1000000;
    else if (kind === "total") state.totals[op[1]] = { size: op[2], t: op[3] };
    else if (kind === "recent") state.recent.push(op[1]);
    else if (kind === "breaker") state.breaker[op[1]] = op[2];
    else if (kind === "streak") state.streaks[op[1]] = op[2] === null ? 0 : (state.streaks[op[1]] || 0) + op[2];
    else if (kind === "note") state.notes[op[1]] = op[2];
    else if (kind === "host") {
      var item = state.hosts[op[1]] || (state.hosts[op[1]] = { ok: 0, bad: 0, streak: 0, until: 0, benches: 0 });
      if (op[2]) { item.ok += 1; item.streak = 0; item.until = 0; item.benches = 0; }
      else {
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

  function change() {
    var op = Array.prototype.slice.call(arguments);
    ops.push(op);
    apply(state, op);
  }

  function commit() {
    if (!ops.length) return;
    try {
      var fresh = loadState();
      for (var index = 0; index < ops.length; index += 1) apply(fresh, ops[index]);
      var now = Date.now();
      fresh.recent = fresh.recent.filter(function (entry) { return now - entry.t <= 60000; }).slice(-40);
      var names = [];
      for (var key in fresh.totals) names.push(key);
      if (names.length > 80) {
        names.sort(function (a, b) { return fresh.totals[a].t - fresh.totals[b].t; });
        for (var cut = 0; cut < names.length - 60; cut += 1) delete fresh.totals[names[cut]];
      }
      $persistentStore.write(JSON.stringify(fresh), BTRA_STORE_KEY);
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

  function notifyOnce(config, key, everyMs, title, subtitle, body) {
    if (!config.notify) return;
    var now = Date.now();
    if (state.notes[key] && now - state.notes[key] < everyMs) return;
    change("note", key, now);
    try { $notification.post(title, subtitle, body); } catch (_error) {}
  }

  /* ------------------------------------------------------------ status page */

  function escapeHtml(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function statusPage() {
    if (/[?&]reset=1(?:&|$)/.test(url)) {
      try { $persistentStore.write(JSON.stringify(emptyState()), BTRA_STORE_KEY); } catch (_error) {}
    }
    var current = loadState();
    var config = options();
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
      hosts.push(escapeHtml(shortHost(host) + "：成功 " + (item.ok || 0) + " / 失败 " + (item.bad || 0) + (item.until > now ? "（停用中）" : "")));
    }
    var rows = [
      ["版本", escapeHtml(BTRA_VERSION)],
      ["设置", escapeHtml(config.threads + " 线程 · 每块 " + sizeText(config.chunkBytes) + " · " + (config.overseas ? "海外 CDN" : "大陆 CDN") + " · 大范围请求：" + (config.chunkReplies ? "分块答复" : "原样放行"))],
      ["统计起点", escapeHtml(new Date(current.since).toLocaleString())],
      ["看到的取流请求", escapeHtml((stats.seen || 0) + " 个（小段 " + (stats.bounded || 0) + " · 开放式 " + (stats.open || 0) + " · 无 Range " + (stats.none || 0) + " · 其他 " + (stats.other || 0) + "）")],
      ["多线程完成", escapeHtml((stats.accelerated || 0) + " 次 · " + sizeText(stats.bytes || 0) + " · " + (stats.pieces || 0) + " 个子块" + (stats.ms ? " · 平均 " + sizeText((stats.bytes || 0) * 1000 / stats.ms) + "/s" : ""))],
      ["其中分块答复", escapeHtml((stats.shortReplies || 0) + " 次")],
      ["原样放行", escapeHtml((stats.passed || 0) + " 次" + (stats.lastPass ? "（最近一次原因：" + stats.lastPass + "）" : ""))],
      ["失败后放行", escapeHtml((stats.failed || 0) + " 次" + (stats.lastError ? "（最近一次：" + stats.lastError + "）" : ""))],
      ["保险丝", breakers.length ? breakers.join("<br>") : "没有跳闸"],
      ["节点", hosts.length ? hosts.join("<br>") : "还没有记录"],
      ["App 标识", escapeHtml(stats.agent || "还没有记录")]
    ];
    var html = "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
      "<title>BTR App 模式</title><style>body{margin:0;padding:16px;font:15px/1.6 -apple-system,'PingFang SC',sans-serif;background:#0e1014;color:#e9ecf2}" +
      "h1{font-size:18px}table{border-collapse:collapse;width:100%}td{padding:8px 6px;border-top:1px solid #2a2f3a;vertical-align:top;word-break:break-word}td:first-child{color:#97a0b0;white-space:nowrap}" +
      "a{color:#4cc2ff}p{color:#97a0b0;font-size:13px}</style></head><body><h1>⚡ BTR App 模式</h1><table>";
    for (var index = 0; index < rows.length; index += 1) html += "<tr><td>" + rows[index][0] + "</td><td>" + rows[index][1] + "</td></tr>";
    html += "</table><p>先在 B 站 App 里看一会儿视频，再回来刷新这个页面。反馈问题时把这一页截图发出来就行。<br><a href=\"?reset=1\">清零统计和保险丝</a></p></body></html>";
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
    if (!parts || !/^\/upgcxcode\/.+\.m4s$/i.test(parts[4])) { finished = true; $done({}); return; }

    var config = options();
    state = loadState();
    var originHost = parts[2].toLowerCase();
    var path = parts[4];
    var query = parts[5] || "";
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

    var total = state.totals[path] ? state.totals[path].size : 0;
    if (total && start >= total) { passThrough("起点超出文件"); return; }
    if (total && wantedEnd > total - 1) wantedEnd = total - 1;

    // How much goes into this one answer. A range the App spelled out is answered exactly as long as
    // it fits in memory comfortably. "From here to the end" (or a huge range) gets one block; the
    // very first block of a file is kept small so that the player has its header quickly.
    var replyLimit = Math.min(BTRA_MAX_REPLY, start === 0 ? Math.min(config.chunkBytes, 1048576) : config.chunkBytes);
    if (bounded && wantedEnd - start + 1 <= BTRA_EXACT_LIMIT) replyLimit = BTRA_EXACT_LIMIT;
    var end = wantedEnd;
    var plannedShort = false;
    if (wantedEnd - start + 1 > replyLimit) {
      plannedShort = true;
      end = start + replyLimit - 1;
    }
    if (plannedShort) {
      if (!config.chunkReplies) { passThrough("大范围请求按设置原样放行"); return; }
      var trip = state.breaker.shortReply;
      if (trip && trip.until > now) { passThrough("保险丝：" + trip.reason); return; }
      // The same position asked for again and again: this player does not carry on after a short
      // answer. (A healthy player may well open a file two or three times from the start.)
      var repeats = 0;
      for (var index = 0; index < state.recent.length; index += 1) {
        var entry = state.recent[index];
        if (now - entry.t <= 60000 && entry.p === path && entry.s === start) repeats += 1;
      }
      change("recent", { p: path, s: start, t: now });
      if (repeats >= (start === 0 ? 4 : 3)) {
        change("breaker", "shortReply", { until: now + 10 * 60000, reason: "App 播放器不接受分块答复" });
        notifyOnce(config, "breaker-short", 60000, "BTR App 模式已自动让路", "这个 App 的播放器不接受分块答复", "接下来 10 分钟大范围取流请求会原样放行（不加速，但不影响观看）。请把 " + BTRA_STATUS_URL + " 这一页截图发给作者。");
        passThrough("保险丝刚刚跳闸");
        return;
      }
    }
    var originTrip = state.breaker["origin:" + originHost];
    if (originTrip && originTrip.until > now) { passThrough("保险丝：" + originTrip.reason); return; }

    /* ---- mirrors ---- */
    var everyMirror = config.overseas ? BTRA_OVERSEAS : BTRA_MAINLAND;
    var pool = everyMirror.filter(function (host) { return !(state.hosts[host] && state.hosts[host].until > now); });
    if (pool.length < 2) pool = everyMirror.slice();
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

    var failed = false;
    var contentType = "";

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
        notifyOnce(config, "breaker-origin", 5 * 60000, "BTR App 模式暂时让路", originHost, "连续几次没能从镜像节点拿到数据（" + reason + "），先原样放行 5 分钟。");
      }
      finish({});
    }

    var goodHosts = [];
    var tasks = [];

    function requestPiece(host, piece, callback) {
      var headers = {};
      for (var key in forwardHeaders) headers[key] = forwardHeaders[key];
      headers.Range = "bytes=" + piece.start + "-" + piece.end;
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
          else if (Number(response.status) !== 206) problem = "HTTP " + response.status;
          else if (!data || typeof data.subarray !== "function") problem = "拿到的不是二进制数据";
          else {
            range = parseContentRange(header(response.headers, "Content-Range"));
            if (!range || range.start !== piece.start || range.end > piece.end) problem = "Content-Range 不对";
            else if (range.end < piece.end && range.end !== range.total - 1) problem = "少给了数据";
            else if (data.length !== range.end - range.start + 1) problem = "长度不符";
            else if (total && range.total !== total) problem = "文件总长度不一致";
          }
          callback(problem, data, range, response);
        } catch (failure) {
          giveUp("脚本内部错误：" + String(failure && failure.message || failure));
        }
      });
    }

    // One piece may be asked of up to three mirrors: the next one when the previous one failed, or
    // alongside a slow one (see hedge()). The first correct answer wins, the rest is ignored.
    function createTask(piece, onDone) {
      var task = { piece: piece, done: false, launched: 0, inflight: 0, used: [] };
      task.launch = function () {
        if (task.done || failed || finished || task.launched >= 3) return false;
        if (task.launched > 0 && Date.now() - startedAt > BTRA_DEADLINE - 2000) return false;
        var attempt = task.launched;
        var host = "";
        if (attempt > 0) {
          for (var index = 0; index < goodHosts.length && !host; index += 1) {
            var candidate = goodHosts[(piece.index + attempt + index) % goodHosts.length];
            if (task.used.indexOf(candidate) < 0) host = candidate;
          }
        }
        for (var step = 0; step < pool.length && !host; step += 1) {
          var next = pool[(rotation + piece.index + attempt * 3 + step) % pool.length];
          if (task.used.indexOf(next) < 0) host = next;
        }
        if (!host) return false;
        task.launched += 1;
        task.inflight += 1;
        task.used.push(host);
        requestPiece(host, piece, function (problem, data, range, response) {
          task.inflight -= 1;
          if (failed || finished) return;
          if (problem) {
            change("host", host, false, Date.now());
            if (task.done) return;
            if (!task.launch() && task.inflight === 0) giveUp(shortHost(host) + "：" + problem);
            return;
          }
          change("host", host, true, Date.now());
          if (goodHosts.indexOf(host) < 0) goodHosts.push(host);
          if (task.done) return;
          task.done = true;
          if (!contentType) contentType = header(response.headers, "Content-Type");
          onDone(data, range);
          hedge(false);
        });
        return true;
      };
      tasks.push(task);
      return task;
    }

    // A mirror that swallows a request without answering would hold the whole reply up until its
    // timeout. When only stragglers are left (or a few seconds have gone by), ask a mirror that
    // has just proved itself for the same bytes as well.
    function hedge(byTimer) {
      if (failed || finished) return;
      var open = 0;
      for (var index = 0; index < tasks.length; index += 1) if (!tasks[index].done) open += 1;
      if (!open) return;
      if (!byTimer && (open > 2 || open === tasks.length)) return;
      // When everything is slow, doubling every request would only make it worse: a few at a time.
      var budget = 3;
      for (var pick = 0; pick < tasks.length && budget > 0; pick += 1) {
        var task = tasks[pick];
        if (!task.done && task.inflight === 1 && task.launched === 1 && task.launch()) budget -= 1;
      }
    }

    function deliver(buffers, realEnd, pieceCount) {
      if (failed || finished) return;
      var length = realEnd - start + 1;
      var body = new Uint8Array(length);
      var offset = 0;
      for (var index = 0; index < buffers.length; index += 1) {
        if (offset + buffers[index].length > length) { giveUp("拼装后的长度不符"); return; }
        body.set(buffers[index], offset);
        offset += buffers[index].length;
      }
      if (offset !== length) { giveUp("拼装后的长度不符"); return; }
      var elapsed = Math.max(1, Date.now() - startedAt);
      var isShort = realEnd < wantedEnd;
      change("bump", "accelerated", 1);
      change("bump", "bytes", length);
      change("bump", "pieces", pieceCount);
      change("bump", "ms", elapsed);
      if (isShort) change("bump", "shortReplies", 1);
      if (state.streaks["origin:" + originHost]) change("streak", "origin:" + originHost, null);
      notifyOnce(config, "working", 6 * 3600000, "BTR App 模式正在加速", config.threads + " 线程 · " + (config.overseas ? "海外 CDN" : "大陆 CDN"), "刚才这一块 " + sizeText(length) + " 用了 " + (elapsed / 1000).toFixed(1) + " 秒（" + pieceCount + " 个子块）。统计页：" + BTRA_STATUS_URL);
      var headers = {
        "Content-Type": contentType || "video/mp4",
        "Content-Range": "bytes " + start + "-" + realEnd + "/" + total,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "X-BTR-iOS": BTRA_VERSION + "; pieces=" + pieceCount + "; ms=" + elapsed
      };
      // After a short answer the player has to come back for the rest. On a kept-alive HTTP/1.1
      // connection some players would wait for more bytes instead; closing makes the end explicit.
      if (isShort) headers.Connection = "close";
      finish({ response: { status: 206, headers: headers, body: body } });
    }

    function fetchAll(from, to, headBuffers) {
      var length = to - from + 1;
      var count = Math.max(1, Math.min(config.threads, Math.ceil(length / BTRA_MIN_PIECE)));
      var base = Math.floor(length / count);
      var extra = length % count;
      var buffers = new Array(count);
      var cursor = from;
      var remaining = count;
      for (var index = 0; index < count; index += 1) {
        var size = base + (index < extra ? 1 : 0);
        (function (piece, slot) {
          createTask(piece, function (data) {
            buffers[slot] = data;
            remaining -= 1;
            if (remaining === 0) deliver(headBuffers.concat(buffers), to, headBuffers.length + count);
          }).launch();
        })({ index: index + headBuffers.length, start: cursor, end: cursor + size - 1 }, index);
        cursor += size;
      }
    }

    if (typeof setTimeout === "function") {
      setTimeout(function () { giveUp("超过 " + Math.round(BTRA_DEADLINE / 1000) + " 秒还没拼齐"); }, BTRA_DEADLINE);
      setTimeout(function () { hedge(true); }, BTRA_HEDGE_AFTER);
      setTimeout(function () { hedge(true); }, BTRA_HEDGE_AFTER * 2);
    }

    if (total) {
      fetchAll(start, end, []);
      return;
    }
    // First contact with this file: one small piece tells how long the file is, so that the rest
    // can be cut to size without asking for bytes beyond the end.
    var head = createTask({ index: 0, start: start, end: Math.min(end, start + BTRA_MIN_PIECE - 1) }, function (data, range) {
      tasks = [];
      total = range.total;
      change("total", path, total, Date.now());
      if (wantedEnd > total - 1) wantedEnd = total - 1;
      if (end > total - 1) end = total - 1;
      if (range.end >= end) { deliver([data], range.end, 1); return; }
      fetchAll(range.end + 1, end, [data]);
    });
    // The very first bytes of a video decide how long the spinner shows: ask two mirrors at once.
    head.launch();
    head.launch();
  }

  try {
    main();
  } catch (error) {
    try { console.log("BTR App: " + String(error && error.stack || error)); } catch (_error) {}
    if (!finished) { finished = true; $done({}); }
  }
})();
