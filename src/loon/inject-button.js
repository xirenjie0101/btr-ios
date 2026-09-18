/*
 * BTR-iOS: the small button the Loon plugin adds to bilibili video pages. It only links to the
 * player page that the same plugin serves; the player itself is not loaded here.
 */
(function btrIosLoonButton() {
  "use strict";
  if (window.__BTRI_LOON_BUTTON__) return;
  try { if (window.top !== window.self) return; } catch (_error) { return; }
  window.__BTRI_LOON_BUTTON__ = true;

  // Same host as the page: iOS never hands a same-domain navigation to an installed app.
  var BASE = location.origin + "/__btr__/";

  function identity() {
    var match = /\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i.exec(location.pathname);
    if (!match) return null;
    var part = Math.max(1, parseInt(new URLSearchParams(location.search).get("p"), 10) || 1);
    return { id: match[1], part: part };
  }

  function target() {
    var current = identity();
    if (!current) return "";
    var seconds = 0;
    try {
      Array.prototype.forEach.call(document.querySelectorAll("video"), function (node) {
        if (Number(node.currentTime) > 3) seconds = Math.floor(Number(node.currentTime));
      });
    } catch (_error) {}
    var query = [];
    if (current.part > 1) query.push("p=" + current.part);
    if (seconds > 0) query.push("t=" + seconds);
    return BASE + "#/v/" + current.id + (query.length ? "?" + query.join("&") : "");
  }

  function install() {
    if (document.getElementById("__btri_loon_fab__")) return;
    var host = document.createElement("div");
    host.id = "__btri_loon_fab__";
    var shadow = host.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent = ":host{all:initial}button{position:fixed;right:calc(12px + env(safe-area-inset-right,0px));bottom:calc(84px + env(safe-area-inset-bottom,0px));z-index:2147483645;border:0;border-radius:999px;padding:11px 16px;font:600 14px/1 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;color:#06202d;background:#4cc2ff;box-shadow:0 6px 20px rgba(0,0,0,.35);cursor:pointer;-webkit-tap-highlight-color:transparent}";
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = "⚡ BTR 加速播放";
    button.addEventListener("click", function () {
      var url = target();
      if (!url) return;
      try {
        Array.prototype.forEach.call(document.querySelectorAll("video"), function (node) { node.pause(); });
      } catch (_error) {}
      // A script navigation (not a tapped <a>) keeps iOS from handing the link to the app.
      location.href = url;
    });
    shadow.appendChild(style);
    shadow.appendChild(button);
    (document.body || document.documentElement).appendChild(host);
    function sync() { host.style.display = identity() ? "" : "none"; }
    sync();
    setInterval(sync, 800);
  }

  if (document.body) install();
  else document.addEventListener("DOMContentLoaded", install, { once: true });
})();
