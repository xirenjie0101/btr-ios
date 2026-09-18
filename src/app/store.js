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
