"use strict";
/*
 * What sits between the Bilibili app and the CDN when Loon decrypts the connection: every request
 * is shown to the http-request script first. The script either answers it itself
 * ($done({response})) or lets it through ($done({})), in which case the request goes on to the
 * real host — here: the mock CDN.
 *
 * Test clients talk plain HTTP to this proxy and name the original URL in X-Original-URL (in real
 * life Loon knows it from the TLS connection it terminated).
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const { runLoonScript } = require("./loon-vm.js");

function createFakeLoon({ port, cdnPort, scriptPath, argument }) {
  const store = new Map();
  const log = { scriptAnswers: 0, passedThrough: 0, notifications: [] };
  const sockets = new Set();
  const settings = { argument };

  const server = http.createServer(async (request, response) => {
    const original = String(request.headers["x-original-url"] || "");
    const headers = {};
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (!/^x-original-url$/i.test(request.rawHeaders[index])) headers[request.rawHeaders[index]] = request.rawHeaders[index + 1];
    }
    let result;
    try {
      result = await runLoonScript({
        code: fs.readFileSync(scriptPath, "utf8"), request: { url: original, method: request.method, headers },
        argument: settings.argument, httpClientPort: cdnPort, store, timeoutMs: 40000
      });
    } catch (error) {
      result = {};
      log.lastScriptError = String(error?.message || error);
    }
    for (const line of result?.__logs || []) if (line.startsWith("notify:")) log.notifications.push(line);
    if (request.destroyed) return;
    if (result && result.response) {
      log.scriptAnswers += 1;
      const fake = result.response;
      const body = ArrayBuffer.isView(fake.body) ? Buffer.from(fake.body.buffer, fake.body.byteOffset, fake.body.byteLength) : Buffer.from(String(fake.body ?? ""));
      const replyHeaders = { ...(fake.headers || {}), "Content-Length": String(body.length) };
      response.writeHead(Number(fake.status) || 200, replyHeaders);
      response.end(body);
      return;
    }
    // pass-through: the request continues to the host it was meant for
    log.passedThrough += 1;
    const target = new URL(original);
    const upstream = https.request({
      host: "127.0.0.1", port: cdnPort, servername: target.hostname, method: request.method, path: `${target.pathname}${target.search}`,
      headers: { ...headers, Host: target.host }, rejectUnauthorized: false
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
      upstreamResponse.pipe(response);
      response.on("close", () => upstreamResponse.destroy());
    });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.on("close", () => { if (!response.writableEnded) upstream.destroy(); });
    upstream.end();
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });

  return {
    port, store, log, settings,
    state: () => JSON.parse(store.get("btr_ios_app_v1") || "null"),
    start: () => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); }),
    stop: () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); })
  };
}

/* ------------------------------------------------------------------ players */

function get(proxyPort, originalUrl, headers, onResponse) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: "/", agent: false, headers: { "X-Original-URL": originalUrl, ...headers } }, (response) => {
      Promise.resolve(onResponse(response, request)).then(resolve, reject);
    });
    request.on("error", reject);
    request.end();
  });
}

const APP_AGENT = "bili-universal/80300100 CFNetwork/1568.200.51 Darwin/24.1.0 os/ios model/iPhone 15 Pro mobi_app/iphone";

// The way ffmpeg / ijkplayer read a file: "from here to the end", in one go. When the connection
// ends before the file does, reconnect at the position reached (ijkplayer's http hook does this).
async function ffmpegLikePlayer({ proxyPort, url, from = 0, stopAfterBytes = Infinity, maxRequests = 400 }) {
  const chunks = [];
  let offset = from;
  let total = null;
  let requests = 0;
  const started = Date.now();
  while ((total === null || offset < total) && offset - from < stopAfterBytes && requests < maxRequests) {
    requests += 1;
    const before = offset;
    await get(proxyPort, url, { Range: `bytes=${offset}-`, "User-Agent": APP_AGENT, Connection: "close", Accept: "*/*", "Icy-MetaData": "1" }, (response, request) => new Promise((resolve, reject) => {
      if (response.statusCode !== 206) { response.resume(); reject(new Error(`HTTP ${response.statusCode} at ${offset}`)); return; }
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(response.headers["content-range"] || ""));
      if (!range || Number(range[1]) !== offset) { response.resume(); reject(new Error(`bad Content-Range ${response.headers["content-range"]} for offset ${offset}`)); return; }
      total = Number(range[3]);
      response.on("data", (chunk) => {
        chunks.push(chunk);
        offset += chunk.length;
        if (offset - from >= stopAfterBytes) { request.destroy(); resolve(); }
      });
      response.on("end", resolve);
      response.on("error", () => resolve());
      response.on("close", resolve);
    }));
    if (offset === before) throw new Error(`no progress at ${offset}`);
  }
  return { bytes: Buffer.concat(chunks), total, requests, seconds: (Date.now() - started) / 1000 };
}

// A player that asks for exactly the piece it wants next.
async function segmentPlayer({ proxyPort, url, size, segment = 1048576, stopAfterBytes = Infinity }) {
  const chunks = [];
  let offset = 0;
  let requests = 0;
  const started = Date.now();
  while (offset < size && offset < stopAfterBytes) {
    const end = Math.min(size - 1, offset + segment - 1);
    requests += 1;
    const body = await get(proxyPort, url, { Range: `bytes=${offset}-${end}`, "User-Agent": APP_AGENT }, (response) => new Promise((resolve, reject) => {
      const parts = [];
      if (response.statusCode !== 206) { response.resume(); reject(new Error(`HTTP ${response.statusCode}`)); return; }
      if (response.headers["content-range"] !== `bytes ${offset}-${end}/${size}`) { response.resume(); reject(new Error(`bad Content-Range ${response.headers["content-range"]}`)); return; }
      response.on("data", (chunk) => parts.push(chunk));
      response.on("end", () => resolve(Buffer.concat(parts)));
      response.on("error", reject);
    }));
    if (body.length !== end - offset + 1) throw new Error(`short segment ${body.length}`);
    chunks.push(body);
    offset = end + 1;
  }
  return { bytes: Buffer.concat(chunks), requests, seconds: (Date.now() - started) / 1000 };
}

// A player that throws a short answer away and asks for the same position again.
async function stubbornPlayer({ proxyPort, url, attempts = 6 }) {
  const seen = [];
  for (let index = 0; index < attempts; index += 1) {
    const outcome = await get(proxyPort, url, { Range: "bytes=4096-", "User-Agent": APP_AGENT }, (response, request) => new Promise((resolve) => {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(response.headers["content-range"] || ""));
      const complete = range && Number(range[2]) === Number(range[3]) - 1;
      const byScript = Boolean(response.headers["x-btr-ios"]);
      request.destroy();
      resolve({ complete, byScript });
    }));
    seen.push(outcome);
    if (outcome.complete) break;
  }
  return seen;
}

module.exports = { createFakeLoon, ffmpegLikePlayer, segmentPlayer, stubbornPlayer, APP_AGENT };
