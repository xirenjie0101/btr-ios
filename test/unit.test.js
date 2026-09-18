"use strict";
// Pure-logic tests: the modules are loaded into a bare VM context with just enough browser stubs.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");
const { segmentBase } = require("./lib/mp4boxes.js");

const ROOT = path.join(__dirname, "..");
const FILES = [
  "src/vendor-btr/range-core.js", "src/vendor-btr/cdn-resolver.js", "src/vendor-btr/sidx.js", "src/vendor-btr/idm-downloader.js",
  "src/app/engine.js", "src/app/api.js", "src/app/store.js"
];

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  windowsEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0"
};

function load({ userAgent = UA.iphone, supports = () => true, storage = new Map(), cookie = "" } = {}) {
  const sandbox = {
    navigator: { userAgent },
    location: { href: "https://www.bilibili.com/__btr__/", origin: "https://www.bilibili.com" },
    document: { cookie },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)); }
    },
    MediaSource: class { static isTypeSupported(type) { return supports(type); } },
    fetch: () => Promise.reject(new Error("no network in unit tests")),
    performance: { now: () => Date.now() },
    URL, URLSearchParams, DOMException, AbortController, setTimeout, clearTimeout, Uint8Array, console
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of FILES) vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), sandbox, { filename: file });
  return sandbox;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test("video input: ids, links, share text, short links", () => {
  const { parseVideoInput } = load().__BTRI_API__;
  assert.deepEqual(plain(parseVideoInput("BV1GJ411x7h7")), { bvid: "BV1GJ411x7h7", aid: 0, part: 1, time: 0, shortLink: "" });
  assert.deepEqual(plain(parseVideoInput("  https://www.bilibili.com/video/BV1GJ411x7h7/?p=3&t=95.5&vd_source=abc  ")), { bvid: "BV1GJ411x7h7", aid: 0, part: 3, time: 95.5, shortLink: "" });
  assert.deepEqual(plain(parseVideoInput("https://m.bilibili.com/video/av170001?t=1m30s")), { bvid: "", aid: 170001, part: 1, time: 90, shortLink: "" });
  assert.deepEqual(plain(parseVideoInput("av170001")), { bvid: "", aid: 170001, part: 1, time: 0, shortLink: "" });
  assert.deepEqual(plain(parseVideoInput("【标题带 BV 字样也没关系】 https://b23.tv/AbC123x")), { bvid: "", aid: 0, part: 1, time: 0, shortLink: "https://b23.tv/AbC123x" });
  assert.deepEqual(plain(parseVideoInput("https://www.bilibili.com/video/BV1GJ411x7h7?start_progress_ms=12500")).time, 12.5);
  // not videos
  for (const text of ["", "   ", "hello", "https://live.bilibili.com/123", "https://www.bilibili.com/bangumi/play/ep1", "java 8"]) {
    assert.equal(parseVideoInput(text), null, text);
  }
  // "av" inside a word is not an id
  assert.equal(parseVideoInput("https://example.com/navy123"), null);
});

test("time formats", () => {
  const { parseTime } = load().__BTRI_API__;
  assert.equal(parseTime("90"), 90);
  assert.equal(parseTime("1h2m3s"), 3723);
  assert.equal(parseTime("45s"), 45);
  assert.equal(parseTime("2m"), 120);
  assert.equal(parseTime("1500", true), 1.5);
  assert.equal(parseTime("soon"), 0);
  assert.equal(parseTime(null), 0);
});

test("login is read from the cookie the site itself sets", () => {
  assert.equal(load({ cookie: "buvid3=x; DedeUserID=12345; bili_jct=y" }).__BTRI_API__.isLoggedIn(), true);
  assert.equal(load({ cookie: "buvid3=x" }).__BTRI_API__.isLoggedIn(), false);
});

test("API errors come back as something a person can act on", async () => {
  const sandbox = load();
  const replies = {
    "/x/web-interface/view": { code: -404, message: "啥都木有" },
    "/x/player/playurl": { code: 0, data: { durl: [{ url: "https://example.invalid/a.mp4" }] } }
  };
  const api = sandbox.__BTRI_API__.createApi({ fetch: async (url) => ({ ok: true, status: 200, json: async () => replies[new URL(url).pathname] }) });
  await assert.rejects(() => api.view({ bvid: "BV1GJ411x7h7" }), /找不到这个视频/);
  await assert.rejects(() => api.playurl({ bvid: "BV1GJ411x7h7" }, 1), /没有 DASH 播放清单/);
  const offline = sandbox.__BTRI_API__.createApi({ fetch: async () => { throw new TypeError("Load failed"); } });
  await assert.rejects(() => offline.view({ bvid: "BV1GJ411x7h7" }), /连不上哔哩哔哩接口/);
  const blocked = sandbox.__BTRI_API__.createApi({ fetch: async () => ({ ok: false, status: 412, json: async () => ({}) }) });
  await assert.rejects(() => blocked.view({ bvid: "BV1GJ411x7h7" }), /HTTP 412/);
});

test("playurl request is the same one upstream sends", async () => {
  const sandbox = load();
  const seen = [];
  const api = sandbox.__BTRI_API__.createApi({
    fetch: async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => ({ code: 0, data: { dash: { video: [], audio: [] } } }) }; }
  });
  await api.playurl({ bvid: "BV1GJ411x7h7", aid: 1 }, 137649199);
  assert.equal(seen[0].url, "https://api.bilibili.com/x/player/playurl?bvid=BV1GJ411x7h7&cid=137649199&qn=127&fnval=4048&fnver=0&fourk=1");
  assert.equal(seen[0].init.credentials, "include");
});

test("settings survive bad input and storage failures", () => {
  const storage = new Map([["BTRI.settings", "{not json"]]);
  const sandbox = load({ storage });
  const store = sandbox.__BTRI_STORE__.createStore();
  assert.equal(store.get().concurrency, 8);
  assert.equal(store.get().mode, "mainland");
  store.update({ concurrency: 7, mode: "mars", codec: "vp9", maxAutoHeight: 123, droppedCodecs: ["hevc", "hevc", "mpeg2"] });
  assert.deepEqual(plain(store.get()), { ...plain(sandbox.__BTRI_STORE__.DEFAULTS), droppedCodecs: ["hevc"] });
  store.update({ concurrency: 32 });
  assert.equal(JSON.parse(storage.get("BTRI.settings")).concurrency, 32);
  // upstream's own normaliser must accept what we hand it
  const normalised = sandbox.__BILI_RANGE_CORE__.normalizeSettings(store.get());
  assert.equal(normalised.concurrency, 32);
  assert.equal(normalised.mode, "mainland");
  assert.equal(normalised.enabled, true);
});

test("history: resume position rules", () => {
  const store = load().__BTRI_STORE__.createStore();
  store.remember({ key: "BV1GJ411x7h7", title: "t", part: 2, parts: 3, time: 123.44, duration: 600 });
  assert.equal(store.recall("BV1GJ411x7h7", 2), 123.4);
  assert.equal(store.recall("BV1GJ411x7h7", 1), 0, "another part starts from the beginning");
  store.remember({ key: "BV1GJ411x7h7", part: 2, time: 597, duration: 600 });
  assert.equal(store.recall("BV1GJ411x7h7", 2), 0, "finished videos start over");
  store.remember({ key: "BV1GJ411x7h7", part: 2, time: 3, duration: 600 });
  assert.equal(store.recall("BV1GJ411x7h7", 2), 0, "a few seconds in is not worth resuming");
  assert.equal(store.history().length, 1);
  for (let index = 0; index < 60; index += 1) store.remember({ key: `av${index + 1}`, time: 10, duration: 100 });
  assert.equal(store.history().length, 50);
});

test("who counts as Apple WebKit", () => {
  assert.equal(load({ userAgent: UA.iphone }).__BTRI_ENGINE__.isAppleWebKit(), true);
  assert.equal(load({ userAgent: UA.iphoneChrome }).__BTRI_ENGINE__.isAppleWebKit(), true, "Chrome on iOS is WebKit underneath");
  assert.equal(load({ userAgent: UA.ipad }).__BTRI_ENGINE__.isAppleWebKit(), true, "iPadOS calls itself a Mac");
  assert.equal(load({ userAgent: UA.macChrome }).__BTRI_ENGINE__.isAppleWebKit(), false);
  assert.equal(load({ userAgent: UA.windowsEdge }).__BTRI_ENGINE__.isAppleWebKit(), false);
});

const representation = (id, codecs, height, bandwidth) => ({ id, codecs, height, width: Math.round(height * 16 / 9), bandwidth, mimeType: "video/mp4", frameRate: "30", baseUrl: `https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/1/2/3/3-1-${id}${codecs.slice(0, 4)}.m4s?x=1` });
const playinfo = {
  data: {
    quality: 120,
    dash: {
      duration: 100,
      video: [
        representation(120, "hev1.2.4.L153.90", 2160, 12e6), representation(120, "av01.0.12M.10.0.110.01.01.01.0", 2160, 9e6),
        representation(80, "avc1.640032", 1080, 3e6), representation(80, "hev1.1.6.L150.90", 1080, 1.6e6), representation(80, "av01.0.08M.08.0.110.01.01.01.0", 1080, 1.4e6),
        representation(32, "avc1.64001F", 480, 6e5), representation(32, "hev1.1.6.L120.90", 480, 3e5)
      ],
      audio: [{ id: 30280, codecs: "mp4a.40.2", bandwidth: 192000, mimeType: "audio/mp4" }, { id: 30216, codecs: "mp4a.40.2", bandwidth: 64000, mimeType: "audio/mp4" }]
    }
  }
};

test("codec choice on an iPhone without AV1 hardware: AVC first, HEVC only where nothing else exists, asked for as hvc1", () => {
  const asked = [];
  const sandbox = load({ userAgent: UA.iphone, supports: (type) => { asked.push(type); return !/av01/.test(type) && !/hev1/.test(type); } });
  const engine = sandbox.__BTRI_ENGINE__;
  const selector = engine.createSelector({ ctor: sandbox.MediaSource, managed: false });
  const selection = selector.select(playinfo, "auto");
  assert.deepEqual(plain(selection.videos.map((item) => [item.id, item.codecs.slice(0, 4)])), [[120, "hev1"], [80, "avc1"], [32, "avc1"]]);
  assert.ok(asked.includes('video/mp4; codecs="hvc1.1.6.L150.90"'), "HEVC support is asked about under the Apple label");
  assert.ok(!asked.some((type) => /hev1/.test(type)));
  assert.equal(selection.audio.id, 30280, "best audio");
  assert.equal(selector.pick(selection, 0, 1080).id, 80, "automatic: best quality up to 1080P");
  assert.equal(selector.pick(selection, 0, 4320).id, 120);
  assert.equal(selector.pick(selection, 64, 1080).id, 32, "a quality that is not offered falls to the next one below");
  assert.equal(selector.pick(selection, 6, 1080).id, 32, "…or to the lowest there is");
  assert.equal(selector.playableMime(selection.videos[0], "video"), 'video/mp4; codecs="hvc1.2.4.L153.90"');
  assert.equal(selector.relabelsInit(selection.videos[0]), true);
  assert.equal(selector.relabelsInit(selection.videos[1]), false);
  // asking for HEVC by name
  assert.deepEqual(plain(selector.select(playinfo, "hevc").videos.map((item) => item.codecs.slice(0, 4))), ["hev1", "hev1", "hev1"]);
});

test("codec choice elsewhere keeps upstream's order and leaves hev1 alone", () => {
  const sandbox = load({ userAgent: UA.windowsEdge });
  const selector = sandbox.__BTRI_ENGINE__.createSelector({ ctor: sandbox.MediaSource, managed: false });
  const selection = selector.select(playinfo, "auto");
  assert.deepEqual(plain(selection.videos.map((item) => item.codecs.slice(0, 4))), ["av01", "av01", "hev1"]);
  assert.equal(selector.playableMime(selection.videos[2], "video"), 'video/mp4; codecs="hev1.1.6.L120.90"');
  assert.equal(selector.relabelsInit(selection.videos[2]), false);
});

test("a codec family that failed stays out — until it is asked for by name", () => {
  const sandbox = load({ userAgent: UA.iphone });
  const selector = sandbox.__BTRI_ENGINE__.createSelector({ ctor: sandbox.MediaSource, managed: false }, ["av1", "bogus"]);
  assert.deepEqual(plain(selector.droppedFamilies()), ["av1"]);
  assert.deepEqual(plain(selector.select(playinfo, "auto").videos.map((item) => item.codecs.slice(0, 4))), ["hev1", "avc1", "avc1"]);
  assert.deepEqual(plain(selector.select(playinfo, "av1").videos.map((item) => item.codecs.slice(0, 4))), ["av01", "av01", "avc1"]);
  selector.dropFamily("avc");
  selector.dropFamily("hevc");
  assert.equal(selector.select(playinfo, "auto").videos.length, 3, "with everything written off, everything is back on the table");
});

test("nothing playable, no DASH: clear errors", () => {
  const sandbox = load({ supports: () => false });
  const selector = sandbox.__BTRI_ENGINE__.createSelector({ ctor: sandbox.MediaSource, managed: false });
  assert.throws(() => selector.select(playinfo), /不支持清单里的任何视频编码/);
  assert.throws(() => selector.select({ data: { durl: [] } }), /没有 DASH 播放清单/);
});

test("Akamai-only play lists get one ordinary-host address to build the mainland routes from", () => {
  const sandbox = load();
  const { withDonorUrl } = sandbox.__BTRI_ENGINE__;
  const akamai = "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/1/2/3/3-1-100026.m4s?e=abc&upsig=def&hdnts=exp%3D1~hmac%3Dx";
  const donor = withDonorUrl({ baseUrl: akamai, backupUrl: [] });
  assert.deepEqual(plain(donor.backupUrl), ["https://upos-sz-mirrorali.bilivideo.com/upgcxcode/1/2/3/3-1-100026.m4s?e=abc&upsig=def"]);
  const urls = sandbox.__BILI_CDN_RESOLVER_FACTORY__.representationUrls(donor, "mainland");
  assert.equal(urls.length, 8);
  assert.ok(urls.every((url) => /^https:\/\/upos-sz-[a-z0-9]+\.bilivideo\.com\/upgcxcode\/1\/2\/3\/3-1-100026\.m4s\?e=abc&upsig=def$/.test(url)));
  // untouched when an ordinary address is already there, or when it is not a Bilibili media URL at all
  const normal = { baseUrl: akamai, backupUrl: ["https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/1/2/3/3-1-100026.m4s?e=abc"] };
  assert.equal(withDonorUrl(normal), normal);
  const foreign = { baseUrl: "https://example.com/video.m4s" };
  assert.equal(withDonorUrl(foreign), foreign);
});

test("hev1 → hvc1: four bytes of the initialisation segment, and the result is still a sound HEVC stream", () => {
  const { relabelSampleEntryForApple, appleCodecString } = load().__BTRI_ENGINE__;
  assert.equal(appleCodecString("hev1.1.6.L120.90"), "hvc1.1.6.L120.90");
  assert.equal(appleCodecString("dvhe.08.07"), "dvh1.08.07");
  assert.equal(appleCodecString("avc1.640028"), "avc1.640028");
  assert.equal(appleCodecString("hvc1.1.6.L120.90"), "hvc1.1.6.L120.90");

  const file = path.join(__dirname, "media", "hevc_hev1.m4s");
  const original = fs.readFileSync(file);
  const initEnd = Number(segmentBase(file).initialization.split("-")[1]);
  const init = new Uint8Array(original.subarray(0, initEnd + 1));
  const patched = relabelSampleEntryForApple(init);
  assert.notEqual(patched, init, "a copy, the downloaded bytes are left alone");
  assert.equal(patched.length, init.length);
  const changed = [];
  for (let index = 0; index < init.length; index += 1) if (init[index] !== patched[index]) changed.push(index);
  assert.equal(changed.length, 2, "hev1 and hvc1 differ in two letters");
  assert.equal(Buffer.from(patched.subarray(changed[0] - 1, changed[0] + 3)).toString("latin1"), "hvc1");
  assert.equal(Buffer.from(init.subarray(changed[0] - 1, changed[0] + 3)).toString("latin1"), "hev1");

  // ffmpeg must read the relabelled stream as hvc1 and decode every frame of it
  const rebuilt = path.join(os.tmpdir(), `btri-hvc1-${process.pid}.mp4`);
  fs.writeFileSync(rebuilt, Buffer.concat([Buffer.from(patched), original.subarray(initEnd + 1)]));
  try {
    const probe = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=codec_name,codec_tag_string,nb_read_frames", "-of", "csv=p=0", rebuilt]).toString().trim();
    assert.equal(probe, "hevc,hvc1,250");
  } finally {
    fs.rmSync(rebuilt, { force: true });
  }

  // other codecs and odd input pass through untouched
  const vp9 = new Uint8Array(fs.readFileSync(path.join(__dirname, "media", "v360.m4s")).subarray(0, 775));
  assert.equal(relabelSampleEntryForApple(vp9), vp9);
  const junk = new Uint8Array([0, 0, 0, 1, 2, 3]);
  assert.equal(relabelSampleEntryForApple(junk), junk);
  assert.equal(relabelSampleEntryForApple(new Uint8Array(0)).length, 0);
});

test("buffered-run arithmetic tolerates the frame-sized gaps between fragments", () => {
  const { bufferedEndAt } = load().__BTRI_ENGINE__;
  const ranges = (list) => ({ buffered: { length: list.length, start: (index) => list[index][0], end: (index) => list[index][1] } });
  assert.equal(bufferedEndAt(ranges([[0, 5], [5.04, 10], [10.1, 15]]), 2), 15);
  assert.equal(bufferedEndAt(ranges([[0, 5], [6, 10]]), 2), 5, "a real hole ends the run");
  assert.equal(bufferedEndAt(ranges([[0, 5], [6, 10]]), 7), 10);
  assert.equal(bufferedEndAt(ranges([[3, 5]]), 0), 0, "nothing under the play head");
  assert.equal(bufferedEndAt({ get buffered() { throw new Error("removed"); } }, 4), 4, "a removed SourceBuffer throws on .buffered");
});
