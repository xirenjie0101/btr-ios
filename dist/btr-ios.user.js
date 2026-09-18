// ==UserScript==
// @name         Bilibili 线程撕裂者 iOS (BTR-iOS)
// @namespace    https://github.com/MrTangLuyao/Bilibili-thread-ripper
// @version      1.1.0
// @homepageURL  https://github.com/xirenjie0101/btr-ios
// @downloadURL  https://raw.githubusercontent.com/xirenjie0101/btr-ios/main/dist/btr-ios.user.js
// @updateURL    https://raw.githubusercontent.com/xirenjie0101/btr-ios/main/dist/btr-ios.user.js
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

/*! BTR-iOS 1.1.0 — MIT. Download core: Bilibili-thread-ripper @ cb50803 (MIT, © 2026 Bilibili-thread-ripper contributors). */
(function () {
const __BTRI_VERSION__ = "1.1.0";
const __BTRI_CSS__ = ":host([hidden]){display:none !important;}:host{all:initial;--bg:#0e1014;--surface:#171a21;--surface-2:#1f232c;--line:#2a2f3a;--text:#e9ecf2;--muted:#97a0b0;--accent:#4cc2ff;--accent-ink:#06202d;--good:#4ade80;--warn:#fbbf24;--bad:#f87171;color-scheme:dark;display:block;color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,\"PingFang SC\",\"Helvetica Neue\",\"Microsoft YaHei\",sans-serif;-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent;}@media (prefers-color-scheme:light){:host{--bg:#f4f6fa;--surface:#ffffff;--surface-2:#eef1f6;--line:#dde2ea;--text:#151922;--muted:#5d6676;--accent:#0a84d6;--accent-ink:#ffffff;--good:#15803d;--warn:#b45309;--bad:#b91c1c;color-scheme:light;}}*,*::before,*::after{box-sizing:border-box;}[hidden]{display:none !important;}button,select,input{font:inherit;color:inherit;}button{cursor:pointer;}.app{min-height:100vh;min-height:100dvh;background:var(--bg);display:flex;flex-direction:column;}.app.overlay{position:fixed;inset:0;z-index:2147483646;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;}.bar{display:flex;align-items:center;gap:10px;padding:calc(8px + env(safe-area-inset-top,0px)) calc(14px + env(safe-area-inset-right,0px)) 8px calc(14px + env(safe-area-inset-left,0px));background:var(--surface);border-bottom:1px solid var(--line);}.brand{display:flex;align-items:baseline;gap:8px;min-width:0;flex:1;}.brand b{font-size:17px;letter-spacing:.02em;white-space:nowrap;}.brand b i{font-style:normal;color:var(--accent);}.brand span{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}.bar button{border:1px solid var(--line);background:var(--surface-2);border-radius:999px;padding:6px 12px;font-size:13px;white-space:nowrap;}.stage{position:sticky;top:0;z-index:5;background:#000;width:100%;aspect-ratio:16 / 9;max-height:78vh;max-height:78dvh;}.stage video{position:absolute;inset:0;width:100%;height:100%;background:#000;object-fit:contain;}.dm{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:1;contain:strict;}.dm-item{position:absolute;left:0;top:0;white-space:nowrap;font-weight:700;line-height:1.3;opacity:.88;text-shadow:1px 0 1px #000,-1px 0 1px #000,0 1px 1px #000,0 -1px 1px #000;will-change:transform;}.veil{z-index:2;position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;padding:16px;color:#fff;background:rgba(0,0,0,.55) center / cover no-repeat;pointer-events:none;}.veil.tap{pointer-events:auto;cursor:pointer;}.veil .play{width:72px;height:72px;border-radius:50%;border:0;background:var(--accent);color:var(--accent-ink);font-size:30px;line-height:72px;padding:0 0 0 6px;box-shadow:0 6px 24px rgba(0,0,0,.45);}.veil .note{font-size:13px;text-shadow:0 1px 3px rgba(0,0,0,.8);max-width:30em;white-space:pre-line;}.veil .retry{pointer-events:auto;border:1px solid rgba(255,255,255,.5);background:rgba(0,0,0,.4);color:#fff;border-radius:999px;padding:7px 16px;}.spin{width:38px;height:38px;border-radius:50%;border:3px solid rgba(255,255,255,.25);border-top-color:#fff;animation:btri-spin .9s linear infinite;}@keyframes btri-spin{to{transform:rotate(360deg);}}@media (prefers-reduced-motion:reduce){.spin{animation-duration:2.4s;}}.page{flex:1;width:100%;max-width:820px;margin:0 auto;padding:14px calc(14px + env(safe-area-inset-right,0px)) calc(28px + env(safe-area-inset-bottom,0px)) calc(14px + env(safe-area-inset-left,0px));display:flex;flex-direction:column;gap:14px;}.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px;}.card h2{margin:0 0 10px;font-size:13px;font-weight:600;color:var(--muted);letter-spacing:.04em;}.title{margin:0;font-size:17px;font-weight:650;line-height:1.35;word-break:break-word;}.meta{margin-top:6px;color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:4px 12px;}.meta a{color:var(--accent);text-decoration:none;}.open{display:flex;gap:8px;}.open input{flex:1;min-width:0;border:1px solid var(--line);background:var(--surface-2);border-radius:10px;padding:11px 12px;font-size:16px;outline:none;}.open input:focus{border-color:var(--accent);}.primary{border:0;background:var(--accent);color:var(--accent-ink);font-weight:650;border-radius:10px;padding:0 18px;min-height:44px;}.ghost{border:1px solid var(--line);background:var(--surface-2);border-radius:10px;padding:0 14px;min-height:44px;}.hint{margin:10px 0 0;color:var(--muted);font-size:13px;}.hint.bad{color:var(--bad);}.hint a{color:var(--accent);}.rows{display:grid;gap:10px;}.row{display:flex;align-items:center;gap:10px;min-height:40px;}.row>label,.row>span.k{flex:0 0 5.2em;color:var(--muted);font-size:13px;}.row>.v{flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;}.row select{flex:1;min-width:0;max-width:100%;border:1px solid var(--line);background:var(--surface-2);border-radius:10px;padding:9px 10px;font-size:15px;-webkit-appearance:none;appearance:none;}.seg{display:inline-flex;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--surface-2);}.seg button{border:0;background:transparent;padding:8px 12px;font-size:14px;min-width:44px;}.seg button[aria-pressed=\"true\"]{background:var(--accent);color:var(--accent-ink);font-weight:650;}.switch{display:inline-flex;align-items:center;gap:8px;}.switch input{width:20px;height:20px;accent-color:var(--accent);}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}.stat{background:var(--surface-2);border-radius:10px;padding:9px 10px;min-width:0;}.stat b{display:block;font-size:17px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}.stat span{color:var(--muted);font-size:12px;}.lanes{margin-top:10px;display:flex;flex-wrap:wrap;gap:3px;min-height:10px;}.lane{width:10px;height:10px;border-radius:3px;background:var(--line);}.lane.video{background:var(--accent);}.lane.audio{background:var(--good);}.lane.meta{background:var(--warn);}.hosts{margin-top:10px;display:flex;flex-wrap:wrap;gap:6px;}.host{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:3px 9px;color:var(--muted);font-variant-numeric:tabular-nums;}.host::before{content:\"○ \";}.host.healthy{color:var(--good);border-color:currentColor;}.host.healthy::before{content:\"● \";}.host.blocked{color:var(--warn);border-color:currentColor;}.host.blocked::before{content:\"◐ \";}.host.banned{color:var(--bad);border-color:currentColor;text-decoration:line-through;}.host.banned::before{content:\"✕ \";}.statusline{margin-top:10px;font-size:13px;color:var(--muted);}.history{list-style:none;margin:0;padding:0;display:grid;gap:8px;}.history li{display:flex;gap:10px;align-items:stretch;}.history button.item{flex:1;min-width:0;display:flex;gap:10px;text-align:left;border:1px solid var(--line);background:var(--surface-2);border-radius:12px;padding:8px;}.history img{width:96px;height:60px;border-radius:8px;object-fit:cover;background:#000;flex:none;}.history .t{font-size:14px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}.history .s{margin-top:3px;color:var(--muted);font-size:12px;}.history button.del{flex:none;width:40px;border:1px solid var(--line);background:transparent;border-radius:12px;color:var(--muted);}.empty{color:var(--muted);font-size:13px;margin:0;}details.log summary{color:var(--muted);font-size:13px;cursor:pointer;}.logtools{margin:10px 0 6px;display:flex;gap:8px;}.logtools button{border:1px solid var(--line);background:var(--surface-2);border-radius:8px;padding:5px 10px;font-size:13px;}.loglist{margin:0;padding:0;list-style:none;max-height:260px;overflow:auto;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;border-top:1px solid var(--line);}.loglist li{padding:5px 0;border-bottom:1px solid var(--line);white-space:pre-wrap;word-break:break-word;}.loglist li.error{color:var(--bad);}.loglist li.success{color:var(--good);}.loglist time{color:var(--muted);margin-right:6px;}.foot{color:var(--muted);font-size:12px;text-align:center;line-height:1.6;}.foot a{color:var(--accent);}.fab{position:fixed;right:calc(12px + env(safe-area-inset-right,0px));bottom:calc(84px + env(safe-area-inset-bottom,0px));z-index:2147483645;border:0;border-radius:999px;padding:11px 16px;font:600 14px/1 -apple-system,BlinkMacSystemFont,\"PingFang SC\",sans-serif;color:#06202d;background:#4cc2ff;box-shadow:0 6px 20px rgba(0,0,0,.35);}@media (orientation:landscape) and (max-height:520px){.bar{display:none;}.stage{max-height:100vh;max-height:100dvh;height:100vh;height:100dvh;aspect-ratio:auto;position:relative;}}";
const __BTRI_CONTEXT__ = {"mode":"overlay"};

/* ---- src/vendor-btr/range-core.js ---- */
(function installRangeCore(root) {
  "use strict";

  const MEDIA_SUFFIX_RE = /\.(?:m4s|mp4|flv)$/i;
  const MEDIA_HOST_RE = /(?:^|\.)(?:bilivideo\.(?:com|cn|net)|akamaized\.net|szbdyd\.com|hdslb\.com|xycdn\.com|mountaintoys\.cn|nexusedgeio\.com|ahdohpiechei\.com)$/i;

  function parseByteRange(value) {
    if (typeof value !== "string") return null;
    const match = /^(\d+)-(\d+)$/.exec(value.trim());
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
    return { start, end, length: end - start + 1 };
  }

  function parseRangeHeader(value) {
    if (typeof value !== "string") return null;
    const match = /^bytes=(\d+)-(\d+)$/i.exec(value.trim());
    return match ? parseByteRange(`${match[1]}-${match[2]}`) : null;
  }

  function parseContentRange(value) {
    if (typeof value !== "string") return null;
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = match[3] === "*" ? null : Number(match[3]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
    if (total !== null && (!Number.isSafeInteger(total) || total <= end)) return null;
    return { start, end, total, length: end - start + 1 };
  }

  function splitRange(start, end, concurrency, minChunkBytes = 128 * 1024) {
    const length = end - start + 1;
    const limit = Math.max(1, Math.min(512, Math.trunc(concurrency) || 1));
    const minimum = Math.max(32 * 1024, Math.trunc(minChunkBytes) || 128 * 1024);
    const count = Math.max(1, Math.min(limit, Math.ceil(length / minimum)));
    const base = Math.floor(length / count);
    const remainder = length % count;
    const pieces = [];
    let cursor = start;
    for (let index = 0; index < count; index += 1) {
      const size = base + (index < remainder ? 1 : 0);
      pieces.push({ index, start: cursor, end: cursor + size - 1, length: size });
      cursor += size;
    }
    return pieces;
  }

  function concatChunks(chunks, expectedLength) {
    const output = new Uint8Array(expectedLength);
    let offset = 0;
    for (const chunk of chunks) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (offset + bytes.byteLength > expectedLength) throw new RangeError("子区间超出目标长度");
      output.set(bytes, offset);
      offset += bytes.byteLength;
    }
    if (offset !== expectedLength) throw new RangeError(`子区间长度不符：${offset}/${expectedLength}`);
    return output;
  }

  function isBilibiliMediaUrl(value) {
    try {
      const url = new URL(value, root.location?.href);
      return url.protocol === "https:" && MEDIA_SUFFIX_RE.test(url.pathname) && MEDIA_HOST_RE.test(url.hostname);
    } catch (_error) {
      return false;
    }
  }

  function normalizeSettings(input) {
    const source = input && typeof input === "object" ? input : {};
    const allowed = [4, 8, 16, 32, 64, 128];
    const requested = Math.trunc(Number(source.concurrency));
    const danmakuSource = source.danmaku && typeof source.danmaku === "object" ? source.danmaku : {};
    const allowedAreas = ["quarter", "half", "threeQuarter", "full"];
    const allowedSpeeds = [1, 2.5, 5, 7.5, 10];
    const requestedSpeed = Number(danmakuSource.speed);
    const requestedModes = Array.isArray(danmakuSource.modes)
      ? [...new Set(danmakuSource.modes.map(Number).filter((value) => [0, 1, 2].includes(value)))]
      : [0, 1, 2];
    const requestedColor = String(danmakuSource.color || "").toUpperCase();
    const danmaku = {
      visible: danmakuSource.visible !== false,
      opacity: Math.max(0, Math.min(1, Number.isFinite(Number(danmakuSource.opacity)) ? Number(danmakuSource.opacity) : 0.9)),
      area: allowedAreas.includes(danmakuSource.area) ? danmakuSource.area : "threeQuarter",
      fontSize: Math.max(12, Math.min(64, Math.round(Number(danmakuSource.fontSize ?? source.danmakuFontSize) || 25))),
      speed: allowedSpeeds.includes(requestedSpeed) ? requestedSpeed : 5,
      modes: requestedModes,
      antiOverlap: danmakuSource.antiOverlap !== false,
      synchronousPlayback: danmakuSource.synchronousPlayback !== false,
      mode: [0, 1, 2].includes(Number(danmakuSource.mode)) ? Number(danmakuSource.mode) : 0,
      color: /^#[0-9A-F]{6}$/.test(requestedColor) ? requestedColor : "#FFFFFF"
    };
    const mode = source.mode === "overseas" ? "overseas" : "mainland";
    const compatibilityMode = ["a", "b"].includes(String(source.compatibilityMode || "").toLowerCase())
      ? String(source.compatibilityMode).toLowerCase()
      : "off";
    const requestedVolume = Number(source.volume);
    return {
      enabled: source.enabled !== false,
      mode,
      compatibilityMode,
      debugNotices: source.debugNotices === true,
      errorNotices: source.errorNotices === true,
      debugCategories: Object.fromEntries(["takeover", "playback", "download", "buffer", "settings", "other"].map(key => [key, source.debugCategories?.[key] !== false])),
      concurrency: allowed.includes(requested) ? requested : 8,
      volume: Number.isFinite(requestedVolume) ? Math.max(0, Math.min(1, requestedVolume)) : 0.7,
      subtitleLanguage: /^[\w-]+$/i.test(String(source.subtitleLanguage || "off"))
        ? String(source.subtitleLanguage).slice(0, 48)
        : "off",
      subtitleLastLanguage: /^[\w-]+$/i.test(String(source.subtitleLastLanguage || ""))
        && String(source.subtitleLastLanguage).toLowerCase() !== "off"
        ? String(source.subtitleLastLanguage).slice(0, 48)
        : "",
      danmaku,
      minChunkBytes: 64 * 1024,
      firstByteTimeoutMs: 5500,
      stallTimeoutMs: 4000,
      attemptTimeoutMs: 15000,
      hedgeDelayMs: 900,
      bufferAheadSeconds: 45
    };
  }

  root.__BILI_RANGE_CORE__ = Object.freeze({
    concatChunks,
    isBilibiliMediaUrl,
    normalizeSettings,
    parseByteRange,
    parseContentRange,
    parseRangeHeader,
    splitRange
  });
})(globalThis);

/* ---- src/vendor-btr/cdn-resolver.js ---- */
(function installCdnResolver(root) {
  "use strict";

  const core = root.__BILI_RANGE_CORE__;
  if (!core) return;

  const MAINLAND_HOSTS = Object.freeze([
    "upos-sz-mirrorali.bilivideo.com",
    "upos-sz-mirrorhw.bilivideo.com",
    "upos-sz-mirrorbos.bilivideo.com",
    "upos-sz-mirror08c.bilivideo.com",
    "upos-sz-mirrorbd.bilivideo.com",
    "upos-sz-mirror14b.bilivideo.com",
    "upos-sz-estgoss.bilivideo.com",
    "upos-sz-mirrorcos.bilivideo.com"
  ]);

  const OVERSEAS_HOSTS = Object.freeze([
    "upos-sz-mirrorcosov.bilivideo.com",
    "upos-sz-mirroraliov.bilivideo.com",
    "cn-hk-eq-01-01.bilivideo.com",
    "cn-hk-eq-01-03.bilivideo.com"
  ]);

  const GLOBAL_HOSTS = Object.freeze([
    ...OVERSEAS_HOSTS,
    ...MAINLAND_HOSTS
  ]);

  function isAkamaiUrl(value) {
    try { return new URL(value).hostname.toLowerCase().endsWith(".akamaized.net"); }
    catch (_error) { return false; }
  }

  function safeMediaUrl(value) {
    try {
      const url = new URL(String(value));
      return core.isBilibiliMediaUrl(url.href) ? url.href : null;
    } catch (_error) {
      return null;
    }
  }

  function swapOrdinaryHost(rawUrl, targetHost) {
    if (isAkamaiUrl(rawUrl)) return null;
    const host = String(targetHost || "").toLowerCase();
    if (!GLOBAL_HOSTS.includes(host)) return null;
    try {
      const url = new URL(rawUrl);
      url.host = host;
      return url.href;
    } catch (_error) {
      return null;
    }
  }

  function representationUrls(representation, mode) {
    const primary = representation?.baseUrl || representation?.base_url;
    const backup = representation?.backupUrl || representation?.backup_url || representation?.backup_url_list || [];
    const originals = [primary, ...(Array.isArray(backup) ? backup : [])]
      .map(safeMediaUrl)
      .filter(Boolean)
      .filter((value, index, all) => all.indexOf(value) === index);
    const donor = originals.find((url) => !isAkamaiUrl(url));
    const hosts = mode === "mainland" ? MAINLAND_HOSTS : OVERSEAS_HOSTS;
    const synthetic = donor ? hosts.map((host) => swapOrdinaryHost(donor, host)).map(safeMediaUrl).filter(Boolean) : [];
    const allowedOriginals = mode === "mainland"
      ? originals.filter((url) => MAINLAND_HOSTS.includes(new URL(url).hostname.toLowerCase()))
      : originals.filter((url) => !MAINLAND_HOSTS.includes(new URL(url).hostname.toLowerCase()));
    return [...allowedOriginals, ...synthetic].filter((value, index, all) => all.indexOf(value) === index);
  }

  function hostOf(value) {
    try { return new URL(value).hostname.toLowerCase(); }
    catch (_error) { return ""; }
  }

  // A CDN node that twice fails without sending a single byte is skipped for the
  // rest of the current video. The owner resets the list when the video changes.
  function createBanList(options = {}) {
    const limit = Math.max(1, Math.trunc(Number(options.limit)) || 2);
    const strikes = new Map();
    const banned = new Set();
    return Object.freeze({
      record(url, receivedBytes, error) {
        if (error?.name === "AbortError" || Number(receivedBytes) > 0) return false;
        const host = hostOf(url);
        if (!host || banned.has(host)) return false;
        const count = (strikes.get(host) || 0) + 1;
        strikes.set(host, count);
        if (count < limit) return false;
        banned.add(host);
        try { options.onBan?.(host, count, error); } catch (_error) {}
        return true;
      },
      allows: (url) => !banned.has(hostOf(url)),
      hosts: () => [...banned],
      reset() {
        strikes.clear();
        banned.clear();
      }
    });
  }

  function createResolver(representation, getMode, bans = null) {
    const health = new Map();
    let cursor = 0;
    let mediaRangeCount = 0;
    let rangeCursor = 0;

    function allUrls() {
      return representationUrls(representation, getMode?.() === "overseas" ? "overseas" : "mainland");
    }

    // Banned nodes are left out. If every node is banned, keep using them rather
    // than leaving the video with no download address at all.
    function unbanned(list) {
      if (!bans) return list;
      const allowed = list.filter(bans.allows);
      return allowed.length ? allowed : list;
    }

    function urls() {
      return unbanned(allUrls());
    }

    function ordered(pieceIndex = 0, exclude = new Set()) {
      const now = Date.now();
      const candidates = urls().filter((url) => !exclude.has(url));
      const available = candidates.filter((url) => (health.get(url)?.blockedUntil || 0) <= now);
      const pool = available.length ? available : candidates;
      if (!pool.length) return [];
      const offset = (cursor + pieceIndex) % pool.length;
      const rotated = pool.slice(offset).concat(pool.slice(0, offset));
      cursor = (cursor + 1) % pool.length;
      return rotated;
    }

    function rangeCandidates() {
      const now = Date.now();
      const pool = urls()
        .filter((url) => (health.get(url)?.blockedUntil || 0) <= now)
        .sort((a, b) => {
          const ah = health.get(a) || {};
          const bh = health.get(b) || {};
          return Number(Boolean(bh.lastSuccessAt)) - Number(Boolean(ah.lastSuccessAt)) ||
            (bh.bps || 0) - (ah.bps || 0);
        });
      if (!pool.length) return urls();
      const firstRange = mediaRangeCount === 0;
      const width = Math.min(firstRange ? pool.length : 3, pool.length);
      let selected;
      const warmupRanges = getMode?.() === "mainland" ? 1 : 4;
      if (mediaRangeCount < warmupRanges) {
        selected = pool.slice(0, width);
        rangeCursor = width % pool.length;
      } else {
        const offset = rangeCursor % pool.length;
        const rotated = pool.slice(offset).concat(pool.slice(0, offset));
        selected = rotated.slice(0, width);
        rangeCursor = (rangeCursor + width) % pool.length;
      }
      mediaRangeCount += 1;
      return selected;
    }

    function startupCandidates() {
      const now = Date.now();
      const primary = representation?.baseUrl || representation?.base_url;
      const backup = representation?.backupUrl || representation?.backup_url || representation?.backup_url_list || [];
      const originals = [primary, ...(Array.isArray(backup) ? backup : [])]
        .map(safeMediaUrl)
        .filter(Boolean);
      const candidates = unbanned([...originals, ...allUrls()]
        .filter((url, index, all) => all.indexOf(url) === index))
        .filter((url) => (health.get(url)?.blockedUntil || 0) <= now);
      return candidates.slice(0, 8);
    }

    function rescueCandidates() {
      const now = Date.now();
      return urls()
        .filter((url) => (health.get(url)?.blockedUntil || 0) <= now)
        .sort((a, b) => {
          const ah = health.get(a) || {};
          const bh = health.get(b) || {};
          return Number(Boolean(bh.lastSuccessAt)) - Number(Boolean(ah.lastSuccessAt)) ||
            (bh.bps || 0) - (ah.bps || 0);
        });
    }

    function success(url, bps) {
      const old = health.get(url) || {};
      health.set(url, {
        failures: 0,
        blockedUntil: 0,
        lastSuccessAt: Date.now(),
        bps: old.bps ? old.bps * 0.65 + bps * 0.35 : bps
      });
    }

    function failure(url, error, receivedBytes = 0) {
      if (error?.name === "AbortError") return;
      bans?.record(url, receivedBytes, error);
      const old = health.get(url) || {};
      const failures = (old.failures || 0) + 1;
      health.set(url, {
        ...old,
        failures,
        blockedUntil: Date.now() + Math.min(60000, 3000 * (2 ** Math.min(failures, 4)))
      });
    }

    function status() {
      const now = Date.now();
      return allUrls().map((url) => {
        const item = health.get(url) || {};
        return {
          host: new URL(url).hostname,
          state: bans && !bans.allows(url) ? "banned" : (item.blockedUntil || 0) > now ? "blocked" : item.lastSuccessAt ? "healthy" : "untested",
          bps: item.bps || 0
        };
      });
    }

    const allows = (url) => !bans || bans.allows(url);
    return Object.freeze({ allows, failure, ordered, rangeCandidates, rescueCandidates, startupCandidates, status, success, urls });
  }

  root.__BILI_CDN_RESOLVER_FACTORY__ = Object.freeze({
    GLOBAL_HOSTS,
    MAINLAND_HOSTS,
    OVERSEAS_HOSTS,
    createBanList,
    createResolver,
    isAkamaiUrl,
    representationUrls,
    swapOrdinaryHost
  });
})(globalThis);

/* ---- src/vendor-btr/sidx.js ---- */
(function installSidx(root) {
  "use strict";

  function readUint64(view, offset) {
    const value = view.getUint32(offset) * (2 ** 32) + view.getUint32(offset + 4);
    return Number.isSafeInteger(value) ? value : null;
  }

  function readType(bytes, offset) {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  }

  function parseSidx(buffer, absoluteStart = 0) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let boxOffset = 0;

    while (boxOffset + 8 <= bytes.byteLength) {
      let boxSize = view.getUint32(boxOffset);
      const type = readType(bytes, boxOffset + 4);
      let headerSize = 8;
      if (boxSize === 1) {
        if (boxOffset + 16 > bytes.byteLength) return null;
        boxSize = readUint64(view, boxOffset + 8);
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = bytes.byteLength - boxOffset;
      }
      if (!boxSize || boxSize < headerSize || boxOffset + boxSize > bytes.byteLength) return null;

      if (type === "sidx") {
        let cursor = boxOffset + headerSize;
        if (cursor + 12 > boxOffset + boxSize) return null;
        const version = view.getUint8(cursor);
        cursor += 4;
        cursor += 4;
        const timescale = view.getUint32(cursor);
        cursor += 4;
        if (!timescale) return null;

        let earliestPresentationTime;
        let firstOffset;
        if (version === 0) {
          if (cursor + 8 > boxOffset + boxSize) return null;
          earliestPresentationTime = view.getUint32(cursor);
          firstOffset = view.getUint32(cursor + 4);
          cursor += 8;
        } else if (version === 1) {
          if (cursor + 16 > boxOffset + boxSize) return null;
          earliestPresentationTime = readUint64(view, cursor);
          firstOffset = readUint64(view, cursor + 8);
          cursor += 16;
          if (earliestPresentationTime === null || firstOffset === null) return null;
        } else {
          return null;
        }

        cursor += 2;
        if (cursor + 2 > boxOffset + boxSize) return null;
        const referenceCount = view.getUint16(cursor);
        cursor += 2;
        if (referenceCount < 1 || referenceCount > 10000 || cursor + referenceCount * 12 > boxOffset + boxSize) return null;

        let byteCursor = absoluteStart + boxOffset + boxSize + firstOffset;
        let timeCursor = earliestPresentationTime;
        const segments = [];
        for (let index = 0; index < referenceCount; index += 1) {
          const reference = view.getUint32(cursor);
          const referenceType = reference >>> 31;
          const referencedSize = reference & 0x7fffffff;
          const duration = view.getUint32(cursor + 4);
          cursor += 12;
          if (!referencedSize) return null;
          if (referenceType === 0) {
            segments.push({
              index: segments.length,
              start: byteCursor,
              end: byteCursor + referencedSize - 1,
              length: referencedSize,
              time: timeCursor,
              duration,
              startTime: timeCursor / timescale,
              endTime: (timeCursor + duration) / timescale,
              durationSeconds: duration / timescale
            });
          }
          byteCursor += referencedSize;
          timeCursor += duration;
        }
        if (!segments.length) return null;
        return { earliestPresentationTime, firstOffset, segments, timescale };
      }
      boxOffset += boxSize;
    }
    return null;
  }

  function segmentIndexAt(segments, seconds) {
    if (!Array.isArray(segments) || !segments.length) return -1;
    const target = Math.max(0, Number(seconds) || 0);
    let low = 0;
    let high = segments.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const segment = segments[middle];
      if (target < segment.startTime) high = middle - 1;
      else if (target >= segment.endTime) low = middle + 1;
      else return middle;
    }
    return Math.max(0, Math.min(segments.length - 1, low));
  }

  root.__BILI_SIDX__ = Object.freeze({ parseSidx, segmentIndexAt });
})(globalThis);

/* ---- src/vendor-btr/idm-downloader.js ---- */
(function installIdmDownloader(root) {
  "use strict";

  const core = root.__BILI_RANGE_CORE__;
  if (!core) return;

  function abortError(reason) {
    if (reason instanceof Error || reason instanceof DOMException) return reason;
    return new DOMException("播放器任务已取消", "AbortError");
  }

  class Semaphore {
    constructor(limit) {
      this.limit = limit;
      this.active = 0;
      this.queue = [];
      this.sequence = 0;
    }

    setLimit(limit) {
      this.limit = Math.max(1, Math.min(512, Math.trunc(limit) || 1));
      this.drain();
    }

    drain() {
      while (this.active < this.limit && this.queue.length) {
        const entry = this.queue.shift();
        if (entry.signal?.aborted) {
          entry.reject(abortError(entry.signal.reason));
          continue;
        }
        this.active += 1;
        entry.resolve(() => {
          if (entry.released) return;
          entry.released = true;
          this.active = Math.max(0, this.active - 1);
          this.drain();
        });
      }
    }

    acquire(signal, priority = 0) {
      if (signal?.aborted) return Promise.reject(abortError(signal.reason));
      return new Promise((resolve, reject) => {
        const entry = {
          reject,
          resolve,
          signal,
          released: false,
          priority: Number(priority) || 0,
          sequence: this.sequence++
        };
        this.queue.push(entry);
        this.queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
        this.drain();
      });
    }
  }

  function createDownloader(options) {
    const nativeFetch = options.nativeFetch || root.fetch.bind(root);
    const getSettings = options.getSettings;
    const onTransfer = typeof options.onTransfer === "function" ? options.onTransfer : () => null;
    const semaphore = new Semaphore(core.normalizeSettings(getSettings()).concurrency);

    async function readBody(response, controller, transferId, settings, received) {
      if (!response.body?.getReader) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        received.bytes += bytes.byteLength;
        onTransfer({ phase: "progress", id: transferId, bytes: bytes.byteLength });
        return bytes;
      }
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      let stallTimer = null;
      const armStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => controller.abort(new DOMException("CDN 子块停止传输", "TimeoutError")), settings.stallTimeoutMs);
      };
      armStall();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          armStall();
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          chunks.push(chunk);
          total += chunk.byteLength;
          received.bytes += chunk.byteLength;
          onTransfer({ phase: "progress", id: transferId, bytes: chunk.byteLength });
        }
      } finally {
        clearTimeout(stallTimer);
        reader.releaseLock?.();
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }

    async function attempt(piece, url, signal, kind, resolver, priority = 0) {
      const settings = core.normalizeSettings(getSettings());
      const release = await semaphore.acquire(signal, priority);
      const controller = new AbortController();
      const cancel = () => controller.abort(abortError(signal?.reason));
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
      const firstByteTimer = setTimeout(() => controller.abort(new DOMException("CDN 首字节超时", "TimeoutError")), settings.firstByteTimeoutMs);
      const totalTimer = setTimeout(() => controller.abort(new DOMException("CDN 子块总耗时超限", "TimeoutError")), settings.attemptTimeoutMs);
      const transferId = onTransfer({ phase: "start", kind, totalBytes: piece.length, url });
      const startedAt = performance.now();
      const received = { bytes: 0 };
      try {
        const response = await nativeFetch(url, {
          method: "GET",
          headers: { Range: `bytes=${piece.start}-${piece.end}` },
          credentials: "omit",
          cache: "no-store",
          mode: "cors",
          referrer: root.location?.href,
          referrerPolicy: "strict-origin-when-cross-origin",
          signal: controller.signal
        });
        clearTimeout(firstByteTimer);
        const contentRange = core.parseContentRange(response.headers.get("content-range"));
        if (response.status !== 206 || !contentRange || contentRange.start !== piece.start || contentRange.end !== piece.end) {
          throw new Error(`Range 校验失败：HTTP ${response.status}`);
        }
        const bytes = await readBody(response, controller, transferId, settings, received);
        if (bytes.byteLength !== piece.length) throw new Error(`子块长度不符：${bytes.byteLength}/${piece.length}`);
        const seconds = Math.max(0.001, (performance.now() - startedAt) / 1000);
        resolver.success(url, bytes.byteLength / seconds);
        onTransfer({ phase: "done", id: transferId });
        return { bytes, total: contentRange.total, url };
      } catch (error) {
        // Received bytes tell a dead node (0 KiB) apart from a transfer that stalled midway.
        resolver.failure(url, error, received.bytes);
        const canceled = error?.name === "AbortError";
        onTransfer({ phase: canceled ? "cancel" : "error", id: transferId, error });
        throw error;
      } finally {
        clearTimeout(firstByteTimer);
        clearTimeout(totalTimer);
        signal?.removeEventListener("abort", cancel);
        release();
      }
    }

    async function downloadPiece(piece, resolver, signal, kind, preferredUrls, startupMode = false, priority = 0) {
      const preferred = Array.isArray(preferredUrls) ? preferredUrls : [];
      const preferredOffset = preferred.length ? piece.index % preferred.length : 0;
      const rotatedPreferred = preferred.slice(preferredOffset).concat(preferred.slice(0, preferredOffset));
      const rescue = (typeof resolver.rescueCandidates === "function" ? resolver.rescueCandidates() : resolver.ordered(piece.index))
        .filter((url) => !rotatedPreferred.includes(url));
      const candidates = [];
      const width = Math.max(rotatedPreferred.length, rescue.length);
      for (let index = 0; index < width; index += 1) {
        if (rotatedPreferred[index]) candidates.push(rotatedPreferred[index]);
        if (rescue[index]) candidates.push(rescue[index]);
      }
      for (const url of resolver.ordered(piece.index)) {
        if (!candidates.includes(url)) candidates.push(url);
      }
      const settings = core.normalizeSettings(getSettings());
      const limit = Math.min(8, candidates.length);
      const allowed = (url) => typeof resolver.allows !== "function" || resolver.allows(url);
      const tried = new Set();
      let lastError = null;

      const startup = startupMode === true || startupMode === "probe";
      const probe = startupMode === "probe";
      const batchWidth = probe ? limit : 2;
      while (tried.size < limit) {
        if (signal?.aborted) throw abortError(signal.reason);
        // A node banned while this piece was waiting is skipped, unless only banned nodes are left.
        const untried = candidates.filter((url) => !tried.has(url));
        const open = untried.filter(allowed);
        const pair = (open.length ? open : untried).slice(0, batchWidth);
        if (!pair.length) break;
        pair.forEach((url) => tried.add(url));
        const controllers = pair.map(() => new AbortController());
        const cancelAll = () => controllers.forEach((controller) => controller.abort(abortError(signal?.reason)));
        if (signal?.aborted) cancelAll();
        else signal?.addEventListener("abort", cancelAll, { once: true });
        const attempts = pair.map((url, pairIndex) => (async () => {
          if (pairIndex) await new Promise((resolve, reject) => {
            const delay = probe ? 0 : startup ? Math.min(250, settings.hedgeDelayMs) : settings.hedgeDelayMs;
            const timer = setTimeout(resolve, delay);
            const canceled = () => {
              clearTimeout(timer);
              reject(abortError(controllers[pairIndex].signal.reason));
            };
            if (controllers[pairIndex].signal.aborted) canceled();
            else controllers[pairIndex].signal.addEventListener("abort", canceled, { once: true });
          });
          return attempt(piece, url, controllers[pairIndex].signal, kind, resolver, priority + (pairIndex ? 20 : 0));
        })());
        try {
          const winner = await Promise.any(attempts);
          controllers.forEach((controller) => {
            if (!controller.signal.aborted) controller.abort(new DOMException("并发副本已取消", "AbortError"));
          });
          return winner;
        } catch (aggregate) {
          lastError = aggregate?.errors?.at?.(-1) || aggregate;
          if (signal?.aborted) throw abortError(signal.reason);
        } finally {
          signal?.removeEventListener("abort", cancelAll);
        }
      }
      throw lastError || new Error("没有可用 CDN");
    }

    async function delayedAttempt(piece, url, delayMs, signal, kind, resolver, controller, priority = 0) {
      if (delayMs > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          const canceled = () => {
            clearTimeout(timer);
            reject(abortError(controller.signal.reason));
          };
          if (controller.signal.aborted) canceled();
          else controller.signal.addEventListener("abort", canceled, { once: true });
        });
      }
      if (signal?.aborted) throw abortError(signal.reason);
      return attempt(piece, url, controller.signal, kind, resolver, priority);
    }

    async function downloadStartupRange(range, resolver, options) {
      const candidates = (typeof resolver.startupCandidates === "function" ? resolver.startupCandidates() : resolver.urls())
        .filter((url, index, all) => all.indexOf(url) === index)
        .slice(0, 3);
      if (!candidates.length) throw new Error("没有可用 CDN");
      semaphore.setLimit(core.normalizeSettings(getSettings()).concurrency);
      const piece = { index: 0, start: range.start, end: range.end, length: range.length };
      const controllers = candidates.map(() => new AbortController());
      const cancelAll = () => controllers.forEach((controller) => {
        if (!controller.signal.aborted) controller.abort(abortError(options.signal?.reason));
      });
      if (options.signal?.aborted) cancelAll();
      else options.signal?.addEventListener("abort", cancelAll, { once: true });
      try {
        let winner;
        try {
          winner = await Promise.any(candidates.map((url, index) => delayedAttempt(
            piece,
            url,
            index === 0 ? 0 : index === 1 ? 120 : 300,
            options.signal,
            options.kind || "meta",
            resolver,
            controllers[index],
            220
          )));
        } catch (aggregate) {
          if (options.signal?.aborted) throw abortError(options.signal.reason);
          throw aggregate?.errors?.at?.(-1) || aggregate;
        }
        controllers.forEach((controller) => {
          if (!controller.signal.aborted) controller.abort(new DOMException("并发副本已取消", "AbortError"));
        });
        return {
          bytes: winner.bytes,
          pieceCount: 1,
          total: winner.total || null,
          hosts: [new URL(winner.url).hostname]
        };
      } finally {
        options.signal?.removeEventListener("abort", cancelAll);
      }
    }

    async function downloadStartupMediaRange(range, resolver, options, settings) {
      const effectiveConcurrency = settings.concurrency;
      semaphore.setLimit(effectiveConcurrency);
      const candidateUrls = (typeof resolver.rangeCandidates === "function" ? resolver.rangeCandidates() : resolver.urls())
        .filter((url, index, all) => all.indexOf(url) === index);
      const headLength = Math.min(range.length, Math.max(64 * 1024, settings.minChunkBytes));
      const head = {
        index: 0,
        start: range.start,
        end: range.start + headLength - 1,
        length: headLength
      };
      const headResult = await downloadPiece(
        head,
        resolver,
        options.signal,
        options.kind || "media",
        candidateUrls,
        "probe",
        220
      );
      await options.onOrderedChunk(headResult.bytes, head);
      if (head.end >= range.end) {
        options.onStartupScheduled?.();
        return {
          bytes: null,
          byteLength: range.length,
          pieceCount: 1,
          streamed: true,
          total: headResult.total || null,
          hosts: [new URL(headResult.url).hostname]
        };
      }

      const rescueReserve = Math.max(1, Math.min(16, Math.ceil(effectiveConcurrency / 8)));
      const mediaBudget = Math.max(1, effectiveConcurrency - rescueReserve);
      const audioBudget = Math.max(1, Math.min(mediaBudget, Math.ceil(effectiveConcurrency / 8)));
      const pieceBudget = options.kind === "audio"
        ? audioBudget
        : Math.max(1, mediaBudget - audioBudget);
      const pieces = core.splitRange(
        head.end + 1,
        range.end,
        pieceBudget,
        settings.minChunkBytes
      ).map((piece, index) => ({ ...piece, index: index + 1 }));
      const ordered = new Array(pieces.length);
      let nextOrderedIndex = 0;
      let flushOperation = Promise.resolve();
      const flushOrdered = () => {
        flushOperation = flushOperation.then(async () => {
          while (ordered[nextOrderedIndex]) {
            const item = ordered[nextOrderedIndex];
            ordered[nextOrderedIndex] = null;
            await options.onOrderedChunk(item.bytes, pieces[nextOrderedIndex]);
            nextOrderedIndex += 1;
          }
        });
        return flushOperation;
      };
      const pendingPieces = pieces.map(async (piece, orderedIndex) => {
        const result = await downloadPiece(
          piece,
          resolver,
          options.signal,
          options.kind || "media",
          [headResult.url],
          true,
          120 - Math.min(30, piece.index)
        );
        ordered[orderedIndex] = result;
        await flushOrdered();
        return result;
      });
      options.onStartupScheduled?.();
      const results = await Promise.all(pendingPieces);
      await flushOperation;
      const totals = [headResult, ...results].map((item) => item.total).filter(Number.isSafeInteger);
      if (totals.length && totals.some((value) => value !== totals[0])) throw new Error("不同 CDN 返回的文件总长度不一致");
      return {
        bytes: null,
        byteLength: range.length,
        pieceCount: pieces.length + 1,
        streamed: true,
        total: totals[0] || null,
        hosts: [...new Set([headResult, ...results].map((item) => new URL(item.url).hostname))]
      };
    }

    async function downloadRange(range, resolver, options = {}) {
      const settings = core.normalizeSettings(getSettings());
      if (options.kind === "meta") return downloadStartupRange(range, resolver, options);
      const parallel = options.parallel !== false;
      if (options.startup === true && parallel && typeof options.onOrderedChunk === "function") {
        return downloadStartupMediaRange(range, resolver, options, settings);
      }
      const preferredUrls = parallel && typeof resolver.rangeCandidates === "function"
        ? resolver.rangeCandidates()
        : resolver.urls();
      const globalConcurrency = parallel ? settings.concurrency : 1;
      const requestedConcurrency = Number.isFinite(Number(options.maxConcurrency))
        ? Math.max(1, Math.trunc(Number(options.maxConcurrency)))
        : globalConcurrency;
      const effectiveConcurrency = parallel ? Math.min(globalConcurrency, requestedConcurrency) : 1;
      // 后台预取可以限制自己的子块数，但不能降低全局信号量上限；
      // 否则一个低优先级预取会把后续播放器的紧急请求也锁在低并发上。
      semaphore.setLimit(globalConcurrency);
      const basePriority = Number.isFinite(Number(options.priority)) ? Number(options.priority) : 50;
      const rescueReserve = parallel && effectiveConcurrency >= 8
        ? Math.min(8, Math.max(1, Math.ceil(effectiveConcurrency / 8)))
        : 0;
      const pieceConcurrency = options.startup === true
        ? Math.max(1, Math.min(22, effectiveConcurrency))
        : Math.max(1, effectiveConcurrency - rescueReserve);
      const pieces = core.splitRange(
        range.start,
        range.end,
        pieceConcurrency,
        parallel ? settings.minChunkBytes : Number.MAX_SAFE_INTEGER
      );
      const progressive = typeof options.onOrderedChunk === "function";
      const ordered = new Array(pieces.length);
      let nextOrderedIndex = 0;
      let flushOperation = Promise.resolve();
      const flushOrdered = () => {
        flushOperation = flushOperation.then(async () => {
          while (ordered[nextOrderedIndex]) {
            const item = ordered[nextOrderedIndex];
            ordered[nextOrderedIndex] = null;
            await options.onOrderedChunk(item.bytes, pieces[nextOrderedIndex]);
            nextOrderedIndex += 1;
          }
        });
        return flushOperation;
      };
      const results = await Promise.all(pieces.map(async (piece) => {
        const result = await downloadPiece(
          piece,
          resolver,
          options.signal,
          options.kind || "media",
          preferredUrls,
          options.startup === true,
          basePriority - Math.min(20, piece.index)
        );
        if (progressive) {
          ordered[piece.index] = result;
          await flushOrdered();
        }
        return result;
      }));
      if (progressive) await flushOperation;
      const totals = results.map((item) => item.total).filter(Number.isSafeInteger);
      if (totals.length && totals.some((value) => value !== totals[0])) throw new Error("不同 CDN 返回的文件总长度不一致");
      return {
        bytes: progressive ? null : core.concatChunks(results.map((item) => item.bytes), range.length),
        byteLength: range.length,
        pieceCount: pieces.length,
        streamed: progressive,
        total: totals[0] || null,
        hosts: [...new Set(results.map((item) => new URL(item.url).hostname))]
      };
    }

    return Object.freeze({ downloadRange });
  }

  root.__BILI_IDM_DOWNLOADER_FACTORY__ = Object.freeze({ createDownloader });
})(globalThis);

/* ---- src/app/engine.js ---- */
/*
 * BTR-iOS playback engine.
 *
 * Adapted from Bilibili-thread-ripper (MIT, © 2026 Bilibili-thread-ripper contributors),
 * src/native-mse-player.js @ 0.9.1.3. The buffering strategy (startup profile, progressive
 * first segment, ordered multi-Range pieces, prune/seek/end-of-stream handling) is upstream's.
 *
 * What is different here, because this runs in iOS / iPadOS Safari instead of desktop Chrome:
 *   - iPhone has no MediaSource. It only has ManagedMediaSource (iOS 17.1+), which needs
 *     remote playback disabled, is attached through a <source> child, may evict buffered
 *     data whenever it likes and tells us when it wants data (startstreaming/endstreaming).
 *   - We own the <video> element (one persistent element, so a single user tap unlocks
 *     programmatic play() for every later video); there is no Bilibili player to hand back to.
 *   - SourceBuffer quotas are small on iOS, so QuotaExceededError is an expected event and the
 *     look-ahead target is sized in bytes as well as seconds.
 *   - Small timeline gaps and evicted ranges are repaired instead of being left to stall.
 *   - Codec families that turn out not to decode are dropped and the next one is tried.
 */
(function installBtrIosEngine(root) {
  "use strict";

  const core = root.__BILI_RANGE_CORE__;
  const sidxTools = root.__BILI_SIDX__;
  const resolverFactory = root.__BILI_CDN_RESOLVER_FACTORY__;
  const downloaderFactory = root.__BILI_IDM_DOWNLOADER_FACTORY__;
  if (!core || !sidxTools || !resolverFactory || !downloaderFactory) return;

  const STARTUP_BUFFER_MIN_SECONDS = 2.5;
  const STARTUP_BUFFER_MAX_SECONDS = 10;
  const STARTUP_RECOVERY_SECONDS = 6;
  const STARTUP_PROTECTION_MS = 20000;
  const SOURCE_OPEN_TIMEOUT_MS = 10000;
  const MAX_AHEAD_SECONDS = 45;
  const MIN_AHEAD_SECONDS = 12;
  const DEFAULT_AHEAD_BYTES = 96 * 1024 * 1024;
  const MIN_AHEAD_BYTES = 12 * 1024 * 1024;
  const IDLE_STREAMING_AHEAD_SECONDS = 15;
  const ENGINE_PAUSE_WINDOW_MS = 400;
  const QUALITY_NAMES = Object.freeze({
    127: "8K", 126: "杜比视界", 125: "HDR", 120: "4K", 116: "1080P 60帧",
    112: "1080P 高码率", 80: "1080P", 74: "720P 60帧", 64: "720P",
    32: "480P", 16: "360P", 6: "240P"
  });
  const QUALITY_HEIGHTS = Object.freeze({ 127: 4320, 126: 2160, 125: 2160, 120: 2160, 116: 1080, 112: 1080, 80: 1080, 74: 720, 64: 720, 32: 480, 16: 360, 6: 240 });
  const CODEC_LABELS = Object.freeze({ av1: "AV1", hevc: "HEVC", avc: "AVC", other: "" });

  /* ------------------------------------------------------------------ *
   * Media Source flavour
   * ------------------------------------------------------------------ */

  // Plain MediaSource is used wherever it exists (iPad, Mac, desktop browsers): that is the
  // path upstream runs on every day. ManagedMediaSource is the only choice on iPhone.
  function mediaSourceFlavour(preference) {
    const plain = typeof root.MediaSource === "function" ? root.MediaSource : null;
    const managed = typeof root.ManagedMediaSource === "function" ? root.ManagedMediaSource : null;
    if (preference === "mms" && managed) return { ctor: managed, managed: true };
    if (preference === "mse" && plain) return { ctor: plain, managed: false };
    if (plain) return { ctor: plain, managed: false };
    if (managed) return { ctor: managed, managed: true };
    return null;
  }

  function isSupportedPlatform() {
    return Boolean(mediaSourceFlavour("auto"));
  }

  // Every browser on iPhone / iPad is WebKit; on the Mac it is Safari (iPadOS also says "Macintosh").
  function isAppleWebKit() {
    const agent = String(root.navigator?.userAgent || "");
    if (/iP(?:hone|ad|od)/.test(agent)) return true;
    return /Macintosh/.test(agent) && /Safari\//.test(agent) && !/Chrom(?:e|ium)|Edg\/|OPR\//.test(agent);
  }

  /*
   * Bilibili labels its HEVC streams "hev1" (parameter sets may also travel inside the stream).
   * Apple's media stack only takes HEVC that is labelled "hvc1" (parameter sets in the header).
   * Bilibili's files do carry the parameter sets in the header as well, so on Apple devices the
   * label is changed: in the codec string, and in the four bytes of the sample entry inside the
   * initialisation segment. Dolby Vision has the same pair of names (dvhe / dvh1).
   */
  const APPLE_CODEC_LABELS = Object.freeze({ hev1: "hvc1", dvhe: "dvh1" });

  function appleCodecString(codecs) {
    const text = String(codecs || "");
    const label = text.slice(0, 4).toLowerCase();
    return APPLE_CODEC_LABELS[label] ? `${APPLE_CODEC_LABELS[label]}${text.slice(4)}` : text;
  }

  function findBox(bytes, start, end, type) {
    let offset = start;
    while (offset + 8 <= end) {
      const size = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
      const name = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      const boxEnd = size === 0 ? end : offset + size;
      if (size === 1 || (size !== 0 && size < 8) || boxEnd > end) return null;
      if (name === type) return { start: offset, end: boxEnd, payload: offset + 8 };
      offset = boxEnd;
    }
    return null;
  }

  // Returns a copy with the sample entry renamed, or the input itself when there is nothing to do.
  function relabelSampleEntryForApple(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let box = { payload: 0, end: bytes.byteLength };
    for (const type of ["moov", "trak", "mdia", "minf", "stbl", "stsd"]) {
      box = findBox(bytes, box.payload, box.end, type);
      if (!box) return input;
    }
    // stsd: version+flags (4), entry count (4), then the first entry: size (4), type (4)
    const typeOffset = box.payload + 8 + 4;
    if (typeOffset + 4 > box.end) return input;
    const label = String.fromCharCode(bytes[typeOffset], bytes[typeOffset + 1], bytes[typeOffset + 2], bytes[typeOffset + 3]);
    const wanted = APPLE_CODEC_LABELS[label];
    if (!wanted) return input;
    const output = new Uint8Array(bytes);
    for (let index = 0; index < 4; index += 1) output[typeOffset + index] = wanted.charCodeAt(index);
    return output;
  }

  /* ------------------------------------------------------------------ *
   * Play-list helpers (shape of /x/player/playurl with fnval=4048)
   * ------------------------------------------------------------------ */

  function dashBody(playinfo) {
    return playinfo?.data?.dash ? playinfo.data : playinfo?.result?.dash ? playinfo.result : playinfo;
  }

  function mimeFor(representation, fallbackKind) {
    const mime = representation?.mimeType || representation?.mime_type || `${fallbackKind}/mp4`;
    const codecs = representation?.codecs || representation?.codec;
    return codecs ? `${mime}; codecs="${codecs}"` : mime;
  }

  function frameRate(representation) {
    const raw = String(representation?.frameRate || representation?.frame_rate || "0");
    if (!raw.includes("/")) return Number(raw) || 0;
    const [top, bottom] = raw.split("/").map(Number);
    return bottom ? top / bottom : 0;
  }

  function codecFamily(representation) {
    const codec = String(representation?.codecs || representation?.codec || "").toLowerCase();
    const codecId = Number(representation?.codecid || representation?.codec_id);
    if (codec.startsWith("av01") || codecId === 13) return "av1";
    if (codec.startsWith("hev1") || codec.startsWith("hvc1") || codec.startsWith("dvh1") || codec.startsWith("dvhe") || codecId === 12) return "hevc";
    if (codec.startsWith("avc1") || codec.startsWith("avc3") || codecId === 7) return "avc";
    return "other";
  }

  function qualityLabel(representation) {
    const id = Number(representation?.id);
    const fps = frameRate(representation);
    if (QUALITY_NAMES[id]) {
      const label = QUALITY_NAMES[id];
      return fps >= 50 && !label.includes("60帧") && [120, 80, 64, 32, 16].includes(id)
        ? `${label} ${Math.round(fps)}帧`
        : label;
    }
    const height = Number(representation?.height) || 0;
    const label = height >= 2160 ? "4K" : height ? `${height}P` : `清晰度 ${id || "?"}`;
    return fps >= 50 ? `${label} ${Math.round(fps)}帧` : label;
  }

  function representationUrl(representation) {
    return String(representation?.baseUrl || representation?.base_url || "");
  }

  function backupUrls(representation) {
    const backup = representation?.backupUrl || representation?.backup_url || representation?.backup_url_list || [];
    return Array.isArray(backup) ? backup.map(String) : [];
  }

  function sameRepresentation(left, right) {
    const path = (representation) => {
      try { return new URL(representationUrl(representation)).pathname; }
      catch (_error) { return representationUrl(representation); }
    };
    return Number(left?.id) === Number(right?.id)
      && codecFamily(left) === codecFamily(right)
      && path(left) === path(right);
  }

  function segmentBase(representation) {
    const base = representation?.segment_base || representation?.segmentBase || representation?.SegmentBase || {};
    const init = core.parseByteRange(base.initialization || base.Initialization || base.initialization_range);
    const index = core.parseByteRange(base.index_range || base.indexRange || base.IndexRange);
    if (!init || !index) throw new Error("播放清单缺少初始化或 SIDX 字节范围");
    return { init, index };
  }

  // Upstream only synthesises mainland URLs from a non-Akamai "donor" address. Overseas
  // accounts sometimes get nothing but Akamai addresses; then every mainland route would be
  // missing and the video could not start at all. The path and signature of an Akamai address
  // are accepted by the ordinary mirrors (the reverse is not true), so as a last resort one
  // ordinary-host copy is added to the backup list. Akamai's own token parameter is dropped.
  function withDonorUrl(representation) {
    const all = [representationUrl(representation), ...backupUrls(representation)].filter(Boolean);
    const hasOrdinary = all.some((value) => core.isBilibiliMediaUrl(value) && !resolverFactory.isAkamaiUrl(value));
    if (hasOrdinary || !all.length) return representation;
    const akamai = all.find((value) => core.isBilibiliMediaUrl(value));
    if (!akamai) return representation;
    try {
      const url = new URL(akamai);
      url.host = resolverFactory.MAINLAND_HOSTS[0];
      url.searchParams.delete("hdnts");
      return { ...representation, backupUrl: [...backupUrls(representation), url.href] };
    } catch (_error) {
      return representation;
    }
  }

  function abortError(message = "播放任务已取消") {
    return new DOMException(message, "AbortError");
  }

  function waitEvent(target, successName, errorName = "error", signal = null, timeoutMs = 0, timeoutMessage = "") {
    return new Promise((resolve, reject) => {
      let timer = null;
      const abortReason = () => signal?.reason instanceof Error ? signal.reason : abortError();
      const success = () => { cleanup(); resolve(); };
      const failure = () => { cleanup(); reject(new Error(`${successName} 失败`)); };
      const aborted = () => { cleanup(); reject(abortReason()); };
      const cleanup = () => {
        clearTimeout(timer);
        target.removeEventListener(successName, success);
        target.removeEventListener(errorName, failure);
        signal?.removeEventListener("abort", aborted);
      };
      if (signal?.aborted) {
        reject(abortReason());
        return;
      }
      target.addEventListener(successName, success, { once: true });
      target.addEventListener(errorName, failure, { once: true });
      signal?.addEventListener("abort", aborted, { once: true });
      if (timeoutMs > 0) timer = setTimeout(() => { cleanup(); reject(new Error(timeoutMessage || `${successName} 超时`)); }, timeoutMs);
    });
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(done, ms);
      function done() { signal?.removeEventListener("abort", canceled); resolve(); }
      function canceled() { clearTimeout(timer); reject(abortError()); }
      if (signal?.aborted) canceled();
      else signal?.addEventListener("abort", canceled, { once: true });
    });
  }

  function bufferedRanges(sourceBuffer) {
    try { return sourceBuffer?.buffered || null; }
    catch (_error) { return null; }
  }

  function isBufferedAt(sourceBuffer, time) {
    const ranges = bufferedRanges(sourceBuffer);
    if (!ranges) return false;
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) <= time + 0.25 && ranges.end(index) >= time - 0.25) return true;
    }
    return false;
  }

  function isStrictlyBufferedAt(sourceBuffer, time) {
    const ranges = bufferedRanges(sourceBuffer);
    if (!ranges) return false;
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) <= time && ranges.end(index) > time + 0.05) return true;
    }
    return false;
  }

  // End of the buffered run that contains `time`. Ranges separated by less than `joinGap`
  // seconds count as one run: audio and video fragments rarely end on the same millisecond.
  function bufferedEndAt(sourceBuffer, time, joinGap = 0.2) {
    const ranges = bufferedRanges(sourceBuffer);
    if (!ranges) return time;
    let end = null;
    for (let index = 0; index < ranges.length; index += 1) {
      const start = ranges.start(index);
      const stop = ranges.end(index);
      if (end === null) {
        if (start <= time + 0.25 && stop >= time - 0.25) end = stop;
      } else if (start - end <= joinGap) {
        end = Math.max(end, stop);
      } else {
        break;
      }
    }
    return end === null ? time : end;
  }

  // Start of the first buffered range that begins after `time` (used to hop over small holes).
  function nextBufferedStart(sourceBuffer, time) {
    const ranges = bufferedRanges(sourceBuffer);
    if (!ranges) return null;
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) > time) return ranges.start(index);
    }
    return null;
  }

  function firstBufferedStart(sourceBuffer) {
    const ranges = bufferedRanges(sourceBuffer);
    return ranges && ranges.length ? ranges.start(0) : null;
  }

  function mediaBytesPerSecond(track) {
    const segment = track?.sidx?.segments?.[track.startupIndex];
    if (segment?.durationSeconds > 0 && segment?.length > 0) return segment.length / segment.durationSeconds;
    return Math.max(0, Number(track?.representation?.bandwidth) || 0) / 8;
  }

  /* ------------------------------------------------------------------ *
   * Representation selection
   * ------------------------------------------------------------------ */

  function createSelector(flavour, initiallyDropped = []) {
    const apple = isAppleWebKit();
    const droppedFamilies = new Set(initiallyDropped.filter((family) => ["av1", "hevc", "avc"].includes(family)));

    function playableMime(representation, kind) {
      if (!apple || kind !== "video") return mimeFor(representation, kind);
      const codecs = representation?.codecs || representation?.codec;
      return mimeFor({ ...representation, codecs: appleCodecString(codecs), codec: undefined }, kind);
    }

    function supported(representation, kind) {
      try { return flavour.ctor.isTypeSupported(playableMime(representation, kind)); }
      catch (_error) { return false; }
    }

    // Upstream's order is AV1 > HEVC > AVC (smallest files first). On Apple devices HEVC is the one
    // family that needs the relabelling trick above, so there it is only used when it is the only
    // way to get a quality (4K, HDR) or when it was asked for. AV1 is only ever reported as
    // supported on Apple hardware that decodes it in silicon.
    function familyScore(representation, preference) {
      const family = codecFamily(representation);
      if (preference && preference !== "auto" && family === preference) return 10;
      const order = apple ? { av1: 3, avc: 2, hevc: 1, other: 0 } : { av1: 3, hevc: 2, avc: 1, other: 0 };
      return order[family] || 0;
    }

    function select(playinfo, preference = "auto") {
      const body = dashBody(playinfo);
      const dash = body?.dash;
      if (!dash) throw new Error("这个视频没有 DASH 播放清单（可能是地区、权限或登录限制）");
      const usable = (dash.video || []).filter((item) => supported(item, "video"));
      // A family that failed before stays out, unless it is exactly what was asked for now.
      const kept = usable.filter((item) => !droppedFamilies.has(codecFamily(item)) || codecFamily(item) === preference);
      const pool = kept.length ? kept : usable;
      const byQuality = new Map();
      for (const representation of pool) {
        const key = Number(representation.id) || `${Number(representation.height) || 0}-${Math.round(frameRate(representation))}`;
        const existing = byQuality.get(key);
        if (!existing
          || familyScore(representation, preference) > familyScore(existing, preference)
          || (familyScore(representation, preference) === familyScore(existing, preference)
            && (Number(representation.bandwidth) || 0) > (Number(existing.bandwidth) || 0))) {
          byQuality.set(key, representation);
        }
      }
      const videos = Array.from(byQuality.values()).sort((a, b) =>
        (Number(b.height) || 0) - (Number(a.height) || 0) || frameRate(b) - frameRate(a) ||
        (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0));
      const audio = (dash.audio || []).filter((item) => supported(item, "audio"))
        .sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0))[0];
      if (!videos.length) throw new Error("这台设备的浏览器不支持清单里的任何视频编码");
      if (!audio) throw new Error("这台设备的浏览器不支持清单里的音频编码");
      return { audio, dash, videos, serverQuality: Number(body?.quality || body?.qn) || 0 };
    }

    // wantedId > 0: that quality, or the nearest one below it, or the lowest there is.
    // wantedId = 0 ("自动"): the best quality that is not taller than maxAutoHeight.
    function pick(selection, wantedId, maxAutoHeight = 1080) {
      const videos = selection.videos;
      if (wantedId > 0) {
        const exact = videos.find((item) => Number(item.id) === wantedId);
        if (exact) return exact;
        const wantedHeight = QUALITY_HEIGHTS[wantedId] || 1080;
        return videos.find((item) => (Number(item.height) || 0) <= wantedHeight) || videos[videos.length - 1];
      }
      return videos.find((item) => (Number(item.height) || 0) <= maxAutoHeight) || videos[videos.length - 1];
    }

    return Object.freeze({
      select,
      pick,
      playableMime,
      relabelsInit: (representation) => apple && Boolean(APPLE_CODEC_LABELS[String(representation?.codecs || representation?.codec || "").slice(0, 4).toLowerCase()]),
      dropFamily(family) { if (family && family !== "other") droppedFamilies.add(family); },
      droppedFamilies: () => [...droppedFamilies]
    });
  }

  /* ------------------------------------------------------------------ *
   * Engine
   * ------------------------------------------------------------------ */

  function createEngine(options) {
    const video = options.video;
    if (!video || typeof video.play !== "function") throw new Error("需要一个 video 元素");
    const getSettings = options.getSettings;
    const flavour = mediaSourceFlavour(String(getSettings()?.engine || "auto"));
    if (!flavour) throw new Error("这个浏览器没有 MediaSource / ManagedMediaSource（iPhone 需要 iOS 17.1 以上）");
    const selector = createSelector(flavour, Array.isArray(options.droppedFamilies) ? options.droppedFamilies : []);
    const log = (title, detail, level = "info", category = "other") => {
      try { options.onLog?.(title, detail, level, category); } catch (_error) {}
    };

    let playinfo = null;
    let selection = null;
    let selectedVideo = null;
    let wantedQualityId = 0;
    let session = null;
    let destroyed = false;
    let generationSequence = 0;
    let seekTimer = null;
    let seekReloads = 0;
    let holeRepairs = 0;
    let gapJumps = 0;
    let quotaEvents = 0;
    let lastRepairAt = 0;
    let lastStallRebuildAt = -Infinity;
    let decodeStalls = 0;
    let enginePausedAt = -Infinity;
    let aheadBytesCap = DEFAULT_AHEAD_BYTES;
    let userWantsPlayback = false;
    let gestureUnlocked = false;
    const cdnBans = resolverFactory.createBanList({
      onBan(host) { log("已停用这个 CDN 节点", `${host} 两次没有返回任何数据，这个视频接下来不再使用它。`, "error", "download"); }
    });
    const eventController = new AbortController();
    const downloader = downloaderFactory.createDownloader({
      getSettings,
      nativeFetch: options.nativeFetch || root.fetch.bind(root),
      onTransfer: options.onTransfer
    });

    function settings() {
      return core.normalizeSettings(getSettings());
    }

    function maxAutoHeight() {
      return Math.max(240, Number(getSettings()?.maxAutoHeight) || 1080);
    }

    function sessionIsCurrent(candidate) {
      return !destroyed && session === candidate && !candidate.disposed;
    }

    function enginePause() {
      enginePausedAt = performance.now();
      try { video.pause(); } catch (_error) {}
    }

    function aheadTargetSeconds(candidate) {
      if (!candidate?.mediaBytesPerSecond) return MAX_AHEAD_SECONDS;
      const byBytes = aheadBytesCap / Math.max(1, candidate.mediaBytesPerSecond);
      return Math.max(MIN_AHEAD_SECONDS, Math.min(MAX_AHEAD_SECONDS, byBytes));
    }

    function publishState(extra = {}) {
      const resolvers = session ? [session.videoResolver, session.audioResolver] : [];
      const health = resolvers.flatMap((resolver) => resolver.status());
      const current = Number(video.currentTime) || 0;
      try {
        options.onState?.({
          mode: settings().mode,
          playerState: session?.fatal ? "error"
            : video.ended ? "ended"
              : session?.recovering ? "buffering"
                : session?.playbackActivated ? (video.paused ? "paused" : "ready") : session ? "loading" : "idle",
          quality: selectedVideo ? qualityLabel(selectedVideo) : "",
          qualityId: Number(selectedVideo?.id) || 0,
          codec: selectedVideo ? codecFamily(selectedVideo) : "",
          managed: flavour.managed,
          streaming: session?.mediaSource && flavour.managed ? session.mediaSource.streaming !== false : true,
          bufferedAhead: session?.tracks?.length
            ? Math.max(0, Math.min(...session.tracks.map((track) => bufferedEndAt(track.sourceBuffer, current))) - current)
            : 0,
          aheadTargetSeconds: session ? aheadTargetSeconds(session) : 0,
          startupTargetSeconds: session?.startupTargetSeconds || 0,
          startupThroughputBps: session?.startupThroughputBps || 0,
          mediaBytesPerSecond: session?.mediaBytesPerSecond || 0,
          needsTap: Boolean(session?.needsTap),
          cdnHosts: health,
          ...extra
        });
      } catch (_error) {}
    }

    /* ---------------- SourceBuffer operations ---------------- */

    async function queuedSourceOperation(candidate, track, operation) {
      const next = track.operation.catch(() => {}).then(async () => {
        if (!sessionIsCurrent(candidate)) return;
        if (track.sourceBuffer.updating) await waitEvent(track.sourceBuffer, "updateend", "error", candidate.controller.signal);
        if (!sessionIsCurrent(candidate)) return;
        return operation();
      });
      track.operation = next;
      return next;
    }

    async function removeNow(candidate, track, start, end) {
      if (end <= start || candidate.mediaSource.readyState !== "open") return;
      track.sourceBuffer.remove(start, end);
      await waitEvent(track.sourceBuffer, "updateend", "error", candidate.controller.signal);
    }

    // Runs inside the track's operation queue. iOS gives each SourceBuffer a small quota, so a
    // full buffer is normal: make room behind the play head (then far ahead of it), shrink the
    // look-ahead target and try again instead of treating it as a fatal error.
    async function appendNow(candidate, track, bytes) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          track.sourceBuffer.appendBuffer(bytes);
        } catch (error) {
          if (error?.name !== "QuotaExceededError" || attempt >= 6) throw error;
          quotaEvents += 1;
          aheadBytesCap = Math.max(MIN_AHEAD_BYTES, Math.floor(aheadBytesCap * 0.7));
          const current = Number(video.currentTime) || 0;
          log("浏览器的视频缓冲区满了", `正在清理已经播放过的部分，并把预读上限降到 ${(aheadBytesCap / 1048576).toFixed(0)} MiB。`, "info", "buffer");
          const keepBehind = attempt === 0 ? 10 : 3;
          if (current - keepBehind > 0.5) await removeNow(candidate, track, 0, current - keepBehind);
          if (attempt >= 1) {
            // Still full: drop what lies far ahead as well. fillTrack() notices and fetches it again.
            const farAhead = current + Math.max(MIN_AHEAD_SECONDS, aheadTargetSeconds(candidate) / (attempt + 1));
            const duration = Number(candidate.mediaSource.duration);
            if (Number.isFinite(duration) && duration > farAhead + 1) await removeNow(candidate, track, farAhead, duration);
          }
          await sleep(150 * (attempt + 1), candidate.controller.signal);
          if (!sessionIsCurrent(candidate)) return;
          continue;
        }
        await waitEvent(track.sourceBuffer, "updateend", "error", candidate.controller.signal);
        return;
      }
    }

    function append(candidate, track, bytes, generation) {
      return queuedSourceOperation(candidate, track, async () => {
        if (!sessionIsCurrent(candidate) || generation !== candidate.generation) return;
        await appendNow(candidate, track, bytes);
        // Appending to an ended stream opens it again; it has to be ended once more afterwards.
        if (candidate.streamEnded && candidate.mediaSource.readyState === "open") candidate.streamEnded = false;
      });
    }

    function removeRange(candidate, track, start, end) {
      if (end <= start || candidate.mediaSource.readyState !== "open") return Promise.resolve();
      return queuedSourceOperation(candidate, track, async () => {
        if (!sessionIsCurrent(candidate) || candidate.mediaSource.readyState !== "open") return;
        await removeNow(candidate, track, start, end);
      });
    }

    /* ---------------- downloading ---------------- */

    async function loadTrack(candidate, kind, representation, resolver, sourceBuffer, startTime) {
      const ranges = segmentBase(representation);
      const [initialization, indexBytes] = await Promise.all([
        downloader.downloadRange(ranges.init, resolver, { signal: candidate.controller.signal, parallel: false, kind: "meta" }),
        downloader.downloadRange(ranges.index, resolver, { signal: candidate.controller.signal, parallel: false, kind: "meta" })
      ]);
      if (!sessionIsCurrent(candidate)) throw abortError();
      const sidx = sidxTools.parseSidx(indexBytes.bytes, ranges.index.start);
      if (!sidx?.segments?.length) throw new Error(`${kind === "video" ? "视频" : "音频"} SIDX 解析失败`);
      log("已经确认数据的下载位置", `找到了 ${sidx.segments.length} 段${kind === "audio" ? "声音" : "画面"}数据。`, "success", "download");
      const startupIndex = sidxTools.segmentIndexAt(sidx.segments, startTime);
      const track = {
        kind, representation, resolver, sourceBuffer, sidx,
        nextIndex: startupIndex,
        startupIndex,
        complete: false,
        filling: false,
        started: false,
        startupComplete: false,
        startupScheduled: false,
        followupScheduled: false,
        prefetches: new Map(),
        resyncHits: new Map(),
        operation: Promise.resolve()
      };
      const initBytes = kind === "video" && selector.relabelsInit(representation)
        ? relabelSampleEntryForApple(initialization.bytes)
        : initialization.bytes;
      if (initBytes !== initialization.bytes) log("已把 HEVC 标签换成苹果设备认的写法", "hev1 → hvc1（只改初始化段里的四个字节）。", "info", "playback");
      await append(candidate, track, initBytes, candidate.generation);
      return track;
    }

    function segmentDownload(candidate, track, segment, index, downloadOptions = {}) {
      return downloader.downloadRange(segment, track.resolver, {
        signal: candidate.controller.signal,
        parallel: true,
        kind: track.kind,
        priority: downloadOptions.priority,
        startup: downloadOptions.startup === true,
        onStartupScheduled: downloadOptions.onStartupScheduled,
        onOrderedChunk: downloadOptions.onOrderedChunk || null
      }).then(
        (result) => ({ index, result }),
        (error) => ({ error, index })
      );
    }

    function updateStartupProfile(candidate) {
      const elapsedSeconds = Math.max(0.25, (performance.now() - candidate.startupStartedAt) / 1000);
      const throughput = candidate.startupCompletedBytes / elapsedSeconds;
      const required = candidate.tracks.reduce((sum, track) => sum + mediaBytesPerSecond(track), 0);
      const ratio = required > 0 ? throughput / required : 0;
      let target = ratio >= 3 ? STARTUP_BUFFER_MIN_SECONDS : ratio >= 1.8 ? 4 : ratio >= 1.25 ? 6 : ratio > 0 ? 8 : 6;
      if ((Number(selectedVideo?.height) || 0) >= 2160 && ratio < 1.8) target = Math.max(target, 8);
      candidate.startupThroughputBps = throughput;
      candidate.mediaBytesPerSecond = required;
      candidate.startupTargetSeconds = Math.max(STARTUP_BUFFER_MIN_SECONDS, Math.min(STARTUP_BUFFER_MAX_SECONDS, target));
      return candidate.startupTargetSeconds;
    }

    function maybeStartStartupPrefetch(candidate) {
      if (candidate.startupPrefetchLaunched || !sessionIsCurrent(candidate) || !candidate.tracks.length) return;
      if (!candidate.tracks.every((track) => track.startupScheduled)) return;
      candidate.startupPrefetchLaunched = true;
      for (const track of candidate.tracks) {
        const index = track.startupIndex + 1;
        track.followupScheduled = true;
        const segment = track.sidx.segments[index];
        if (segment) track.prefetches.set(index, segmentDownload(candidate, track, segment, index, { priority: 70 }));
      }
      ensureBuffer(candidate);
    }

    // ManagedMediaSource says when it wants data. Honour "not now", but never let the buffer
    // in front of the play head run low because of it.
    function streamingPaused(candidate, track, current) {
      if (!flavour.managed || candidate.mediaSource.streaming !== false) return false;
      return bufferedEndAt(track.sourceBuffer, current) - current >= IDLE_STREAMING_AHEAD_SECONDS;
    }

    // Data in front of the play head that the downloader believes it delivered can disappear
    // (ManagedMediaSource eviction, quota clean-up). Go back to the first missing segment. The
    // probe sits half a second past the buffered end so a fragment that ends a frame short of
    // its SIDX time is not fetched again for ever.
    function resyncNextIndex(track, current) {
      if (!track.started || !isBufferedAt(track.sourceBuffer, current)) return;
      const probe = bufferedEndAt(track.sourceBuffer, current) + 0.5;
      const index = sidxTools.segmentIndexAt(track.sidx.segments, probe);
      const segment = track.sidx.segments[index];
      if (!segment || probe < segment.startTime || probe >= segment.endTime) return;
      if (index >= track.nextIndex || track.prefetches.has(index)) return;
      // A browser that throws the same fragment away again and again must not turn this into an
      // endless download loop: three tries per fragment, then leave it to repairHole().
      const hits = (track.resyncHits.get(index) || 0) + 1;
      track.resyncHits.set(index, hits);
      if (hits > 3) return;
      track.nextIndex = index;
      track.complete = false;
    }

    async function fillTrack(candidate, track) {
      if (track.filling || !sessionIsCurrent(candidate) || candidate.fatal) return;
      resyncNextIndex(track, Number(video.currentTime) || candidate.startTime);
      if (track.complete) return;
      track.filling = true;
      const generation = candidate.generation;
      const signal = candidate.controller.signal;
      try {
        while (sessionIsCurrent(candidate) && generation === candidate.generation && !signal.aborted) {
          const current = Number(video.currentTime) || candidate.startTime;
          resyncNextIndex(track, current);
          if (track.nextIndex >= track.sidx.segments.length) {
            track.complete = true;
            break;
          }
          const aheadTarget = aheadTargetSeconds(candidate);
          if (bufferedEndAt(track.sourceBuffer, current) - current >= aheadTarget) break;
          if (track.started && streamingPaused(candidate, track, current)) break;
          const batchSize = track.started ? (track.kind === "video" ? 3 : 4) : 1;
          const batch = [];
          let projectedEnd = bufferedEndAt(track.sourceBuffer, current);
          for (let offset = 0; offset < batchSize; offset += 1) {
            const index = track.nextIndex + offset;
            const segment = track.sidx.segments[index];
            if (!segment || projectedEnd - current >= aheadTarget) break;
            const startup = !track.startupComplete && index === track.startupIndex;
            const prefetched = track.prefetches.get(index);
            batch.push(prefetched || segmentDownload(candidate, track, segment, index, {
              priority: startup ? 120 : Math.max(30, 55 - offset * 5),
              startup,
              onStartupScheduled: startup ? () => {
                track.startupScheduled = true;
                maybeStartStartupPrefetch(candidate);
              } : null,
              onOrderedChunk: startup ? async (bytes) => {
                if (!sessionIsCurrent(candidate) || generation !== candidate.generation || signal.aborted) return;
                candidate.progressiveAppends += 1;
                await append(candidate, track, bytes, generation);
                ensureBuffer(candidate);
              } : null
            }));
            projectedEnd = segment.endTime;
          }
          if (!batch.length) break;
          for (const pending of batch) {
            const settled = await pending;
            track.prefetches.delete(settled.index);
            if (settled.error) throw settled.error;
            if (!sessionIsCurrent(candidate) || generation !== candidate.generation || signal.aborted) break;
            if (!settled.result.streamed) await append(candidate, track, settled.result.bytes, generation);
            if (!track.startupComplete && settled.index === track.startupIndex) {
              track.startupComplete = true;
              candidate.startupCompletedBytes += settled.result.byteLength;
              updateStartupProfile(candidate);
            }
            track.nextIndex = settled.index + 1;
            track.started = true;
            try { options.onSegment?.({ kind: track.kind, bytes: settled.result.byteLength, pieces: settled.result.pieceCount, hosts: settled.result.hosts }); } catch (_error) {}
            ensureBuffer(candidate);
          }
        }
      } catch (error) {
        if (!signal.aborted && sessionIsCurrent(candidate)) fatal(candidate, error);
      } finally {
        track.filling = false;
        maybeEndStream(candidate);
      }
    }

    function maybeEndStream(candidate = session) {
      if (!candidate || !sessionIsCurrent(candidate) || candidate.fatal || candidate.streamEnded || candidate.ending) return;
      if (!candidate.tracks.length || !candidate.tracks.every((track) => track.complete)) return;
      candidate.ending = true;
      Promise.all(candidate.tracks.map((track) => track.operation.catch(() => {}))).then(() => {
        candidate.ending = false;
        if (!sessionIsCurrent(candidate) || candidate.fatal || candidate.streamEnded || candidate.mediaSource.readyState !== "open") return;
        if (!candidate.tracks.every((track) => track.complete)) return;
        if (candidate.tracks.some((track) => track.sourceBuffer.updating)) {
          candidate.endRetryTimer = setTimeout(() => maybeEndStream(candidate), 50);
          return;
        }
        // endOfStream() trims the duration to the end of the buffered media by itself. See
        // upstream 0.9.1.3: setting a shorter duration first is refused for HEVC tails.
        candidate.mediaSource.endOfStream();
        candidate.streamEnded = true;
        publishState();
      }).catch((error) => {
        candidate.ending = false;
        if (sessionIsCurrent(candidate) && error?.name !== "InvalidStateError") fatal(candidate, error);
        else if (sessionIsCurrent(candidate)) {
          candidate.endAttempts = (candidate.endAttempts || 0) + 1;
          if (candidate.endAttempts === 40) log("视频结尾没能正常收尾", `结束媒体流一直失败，播放器可能停在结尾。\n原因：${String(error?.message || error).slice(0, 160)}`, "error", "playback");
          if (candidate.endAttempts < 400) candidate.endRetryTimer = setTimeout(() => maybeEndStream(candidate), 50);
        }
      });
    }

    /* ---------------- play / pause plumbing ---------------- */

    function setCurrentTimeInternal(candidate, target) {
      candidate.internalSeekTarget = Number(target) || 0;
      try { video.currentTime = target; }
      catch (_error) { candidate.internalSeekTarget = null; }
      setTimeout(() => {
        if (sessionIsCurrent(candidate) && candidate.internalSeekTarget === (Number(target) || 0)) candidate.internalSeekTarget = null;
      }, 300);
    }

    // iOS refuses play() with sound until one play() call has happened inside a tap on this
    // element. After that the element stays unlocked, which is why there is only one element.
    function tryPlay(candidate) {
      let promise;
      try { promise = video.play(); }
      catch (error) { promise = Promise.reject(error); }
      Promise.resolve(promise).then(() => {
        gestureUnlocked = true;
        if (sessionIsCurrent(candidate) && candidate.needsTap) {
          candidate.needsTap = false;
          publishState();
        }
      }).catch((error) => {
        if (!sessionIsCurrent(candidate)) return;
        if (error?.name === "NotAllowedError") {
          if (!candidate.needsTap) {
            candidate.needsTap = true;
            log("需要你点一下才能开始播放", "iOS 不允许网页自己播放有声音的视频，点一下播放按钮就可以了。", "info", "playback");
          }
          publishState();
        }
      });
    }

    function attemptAutoplay(candidate) {
      if (candidate.playAttempted || !candidate.resumeWanted || !sessionIsCurrent(candidate)) return;
      candidate.playAttempted = true;
      tryPlay(candidate);
    }

    function activateWhenReady(candidate) {
      if (candidate.playbackActivated || !sessionIsCurrent(candidate) || !candidate.tracks.length) return;
      if (!candidate.tracks.every((track) => track.startupComplete && track.followupScheduled)) return;
      const liveTime = Math.max(0, Number(video.currentTime) || 0);
      const target = Math.max(candidate.startTime, liveTime);
      candidate.startTime = target;
      if (!candidate.tracks.every((track) => isBufferedAt(track.sourceBuffer, target))) return;
      const ends = candidate.tracks.map((track) => bufferedEndAt(track.sourceBuffer, target));
      const required = updateStartupProfile(candidate);
      const remaining = Math.max(0.5, (Number(candidate.mediaSource.duration) || target + required) - target);
      if (Math.min(...ends) - target < Math.max(0.5, Math.min(required, remaining))) return;
      candidate.playbackActivated = true;
      log("开播需要的缓冲已经够了", `从 ${target.toFixed(2)} 秒开始播放，这次先缓冲了 ${required.toFixed(1)} 秒。`, "success", "buffer");
      candidate.playbackActivatedAt = performance.now();
      if (target - (Number(video.currentTime) || 0) > 0.05) setCurrentTimeInternal(candidate, target);
      video.playbackRate = candidate.playbackRate;
      attemptAutoplay(candidate);
    }

    /* ---------------- repairs ---------------- */

    // Give up on the current codec family (for this and later videos) and carry on with the next
    // best one at the same quality. False when there is nothing else to switch to.
    function switchCodecFamily(reason) {
      const family = codecFamily(selectedVideo);
      if (!playinfo || family === "other" || selector.droppedFamilies().includes(family)) return false;
      selector.dropFamily(family);
      try {
        const nextSelection = selector.select(playinfo, "auto");
        const nextVideo = selector.pick(nextSelection, Number(selectedVideo?.id) || wantedQualityId, maxAutoHeight());
        if (!nextVideo || codecFamily(nextVideo) === family) return false;
        log("这种编码在这台设备上放不了", `${CODEC_LABELS[family] || family} ${reason}，改用 ${CODEC_LABELS[codecFamily(nextVideo)] || "其他编码"}。`, "error", "playback");
        try { options.onFamilyDropped?.(family); } catch (_error) {}
        selection = nextSelection;
        startSession(nextVideo, { ...playbackState(), resume: true }).catch((error) => { if (session) fatal(session, error); });
        announceQualities();
        return true;
      } catch (_error) {
        return false;
      }
    }

    // Data is buffered right where the play head is, playback is wanted, and still nothing moves:
    // the decoder is stuck. Some devices do this instead of reporting an error for a stream they
    // cannot handle.
    function handleDecodeStall(candidate) {
      if (switchCodecFamily("一直解不出画面")) return;
      const now = performance.now();
      if (now - lastStallRebuildAt < 30000) return;
      lastStallRebuildAt = now;
      log("有缓冲却一直不动", "正在原地重建播放器。", "error", "playback");
      startSession(selectedVideo, { ...playbackState(), resume: true }).catch((error) => { if (session) fatal(session, error); });
    }

    // A hole right in front of the play head that is shorter than a second (timestamps that do
    // not start at exactly zero, fragments that end a frame apart) would stall Safari for ever.
    function jumpSmallGap(candidate) {
      if (!candidate.playbackActivated || video.seeking || candidate.internalSeekTarget !== null) return false;
      const current = Number(video.currentTime) || 0;
      if (candidate.tracks.every((track) => isStrictlyBufferedAt(track.sourceBuffer, current))) return false;
      const starts = candidate.tracks.map((track) => isStrictlyBufferedAt(track.sourceBuffer, current)
        ? current
        : nextBufferedStart(track.sourceBuffer, current));
      if (starts.some((value) => value === null)) return false;
      const target = Math.max(...starts);
      if (target - current <= 0 || target - current > 1) return false;
      if (!candidate.tracks.every((track) => isStrictlyBufferedAt(track.sourceBuffer, target + 0.1))) return false;
      gapJumps += 1;
      log("跳过了一小段空隙", `从 ${current.toFixed(2)} 秒跳到 ${(target + 0.05).toFixed(2)} 秒。`, "info", "buffer");
      setCurrentTimeInternal(candidate, target + 0.05);
      return true;
    }

    // The play head sits on data that is gone (ManagedMediaSource evicted it, or a quota clean-up
    // removed it) and the downloader has already moved past that position: rebuild from here.
    function repairHole(candidate) {
      if (!candidate.playbackActivated || candidate.fatal || video.seeking || seekTimer) return false;
      if (candidate.internalSeekTarget !== null || video.ended) return false;
      const current = Number(video.currentTime) || 0;
      const duration = Number(candidate.mediaSource.duration);
      if (Number.isFinite(duration) && current >= duration - 0.5) return false;
      const lost = candidate.tracks.filter((track) => {
        if (isBufferedAt(track.sourceBuffer, current)) return false;
        const next = track.sidx.segments[track.nextIndex];
        return track.complete || !next || next.startTime > current + 0.25;
      });
      if (!lost.length) return false;
      const now = performance.now();
      if (now - lastRepairAt < 3000) return false;
      lastRepairAt = now;
      holeRepairs += 1;
      log("播放位置的缓冲不见了", `浏览器回收了 ${current.toFixed(1)} 秒附近的数据，正在从这里重新缓冲。`, "info", "buffer");
      startSession(selectedVideo, { ...playbackState(), time: current, resume: userWantsPlayback || !video.paused }).catch((error) => {
        if (session) fatal(session, error);
      });
      return true;
    }

    function ensureBuffer(candidate = session) {
      if (!candidate || !sessionIsCurrent(candidate) || candidate.fatal || !candidate.tracks.length) return;
      for (const track of candidate.tracks) fillTrack(candidate, track);
      activateWhenReady(candidate);
      const current = Number(video.currentTime) || candidate.startTime;
      const ready = candidate.tracks.every((track) => isBufferedAt(track.sourceBuffer, current));
      const ahead = ready ? Math.max(0, Math.min(...candidate.tracks.map((track) => bufferedEndAt(track.sourceBuffer, current))) - current) : 0;
      if (candidate.recovering && ready) {
        const remaining = Math.max(0.5, (Number(candidate.mediaSource.duration) || current + candidate.recoveryTargetSeconds) - current);
        if (ahead >= Math.min(candidate.recoveryTargetSeconds, remaining)) {
          candidate.recovering = false;
          log("缓冲补好了，可以继续播放", `已经备好接下来 ${ahead.toFixed(1)} 秒的数据。`, "success", "buffer");
          candidate.playAttempted = false;
          attemptAutoplay(candidate);
        }
      }
      if (candidate.playbackActivated) {
        const now = performance.now();
        const stalled = !video.paused && !video.seeking && !video.ended && video.readyState < 3;
        candidate.stalledSince = stalled ? (candidate.stalledSince || now) : 0;
        if (!ready || (stalled && now - candidate.stalledSince >= 1000)) {
          if (!jumpSmallGap(candidate) && !ready) repairHole(candidate);
        }
        const stuckWithData = stalled && !candidate.recovering && candidate.tracks.every((track) => isStrictlyBufferedAt(track.sourceBuffer, current)) && ahead >= 3;
        candidate.decodeStallSince = stuckWithData ? (candidate.decodeStallSince || now) : 0;
        if (stuckWithData && now - candidate.decodeStallSince >= 8000) {
          candidate.decodeStallSince = 0;
          decodeStalls += 1;
          handleDecodeStall(candidate);
          return;
        }
      }
      publishState();
    }

    function prune(candidate = session) {
      if (!candidate || !sessionIsCurrent(candidate) || candidate.fatal || video.currentTime < 75) return;
      const end = video.currentTime - 30;
      const stale = candidate.tracks.filter((track) => {
        const first = firstBufferedStart(track.sourceBuffer);
        return first !== null && first < end - 10;
      });
      if (!stale.length) return;
      Promise.all(stale.map((track) => removeRange(candidate, track, 0, end).catch(() => {}))).catch(() => {});
    }

    /* ---------------- session life cycle ---------------- */

    function detachSource() {
      for (const node of Array.from(video.querySelectorAll("source[data-btr]"))) node.remove();
      video.removeAttribute("src");
    }

    function disposeSession(candidate, detach = true) {
      if (!candidate || candidate.disposed) return;
      candidate.disposed = true;
      candidate.generation = ++generationSequence;
      candidate.controller.abort(abortError());
      clearInterval(candidate.timer);
      clearTimeout(candidate.endRetryTimer);
      if (detach) {
        enginePause();
        detachSource();
        try { video.load(); } catch (_error) {}
      }
      try { URL.revokeObjectURL(candidate.objectUrl); } catch (_error) {}
    }

    function fatal(candidate, error) {
      if (!sessionIsCurrent(candidate) || candidate.fatal || error?.name === "AbortError") return;
      candidate.fatal = true;
      candidate.controller.abort(abortError("播放内核发生错误"));
      clearInterval(candidate.timer);
      const message = String(error?.message || error).slice(0, 200);
      log("播放内核出错了", message, "error", "playback");
      publishState({ playerState: "error", lastError: message });
      try { options.onFatal?.(error); } catch (_error) {}
    }

    function attachSource(candidate) {
      detachSource();
      if (flavour.managed) {
        // ManagedMediaSource never opens while AirPlay could take the element over.
        try { video.disableRemotePlayback = true; } catch (_error) {}
        video.setAttribute("x-webkit-airplay", "deny");
        const source = document.createElement("source");
        source.type = "video/mp4";
        source.src = candidate.objectUrl;
        source.dataset.btr = "1";
        video.appendChild(source);
      } else {
        video.src = candidate.objectUrl;
      }
      video.load();
    }

    async function startSession(representation, state) {
      if (destroyed) return;
      const family = CODEC_LABELS[codecFamily(representation)];
      log("正在准备播放器", `使用 ${qualityLabel(representation)}${family ? ` ${family}` : ""}，从 ${Number(state.time || 0).toFixed(2)} 秒开始。`, "info", "takeover");
      const previous = session;
      selectedVideo = representation;
      const mediaSource = new flavour.ctor();
      const objectUrl = URL.createObjectURL(mediaSource);
      const videoRepresentation = withDonorUrl(representation);
      const audioRepresentation = withDonorUrl(selection.audio);
      const candidate = {
        disposed: false, fatal: false, generation: ++generationSequence,
        controller: new AbortController(), mediaSource, objectUrl,
        timer: null, endRetryTimer: null, tracks: [], ending: false, streamEnded: false,
        playAttempted: false, playbackActivated: false, playbackActivatedAt: 0,
        recovering: false, recoveryTargetSeconds: STARTUP_RECOVERY_SECONDS, stalledSince: 0, decodeStallSince: 0,
        startupCompletedBytes: 0, startupPrefetchLaunched: false, startupStartedAt: performance.now(),
        progressiveAppends: 0, needsTap: false,
        startupTargetSeconds: 6, startupThroughputBps: 0, mediaBytesPerSecond: 0,
        startupWaitingEvents: 0, resumeWanted: Boolean(state.resume),
        playbackRate: Number(state.playbackRate) || 1,
        startTime: Math.max(0, Number(state.time) || 0),
        internalSeekTarget: null,
        videoResolver: resolverFactory.createResolver(videoRepresentation, () => settings().mode, cdnBans),
        audioResolver: resolverFactory.createResolver(audioRepresentation, () => settings().mode, cdnBans)
      };
      session = candidate;
      if (previous) disposeSession(previous, false);
      enginePause();
      attachSource(candidate);
      video.playbackRate = candidate.playbackRate;
      publishState({ playerState: "loading", lastError: "" });
      if (flavour.managed) {
        mediaSource.addEventListener("startstreaming", () => ensureBuffer(candidate), { signal: candidate.controller.signal });
        mediaSource.addEventListener("endstreaming", () => publishState(), { signal: candidate.controller.signal });
      }
      try {
        if (mediaSource.readyState !== "open") {
          await waitEvent(mediaSource, "sourceopen", "error", candidate.controller.signal, SOURCE_OPEN_TIMEOUT_MS,
            "浏览器一直没有打开媒体源（请确认页面在前台；iPhone 需要 iOS 17.1 以上）");
        }
        if (!sessionIsCurrent(candidate)) return;
        const videoBuffer = mediaSource.addSourceBuffer(selector.playableMime(representation, "video"));
        const audioBuffer = mediaSource.addSourceBuffer(selector.playableMime(selection.audio, "audio"));
        const [videoTrack, audioTrack] = await Promise.all([
          loadTrack(candidate, "video", videoRepresentation, candidate.videoResolver, videoBuffer, candidate.startTime),
          loadTrack(candidate, "audio", audioRepresentation, candidate.audioResolver, audioBuffer, candidate.startTime)
        ]);
        if (!sessionIsCurrent(candidate)) return;
        candidate.tracks = [videoTrack, audioTrack];
        if (flavour.managed) {
          for (const track of candidate.tracks) {
            track.sourceBuffer.addEventListener("bufferedchange", () => ensureBuffer(candidate), { signal: candidate.controller.signal });
          }
        }
        const duration = Math.max(
          Number(selection.dash.duration) || 0,
          videoTrack.sidx.segments.at(-1)?.endTime || 0,
          audioTrack.sidx.segments.at(-1)?.endTime || 0
        );
        if (duration > 0) mediaSource.duration = duration;
        if (candidate.startTime > 0 && Number.isFinite(mediaSource.duration)) {
          setCurrentTimeInternal(candidate, Math.min(candidate.startTime, Math.max(0, mediaSource.duration - 0.1)));
        }
        candidate.startupStartedAt = performance.now();
        candidate.timer = setInterval(() => { ensureBuffer(candidate); prune(candidate); }, 750);
        ensureBuffer(candidate);
      } catch (error) {
        if (sessionIsCurrent(candidate)) fatal(candidate, error);
      }
    }

    async function seek() {
      const candidate = session;
      if (!candidate || !sessionIsCurrent(candidate) || !candidate.tracks.length) return;
      const target = Number(video.currentTime) || 0;
      if (candidate.internalSeekTarget !== null && Math.abs(target - candidate.internalSeekTarget) < 0.25) {
        candidate.internalSeekTarget = null;
        return;
      }
      if (candidate.tracks.every((track) => isBufferedAt(track.sourceBuffer, target))) {
        ensureBuffer(candidate);
        return;
      }
      // Safari reports the engine's own initial positioning late, as if it were a seek. The session
      // is already buffering exactly there; rebuilding it would only start the wait over.
      if (!candidate.playbackActivated && Math.abs(target - candidate.startTime) < 0.75) {
        ensureBuffer(candidate);
        return;
      }
      seekReloads += 1;
      log("你跳到的位置还需要加载", `正在为 ${target.toFixed(2)} 秒的位置重新准备数据。`, "info", "buffer");
      await startSession(selectedVideo, { ...playbackState(), time: target, resume: userWantsPlayback || !video.paused });
    }

    function scheduleSeek() {
      clearTimeout(seekTimer);
      seekTimer = setTimeout(() => {
        seekTimer = null;
        seek().catch((error) => { if (session && sessionIsCurrent(session)) fatal(session, error); });
      }, 220);
    }

    function playbackState() {
      return {
        time: Number(video.currentTime) || 0,
        resume: userWantsPlayback,
        playbackRate: video.playbackRate || 1
      };
    }

    /* ---------------- <video> events ---------------- */

    const listen = (name, handler) => video.addEventListener(name, handler, { signal: eventController.signal });
    listen("seeking", scheduleSeek);
    listen("timeupdate", () => ensureBuffer());
    listen("play", () => {
      userWantsPlayback = true;
      const candidate = session;
      if (candidate && sessionIsCurrent(candidate)) {
        candidate.resumeWanted = true;
        candidate.needsTap = false;
      }
      publishState();
    });
    listen("pause", () => {
      // The engine pauses by itself while it rebuilds or tops up the buffer. Only a pause that the
      // person (or iOS: a phone call, unplugged headphones) caused cancels the automatic resume.
      const engineDidIt = performance.now() - enginePausedAt < ENGINE_PAUSE_WINDOW_MS;
      const candidate = session;
      if (!engineDidIt && !video.ended && !video.seeking) {
        userWantsPlayback = false;
        if (candidate && sessionIsCurrent(candidate)) candidate.resumeWanted = false;
      }
      publishState();
    });
    listen("waiting", () => {
      const candidate = session;
      if (candidate && sessionIsCurrent(candidate) && candidate.playbackActivated) {
        candidate.startupWaitingEvents += 1;
        if (performance.now() - candidate.playbackActivatedAt <= STARTUP_PROTECTION_MS && !candidate.recovering && !video.seeking) {
          candidate.recovering = true;
          candidate.resumeWanted = true;
          candidate.playAttempted = false;
          candidate.recoveryTargetSeconds = Math.min(STARTUP_BUFFER_MAX_SECONDS, Math.max(STARTUP_RECOVERY_SECONDS, candidate.startupTargetSeconds + 2));
          log("刚开始播放就卡住了", `先暂停一下，多缓冲 ${candidate.recoveryTargetSeconds.toFixed(0)} 秒再继续。`, "info", "buffer");
          enginePause();
        }
        ensureBuffer(candidate);
      }
    });
    listen("ended", () => {
      publishState({ playerState: "ended", bufferedAhead: 0 });
      try { options.onEnded?.(); } catch (_error) {}
    });
    listen("error", () => {
      const candidate = session;
      if (!candidate || !sessionIsCurrent(candidate) || candidate.fatal) return;
      const mediaError = video.error;
      if (!mediaError) return;
      const decodeProblem = mediaError.code === 3 || mediaError.code === 4;
      // A codec the browser claimed to support but cannot actually decode: try the next family.
      if (decodeProblem && switchCodecFamily("解码失败")) return;
      fatal(candidate, new Error(`浏览器报告媒体错误（代码 ${mediaError.code}）${mediaError.message ? `：${mediaError.message}` : ""}`));
    });

    /* ---------------- public API ---------------- */

    function qualities() {
      return (selection?.videos || []).map((item) => ({
        id: Number(item.id) || 0,
        label: qualityLabel(item),
        codec: codecFamily(item),
        codecLabel: CODEC_LABELS[codecFamily(item)] || "",
        width: Number(item.width) || 0,
        height: Number(item.height) || 0,
        bandwidth: Number(item.bandwidth) || 0,
        selected: Boolean(selectedVideo && sameRepresentation(item, selectedVideo))
      }));
    }

    function announceQualities() {
      try { options.onQualities?.(qualities()); } catch (_error) {}
    }

    async function load(request) {
      if (destroyed) throw new Error("播放内核已经销毁");
      playinfo = request.playinfo;
      cdnBans.reset();
      aheadBytesCap = DEFAULT_AHEAD_BYTES;
      selection = selector.select(playinfo, String(getSettings()?.codec || "auto"));
      wantedQualityId = Math.max(0, Number(request.qualityId) || 0);
      const chosen = selector.pick(selection, wantedQualityId, maxAutoHeight());
      userWantsPlayback = request.autoplay !== false;
      selectedVideo = chosen;
      announceQualities();
      await startSession(chosen, {
        time: Math.max(0, Number(request.startTime) || 0),
        resume: userWantsPlayback,
        playbackRate: video.playbackRate || 1
      });
    }

    async function setQuality(id) {
      if (!selection || destroyed) return;
      wantedQualityId = Math.max(0, Number(id) || 0);
      const next = selector.pick(selection, wantedQualityId, maxAutoHeight());
      if (!next || (selectedVideo && sameRepresentation(next, selectedVideo))) return;
      const state = playbackState();
      selectedVideo = next;
      announceQualities();
      await startSession(next, state);
    }

    // Codec preference changed: choose again, keep the quality.
    async function reselect() {
      if (!playinfo || destroyed) return;
      selection = selector.select(playinfo, String(getSettings()?.codec || "auto"));
      const next = selector.pick(selection, Number(selectedVideo?.id) || wantedQualityId, maxAutoHeight());
      if (next && !(selectedVideo && sameRepresentation(next, selectedVideo))) {
        const state = playbackState();
        selectedVideo = next;
        await startSession(next, state);
      }
      announceQualities();
    }

    // Must be called synchronously from a tap/click handler.
    function userPlay() {
      userWantsPlayback = true;
      const candidate = session;
      if (candidate && sessionIsCurrent(candidate)) {
        candidate.resumeWanted = true;
        candidate.needsTap = false;
        if (candidate.playbackActivated && !candidate.recovering) {
          candidate.playAttempted = true;
          tryPlay(candidate);
          publishState();
          return;
        }
        candidate.playAttempted = false;
      }
      // Nothing to show yet. A play() inside the tap still unlocks the element for the engine's
      // own play() later on; the immediate pause keeps half-buffered video from flashing by.
      try {
        const promise = video.play();
        if (promise && typeof promise.catch === "function") promise.catch(() => {});
      } catch (_error) {}
      enginePause();
      if (candidate && sessionIsCurrent(candidate)) ensureBuffer(candidate);
      publishState();
    }

    function stop() {
      if (session) disposeSession(session, true);
      session = null;
      selection = null;
      selectedVideo = null;
      playinfo = null;
      publishState({ playerState: "idle" });
    }

    function destroy() {
      if (destroyed) return;
      clearTimeout(seekTimer);
      if (session) disposeSession(session, true);
      destroyed = true;
      session = null;
      eventController.abort();
    }

    return Object.freeze({
      load,
      stop,
      destroy,
      setQuality,
      reselect,
      userPlay,
      qualities,
      applySettings() { ensureBuffer(); },
      isManaged: () => flavour.managed,
      isUnlocked: () => gestureUnlocked,
      getDebug: () => ({
        engine: "btr-ios-progressive-mse",
        upstream: "bilibili-thread-ripper 0.9.1.3",
        managed: flavour.managed,
        quality: selectedVideo ? qualityLabel(selectedVideo) : "",
        qualityId: Number(selectedVideo?.id) || 0,
        codec: selectedVideo ? codecFamily(selectedVideo) : "",
        currentTime: Number(video.currentTime) || 0,
        mediaSourceState: session?.mediaSource?.readyState || "closed",
        playbackActivated: Boolean(session?.playbackActivated),
        recovering: Boolean(session?.recovering),
        needsTap: Boolean(session?.needsTap),
        userWantsPlayback,
        sessionStartTime: session?.startTime || 0,
        startupBufferSeconds: session?.startupTargetSeconds || 0,
        startupWaitingEvents: session?.startupWaitingEvents || 0,
        progressiveAppends: session?.progressiveAppends || 0,
        aheadBytesCap,
        seekReloads,
        holeRepairs,
        gapJumps,
        quotaEvents,
        decodeStalls,
        appleWebKit: isAppleWebKit(),
        droppedCodecFamilies: selector.droppedFamilies(),
        bannedHosts: cdnBans.hosts(),
        tracks: (session?.tracks || []).map((track) => ({ kind: track.kind, nextIndex: track.nextIndex, segments: track.sidx.segments.length, complete: track.complete }))
      })
    });
  }

  root.__BTRI_ENGINE__ = Object.freeze({
    createEngine,
    createSelector,
    isAppleWebKit,
    appleCodecString,
    relabelSampleEntryForApple,
    isSupportedPlatform,
    mediaSourceFlavour,
    qualityLabel,
    codecFamily,
    withDonorUrl,
    bufferedEndAt
  });
})(globalThis);

/* ---- src/app/api.js ---- */
/*
 * BTR-iOS: video identity parsing and the two Bilibili web requests the player needs.
 *
 * Exactly like upstream Bilibili-thread-ripper, only the play list that the signed-in browser is
 * already entitled to is read (same cookies, same origin rules as the site itself). Nothing here
 * works around login, membership, region, review state, DRM or URL signatures.
 */
(function installBtrIosApi(root) {
  "use strict";

  const API_ORIGIN = "https://api.bilibili.com";
  const BV_RE = /BV[0-9A-Za-z]{10}/;
  const AV_RE = /(?:^|[^0-9A-Za-z])av(\d{1,12})(?![0-9A-Za-z])/i;
  const SHORT_LINK_RE = /https?:\/\/(?:b23\.tv|bili2233\.cn)\/[0-9A-Za-z]+/i;

  // Accepts a BV id, an av id, any bilibili video URL, or text copied from the app's share
  // sheet ("【标题】 https://b23.tv/xxxx"). Returns null when nothing usable is in there.
  function parseVideoInput(text) {
    const raw = String(text || "").trim();
    if (!raw) return null;
    const result = { bvid: "", aid: 0, part: 1, time: 0, shortLink: "" };
    let query = "";
    const urlMatch = /https?:\/\/[^\s]+/i.exec(raw);
    if (urlMatch) {
      try {
        const url = new URL(urlMatch[0]);
        query = url.search;
        const short = SHORT_LINK_RE.exec(url.href);
        if (short && !BV_RE.test(url.pathname)) result.shortLink = short[0];
      } catch (_error) {}
    }
    const bv = BV_RE.exec(raw);
    if (bv) result.bvid = bv[0];
    else {
      const av = AV_RE.exec(raw);
      if (av) result.aid = Number(av[1]) || 0;
    }
    if (query) {
      const params = new URLSearchParams(query);
      result.part = Math.max(1, Math.trunc(Number(params.get("p"))) || 1);
      result.time = parseTime(params.get("t") || params.get("start_progress_ms"), params.has("start_progress_ms") && !params.has("t"));
    }
    if (!result.bvid && !result.aid && !result.shortLink) return null;
    return result;
  }

  // "90", "90.5", "1m30s", "1h2m3s"; milliseconds when the caller says so.
  function parseTime(value, isMilliseconds = false) {
    const raw = String(value || "").trim();
    if (!raw) return 0;
    if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.max(0, Number(raw) / (isMilliseconds ? 1000 : 1));
    const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/i.exec(raw);
    if (!match) return 0;
    return (Number(match[1]) || 0) * 3600 + (Number(match[2]) || 0) * 60 + (Number(match[3]) || 0);
  }

  function videoKey(identity) {
    return identity?.bvid ? identity.bvid : identity?.aid ? `av${identity.aid}` : "";
  }

  function describeApiError(payload, fallback) {
    const code = Number(payload?.code);
    const known = {
      "-101": "还没有登录哔哩哔哩（先在 Safari 里登录，再回来刷新）",
      "-352": "请求被哔哩哔哩的风控拦下了，过一会儿再试，或者先在 Safari 里正常打开一次 B 站",
      "-400": "请求参数有误",
      "-403": "当前账号没有权限观看这个视频",
      "-404": "找不到这个视频",
      "-412": "请求太频繁，被暂时拦截了，过一会儿再试",
      "62002": "这个视频不可见",
      "62004": "这个视频还在审核中",
      "62012": "这个视频仅 UP 主自己可见"
    };
    return known[String(code)] || payload?.message || fallback;
  }

  async function getJson(fetcher, url, signal) {
    let response;
    try {
      response = await fetcher(url, { credentials: "include", cache: "no-store", signal });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new Error(`连不上哔哩哔哩接口（${String(error?.message || error).slice(0, 80)}）`);
    }
    if (!response.ok) throw new Error(`哔哩哔哩接口返回 HTTP ${response.status}`);
    try { return await response.json(); }
    catch (_error) { throw new Error("哔哩哔哩接口返回的不是 JSON"); }
  }

  function createApi(options = {}) {
    const fetcher = options.fetch || root.fetch.bind(root);
    const origin = String(options.apiOrigin || API_ORIGIN).replace(/\/+$/, "");

    async function view(identity, signal) {
      const query = identity.bvid
        ? `bvid=${encodeURIComponent(identity.bvid)}`
        : `aid=${encodeURIComponent(identity.aid)}`;
      const payload = await getJson(fetcher, `${origin}/x/web-interface/view?${query}`, signal);
      if (Number(payload?.code) !== 0 || !payload?.data) throw new Error(describeApiError(payload, "读取视频信息失败"));
      const data = payload.data;
      const pages = (Array.isArray(data.pages) ? data.pages : []).map((page, index) => ({
        cid: Number(page?.cid) || 0,
        page: Number(page?.page) || index + 1,
        part: String(page?.part || ""),
        duration: Number(page?.duration) || 0
      })).filter((page) => page.cid > 0);
      if (!pages.length && Number(data.cid) > 0) pages.push({ cid: Number(data.cid), page: 1, part: "", duration: Number(data.duration) || 0 });
      if (!pages.length) throw new Error("这个视频缺少 CID");
      return {
        bvid: String(data.bvid || identity.bvid || ""),
        aid: Number(data.aid || identity.aid) || 0,
        title: String(data.title || ""),
        cover: String(data.pic || "").replace(/^http:/, "https:"),
        owner: String(data.owner?.name || ""),
        duration: Number(data.duration) || 0,
        pages
      };
    }

    // Same request as upstream: the best quality the account may have, as DASH, every codec.
    async function playurl(info, cid, signal) {
      const query = info.bvid
        ? `bvid=${encodeURIComponent(info.bvid)}`
        : `avid=${encodeURIComponent(info.aid)}`;
      const payload = await getJson(fetcher, `${origin}/x/player/playurl?${query}&cid=${encodeURIComponent(cid)}&qn=127&fnval=4048&fnver=0&fourk=1`, signal);
      if (Number(payload?.code) !== 0) throw new Error(describeApiError(payload, "读取播放清单失败"));
      const body = payload?.data?.dash ? payload.data : payload?.result?.dash ? payload.result : null;
      if (!body) throw new Error("这个视频没有 DASH 播放清单（可能是地区、权限或登录限制）");
      return payload;
    }

    return Object.freeze({ view, playurl });
  }

  function isLoggedIn() {
    try { return /(?:^|;\s*)DedeUserID=\d+/.test(root.document?.cookie || ""); }
    catch (_error) { return false; }
  }

  root.__BTRI_API__ = Object.freeze({ createApi, parseVideoInput, parseTime, videoKey, isLoggedIn, SHORT_LINK_RE });
})(globalThis);

/* ---- src/app/store.js ---- */
/*
 * BTR-iOS: settings and watch history, kept in this site's localStorage only.
 * Everything still works (with defaults, without memory) when storage is unavailable, which is
 * the case in Safari's private mode with content blockers or when the quota is exhausted.
 */
(function installBtrIosStore(root) {
  "use strict";

  const PREFIX = "BTRI.";
  const THREAD_OPTIONS = Object.freeze([4, 8, 16, 32, 64]);
  const DEFAULTS = Object.freeze({
    enabled: true,
    mode: "mainland",
    concurrency: 8,
    codec: "auto",
    maxAutoHeight: 1080,
    qualityId: 0,
    autoNextPart: true,
    rememberProgress: true,
    engine: "auto",
    autoOpen: false,
    danmaku: true,
    danmakuArea: 0.5,
    droppedCodecs: []
  });

  function read(key, fallback) {
    try {
      const raw = root.localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (_error) {
      return fallback;
    }
  }

  function write(key, value) {
    try { root.localStorage.setItem(PREFIX + key, JSON.stringify(value)); return true; }
    catch (_error) { return false; }
  }

  function normalizeSettings(input) {
    const source = input && typeof input === "object" ? input : {};
    const concurrency = Math.trunc(Number(source.concurrency));
    const maxAutoHeight = Math.trunc(Number(source.maxAutoHeight));
    return {
      enabled: true,
      mode: source.mode === "overseas" ? "overseas" : "mainland",
      concurrency: THREAD_OPTIONS.includes(concurrency) ? concurrency : DEFAULTS.concurrency,
      codec: ["auto", "avc", "hevc", "av1"].includes(source.codec) ? source.codec : "auto",
      maxAutoHeight: [720, 1080, 2160, 4320].includes(maxAutoHeight) ? maxAutoHeight : DEFAULTS.maxAutoHeight,
      qualityId: Math.max(0, Math.trunc(Number(source.qualityId)) || 0),
      autoNextPart: source.autoNextPart !== false,
      rememberProgress: source.rememberProgress !== false,
      engine: ["auto", "mse", "mms"].includes(source.engine) ? source.engine : "auto",
      autoOpen: source.autoOpen === true,
      danmaku: source.danmaku !== false,
      danmakuArea: [0.25, 0.5, 0.75, 1].includes(Number(source.danmakuArea)) ? Number(source.danmakuArea) : DEFAULTS.danmakuArea,
      // codec families this device turned out not to decode (see engine: switchCodecFamily)
      droppedCodecs: Array.isArray(source.droppedCodecs)
        ? [...new Set(source.droppedCodecs.filter((family) => ["av1", "hevc", "avc"].includes(family)))].sort()
        : []
    };
  }

  function createStore() {
    let settings = normalizeSettings(read("settings", DEFAULTS));
    const listeners = new Set();

    function update(patch) {
      const next = normalizeSettings({ ...settings, ...patch });
      const changed = Object.keys(next).filter((key) => JSON.stringify(next[key]) !== JSON.stringify(settings[key]));
      if (!changed.length) return settings;
      const previous = settings;
      settings = next;
      write("settings", settings);
      for (const listener of listeners) {
        try { listener(settings, previous, changed); } catch (_error) {}
      }
      return settings;
    }

    function history() {
      const list = read("history", []);
      return Array.isArray(list) ? list.filter((item) => item && typeof item === "object" && item.key) : [];
    }

    // One entry per video (not per part); the newest first, fifty at most.
    function remember(entry) {
      if (!entry?.key) return;
      const list = history().filter((item) => item.key !== entry.key);
      list.unshift({
        key: String(entry.key),
        title: String(entry.title || "").slice(0, 120),
        owner: String(entry.owner || "").slice(0, 40),
        cover: String(entry.cover || "").slice(0, 300),
        part: Math.max(1, Math.trunc(Number(entry.part)) || 1),
        parts: Math.max(1, Math.trunc(Number(entry.parts)) || 1),
        time: Math.max(0, Math.round((Number(entry.time) || 0) * 10) / 10),
        duration: Math.max(0, Math.round(Number(entry.duration) || 0)),
        at: Date.now()
      });
      write("history", list.slice(0, 50));
    }

    function recall(key, part) {
      const item = history().find((entry) => entry.key === key);
      if (!item || item.part !== part) return 0;
      if (item.duration > 0 && item.time > item.duration - 8) return 0;
      return item.time > 5 ? item.time : 0;
    }

    function forget(key) {
      write("history", key ? history().filter((item) => item.key !== key) : []);
    }

    return Object.freeze({
      get: () => settings,
      update,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      history,
      remember,
      recall,
      forget
    });
  }

  root.__BTRI_STORE__ = Object.freeze({ createStore, normalizeSettings, THREAD_OPTIONS, DEFAULTS });
})(globalThis);

/* ---- src/app/danmaku.js ---- */
/*
 * BTR-iOS: a small danmaku layer for the player's own <video>.
 *
 * Upstream 0.9 keeps Bilibili's player and therefore its danmaku; this port has its own player, so
 * it brings a light layer of its own (scrolling, top and bottom comments; the scripted "advanced"
 * modes are left out, as in upstream 0.8). The comment file is the same public XML upstream 0.8
 * read. On iPhone the layer is visible inline (portrait or landscape) but not in the system's
 * full-screen player, which shows nothing but the video.
 */
(function installBtrIosDanmaku(root) {
  "use strict";

  const MAX_ITEMS = 6000;
  const MAX_ON_SCREEN = 90;
  const SCROLL_SECONDS = 8;
  const FIXED_SECONDS = 4;
  const MAX_XML_CHARS = 20 * 1024 * 1024;

  function decimalColor(value) {
    const number = Math.max(0, Math.min(0xffffff, Number(value)));
    return `#${Math.trunc(Number.isFinite(number) ? number : 0xffffff).toString(16).padStart(6, "0")}`;
  }

  // <d p="time,mode,size,color,sent,pool,user,id,…">text</d>; modes 1-3 scroll, 4 bottom, 5 top.
  function parseXml(xml) {
    if (typeof xml !== "string" || xml.length > MAX_XML_CHARS) throw new Error("弹幕数据格式或大小异常");
    const parsed = new root.DOMParser().parseFromString(xml, "text/xml");
    if (parsed.querySelector("parsererror")) throw new Error("弹幕 XML 解析失败");
    const items = [];
    for (const node of parsed.querySelectorAll("d")) {
      if (items.length >= MAX_ITEMS) break;
      const fields = String(node.getAttribute("p") || "").split(",");
      const mode = Number(fields[1]);
      if (![1, 2, 3, 4, 5, 6].includes(mode)) continue;
      const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      items.push({
        time: Math.max(0, Number(fields[0]) || 0),
        kind: mode === 5 ? "top" : mode === 4 ? "bottom" : "scroll",
        color: decimalColor(fields[3] === undefined ? 0xffffff : fields[3]),
        text: text.slice(0, 120)
      });
    }
    items.sort((a, b) => a.time - b.time);
    return items;
  }

  // Tries the places the XML can come from, in order; resolves to [] when none works.
  async function load(cid, sources, signal) {
    const errors = [];
    for (const source of sources) {
      try {
        const response = await root.fetch(source.url(cid), { credentials: "omit", cache: "no-store", signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return { items: parseXml(await response.text()), via: source.name, errors };
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        errors.push(`${source.name}: ${String(error?.message || error).slice(0, 80)}`);
      }
    }
    return { items: [], via: "", errors };
  }

  function createLayer(options) {
    const video = options.video;
    const layer = options.container;
    let items = [];
    let cursor = 0;          // index of the next item to show
    let lastTime = 0;
    let enabled = true;
    let area = 0.5;
    let timer = null;
    const live = new Set();  // { node, animation, lane, kind }
    const scrollLanes = [];  // per lane: when its last comment has cleared the right edge / left the screen
    const fixedLanes = { top: [], bottom: [] };

    function metrics() {
      const width = layer.clientWidth || video.clientWidth || 320;
      const height = layer.clientHeight || video.clientHeight || 180;
      const fontSize = Math.max(13, Math.min(26, Math.round(width / 24)));
      const laneHeight = Math.round(fontSize * 1.4);
      const lanes = Math.max(1, Math.floor(height * area / laneHeight));
      return { width, height, fontSize, laneHeight, lanes };
    }

    function clear() {
      for (const entry of live) {
        try { entry.animation.cancel(); } catch (_error) {}
        entry.node.remove();
      }
      live.clear();
      scrollLanes.length = 0;
      fixedLanes.top.length = 0;
      fixedLanes.bottom.length = 0;
    }

    function locate(time) {
      let low = 0;
      let high = items.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (items[middle].time < time) low = middle + 1;
        else high = middle;
      }
      return low;
    }

    function finish(entry) {
      if (!live.delete(entry)) return;
      entry.node.remove();
    }

    function show(item, now) {
      if (live.size >= MAX_ON_SCREEN) return;
      const size = metrics();
      const node = document.createElement("span");
      node.className = "dm-item";
      node.textContent = item.text;
      node.style.color = item.color;
      node.style.fontSize = `${size.fontSize}px`;
      layer.append(node);
      const width = node.offsetWidth || item.text.length * size.fontSize;
      let lane = -1;
      let keyframes;
      let duration;
      if (item.kind === "scroll") {
        duration = SCROLL_SECONDS * 1000;
        const speed = (size.width + width) / duration;                 // px per ms
        const reachesLeftAt = now + size.width / speed;               // when this comment's head gets to the left edge
        for (let index = 0; index < size.lanes; index += 1) {
          const state = scrollLanes[index];
          if (!state || (state.clearOfRightEdgeAt <= now && state.goneAt <= reachesLeftAt)) { lane = index; break; }
        }
        if (lane < 0) { node.remove(); return; }
        scrollLanes[lane] = { clearOfRightEdgeAt: now + (width + 24) / speed, goneAt: now + duration };
        node.style.top = `${lane * size.laneHeight}px`;
        keyframes = [{ transform: `translate3d(${size.width}px,0,0)` }, { transform: `translate3d(${-width}px,0,0)` }];
      } else {
        duration = FIXED_SECONDS * 1000;
        const taken = fixedLanes[item.kind];
        for (let index = 0; index < size.lanes; index += 1) {
          if (!taken[index] || taken[index] <= now) { lane = index; break; }
        }
        if (lane < 0) { node.remove(); return; }
        taken[lane] = now + duration;
        node.style.left = "50%";
        if (item.kind === "top") node.style.top = `${lane * size.laneHeight}px`;
        else { node.style.top = "auto"; node.style.bottom = `${lane * size.laneHeight + 4}px`; }
        keyframes = [{ transform: "translate3d(-50%,0,0)" }, { transform: "translate3d(-50%,0,0)" }];
      }
      const animation = node.animate(keyframes, { duration, easing: "linear", fill: "both" });
      const entry = { node, animation };
      live.add(entry);
      animation.playbackRate = video.playbackRate || 1;
      if (video.paused) animation.pause();
      animation.onfinish = () => finish(entry);
      animation.oncancel = () => finish(entry);
    }

    function tick() {
      if (!enabled || !items.length || video.paused || video.seeking) return;
      const time = Number(video.currentTime) || 0;
      if (time < lastTime - 0.5 || time > lastTime + 2.5) {
        // a jump: do not replay or fast-forward through everything in between
        clear();
        cursor = locate(time);
      }
      lastTime = time;
      const now = performance.now();
      let shown = 0;
      while (cursor < items.length && items[cursor].time <= time) {
        if (time - items[cursor].time < 1.5 && shown < 12) { show(items[cursor], now); shown += 1; }
        cursor += 1;
      }
    }

    // Lane bookkeeping runs on the wall clock while the comments run on the video's clock: when the
    // picture stands still, the lanes' timetables are pushed back by the same amount afterwards.
    let frozenAt = 0;
    function freeze(paused) {
      const now = performance.now();
      if (paused && !frozenAt) frozenAt = now;
      if (!paused && frozenAt) {
        const shift = now - frozenAt;
        frozenAt = 0;
        for (const state of scrollLanes) if (state) { state.clearOfRightEdgeAt += shift; state.goneAt += shift; }
        for (const list of [fixedLanes.top, fixedLanes.bottom]) for (let index = 0; index < list.length; index += 1) if (list[index]) list[index] += shift;
      }
      for (const entry of live) {
        try { if (paused) entry.animation.pause(); else entry.animation.play(); } catch (_error) {}
      }
    }

    const events = new AbortController();
    const on = (name, handler) => video.addEventListener(name, handler, { signal: events.signal });
    on("pause", () => freeze(true));
    on("play", () => freeze(false));
    on("playing", () => freeze(false));
    on("waiting", () => freeze(true));
    on("seeking", () => { clear(); });
    on("seeked", () => { cursor = locate(Number(video.currentTime) || 0); lastTime = Number(video.currentTime) || 0; });
    on("ratechange", () => { for (const entry of live) entry.animation.playbackRate = video.playbackRate || 1; });
    on("emptied", () => clear());
    timer = setInterval(tick, 200);

    return Object.freeze({
      setItems(list) {
        clear();
        items = Array.isArray(list) ? list : [];
        lastTime = Number(video.currentTime) || 0;
        cursor = locate(lastTime);
      },
      setEnabled(value) {
        enabled = Boolean(value);
        layer.hidden = !enabled;
        if (!enabled) clear();
        else { lastTime = Number(video.currentTime) || 0; cursor = locate(lastTime); }
      },
      setArea(value) { area = Math.max(0.25, Math.min(1, Number(value) || 0.5)); },
      count: () => items.length,
      onScreen: () => live.size,
      destroy() { clearInterval(timer); events.abort(); clear(); }
    });
  }

  root.__BTRI_DANMAKU__ = Object.freeze({ createLayer, load, parseXml });
})(globalThis);

/* ---- src/app/ui.js ---- */
/*
 * BTR-iOS: the touch UI around the engine. One component, two ways to show it:
 *   - "page":    the whole document (the page the Loon plugin serves at /__btr__/), hash routed;
 *   - "overlay": a full-screen layer on top of a bilibili video page (userscript build).
 * Everything lives in a shadow root so neither side's CSS leaks into the other.
 */
(function installBtrIosUi(root) {
  "use strict";

  const engineTools = root.__BTRI_ENGINE__;
  const apiTools = root.__BTRI_API__;
  const storeTools = root.__BTRI_STORE__;
  const danmakuTools = root.__BTRI_DANMAKU__;
  if (!engineTools || !apiTools || !storeTools) return;

  const UPSTREAM_URL = "https://github.com/MrTangLuyao/Bilibili-thread-ripper";
  const LOGIN_URL = "https://passport.bilibili.com/login";
  const KIND_NAMES = Object.freeze({ video: "画面", audio: "声音", meta: "索引" });
  const STATE_TEXT = Object.freeze({
    idle: "空闲", loading: "正在准备播放", ready: "正在播放", paused: "已暂停",
    buffering: "正在补充缓冲", ended: "播放完了", error: "出错了"
  });

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key in node && key !== "list" && key !== "type") {
        try { node[key] = value; } catch (_error) { node.setAttribute(key, value === true ? "" : String(value)); }
      }
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function formatSpeed(bytesPerSecond) {
    const value = Math.max(0, Number(bytesPerSecond) || 0);
    if (value >= 1048576) return `${(value / 1048576).toFixed(value >= 10485760 ? 0 : 1)} MB/s`;
    return `${Math.round(value / 1024)} KB/s`;
  }

  function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value >= 1073741824) return `${(value / 1073741824).toFixed(2)} GB`;
    if (value >= 1048576) return `${(value / 1048576).toFixed(value >= 104857600 ? 0 : 1)} MB`;
    return `${Math.round(value / 1024)} KB`;
  }

  function formatClock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = String(total % 60).padStart(2, "0");
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
  }

  function shortHost(host) {
    return String(host || "").replace(/^upos-(?:sz|hz)-/, "").replace(/\.(?:bilivideo\.com|akamaized\.net)$/, "");
  }

  function createApp(options) {
    const mode = options.mode === "overlay" ? "overlay" : "page";
    const version = String(options.version || "dev");
    const store = storeTools.createStore();
    const api = apiTools.createApi({ fetch: options.fetch, apiOrigin: options.apiOrigin });
    const host = h("div", { id: "__btri_root__" });
    const shadow = host.attachShadow({ mode: "open" });
    shadow.append(h("style", { text: String(options.css || "") }));

    /* ---------------- state ---------------- */

    let engine = null;
    let engineError = "";
    let view = "home";
    let current = null;          // { identity, info, partIndex }
    let loadController = null;
    let loadSequence = 0;
    let lastState = { playerState: "idle" };
    let infoMessage = "";
    let failure = "";
    let tapped = false;
    let lastSavedAt = 0;
    let statsTimer = null;
    let transferSequence = 1;
    const transfers = new Map();
    const totals = { bytes: 0, segments: 0, pieces: 0 };
    const logs = [];

    /* ---------------- persistent <video> ---------------- */

    const video = h("video", { controls: true, playsInline: true, preload: "auto" });
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.setAttribute("x5-playsinline", "");

    /* ---------------- DOM ---------------- */

    const statusText = h("span", { text: "" });
    const closeButton = h("button", { type: "button", text: mode === "overlay" ? "关闭" : "返回", onclick: () => (mode === "overlay" && view === "home" ? close() : goHome()) });
    const bar = h("header", { class: "bar" },
      h("div", { class: "brand" }, h("b", {}, h("i", { text: "⚡" }), " BTR"), statusText),
      closeButton);

    const veilPlay = h("button", { class: "play", type: "button", "aria-label": "播放", text: "▶" });
    const veilSpin = h("div", { class: "spin", role: "status", "aria-label": "加载中" });
    const veilNote = h("div", { class: "note" });
    const veilRetry = h("button", { class: "retry", type: "button", text: "重试", onclick: (event) => { event.stopPropagation(); retry(true); } });
    // The mirrors are known to accept requests from www.bilibili.com pages; for other bilibili
    // hosts that is likely but not certain. Offer the way over when something failed elsewhere.
    const onProvenOrigin = root.location?.hostname === "www.bilibili.com";
    const veilSwitch = h("button", { class: "retry", type: "button", text: "换到 www.bilibili.com 再试", onclick: (event) => {
      event.stopPropagation();
      root.location.href = `https://www.bilibili.com/__btr__/${root.location.hash || ""}`;
    } });
    const veil = h("div", { class: "veil" }, veilPlay, veilSpin, veilNote, veilRetry, veilSwitch);
    veil.addEventListener("click", () => { if (veil.classList.contains("tap")) userTap(); });
    const danmakuNode = h("div", { class: "dm", "aria-hidden": "true" });
    const stage = h("div", { class: "stage", hidden: true }, video, danmakuNode, veil);
    const danmaku = danmakuTools ? danmakuTools.createLayer({ video, container: danmakuNode }) : null;
    let danmakuController = null;

    const titleNode = h("h1", { class: "title" });
    const metaNode = h("div", { class: "meta" });
    const partSelect = h("select", { "aria-label": "分 P", onchange: () => switchPart(Number(partSelect.value), true) });
    const partRow = h("div", { class: "row", hidden: true }, h("label", { text: "分 P" }), partSelect);
    const qualitySelect = h("select", { "aria-label": "清晰度", onchange: () => chooseQuality(Number(qualitySelect.value)) });
    const danmakuSeg = segmented("弹幕", [{ label: "开", value: "on" }, { label: "关", value: "off" }], (value) => store.update({ danmaku: value === "on" }));
    const danmakuNote = h("span", { class: "k dmcount", style: "flex:1;text-align:right", text: "" });
    const infoCard = h("section", { class: "card" }, titleNode, metaNode,
      h("div", { class: "rows", style: "margin-top:12px" },
        partRow,
        h("div", { class: "row" }, h("label", { text: "清晰度" }), qualitySelect),
        h("div", { class: "row", hidden: !danmaku }, h("span", { class: "k", text: "弹幕" }), danmakuNote, danmakuSeg)));

    const statThreads = h("b", { text: "0" });
    const statSpeed = h("b", { text: "0 KB/s" });
    const statBuffer = h("b", { text: "0 秒" });
    const lanes = h("div", { class: "lanes", "aria-hidden": "true" });
    const hostsNode = h("div", { class: "hosts" });
    const statusLine = h("div", { class: "statusline" });
    const statsCard = h("section", { class: "card" },
      h("h2", { text: "加速状态" }),
      h("div", { class: "stats" },
        h("div", { class: "stat" }, statThreads, h("span", { text: "在途线程" })),
        h("div", { class: "stat" }, statSpeed, h("span", { text: "下载速度" })),
        h("div", { class: "stat" }, statBuffer, h("span", { text: "前方缓冲" }))),
      lanes, hostsNode, statusLine);

    function segmented(name, choices, onPick) {
      const node = h("div", { class: "seg", role: "group", "aria-label": name });
      for (const choice of choices) {
        node.append(h("button", { type: "button", text: choice.label, dataset: { value: String(choice.value) }, onclick: () => onPick(choice.value) }));
      }
      node.sync = (value) => {
        for (const button of node.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.value === String(value)));
      };
      return node;
    }

    const modeSeg = segmented("CDN 模式", [{ label: "大陆 CDN", value: "mainland" }, { label: "海外 CDN", value: "overseas" }], (value) => store.update({ mode: value }));
    const threadSeg = segmented("并发线程", storeTools.THREAD_OPTIONS.map((value) => ({ label: String(value), value })), (value) => store.update({ concurrency: Number(value) }));
    // Asking for a codec by name also gives it another chance if it was written off earlier.
    const codecSeg = segmented("编码", [{ label: "自动", value: "auto" }, { label: "AVC", value: "avc" }, { label: "HEVC", value: "hevc" }, { label: "AV1", value: "av1" }],
      (value) => store.update({ codec: value, droppedCodecs: store.get().droppedCodecs.filter((family) => family !== value) }));
    const capSeg = segmented("自动清晰度上限", [{ label: "720P", value: 720 }, { label: "1080P", value: 1080 }, { label: "4K", value: 2160 }, { label: "不限", value: 4320 }], (value) => store.update({ maxAutoHeight: Number(value) }));
    const areaSeg = segmented("弹幕显示区域", [{ label: "1/4", value: 0.25 }, { label: "半屏", value: 0.5 }, { label: "3/4", value: 0.75 }, { label: "全屏", value: 1 }], (value) => store.update({ danmakuArea: Number(value) }));
    const nextSwitch = h("input", { type: "checkbox", onchange: () => store.update({ autoNextPart: nextSwitch.checked }) });
    const progressSwitch = h("input", { type: "checkbox", onchange: () => store.update({ rememberProgress: progressSwitch.checked }) });
    const autoOpenSwitch = h("input", { type: "checkbox", onchange: () => store.update({ autoOpen: autoOpenSwitch.checked }) });
    const settingsCard = h("section", { class: "card" },
      h("h2", { text: "线程撕裂者设置" }),
      h("div", { class: "rows" },
        h("div", { class: "row" }, h("span", { class: "k", text: "CDN 模式" }), h("div", { class: "v" }, modeSeg)),
        h("div", { class: "row" }, h("span", { class: "k", text: "并发线程" }), h("div", { class: "v" }, threadSeg)),
        h("div", { class: "row" }, h("span", { class: "k", text: "视频编码" }), h("div", { class: "v" }, codecSeg)),
        h("div", { class: "row" }, h("span", { class: "k", text: "自动上限" }), h("div", { class: "v" }, capSeg)),
        danmaku ? h("div", { class: "row" }, h("span", { class: "k", text: "弹幕区域" }), h("div", { class: "v" }, areaSeg)) : null,
        h("div", { class: "row" }, h("span", { class: "k", text: "自动连播" }), h("div", { class: "v" }, h("label", { class: "switch" }, nextSwitch, "播完自动放下一 P"))),
        h("div", { class: "row" }, h("span", { class: "k", text: "记住进度" }), h("div", { class: "v" }, h("label", { class: "switch" }, progressSwitch, "下次从上次的位置继续"))),
        mode === "overlay"
          ? h("div", { class: "row" }, h("span", { class: "k", text: "自动接管" }), h("div", { class: "v" }, h("label", { class: "switch" }, autoOpenSwitch, "打开视频页就弹出加速播放器")))
          : null),
      h("p", { class: "hint", text: "海外看冷门视频、高码率视频：大陆 CDN + 8～32 线程。线程不是越多越快；设备发热或者反而变慢就调低。" }));

    const input = h("input", {
      type: "url", inputMode: "url", autocapitalize: "off", autocomplete: "off", spellcheck: false,
      placeholder: "粘贴 B 站链接、b23.tv 短链或 BV 号", "aria-label": "视频链接或 BV 号",
      onkeydown: (event) => { if (event.key === "Enter") { event.preventDefault(); submitInput(); } }
    });
    const openHint = h("p", { class: "hint", hidden: true });
    const openCard = h("section", { class: "card" },
      h("h2", { text: "打开视频" }),
      h("div", { class: "open" }, input, h("button", { class: "primary", type: "button", text: "播放", onclick: () => submitInput() })),
      h("div", { class: "open", style: "margin-top:8px" },
        h("button", { class: "ghost", type: "button", text: "从剪贴板粘贴并播放", onclick: () => pasteAndOpen() })),
      openHint);

    const loginHint = h("section", { class: "card", hidden: true },
      h("h2", { text: "还没有登录" }),
      h("p", { class: "hint", style: "margin:0" }, "未登录时 B 站只给低清晰度。先在这个浏览器里登录哔哩哔哩，再回来刷新：", h("a", { href: LOGIN_URL, text: "去登录" })));

    const historyList = h("ul", { class: "history" });
    const historyEmpty = h("p", { class: "empty", text: "这里会列出你用线程撕裂者看过的视频。" });
    const historyCard = h("section", { class: "card" }, h("h2", { text: "最近看过" }), historyList, historyEmpty);

    const logList = h("ul", { class: "loglist" });
    const logCard = h("section", { class: "card" },
      h("details", { class: "log" },
        h("summary", { text: "调试日志（反馈问题时请复制这里的内容）" }),
        h("div", { class: "logtools" },
          h("button", { type: "button", text: "复制日志", onclick: () => copyLogs() }),
          h("button", { type: "button", text: "清空", onclick: () => { logs.length = 0; logList.replaceChildren(); } })),
        logList));

    const unsupportedCard = h("section", { class: "card", hidden: true },
      h("h2", { text: "这台设备暂时用不了" }),
      h("p", { class: "hint bad", style: "margin:0" }));

    const foot = h("p", { class: "foot" },
      `BTR-iOS ${version} · 非官方工具，与哔哩哔哩无关。`, h("br"),
      "下载内核来自开源项目 ", h("a", { href: UPSTREAM_URL, target: "_blank", rel: "noopener", text: "Bilibili 线程撕裂者" }),
      "（MIT）。不会绕过登录、会员、地区或版权限制。");

    const playerSection = h("div", { hidden: true, style: "display:contents" }, infoCard, statsCard);
    const homeSection = h("div", { style: "display:contents" }, openCard, loginHint, historyCard);
    const page = h("main", { class: "page" }, unsupportedCard, playerSection, homeSection, settingsCard, logCard, foot);
    const app = h("div", { class: mode === "overlay" ? "app overlay" : "app" }, bar, stage, page);
    shadow.append(app);

    /* ---------------- logging ---------------- */

    function log(title, detail = "", level = "info", category = "other") {
      const entry = { at: new Date(), title: String(title), detail: String(detail || ""), level, category };
      logs.push(entry);
      if (logs.length > 300) logs.splice(0, logs.length - 300);
      const stamp = entry.at.toTimeString().slice(0, 8);
      const item = h("li", { class: level }, h("time", { text: stamp }), entry.detail ? `${entry.title} — ${entry.detail}` : entry.title);
      logList.prepend(item);
      while (logList.childElementCount > 300) logList.lastElementChild.remove();
    }

    function debugSnapshot() {
      return {
        version, mode,
        origin: root.location?.origin || "",
        userAgent: root.navigator?.userAgent || "",
        mediaSource: typeof root.MediaSource, managedMediaSource: typeof root.ManagedMediaSource,
        loggedIn: apiTools.isLoggedIn(),
        settings: store.get(),
        video: current ? { key: apiTools.videoKey(current.info || current.identity), part: current.partIndex + 1 } : null,
        state: lastState.playerState,
        engine: engine ? engine.getDebug() : null,
        totals
      };
    }

    function logsAsText() {
      const lines = logs.map((entry) => `${entry.at.toISOString()} [${entry.level}/${entry.category}] ${entry.title}${entry.detail ? ` — ${entry.detail.replace(/\n/g, " | ")}` : ""}`);
      return `BTR-iOS 调试信息\n${JSON.stringify(debugSnapshot(), null, 1)}\n\n${lines.join("\n")}`;
    }

    async function copyLogs() {
      const text = logsAsText();
      try {
        await root.navigator.clipboard.writeText(text);
        log("日志已经复制到剪贴板", "", "success");
      } catch (_error) {
        const area = h("textarea", { value: text, readOnly: true, style: "width:100%;height:160px;margin-top:8px" });
        logCard.append(area);
        area.focus();
        area.select();
        log("没有剪贴板权限", "日志已经放进下面的文本框，长按全选后复制。", "info");
      }
    }

    /* ---------------- transfers → numbers ---------------- */

    function onTransfer(event) {
      if (event?.phase === "start") {
        const id = transferSequence++;
        let hostName = "";
        try { hostName = new URL(event.url).hostname; } catch (_error) {}
        transfers.set(id, {
          id, kind: ["video", "audio", "meta"].includes(event.kind) ? event.kind : "video", host: hostName,
          loaded: 0, startedAt: Date.now(), sampleAt: Date.now(), sampleBytes: 0, lastByteAt: 0, bps: 0
        });
        return id;
      }
      const item = transfers.get(Number(event?.id));
      if (!item) return event?.id;
      if (event.phase === "progress") {
        const bytes = Math.max(0, Number(event.bytes) || 0);
        const now = Date.now();
        item.loaded += bytes;
        item.sampleBytes += bytes;
        item.lastByteAt = now;
        totals.bytes += bytes;
        const elapsed = Math.max(1, now - item.sampleAt);
        if (elapsed >= 250) {
          item.bps = item.sampleBytes * 1000 / elapsed;
          item.sampleAt = now;
          item.sampleBytes = 0;
        } else if (!item.bps) {
          item.bps = item.loaded * 1000 / Math.max(1, now - item.startedAt);
        }
      } else {
        if (event.phase === "error") {
          log("一小块没能下载下来", `${KIND_NAMES[item.kind] || "数据"} · ${item.host} · 已收到 ${Math.round(item.loaded / 1024)} KiB · ${String(event.error?.message || event.error || "").slice(0, 120)}`, "error", "download");
        }
        transfers.delete(item.id);
      }
      return event.id;
    }

    function renderStats() {
      const now = Date.now();
      const active = Array.from(transfers.values());
      const speed = active.reduce((sum, item) => sum + (item.lastByteAt && now - item.lastByteAt < 1800 ? item.bps : 0), 0);
      statThreads.textContent = String(active.length);
      statSpeed.textContent = formatSpeed(speed);
      statBuffer.textContent = `${Math.round(Number(lastState.bufferedAhead) || 0)} 秒`;
      const wanted = active.slice(0, 64);
      while (lanes.childElementCount > wanted.length) lanes.lastElementChild.remove();
      while (lanes.childElementCount < wanted.length) lanes.append(h("span", { class: "lane" }));
      wanted.forEach((item, index) => { lanes.children[index].className = `lane ${item.kind}`; });
      const byHost = new Map();
      for (const item of lastState.cdnHosts || []) {
        const known = byHost.get(item.host);
        if (!known || known.state === "untested" || ["blocked", "banned"].includes(item.state)) byHost.set(item.host, item);
      }
      const chips = Array.from(byHost.values()).slice(0, 16);
      while (hostsNode.childElementCount > chips.length) hostsNode.lastElementChild.remove();
      while (hostsNode.childElementCount < chips.length) hostsNode.append(h("span", { class: "host" }));
      chips.forEach((item, index) => {
        const chip = hostsNode.children[index];
        chip.className = `host ${item.state}`;
        chip.textContent = item.bps ? `${shortHost(item.host)} ${formatSpeed(item.bps)}` : shortHost(item.host);
        chip.title = item.host;
      });
      const parts = [STATE_TEXT[lastState.playerState] || ""];
      if (lastState.quality) parts.push(`${lastState.quality}${lastState.codec && lastState.codec !== "other" ? ` ${lastState.codec.toUpperCase()}` : ""}`);
      if (engine) parts.push(engine.isManaged() ? "ManagedMediaSource" : "MediaSource");
      if (totals.bytes) parts.push(`已下载 ${formatBytes(totals.bytes)}`);
      statusLine.textContent = parts.filter(Boolean).join(" · ");
      statusText.textContent = view === "player"
        ? `${active.length} 线程 · ${formatSpeed(speed)}`
        : "线程撕裂者 iOS";
    }

    /* ---------------- veil over the video ---------------- */

    function renderVeil() {
      const state = lastState.playerState;
      let kind = "none";
      let note = "";
      if (failure) { kind = "error"; note = failure; }
      else if (infoMessage) { kind = "spin"; note = infoMessage; }
      else if (state === "ended") kind = "none";
      else if (lastState.needsTap || (!tapped && video.paused)) { kind = "tap"; note = state === "loading" ? "点一下开始播放（正在后台缓冲）" : "点一下开始播放"; }
      else if (state === "loading") { kind = "spin"; note = "正在多线程缓冲…"; }
      else if (state === "buffering") { kind = "spin"; note = "正在补充缓冲…"; }
      veil.hidden = kind === "none";
      veil.classList.toggle("tap", kind === "tap");
      veilPlay.hidden = kind !== "tap";
      veilSpin.hidden = kind !== "spin";
      veilRetry.hidden = kind !== "error";
      veilSwitch.hidden = kind !== "error" || mode !== "page" || onProvenOrigin;
      veilNote.textContent = note;
      const cover = current?.info?.cover;
      veil.style.backgroundImage = cover && (kind === "tap" || kind === "error" || (kind === "spin" && !lastState.bufferedAhead))
        ? `linear-gradient(rgba(0,0,0,.45),rgba(0,0,0,.45)),url("${cover.replace(/["\\\n]/g, "")}")`
        : "";
    }

    // Runs inside a tap: the one moment iOS lets a page start audible playback.
    function userTap() {
      tapped = true;
      ensureEngine();
      if (engine) engine.userPlay();
      renderVeil();
    }

    /* ---------------- engine wiring ---------------- */

    function ensureEngine() {
      if (engine || engineError) return engine;
      try {
        engine = engineTools.createEngine({
          video,
          getSettings: () => store.get(),
          nativeFetch: options.fetch,
          onTransfer,
          onLog: log,
          onState(next) {
            lastState = next;
            if (next.playerState === "ready") { tapped = true; failure = ""; }
            renderVeil();
          },
          onSegment(event) {
            totals.segments += 1;
            totals.pieces += Number(event.pieces) || 0;
          },
          onQualities: renderQualities,
          droppedFamilies: store.get().droppedCodecs,
          onFamilyDropped(family) {
            store.update({ droppedCodecs: [...store.get().droppedCodecs, family] });
          },
          onFatal(error) {
            failure = `${String(error?.message || error).slice(0, 160)}\n可以重试；一直失败就换一种 CDN 模式，或者把线程数调低。`;
            renderVeil();
          },
          onEnded: handleEnded
        });
      } catch (error) {
        engineError = String(error?.message || error);
        unsupportedCard.hidden = false;
        unsupportedCard.querySelector("p").textContent = `${engineError}。iPhone 需要 iOS 17.1 或更新的系统（Safari 的 ManagedMediaSource），iPad 需要 iPadOS 13 或更新。`;
        log("这台设备不支持", engineError, "error");
      }
      return engine;
    }

    // Comments are a nicety: whatever goes wrong here must never get in the way of the video.
    async function loadDanmaku(cid) {
      if (!danmaku) return;
      danmakuController?.abort();
      const controller = new AbortController();
      danmakuController = controller;
      danmaku.setItems([]);
      danmakuNote.textContent = "";
      const sources = [{ name: "comment.bilibili.com", url: (id) => `https://comment.bilibili.com/${id}.xml` }];
      if (options.helperBase) sources.push({ name: "Loon 助手", url: (id) => `${options.helperBase}dm?cid=${id}` });
      try {
        const result = await danmakuTools.load(cid, sources, controller.signal);
        if (controller.signal.aborted) return;
        danmaku.setItems(result.items);
        danmakuNote.textContent = result.items.length ? `${result.items.length} 条` : "没有拿到弹幕";
        if (result.items.length) log("弹幕已就绪", `${result.items.length} 条，来自 ${result.via}。`, "success", "other");
        else log("没有拿到弹幕", result.errors.join("；") || "这个视频没有弹幕。", "info", "other");
      } catch (error) {
        if (error?.name !== "AbortError") danmakuNote.textContent = "没有拿到弹幕";
      }
    }

    function renderQualities(list) {
      const wanted = store.get().qualityId;
      qualitySelect.replaceChildren(
        h("option", { value: "0", text: `自动（不超过 ${store.get().maxAutoHeight >= 4320 ? "最高" : store.get().maxAutoHeight >= 2160 ? "4K" : `${store.get().maxAutoHeight}P`}）` }),
        ...list.map((item) => h("option", { value: String(item.id), text: `${item.label}${item.codecLabel ? ` · ${item.codecLabel}` : ""}${item.bandwidth ? ` · ${(item.bandwidth / 1e6).toFixed(1)} Mbps` : ""}` })));
      qualitySelect.value = list.some((item) => item.id === wanted) ? String(wanted) : "0";
    }

    function chooseQuality(id) {
      store.update({ qualityId: Math.max(0, id || 0) });
      failure = "";
      engine?.setQuality(id).catch((error) => log("切换清晰度失败", error?.message || error, "error"));
    }

    function handleEnded() {
      saveProgress(true);
      if (!current || !store.get().autoNextPart) return;
      const next = current.partIndex + 1;
      if (next < current.info.pages.length) switchPart(next, false);
    }

    /* ---------------- history / progress ---------------- */

    function saveProgress(force = false) {
      if (!current?.info || !store.get().rememberProgress) return;
      const now = Date.now();
      if (!force && now - lastSavedAt < 5000) return;
      lastSavedAt = now;
      const pageInfo = current.info.pages[current.partIndex];
      store.remember({
        key: apiTools.videoKey(current.info),
        title: current.info.title,
        owner: current.info.owner,
        cover: current.info.cover,
        part: current.partIndex + 1,
        parts: current.info.pages.length,
        time: video.ended ? 0 : Number(video.currentTime) || 0,
        duration: pageInfo?.duration || current.info.duration
      });
    }

    function renderHistory() {
      const list = store.history();
      historyEmpty.hidden = list.length > 0;
      historyList.replaceChildren(...list.slice(0, 30).map((item) => {
        const progress = item.duration > 0 && item.time > 0 ? `看到 ${formatClock(item.time)} / ${formatClock(item.duration)}` : item.duration ? formatClock(item.duration) : "";
        const open = h("button", { class: "item", type: "button", onclick: () => openFromGesture({ bvid: /^BV/.test(item.key) ? item.key : "", aid: /^av/.test(item.key) ? Number(item.key.slice(2)) : 0, part: item.part, time: 0 }) },
          item.cover ? h("img", { src: `${item.cover}@192w_120h_1c.webp`, alt: "", loading: "lazy", referrerPolicy: "no-referrer" }) : null,
          h("div", { style: "min-width:0" },
            h("div", { class: "t", text: item.title || item.key }),
            h("div", { class: "s", text: [item.owner, item.parts > 1 ? `P${item.part}/${item.parts}` : "", progress].filter(Boolean).join(" · ") })));
        const remove = h("button", { class: "del", type: "button", "aria-label": "从列表移除", text: "✕", onclick: () => { store.forget(item.key); renderHistory(); } });
        return h("li", {}, open, remove);
      }));
    }

    /* ---------------- opening videos ---------------- */

    function setView(next) {
      view = next;
      stage.hidden = next !== "player";
      playerSection.hidden = next !== "player";
      homeSection.hidden = next === "player";
      closeButton.textContent = next === "player" ? "返回" : mode === "overlay" ? "关闭" : "刷新";
      if (next === "home") {
        loginHint.hidden = apiTools.isLoggedIn();
        renderHistory();
      }
      renderStats();
      try { app.scrollTop = 0; root.scrollTo?.(0, 0); } catch (_error) {}
    }

    function showOpenHint(text, bad = false) {
      openHint.hidden = !text;
      openHint.textContent = text || "";
      openHint.classList.toggle("bad", Boolean(bad));
    }

    function submitInput() {
      const parsed = apiTools.parseVideoInput(input.value);
      if (!parsed) {
        showOpenHint("没认出视频：请粘贴 B 站视频链接、b23.tv 短链，或者 BV 号。", true);
        return;
      }
      showOpenHint("");
      input.blur();
      openFromGesture(parsed);
    }

    async function pasteAndOpen() {
      // The tap that pressed this button is also the one that may unlock playback.
      userTap();
      try {
        const text = await root.navigator.clipboard.readText();
        input.value = String(text || "").trim();
      } catch (_error) {
        showOpenHint("读不到剪贴板：请长按输入框手动粘贴。", true);
        input.focus();
        return;
      }
      const parsed = apiTools.parseVideoInput(input.value);
      if (!parsed) {
        showOpenHint("剪贴板里没有认出 B 站视频链接。", true);
        return;
      }
      showOpenHint("");
      navigateTo(parsed);
    }

    function openFromGesture(identity) {
      userTap();
      navigateTo(identity);
    }

    // In page mode the address bar is the source of truth (so reloads and the back button work).
    function navigateTo(identity) {
      if (mode === "page" && !identity.shortLink) {
        const key = apiTools.videoKey(identity);
        const query = new URLSearchParams();
        if (identity.part > 1) query.set("p", String(identity.part));
        if (identity.time > 0) query.set("t", String(Math.floor(identity.time)));
        const target = `#/v/${key}${query.toString() ? `?${query}` : ""}`;
        if (root.location.hash === target) openVideo(identity);
        else root.location.hash = target;
        return;
      }
      openVideo(identity);
    }

    async function resolveShort(identity, signal) {
      if (!identity.shortLink || identity.bvid || identity.aid) return identity;
      if (typeof options.resolveShortLink !== "function") {
        // No helper in this build: let the browser follow the short link. It lands on a bilibili
        // video page, where the floating button (or auto takeover) brings the player back.
        root.location.href = identity.shortLink;
        throw new DOMException("正在跳转", "AbortError");
      }
      infoMessage = "正在解析短链…";
      renderVeil();
      const longUrl = await options.resolveShortLink(identity.shortLink, signal);
      const parsed = apiTools.parseVideoInput(longUrl);
      if (!parsed || (!parsed.bvid && !parsed.aid)) throw new Error("这个短链不是视频链接（可能是直播、番剧或专栏）");
      return parsed;
    }

    async function openVideo(identityInput, partOverride = null) {
      if (!ensureEngine()) { setView("home"); return; }
      const sequence = ++loadSequence;
      loadController?.abort();
      const controller = new AbortController();
      loadController = controller;
      saveProgress(true);
      engine.stop();
      transfers.clear();
      failure = "";
      infoMessage = "正在读取视频信息…";
      lastState = { playerState: "loading" };
      current = { identity: identityInput, info: current && apiTools.videoKey(current.info || {}) === apiTools.videoKey(identityInput) ? current.info : null, partIndex: 0 };
      titleNode.textContent = current.info?.title || "";
      metaNode.replaceChildren();
      setView("player");
      renderVeil();
      try {
        const identity = await resolveShort(identityInput, controller.signal);
        if (sequence !== loadSequence) return;
        current.identity = identity;
        if (mode === "page" && identityInput.shortLink) {
          // Put the resolved id into the address bar without triggering another load.
          const key = apiTools.videoKey(identity);
          try { root.history.replaceState(null, "", `#/v/${key}${identity.part > 1 ? `?p=${identity.part}` : ""}`); } catch (_error) {}
        }
        const info = current.info || await api.view(identity, controller.signal);
        if (sequence !== loadSequence) return;
        const wantedPart = partOverride !== null ? partOverride : Math.max(0, (identity.part || 1) - 1);
        const partIndex = Math.min(info.pages.length - 1, wantedPart);
        current = { identity, info, partIndex };
        renderInfo();
        infoMessage = "正在读取播放清单…";
        renderVeil();
        const pageInfo = info.pages[partIndex];
        const playinfo = await api.playurl(info, pageInfo.cid, controller.signal);
        if (sequence !== loadSequence) return;
        loadDanmaku(pageInfo.cid);
        const remembered = store.get().rememberProgress ? store.recall(apiTools.videoKey(info), partIndex + 1) : 0;
        const startTime = identity.time > 0 && partOverride === null ? identity.time : remembered;
        infoMessage = "";
        totals.bytes = 0; totals.segments = 0; totals.pieces = 0;
        log("开始播放", `${info.title}${info.pages.length > 1 ? ` · P${partIndex + 1}` : ""}${startTime ? ` · 从 ${formatClock(startTime)} 继续` : ""}`, "info", "takeover");
        updateMediaSession();
        await engine.load({ playinfo, startTime, qualityId: store.get().qualityId, autoplay: true });
        saveProgress(true);
      } catch (error) {
        if (error?.name === "AbortError" || sequence !== loadSequence) return;
        infoMessage = "";
        failure = String(error?.message || error).slice(0, 200);
        log("没能打开这个视频", failure, "error", "takeover");
        renderVeil();
      }
    }

    function renderInfo() {
      const info = current.info;
      titleNode.textContent = info.title;
      const key = apiTools.videoKey(info);
      // "btr=0" tells the Loon plugin's optional redirect to leave this one link alone.
      const linkQuery = [mode === "page" ? "btr=0" : "", current.partIndex > 0 ? `p=${current.partIndex + 1}` : ""].filter(Boolean).join("&");
      const link = `https://www.bilibili.com/video/${key}${linkQuery ? `?${linkQuery}` : ""}`;
      metaNode.replaceChildren(
        info.owner ? h("span", { text: `UP：${info.owner}` }) : null,
        h("span", { text: key }),
        h("a", { href: link, target: "_blank", rel: "noopener", text: "在 B 站打开" }));
      partRow.hidden = info.pages.length <= 1;
      partSelect.replaceChildren(...info.pages.map((pageInfo, index) => h("option", { value: String(index), text: `P${pageInfo.page} ${pageInfo.part}`.trim() })));
      partSelect.value = String(current.partIndex);
      video.poster = "";
    }

    function switchPart(index, fromGesture) {
      if (!current?.info || index === current.partIndex || index < 0 || index >= current.info.pages.length) return;
      if (fromGesture) userTap();
      const identity = { bvid: current.info.bvid, aid: current.info.aid, part: index + 1, time: 0 };
      if (mode === "page") {
        try { root.history.replaceState(null, "", `#/v/${apiTools.videoKey(identity)}?p=${index + 1}`); } catch (_error) {}
      }
      openVideo(identity, index);
    }

    function retry(fromGesture) {
      if (!current) return;
      if (fromGesture) userTap();
      const time = Number(video.currentTime) || 0;
      openVideo({ ...current.identity, part: current.partIndex + 1, time: time > 5 ? time : current.identity.time || 0 });
    }

    function updateMediaSession() {
      try {
        if (!("mediaSession" in root.navigator) || !current?.info || typeof root.MediaMetadata !== "function") return;
        root.navigator.mediaSession.metadata = new root.MediaMetadata({
          title: current.info.title,
          artist: current.info.owner,
          artwork: current.info.cover ? [{ src: `${current.info.cover}@512w_512h_1c.png`, sizes: "512x512", type: "image/png" }] : []
        });
      } catch (_error) {}
    }

    function goHome() {
      if (mode === "page") {
        if (view === "home") { root.location.reload(); return; }
        if (root.location.hash && root.location.hash !== "#/") { root.location.hash = "#/"; return; }
      }
      showHome();
    }

    function showHome() {
      loadSequence += 1;
      loadController?.abort();
      danmakuController?.abort();
      danmaku?.setItems([]);
      saveProgress(true);
      engine?.stop();
      transfers.clear();
      current = null;
      failure = "";
      infoMessage = "";
      lastState = { playerState: "idle" };
      setView("home");
    }

    /* ---------------- routing (page mode) ---------------- */

    function routeFromHash() {
      const hash = String(root.location.hash || "");
      const match = /^#\/v\/([^?]+)(?:\?(.*))?$/.exec(hash);
      if (!match) {
        // "#https://b23.tv/…" or "#BV…": links handed over by the share-sheet shortcut.
        let text = hash.slice(1);
        try { text = decodeURIComponent(text); } catch (_error) {}
        const loose = apiTools.parseVideoInput(text);
        if (loose) { openVideo(loose); return; }
        if (view !== "home" || current) showHome();
        return;
      }
      let idText = match[1];
      try { idText = decodeURIComponent(idText); } catch (_error) {}
      const parsed = apiTools.parseVideoInput(idText);
      if (!parsed) { showHome(); return; }
      const params = new URLSearchParams(match[2] || "");
      parsed.part = Math.max(1, Math.trunc(Number(params.get("p"))) || 1);
      parsed.time = apiTools.parseTime(params.get("t"));
      const sameVideo = current?.info && apiTools.videoKey(current.info) === apiTools.videoKey(parsed) && current.partIndex === parsed.part - 1;
      if (sameVideo && view === "player" && !failure) return;
      openVideo(parsed);
    }

    /* ---------------- settings → engine ---------------- */

    function syncSettingsUi() {
      const settings = store.get();
      modeSeg.sync(settings.mode);
      threadSeg.sync(settings.concurrency);
      codecSeg.sync(settings.codec);
      capSeg.sync(settings.maxAutoHeight);
      danmakuSeg.sync(settings.danmaku ? "on" : "off");
      areaSeg.sync(settings.danmakuArea);
      danmaku?.setArea(settings.danmakuArea);
      danmaku?.setEnabled(settings.danmaku);
      nextSwitch.checked = settings.autoNextPart;
      progressSwitch.checked = settings.rememberProgress;
      autoOpenSwitch.checked = settings.autoOpen;
    }

    store.subscribe((settings, _previous, changed) => {
      syncSettingsUi();
      if (changed.includes("mode") || changed.includes("concurrency")) {
        log("设置已经生效", `${settings.mode === "overseas" ? "海外" : "大陆"} CDN · ${settings.concurrency} 线程`, "success", "settings");
        engine?.applySettings();
      }
      if (changed.includes("codec") || changed.includes("maxAutoHeight")) {
        engine?.reselect().catch((error) => log("重新选择编码失败", error?.message || error, "error"));
      }
    });

    /* ---------------- video element bookkeeping ---------------- */

    video.addEventListener("timeupdate", () => saveProgress(false));
    video.addEventListener("pause", () => { saveProgress(true); renderVeil(); });
    video.addEventListener("playing", () => { tapped = true; renderVeil(); });
    root.addEventListener("pagehide", () => saveProgress(true));
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveProgress(true); });

    /* ---------------- life cycle ---------------- */

    let pageVideoTimer = null;

    function quietPageVideos() {
      for (const other of document.querySelectorAll("video")) {
        if (other === video) continue;
        try { if (!other.paused) other.pause(); other.muted = true; } catch (_error) {}
      }
    }

    function mount(parent) {
      host.hidden = mode === "overlay";
      (parent || document.body || document.documentElement).append(host);
      syncSettingsUi();
      ensureEngine();
      setView("home");
      statsTimer = setInterval(renderStats, 500);
      if (mode === "page") {
        root.addEventListener("hashchange", routeFromHash);
        routeFromHash();
      }
      log("BTR-iOS 已就绪", `${version} · ${mode === "page" ? "独立页面" : "视频页浮层"} · ${root.location?.origin || ""}`, "info");
    }

    let previousOverflow = "";
    function open(identity, fromGesture) {
      if (mode !== "overlay") return;
      host.hidden = false;
      previousOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = "hidden";
      quietPageVideos();
      clearInterval(pageVideoTimer);
      pageVideoTimer = setInterval(quietPageVideos, 1000);
      if (fromGesture) userTap();
      if (identity) openVideo(identity);
    }

    function close() {
      if (mode !== "overlay") return;
      showHome();
      clearInterval(pageVideoTimer);
      pageVideoTimer = null;
      document.documentElement.style.overflow = previousOverflow;
      host.hidden = true;
      try { options.onClose?.(); } catch (_error) {}
    }

    function destroy() {
      clearInterval(statsTimer);
      clearInterval(pageVideoTimer);
      root.removeEventListener("hashchange", routeFromHash);
      loadController?.abort();
      danmakuController?.abort();
      danmaku?.destroy();
      engine?.destroy();
      host.remove();
    }

    return Object.freeze({
      mount, open, close, destroy, openVideo,
      isOpen: () => !host.hidden,
      settings: () => store.get(),
      debug: debugSnapshot,
      logsAsText,
      host
    });
  }

  root.__BTRI_UI__ = Object.freeze({ createApp, formatSpeed, formatBytes, formatClock });
})(globalThis);

/* ---- src/app/boot.js ---- */
/*
 * BTR-iOS: start-up. The build puts three constants in scope:
 *   __BTRI_VERSION__  version string
 *   __BTRI_CSS__      the style sheet
 *   __BTRI_CONTEXT__  { mode: "page", helperBase } for the page the Loon plugin serves,
 *                     { mode: "overlay" } for the userscript build.
 */
(function bootBtrIos(root) {
  "use strict";

  const ui = root.__BTRI_UI__;
  const apiTools = root.__BTRI_API__;
  if (!ui || !apiTools || !root.document) return;
  if (root.__BTRI_BOOTED__) return;
  try { if (root.top !== root.self) return; } catch (_error) { return; }
  Object.defineProperty(root, "__BTRI_BOOTED__", { value: true });

  const context = typeof __BTRI_CONTEXT__ === "object" && __BTRI_CONTEXT__ ? __BTRI_CONTEXT__ : { mode: "overlay" };
  const version = typeof __BTRI_VERSION__ === "string" ? __BTRI_VERSION__ : "dev";
  const css = typeof __BTRI_CSS__ === "string" ? __BTRI_CSS__ : "";

  function whenBodyReady(callback) {
    if (document.body) callback();
    else document.addEventListener("DOMContentLoaded", callback, { once: true });
  }

  /* ---------------- the page served by the Loon plugin ---------------- */

  function bootPage() {
    const helperBase = String(context.helperBase || "");
    const app = ui.createApp({
      mode: "page",
      version,
      css,
      helperBase,
      resolveShortLink: helperBase ? async (shortLink, signal) => {
        const response = await root.fetch(`${helperBase}resolve?u=${encodeURIComponent(shortLink)}`, { cache: "no-store", signal });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.url) throw new Error(payload?.error || "短链解析失败");
        return String(payload.url);
      } : null
    });
    whenBodyReady(() => app.mount(document.body));
    root.__BTRI_APP__ = app;
  }

  /* ---------------- on top of a bilibili video page (userscript) ---------------- */

  function identityFromLocation() {
    if (!/\/video\/(?:BV[0-9A-Za-z]{10}|av\d+)/i.test(root.location.pathname)) return null;
    const identity = apiTools.parseVideoInput(root.location.href);
    if (!identity) return null;
    // Carry on from where the page's own player is, if it got anywhere.
    const native = Array.from(document.querySelectorAll("video")).find((node) => Number(node.currentTime) > 3);
    if (native && !identity.time) identity.time = Math.floor(Number(native.currentTime) || 0);
    return identity;
  }

  function bootOverlay() {
    if (!/(?:^|\.)bilibili\.com$/i.test(root.location.hostname)) return;
    const app = ui.createApp({ mode: "overlay", version, css, onClose: () => syncFab() });
    const fabHost = document.createElement("div");
    fabHost.id = "__btri_fab__";
    const fabShadow = fabHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = css;
    const fab = document.createElement("button");
    fab.type = "button";
    fab.className = "fab";
    fab.textContent = "⚡ BTR 加速播放";
    fab.addEventListener("click", () => {
      const identity = identityFromLocation();
      if (!identity) return;
      app.open(identity, true);
      syncFab();
    });
    fabShadow.append(style, fab);

    let lastHref = "";
    let autoOpenedFor = "";
    function syncFab() {
      const identity = identityFromLocation();
      fabHost.hidden = !identity || app.isOpen();
      fabHost.style.display = fabHost.hidden ? "none" : "";
      return identity;
    }
    function watchLocation() {
      if (root.location.href === lastHref) return;
      lastHref = root.location.href;
      const identity = syncFab();
      const key = identity ? `${apiTools.videoKey(identity)}:${identity.part}` : "";
      if (identity && app.settings().autoOpen && !app.isOpen() && autoOpenedFor !== key) {
        autoOpenedFor = key;
        app.open(identity, false);
        syncFab();
      }
    }

    whenBodyReady(() => {
      app.mount(document.documentElement);
      document.documentElement.append(fabHost);
      watchLocation();
      setInterval(watchLocation, 800);
    });
    root.__BTRI_APP__ = app;
  }

  if (context.mode === "page") bootPage();
  else bootOverlay();
})(globalThis);
})();
