/*
 * BTR-iOS for Loon  —  __BTRI_VERSION__
 *
 * Multi-threaded, multi-CDN buffering for Bilibili in iOS / iPadOS Safari: a port of the open
 * source "Bilibili 线程撕裂者" (Bilibili-thread-ripper, MIT) browser extension.
 *
 * This one file is used by three [Script] lines of BTR-iOS.plugin:
 *   1. http-request  https://(www|m).bilibili.com/__btr__/…   serves the player page and its
 *      helper endpoints. Nothing under that path exists on Bilibili's servers; the request never
 *      leaves the phone. (www is the origin the upstream extension is proven on; m is served too
 *      so that the button on a mobile video page can stay on its own host.)
 *   2. http-request  https://(m|www).bilibili.com/video/… optional redirect of video pages to
 *      the player page.
 *   3. http-response https://(m|www).bilibili.com/video/… optional "⚡ BTR" button on video pages.
 *
 * The video bytes themselves are NOT decrypted or touched by Loon: the player page fetches them
 * straight from Bilibili's CDNs with many parallel Range requests. Only www.bilibili.com and
 * m.bilibili.com need MITM, and only so that the page and the button can be added.
 *
 * Generated file — edit src/ and run `node build.js` instead.
 */
var BTRI_VERSION = "__BTRI_VERSION__";
var BTRI_BASE_PATH = "/__btr__/";
var BTRI_PAGE_HTML = __BTRI_PAGE_HTML_JSON__;
var BTRI_BUTTON_JS = __BTRI_BUTTON_JS_JSON__;
var BTRI_ICON_BASE64 = "__BTRI_ICON_BASE64__";

(function btrIosLoonMain() {
  "use strict";

  var request = typeof $request !== "undefined" && $request ? $request : {};
  var response = typeof $response !== "undefined" && $response ? $response : null;
  var url = String(request.url || "");

  function header(headers, name) {
    if (!headers) return "";
    var wanted = name.toLowerCase();
    for (var key in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === wanted) return String(headers[key]);
    }
    return "";
  }

  function reply(status, headers, body) {
    var merged = { "Cache-Control": "no-store", "X-BTR-iOS": BTRI_VERSION };
    for (var key in headers) merged[key] = headers[key];
    $done({ response: { status: status, headers: merged, body: body } });
  }

  function replyJson(status, payload) {
    reply(status, { "Content-Type": "application/json; charset=utf-8" }, JSON.stringify(payload));
  }

  function decodeBase64(text) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var clean = text.replace(/[^A-Za-z0-9+/]/g, "");
    var length = Math.floor(clean.length * 3 / 4);
    var bytes = new Uint8Array(length);
    var offset = 0;
    for (var index = 0; index < clean.length; index += 4) {
      var a = alphabet.indexOf(clean.charAt(index));
      var b = alphabet.indexOf(clean.charAt(index + 1));
      var c = alphabet.indexOf(clean.charAt(index + 2));
      var d = alphabet.indexOf(clean.charAt(index + 3));
      var chunk = (a << 18) | (b << 12) | ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d);
      if (offset < length) bytes[offset++] = (chunk >> 16) & 255;
      if (c >= 0 && offset < length) bytes[offset++] = (chunk >> 8) & 255;
      if (d >= 0 && offset < length) bytes[offset++] = chunk & 255;
    }
    return bytes.subarray(0, offset);
  }

  function queryValue(name) {
    var mark = url.indexOf("?");
    if (mark < 0) return "";
    var pairs = url.slice(mark + 1).split("#")[0].split("&");
    for (var index = 0; index < pairs.length; index += 1) {
      var pair = pairs[index].split("=");
      if (decodeURIComponent(pair[0] || "") === name) {
        try { return decodeURIComponent((pair.slice(1).join("=") || "").replace(/\+/g, "%20")); }
        catch (_error) { return ""; }
      }
    }
    return "";
  }

  /* ---- b23.tv short links: follow redirects by hand until a bilibili.com address shows up ---- */

  function resolveShortLink(shortLink, hopsLeft, callback) {
    if (!/^https?:\/\/(?:b23\.tv|bili2233\.cn)\/[0-9A-Za-z]+/i.test(shortLink)) {
      callback("只支持 b23.tv 短链", "");
      return;
    }
    $httpClient.get({
      url: shortLink.replace(/^http:/i, "https:"),
      timeout: 8000,
      "auto-redirect": false,
      headers: { "User-Agent": header(request.headers, "User-Agent") || "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" }
    }, function (error, shortResponse) {
      if (error || !shortResponse) {
        callback("短链解析失败：" + String(error || "没有响应"), "");
        return;
      }
      var location = header(shortResponse.headers, "Location");
      if (!location) {
        callback("短链没有给出跳转地址（HTTP " + shortResponse.status + "）", "");
        return;
      }
      if (/^https?:\/\/(?:b23\.tv|bili2233\.cn)\//i.test(location) && hopsLeft > 0) {
        resolveShortLink(location, hopsLeft - 1, callback);
        return;
      }
      if (!/^https?:\/\/(?:[0-9a-z-]+\.)*bilibili\.com\//i.test(location)) {
        callback("短链指向的不是哔哩哔哩", "");
        return;
      }
      callback("", location);
    });
  }

  /* ---- request phase ---- */

  function servePlayer() {
    var path = url.replace(/^https?:\/\/[^/]+/i, "").split("#")[0];
    var route = path.split("?")[0].slice(BTRI_BASE_PATH.length);
    if (route === "" || route === "index.html") {
      reply(200, { "Content-Type": "text/html; charset=utf-8" }, BTRI_PAGE_HTML);
      return;
    }
    if (route === "ping") {
      replyJson(200, { ok: true, version: BTRI_VERSION });
      return;
    }
    if (route === "icon.png") {
      reply(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" }, decodeBase64(BTRI_ICON_BASE64));
      return;
    }
    if (route === "resolve") {
      resolveShortLink(queryValue("u"), 3, function (error, longUrl) {
        if (error) replyJson(502, { error: error });
        else replyJson(200, { url: longUrl });
      });
      return;
    }
    if (route === "dm") {
      // The comment file has no CORS headers; fetched here, on the phone, on the page's behalf.
      var cid = queryValue("cid");
      if (!/^[1-9][0-9]{0,17}$/.test(cid)) {
        replyJson(400, { error: "无效的 cid" });
        return;
      }
      $httpClient.get({
        url: "https://comment.bilibili.com/" + cid + ".xml",
        timeout: 8000,
        headers: { "User-Agent": header(request.headers, "User-Agent") || "Mozilla/5.0", Referer: "https://www.bilibili.com/" }
      }, function (error, xmlResponse, data) {
        if (error || !xmlResponse || Number(xmlResponse.status) !== 200 || typeof data !== "string" || data.indexOf("<i") < 0) {
          replyJson(502, { error: "弹幕没取到：" + String(error || (xmlResponse && xmlResponse.status) || "格式不对") });
          return;
        }
        reply(200, { "Content-Type": "text/xml; charset=utf-8" }, data);
      });
      return;
    }
    replyJson(404, { error: "BTR-iOS 没有这个地址", route: route });
  }

  function redirectVideoPage() {
    var match = /^https?:\/\/(?:m|www)\.bilibili\.com\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i.exec(url);
    var method = String(request.method || "GET").toUpperCase();
    var destination = header(request.headers, "Sec-Fetch-Dest");
    var accept = header(request.headers, "Accept");
    var isNavigation = destination ? destination === "document" : /text\/html/i.test(accept);
    // "?btr=0" is how the player's own "在 B 站打开" link asks to be left alone.
    if (!match || method !== "GET" || !isNavigation || queryValue("btr") === "0") {
      $done({});
      return;
    }
    var query = [];
    var part = parseInt(queryValue("p"), 10);
    if (part > 1) query.push("p=" + part);
    var time = queryValue("t");
    if (/^[0-9hms.]+$/i.test(time)) query.push("t=" + time);
    var target = "https://www.bilibili.com" + BTRI_BASE_PATH + "#/v/" + match[1] + (query.length ? "?" + query.join("&") : "");
    $done({ response: { status: 302, headers: { Location: target, "Cache-Control": "no-store" }, body: "" } });
  }

  /* ---- response phase ---- */

  function addButton() {
    var type = header(response.headers, "Content-Type");
    var body = response.body;
    if (Number(response.status) !== 200 || !/text\/html/i.test(type) || typeof body !== "string" || body.indexOf("__BTRI_LOON_BUTTON__") >= 0) {
      $done({});
      return;
    }
    var tag = "<script>" + BTRI_BUTTON_JS.replace(/<\/script/gi, "<\\/script") + "</script>";
    var at = body.lastIndexOf("</body>");
    if (at < 0) at = body.lastIndexOf("</html>");
    body = at >= 0 ? body.slice(0, at) + tag + body.slice(at) : body + tag;
    var headers = {};
    for (var key in response.headers) {
      // A strict Content-Security-Policy would block the inline button script.
      if (!/^content-security-policy(?:-report-only)?$/i.test(key)) headers[key] = response.headers[key];
    }
    $done({ body: body, headers: headers });
  }

  try {
    if (response) addButton();
    else if (/^https?:\/\/(?:www|m)\.bilibili\.com\/__btr__\//i.test(url)) servePlayer();
    else redirectVideoPage();
  } catch (error) {
    try { console.log("BTR-iOS: " + String(error && error.stack || error)); } catch (_error) {}
    $done({});
  }
})();
