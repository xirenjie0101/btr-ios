#!/usr/bin/env node
"use strict";
/*
 * Builds dist/ from src/. No dependencies.
 *
 *   node build.js                              script URLs point at this repository's dist/ on GitHub
 *   node build.js --base https://raw.githubusercontent.com/<you>/<repo>/main/dist
 *                                              (forks / self-hosting: wherever you serve dist/ from)
 *   node build.js --date 2026-09-18            override the plugins' "#!date" line (default: releaseDate in package.json)
 *
 * Outputs
 *   dist/btr-app.js           Loon script, App mode: multi-threaded fetching for the Bilibili apps
 *   dist/BTR-iOS-App.plugin   Loon plugin for it
 *   dist/btr-ios.user.js      userscript (Safari + Userscripts / Stay / Tampermonkey)
 *   dist/btr-loon.js          Loon script (player page, short-link helper, button, redirect)
 *   dist/BTR-iOS.plugin       Loon plugin that wires the script up
 *   dist/player.html          the player page on its own (what the Loon script serves)
 *   dist/icon.png             plugin icon shown in Loon's plugin list
 *   dist/extras/…             optional diagnostic probe for the official app (see README)
 */
const fs = require("fs");
const path = require("path");

const root = __dirname;
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const pkg = JSON.parse(read("package.json"));
const version = pkg.version;

const args = process.argv.slice(2);
const baseIndex = args.indexOf("--base");
const DEFAULT_BASE = "https://raw.githubusercontent.com/xirenjie0101/btr-ios/main/dist";
const UPSTREAM_HOME = "https://github.com/MrTangLuyao/Bilibili-thread-ripper";
const base = (baseIndex >= 0 && args[baseIndex + 1] ? args[baseIndex + 1] : DEFAULT_BASE).replace(/\/+$/, "");
// The plugins' "#!date" line is the release date from package.json (override: --date YYYY-MM-DD),
// not "today", so building the same sources always gives byte-identical files.
const dateIndex = args.indexOf("--date");
const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || "");
const buildDate = dateIndex >= 0 && isDate(args[dateIndex + 1]) ? args[dateIndex + 1] : isDate(pkg.releaseDate) ? pkg.releaseDate : new Date().toISOString().slice(0, 10);
// A raw.githubusercontent.com base tells us which repository this build belongs to; anything else
// (self-hosted dist/) falls back to crediting the upstream project as the homepage.
const repoMatch = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//.exec(`${base}/`);
const homepage = repoMatch ? `https://github.com/${repoMatch[1]}/${repoMatch[2]}` : UPSTREAM_HOME;

const VENDOR = ["range-core.js", "cdn-resolver.js", "sidx.js", "idm-downloader.js"].map((name) => `src/vendor-btr/${name}`);
const APP = ["engine.js", "api.js", "store.js", "danmaku.js", "ui.js", "boot.js"].map((name) => `src/app/${name}`);
const upstreamCommit = read("src/vendor-btr/UPSTREAM_COMMIT").trim();

function minifyCss(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s*\n\s*/g, "").replace(/\s*([{};,>])\s*/g, "$1").replace(/:\s+/g, ":").trim();
}

function jsString(value) {
  // U+2028 / U+2029 are legal inside JSON strings but were line terminators in older JS engines.
  const lineSeparator = String.fromCharCode(0x2028);
  const paragraphSeparator = String.fromCharCode(0x2029);
  return JSON.stringify(value).split(lineSeparator).join("\\u2028").split(paragraphSeparator).join("\\u2029");
}

function fill(template, values) {
  let output = template;
  for (const [token, value] of Object.entries(values)) output = output.split(token).join(value);
  return output;
}

function bundle(context) {
  const css = minifyCss(read("src/app/ui.css"));
  const parts = [
    `/*! BTR-iOS ${version} — MIT. Download core: Bilibili-thread-ripper @ ${upstreamCommit.slice(0, 7)} (MIT, © 2026 Bilibili-thread-ripper contributors). */`,
    "(function () {",
    `const __BTRI_VERSION__ = ${jsString(version)};`,
    `const __BTRI_CSS__ = ${jsString(css)};`,
    `const __BTRI_CONTEXT__ = ${JSON.stringify(context)};`
  ];
  for (const file of [...VENDOR, ...APP]) parts.push(`\n/* ---- ${file} ---- */`, read(file).trim());
  parts.push("})();");
  return parts.join("\n");
}

const USERSCRIPT_HEADER = `// ==UserScript==
// @name         Bilibili 线程撕裂者 iOS (BTR-iOS)
// @namespace    https://github.com/MrTangLuyao/Bilibili-thread-ripper
// @version      ${version}
// @homepageURL  ${homepage}
// @downloadURL  ${base}/btr-ios.user.js
// @updateURL    ${base}/btr-ios.user.js
// @description  iPhone / iPad Safari 上的 B 站多线程、多 CDN 加速播放器。移植自开源项目 Bilibili-thread-ripper。
// @author       BTR-iOS (port); download core © Bilibili-thread-ripper contributors
// @license      MIT
// @match        https://www.bilibili.com/*
// @match        https://m.bilibili.com/*
// @run-at       document-end
// @grant        none
// @inject-into  page
// @noframes
// ==/UserScript==
`;

function pageHtml(script) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="format-detection" content="telephone=no">
<meta name="theme-color" content="#0e1014">
<meta name="apple-mobile-web-app-title" content="BTR">
<link rel="apple-touch-icon" href="/__btr__/icon.png">
<link rel="icon" type="image/png" href="/__btr__/icon.png">
<title>BTR 线程撕裂者 iOS</title>
<style>html,body{margin:0;background:#0e1014}@media (prefers-color-scheme:light){html,body{background:#f4f6fa}}</style>
</head>
<body>
<noscript>这个页面需要 JavaScript。</noscript>
<script>
${script.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--")}
</script>
</body>
</html>
`;
}

fs.mkdirSync(path.join(root, "dist"), { recursive: true });

const overlayBundle = bundle({ mode: "overlay" });
const pageBundle = bundle({ mode: "page", helperBase: "/__btr__/" });
const html = pageHtml(pageBundle);
const iconPath = path.join(root, "src/loon/icon-180.png");
const iconBase64 = fs.existsSync(iconPath) ? fs.readFileSync(iconPath).toString("base64") : "";

// Order matters: the page payload contains the token names itself (the bundle declares
// __BTRI_VERSION__), so it has to go in last, after the template's own tokens are filled.
const loon = fill(read("src/loon/btr-loon.template.js"), {
  "__BTRI_VERSION__": version,
  "__BTRI_ICON_BASE64__": iconBase64,
  "__BTRI_BUTTON_JS_JSON__": jsString(read("src/loon/inject-button.js").trim()),
  "__BTRI_PAGE_HTML_JSON__": jsString(html)
});

const plugin = fill(read("src/loon/BTR-iOS.plugin.template"), {
  "__BTRI_VERSION__": version,
  "__BTRI_SCRIPT_URL__": `${base}/btr-loon.js`,
  "__BTRI_HOMEPAGE__": homepage,
  "__BTRI_ICON_URL__": `${base}/icon.png`,
  "__BTRI_DATE__": buildDate
});

const probePlugin = fill(read("extras/app-probe/BTR-App-Probe.plugin.template"), {
  "__BTRI_VERSION__": version,
  "__BTRI_PROBE_URL__": `${base}/extras/btr-app-probe.js`,
  "__BTRI_HOMEPAGE__": homepage,
  "__BTRI_ICON_URL__": `${base}/icon.png`,
  "__BTRI_DATE__": buildDate
});

const appScript = fill(read("src/loon/btr-app.template.js"), { "__BTRI_VERSION__": version });
const appPlugin = fill(read("src/loon/BTR-iOS-App.plugin.template"), {
  "__BTRI_VERSION__": version,
  "__BTRI_APP_SCRIPT_URL__": `${base}/btr-app.js`,
  "__BTRI_HOMEPAGE__": homepage,
  "__BTRI_ICON_URL__": `${base}/icon.png`,
  "__BTRI_DATE__": buildDate
});

fs.mkdirSync(path.join(root, "dist", "extras"), { recursive: true });
const outputs = {
  "dist/btr-app.js": appScript,
  "dist/BTR-iOS-App.plugin": appPlugin,
  "dist/extras/btr-app-probe.js": read("extras/app-probe/btr-app-probe.js"),
  "dist/extras/BTR-App-Probe.plugin": probePlugin,
  "dist/btr-ios.user.js": `${USERSCRIPT_HEADER}\n${overlayBundle}\n`,
  "dist/btr-loon.js": loon,
  "dist/BTR-iOS.plugin": plugin,
  "dist/player.html": html
};
for (const [file, content] of Object.entries(outputs)) {
  fs.writeFileSync(path.join(root, file), content);
  console.log(`${file.padEnd(24)} ${(Buffer.byteLength(content) / 1024).toFixed(1)} KiB`);
}
if (fs.existsSync(iconPath)) {
  fs.copyFileSync(iconPath, path.join(root, "dist", "icon.png"));
  console.log(`${"dist/icon.png".padEnd(24)} ${(fs.statSync(iconPath).size / 1024).toFixed(1)} KiB`);
}
console.log(`\n脚本地址前缀：${base}`);
if (base === DEFAULT_BASE) console.log("（fork 或自己托管 dist/ 时，用 --base <你的地址> 重新构建，插件里的链接才会指向你自己的文件。）");
