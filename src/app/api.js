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
