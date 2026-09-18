"use strict";
// The player page as the Loon plugin serves it, driven in a real browser (plain MediaSource path:
// what iPad and Mac Safari use).
const test = require("node:test");
const assert = require("node:assert/strict");
const { createMock } = require("./mock/server.js");
const { launch, inApp, waitFor, saveArtifact } = require("./lib/browser.js");

const mock = createMock({ port: 18470 });
const PLAYER = "https://www.bilibili.com/__btr__/";
let browser;

test.before(async () => { await mock.start(); });
test.after(async () => { await browser?.close(); await mock.stop(); });

async function freshPage(options = {}) {
  await browser?.close();
  mock.resetStats();
  mock.resetProfiles();
  mock.state.requireLogin = false;
  const session = await launch({ port: mock.port, ...options });
  browser = session.browser;
  return session;
}

async function tap(page) {
  await page.locator("#__btri_root__ .veil.tap").click();
}

async function playing(page, beyond, timeout = 40000) {
  return waitFor(async () => {
    const video = await inApp.video(page);
    return video.currentTime > beyond && !video.paused ? video : null;
  }, { timeout, message: `playback beyond ${beyond} s` });
}

async function failWithLogs(page, name, error) {
  try { saveArtifact(`${name}.png`, await page.screenshot({ fullPage: true })); } catch (_error) {}
  try { saveArtifact(`${name}.log.txt`, await inApp.logs(page)); } catch (_error) {}
  throw error;
}

const mainlandBytes = () => Object.entries(mock.stats.hosts)
  .filter(([host]) => /^upos-sz-(?:mirror(?:ali|hw|bos|08c|bd|14b|cos)|estgoss)\.bilivideo\.com$/.test(host))
  .filter(([, item]) => item.bytes > 0);

test("buffers before the tap, plays after it, and pulls pieces from several mainland mirrors at once", async () => {
  const { page } = await freshPage();
  try {
    await page.goto(`${PLAYER}#/v/BV1btrTEST01`);
    await waitFor(async () => (await inApp.veil(page)).tap, { message: "tap-to-play veil" });
    // Without a user gesture nothing may play, but the buffer should already be filling.
    await waitFor(async () => (await inApp.video(page)).buffered.length > 0, { message: "pre-buffering before the tap" });
    assert.equal((await inApp.video(page)).paused, true);
    await tap(page);
    const video = await playing(page, 3);
    assert.equal(video.width, 1280);
    assert.equal(video.height, 720);
    assert.equal((await inApp.veil(page)).hidden, true, "veil gone while playing");
    await new Promise((resolve) => setTimeout(resolve, 4000));
    assert.ok(mock.stats.maxConcurrent >= 6, `expected parallel connections, saw ${mock.stats.maxConcurrent}`);
    assert.ok(mainlandBytes().length >= 3, `expected ≥3 mainland mirrors to deliver data, saw ${mainlandBytes().map(([host]) => host)}`);
    assert.equal(mock.stats.refererFailures, 0, "every media request carried a bilibili.com Referer");
    assert.equal(mock.stats.signatureFailures, 0, "host swapping kept path and signature intact");
    const debug = await inApp.debug(page);
    assert.equal(debug.engine.managed, false);
    assert.ok(debug.engine.bannedHosts.includes("upos-sz-mirror14b.bilivideo.com"), "a mirror that only answers 403 gets benched");
    // Pieces are distinct byte ranges, not the same bytes fetched many times over.
    const videoRanges = mock.stats.ranges.filter((range) => range.key === "v720" && range.end - range.start > 4096);
    const total = videoRanges.reduce((sum, range) => sum + range.end - range.start + 1, 0);
    const covered = new Set();
    for (const range of videoRanges) covered.add(`${range.start}-${range.end}`);
    assert.ok(covered.size >= videoRanges.length * 0.6, "most ranges are requested once (the rest are hedged duplicates)");
    assert.ok(total > 0);
  } catch (error) { await failWithLogs(page, "player-basic", error); }
});

test("aggregate throughput is several times what one connection to the same mirrors gives", async () => {
  const { page } = await freshPage();
  try {
    await page.goto(`${PLAYER}#/v/BV1btrTEST01`);
    await tap(page);
    await playing(page, 1);
    const bytesNow = () => Object.values(mock.stats.hosts).reduce((sum, item) => sum + item.bytes, 0);
    const before = bytesNow();
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const rate = (bytesNow() - before) / 8;
    const single = 120 * 1024; // what the mock allows per connection on mainland mirrors
    assert.ok(rate > single * 3, `aggregate ${(rate / 1024).toFixed(0)} KiB/s should be > 3× a single connection (${single / 1024} KiB/s)`);
    // The stream needs ~288 KiB/s. One connection could not keep up; the buffer must be growing.
    const debug = await inApp.debug(page);
    const video = await inApp.video(page);
    assert.ok(video.buffered.at(-1)[1] - video.currentTime > 8, `buffer ahead should grow, got ${JSON.stringify(video.buffered)} at ${video.currentTime}`);
    assert.equal(debug.engine.startupWaitingEvents, 0, "no stall after start");
  } catch (error) { await failWithLogs(page, "player-throughput", error); }
});

test("seeking into unbuffered territory rebuilds the buffer there", async () => {
  const { page } = await freshPage();
  try {
    await page.goto(`${PLAYER}#/v/BV1btrTEST01`);
    await tap(page);
    await playing(page, 2);
    await page.evaluate(() => { document.querySelector("#__btri_root__").shadowRoot.querySelector("video").currentTime = 61; });
    const video = await playing(page, 63);
    assert.ok(video.currentTime < 75, "continued from the seek target");
    const debug = await inApp.debug(page);
    assert.equal(debug.engine.seekReloads, 1);
    // a seek inside the buffer must not rebuild anything
    await page.evaluate(() => { const v = document.querySelector("#__btri_root__").shadowRoot.querySelector("video"); v.currentTime = v.currentTime + 2; });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal((await inApp.debug(page)).engine.seekReloads, 1);
  } catch (error) { await failWithLogs(page, "player-seek", error); }
});

test("switching quality keeps the position; the choice is remembered", async () => {
  const { page } = await freshPage();
  try {
    await page.goto(`${PLAYER}#/v/BV1btrTEST01`);
    await tap(page);
    const before = await playing(page, 6);
    const options = await page.locator("#__btri_root__ select[aria-label='清晰度'] option").allTextContents();
    assert.deepEqual(options.map((text) => text.split(" ")[0]), ["自动（不超过", "720P", "360P"]);
    await page.locator("#__btri_root__ select[aria-label='清晰度']").selectOption("16");
    const after = await waitFor(async () => {
      const video = await inApp.video(page);
      return video.height === 360 && !video.paused && video.currentTime > before.currentTime ? video : null;
    }, { timeout: 30000, message: "360P playing" });
    assert.ok(after.currentTime - before.currentTime < 25, "did not start over or jump far ahead");
    assert.equal((await inApp.debug(page)).settings.qualityId, 16);
    await page.reload();
    await tap(page);
    await playing(page, 1);
    assert.equal((await inApp.video(page)).height, 360, "remembered after reload");
  } catch (error) { await failWithLogs(page, "player-quality", error); }
});

test("plays through to the end, then moves on to the next part by itself", async () => {
  const { page } = await freshPage();
  try {
    await page.goto(`${PLAYER}#/v/BV1btrTEST02`);
    await tap(page);
    await playing(page, 1);
    assert.equal(await page.locator("#__btri_root__ select[aria-label='分 P']").inputValue(), "0");
    await page.evaluate(() => { document.querySelector("#__btri_root__").shadowRoot.querySelector("video").currentTime = 85; });
    // part 2 starts: part select flips and the clock is near the beginning again
    await waitFor(async () => (await page.locator("#__btri_root__ select[aria-label='分 P']").inputValue()) === "1", { timeout: 45000, message: "part 2 selected" });
    const video = await playing(page, 1);
    assert.ok(video.currentTime < 30);
    assert.equal(new URL(page.url()).hash, "#/v/BV1btrTEST02?p=2");
    // and a single-part video simply ends
    await page.goto(`${PLAYER}#/v/BV1btrTEST01`);
    await page.reload();
    await tap(page);
    await playing(page, 1);
    await page.evaluate(() => { document.querySelector("#__btri_root__").shadowRoot.querySelector("video").currentTime = 86; });
    await waitFor(async () => (await inApp.video(page)).ended, { timeout: 40000, message: "ended" });
    assert.equal((await inApp.debug(page)).state, "ended");
  } catch (error) { await failWithLogs(page, "player-end", error); }
});

test("opens what people actually paste: share text with a b23.tv short link", async () => {
  const { page } = await freshPage();
  try {
    await page.goto(PLAYER);
    await page.locator("#__btri_root__ input[type=url]").fill("【BTR-iOS 测试视频 · 多 P】 https://b23.tv/btrP2");
    await page.locator("#__btri_root__ button.primary").click();
    // The click was the user gesture, so no second tap is needed.
    await playing(page, 1);
    assert.equal(new URL(page.url()).hash, "#/v/BV1btrTEST02?p=2");
    assert.equal(await page.locator("#__btri_root__ select[aria-label='分 P']").inputValue(), "1");
    assert.match(await page.locator("#__btri_root__ .title").textContent(), /多 P/);
    // a short link that is not a video gives a readable error instead of hanging
    await page.goto(PLAYER);
    await page.reload();
    await page.locator("#__btri_root__ input[type=url]").fill("https://b23.tv/btrLive");
    await page.locator("#__btri_root__ button.primary").click();
    await waitFor(async () => /不是视频链接/.test((await inApp.veil(page)).note), { message: "error for a non-video short link" });
    // garbage input is rejected before anything is loaded
    await page.locator("#__btri_root__ button:has-text('返回')").click();
    await page.locator("#__btri_root__ input[type=url]").fill("hello world");
    await page.locator("#__btri_root__ button.primary").click();
    assert.match(await page.locator("#__btri_root__ .open ~ .hint.bad").textContent(), /没认出视频/);
  } catch (error) { await failWithLogs(page, "player-shortlink", error); }
});

test("a play list with nothing but Akamai addresses still reaches the mainland mirrors", async () => {
  const { page } = await freshPage();
  try {
    await page.goto(`${PLAYER}#/v/BV1btrAKAM03`);
    await tap(page);
    await playing(page, 3);
    assert.ok(mainlandBytes().length >= 3, `mainland mirrors used: ${mainlandBytes().map(([host]) => host)}`);
    assert.equal(mock.stats.signatureFailures, 0);
  } catch (error) { await failWithLogs(page, "player-akamai-only", error); }
});

test("unknown video: a readable error and a retry button, no spinner for ever", async () => {
  const { page } = await freshPage();
  try {
    await page.goto(`${PLAYER}#/v/BV1btrNOPE04`);
    await waitFor(async () => /找不到这个视频/.test((await inApp.veil(page)).note), { message: "error text" });
    assert.equal(await page.locator("#__btri_root__ .veil button:has-text('重试')").isVisible(), true);
    assert.equal(await page.locator("#__btri_root__ .veil button:has-text('www.bilibili.com')").isVisible(), false, "already on the www host");
    assert.equal(await page.locator("#__btri_root__ .veil .spin").isVisible(), false);
  } catch (error) { await failWithLogs(page, "player-error", error); }
});

test("history remembers where you were and resumes there", async () => {
  const { page } = await freshPage();
  try {
    await page.goto(`${PLAYER}#/v/BV1btrTEST01`);
    await tap(page);
    await playing(page, 9);
    await page.locator("#__btri_root__ button:has-text('返回')").click();
    await waitFor(async () => new URL(page.url()).hash === "#/", { message: "home route" });
    const item = page.locator("#__btri_root__ .history button.item");
    await waitFor(async () => (await item.count()) === 1, { message: "history entry" });
    assert.match(await item.textContent(), /单 P/);
    assert.match(await item.textContent(), /看到 0:\d\d/);
    assert.equal((await inApp.video(page)).srcAttribute, "", "playback stopped when leaving");
    await item.click();
    const video = await playing(page, 8.5);
    assert.ok(video.currentTime < 40, `resumed near the saved position, at ${video.currentTime}`);
    assert.equal((await inApp.debug(page)).engine.sessionStartTime > 5, true);
    // removing the entry
    await page.locator("#__btri_root__ button:has-text('返回')").click();
    await page.locator("#__btri_root__ .history button.del").click();
    assert.equal(await page.locator("#__btri_root__ .history button.item").count(), 0);
  } catch (error) { await failWithLogs(page, "player-history", error); }
});

test("settings stick, and the CDN mode really changes where the bytes come from", async () => {
  const { page } = await freshPage();
  try {
    await page.goto(PLAYER);
    await page.locator("#__btri_root__ .seg[aria-label='并发线程'] button:has-text('32')").click();
    await page.locator("#__btri_root__ .seg[aria-label='CDN 模式'] button:has-text('海外 CDN')").click();
    await page.reload();
    assert.equal(await page.locator("#__btri_root__ .seg[aria-label='并发线程'] button[aria-pressed=true]").textContent(), "32");
    assert.equal(await page.locator("#__btri_root__ .seg[aria-label='CDN 模式'] button[aria-pressed=true]").textContent(), "海外 CDN");
    mock.resetStats();
    await page.goto(`${PLAYER}#/v/BV1btrTEST01`);
    await tap(page);
    await playing(page, 2, 60000);
    const overseas = Object.entries(mock.stats.hosts).filter(([host, item]) => /ov\.bilivideo\.com$|^cn-hk-eq-/.test(host) && item.bytes > 0);
    assert.ok(overseas.length >= 2, `overseas mirrors used: ${overseas.map(([host]) => host)}`);
    assert.equal(mainlandBytes().length, 0, "no mainland mirror in overseas mode");
  } catch (error) { await failWithLogs(page, "player-settings", error); }
});

test("the account's cookies go along to the API (higher qualities need the login)", async () => {
  const { page, context } = await freshPage();
  try {
    mock.state.requireLogin = true;
    await page.goto(`${PLAYER}#/v/BV1btrTEST01`);
    await waitFor(async () => (await page.locator("#__btri_root__ select[aria-label='清晰度'] option").count()) >= 2, { message: "quality list" });
    assert.deepEqual((await page.locator("#__btri_root__ select[aria-label='清晰度'] option").allTextContents()).slice(1).map((text) => text.split(" ")[0]), ["360P"]);
    await context.addCookies([
      { name: "SESSDATA", value: "mock-session", domain: ".bilibili.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
      { name: "DedeUserID", value: "42", domain: ".bilibili.com", path: "/", secure: true, sameSite: "Lax" }
    ]);
    await page.reload();
    await waitFor(async () => (await page.locator("#__btri_root__ select[aria-label='清晰度'] option").count()) >= 3, { message: "quality list with login" });
    assert.ok(mock.stats.apiCalls.some((call) => call.path === "/x/player/playurl" && /SESSDATA=mock-session/.test(call.cookie)));
    assert.ok(mock.stats.apiCalls.every((call) => call.origin === "https://www.bilibili.com"));
    await page.goto(PLAYER);
    await page.reload();
    assert.equal(await page.locator("#__btri_root__ section:has-text('还没有登录')").isVisible(), false, "login hint hidden when the login cookie is there");
  } catch (error) { await failWithLogs(page, "player-login", error); }
});

test("danmaku: shown in time with the video, frozen on pause, skipped when scripted, off on request", async () => {
  const { page } = await freshPage();
  try {
    const items = () => page.evaluate(() => Array.from(document.querySelector("#__btri_root__").shadowRoot.querySelectorAll(".dm-item")).map((node) => ({
      text: node.textContent, x: node.getBoundingClientRect().x, top: node.getBoundingClientRect().top
    })));
    await page.goto(`${PLAYER}#/v/BV1btrTEST01`);
    await tap(page);
    await playing(page, 3);
    const shown = await waitFor(async () => { const list = await items(); return list.length >= 5 ? list : null; }, { message: "comments on screen" });
    assert.ok(shown.every((item) => !/高级弹幕/.test(item.text)), "scripted comments are left out");
    assert.ok(shown.some((item) => /^第\d+条 cid1001 <弹幕>$/.test(item.text)), `XML entities decoded: ${shown.map((item) => item.text).slice(0, 3)}`);
    assert.ok(shown.some((item) => /^顶部\d+$/.test(item.text)) || shown.some((item) => /^底部\d+$/.test(item.text)), "fixed comments too");
    // bottom comments sit at the bottom of the picture, top ones at the top
    const stageBox = await page.evaluate(() => { const box = document.querySelector("#__btri_root__").shadowRoot.querySelector(".stage").getBoundingClientRect(); return { top: box.top, bottom: box.bottom }; });
    const fixed = await waitFor(async () => { const list = await items(); return list.some((item) => /^底部/.test(item.text)) && list.some((item) => /^顶部/.test(item.text)) ? list : null; }, { timeout: 15000, message: "a top and a bottom comment at the same time" });
    assert.ok(fixed.filter((item) => /^底部/.test(item.text)).every((item) => item.top > (stageBox.top + stageBox.bottom) / 2), "bottom comments in the lower half");
    assert.ok(fixed.filter((item) => /^顶部/.test(item.text)).every((item) => item.top < (stageBox.top + stageBox.bottom) / 2), "top comments in the upper half");
    const time = (await inApp.video(page)).currentTime;
    const numbers = shown.map((item) => Number(/^第(\d+)条/.exec(item.text)?.[1])).filter(Number.isFinite);
    assert.ok(numbers.every((index) => index * 0.4 <= time + 0.5 && index * 0.4 >= time - 9), `only comments around ${time.toFixed(1)} s: ${numbers}`);
    // no two scrolling comments on top of each other
    const scrolling = shown.filter((item) => /^第/.test(item.text));
    assert.match(await page.locator("#__btri_root__ .dmcount").textContent(), /^261 条$/, "225 scrolling + 18 top + 18 bottom, the scripted one dropped");
    assert.ok((await inApp.logs(page)).includes("来自 Loon 助手"), "direct fetch is blocked by CORS in this run, the helper took over");
    // pause: everything stands still
    await page.evaluate(() => document.querySelector("#__btri_root__").shadowRoot.querySelector("video").pause());
    await new Promise((resolve) => setTimeout(resolve, 400));
    const frozenA = await items();
    await new Promise((resolve) => setTimeout(resolve, 700));
    const frozenB = await items();
    assert.deepEqual(frozenB.map((item) => Math.round(item.x)), frozenA.map((item) => Math.round(item.x)));
    assert.ok(scrolling.length >= 3);
    // off
    await page.locator("#__btri_root__ .seg[aria-label='弹幕'] button:has-text('关')").click();
    assert.equal((await items()).length, 0);
    await page.evaluate(() => document.querySelector("#__btri_root__").shadowRoot.querySelector("video").play());
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal((await items()).length, 0);
    assert.equal((await inApp.debug(page)).settings.danmaku, false);
  } catch (error) { await failWithLogs(page, "player-danmaku", error); }
});

test("a codec that turns out not to decode is dropped and the next one takes over", async () => {
  const { page } = await freshPage();
  try {
    await page.goto(`${PLAYER}#/v/BV1btrCODC05`);
    await tap(page);
    await playing(page, 2);
    assert.equal((await inApp.debug(page)).engine.codec, "av1", "AV1 preferred when the browser says it can play it");
    // What an iPhone does when a stream it claimed to support fails in the decoder.
    await page.evaluate(() => {
      const video = document.querySelector("#__btri_root__").shadowRoot.querySelector("video");
      Object.defineProperty(video, "error", { configurable: true, get: () => ({ code: 3, message: "mock decode failure" }) });
      video.dispatchEvent(new Event("error"));
      delete video.error;
    });
    await waitFor(async () => (await inApp.debug(page)).engine.codec === "other", { message: "switched codec family" });
    const video = await playing(page, 3);
    assert.equal(video.error, 0);
    const debug = await inApp.debug(page);
    assert.deepEqual(debug.engine.droppedCodecFamilies, ["av1"]);
    assert.equal(debug.engine.qualityId, 64, "same quality, different codec");
  } catch (error) { await failWithLogs(page, "player-codec", error); }
});

test("a full SourceBuffer (tiny iOS quota) is handled, not fatal", async () => {
  const { page, context } = await freshPage();
  try {
    // Refuse appends once more than 12 s of video sit in front of the play head.
    await context.addInitScript(() => {
      const nativeAppend = SourceBuffer.prototype.appendBuffer;
      window.__quotaThrows = 0;
      SourceBuffer.prototype.appendBuffer = function (data) {
        const video = document.querySelector("#__btri_root__")?.shadowRoot?.querySelector("video");
        const ranges = this.buffered;
        const end = ranges.length ? ranges.end(ranges.length - 1) : 0;
        const start = ranges.length ? ranges.start(0) : 0;
        if (video && data.byteLength > 50000 && end - start > 22) {
          window.__quotaThrows += 1;
          throw new DOMException("mock quota", "QuotaExceededError");
        }
        return nativeAppend.call(this, data);
      };
    });
    await page.goto(`${PLAYER}#/v/BV1btrTEST01`);
    await tap(page);
    await playing(page, 30, 90000);
    const debug = await inApp.debug(page);
    assert.ok(debug.engine.quotaEvents > 0, "quota was hit");
    assert.ok(debug.engine.aheadBytesCap < 96 * 1024 * 1024, "look-ahead budget shrank");
    assert.notEqual(debug.state, "error");
    assert.ok(await page.evaluate(() => window.__quotaThrows) > 0);
  } catch (error) { await failWithLogs(page, "player-quota", error); }
});
