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

/* ------------------------------------------------------------------ 1.5.0: upstream kernel rules */

const AUTO = { ...DEFAULTS, conns: "自动" };
const LADDER = [8, 12, 16, 24, 32, 48];
const everyMirrorProfile = (profile) => {
  for (const pattern of ["*", "*ov.bilivideo.com", "cn-hk-eq-*"]) mock.state.profiles[pattern] = profile;
};
const writeState = (state) => loon.store.set("btr_ios_app_v2", JSON.stringify(state));

test("automatic connection count: climbs while the App waits and more connections bring more", async () => {
  await freshLoon(AUTO);
  // every connection crawls on its own (30 KiB/s, far away) but they do not share a bottleneck
  everyMirrorProfile({ latency: 200, rate: 30 * 1024 });
  const url = mock.mediaUrl(AKAMAI, 1001, "v720", "iphone");
  const original = file("v720.m4s");
  const result = await segmentPlayer({ proxyPort, url, size: original.length, segment: 1048576, stopAfterBytes: 8 * 1048576 });
  assert.equal(sha(result.bytes), sha(original.subarray(0, 8 * 1048576)), "every byte in place");
  assert.equal(loon.log.passedThrough, 0);
  const state = loon.state();
  assert.ok(state.auto.lvl >= 4, `climbed from 16 to at least 32 connections: now ${LADDER[state.auto.lvl]} (${JSON.stringify(state.auto.log)})`);
  assert.ok(state.auto.log.every((step) => /App 等了|又要了一次/.test(step.m)), "every step up was because the App waited");
  const speedAt = (level) => { const list = state.autoS.filter((s) => s.l === level); return list.reduce((a, s) => a + s.b, 0) / Math.max(1, list.reduce((a, s) => a + s.ms, 0)); };
  assert.ok(speedAt(state.auto.lvl) > speedAt(2) * 2, `batches got quicker with more connections: ${speedAt(2).toFixed(0)} → ${speedAt(state.auto.lvl).toFixed(0)} B/ms`);
  assert.ok(mock.stats.maxConcurrent > 16, `more than 16 connections at once in the end: ${mock.stats.maxConcurrent}`);
});

test("automatic connection count: a step that did not make batches quicker is taken back, and that level rests", async () => {
  await freshLoon(AUTO);
  const code = fs.readFileSync(SCRIPT, "utf8");
  // A different file every time: the judgement is about the trial, not about how busy one stream is.
  let cid = 1100;
  const run = (range) => runLoonScript({ code, httpClientPort: mock.port, store: loon.store, timeoutMs: 30000, argument: loon.settings.argument, request: { url: mock.mediaUrl(AKAMAI, cid++, "v360", "iphone"), method: "GET", headers: { Range: range, "User-Agent": "bili-universal/1" } } });
  await run("bytes=0-1048575");
  // A trial of 24 connections (from 16) that started 11 s ago with a baseline of 800 B/ms; since
  // then full batches at 24 made only ~500 B/ms.
  const seed = (afterBps, extra = {}) => {
    const state = loon.state();
    const now = Date.now();
    state.auto = { lvl: 3, at: now - 11000, why: "App 等了 2.0 秒", trial: { from: 2, to: 3, at: now - 11000, base: 800, stalled: false, ...extra }, rest: {}, log: [], steps: 1 };
    state.autoS = [
      { l: 2, b: 800000, ms: 1000, t: now - 15000 },
      { l: 3, b: afterBps * 1000, ms: 1000, t: now - 8000 },
      { l: 3, b: afterBps * 1000, ms: 1000, t: now - 4000 },
      { l: 3, b: afterBps * 1000, ms: 1000, t: now - 1000 }
    ];
    writeState(state);
  };
  seed(500);
  await run("bytes=4000000-4099999");
  let state = loon.state();
  assert.equal(LADDER[state.auto.lvl], 16, "back to where the trial started");
  assert.equal(state.auto.trial, null);
  assert.ok(state.auto.rest["3"] && state.auto.rest["3"].until > Date.now() && !state.auto.rest["3"].hard, "24 rests for a while (a soft rest)");
  assert.match(state.auto.log.at(-1).m, /24 条没有比 16 条更快/);
  // …and plain pressure does not climb into the resting level again
  state.auto.at = Date.now() - 10000;
  writeState(state);
  mock.state.profiles["*"] = { latency: 1700, rate: 120 * 1024 };
  await run("bytes=5000000-5999999");
  state = loon.state();
  assert.equal(LADDER[state.auto.lvl], 16, `a resting level is skipped only on a stall: ${JSON.stringify(state.auto.log)}`);
  mock.resetProfiles();

  seed(950);
  await run("bytes=4100000-4199999");
  state = loon.state();
  assert.equal(LADDER[state.auto.lvl], 24, "a step that made batches quicker is kept");
  assert.equal(state.auto.trial, null, "…and the trial is over");

  seed(500, { stalled: true });
  await run("bytes=4200000-4299999");
  state = loon.state();
  assert.equal(LADDER[state.auto.lvl], 24, "a stall during the trial proves nothing: the level stays");
});

test("a mirror that answers 412 / 429 (too many connections) steps the count down and keeps its place", async () => {
  await freshLoon(AUTO);
  const limited = ["upos-sz-mirrorali.bilivideo.com", "upos-sz-mirrorhw.bilivideo.com", "upos-sz-mirrorbos.bilivideo.com"];
  for (const host of limited) mock.state.profiles[host] = { latency: 160, rate: 120 * 1024, limitConcurrent: 1, limitStatus: 429 };
  mock.state.profiles["upos-sz-mirror08c.bilivideo.com"] = { latency: 160, rate: 120 * 1024, limitConcurrent: 1, limitStatus: 412 };
  const url = mock.mediaUrl(AKAMAI, 1001, "v720", "iphone");
  const original = file("v720.m4s");
  const result = await segmentPlayer({ proxyPort, url, size: original.length, segment: 1048576, stopAfterBytes: 6 * 1048576 });
  assert.equal(sha(result.bytes), sha(original.subarray(0, 6 * 1048576)), "every byte in place");
  assert.equal(loon.log.passedThrough, 0, "refused connections are retried elsewhere, nothing falls back");
  const state = loon.state();
  const refusals = limited.concat("upos-sz-mirror08c.bilivideo.com").reduce((sum, host) => sum + (mock.stats.hosts[host]?.limited || 0), 0);
  assert.ok(refusals >= 1, "the mock did refuse connections");
  assert.ok(state.stats.limited >= 1);
  assert.ok(state.auto.lvl < 2, `stepped down from 16: now ${LADDER[state.auto.lvl]}`);
  assert.match(state.auto.log[0].m, /限流/);
  const rested = Object.keys(state.auto.rest).filter((level) => state.auto.rest[level].hard);
  assert.ok(rested.includes("2"), `16 rests hard after the refusal: ${JSON.stringify(state.auto.rest)}`);
  for (const host of limited) {
    assert.ok(!(state.hosts[host]?.until > Date.now()), `${host} is not benched for limiting connections`);
  }
  assert.ok(limited.some((host) => (state.hosts[host]?.ok || 0) > 0), "the limiting mirrors still carried pieces");
});

test("a mirror that refuses one file (but serves others) is dropped for that file only", async () => {
  await freshLoon();
  const picky = "upos-sz-mirrorali.bilivideo.com";
  mock.state.profiles[picky] = { latency: 100, rate: 200 * 1024, refuseKeys: ["v720"] };
  const original360 = file("v360.m4s");
  const warm = await segmentPlayer({ proxyPort, url: mock.mediaUrl(AKAMAI, 1001, "v360", "iphone"), size: original360.length, segment: 1048576, stopAfterBytes: 2 * 1048576 });
  assert.equal(sha(warm.bytes), sha(original360.subarray(0, 2 * 1048576)));
  assert.ok(loon.state().hosts[picky].ok > 0, "the mirror served the first file");
  const original720 = file("v720.m4s");
  const video = await segmentPlayer({ proxyPort, url: mock.mediaUrl(AKAMAI, 1001, "v720", "iphone"), size: original720.length, segment: 1048576, stopAfterBytes: 8 * 1048576 });
  assert.equal(sha(video.bytes), sha(original720.subarray(0, 8 * 1048576)), "the refusals cost nothing but a retry");
  assert.equal(loon.log.passedThrough, 0);
  let state = loon.state();
  const refusedDuring = mock.stats.hosts[picky].refused || 0;
  assert.ok(refusedDuring >= 1, "it did refuse the second file");
  // The first batch may have given the (fast) mirror several pieces at once, up to its 6
  // connections; they are all refused together. After that the pair is dropped.
  assert.ok(refusedDuring <= 6, `the pair is dropped after the first batch, not asked again and again: ${refusedDuring} refusals`);
  assert.ok(state.hosts[picky].refused >= 1);
  assert.ok(!(state.hosts[picky].until > Date.now()), "the mirror as a whole is not benched");
  assert.ok(Object.keys(state.pairs).some((key) => key.startsWith(picky + " ") && state.pairs[key].n >= 2), JSON.stringify(state.pairs));
  // the pair stays dropped for the rest of that file…
  const more = await segmentPlayer({ proxyPort, url: mock.mediaUrl(AKAMAI, 1002, "v720", "iphone"), size: original720.length, segment: 1048576, stopAfterBytes: 1 });
  assert.equal(more.bytes.length, 1048576);
  // …while the mirror keeps serving other files at full speed
  const bytesBefore = mock.stats.hosts[picky].bytes;
  const audio = await segmentPlayer({ proxyPort, url: mock.mediaUrl(AKAMAI, 1001, "a96", "iphone"), size: file("a96.m4s").length, segment: 1048576 });
  assert.equal(sha(audio.bytes), sha(file("a96.m4s")));
  assert.ok(mock.stats.hosts[picky].bytes > bytesBefore, "the picky mirror carried bytes of the other file");
  state = loon.state();
  assert.ok(!(state.hosts[picky].until > Date.now()));
});

test("a mirror measured at under a twelfth of the fastest sits out, and is tried again once that is old", async () => {
  await freshLoon();
  const slow = "upos-sz-mirrorhw.bilivideo.com";
  const url = mock.mediaUrl(AKAMAI, 1001, "v720", "iphone");
  const original = file("v720.m4s");
  await segmentPlayer({ proxyPort, url, size: original.length, segment: 1048576, stopAfterBytes: 1048576 });
  const seedSlow = (measuredAgo) => {
    const state = loon.state();
    const top = Math.max(...Object.values(state.hosts).map((item) => item.bps || 0));
    state.hosts[slow] = { ...(state.hosts[slow] || {}), ok: 3, bad: 0, until: 0, streak: 0, bps: top / 20, at: Date.now() - measuredAgo };
    // the cache would answer from memory; empty it so every request goes to the mirrors
    for (const entry of state.cache) loon.store.set(`btr_ios_app_c:${entry.k}`, "");
    state.cache = [];
    writeState(state);
  };
  seedSlow(5000);
  const before = mock.stats.hosts[slow]?.requests || 0;
  const part = await segmentPlayer({ proxyPort, url: mock.mediaUrl(AKAMAI, 1003, "v720", "iphone"), size: original.length, segment: 1048576, stopAfterBytes: 4 * 1048576 });
  assert.equal(sha(part.bytes), sha(original.subarray(0, 4 * 1048576)));
  assert.equal((mock.stats.hosts[slow]?.requests || 0) - before, 0, "the very slow mirror got no piece");
  const page = await runLoonScript({ code: fs.readFileSync(SCRIPT, "utf8"), store: loon.store, argument: loon.settings.argument, request: { url: "https://www.bilibili.com/__btr_app__/", method: "GET", headers: {} } });
  assert.match(page.response.body, /太慢，暂不用/);
  // measured long ago: it gets a probe again
  seedSlow(5 * 60000);
  const again = mock.stats.hosts[slow]?.requests || 0;
  await segmentPlayer({ proxyPort, url: mock.mediaUrl(AKAMAI, 1004, "v720", "iphone"), size: original.length, segment: 1048576, stopAfterBytes: 3 * 1048576 });
  assert.ok((mock.stats.hosts[slow]?.requests || 0) > again, "an old measurement does not keep a mirror out for good");
});

test("hedge copies go to a clearly faster mirror, not to an equally slow one", async () => {
  await freshLoon();
  const url = mock.mediaUrl(AKAMAI, 1001, "v720", "iphone");
  const original = file("v720.m4s");
  await segmentPlayer({ proxyPort, url, size: original.length, segment: 1048576, stopAfterBytes: 2 * 1048576 });
  // One mirror swallows the App's piece; every other mirror is measured about as fast as it.
  const state = loon.state();
  const hosts = Object.keys(state.hosts).filter((host) => (state.hosts[host].bps || 0) > 0);
  assert.ok(hosts.length >= 6);
  const stuck = hosts[0];
  for (const host of hosts) state.hosts[host].bps = 100;
  state.hosts[stuck].bps = 400;
  for (const entry of state.cache) loon.store.set(`btr_ios_app_c:${entry.k}`, "");
  state.cache = [];
  writeState(state);
  mock.state.profiles[stuck] = { dead: true };
  const code = fs.readFileSync(SCRIPT, "utf8");
  const t0 = Date.now();
  const reply = await runLoonScript({ code, httpClientPort: mock.port, store: loon.store, timeoutMs: 30000, argument: { ...DEFAULTS, ahead: "关闭", cache: "关闭" }, request: { url: mock.mediaUrl(AKAMAI, 1005, "v720", "iphone"), method: "GET", headers: { Range: "bytes=0-399999", "User-Agent": "bili-universal/1" } } });
  assert.equal(reply.response.status, 206, "the App still gets its bytes");
  assert.deepEqual(Buffer.from(reply.response.body), original.subarray(0, 400000));
  const took = Date.now() - t0;
  // the first (1.4 s) copy may only go to a 1.5× faster mirror — there is none; the copies at 2.2 s
  // (the App has waited long) may go anywhere and rescue it
  assert.ok(took >= 2000 && took < 6000, `rescued by the late copy, not the early one: ${took} ms`);
});

test("status page in automatic mode, and the plugin file", async () => {
  await freshLoon(AUTO);
  await ffmpegLikePlayer({ proxyPort, url: mock.mediaUrl(AKAMAI, 1001, "a96", "iphone") });
  const page = await runLoonScript({ code: fs.readFileSync(SCRIPT, "utf8"), store: loon.store, argument: loon.settings.argument, request: { url: "https://www.bilibili.com/__btr_app__/", method: "GET", headers: {} } });
  assert.match(page.response.body, /设置<\/td><td>自动连接数 · 预读/);
  assert.match(page.response.body, /连接数<\/td><td>自动 · 现在 \d+ 条/);
  assert.match(page.response.body, /来源节点<\/td><td>upos-hz-mirrorakam\.akamaized\.net × \d+/);
  assert.match(page.response.body, /限流（412\/429）<\/td><td>0 次/);

  const plugin = fs.readFileSync(path.join(ROOT, "dist", "BTR-iOS-App.plugin"), "utf8");
  assert.match(plugin, /^conns = select,"自动",/m, "automatic is the default (the first choice)");
  const mitm = /^hostname = (.+)$/m.exec(plugin)[1].split(/\s*,\s*/);
  const covered = (host) => mitm.some((pattern) => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(host));
  // what the pink and the white (international) app are handed from overseas
  for (const host of ["upos-hz-mirrorakam.akamaized.net", "upos-sz-mirrorcosov.bilivideo.com", "cn-hk-eq-01-03.bilivideo.com", "cn-gdfs-ct-01-01.bilivideo.com", "upos-sz-mirrorali.bilivideo.com", "xy1x2x3x4xy.mcdn.bilivideo.cn", "www.bilibili.com"]) {
    assert.ok(covered(host), `${host} is decrypted`);
  }
  for (const host of ["i0.hdslb.com", "api.bilibili.com", "app.bilibili.com", "grpc.biliapi.net", "example.akamaized.net"]) {
    assert.ok(!covered(host), `${host} is left alone`);
  }
  const rule = /^http-request (\S+) script-path=\S+, tag=BTR App 模式,/m.exec(plugin)[1];
  for (const sample of ["https://cn-gdfs-ct-01-01.bilivideo.com/upgcxcode/01/20/1001/1001-1-30080.m4s?e=1", "http://xy1x2x3x4xy.mcdn.bilivideo.cn:4483/upgcxcode/01/20/1001/1001-1-30280.m4s?e=1"]) {
    assert.ok(new RegExp(rule).test(sample), `${sample} reaches the script`);
  }
});

test("every mirror refusing one address: the App gets it straight from its own host, without waiting out the deadline", async () => {
  await freshLoon();
  await segmentPlayer({ proxyPort, url: mock.mediaUrl(AKAMAI, 1001, "v360", "iphone"), size: file("v360.m4s").length, segment: 1048576, stopAfterBytes: 1048576 });
  // every mirror has served before…
  const state = loon.state();
  const everyMirror = [
    "upos-sz-mirrorali.bilivideo.com", "upos-sz-mirrorali02.bilivideo.com", "upos-sz-mirrorhw.bilivideo.com",
    "upos-sz-mirrorhwb.bilivideo.com", "upos-sz-mirrorbos.bilivideo.com", "upos-sz-mirror08c.bilivideo.com",
    "upos-sz-mirror08h.bilivideo.com", "upos-sz-mirrorbd.bilivideo.com", "upos-sz-mirror14b.bilivideo.com",
    "upos-sz-estgoss.bilivideo.com", "upos-sz-mirrorcos.bilivideo.com", "upos-sz-mirrorcosb.bilivideo.com",
    "upos-sz-upcdntx.bilivideo.com", "upos-sz-upcdnbda2.bilivideo.com", "upos-sz-upcdnqn.bilivideo.com",
    "upos-sz-upcdnws.bilivideo.com", "upos-sz-mirroraliov.bilivideo.com", "upos-sz-mirrorcosov.bilivideo.com",
    "cn-hk-eq-01-01.bilivideo.com", "cn-hk-eq-01-03.bilivideo.com", "cn-hk-eq-bcache-01.bilivideo.com"
  ];
  for (const host of everyMirror) state.hosts[host] = { ...(state.hosts[host] || {}), ok: 3, bad: 0, streak: 0, until: 0, bps: state.hosts[host]?.bps || 80, at: Date.now() };
  writeState(state);
  // …and now every one of them refuses this file (the Akamai host the App asked keeps serving it)
  for (const host of everyMirror) mock.state.profiles[host] = { latency: 20, rate: 0, refuseKeys: ["v720"] };
  const code = fs.readFileSync(SCRIPT, "utf8");
  const url = mock.mediaUrl(AKAMAI, 1001, "v720", "iphone");
  const times = [];
  for (let index = 0; index < 6; index += 1) {
    const t0 = Date.now();
    const result = await runLoonScript({ code, httpClientPort: mock.port, store: loon.store, timeoutMs: 30000, argument: { ...DEFAULTS, cache: "关闭", ahead: "关闭" }, request: { url, method: "GET", headers: { Range: `bytes=${index * 100000}-${index * 100000 + 99999}`, "User-Agent": "bili-universal/1" } } });
    times.push(Date.now() - t0);
    assert.ok(result && !result.response, "passed through to the App's own host");
  }
  assert.ok(Math.max(...times) < 2500, `never waits out the 8 s deadline: ${times.join(", ")} ms`);
  const after = loon.state();
  assert.ok(Object.keys(after.pairs).some((key) => key.includes("#")), "refusals are kept per address (file + signature)");
  assert.ok(everyMirror.every((host) => !(after.hosts[host].until > Date.now())), "no mirror is benched as a whole for it");
});

test("a push-back from one stream survives the other stream's concurrent step", async () => {
  await freshLoon(AUTO);
  await segmentPlayer({ proxyPort, url: mock.mediaUrl(AKAMAI, 1001, "v360", "iphone"), size: file("v360.m4s").length, segment: 1048576, stopAfterBytes: 1048576 });
  const state = loon.state();
  state.auto = { v: "seed.1", lvl: 3, at: Date.now() - 60000, why: "", trial: null, rest: {}, log: [], steps: 5 };
  writeState(state);
  // the mirrors the stream knows best take one connection at a time and say 429 to a second one;
  // the rest are slow to answer, so the run is still going when the other stream commits
  everyMirrorProfile({ latency: 400, rate: 120 * 1024 });
  for (const host of Object.keys(state.hosts)) mock.state.profiles[host] = { latency: 400, rate: 120 * 1024, limitConcurrent: 1 };
  const code = fs.readFileSync(SCRIPT, "utf8");
  const running = runLoonScript({ code, httpClientPort: mock.port, store: loon.store, timeoutMs: 30000, argument: loon.settings.argument, request: { url: mock.mediaUrl(AKAMAI, 1001, "v720", "iphone"), method: "GET", headers: { Range: "bytes=0-1048575", "User-Agent": "bili-universal/1" } } });
  // meanwhile the other stream steps up and commits first
  await new Promise((resolve) => setTimeout(resolve, 150));
  const other = loon.state();
  other.auto = { v: "other.1", lvl: 4, at: Date.now(), why: "App 等了 2.0 秒", trial: { from: 3, to: 4, at: Date.now(), base: 500, stalled: false }, rest: { 5: { until: Date.now() + 60000, hard: false } }, log: [{ t: Date.now(), n: 32, m: "App 等了 2.0 秒" }], steps: 6 };
  writeState(other);
  const reply = await running;
  const merged = loon.state().auto;
  assert.equal(reply.response?.status, 206, `the stream itself got its bytes from mirrors that still had room: ${JSON.stringify(loon.state().runs.at(-1))}`);
  assert.equal(LADDER[merged.lvl], 16, `the push-back (24 → 16) wins over the concurrent step to 32: ${JSON.stringify(merged)}`);
  assert.ok(merged.rest["3"] && merged.rest["3"].hard, "the refused level rests hard");
  assert.ok(merged.rest["5"], "the other stream's rest is kept too");
  assert.equal(merged.trial, null);
});
