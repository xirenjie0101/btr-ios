"use strict";
// Quick manual run: node test/smoke.js [mms] — opens the player page, taps play, prints what happens.
const { createMock } = require("./mock/server.js");
const { launch, inApp, waitFor, saveArtifact } = require("./lib/browser.js");

(async () => {
  const mms = process.argv.includes("mms");
  const mock = createMock({ port: 18460 });
  await mock.start();
  const { browser, page, consoleLines } = await launch({ port: mock.port, mms });
  try {
    await page.goto("https://www.bilibili.com/__btr__/#/v/BV1btrTEST01");
    await page.waitForSelector("#__btri_root__");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    console.log("veil before tap:", await inApp.veil(page));
    saveArtifact(`smoke-${mms ? "mms" : "mse"}-1-before-tap.png`, await page.screenshot());
    await page.locator("#__btri_root__ .veil").click();
    const started = Date.now();
    await waitFor(async () => (await inApp.video(page)).currentTime > 3, { timeout: 40000, message: "playback past 3 s" });
    console.log(`playing after ${((Date.now() - started) / 1000).toFixed(1)} s`);
    console.log("video:", await inApp.video(page));
    saveArtifact(`smoke-${mms ? "mms" : "mse"}-2-playing.png`, await page.screenshot());
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const debug = await inApp.debug(page);
    console.log("debug:", JSON.stringify(debug, null, 1));
    console.log("video:", await inApp.video(page));
    console.log("mock: max concurrent", mock.stats.maxConcurrent, "hosts:", Object.fromEntries(Object.entries(mock.stats.hosts).map(([host, item]) => [host, `${item.requests} req, ${(item.bytes / 1024).toFixed(0)} KiB, max ${item.maxConcurrent}`])));
    console.log("referer failures", mock.stats.refererFailures, "signature failures", mock.stats.signatureFailures);
    saveArtifact(`smoke-${mms ? "mms" : "mse"}-3-later.png`, await page.screenshot({ fullPage: true }));
  } catch (error) {
    console.error("SMOKE FAILED:", error.message);
    try { console.log(await inApp.logs(page)); } catch (_error) {}
    try { saveArtifact("smoke-failure.png", await page.screenshot({ fullPage: true })); } catch (_error) {}
    process.exitCode = 1;
  } finally {
    if (consoleLines.length) console.log("console:\n" + consoleLines.slice(-30).join("\n"));
    await browser.close();
    await mock.stop();
  }
})();
