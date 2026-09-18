"use strict";
// Exercises dist/btr-loon.js inside the Loon runtime emulator (no browser involved).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { runLoonScript } = require("./lib/loon-vm.js");
const { createMock } = require("./mock/server.js");

const code = fs.readFileSync(path.join(__dirname, "..", "dist", "btr-loon.js"), "utf8");
const PORT = 18451;
const mock = createMock({ port: PORT });
const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const run = (request, response) => runLoonScript({ code, request, response, httpClientPort: PORT });
// $done({}) — "leave the request alone". (The object comes from another realm, so compare by shape.)
const assertPassThrough = (result, message) => {
  assert.ok(result && typeof result === "object" && Object.keys(result).length === 0, message || `expected pass-through, got ${JSON.stringify(result)}`);
};
const navigation = (url, extra = {}) => ({ url, method: "GET", headers: { "User-Agent": SAFARI, Accept: "text/html,application/xhtml+xml", "Sec-Fetch-Dest": "document", ...extra } });

test.before(() => mock.start());
test.after(() => mock.stop());

test("serves the player page at /__btr__/", async () => {
  for (const url of ["https://www.bilibili.com/__btr__/", "https://www.bilibili.com/__btr__/index.html", "https://www.bilibili.com/__btr__/?from=homescreen", "https://m.bilibili.com/__btr__/"]) {
    const result = await run(navigation(url));
    assert.equal(result.response.status, 200);
    assert.match(result.response.headers["Content-Type"], /text\/html/);
    assert.equal(result.response.headers["Cache-Control"], "no-store");
    const html = result.response.body;
    assert.ok(html.startsWith("<!doctype html>"));
    assert.match(html, /<title>BTR 线程撕裂者 iOS<\/title>/);
    assert.match(html, /__BTRI_CONTEXT__ = \{"mode":"page","helperBase":"\/__btr__\/"\}/);
    assert.match(html, /const __BTRI_VERSION__ = "\d+\.\d+\.\d+";/, "the bundle's own constant must survive the build's token replacement");
    // exactly one closing script tag: nothing inside the inline bundle may end the element early
    assert.equal(html.split("</script>").length - 1, 1);
  }
});

test("the embedded page script is valid JavaScript", async () => {
  const result = await run(navigation("https://www.bilibili.com/__btr__/"));
  const script = /<script>\n([\s\S]*)\n<\/script>/.exec(result.response.body)[1];
  assert.doesNotThrow(() => new Function(script));
});

test("ping, icon and unknown helper routes", async () => {
  const ping = await run(navigation("https://www.bilibili.com/__btr__/ping"));
  assert.deepEqual(JSON.parse(ping.response.body).ok, true);
  const icon = await run(navigation("https://www.bilibili.com/__btr__/icon.png"));
  assert.equal(icon.response.headers["Content-Type"], "image/png");
  const bytes = Buffer.from(icon.response.body);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
  assert.deepEqual([...bytes.subarray(-8)], [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82], "PNG IEND: base64 decoded to the last byte");
  assert.equal(bytes.length, fs.statSync(path.join(__dirname, "..", "src", "loon", "icon-180.png")).size);
  const missing = await run(navigation("https://www.bilibili.com/__btr__/nope"));
  assert.equal(missing.response.status, 404);
});

test("fetches the comment file for the page (it has no CORS headers of its own)", async () => {
  const ok = await run(navigation("https://www.bilibili.com/__btr__/dm?cid=1001"));
  assert.equal(ok.response.status, 200);
  assert.match(ok.response.headers["Content-Type"], /text\/xml/);
  assert.match(ok.response.body, /<chatid>1001<\/chatid>/);
  for (const bad of ["", "abc", "0", "12;rm", "../1001"]) {
    const result = await run(navigation(`https://www.bilibili.com/__btr__/dm?cid=${encodeURIComponent(bad)}`));
    assert.equal(result.response.status, 400, bad);
  }
});

test("app probe: counts Range styles, never touches the request, reports every 25", async () => {
  const probe = fs.readFileSync(path.join(__dirname, "..", "dist", "extras", "btr-app-probe.js"), "utf8");
  const store = new Map();
  const app = "bili-universal/80300100 CFNetwork/1568.200.51 Darwin/24.1.0 os/ios model/iPhone 15 Pro";
  const send = (range, url = "http://upos-sz-mirrorcos.bilivideo.com/upgcxcode/01/20/1001/1001-1-100026.m4s?e=x") =>
    runLoonScript({ code: probe, store, request: { url, method: "GET", headers: range === null ? { "User-Agent": app } : { "User-Agent": app, range } } });
  let last;
  for (let index = 0; index < 20; index += 1) last = await send(`bytes=${index * 1048576}-${(index + 1) * 1048576 - 1}`);
  for (let index = 0; index < 3; index += 1) last = await send("bytes=4096-", "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/01/20/1001/1001-1-30280.m4s?e=x");
  last = await send(null);
  assertPassThrough(last, "requests go through untouched");
  assert.equal(last.__logs.some((line) => line.startsWith("notify:")), false, "quiet until the 25th");
  last = await send("bytes=0-0,5-9");
  assertPassThrough(last);
  const note = last.__logs.find((line) => line.startsWith("notify:"));
  assert.match(note, /已记录 25 个取流请求/);
  assert.match(note, /有结束位置的 Range：20 个（最小 1\.0 MB \/ 中位 1\.0 MB \/ 最大 1\.0 MB）/);
  assert.match(note, /开放式 Range（bytes=a-）：3 个/);
  assert.match(note, /没有 Range：1 个；其他写法：1 个/);
  assert.match(note, /客户端：bili-universal\/80300100 CFNetwork/);
  assert.match(note, /http×22/);
  assert.match(note, /https×3/);
  const record = JSON.parse(store.get("btr_ios_app_probe_v1"));
  assert.deepEqual(record.hosts, { "upos-sz-mirrorcos.bilivideo.com": 22, "upos-hz-mirrorakam.akamaized.net": 3 });
  // a corrupted record starts over instead of breaking playback
  store.set("btr_ios_app_probe_v1", "{oops");
  assertPassThrough(await send("bytes=0-99"));
  assert.equal(JSON.parse(store.get("btr_ios_app_probe_v1")).count, 1);
});

test("resolves b23.tv short links, also through a second hop", async () => {
  const direct = await run(navigation(`https://www.bilibili.com/__btr__/resolve?u=${encodeURIComponent("https://b23.tv/btrP2")}`));
  assert.equal(direct.response.status, 200);
  assert.equal(JSON.parse(direct.response.body).url, "https://www.bilibili.com/video/BV1btrTEST02?p=2&share_source=copy_web");
  const hop = await run(navigation(`https://www.bilibili.com/__btr__/resolve?u=${encodeURIComponent("http://b23.tv/btrHop")}`));
  assert.equal(JSON.parse(hop.response.body).url, "https://www.bilibili.com/video/BV1btrTEST02?p=2&share_source=copy_web");
});

test("refuses to resolve anything that is not a short link", async () => {
  for (const bad of ["https://evil.example/x", "https://b23.tv.evil.example/x", "file:///etc/passwd", ""]) {
    const result = await run(navigation(`https://www.bilibili.com/__btr__/resolve?u=${encodeURIComponent(bad)}`));
    assert.equal(result.response.status, 502, bad);
    assert.ok(JSON.parse(result.response.body).error);
  }
  const unknown = await run(navigation(`https://www.bilibili.com/__btr__/resolve?u=${encodeURIComponent("https://b23.tv/doesNotExist")}`));
  assert.equal(unknown.response.status, 502);
});

test("redirects video page navigations to the player, and nothing else", async () => {
  const hit = await run(navigation("https://m.bilibili.com/video/BV1btrTEST02?p=2&t=1m5s&share_source=copy_web"));
  assert.equal(hit.response.status, 302);
  assert.equal(hit.response.headers.Location, "https://www.bilibili.com/__btr__/#/v/BV1btrTEST02?p=2&t=1m5s");
  const av = await run(navigation("https://www.bilibili.com/video/av900001/"));
  assert.equal(av.response.headers.Location, "https://www.bilibili.com/__btr__/#/v/av900001");
  // opt-out parameter, sub-resources, non-GET and other paths pass through untouched
  assertPassThrough(await run(navigation("https://www.bilibili.com/video/BV1btrTEST01?btr=0")));
  assertPassThrough(await run({ url: "https://m.bilibili.com/video/BV1btrTEST01", method: "GET", headers: { Accept: "application/json", "Sec-Fetch-Dest": "empty" } }));
  assertPassThrough(await run({ ...navigation("https://m.bilibili.com/video/BV1btrTEST01"), method: "POST" }));
  assertPassThrough(await run(navigation("https://m.bilibili.com/bangumi/play/ep1")));
  // old Safari without Sec-Fetch-Dest: fall back to Accept
  const legacy = await run({ url: "https://m.bilibili.com/video/BV1btrTEST01", method: "GET", headers: { accept: "text/html,*/*" } });
  assert.equal(legacy.response.status, 302);
});

test("adds the button to HTML video pages only, once, and drops the CSP header", async () => {
  const request = navigation("https://m.bilibili.com/video/BV1btrTEST01");
  const page = "<!doctype html><html><head><title>x</title></head><body><div id=app></div></body></html>";
  const result = await run(request, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "content-security-policy": "script-src 'self'", "X-Keep": "1" }, body: page });
  assert.ok(result.body.includes("__BTRI_LOON_BUTTON__"));
  assert.ok(result.body.indexOf("<script>") < result.body.indexOf("</body>"), "inserted before </body>");
  assert.equal(result.body.split("</body>").length - 1, 1);
  assert.equal(result.headers["X-Keep"], "1");
  assert.ok(!Object.keys(result.headers).some((key) => /content-security-policy/i.test(key)));
  // the injected code must parse
  const injected = /<script>([\s\S]*?)<\/script>/.exec(result.body)[1];
  assert.doesNotThrow(() => new Function(injected));
  // second pass: already there
  assertPassThrough(await run(request, { status: 200, headers: { "Content-Type": "text/html" }, body: result.body }));
  // not HTML, not 200, binary body
  assertPassThrough(await run(request, { status: 200, headers: { "Content-Type": "application/json" }, body: "{}" }));
  assertPassThrough(await run(request, { status: 302, headers: { "Content-Type": "text/html" }, body: "" }));
  assertPassThrough(await run(request, { status: 200, headers: { "Content-Type": "text/html" }, body: new Uint8Array([60, 104]) }));
  // no </body>: appended at the end
  const bare = await run(request, { status: 200, headers: { "content-type": "text/html" }, body: "<p>hi" });
  assert.ok(bare.body.startsWith("<p>hi<script>"));
});
