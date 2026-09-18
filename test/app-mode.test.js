"use strict";
/*
 * App mode (dist/btr-app.js): simulated Bilibili-app players fetch media through a stand-in for
 * Loon's MITM layer that runs the real script for every request, against the throttled mock CDN.
 * What is checked: the bytes the player ends up with are exactly the file's bytes, it gets them
 * several times faster than its own single connection would, the read-ahead cache does what it
 * says (hits, bounded size, eviction, graceful loss of the store) and every safety net holds.
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
const DEFAULTS = { conns: "32", ahead: "4MB", cache: "16MB", cdn: "大陆CDN", openEnded: "分块答复", notify: true };
const cachedBytes = (state) => state.cache.reduce((sum, entry) => sum + entry.b, 0);

test.before(() => mock.start());
test.after(async () => { await loon?.stop(); await mock.stop(); });

async function freshLoon(argument = DEFAULTS) {
  await loon?.stop();
  mock.resetStats();
  mock.resetProfiles();
  proxyPort += 1;
  loon = createFakeLoon({ port: proxyPort, cdnPort: mock.port, scriptPath: SCRIPT, argument });
  await loon.start();
  return loon;
}

test("segment-style reading (bytes=a-b, ~1 MB at a time, as the real app does): exact bytes, read-ahead makes it many times faster", async () => {
  await freshLoon();
  const url = mock.mediaUrl(AKAMAI, 1001, "v360", "iphone");
  const original = file("v360.m4s");
  const result = await segmentPlayer({ proxyPort, url, size: original.length, segment: 1048576 });
  assert.equal(sha(result.bytes), sha(original), "every byte in place");
  assert.equal(loon.log.passedThrough, 0, "nothing had to fall back");
  const rate = original.length / result.seconds;
  // the player's own route: one connection to the cold Akamai edge at 40 KiB/s
  assert.ok(rate > 40 * 1024 * 12, `${(rate / 1024).toFixed(0)} KiB/s should be well over 12× the 40 KiB/s the app gets on its own`);
  const state = loon.state();
  assert.equal(state.stats.bounded, result.requests);
  assert.equal(state.stats.served, original.length);
  assert.ok((state.stats.hits || 0) + (state.stats.partial || 0) >= 2, `later segments come from the cache (a full or partial hit): ${JSON.stringify(state.stats)}`);
  assert.ok(state.stats.servedCached > original.length * 0.3, `a good part of the bytes were already there when asked for: ${state.stats.servedCached}`);
  assert.equal(state.stats.shortReplies || 0, 0, "bounded requests of reasonable size are never cut short");
  assert.ok(state.flags.storeTest.ok, "the store self-test passed");
  assert.ok(state.stats.batches < result.requests, `fewer batches than requests: ${state.stats.batches} for ${result.requests}`);
  assert.ok(Object.keys(mock.stats.hosts).filter((host) => mock.stats.hosts[host].bytes > 0).length >= 4, "several mirrors shared the work");
  assert.equal(mock.stats.hosts[AKAMAI], undefined, "the slow origin host was not needed at all");
  assert.ok(mock.stats.maxConcurrent >= 8, `parallel connections: ${mock.stats.maxConcurrent}`);
  assert.equal(mock.stats.signatureFailures, 0);
  assert.equal(state.hosts["upos-sz-mirrorbd.bilivideo.com"]?.ok || 0, 0, "the mirror that never answers never got a chance to matter");
  assert.ok((mock.stats.hosts["upos-sz-mirrorbd.bilivideo.com"]?.requests || 0) <= 6, "…and was only ever probed with a few read-ahead pieces");
  assert.ok(loon.log.notifications.some((line) => /正在加速/.test(line)), "one notification says it works");
  assert.equal(loon.log.notifications.filter((line) => /正在加速/.test(line)).length, 1, "…and only one");
});

test("ijkplayer-style reading (bytes=a- , reconnect when the answer ends early): exact bytes, few reconnects", async () => {
  await freshLoon();
  const url = mock.mediaUrl(AKAMAI, 1001, "v360", "iphone");
  const original = file("v360.m4s");
  const result = await ffmpegLikePlayer({ proxyPort, url });
  assert.equal(result.total, original.length);
  assert.equal(sha(result.bytes), sha(original), "every byte in place");
  assert.equal(loon.log.passedThrough, 0, "nothing had to fall back");
  assert.ok(result.requests >= 2 && result.requests <= 5, `5.2 MB in a few answers: ${result.requests} requests`);
  assert.ok(original.length / result.seconds > 40 * 1024 * 8, "well over 8× the app's own 40 KiB/s");
  const state = loon.state();
  assert.equal(state.stats.open, result.requests);
  assert.equal(state.stats.served, original.length);
  assert.equal(state.stats.shortReplies, result.requests - 1, "all answers but the last were partial");
  assert.ok(state.stats.agent.startsWith("bili-universal/"));
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
  assert.deepEqual(Buffer.from(tail.response.body), file("a96.m4s").subarray(1048576));
  const exact = await run("bytes=100-299");
  assert.equal(exact.response.headers["Content-Range"], `bytes 100-299/${size}`);
  assert.equal(exact.response.headers.Connection, undefined);
  assert.deepEqual(Buffer.from(exact.response.body), file("a96.m4s").subarray(100, 300));
  // a spelled-out range from the start of a file is honoured in full (the 1 MB first block is for "0-" only)
  const wide = await run("bytes=0-1299999");
  assert.equal(wide.response.headers["Content-Range"], `bytes 0-1299999/${size}`);
  assert.equal(wide.response.body.length, 1300000);
  assert.deepEqual(Buffer.from(wide.response.body), file("a96.m4s").subarray(0, 1300000));
  // …but one that would not fit in memory comfortably is answered in what one batch can carry
  const videoUrl = mock.mediaUrl(AKAMAI, 1001, "v720", "iphone");
  const huge = await runLoonScript({
    code: fs.readFileSync(SCRIPT, "utf8"), httpClientPort: mock.port, store: loon.store, timeoutMs: 30000,
    argument: loon.settings.argument, request: { url: videoUrl, method: "GET", headers: { Range: "bytes=1048576-24000000" } }
  });
  const hugeRange = /^bytes 1048576-(\d+)\/(\d+)$/.exec(huge.response.headers["Content-Range"]);
  assert.ok(hugeRange, huge.response.headers["Content-Range"]);
  const hugeBytes = Number(hugeRange[1]) - 1048576 + 1;
  assert.ok(hugeBytes >= 2097152 && hugeBytes <= 8 * 1048576, `between 2 and 8 MB: ${hugeBytes}`);
  assert.equal(huge.response.body.length, hugeBytes);
  assert.equal(Number(hugeRange[2]), file("v720.m4s").length);
  assert.equal(huge.response.headers.Connection, "close");
});

test("the end of a file whose length is not known yet: read-ahead past the end is harmless", async () => {
  await freshLoon();
  const url = mock.mediaUrl(AKAMAI, 1001, "v360", "iphone");
  const original = file("v360.m4s");
  const near = original.length - 300000;
  const result = await ffmpegLikePlayer({ proxyPort, url, from: near });
  assert.deepEqual(result.bytes, original.subarray(near));
  assert.equal(result.requests, 1, "one complete answer");
  const state = loon.state();
  assert.equal(state.stats.failed || 0, 0, "a 416 on read-ahead is not a failure");
  assert.equal(loon.log.passedThrough, 0);
  for (const host of Object.keys(state.hosts)) {
    if (!/mirrorbd|mirror14b/.test(host)) assert.equal(state.hosts[host].bad, 0, `${host} was not blamed for the end of the file`);
  }
});

test("cache stays within its limit and lets go of what has been played", async () => {
  await freshLoon({ ...DEFAULTS, cache: "4MB", ahead: "8MB" });
  const url = mock.mediaUrl(AKAMAI, 1001, "v720", "iphone");
  const original = file("v720.m4s");
  const result = await segmentPlayer({ proxyPort, url, size: original.length, segment: 1048576, stopAfterBytes: 12 * 1048576 });
  assert.equal(sha(result.bytes), sha(original.subarray(0, 12 * 1048576)));
  const state = loon.state();
  assert.ok(cachedBytes(state) <= 4 * 1048576, `cache holds ${cachedBytes(state)} bytes, limit 4 MB`);
  const head = state.heads[Object.keys(state.heads)[0]];
  for (const entry of state.cache) assert.ok(entry.e >= head.pos - 524288, "nothing far behind the play position is kept");
  for (const entry of state.cache) assert.ok(loon.store.has(`btr_ios_app_c:${entry.k}`), "every listed entry has its bytes");
  for (const key of loon.store.keys()) {
    if (key.startsWith("btr_ios_app_c:") && loon.store.get(key)) assert.ok(state.cache.some((entry) => key === `btr_ios_app_c:${entry.k}`), `${key} is listed`);
  }
  assert.ok((state.stats.hits || 0) + (state.stats.partial || 0) >= 3, `read-ahead kept feeding later reads from cache: hits ${state.stats.hits || 0}, partial ${state.stats.partial || 0}`);
});

test("mirrors of very different speed (as measured on a phone): the fast ones carry the batch, the slow ones never hold it up", async () => {
  await freshLoon();
  const KB = 1024;
  Object.assign(mock.state.profiles, {
    "upos-sz-mirrorali.bilivideo.com": { latency: 200, rate: 250 * KB },
    "upos-sz-mirror14b.bilivideo.com": { latency: 200, rate: 210 * KB },
    "upos-sz-mirrorbos.bilivideo.com": { latency: 200, rate: 56 * KB },
    "upos-sz-estgoss.bilivideo.com": { latency: 200, rate: 26 * KB },
    "upos-sz-mirrorcos.bilivideo.com": { latency: 200, rate: 32 * KB },
    "upos-sz-mirrorbd.bilivideo.com": { latency: 200, rate: 17 * KB },
    "upos-sz-mirror08c.bilivideo.com": { latency: 200, rate: 14 * KB },
    "upos-sz-mirrorhw.bilivideo.com": { latency: 200, rate: 12 * KB }
  });
  const url = mock.mediaUrl(AKAMAI, 1001, "v720", "iphone");
  const original = file("v720.m4s");
  const result = await segmentPlayer({ proxyPort, url, size: original.length, segment: 1048576, stopAfterBytes: 12 * 1048576 });
  assert.equal(sha(result.bytes), sha(original.subarray(0, 12 * 1048576)));
  const state = loon.state();
  assert.equal(state.stats.failed || 0, 0, "no batch ran into the deadline");
  assert.equal(loon.log.passedThrough, 0);
  const rate = 12 * 1048576 / result.seconds;
  assert.ok(rate > 1024 * 1024, `${(rate / 1024).toFixed(0)} KiB/s: over 1 MiB/s although most mirrors crawl`);
  // The point of the design is to add every route's bandwidth together, so many mirrors carry bytes
  // — not only the two fastest. The fast ones still pull far more per connection, which is what
  // sends the App's own blocking bytes to them; the slow ones fill in read-ahead without gating it.
  const contributing = Object.keys(mock.stats.hosts).filter(function (h) { return mock.stats.hosts[h].bytes > 0 && !/akam/.test(h); }).length;
  assert.ok(contributing >= 5, `many routes were summed, not just the fast few: ${contributing} mirrors carried bytes`);
  assert.ok((mock.stats.hosts["upos-sz-mirrorali.bilivideo.com"]?.bytes || 0) > (mock.stats.hosts["upos-sz-mirrorbos.bilivideo.com"]?.bytes || 0), "the fast mirror still carried more than a slow one");
  assert.ok(state.stats.slowRuns === undefined || state.stats.slowRuns <= 1, `answers over 4 s: ${state.stats.slowRuns}`);
  assert.ok(state.hosts["upos-sz-mirrorali.bilivideo.com"].bps > state.hosts["upos-sz-mirrorbos.bilivideo.com"].bps * 2, "the fast mirror is measured much quicker per connection");
});

test("when every mirror crawls (a congested overseas link) they are summed, not benched", async () => {
  // The failure mode this guards against: over a slow evening link every mirror answers late, and an
  // earlier version read that as "bad", knocked each mirror's measured speed down and rested the
  // ones that were late three times running — including the fastest — leaving even less bandwidth. A
  // mirror that is only slow must keep its place, because throughput here is the sum over all of them.
  await freshLoon();
  const KB = 1024;
  for (const short of ["mirrorali", "mirrorhw", "mirrorbos", "mirror08c", "mirrorbd", "mirror14b", "estgoss", "mirrorcos"]) {
    mock.state.profiles["upos-sz-" + short + ".bilivideo.com"] = { latency: 300, rate: 18 * KB };
  }
  const url = mock.mediaUrl(AKAMAI, 1001, "v720", "iphone");
  const original = file("v720.m4s");
  const result = await segmentPlayer({ proxyPort, url, size: original.length, segment: 1048576, stopAfterBytes: 6 * 1048576 });
  assert.equal(sha(result.bytes), sha(original.subarray(0, 6 * 1048576)), "every byte still arrives");
  assert.equal(loon.log.passedThrough, 0, "slow mirrors added together still carry the stream");
  const state = loon.state();
  let late = 0;
  let benched = 0;
  let carried = 0;
  for (const host of Object.keys(state.hosts)) {
    if (state.hosts[host].late > 0) late += 1;
    if (state.hosts[host].until > Date.now()) benched += 1;
    if ((state.hosts[host].ok || 0) > 0) carried += 1;
  }
  assert.ok(late >= 1, "mirrors were indeed slow enough to be marked late");
  assert.equal(benched, 0, "but lateness alone benched none of them");
  assert.ok(carried >= 6, `their bandwidth was summed across many mirrors: ${carried} carried pieces`);
});

test("when the store cannot hold the data, playback goes on without a cache", async () => {
  await freshLoon();
  const original = file("v360.m4s");
  const url = mock.mediaUrl(AKAMAI, 1001, "v360", "iphone");
  const realWrite = loon.store.set.bind(loon.store);
  loon.store.set = (key, value) => { if (key.startsWith("btr_ios_app_c:") && value.length > 100000) return loon.store; return realWrite(key, value); };
  const result = await segmentPlayer({ proxyPort, url, size: original.length, segment: 1048576 });
  assert.equal(sha(result.bytes), sha(original));
  const state = loon.state();
  assert.equal(state.flags.storeTest.ok, false);
  assert.match(state.flags.cacheOff, /自检/);
  assert.equal(state.stats.hits || 0, 0);
  assert.equal(state.stats.misses, result.requests, "every request was fetched on its own");
  assert.equal(state.cache.length, 0);
  assert.equal(loon.log.passedThrough, 0);
});

test("a player that cannot take short answers trips the fuse and gets its stream the old way", async () => {
  await freshLoon();
  const url = mock.mediaUrl(AKAMAI, 1001, "v720", "iphone");
  const seen = await stubbornPlayer({ proxyPort, url, attempts: 6 });
  assert.deepEqual(seen.slice(0, 3).map((item) => item.byScript), [true, true, true]);
  assert.equal(seen.at(-1).complete, true, "after the fuse the full-length answer comes straight from the CDN");
  assert.equal(seen.at(-1).byScript, false);
  assert.equal(seen.length, 4);
  assert.ok(loon.log.notifications.some((line) => /已自动让路/.test(line)));
  const state = loon.state();
  assert.ok(state.breaker.shortReply.until > Date.now());
  // bounded requests are still served: the fuse only covers the partial-answer trick
  const original = file("v720.m4s");
  const part = await segmentPlayer({ proxyPort, url, size: original.length, segment: 524288, stopAfterBytes: 1048576 });
  assert.deepEqual(part.bytes, original.subarray(0, 1048576));
  assert.ok(loon.state().stats.served >= 1048576 + 3 * 1048576);
});

test("with chunked answers switched off, open-ended requests are left alone", async () => {
  await freshLoon({ ...DEFAULTS, openEnded: "原样放行" });
  const url = mock.mediaUrl("upos-sz-mirrorcosov.bilivideo.com", 1001, "a96", "iphone");
  const result = await ffmpegLikePlayer({ proxyPort, url, stopAfterBytes: 200000 });
  assert.equal(result.requests, 1);
  assert.deepEqual(result.bytes.subarray(0, 200000), file("a96.m4s").subarray(0, 200000));
  assert.equal(loon.log.scriptAnswers, 0);
  assert.equal(loon.log.passedThrough, 1);
  assert.match(loon.state().stats.lastPass, /按设置原样放行/);
});

test("read-ahead and cache can be switched off: then it is plain multi-threading", async () => {
  await freshLoon({ ...DEFAULTS, ahead: "关闭", cache: "关闭" });
  const url = mock.mediaUrl(AKAMAI, 1001, "v360", "iphone");
  const original = file("v360.m4s");
  const result = await segmentPlayer({ proxyPort, url, size: original.length, segment: 1048576, stopAfterBytes: 3 * 1048576 });
  assert.deepEqual(result.bytes, original.subarray(0, 3 * 1048576));
  const state = loon.state();
  assert.equal(state.stats.misses, 3);
  assert.equal(state.stats.fetched, 3 * 1048576, "not a byte more than the app asked for");
  assert.equal(state.cache.length, 0);
  assert.equal(state.flags.storeTest, undefined, "no self-test when the cache is off");
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
  assert.ok(state.hosts["upos-sz-mirror14b.bilivideo.com"]?.bad >= 1, "the refusing mirror was found out on a read-ahead piece");
  assert.ok(state.hosts["upos-sz-mirrorhw.bilivideo.com"]?.until > Date.now() || state.hosts["upos-sz-mirrorbd.bilivideo.com"]?.until > Date.now(), `benched after two failures in a row: ${JSON.stringify(state.hosts)}`);
  assert.equal(loon.log.passedThrough, 0, "three bad mirrors out of eight are not a reason to give up");
  // now every mirror refuses (as for content the mirrors do not carry). The whole pool has to be
  // covered — both the mainland and the overseas/Hong Kong nodes — or the script keeps finding a
  // working route and never falls back. The Akamai origin the app itself asked for is left alone.
  const everyMirror = [
    "upos-sz-mirrorali.bilivideo.com", "upos-sz-mirrorali02.bilivideo.com", "upos-sz-mirrorhw.bilivideo.com",
    "upos-sz-mirrorhwb.bilivideo.com", "upos-sz-mirrorbos.bilivideo.com", "upos-sz-mirror08c.bilivideo.com",
    "upos-sz-mirror08h.bilivideo.com", "upos-sz-mirrorbd.bilivideo.com", "upos-sz-mirror14b.bilivideo.com",
    "upos-sz-estgoss.bilivideo.com", "upos-sz-mirrorcos.bilivideo.com", "upos-sz-mirrorcosb.bilivideo.com",
    "upos-sz-upcdntx.bilivideo.com", "upos-sz-upcdnbda2.bilivideo.com", "upos-sz-upcdnqn.bilivideo.com",
    "upos-sz-upcdnws.bilivideo.com", "upos-sz-mirroraliov.bilivideo.com", "upos-sz-mirrorcosov.bilivideo.com",
    "cn-hk-eq-01-01.bilivideo.com", "cn-hk-eq-01-03.bilivideo.com", "cn-hk-eq-bcache-01.bilivideo.com"
  ];
  for (const host of Object.keys(state.hosts).concat(everyMirror)) {
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
  assert.match(page.response.body, /交给 App<\/td><td>1\.3 MB/);
  assert.match(page.response.body, /开放式 2/);
  assert.match(page.response.body, /bili-universal/);
  assert.match(page.response.body, /32 条连接 · 预读 4\.0 MB · 缓存上限 16\.0 MB · 大陆 CDN · 大范围请求：分块答复/);
  assert.match(page.response.body, /存储自检<\/td><td>通过/);
  assert.match(page.response.body, /KB\/s/, "mirror speeds are shown");
  assert.match(page.response.body, /重复位置<\/td><td>0 次/);
  const reset = await runLoonScript({ code, store: loon.store, argument: loon.settings.argument, request: { url: "https://www.bilibili.com/__btr_app__/?reset=1", method: "GET", headers: {} } });
  assert.match(reset.response.body, /交给 App<\/td><td>0 KB/);
  assert.equal(Array.from(loon.store.keys()).filter((key) => key.startsWith("btr_ios_app_c:") && loon.store.get(key)).length, 0, "reset drops the cached bytes too");
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
  assert.equal(state.stats.open, a.requests + b.requests);
  assert.equal(state.stats.served, file("v360.m4s").length + file("a96.m4s").length);
  assert.equal(Object.keys(state.totals).length, 2);
  assert.equal(Object.keys(state.heads).length, 2);
});
