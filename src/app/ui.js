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
