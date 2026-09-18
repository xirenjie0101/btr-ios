"use strict";
// Playwright + Chromium set up so that every Bilibili host name lands on the mock server.
const path = require("path");
const fs = require("fs");

function loadPlaywright() {
  for (const candidate of ["playwright", "/home/claude/.npm-global/lib/node_modules/playwright"]) {
    try { return require(candidate); } catch (_error) {}
  }
  throw new Error("playwright is not installed");
}

const { chromium, devices } = loadPlaywright();

// iPhone Safari has no MediaSource at all, only ManagedMediaSource. Chromium has it the other way
// round, so for the "iPhone" runs a thin ManagedMediaSource is put on top of Chromium's
// MediaSource and the original is hidden. It models the parts BTR-iOS depends on:
//   - it does not open unless remote playback is disabled on the element it is attached to,
//   - `streaming` + startstreaming / endstreaming,
//   - the page can ask it to evict buffered data (window.__mmsEvict), like iOS does under memory pressure.
const MMS_SHIM = `(() => {
  const Native = window.MediaSource;
  if (!Native) return;
  const created = [];
  class ManagedMediaSource extends Native {
    constructor() {
      super();
      this.__streaming = false;
      created.push(this);
      this.addEventListener("sourceopen", () => this.__setStreaming(true));
    }
    get streaming() { return this.__streaming; }
    __setStreaming(value) {
      if (this.__streaming === value) return;
      this.__streaming = value;
      this.dispatchEvent(new Event(value ? "startstreaming" : "endstreaming"));
    }
    addSourceBuffer(type) {
      const buffer = super.addSourceBuffer(type);
      buffer.addEventListener("updateend", () => buffer.dispatchEvent(new Event("bufferedchange")));
      return buffer;
    }
  }
  const nativeCreate = URL.createObjectURL.bind(URL);
  const managedUrls = new Set();
  URL.createObjectURL = (object) => {
    const url = nativeCreate(object);
    if (object instanceof ManagedMediaSource) managedUrls.add(url);
    return url;
  };
  // A managed source attached to an element that still allows AirPlay never opens on iOS.
  const nativeLoad = HTMLMediaElement.prototype.load;
  HTMLMediaElement.prototype.load = function () {
    const source = this.querySelector("source");
    const url = this.getAttribute("src") || (source && source.src) || "";
    if (managedUrls.has(url) && this.disableRemotePlayback !== true) {
      window.__mmsRefused = (window.__mmsRefused || 0) + 1;
      return;
    }
    return nativeLoad.call(this);
  };
  window.ManagedMediaSource = ManagedMediaSource;
  window.__mmsAll = created;
  window.__mmsCurrent = () => created.filter((item) => item.readyState === "open").at(-1) || null;
  window.__mmsSetStreaming = (value) => { const current = window.__mmsCurrent(); if (current) current.__setStreaming(Boolean(value)); };
  window.__mmsEvict = async (start, end) => {
    const current = window.__mmsCurrent();
    if (!current) return 0;
    // Both tracks at once, like a real eviction. The engine may replace the whole media source
    // as soon as the first hole appears, so a buffer can be gone before its turn comes.
    const results = await Promise.all(Array.from(current.sourceBuffers).map(async (buffer) => {
      try {
        while (buffer.updating) await new Promise((resolve) => buffer.addEventListener("updateend", resolve, { once: true }));
        buffer.remove(start, end);
        await new Promise((resolve) => buffer.addEventListener("updateend", resolve, { once: true }));
        return 1;
      } catch (_error) {
        return 0;
      }
    }));
    return results.reduce((sum, value) => sum + value, 0);
  };
  delete window.MediaSource;
  Object.defineProperty(window, "MediaSource", { value: undefined, configurable: true, writable: true });
})();`;

// The test browser only ever talks to the local mock (every host name is mapped to it), so the
// machine's proxy settings must not apply: a proxy would be asked to CONNECT to made-up hosts.
function environmentWithoutProxy() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:https?|all|no)_proxy$/i.test(key)) delete env[key];
  return env;
}

async function launch({ port, iphone = true, mms = false, extraArgs = [] }) {
  const browser = await chromium.launch({
    headless: true,
    env: environmentWithoutProxy(),
    args: [
      `--host-resolver-rules=MAP * 127.0.0.1:${port}`,
      "--ignore-certificate-errors",
      // Everything is served by the local mock; never hand these made-up host names to a proxy.
      "--no-proxy-server",
      "--autoplay-policy=document-user-activation-required",
      "--mute-audio",
      ...extraArgs
    ]
  });
  const context = await browser.newContext({
    ...(iphone ? devices["iPhone 14"] : { viewport: { width: 1180, height: 820 } }),
    ignoreHTTPSErrors: true,
    locale: "zh-CN"
  });
  if (mms) await context.addInitScript(MMS_SHIM);
  const page = await context.newPage();
  const consoleLines = [];
  page.on("console", (message) => consoleLines.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => consoleLines.push(`[pageerror] ${error.message}`));
  return { browser, context, page, consoleLines };
}

// Helpers that reach into the app's shadow root.
const inApp = {
  video: (page) => page.evaluate(() => {
    const video = document.querySelector("#__btri_root__").shadowRoot.querySelector("video");
    const ranges = [];
    for (let index = 0; index < video.buffered.length; index += 1) ranges.push([Number(video.buffered.start(index).toFixed(2)), Number(video.buffered.end(index).toFixed(2))]);
    return {
      currentTime: video.currentTime, paused: video.paused, ended: video.ended, readyState: video.readyState,
      duration: video.duration, width: video.videoWidth, height: video.videoHeight, buffered: ranges,
      error: video.error ? video.error.code : 0, disableRemotePlayback: video.disableRemotePlayback,
      usesSourceChild: Boolean(video.querySelector("source[data-btr]")), srcAttribute: video.getAttribute("src") || ""
    };
  }),
  debug: (page) => page.evaluate(() => window.__BTRI_APP__.debug()),
  logs: (page) => page.evaluate(() => window.__BTRI_APP__.logsAsText()),
  veil: (page) => page.evaluate(() => {
    const rootNode = document.querySelector("#__btri_root__").shadowRoot;
    const veil = rootNode.querySelector(".veil");
    return { hidden: veil.hidden, tap: veil.classList.contains("tap"), note: rootNode.querySelector(".veil .note").textContent };
  })
};

async function waitFor(check, { timeout = 30000, interval = 250, message = "condition" } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`timed out after ${timeout} ms waiting for ${message}`);
}

function saveArtifact(name, data) {
  const dir = path.join(__dirname, "..", "artifacts");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
}

module.exports = { launch, inApp, waitFor, saveArtifact, MMS_SHIM };
