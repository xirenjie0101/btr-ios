"use strict";
/*
 * Runs a Loon script the way Loon does: a fresh JavaScript context per matched request with
 * $request / $response / $done / $httpClient / $persistentStore / $notification in scope.
 * (Loon uses JavaScriptCore; there is no window, document, fetch, atob, URL or URLSearchParams.
 * The sandbox deliberately leaves those out so that code relying on them fails here first.)
 *
 * $httpClient resolves every host to the mock server on `httpClientPort`.
 */
const vm = require("vm");
const https = require("https");

function httpClient(port) {
  function send(method, input, callback) {
    const options = typeof input === "string" ? { url: input } : { ...(input || {}) };
    let target;
    try { target = new URL(options.url); }
    catch (_error) { callback("Invalid URL", null, null); return; }
    const request = https.request({
      host: "127.0.0.1",
      port,
      servername: target.hostname,
      method,
      path: `${target.pathname}${target.search}`,
      headers: { Host: target.host, ...(options.headers || {}) },
      rejectUnauthorized: false,
      timeout: Number(options.timeout) || 5000
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const status = response.statusCode;
        const location = response.headers.location;
        if (options["auto-redirect"] !== false && status >= 300 && status < 400 && location) {
          send(method, { ...options, url: new URL(location, target).href }, callback);
          return;
        }
        const headers = {};
        for (let index = 0; index < response.rawHeaders.length; index += 2) headers[response.rawHeaders[index]] = response.rawHeaders[index + 1];
        const body = Buffer.concat(chunks);
        callback(null, { status, headers }, options["binary-mode"] ? new Uint8Array(body) : body.toString("utf8"));
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", (error) => callback(String(error?.message || error), null, null));
    if (options.body) request.write(options.body);
    request.end();
  }
  const client = {};
  for (const method of ["get", "post", "head", "put", "delete", "options", "patch"]) {
    client[method] = (input, callback) => send(method.toUpperCase(), input, callback);
  }
  return client;
}

function runLoonScript({ code, request, response = undefined, argument = undefined, httpClientPort = 0, timeoutMs = 10000, store = new Map() }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const logs = [];
    const timer = setTimeout(() => finish(null, new Error("Loon script timed out (no $done)")), timeoutMs);
    const scriptTimers = new Set();
    function finish(value, error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Loon tears the context down after $done; pending script timers die with it.
      for (const pending of scriptTimers) clearTimeout(pending);
      if (error) { error.logs = logs; reject(error); } else {
        if (value && typeof value === "object") Object.defineProperty(value, "__logs", { value: logs, enumerable: false });
        resolve(value);
      }
    }
    const sandbox = {
      $request: request,
      $response: response,
      $argument: argument,
      $loon: "iPhone15,2 18.0 3.2.4(800)",
      $script: { name: "BTR-iOS test", startTime: new Date() },
      $done: (value) => finish(value === undefined ? undefined : value),
      $httpClient: httpClientPort ? httpClient(httpClientPort) : {},
      $persistentStore: {
        read: (key) => store.get(String(key)) ?? null,
        write: (value, key) => { store.set(String(key), String(value)); return true; }
      },
      $notification: { post: (...parts) => logs.push(`notify: ${parts.join(" | ")}`) },
      console: { log: (...parts) => logs.push(parts.join(" ")) },
      setTimeout: (callback, ms) => { const handle = setTimeout(() => { scriptTimers.delete(handle); callback(); }, ms); scriptTimers.add(handle); return handle; },
      clearTimeout: (handle) => { scriptTimers.delete(handle); clearTimeout(handle); }
    };
    try {
      vm.runInNewContext(code, sandbox, { filename: "btr-loon.js", timeout: 5000 });
    } catch (error) {
      finish(null, error);
    }
  });
}

module.exports = { runLoonScript };
