"use strict";
// Renders the screens used in the README (and lets a human eyeball the layout).
const { createMock } = require("./mock/server.js");
const { launch, inApp, waitFor, saveArtifact } = require("./lib/browser.js");

(async () => {
  const mock = createMock({ port: 18480 });
  await mock.start();
  const { browser, context, page } = await launch({ port: mock.port, mms: true });
  try {
    await page.emulateMedia({ colorScheme: "dark" });
    await context.addCookies([{ name: "DedeUserID", value: "42", domain: ".bilibili.com", path: "/", secure: true, sameSite: "Lax" }]);
    await page.goto("https://www.bilibili.com/__btr__/#/v/BV1btrTEST02");
    await page.locator("#__btri_root__ .veil.tap").click();
    await waitFor(async () => (await inApp.video(page)).currentTime > 6, { timeout: 40000, message: "playing" });
    saveArtifact("shot-player-dark.png", await page.screenshot({ fullPage: true }));
    await page.setViewportSize({ width: 844, height: 390 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    saveArtifact("shot-player-landscape.png", await page.screenshot());
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#__btri_root__ button:has-text('返回')").click();
    await new Promise((resolve) => setTimeout(resolve, 600));
    saveArtifact("shot-home-dark.png", await page.screenshot({ fullPage: true }));
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("https://m.bilibili.com/video/BV1btrTEST01");
    await page.locator("#__btri_loon_fab__ button").waitFor({ state: "visible" });
    saveArtifact("shot-button-on-video-page.png", await page.screenshot());
    console.log("screenshots written to test/artifacts/");
  } finally {
    await browser.close();
    await mock.stop();
  }
})();
