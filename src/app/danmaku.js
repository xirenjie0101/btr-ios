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
