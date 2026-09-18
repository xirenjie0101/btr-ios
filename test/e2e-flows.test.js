"use strict";
// The two ways into the player from a Bilibili video page:
//   - Loon plugin: button (or redirect) added by dist/btr-loon.js, leading to the player page;
//   - userscript:  dist/btr-ios.user.js laid over the video page itself.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createMock } = require("./mock/server.js");
const { launch, inApp, waitFor, saveArtifact } = require("./lib/browser.js");

const mock = createMock({ port: 18472 });
const userscript = fs.readFileSync(path.join(__dirname, "..", "dist", "btr-ios.user.js"), "utf8");
let browser;

test.before(async () => { await mock.start(); });
test.after(async () => { await browser?.close(); await mock.stop(); });

async function fresh(options = {}) {
  await browser?.close();
  mock.resetStats();
  mock.resetProfiles();
  Object.assign(mock.state.loon, { enabled: true, injectButton: true, autoRedirect: false });
  mock.state.pageCsp = true;
  mock.state.mediaCorsWwwOnly = false;
  const session = await launch({ port: mock.port, ...options });
  browser = session.browser;
  return session;
}

const playing = (page, beyond, timeout = 40000) => waitFor(async () => {
  const video = await inApp.video(page);
  return video.currentTime > beyond && !video.paused ? video : null;
}, { timeout, message: `playback beyond ${beyond} s` });

async function failWithLogs(page, name, error) {
  try { saveArtifact(`${name}.png`, await page.screenshot({ fullPage: true })); } catch (_error) {}
  try { saveArtifact(`${name}.log.txt`, await inApp.logs(page)); } catch (_error) {}
  throw error;
}

test("Loon: the button appears on the video page (despite its CSP) and leads to the player with the same part", async () => {
  const { page, consoleLines } = await fresh({ mms: true });
  try {
    await page.goto("https://m.bilibili.com/video/BV1btrTEST02?p=2&share_source=copy_web");
    const button = page.locator("#__btri_loon_fab__ button");
    await button.waitFor({ state: "visible", timeout: 10000 });
    assert.match(await button.textContent(), /BTR/);
    assert.ok(!consoleLines.some((line) => /Content Security Policy/i.test(line)), "the page's CSP no longer blocks the inline button script");
    await button.click();
    // stays on the page's own host: a same-domain navigation can never be grabbed by the app
    await page.waitForURL("https://m.bilibili.com/__btr__/#/v/BV1btrTEST02?p=2", { timeout: 10000 });
    await page.locator("#__btri_root__ .veil.tap").click();
    await playing(page, 2);
    assert.equal(await page.locator("#__btri_root__ select[aria-label='分 P']").inputValue(), "1");
    // short links resolve through the helper on this host as well
    await page.locator("#__btri_root__ button:has-text('返回')").click();
    await page.locator("#__btri_root__ input[type=url]").fill("https://b23.tv/btrP2");
    await page.locator("#__btri_root__ button.primary").click();
    await playing(page, 1);
    assert.equal(page.url(), "https://m.bilibili.com/__btr__/#/v/BV1btrTEST02?p=2");
  } catch (error) { await failWithLogs(page, "flow-loon-button", error); }
});

test("Loon: with the redirect switch on, opening a video link lands in the player; ?btr=0 opts out", async () => {
  const { page } = await fresh();
  try {
    mock.state.loon.autoRedirect = true;
    await page.goto("https://m.bilibili.com/video/BV1btrTEST01?t=30");
    await page.waitForURL("https://www.bilibili.com/__btr__/#/v/BV1btrTEST01?t=30", { timeout: 10000 });
    await page.locator("#__btri_root__ .veil.tap").click();
    const video = await playing(page, 31);
    assert.ok(video.currentTime < 60, "started at the linked time");
    // the player's own link back to Bilibili must not bounce straight back
    const back = await page.locator("#__btri_root__ .meta a").getAttribute("href");
    assert.match(back, /^https:\/\/www\.bilibili\.com\/video\/BV1btrTEST01\?btr=0$/);
    await page.goto(back);
    assert.equal(new URL(page.url()).pathname, "/video/BV1btrTEST01");
  } catch (error) { await failWithLogs(page, "flow-loon-redirect", error); }
});

test("if the mirrors turn out to accept only www pages, the player on m offers the way over and it works there", async () => {
  const { page } = await fresh();
  try {
    mock.state.mediaCorsWwwOnly = true;
    await page.goto("https://m.bilibili.com/__btr__/#/v/BV1btrTEST02?p=2");
    const switchButton = page.locator("#__btri_root__ .veil button:has-text('www.bilibili.com')");
    await switchButton.waitFor({ state: "visible", timeout: 30000 });
    assert.equal(await page.locator("#__btri_root__ .veil .retry").first().isVisible(), true);
    await switchButton.click();
    await page.waitForURL("https://www.bilibili.com/__btr__/#/v/BV1btrTEST02?p=2", { timeout: 10000 });
    await page.locator("#__btri_root__ .veil.tap").click();
    await playing(page, 2);
    assert.equal(await page.locator("#__btri_root__ .veil button:has-text('www.bilibili.com')").isVisible(), false);
  } catch (error) { await failWithLogs(page, "flow-cors-www-only", error); }
});

test("without the plugin the player address simply does not exist", async () => {
  const { page } = await fresh();
  mock.state.loon.enabled = false;
  const response = await page.goto("https://www.bilibili.com/__btr__/");
  assert.equal(response.status(), 404);
  await page.goto("https://m.bilibili.com/video/BV1btrTEST01");
  assert.equal(await page.locator("#__btri_loon_fab__").count(), 0);
});

test("userscript: button on the video page, overlay player on top of it, page's own player silenced", async () => {
  const { page } = await fresh();
  try {
    mock.state.loon.enabled = false;
    mock.state.pageCsp = false;
    await page.goto("https://m.bilibili.com/video/BV1btrTEST01");
    await page.addScriptTag({ content: userscript });
    const fab = page.locator("#__btri_fab__ button.fab");
    await fab.waitFor({ state: "visible", timeout: 10000 });
    assert.equal(await page.locator("#__btri_root__").isVisible(), false, "overlay closed until asked for");
    await fab.click();
    // the tap on the button is the user gesture: no second tap
    const video = await playing(page, 3);
    assert.equal(video.width, 1280);
    assert.equal(await fab.isVisible(), false);
    assert.equal(await page.evaluate(() => document.documentElement.style.overflow), "hidden");
    assert.ok(mock.stats.apiCalls.every((call) => call.origin === "https://m.bilibili.com"));
    assert.equal(mock.stats.refererFailures, 0);
    // close: back to the page as it was
    await page.locator("#__btri_root__ button:has-text('返回')").click();
    await page.locator("#__btri_root__ button:has-text('关闭')").click();
    await fab.waitFor({ state: "visible" });
    assert.equal(await page.locator("#__btri_root__").isVisible(), false);
    assert.equal(await page.evaluate(() => document.documentElement.style.overflow), "");
    assert.equal(await page.evaluate(() => location.href), "https://m.bilibili.com/video/BV1btrTEST01", "the host page's address was never touched");
  } catch (error) { await failWithLogs(page, "flow-userscript", error); }
});

test("userscript: no button where there is no video; automatic takeover waits for a tap", async () => {
  const { page, context } = await fresh();
  try {
    mock.state.loon.enabled = false;
    mock.state.pageCsp = false;
    await context.addInitScript(() => { try { localStorage.setItem("BTRI.settings", JSON.stringify({ autoOpen: true })); } catch (_error) {} });
    await page.goto("https://m.bilibili.com/video/BV1btrTEST01");
    await page.addScriptTag({ content: userscript });
    await page.locator("#__btri_root__ .veil.tap").waitFor({ state: "visible", timeout: 10000 });
    assert.equal((await inApp.video(page)).paused, true, "no gesture yet, so it waits");
    await page.locator("#__btri_root__ .veil.tap").click();
    await playing(page, 2);
    // same script on a page that is not a video
    const other = await context.newPage();
    await other.goto("https://m.bilibili.com/space/1");
    await other.addScriptTag({ content: userscript });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(await other.locator("#__btri_fab__ button.fab").isVisible(), false);
    assert.equal(await other.locator("#__btri_root__").isVisible(), false);
  } catch (error) { await failWithLogs(page, "flow-userscript-auto", error); }
});
