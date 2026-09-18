"use strict";
// The iPhone path. iPhone Safari has ManagedMediaSource only; Chromium has MediaSource only, so
// test/lib/browser.js puts a ManagedMediaSource with the iOS rules on top and hides MediaSource.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createMock } = require("./mock/server.js");
const { launch, inApp, waitFor, saveArtifact } = require("./lib/browser.js");

const mock = createMock({ port: 18471 });
const PLAYER = "https://www.bilibili.com/__btr__/";
let browser;

test.before(async () => { await mock.start(); });
test.after(async () => { await browser?.close(); await mock.stop(); });

async function iphone() {
  await browser?.close();
  mock.resetStats();
  mock.resetProfiles();
  const session = await launch({ port: mock.port, mms: true });
  browser = session.browser;
  return session;
}

const tap = (page) => page.locator("#__btri_root__ .veil.tap").click();
const playing = (page, beyond, timeout = 40000) => waitFor(async () => {
  const video = await inApp.video(page);
  return video.currentTime > beyond && !video.paused ? video : null;
}, { timeout, message: `playback beyond ${beyond} s` });
const totalBytes = () => Object.values(mock.stats.hosts).reduce((sum, item) => sum + item.bytes, 0);

async function failWithLogs(page, name, error) {
  try { saveArtifact(`${name}.png`, await page.screenshot({ fullPage: true })); } catch (_error) {}
  try { saveArtifact(`${name}.log.txt`, await inApp.logs(page)); } catch (_error) {}
  throw error;
}

test("without MediaSource the engine takes ManagedMediaSource, the way iOS wants it attached", async () => {
  const { page } = await iphone();
  try {
    await page.goto(`${PLAYER}#/v/BV1btrTEST01`);
    assert.deepEqual(await page.evaluate(() => [typeof window.MediaSource, typeof window.ManagedMediaSource]), ["undefined", "function"]);
    await tap(page);
    const video = await playing(page, 3);
    assert.equal(video.disableRemotePlayback, true, "remote playback disabled, or the source would never open on iOS");
    assert.equal(video.usesSourceChild, true, "attached through a <source> child");
    assert.equal(video.srcAttribute, "");
    assert.equal(await page.evaluate(() => window.__mmsRefused || 0), 0, "never tried to open while AirPlay was still allowed");
    const debug = await inApp.debug(page);
    assert.equal(debug.engine.managed, true);
    assert.match(await page.locator("#__btri_root__ .statusline").textContent(), /ManagedMediaSource/);
  } catch (error) { await failWithLogs(page, "mms-basic", error); }
});

test("endstreaming is honoured once enough is buffered, startstreaming resumes", async () => {
  const { page } = await iphone();
  try {
    await page.goto(`${PLAYER}#/v/BV1btrTEST01`);
    await tap(page);
    await playing(page, 1);
    await waitFor(async () => {
      const video = await inApp.video(page);
      return video.buffered.length && video.buffered.at(-1)[1] - video.currentTime > 22;
    }, { timeout: 60000, message: "22 s buffered ahead" });
    await page.evaluate(() => window.__mmsSetStreaming(false));
    await new Promise((resolve) => setTimeout(resolve, 5000)); // requests already in flight may finish
    const paused = totalBytes();
    await new Promise((resolve) => setTimeout(resolve, 4000));
    assert.ok(totalBytes() - paused < 64 * 1024, `downloads should rest while the browser says "not now" (got ${totalBytes() - paused} bytes)`);
    assert.equal((await inApp.video(page)).paused, false, "playback itself carries on");
    await page.evaluate(() => window.__mmsSetStreaming(true));
    await waitFor(async () => totalBytes() - paused > 512 * 1024, { timeout: 20000, message: "downloads resume" });
  } catch (error) { await failWithLogs(page, "mms-streaming", error); }
});

test("even with endstreaming the buffer is never allowed to run dry", async () => {
  const { page } = await iphone();
  try {
    await page.goto(`${PLAYER}#/v/BV1btrTEST01`);
    await tap(page);
    await playing(page, 1);
    await page.evaluate(() => window.__mmsSetStreaming(false));
    // 30 s of playback with the browser never asking for data again
    const video = await playing(page, 32, 70000);
    assert.ok(video.buffered.at(-1)[1] - video.currentTime > 5);
    assert.equal((await inApp.debug(page)).engine.startupWaitingEvents, 0);
  } catch (error) { await failWithLogs(page, "mms-floor", error); }
});

test("iOS evicts the data under the play head: the engine rebuilds and keeps playing", async () => {
  const { page } = await iphone();
  try {
    await page.goto(`${PLAYER}#/v/BV1btrTEST01`);
    await tap(page);
    const before = await playing(page, 8);
    await page.evaluate((time) => window.__mmsEvict(Math.max(0, time - 2), time + 12), before.currentTime);
    const after = await playing(page, before.currentTime + 6, 45000);
    assert.ok(after.currentTime < before.currentTime + 40);
    const debug = await inApp.debug(page);
    assert.ok(debug.engine.holeRepairs >= 1, "the hole under the play head was repaired");
    assert.notEqual(debug.state, "error");
  } catch (error) { await failWithLogs(page, "mms-evict-here", error); }
});

test("iOS evicts data further ahead: it is fetched again before the play head gets there", async () => {
  const { page } = await iphone();
  try {
    await page.goto(`${PLAYER}#/v/BV1btrTEST01`);
    await tap(page);
    await playing(page, 1);
    await waitFor(async () => {
      const video = await inApp.video(page);
      return video.buffered.length && video.buffered.at(-1)[1] - video.currentTime > 25;
    }, { timeout: 60000, message: "25 s buffered ahead" });
    const at = (await inApp.video(page)).currentTime;
    await page.evaluate((time) => window.__mmsEvict(time + 8, time + 18), at);
    const holes = (await inApp.video(page)).buffered;
    assert.ok(holes.length >= 2, `eviction made a hole: ${JSON.stringify(holes)}`);
    const video = await playing(page, at + 22, 60000);
    assert.ok(video.currentTime > at + 22);
    const debug = await inApp.debug(page);
    assert.equal(debug.engine.holeRepairs, 0, "refilled in time, no rebuild needed");
    assert.equal(debug.engine.startupWaitingEvents, 0, "no stall");
  } catch (error) { await failWithLogs(page, "mms-evict-ahead", error); }
});
