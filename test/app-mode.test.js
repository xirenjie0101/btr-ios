"use strict";
/*
 * App mode (dist/btr-app.js): simulated Bilibili-app players fetch media through a stand-in for
 * Loon's MITM layer that runs the real script for every request, against the throttled mock CDN.
 * What is checked: the bytes the player ends up with are exactly the file's bytes, it gets them
 * several times faster than its own single connection would, and every safety net holds.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createMock } = require("./mock/server.js");
const { createFakeLoon, ffmpegLikePlayer, segmentPlayer, stubbornPlayer } = require("./lib/fake-loon-proxy.js");
const { runLoonScript } = require("./lib/loon-vm.js");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "dist", "btr-app.js");
const mock = createMock({ port: 18490 });
let loon;
let proxyPort = 18491;

const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const file = (name) => fs.readFileSync(path.join(ROOT, "test", "media", name));
const AKAMAI = "upos-hz-mirrorakam.akamaized.net";

test.before(() => mock.start());
test.after(async () => { await loon?.stop(); await mock.stop(); });

async function freshLoon(argument = { threads: "8", chunk: "2MB", cdn: "大陆CDN", openEnded: "分块答复", notify: true }) {
  await loon?.stop();
  mock.resetStats();
  mock.resetProfiles();
  proxyPort += 1;
  loon = createFakeLoon({ port: proxyPort, cdnPort: mock.port, scriptPath: SCRIPT, argument });
  await loon.start();
  return loon;
}

test("ijkplayer-style reading (bytes=a- , reconnect when the answer ends early): exact bytes, many times faster", async () => {
  await freshLoon();
  const url = mock.mediaUrl(AKAMAI, 1001, "v360", "iphone");
  const original = file("v360.m4s");
  const result = await ffmpegLikePlayer({ proxyPort, url });
  assert.equal(result.total, original.length);
  assert.equal(sha(result.bytes), sha(original), "every byte in place");
  assert.equal(loon.log.passedThrough, 0, "nothing had to fall back");
  assert.ok(result.requests >= 3 && result.requests <= 5, `5.2 MB in 1 MB + 2 MB answers: ${result.requests} requests`);
  const rate = original.length / result.seconds;
  // the player's own route: one connection to the cold Akamai edge at 40 KiB/s
  assert.ok(rate > 40 * 1024 * 6, `${(rate / 1024).toFixed(0)} KiB/s should be well over 6× the 40 KiB/s the app gets on its own`);
  const state = loon.state();
  assert.equal(state.stats.open, result.requests);
  assert.equal(state.stats.accelerated, result.requests);
  assert.equal(state.stats.bytes, original.length);
  assert.equal(state.stats.shortReplies, result.requests - 1, "all answers but the last were partial");
  assert.ok(state.stats.agent.startsWith("bili-universal/"));
  assert.ok(Object.keys(mock.stats.hosts).filter((host) => mock.stats.hosts[host].bytes > 0).length >= 4, "several mirrors shared the work");
  assert.equal(mock.stats.hosts[AKAMAI], undefined, "the slow origin host was not needed at all");
  assert.ok(mock.stats.maxConcurrent >= 6, `parallel connections: ${mock.stats.maxConcurrent}`);
  assert.equal(mock.stats.signatureFailures, 0);
  assert.ok(loon.log.notifications.some((line) => /正在加速/.test(line)), "one notification says it works");
  assert.equal(loon.log.notifications.filter((line) => /正在加速/.test(line)).length, 1, "…and only one");
});

test("short answers close the connection, complete ones need not", async () => {
  await freshLoon();
  const url = mock.mediaUrl(AKAMAI, 1001, "a96", "iphone");
  const run = (range) => runLoonScript({
    code: fs.readFileSync(SCRIPT, "utf8"), httpClientPort: mock.port, store: loon.store, timeoutMs: 30000,
    argument: loon.settings.argument, request: { url, method: "GET", headers: { Range: range, "User-Agent": "bili-universal/1" } }
  });
  const size = file("a96.m4s").length;
  const first = await run("bytes=0-");
  assert.equal(first.response.status, 206);
  assert.equal(first.response.headers["Content-Range"], `bytes 0-1048575/${size}`, "the first answer of a file is 1 MB so the header arrives quickly");
  assert.equal(first.response.headers.Connection, "close");
  assert.equal(first.response.body.length, 1048576);
  const tail = await run("bytes=1048576-");
  assert.equal(tail.response.headers["Content-Range"], `bytes 1048576-${size - 1}/${size}`);
  assert.equal(tail.response.headers.Connection, undefined, "this answer reaches the end of the file");
  const exact = await run("bytes=100-299");
  assert.equal(exact.response.headers["Content-Range"], `bytes 100-299/${size}`);
  assert.equal(exact.response.headers.Connection, undefined);
  assert.deepEqual(Buffer.from(exact.response.body), file("a96.m4s").subarray(100, 300));
  // a spelled-out range from the start of a file is honoured in full (the 1 MB first block is for "0-" only)
  const wide = await run("bytes=0-1299999");
  assert.equal(wide.response.headers["Content-Range"], `bytes 0-1299999/${size}`);
  assert.equal(wide.response.body.length, 1300000);
  assert.deepEqual(Buffer.from(wide.response.body), file("a96.m4s").subarray(0, 1300000));
  // …but one that would not fit in memory comfortably is answered block by block
  const videoUrl = mock.mediaUrl(AKAMAI, 1001, "v720", "iphone");
  const huge = await runLoonScript({
    code: fs.readFileSync(SCRIPT, "utf8"), httpClientPort: mock.port, store: loon.store, timeoutMs: 30000,
    argument: loon.settings.argument, request: { url: videoUrl, method: "GET", headers: { Range: "bytes=1048576-24000000" } }
  });
  assert.equal(huge.response.headers["Content-Range"], `bytes 1048576-${1048576 + 2097152 - 1}/${file("v720.m4s").length}`);
  assert.equal(huge.response.headers.Connection, "close");
});

test("segment-style reading (bytes=a-b): answered exactly as asked, just faster", async () => {
  await freshLoon({ threads: "16", chunk: "2MB", cdn: "大陆CDN", openEnded: "分块答复", notify: false });
  const url = mock.mediaUrl("upos-sz-mirrorcosov.bilivideo.com", 1001, "v360", "iphone");
  const original = file("v360.m4s");
  const result = await segmentPlayer({ proxyPort, url, size: original.length, segment: 1048576 });
  assert.equal(sha(result.bytes), sha(original));
  const state = loon.state();
  assert.equal(state.stats.bounded, result.requests);
  assert.equal(state.stats.shortReplies || 0, 0, "bounded requests of reasonable size are never cut short");
  assert.ok(original.length / result.seconds > 60 * 1024 * 4, "well over 4× the 60 KiB/s of the overseas mirror it was addressed to");
  assert.equal(loon.log.notifications.length, 0, "notifications switched off");
});

test("a player that cannot take short answers trips the fuse and gets its stream the old way", async () => {
  await freshLoon();
  const url = mock.mediaUrl(AKAMAI, 1001, "v360", "iphone");
  const seen = await stubbornPlayer({ proxyPort, url, attempts: 6 });
  assert.deepEqual(seen.slice(0, 3).map((item) => item.byScript), [true, true, true]);
  assert.equal(seen.at(-1).complete, true, "after the fuse the full-length answer comes straight from the CDN");
  assert.equal(seen.at(-1).byScript, false);
  assert.equal(seen.length, 4);
  assert.ok(loon.log.notifications.some((line) => /已自动让路/.test(line)));
  const state = loon.state();
  assert.ok(state.breaker.shortReply.until > Date.now());
  // bounded requests are still served: the fuse only covers the partial-answer trick
  const original = file("v360.m4s");
  const part = await segmentPlayer({ proxyPort, url, size: original.length, segment: 524288, stopAfterBytes: 1048576 });
  assert.deepEqual(part.bytes, original.subarray(0, 1048576));
  assert.ok(loon.state().stats.accelerated >= 5);
});

test("with chunked answers switched off, open-ended requests are left alone", async () => {
  await freshLoon({ threads: "8", chunk: "2MB", cdn: "大陆CDN", openEnded: "原样放行", notify: true });
  const url = mock.mediaUrl("upos-sz-mirrorcosov.bilivideo.com", 1001, "a96", "iphone");
  const result = await ffmpegLikePlayer({ proxyPort, url, stopAfterBytes: 200000 });
  assert.equal(result.requests, 1);
  assert.deepEqual(result.bytes.subarray(0, 200000), file("a96.m4s").subarray(0, 200000));
  assert.equal(loon.log.scriptAnswers, 0);
  assert.equal(loon.log.passedThrough, 1);
  assert.match(loon.state().stats.lastPass, /按设置原样放行/);
});

test("mirrors that fail or lie are routed around; if nothing works the request passes through untouched", async () => {
  await freshLoon();
  const url = mock.mediaUrl(AKAMAI, 1001, "v360", "iphone");
  // two dead ends by default (bd never answers, 14b says 403) plus one that reports wrong ranges
  mock.state.profiles["upos-sz-mirrorhw.bilivideo.com"] = { latency: 10, rate: 0, wrongRange: true };
  const original = file("v360.m4s");
  const result = await ffmpegLikePlayer({ proxyPort, url });
  assert.equal(sha(result.bytes), sha(original), "bad mirrors never got their bytes into the stream");
  let state = loon.state();
  assert.ok(state.hosts["upos-sz-mirrorhw.bilivideo.com"]?.bad >= 1, JSON.stringify(state.hosts));
  assert.ok(state.hosts["upos-sz-mirror14b.bilivideo.com"]?.until > Date.now(), `benched after two failures in a row: ${JSON.stringify(state.hosts)}`);
  assert.equal(loon.log.passedThrough, 0, "three bad mirrors out of eight are not a reason to give up");
  // now every mirror refuses (as for content the mirrors do not carry)
  for (const host of Object.keys(state.hosts).concat(["upos-sz-mirrorali.bilivideo.com", "upos-sz-mirrorbos.bilivideo.com", "upos-sz-mirror08c.bilivideo.com", "upos-sz-estgoss.bilivideo.com", "upos-sz-mirrorcos.bilivideo.com"])) {
    mock.state.profiles[host] = { status: 403 };
  }
  loon.store.clear();
  const before = loon.log.passedThrough;
  const fallback = await ffmpegLikePlayer({ proxyPort, url, stopAfterBytes: 150000 });
  assert.deepEqual(fallback.bytes.subarray(0, 150000), original.subarray(0, 150000), "the app still gets its data, from the host it asked");
  assert.equal(loon.log.passedThrough, before + 1);
  state = loon.state();
  assert.equal(state.stats.failed, 1);
  assert.match(state.stats.lastError, /HTTP 403/);
  // after four failures in a row the script stops trying for this origin for a while
  for (let index = 0; index < 3; index += 1) await ffmpegLikePlayer({ proxyPort, url, from: 1000 + index, stopAfterBytes: 1000 });
  state = loon.state();
  assert.ok(state.breaker[`origin:${AKAMAI}`].until > Date.now());
  const requestsBefore = Object.values(mock.stats.hosts).reduce((sum, item) => sum + item.requests, 0);
  await ffmpegLikePlayer({ proxyPort, url, from: 5000, stopAfterBytes: 1000 });
  const requestsAfter = Object.values(mock.stats.hosts).reduce((sum, item) => sum + item.requests, 0);
  assert.equal(requestsAfter - requestsBefore, 1, "only the app's own request went out");
});

test("things the script must not touch", async () => {
  await freshLoon();
  const code = fs.readFileSync(SCRIPT, "utf8");
  const url = mock.mediaUrl(AKAMAI, 1001, "v360", "iphone");
  const run = (request) => runLoonScript({ code, request, httpClientPort: mock.port, store: loon.store, argument: loon.settings.argument, timeoutMs: 30000 });
  const untouched = async (request, why) => {
    const result = await run(request);
    assert.ok(result && Object.keys(result).length === 0, why);
  };
  await untouched({ url, method: "GET", headers: {} }, "no Range: the app expects the whole file with 200");
  await untouched({ url, method: "GET", headers: { Range: "bytes=-500" } }, "suffix ranges");
  await untouched({ url, method: "GET", headers: { Range: "bytes=0-99,200-299" } }, "multi-part ranges");
  await untouched({ url, method: "HEAD", headers: { Range: "bytes=0-99" } }, "HEAD");
  await untouched({ url, method: "GET", headers: { Range: "bytes=0-99", "X-BTR-Sub": "1" } }, "its own sub-requests");
  await untouched({ url, method: "GET", headers: { Range: "bytes=0-99", Origin: "https://www.bilibili.com", "User-Agent": "Mozilla/5.0 Safari" } }, "a web page's requests need the CDN's CORS headers");
  await untouched({ url, method: "GET", headers: { Range: "bytes=0-99", "sec-fetch-mode": "cors" } }, "same, lower-case header names (HTTP/2)");
  await untouched({ url: "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/01/20/1001/1001-1-v360.m4s.json", method: "GET", headers: { Range: "bytes=0-99" } }, "not an m4s");
  await untouched({ url: "https://xy1x2x3x4xy.mcdn.bilivideo.cn:8082/v1/resource/1001-1-v360.m4s?x=1", method: "GET", headers: { Range: "bytes=0-99" } }, "MCDN resource paths use another addressing scheme");
  await untouched({ url: "https://i0.hdslb.com/bfs/archive/cover.jpg", method: "GET", headers: {} }, "anything else");
  const size = file("v360.m4s").length;
  await run({ url, method: "GET", headers: { Range: "bytes=0-99" } }); // learns the size
  await untouched({ url, method: "GET", headers: { Range: `bytes=${size}-` } }, "beyond the end: let the CDN say 416");
  // sub-requests keep the app's own headers (its User-Agent matters to the CDN), minus hop-by-hop ones
  assert.ok(mock.stats.ranges.length > 0);
});

test("status page", async () => {
  await freshLoon();
  const url = mock.mediaUrl(AKAMAI, 1001, "a96", "iphone");
  await ffmpegLikePlayer({ proxyPort, url });
  const code = fs.readFileSync(SCRIPT, "utf8");
  const page = await runLoonScript({ code, store: loon.store, argument: loon.settings.argument, request: { url: "https://www.bilibili.com/__btr_app__/", method: "GET", headers: {} } });
  assert.equal(page.response.status, 200);
  assert.match(page.response.body, /多线程完成<\/td><td>2 次 · 1\.3 MB/);
  assert.match(page.response.body, /开放式 2/);
  assert.match(page.response.body, /bili-universal/);
  assert.match(page.response.body, /8 线程 · 每块 2\.0 MB · 大陆 CDN · 大范围请求：分块答复/);
  const reset = await runLoonScript({ code, store: loon.store, argument: loon.settings.argument, request: { url: "https://www.bilibili.com/__btr_app__/?reset=1", method: "GET", headers: {} } });
  assert.match(reset.response.body, /多线程完成<\/td><td>0 次/);
});

test("two requests at once (picture + sound) do not lose each other's bookkeeping", async () => {
  await freshLoon();
  const video = mock.mediaUrl(AKAMAI, 1001, "v360", "iphone");
  const audio = mock.mediaUrl(AKAMAI, 1001, "a96", "iphone");
  const [a, b] = await Promise.all([
    ffmpegLikePlayer({ proxyPort, url: video }),
    ffmpegLikePlayer({ proxyPort, url: audio })
  ]);
  assert.equal(sha(a.bytes), sha(file("v360.m4s")));
  assert.equal(sha(b.bytes), sha(file("a96.m4s")));
  const state = loon.state();
  assert.equal(state.stats.accelerated, a.requests + b.requests);
  assert.equal(state.stats.bytes, file("v360.m4s").length + file("a96.m4s").length);
  assert.equal(Object.keys(state.totals).length, 2);
});
