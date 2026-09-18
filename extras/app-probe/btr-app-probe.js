/*
 * BTR-iOS · 官方 App 取流探针（诊断用，不加速、不改动任何数据）
 *
 * 目的：弄清楚哔哩哔哩官方 App 的播放器是怎么向 CDN 要数据的 —— 是一小段一小段带结束位置的
 * Range（bytes=a-b），还是一条“从某处一直读到底”的开放式请求（bytes=a-）。只有前一种，Loon
 * 脚本才有可能替它做多线程；后一种脚本无能为力（脚本必须一次性给出完整响应，不能边下边给）。
 *
 * 做法：对每个视频分段请求只读取请求头，原样放行（$done({})），把统计记在 Loon 的本地存储里，
 * 每 25 个请求发一条通知。不读取、不保存响应内容，也不会把任何东西发到网络上。
 * 用完请把这个插件关掉：它需要对视频 CDN 做 MITM，长期开着只会白白耗电。
 */
var BTR_PROBE_KEY = "btr_ios_app_probe_v1";

(function () {
  "use strict";
  var request = typeof $request !== "undefined" && $request ? $request : {};
  var headers = request.headers || {};

  function header(name) {
    var wanted = name.toLowerCase();
    for (var key in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === wanted) return String(headers[key]);
    }
    return "";
  }

  function readRecord() {
    try {
      var parsed = JSON.parse($persistentStore.read(BTR_PROBE_KEY) || "null");
      if (parsed && typeof parsed === "object" && parsed.version === 1) return parsed;
    } catch (_error) {}
    return { version: 1, startedAt: Date.now(), count: 0, bounded: 0, open: 0, none: 0, other: 0, sizes: [], hosts: {}, agents: {}, schemes: {} };
  }

  function bump(map, key) {
    var name = String(key || "(空)").slice(0, 60);
    map[name] = (map[name] || 0) + 1;
  }

  function sizeText(bytes) {
    return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.round(bytes / 1024) + " KB";
  }

  function summary(record) {
    var sizes = record.sizes.slice().sort(function (a, b) { return a - b; });
    var lines = [
      "有结束位置的 Range：" + record.bounded + " 个" + (sizes.length ? "（最小 " + sizeText(sizes[0]) + " / 中位 " + sizeText(sizes[Math.floor(sizes.length / 2)]) + " / 最大 " + sizeText(sizes[sizes.length - 1]) + "）" : ""),
      "开放式 Range（bytes=a-）：" + record.open + " 个",
      "没有 Range：" + record.none + " 个；其他写法：" + record.other + " 个"
    ];
    var agents = Object.keys(record.agents).sort(function (a, b) { return record.agents[b] - record.agents[a]; }).slice(0, 2);
    if (agents.length) lines.push("客户端：" + agents.join(" | "));
    var schemes = Object.keys(record.schemes).map(function (key) { return key + "×" + record.schemes[key]; });
    if (schemes.length) lines.push("协议：" + schemes.join("，"));
    return lines.join("\n");
  }

  try {
    var url = String(request.url || "");
    var record = readRecord();
    var range = header("Range");
    var bounded = /^bytes=(\d+)-(\d+)$/i.exec(range);
    record.count += 1;
    if (bounded) {
      record.bounded += 1;
      record.sizes.push(Number(bounded[2]) - Number(bounded[1]) + 1);
      if (record.sizes.length > 400) record.sizes.splice(0, record.sizes.length - 400);
    } else if (/^bytes=\d+-$/i.test(range)) record.open += 1;
    else if (!range) record.none += 1;
    else record.other += 1;
    bump(record.hosts, (/^https?:\/\/([^/:]+)/i.exec(url) || [])[1]);
    bump(record.schemes, (/^(https?):/i.exec(url) || [])[1]);
    // 只留下客户端名字那一小段，足够分清是官方 App 还是浏览器
    bump(record.agents, header("User-Agent").replace(/\s*\(.*$/, "").slice(0, 40));
    $persistentStore.write(JSON.stringify(record), BTR_PROBE_KEY);
    if (record.count % 25 === 0) {
      $notification.post("BTR 探针：已记录 " + record.count + " 个取流请求", "把这条通知的内容发给我就行", summary(record));
      console.log("BTR probe\n" + summary(record) + "\nhosts: " + JSON.stringify(record.hosts));
    }
  } catch (error) {
    try { console.log("BTR probe error: " + String(error)); } catch (_error) {}
  }
  $done({});
})();
