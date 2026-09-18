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
