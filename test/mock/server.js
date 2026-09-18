"use strict";
/*
 * A stand-in for everything BTR-iOS talks to, so the real build can be exercised end to end
 * without touching Bilibili:
 *
 *   api.bilibili.com              /x/web-interface/view and /x/player/playurl (DASH, fnval=4048 shape)
 *   *.bilivideo.com, *.akamaized.net   media mirrors: Range, CORS + preflight, Referer check, URL
 *                                 signature check, per-connection throttling, latency, dead / 403 hosts
 *   b23.tv                        short links
 *   www / m.bilibili.com          a fake video page, and — through test/lib/loon-vm.js — the real
 *                                 dist/btr-loon.js acting exactly where Loon would run it
 *
 * Every host name is mapped to this one HTTPS port by the browser's host resolver rules.
 */
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { segmentBase } = require("../lib/mp4boxes.js");
const { runLoonScript } = require("../lib/loon-vm.js");

const ROOT = path.resolve(__dirname, "..", "..");
const MEDIA_DIR = path.join(ROOT, "test", "media");
const SECRET = "btr-ios-mock-secret";

const MEDIA = {
  v720: { file: "v720.m4s", kind: "video", id: 64, codecs: "vp09.00.31.08", codecid: 0, width: 1280, height: 720, frameRate: "25" },
  v720av1: { file: "v720_av1.m4s", kind: "video", id: 64, codecs: "av01.0.05M.08", codecid: 13, width: 1280, height: 720, frameRate: "25" },
  v360: { file: "v360.m4s", kind: "video", id: 16, codecs: "vp09.00.21.08", codecid: 0, width: 640, height: 360, frameRate: "25" },
  a96: { file: "a96.m4s", kind: "audio", id: 30280, codecs: "opus", codecid: 0 }
};
for (const item of Object.values(MEDIA)) {
  const info = segmentBase(path.join(MEDIA_DIR, item.file));
  item.size = info.size;
  item.initialization = info.initialization;
  item.indexRange = info.indexRange;
  item.bandwidth = Math.round(info.size * 8 / 90);
}

const VIDEOS = {
  BV1btrTEST01: { aid: 900001, title: "BTR-iOS 测试视频 · 单 P", owner: "测试UP", pages: [{ cid: 1001, part: "正片" }], media: ["v720", "v360"] },
  BV1btrTEST02: { aid: 900002, title: "BTR-iOS 测试视频 · 多 P", owner: "测试UP", pages: [{ cid: 2001, part: "上集" }, { cid: 2002, part: "下集" }], media: ["v720", "v360"] },
  BV1btrAKAM03: { aid: 900003, title: "只有 Akamai 地址的视频", owner: "测试UP", pages: [{ cid: 3001, part: "" }], media: ["v720", "v360"], akamaiOnly: true },
  BV1btrCODC05: { aid: 900005, title: "同一清晰度两种编码", owner: "测试UP", pages: [{ cid: 5001, part: "" }], media: ["v720av1", "v720", "v360"] }
};
const SHORT_LINKS = {
  "/btrP2": "https://www.bilibili.com/video/BV1btrTEST02?p=2&share_source=copy_web",
  "/btrLive": "https://live.bilibili.com/12345",
  "/btrHop": "https://b23.tv/btrP2"
};

const AKAMAI = "upos-hz-mirrorakam.akamaized.net";
const OVERSEAS = ["upos-sz-mirrorcosov.bilivideo.com", "upos-sz-mirroraliov.bilivideo.com"];

function defaultProfiles() {
  return {
    // Close by, but the cold edge has to pull an unpopular video from far away.
    [AKAMAI]: { latency: 5, rate: 40 * 1024 },
    "*ov.bilivideo.com": { latency: 60, rate: 60 * 1024 },
    "cn-hk-eq-*": { latency: 60, rate: 60 * 1024 },
    // Far away: slow per connection, but every connection gets its own share.
    "*": { latency: 160, rate: 120 * 1024 },
    "upos-sz-mirrorbd.bilivideo.com": { dead: true },
    "upos-sz-mirror14b.bilivideo.com": { status: 403 }
  };
}

function createMock(options = {}) {
  const port = options.port || 18443;
  const loonScriptPath = options.loonScript || path.join(ROOT, "dist", "btr-loon.js");
  const state = {
    profiles: defaultProfiles(),
    loon: { enabled: true, injectButton: true, autoRedirect: false },
    pageCsp: true,
    apiDelay: 20,
    requireLogin: false,
    mediaCorsWwwOnly: false,
    danmakuCors: false
  };
  const stats = { hosts: {}, concurrent: 0, maxConcurrent: 0, ranges: [], apiCalls: [], refererFailures: 0, signatureFailures: 0 };
  const openSockets = new Set();

  function resetStats() {
    stats.hosts = {};
    stats.concurrent = 0;
    stats.maxConcurrent = 0;
    stats.ranges = [];
    stats.apiCalls = [];
    stats.refererFailures = 0;
    stats.signatureFailures = 0;
  }

  function profileFor(host) {
    const profiles = state.profiles;
    if (profiles[host]) return profiles[host];
    for (const [pattern, profile] of Object.entries(profiles)) {
      if (pattern === "*" || !pattern.includes("*")) continue;
      const regex = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
      if (regex.test(host)) return profile;
    }
    return profiles["*"] || { latency: 0, rate: 0 };
  }

  function sign(pathname, cid) {
    return crypto.createHash("md5").update(`${pathname}|${cid}|${SECRET}`).digest("hex");
  }

  function mediaUrl(host, cid, key, platform = "pc") {
    const pathname = `/upgcxcode/${String(cid % 100).padStart(2, "0")}/${String(Math.floor(cid / 100) % 100).padStart(2, "0")}/${cid}/${cid}-1-${key}.m4s`;
    const query = new URLSearchParams({
      e: "ig8euxZM2rNcNbdlhoNvNC8BqJIzNbfqXBvEqxTEto8BTrNvN0GvT90W5JZMkX_YN0MvXg8gNEV4NC8xNEV4N03eN0B5tZlqNxTEto8BTrNvNeZVuJ10Kj_g2UB02J0mN0B5tZlqNCNEto8BTrNvNC7MTX502C8f2jmMQJ6mqF2fka1mqx6gqj0eN0B599M=",
      uipk: "5", nbs: "1", deadline: "1999999999", gen: "playurlv2", os: host === AKAMAI ? "akam" : "cosovbv",
      oi: "1234567890", trid: "0000mock", mid: "0", platform, og: "hw",
      upsig: sign(pathname, cid), uparams: "e,uipk,nbs,deadline,gen,os,oi,trid,mid,platform,og", bvc: "vod", nettype: "0", bw: "250000", orderid: "0,3"
    });
    if (host === AKAMAI) query.set("hdnts", "exp=1999999999~hmac=mockakamaitoken");
    return `https://${host}${pathname}?${query}`;
  }

  function representation(cid, key, akamaiOnly) {
    const item = MEDIA[key];
    const baseUrl = mediaUrl(AKAMAI, cid, key);
    const backup = akamaiOnly ? [] : OVERSEAS.map((host) => mediaUrl(host, cid, key));
    const common = {
      id: item.id, baseUrl, base_url: baseUrl, backupUrl: backup, backup_url: backup,
      bandwidth: item.bandwidth, mimeType: `${item.kind}/mp4`, mime_type: `${item.kind}/mp4`, codecs: item.codecs,
      SegmentBase: { Initialization: item.initialization, indexRange: item.indexRange },
      segment_base: { initialization: item.initialization, index_range: item.indexRange },
      codecid: item.codecid, startWithSap: 1, start_with_sap: 1
    };
    if (item.kind === "video") Object.assign(common, { width: item.width, height: item.height, frameRate: item.frameRate, frame_rate: item.frameRate, sar: "1:1" });
    return common;
  }

  /* ---------------- helpers ---------------- */

  function corsHeaders(request, media = false) {
    const origin = String(request.headers.origin || "");
    if (!/^https:\/\/(?:[0-9a-z-]+\.)*bilibili\.com$/i.test(origin)) return {};
    // What nobody outside Bilibili can know for sure: whether the mirrors accept pages on hosts
    // other than www. This switch plays the pessimistic case.
    if (media && state.mediaCorsWwwOnly && origin !== "https://www.bilibili.com") return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Expose-Headers": "Content-Length,Content-Range",
      "Vary": "Origin"
    };
  }

  function sendJson(request, response, status, payload, extra = {}) {
    const body = JSON.stringify(payload);
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(request), ...extra });
    response.end(body);
  }

  /* ---------------- api.bilibili.com ---------------- */

  function findVideo(params) {
    const bvid = params.get("bvid");
    if (bvid) return VIDEOS[bvid] ? { bvid, ...VIDEOS[bvid] } : null;
    const aid = Number(params.get("aid") || params.get("avid"));
    const entry = Object.entries(VIDEOS).find(([, video]) => video.aid === aid);
    return entry ? { bvid: entry[0], ...entry[1] } : null;
  }

  async function handleApi(request, response, url) {
    stats.apiCalls.push({ path: url.pathname, query: url.search, cookie: String(request.headers.cookie || ""), origin: String(request.headers.origin || "") });
    await new Promise((resolve) => setTimeout(resolve, state.apiDelay));
    if (url.pathname === "/x/web-interface/view") {
      const video = findVideo(url.searchParams);
      if (!video) return sendJson(request, response, 200, { code: -404, message: "啥都木有", ttl: 1 });
      return sendJson(request, response, 200, {
        code: 0, message: "0", ttl: 1,
        data: {
          bvid: video.bvid, aid: video.aid, videos: video.pages.length, title: video.title,
          pic: "http://i0.hdslb.com/bfs/archive/mock-cover.jpg", duration: 90 * video.pages.length,
          owner: { mid: 1, name: video.owner, face: "" }, cid: video.pages[0].cid,
          pages: video.pages.map((page, index) => ({ cid: page.cid, page: index + 1, from: "vupload", part: page.part, duration: 90 }))
        }
      });
    }
    if (url.pathname === "/x/player/playurl") {
      const video = findVideo(url.searchParams);
      const cid = Number(url.searchParams.get("cid"));
      if (!video || !video.pages.some((page) => page.cid === cid)) return sendJson(request, response, 200, { code: -404, message: "啥都木有", ttl: 1 });
      if (url.searchParams.get("fnval") !== "4048") return sendJson(request, response, 200, { code: -400, message: "请求错误", ttl: 1 });
      // Like the real thing (when switched on): without a login cookie only low quality is offered.
      const hasSession = /SESSDATA=/.test(String(request.headers.cookie || ""));
      const keys = video.media.filter((key) => !state.requireLogin || hasSession || MEDIA[key].id <= 32);
      const videos = keys.map((key) => representation(cid, key, video.akamaiOnly));
      return sendJson(request, response, 200, {
        code: 0, message: "0", ttl: 1,
        data: {
          from: "local", result: "suee", message: "", quality: Math.max(...videos.map((item) => item.id)), format: "flv720", timelength: 90000,
          accept_format: "flv720,mp4", accept_description: ["高清 720P", "流畅 360P"], accept_quality: [64, 16], video_codecid: 7,
          dash: { duration: 90, minBufferTime: 1.5, min_buffer_time: 1.5, video: videos, audio: [representation(cid, "a96", video.akamaiOnly)], dolby: { type: 0, audio: null }, flac: null },
          support_formats: []
        }
      });
    }
    return sendJson(request, response, 404, { code: -404, message: "mock: unknown api" });
  }

  /* ---------------- media mirrors ---------------- */

  function hostStats(host) {
    if (!stats.hosts[host]) stats.hosts[host] = { requests: 0, bytes: 0, current: 0, maxConcurrent: 0, errors: 0 };
    return stats.hosts[host];
  }

  function handleMedia(request, response, url, host) {
    const cors = corsHeaders(request, true);
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        ...cors,
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": String(request.headers["access-control-request-headers"] || "Range"),
        "Access-Control-Max-Age": "600"
      });
      return response.end();
    }
    const profile = profileFor(host);
    const counters = hostStats(host);
    counters.requests += 1;
    if (profile.dead) return; // accepted, never answered: what a black-holed route looks like
    const fail = (status, reason) => {
      counters.errors += 1;
      response.writeHead(status, { "Content-Type": "text/plain", ...cors });
      response.end(reason);
    };
    if (profile.status) return fail(profile.status, "mock: host refuses");
    // Web play URLs are tied to a bilibili.com Referer; the apps' URLs (platform=iphone/android) are not.
    const referer = String(request.headers.referer || "");
    const appUrl = /^(?:iphone|android|ipad)$/.test(String(url.searchParams.get("platform") || ""));
    if (!appUrl && !/^https:\/\/(?:[0-9a-z-]+\.)*bilibili\.com\//i.test(referer)) {
      stats.refererFailures += 1;
      return fail(403, "mock: bad referer");
    }
    const match = /^\/upgcxcode\/\d+\/\d+\/(\d+)\/\d+-1-([0-9a-z]+)\.m4s$/i.exec(url.pathname);
    const item = match ? MEDIA[match[2]] : null;
    if (!item) return fail(404, "mock: no such media");
    const akamai = /\.akamaized\.net$/i.test(host);
    if (url.searchParams.get("upsig") !== sign(url.pathname, Number(match[1])) || (akamai && !url.searchParams.get("hdnts"))) {
      stats.signatureFailures += 1;
      return fail(403, "mock: bad signature");
    }
    const rangeMatch = /^bytes=(\d+)-(\d*)$/.exec(String(request.headers.range || ""));
    const start = rangeMatch ? Number(rangeMatch[1]) : 0;
    const end = rangeMatch && rangeMatch[2] !== "" ? Math.min(Number(rangeMatch[2]), item.size - 1) : item.size - 1;
    if (start > end || start >= item.size) {
      response.writeHead(416, { "Content-Range": `bytes */${item.size}`, ...cors });
      return response.end();
    }
    const length = end - start + 1;
    stats.ranges.push({ host, key: match[2], start, end, at: Date.now() });
    if (stats.ranges.length > 5000) stats.ranges.splice(0, 1000);
    counters.current += 1;
    counters.maxConcurrent = Math.max(counters.maxConcurrent, counters.current);
    stats.concurrent += 1;
    stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.concurrent);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      counters.current -= 1;
      stats.concurrent -= 1;
    };
    response.on("close", finish);

    const stallAfter = Number(profile.stallAfterBytes) || 0;
    const rate = Number(profile.rate) || 0;
    setTimeout(() => {
      if (response.destroyed) return finish();
      response.writeHead(rangeMatch ? 206 : 200, {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Content-Length": String(length),
        ...(rangeMatch ? { "Content-Range": `bytes ${profile.wrongRange ? start + 1 : start}-${end}/${item.size}` } : {}),
        "Cache-Control": "max-age=3600",
        ...cors
      });
      const fd = fs.openSync(path.join(MEDIA_DIR, item.file), "r");
      const chunkSize = rate ? Math.max(2048, Math.min(16384, Math.floor(rate / 8))) : 65536;
      let offset = start;
      let sent = 0;
      const pump = () => {
        if (response.destroyed) { fs.closeSync(fd); return finish(); }
        if (offset > end) { fs.closeSync(fd); response.end(); return finish(); }
        if (stallAfter && sent >= stallAfter) { fs.closeSync(fd); return; } // keep the socket open, send nothing more
        const size = Math.min(chunkSize, end - offset + 1);
        const buffer = Buffer.alloc(size);
        fs.readSync(fd, buffer, 0, size, offset);
        offset += size;
        sent += size;
        counters.bytes += size;
        const proceed = () => (rate ? setTimeout(pump, size * 1000 / rate) : setImmediate(pump));
        if (response.write(buffer)) proceed();
        else response.once("drain", proceed);
      };
      pump();
    }, Number(profile.latency) || 0);
  }

  /* ---------------- www / m.bilibili.com ---------------- */

  function fakeVideoPage(url, host) {
    const bvid = /\/video\/([^/?]+)/.exec(url.pathname)?.[1] || "";
    const video = VIDEOS[bvid];
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${video ? video.title : "视频去哪了呢"}_哔哩哔哩_bilibili (mock ${host})</title>
<style>body{margin:0;font:16px sans-serif;background:#fff;color:#222}.player{background:#000;aspect-ratio:16/9}.player video{width:100%;height:100%}button,h1{margin:12px}</style></head>
<body><div class="player"><video id="native-player" muted playsinline></video></div><h1>${video ? video.title : "404"}</h1>
<p style="margin:12px">这是测试用的假视频页（${host}）。</p><button id="open-app">打开 App，流畅又高清</button>
</body></html>`;
  }

  function requestFromNode(request, url) {
    const headers = {};
    for (let index = 0; index < request.rawHeaders.length; index += 2) headers[request.rawHeaders[index]] = request.rawHeaders[index + 1];
    return { url: url.href, method: request.method, headers };
  }

  function loonEnvironment() {
    return {
      code: fs.readFileSync(loonScriptPath, "utf8"),
      httpClientPort: port
    };
  }

  function sendLoonResponse(response, result) {
    const fake = result.response;
    const headers = { ...(fake.headers || {}) };
    const body = fake.body instanceof Uint8Array || ArrayBuffer.isView(fake.body) ? Buffer.from(fake.body.buffer, fake.body.byteOffset, fake.body.byteLength)
      : Buffer.from(String(fake.body ?? ""), "utf8");
    headers["Content-Length"] = String(body.length);
    response.writeHead(Number(fake.status) || 200, headers);
    response.end(body);
  }

  async function handleSite(request, response, url, host) {
    const loonRequest = requestFromNode(request, url);
    const isPlayerPath = url.pathname.startsWith("/__btr__/");
    const isVideoPath = /^\/video\/(?:BV[0-9A-Za-z]+|av\d+)/i.test(url.pathname);
    if (isPlayerPath) {
      if (!state.loon.enabled) { response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" }); return response.end("<h1>404</h1><p>mock: Loon 没有开启，这个地址在真正的 B 站上不存在。</p>"); }
      const result = await runLoonScript({ ...loonEnvironment(), request: loonRequest });
      if (result?.response) return sendLoonResponse(response, result);
      response.writeHead(502); return response.end("mock: loon script did not answer");
    }
    if (isVideoPath) {
      if (state.loon.enabled && state.loon.autoRedirect) {
        const result = await runLoonScript({ ...loonEnvironment(), request: loonRequest });
        if (result?.response) return sendLoonResponse(response, result);
      }
      let body = fakeVideoPage(url, host);
      let headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };
      if (state.pageCsp) headers["Content-Security-Policy"] = "script-src 'self'";
      if (state.loon.enabled && state.loon.injectButton) {
        const result = await runLoonScript({ ...loonEnvironment(), request: loonRequest, response: { status: 200, headers, body } });
        if (result && typeof result.body === "string") body = result.body;
        if (result && result.headers) headers = result.headers;
      }
      const buffer = Buffer.from(body, "utf8");
      const finalHeaders = { ...headers };
      for (const key of Object.keys(finalHeaders)) if (/^content-length$/i.test(key)) delete finalHeaders[key];
      response.writeHead(200, { ...finalHeaders, "Content-Length": String(buffer.length) });
      return response.end(buffer);
    }
    response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<h1>404</h1>");
  }

  /* ---------------- router ---------------- */

  async function route(request, response) {
    const host = String(request.headers.host || "").replace(/:\d+$/, "").toLowerCase();
    const url = new URL(request.url, `https://${host}`);
    if (url.pathname === "/__mock__/config") {
      if (request.method === "POST") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const patch = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (patch.profiles) state.profiles = { ...state.profiles, ...patch.profiles };
        if (patch.resetProfiles) state.profiles = defaultProfiles();
        if (patch.loon) state.loon = { ...state.loon, ...patch.loon };
        if ("pageCsp" in patch) state.pageCsp = Boolean(patch.pageCsp);
        if ("requireLogin" in patch) state.requireLogin = Boolean(patch.requireLogin);
        if ("mediaCorsWwwOnly" in patch) state.mediaCorsWwwOnly = Boolean(patch.mediaCorsWwwOnly);
        if (patch.resetStats) resetStats();
      }
      return sendJson(request, response, 200, { state, stats });
    }
    if (host === "api.bilibili.com") {
      if (request.method === "OPTIONS") { response.writeHead(204, { ...corsHeaders(request), "Access-Control-Allow-Methods": "GET,OPTIONS" }); return response.end(); }
      return handleApi(request, response, url);
    }
    if (/(?:^|\.)(?:bilivideo\.(?:com|cn)|akamaized\.net)$/i.test(host)) return handleMedia(request, response, url, host);
    if (host === "comment.bilibili.com") {
      const cid = Number(/^\/(\d+)\.xml$/.exec(url.pathname)?.[1]);
      if (!cid) { response.writeHead(404); return response.end(); }
      stats.danmakuRequests = (stats.danmakuRequests || 0) + 1;
      // one scrolling comment every 0.4 s, a top and a bottom one every 5 s, one "advanced" one to skip
      const rows = [];
      for (let index = 0; index < 225; index += 1) rows.push(`<d p="${(index * 0.4).toFixed(2)},1,25,${index % 3 ? 16777215 : 16707842},1700000000,0,abcd${index},${1000 + index},10">第${index}条 cid${cid} &lt;弹幕&gt;</d>`);
      for (let index = 0; index < 18; index += 1) rows.push(`<d p="${index * 5 + 1},5,25,65280,1700000000,0,top${index},${5000 + index},10">顶部${index}</d>`, `<d p="${index * 5 + 2},4,25,255,1700000000,0,bot${index},${6000 + index},10">底部${index}</d>`);
      rows.push('<d p="3,7,25,16777215,1700000000,0,adv,7000,10">[0,0,"1-1",4.5,"高级弹幕",0,0,0,0,500,0,true,"黑体",1]</d>');
      const xml = `<?xml version="1.0" encoding="UTF-8"?><i><chatserver>chat.bilibili.com</chatserver><chatid>${cid}</chatid><mission>0</mission><maxlimit>3000</maxlimit><state>0</state><real_name>0</real_name><source>k-v</source>${rows.join("")}</i>`;
      response.writeHead(200, { "Content-Type": "text/xml", ...(state.danmakuCors ? corsHeaders(request) : {}) });
      return response.end(xml);
    }
    if (host === "b23.tv" || host === "bili2233.cn") {
      const target = SHORT_LINKS[url.pathname];
      if (!target) { response.writeHead(404); return response.end("mock: unknown short link"); }
      response.writeHead(302, { Location: target });
      return response.end();
    }
    if (/(?:^|\.)hdslb\.com$/i.test(host)) {
      // 1x1 PNG for covers
      response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=3600" });
      return response.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
    }
    if (host === "www.bilibili.com" || host === "m.bilibili.com") return handleSite(request, response, url, host);
    if (host === "passport.bilibili.com") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return response.end("<h1>mock login</h1>"); }
    response.writeHead(404);
    response.end(`mock: unknown host ${host}`);
  }

  const server = https.createServer({
    key: fs.readFileSync(path.join(ROOT, "test", "certs", "key.pem")),
    cert: fs.readFileSync(path.join(ROOT, "test", "certs", "cert.pem"))
  }, (request, response) => {
    route(request, response).catch((error) => {
      try { response.writeHead(500); response.end(String(error?.stack || error)); } catch (_error) {}
    });
  });
  server.keepAliveTimeout = 30000;
  server.on("connection", (socket) => { openSockets.add(socket); socket.on("close", () => openSockets.delete(socket)); });

  return {
    port,
    state,
    stats,
    resetStats,
    resetProfiles() { state.profiles = defaultProfiles(); },
    MEDIA,
    VIDEOS,
    mediaUrl,
    start: () => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); }),
    stop: () => new Promise((resolve) => { for (const socket of openSockets) socket.destroy(); server.close(() => resolve()); })
  };
}

module.exports = { createMock, MEDIA, VIDEOS };

if (require.main === module) {
  const mock = createMock({ port: Number(process.env.PORT) || 18443 });
  mock.start().then(() => console.log(`mock bilibili on https://127.0.0.1:${mock.port} (map every host to it)`));
}
