/*
 * BTR-iOS playback engine.
 *
 * Adapted from Bilibili-thread-ripper (MIT, © 2026 Bilibili-thread-ripper contributors),
 * src/native-mse-player.js @ 0.9.1.3. The buffering strategy (startup profile, progressive
 * first segment, ordered multi-Range pieces, prune/seek/end-of-stream handling) is upstream's.
 *
 * What is different here, because this runs in iOS / iPadOS Safari instead of desktop Chrome:
 *   - iPhone has no MediaSource. It only has ManagedMediaSource (iOS 17.1+), which needs
 *     remote playback disabled, is attached through a <source> child, may evict buffered
 *     data whenever it likes and tells us when it wants data (startstreaming/endstreaming).
 *   - We own the <video> element (one persistent element, so a single user tap unlocks
 *     programmatic play() for every later video); there is no Bilibili player to hand back to.
 *   - SourceBuffer quotas are small on iOS, so QuotaExceededError is an expected event and the
 *     look-ahead target is sized in bytes as well as seconds.
 *   - Small timeline gaps and evicted ranges are repaired instead of being left to stall.
 *   - Codec families that turn out not to decode are dropped and the next one is tried.
 */
(function installBtrIosEngine(root) {
  "use strict";

  const core = root.__BILI_RANGE_CORE__;
  const sidxTools = root.__BILI_SIDX__;
  const resolverFactory = root.__BILI_CDN_RESOLVER_FACTORY__;
  const downloaderFactory = root.__BILI_IDM_DOWNLOADER_FACTORY__;
  if (!core || !sidxTools || !resolverFactory || !downloaderFactory) return;

  const STARTUP_BUFFER_MIN_SECONDS = 2.5;
  const STARTUP_BUFFER_MAX_SECONDS = 10;
  const STARTUP_RECOVERY_SECONDS = 6;
  const STARTUP_PROTECTION_MS = 20000;
  const SOURCE_OPEN_TIMEOUT_MS = 10000;
  const MAX_AHEAD_SECONDS = 45;
  const MIN_AHEAD_SECONDS = 12;
  const DEFAULT_AHEAD_BYTES = 96 * 1024 * 1024;
  const MIN_AHEAD_BYTES = 12 * 1024 * 1024;
  const IDLE_STREAMING_AHEAD_SECONDS = 15;
  const ENGINE_PAUSE_WINDOW_MS = 400;
  const QUALITY_NAMES = Object.freeze({
    127: "8K", 126: "杜比视界", 125: "HDR", 120: "4K", 116: "1080P 60帧",
    112: "1080P 高码率", 80: "1080P", 74: "720P 60帧", 64: "720P",
    32: "480P", 16: "360P", 6: "240P"
  });
  const QUALITY_HEIGHTS = Object.freeze({ 127: 4320, 126: 2160, 125: 2160, 120: 2160, 116: 1080, 112: 1080, 80: 1080, 74: 720, 64: 720, 32: 480, 16: 360, 6: 240 });
  const CODEC_LABELS = Object.freeze({ av1: "AV1", hevc: "HEVC", avc: "AVC", other: "" });

  /* ------------------------------------------------------------------ *
   * Media Source flavour
   * ------------------------------------------------------------------ */

  // Plain MediaSource is used wherever it exists (iPad, Mac, desktop browsers): that is the
  // path upstream runs on every day. ManagedMediaSource is the only choice on iPhone.
  function mediaSourceFlavour(preference) {
    const plain = typeof root.MediaSource === "function" ? root.MediaSource : null;
    const managed = typeof root.ManagedMediaSource === "function" ? root.ManagedMediaSource : null;
    if (preference === "mms" && managed) return { ctor: managed, managed: true };
    if (preference === "mse" && plain) return { ctor: plain, managed: false };
    if (plain) return { ctor: plain, managed: false };
    if (managed) return { ctor: managed, managed: true };
    return null;
  }

  function isSupportedPlatform() {
    return Boolean(mediaSourceFlavour("auto"));
  }

  // Every browser on iPhone / iPad is WebKit; on the Mac it is Safari (iPadOS also says "Macintosh").
  function isAppleWebKit() {
    const agent = String(root.navigator?.userAgent || "");
    if (/iP(?:hone|ad|od)/.test(agent)) return true;
    return /Macintosh/.test(agent) && /Safari\//.test(agent) && !/Chrom(?:e|ium)|Edg\/|OPR\//.test(agent);
  }

  /*
   * Bilibili labels its HEVC streams "hev1" (parameter sets may also travel inside the stream).
   * Apple's media stack only takes HEVC that is labelled "hvc1" (parameter sets in the header).
   * Bilibili's files do carry the parameter sets in the header as well, so on Apple devices the
   * label is changed: in the codec string, and in the four bytes of the sample entry inside the
   * initialisation segment. Dolby Vision has the same pair of names (dvhe / dvh1).
   */
  const APPLE_CODEC_LABELS = Object.freeze({ hev1: "hvc1", dvhe: "dvh1" });

  function appleCodecString(codecs) {
    const text = String(codecs || "");
    const label = text.slice(0, 4).toLowerCase();
    return APPLE_CODEC_LABELS[label] ? `${APPLE_CODEC_LABELS[label]}${text.slice(4)}` : text;
  }

  function findBox(bytes, start, end, type) {
    let offset = start;
    while (offset + 8 <= end) {
      const size = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
      const name = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      const boxEnd = size === 0 ? end : offset + size;
      if (size === 1 || (size !== 0 && size < 8) || boxEnd > end) return null;
      if (name === type) return { start: offset, end: boxEnd, payload: offset + 8 };
      offset = boxEnd;
    }
    return null;
  }

  // Returns a copy with the sample entry renamed, or the input itself when there is nothing to do.
  function relabelSampleEntryForApple(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let box = { payload: 0, end: bytes.byteLength };
    for (const type of ["moov", "trak", "mdia", "minf", "stbl", "stsd"]) {
      box = findBox(bytes, box.payload, box.end, type);
      if (!box) return input;
    }
    // stsd: version+flags (4), entry count (4), then the first entry: size (4), type (4)
    const typeOffset = box.payload + 8 + 4;
    if (typeOffset + 4 > box.end) return input;
    const label = String.fromCharCode(bytes[typeOffset], bytes[typeOffset + 1], bytes[typeOffset + 2], bytes[typeOffset + 3]);
    const wanted = APPLE_CODEC_LABELS[label];
    if (!wanted) return input;
    const output = new Uint8Array(bytes);
    for (let index = 0; index < 4; index += 1) output[typeOffset + index] = wanted.charCodeAt(index);
    return output;
  }

  /* ------------------------------------------------------------------ *
   * Play-list helpers (shape of /x/player/playurl with fnval=4048)
   * ------------------------------------------------------------------ */

  function dashBody(playinfo) {
    return playinfo?.data?.dash ? playinfo.data : playinfo?.result?.dash ? playinfo.result : playinfo;
  }

  function mimeFor(representation, fallbackKind) {
    const mime = representation?.mimeType || representation?.mime_type || `${fallbackKind}/mp4`;
    const codecs = representation?.codecs || representation?.codec;
    return codecs ? `${mime}; codecs="${codecs}"` : mime;
  }

  function frameRate(representation) {
    const raw = String(representation?.frameRate || representation?.frame_rate || "0");
    if (!raw.includes("/")) return Number(raw) || 0;
    const [top, bottom] = raw.split("/").map(Number);
    return bottom ? top / bottom : 0;
  }

  function codecFamily(representation) {
    const codec = String(representation?.codecs || representation?.codec || "").toLowerCase();
    const codecId = Number(representation?.codecid || representation?.codec_id);
    if (codec.startsWith("av01") || codecId === 13) return "av1";
    if (codec.startsWith("hev1") || codec.startsWith("hvc1") || codec.startsWith("dvh1") || codec.startsWith("dvhe") || codecId === 12) return "hevc";
    if (codec.startsWith("avc1") || codec.startsWith("avc3") || codecId === 7) return "avc";
    return "other";
  }

  function qualityLabel(representation) {
    const id = Number(representation?.id);
    const fps = frameRate(representation);
    if (QUALITY_NAMES[id]) {
      const label = QUALITY_NAMES[id];
      return fps >= 50 && !label.includes("60帧") && [120, 80, 64, 32, 16].includes(id)
        ? `${label} ${Math.round(fps)}帧`
        : label;
    }
    const height = Number(representation?.height) || 0;
    const label = height >= 2160 ? "4K" : height ? `${height}P` : `清晰度 ${id || "?"}`;
    return fps >= 50 ? `${label} ${Math.round(fps)}帧` : label;
  }

  function representationUrl(representation) {
    return String(representation?.baseUrl || representation?.base_url || "");
  }

  function backupUrls(representation) {
    const backup = representation?.backupUrl || representation?.backup_url || representation?.backup_url_list || [];
    return Array.isArray(backup) ? backup.map(String) : [];
  }

  function sameRepresentation(left, right) {
    const path = (representation) => {
      try { return new URL(representationUrl(representation)).pathname; }
      catch (_error) { return representationUrl(representation); }
    };
    return Number(left?.id) === Number(right?.id)
      && codecFamily(left) === codecFamily(right)
      && path(left) === path(right);
  }

  function segmentBase(representation) {
    const base = representation?.segment_base || representation?.segmentBase || representation?.SegmentBase || {};
    const init = core.parseByteRange(base.initialization || base.Initialization || base.initialization_range);
    const index = core.parseByteRange(base.index_range || base.indexRange || base.IndexRange);
    if (!init || !index) throw new Error("播放清单缺少初始化或 SIDX 字节范围");
    return { init, index };
  }

  // Upstream only synthesises mainland URLs from a non-Akamai "donor" address. Overseas
  // accounts sometimes get nothing but Akamai addresses; then every mainland route would be
  // missing and the video could not start at all. The path and signature of an Akamai address
  // are accepted by the ordinary mirrors (the reverse is not true), so as a last resort one
  // ordinary-host copy is added to the backup list. Akamai's own token parameter is dropped.
  function withDonorUrl(representation) {
    const all = [representationUrl(representation), ...backupUrls(representation)].filter(Boolean);
    const hasOrdinary = all.some((value) => core.isBilibiliMediaUrl(value) && !resolverFactory.isAkamaiUrl(value));
    if (hasOrdinary || !all.length) return representation;
    const akamai = all.find((value) => core.isBilibiliMediaUrl(value));
    if (!akamai) return representation;
    try {
      const url = new URL(akamai);
      url.host = resolverFactory.MAINLAND_HOSTS[0];
      url.searchParams.delete("hdnts");
      return { ...representation, backupUrl: [...backupUrls(representation), url.href] };
    } catch (_error) {
      return representation;
    }
  }

  function abortError(message = "播放任务已取消") {
    return new DOMException(message, "AbortError");
  }

  function waitEvent(target, successName, errorName = "error", signal = null, timeoutMs = 0, timeoutMessage = "") {
    return new Promise((resolve, reject) => {
      let timer = null;
      const abortReason = () => signal?.reason instanceof Error ? signal.reason : abortError();
      const success = () => { cleanup(); resolve(); };
      const failure = () => { cleanup(); reject(new Error(`${successName} 失败`)); };
      const aborted = () => { cleanup(); reject(abortReason()); };
      const cleanup = () => {
        clearTimeout(timer);
        target.removeEventListener(successName, success);
        target.removeEventListener(errorName, failure);
        signal?.removeEventListener("abort", aborted);
      };
      if (signal?.aborted) {
        reject(abortReason());
        return;
      }
      target.addEventListener(successName, success, { once: true });
      target.addEventListener(errorName, failure, { once: true });
      signal?.addEventListener("abort", aborted, { once: true });
      if (timeoutMs > 0) timer = setTimeout(() => { cleanup(); reject(new Error(timeoutMessage || `${successName} 超时`)); }, timeoutMs);
    });
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(done, ms);
      function done() { signal?.removeEventListener("abort", canceled); resolve(); }
      function canceled() { clearTimeout(timer); reject(abortError()); }
      if (signal?.aborted) canceled();
      else signal?.addEventListener("abort", canceled, { once: true });
    });
  }

  function bufferedRanges(sourceBuffer) {
    try { return sourceBuffer?.buffered || null; }
    catch (_error) { return null; }
  }

  function isBufferedAt(sourceBuffer, time) {
    const ranges = bufferedRanges(sourceBuffer);
    if (!ranges) return false;
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) <= time + 0.25 && ranges.end(index) >= time - 0.25) return true;
    }
    return false;
  }

  function isStrictlyBufferedAt(sourceBuffer, time) {
    const ranges = bufferedRanges(sourceBuffer);
    if (!ranges) return false;
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) <= time && ranges.end(index) > time + 0.05) return true;
    }
    return false;
  }

  // End of the buffered run that contains `time`. Ranges separated by less than `joinGap`
  // seconds count as one run: audio and video fragments rarely end on the same millisecond.
  function bufferedEndAt(sourceBuffer, time, joinGap = 0.2) {
    const ranges = bufferedRanges(sourceBuffer);
    if (!ranges) return time;
    let end = null;
    for (let index = 0; index < ranges.length; index += 1) {
      const start = ranges.start(index);
      const stop = ranges.end(index);
      if (end === null) {
        if (start <= time + 0.25 && stop >= time - 0.25) end = stop;
      } else if (start - end <= joinGap) {
        end = Math.max(end, stop);
      } else {
        break;
      }
    }
    return end === null ? time : end;
  }

  // Start of the first buffered range that begins after `time` (used to hop over small holes).
  function nextBufferedStart(sourceBuffer, time) {
    const ranges = bufferedRanges(sourceBuffer);
    if (!ranges) return null;
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) > time) return ranges.start(index);
    }
    return null;
  }

  function firstBufferedStart(sourceBuffer) {
    const ranges = bufferedRanges(sourceBuffer);
    return ranges && ranges.length ? ranges.start(0) : null;
  }

  function mediaBytesPerSecond(track) {
    const segment = track?.sidx?.segments?.[track.startupIndex];
    if (segment?.durationSeconds > 0 && segment?.length > 0) return segment.length / segment.durationSeconds;
    return Math.max(0, Number(track?.representation?.bandwidth) || 0) / 8;
  }

  /* ------------------------------------------------------------------ *
   * Representation selection
   * ------------------------------------------------------------------ */

  function createSelector(flavour, initiallyDropped = []) {
    const apple = isAppleWebKit();
    const droppedFamilies = new Set(initiallyDropped.filter((family) => ["av1", "hevc", "avc"].includes(family)));

    function playableMime(representation, kind) {
      if (!apple || kind !== "video") return mimeFor(representation, kind);
      const codecs = representation?.codecs || representation?.codec;
      return mimeFor({ ...representation, codecs: appleCodecString(codecs), codec: undefined }, kind);
    }

    function supported(representation, kind) {
      try { return flavour.ctor.isTypeSupported(playableMime(representation, kind)); }
      catch (_error) { return false; }
    }

    // Upstream's order is AV1 > HEVC > AVC (smallest files first). On Apple devices HEVC is the one
    // family that needs the relabelling trick above, so there it is only used when it is the only
    // way to get a quality (4K, HDR) or when it was asked for. AV1 is only ever reported as
    // supported on Apple hardware that decodes it in silicon.
    function familyScore(representation, preference) {
      const family = codecFamily(representation);
      if (preference && preference !== "auto" && family === preference) return 10;
      const order = apple ? { av1: 3, avc: 2, hevc: 1, other: 0 } : { av1: 3, hevc: 2, avc: 1, other: 0 };
      return order[family] || 0;
    }

    function select(playinfo, preference = "auto") {
      const body = dashBody(playinfo);
      const dash = body?.dash;
      if (!dash) throw new Error("这个视频没有 DASH 播放清单（可能是地区、权限或登录限制）");
      const usable = (dash.video || []).filter((item) => supported(item, "video"));
      // A family that failed before stays out, unless it is exactly what was asked for now.
      const kept = usable.filter((item) => !droppedFamilies.has(codecFamily(item)) || codecFamily(item) === preference);
      const pool = kept.length ? kept : usable;
      const byQuality = new Map();
      for (const representation of pool) {
        const key = Number(representation.id) || `${Number(representation.height) || 0}-${Math.round(frameRate(representation))}`;
        const existing = byQuality.get(key);
        if (!existing
          || familyScore(representation, preference) > familyScore(existing, preference)
          || (familyScore(representation, preference) === familyScore(existing, preference)
            && (Number(representation.bandwidth) || 0) > (Number(existing.bandwidth) || 0))) {
          byQuality.set(key, representation);
        }
      }
      const videos = Array.from(byQuality.values()).sort((a, b) =>
        (Number(b.height) || 0) - (Number(a.height) || 0) || frameRate(b) - frameRate(a) ||
        (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0));
      const audio = (dash.audio || []).filter((item) => supported(item, "audio"))
        .sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0))[0];
      if (!videos.length) throw new Error("这台设备的浏览器不支持清单里的任何视频编码");
      if (!audio) throw new Error("这台设备的浏览器不支持清单里的音频编码");
      return { audio, dash, videos, serverQuality: Number(body?.quality || body?.qn) || 0 };
    }

    // wantedId > 0: that quality, or the nearest one below it, or the lowest there is.
    // wantedId = 0 ("自动"): the best quality that is not taller than maxAutoHeight.
    function pick(selection, wantedId, maxAutoHeight = 1080) {
      const videos = selection.videos;
      if (wantedId > 0) {
        const exact = videos.find((item) => Number(item.id) === wantedId);
        if (exact) return exact;
        const wantedHeight = QUALITY_HEIGHTS[wantedId] || 1080;
        return videos.find((item) => (Number(item.height) || 0) <= wantedHeight) || videos[videos.length - 1];
      }
      return videos.find((item) => (Number(item.height) || 0) <= maxAutoHeight) || videos[videos.length - 1];
    }

    return Object.freeze({
      select,
      pick,
      playableMime,
      relabelsInit: (representation) => apple && Boolean(APPLE_CODEC_LABELS[String(representation?.codecs || representation?.codec || "").slice(0, 4).toLowerCase()]),
      dropFamily(family) { if (family && family !== "other") droppedFamilies.add(family); },
      droppedFamilies: () => [...droppedFamilies]
    });
  }

  /* ------------------------------------------------------------------ *
   * Engine
   * ------------------------------------------------------------------ */

  function createEngine(options) {
    const video = options.video;
    if (!video || typeof video.play !== "function") throw new Error("需要一个 video 元素");
    const getSettings = options.getSettings;
    const flavour = mediaSourceFlavour(String(getSettings()?.engine || "auto"));
    if (!flavour) throw new Error("这个浏览器没有 MediaSource / ManagedMediaSource（iPhone 需要 iOS 17.1 以上）");
    const selector = createSelector(flavour, Array.isArray(options.droppedFamilies) ? options.droppedFamilies : []);
    const log = (title, detail, level = "info", category = "other") => {
      try { options.onLog?.(title, detail, level, category); } catch (_error) {}
    };

    let playinfo = null;
    let selection = null;
    let selectedVideo = null;
    let wantedQualityId = 0;
    let session = null;
    let destroyed = false;
    let generationSequence = 0;
    let seekTimer = null;
    let seekReloads = 0;
    let holeRepairs = 0;
    let gapJumps = 0;
    let quotaEvents = 0;
    let lastRepairAt = 0;
    let lastStallRebuildAt = -Infinity;
    let decodeStalls = 0;
    let enginePausedAt = -Infinity;
    let aheadBytesCap = DEFAULT_AHEAD_BYTES;
    let userWantsPlayback = false;
    let gestureUnlocked = false;
    const cdnBans = resolverFactory.createBanList({
      onBan(host) { log("已停用这个 CDN 节点", `${host} 两次没有返回任何数据，这个视频接下来不再使用它。`, "error", "download"); }
    });
    const eventController = new AbortController();
    const downloader = downloaderFactory.createDownloader({
      getSettings,
      nativeFetch: options.nativeFetch || root.fetch.bind(root),
      onTransfer: options.onTransfer
    });

    function settings() {
      return core.normalizeSettings(getSettings());
    }

    function maxAutoHeight() {
      return Math.max(240, Number(getSettings()?.maxAutoHeight) || 1080);
    }

    function sessionIsCurrent(candidate) {
      return !destroyed && session === candidate && !candidate.disposed;
    }

    function enginePause() {
      enginePausedAt = performance.now();
      try { video.pause(); } catch (_error) {}
    }

    function aheadTargetSeconds(candidate) {
      if (!candidate?.mediaBytesPerSecond) return MAX_AHEAD_SECONDS;
      const byBytes = aheadBytesCap / Math.max(1, candidate.mediaBytesPerSecond);
      return Math.max(MIN_AHEAD_SECONDS, Math.min(MAX_AHEAD_SECONDS, byBytes));
    }

    function publishState(extra = {}) {
      const resolvers = session ? [session.videoResolver, session.audioResolver] : [];
      const health = resolvers.flatMap((resolver) => resolver.status());
      const current = Number(video.currentTime) || 0;
      try {
        options.onState?.({
          mode: settings().mode,
          playerState: session?.fatal ? "error"
            : video.ended ? "ended"
              : session?.recovering ? "buffering"
                : session?.playbackActivated ? (video.paused ? "paused" : "ready") : session ? "loading" : "idle",
          quality: selectedVideo ? qualityLabel(selectedVideo) : "",
          qualityId: Number(selectedVideo?.id) || 0,
          codec: selectedVideo ? codecFamily(selectedVideo) : "",
          managed: flavour.managed,
          streaming: session?.mediaSource && flavour.managed ? session.mediaSource.streaming !== false : true,
          bufferedAhead: session?.tracks?.length
            ? Math.max(0, Math.min(...session.tracks.map((track) => bufferedEndAt(track.sourceBuffer, current))) - current)
            : 0,
          aheadTargetSeconds: session ? aheadTargetSeconds(session) : 0,
          startupTargetSeconds: session?.startupTargetSeconds || 0,
          startupThroughputBps: session?.startupThroughputBps || 0,
          mediaBytesPerSecond: session?.mediaBytesPerSecond || 0,
          needsTap: Boolean(session?.needsTap),
          cdnHosts: health,
          ...extra
        });
      } catch (_error) {}
    }

    /* ---------------- SourceBuffer operations ---------------- */

    async function queuedSourceOperation(candidate, track, operation) {
      const next = track.operation.catch(() => {}).then(async () => {
        if (!sessionIsCurrent(candidate)) return;
        if (track.sourceBuffer.updating) await waitEvent(track.sourceBuffer, "updateend", "error", candidate.controller.signal);
        if (!sessionIsCurrent(candidate)) return;
        return operation();
      });
      track.operation = next;
      return next;
    }

    async function removeNow(candidate, track, start, end) {
      if (end <= start || candidate.mediaSource.readyState !== "open") return;
      track.sourceBuffer.remove(start, end);
      await waitEvent(track.sourceBuffer, "updateend", "error", candidate.controller.signal);
    }

    // Runs inside the track's operation queue. iOS gives each SourceBuffer a small quota, so a
    // full buffer is normal: make room behind the play head (then far ahead of it), shrink the
    // look-ahead target and try again instead of treating it as a fatal error.
    async function appendNow(candidate, track, bytes) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          track.sourceBuffer.appendBuffer(bytes);
        } catch (error) {
          if (error?.name !== "QuotaExceededError" || attempt >= 6) throw error;
          quotaEvents += 1;
          aheadBytesCap = Math.max(MIN_AHEAD_BYTES, Math.floor(aheadBytesCap * 0.7));
          const current = Number(video.currentTime) || 0;
          log("浏览器的视频缓冲区满了", `正在清理已经播放过的部分，并把预读上限降到 ${(aheadBytesCap / 1048576).toFixed(0)} MiB。`, "info", "buffer");
          const keepBehind = attempt === 0 ? 10 : 3;
          if (current - keepBehind > 0.5) await removeNow(candidate, track, 0, current - keepBehind);
          if (attempt >= 1) {
            // Still full: drop what lies far ahead as well. fillTrack() notices and fetches it again.
            const farAhead = current + Math.max(MIN_AHEAD_SECONDS, aheadTargetSeconds(candidate) / (attempt + 1));
            const duration = Number(candidate.mediaSource.duration);
            if (Number.isFinite(duration) && duration > farAhead + 1) await removeNow(candidate, track, farAhead, duration);
          }
          await sleep(150 * (attempt + 1), candidate.controller.signal);
          if (!sessionIsCurrent(candidate)) return;
          continue;
        }
        await waitEvent(track.sourceBuffer, "updateend", "error", candidate.controller.signal);
        return;
      }
    }

    function append(candidate, track, bytes, generation) {
      return queuedSourceOperation(candidate, track, async () => {
        if (!sessionIsCurrent(candidate) || generation !== candidate.generation) return;
        await appendNow(candidate, track, bytes);
        // Appending to an ended stream opens it again; it has to be ended once more afterwards.
        if (candidate.streamEnded && candidate.mediaSource.readyState === "open") candidate.streamEnded = false;
      });
    }

    function removeRange(candidate, track, start, end) {
      if (end <= start || candidate.mediaSource.readyState !== "open") return Promise.resolve();
      return queuedSourceOperation(candidate, track, async () => {
        if (!sessionIsCurrent(candidate) || candidate.mediaSource.readyState !== "open") return;
        await removeNow(candidate, track, start, end);
      });
    }

    /* ---------------- downloading ---------------- */

    async function loadTrack(candidate, kind, representation, resolver, sourceBuffer, startTime) {
      const ranges = segmentBase(representation);
      const [initialization, indexBytes] = await Promise.all([
        downloader.downloadRange(ranges.init, resolver, { signal: candidate.controller.signal, parallel: false, kind: "meta" }),
        downloader.downloadRange(ranges.index, resolver, { signal: candidate.controller.signal, parallel: false, kind: "meta" })
      ]);
      if (!sessionIsCurrent(candidate)) throw abortError();
      const sidx = sidxTools.parseSidx(indexBytes.bytes, ranges.index.start);
      if (!sidx?.segments?.length) throw new Error(`${kind === "video" ? "视频" : "音频"} SIDX 解析失败`);
      log("已经确认数据的下载位置", `找到了 ${sidx.segments.length} 段${kind === "audio" ? "声音" : "画面"}数据。`, "success", "download");
      const startupIndex = sidxTools.segmentIndexAt(sidx.segments, startTime);
      const track = {
        kind, representation, resolver, sourceBuffer, sidx,
        nextIndex: startupIndex,
        startupIndex,
        complete: false,
        filling: false,
        started: false,
        startupComplete: false,
        startupScheduled: false,
        followupScheduled: false,
        prefetches: new Map(),
        resyncHits: new Map(),
        operation: Promise.resolve()
      };
      const initBytes = kind === "video" && selector.relabelsInit(representation)
        ? relabelSampleEntryForApple(initialization.bytes)
        : initialization.bytes;
      if (initBytes !== initialization.bytes) log("已把 HEVC 标签换成苹果设备认的写法", "hev1 → hvc1（只改初始化段里的四个字节）。", "info", "playback");
      await append(candidate, track, initBytes, candidate.generation);
      return track;
    }

    function segmentDownload(candidate, track, segment, index, downloadOptions = {}) {
      return downloader.downloadRange(segment, track.resolver, {
        signal: candidate.controller.signal,
        parallel: true,
        kind: track.kind,
        priority: downloadOptions.priority,
        startup: downloadOptions.startup === true,
        onStartupScheduled: downloadOptions.onStartupScheduled,
        onOrderedChunk: downloadOptions.onOrderedChunk || null
      }).then(
        (result) => ({ index, result }),
        (error) => ({ error, index })
      );
    }

    function updateStartupProfile(candidate) {
      const elapsedSeconds = Math.max(0.25, (performance.now() - candidate.startupStartedAt) / 1000);
      const throughput = candidate.startupCompletedBytes / elapsedSeconds;
      const required = candidate.tracks.reduce((sum, track) => sum + mediaBytesPerSecond(track), 0);
      const ratio = required > 0 ? throughput / required : 0;
      let target = ratio >= 3 ? STARTUP_BUFFER_MIN_SECONDS : ratio >= 1.8 ? 4 : ratio >= 1.25 ? 6 : ratio > 0 ? 8 : 6;
      if ((Number(selectedVideo?.height) || 0) >= 2160 && ratio < 1.8) target = Math.max(target, 8);
      candidate.startupThroughputBps = throughput;
      candidate.mediaBytesPerSecond = required;
      candidate.startupTargetSeconds = Math.max(STARTUP_BUFFER_MIN_SECONDS, Math.min(STARTUP_BUFFER_MAX_SECONDS, target));
      return candidate.startupTargetSeconds;
    }

    function maybeStartStartupPrefetch(candidate) {
      if (candidate.startupPrefetchLaunched || !sessionIsCurrent(candidate) || !candidate.tracks.length) return;
      if (!candidate.tracks.every((track) => track.startupScheduled)) return;
      candidate.startupPrefetchLaunched = true;
      for (const track of candidate.tracks) {
        const index = track.startupIndex + 1;
        track.followupScheduled = true;
        const segment = track.sidx.segments[index];
        if (segment) track.prefetches.set(index, segmentDownload(candidate, track, segment, index, { priority: 70 }));
      }
      ensureBuffer(candidate);
    }

    // ManagedMediaSource says when it wants data. Honour "not now", but never let the buffer
    // in front of the play head run low because of it.
    function streamingPaused(candidate, track, current) {
      if (!flavour.managed || candidate.mediaSource.streaming !== false) return false;
      return bufferedEndAt(track.sourceBuffer, current) - current >= IDLE_STREAMING_AHEAD_SECONDS;
    }

    // Data in front of the play head that the downloader believes it delivered can disappear
    // (ManagedMediaSource eviction, quota clean-up). Go back to the first missing segment. The
    // probe sits half a second past the buffered end so a fragment that ends a frame short of
    // its SIDX time is not fetched again for ever.
    function resyncNextIndex(track, current) {
      if (!track.started || !isBufferedAt(track.sourceBuffer, current)) return;
      const probe = bufferedEndAt(track.sourceBuffer, current) + 0.5;
      const index = sidxTools.segmentIndexAt(track.sidx.segments, probe);
      const segment = track.sidx.segments[index];
      if (!segment || probe < segment.startTime || probe >= segment.endTime) return;
      if (index >= track.nextIndex || track.prefetches.has(index)) return;
      // A browser that throws the same fragment away again and again must not turn this into an
      // endless download loop: three tries per fragment, then leave it to repairHole().
      const hits = (track.resyncHits.get(index) || 0) + 1;
      track.resyncHits.set(index, hits);
      if (hits > 3) return;
      track.nextIndex = index;
      track.complete = false;
    }

    async function fillTrack(candidate, track) {
      if (track.filling || !sessionIsCurrent(candidate) || candidate.fatal) return;
      resyncNextIndex(track, Number(video.currentTime) || candidate.startTime);
      if (track.complete) return;
      track.filling = true;
      const generation = candidate.generation;
      const signal = candidate.controller.signal;
      try {
        while (sessionIsCurrent(candidate) && generation === candidate.generation && !signal.aborted) {
          const current = Number(video.currentTime) || candidate.startTime;
          resyncNextIndex(track, current);
          if (track.nextIndex >= track.sidx.segments.length) {
            track.complete = true;
            break;
          }
          const aheadTarget = aheadTargetSeconds(candidate);
          if (bufferedEndAt(track.sourceBuffer, current) - current >= aheadTarget) break;
          if (track.started && streamingPaused(candidate, track, current)) break;
          const batchSize = track.started ? (track.kind === "video" ? 3 : 4) : 1;
          const batch = [];
          let projectedEnd = bufferedEndAt(track.sourceBuffer, current);
          for (let offset = 0; offset < batchSize; offset += 1) {
            const index = track.nextIndex + offset;
            const segment = track.sidx.segments[index];
            if (!segment || projectedEnd - current >= aheadTarget) break;
            const startup = !track.startupComplete && index === track.startupIndex;
            const prefetched = track.prefetches.get(index);
            batch.push(prefetched || segmentDownload(candidate, track, segment, index, {
              priority: startup ? 120 : Math.max(30, 55 - offset * 5),
              startup,
              onStartupScheduled: startup ? () => {
                track.startupScheduled = true;
                maybeStartStartupPrefetch(candidate);
              } : null,
              onOrderedChunk: startup ? async (bytes) => {
                if (!sessionIsCurrent(candidate) || generation !== candidate.generation || signal.aborted) return;
                candidate.progressiveAppends += 1;
                await append(candidate, track, bytes, generation);
                ensureBuffer(candidate);
              } : null
            }));
            projectedEnd = segment.endTime;
          }
          if (!batch.length) break;
          for (const pending of batch) {
            const settled = await pending;
            track.prefetches.delete(settled.index);
            if (settled.error) throw settled.error;
            if (!sessionIsCurrent(candidate) || generation !== candidate.generation || signal.aborted) break;
            if (!settled.result.streamed) await append(candidate, track, settled.result.bytes, generation);
            if (!track.startupComplete && settled.index === track.startupIndex) {
              track.startupComplete = true;
              candidate.startupCompletedBytes += settled.result.byteLength;
              updateStartupProfile(candidate);
            }
            track.nextIndex = settled.index + 1;
            track.started = true;
            try { options.onSegment?.({ kind: track.kind, bytes: settled.result.byteLength, pieces: settled.result.pieceCount, hosts: settled.result.hosts }); } catch (_error) {}
            ensureBuffer(candidate);
          }
        }
      } catch (error) {
        if (!signal.aborted && sessionIsCurrent(candidate)) fatal(candidate, error);
      } finally {
        track.filling = false;
        maybeEndStream(candidate);
      }
    }

    function maybeEndStream(candidate = session) {
      if (!candidate || !sessionIsCurrent(candidate) || candidate.fatal || candidate.streamEnded || candidate.ending) return;
      if (!candidate.tracks.length || !candidate.tracks.every((track) => track.complete)) return;
      candidate.ending = true;
      Promise.all(candidate.tracks.map((track) => track.operation.catch(() => {}))).then(() => {
        candidate.ending = false;
        if (!sessionIsCurrent(candidate) || candidate.fatal || candidate.streamEnded || candidate.mediaSource.readyState !== "open") return;
        if (!candidate.tracks.every((track) => track.complete)) return;
        if (candidate.tracks.some((track) => track.sourceBuffer.updating)) {
          candidate.endRetryTimer = setTimeout(() => maybeEndStream(candidate), 50);
          return;
        }
        // endOfStream() trims the duration to the end of the buffered media by itself. See
        // upstream 0.9.1.3: setting a shorter duration first is refused for HEVC tails.
        candidate.mediaSource.endOfStream();
        candidate.streamEnded = true;
        publishState();
      }).catch((error) => {
        candidate.ending = false;
        if (sessionIsCurrent(candidate) && error?.name !== "InvalidStateError") fatal(candidate, error);
        else if (sessionIsCurrent(candidate)) {
          candidate.endAttempts = (candidate.endAttempts || 0) + 1;
          if (candidate.endAttempts === 40) log("视频结尾没能正常收尾", `结束媒体流一直失败，播放器可能停在结尾。\n原因：${String(error?.message || error).slice(0, 160)}`, "error", "playback");
          if (candidate.endAttempts < 400) candidate.endRetryTimer = setTimeout(() => maybeEndStream(candidate), 50);
        }
      });
    }

    /* ---------------- play / pause plumbing ---------------- */

    function setCurrentTimeInternal(candidate, target) {
      candidate.internalSeekTarget = Number(target) || 0;
      try { video.currentTime = target; }
      catch (_error) { candidate.internalSeekTarget = null; }
      setTimeout(() => {
        if (sessionIsCurrent(candidate) && candidate.internalSeekTarget === (Number(target) || 0)) candidate.internalSeekTarget = null;
      }, 300);
    }

    // iOS refuses play() with sound until one play() call has happened inside a tap on this
    // element. After that the element stays unlocked, which is why there is only one element.
    function tryPlay(candidate) {
      let promise;
      try { promise = video.play(); }
      catch (error) { promise = Promise.reject(error); }
      Promise.resolve(promise).then(() => {
        gestureUnlocked = true;
        if (sessionIsCurrent(candidate) && candidate.needsTap) {
          candidate.needsTap = false;
          publishState();
        }
      }).catch((error) => {
        if (!sessionIsCurrent(candidate)) return;
        if (error?.name === "NotAllowedError") {
          if (!candidate.needsTap) {
            candidate.needsTap = true;
            log("需要你点一下才能开始播放", "iOS 不允许网页自己播放有声音的视频，点一下播放按钮就可以了。", "info", "playback");
          }
          publishState();
        }
      });
    }

    function attemptAutoplay(candidate) {
      if (candidate.playAttempted || !candidate.resumeWanted || !sessionIsCurrent(candidate)) return;
      candidate.playAttempted = true;
      tryPlay(candidate);
    }

    function activateWhenReady(candidate) {
      if (candidate.playbackActivated || !sessionIsCurrent(candidate) || !candidate.tracks.length) return;
      if (!candidate.tracks.every((track) => track.startupComplete && track.followupScheduled)) return;
      const liveTime = Math.max(0, Number(video.currentTime) || 0);
      const target = Math.max(candidate.startTime, liveTime);
      candidate.startTime = target;
      if (!candidate.tracks.every((track) => isBufferedAt(track.sourceBuffer, target))) return;
      const ends = candidate.tracks.map((track) => bufferedEndAt(track.sourceBuffer, target));
      const required = updateStartupProfile(candidate);
      const remaining = Math.max(0.5, (Number(candidate.mediaSource.duration) || target + required) - target);
      if (Math.min(...ends) - target < Math.max(0.5, Math.min(required, remaining))) return;
      candidate.playbackActivated = true;
      log("开播需要的缓冲已经够了", `从 ${target.toFixed(2)} 秒开始播放，这次先缓冲了 ${required.toFixed(1)} 秒。`, "success", "buffer");
      candidate.playbackActivatedAt = performance.now();
      if (target - (Number(video.currentTime) || 0) > 0.05) setCurrentTimeInternal(candidate, target);
      video.playbackRate = candidate.playbackRate;
      attemptAutoplay(candidate);
    }

    /* ---------------- repairs ---------------- */

    // Give up on the current codec family (for this and later videos) and carry on with the next
    // best one at the same quality. False when there is nothing else to switch to.
    function switchCodecFamily(reason) {
      const family = codecFamily(selectedVideo);
      if (!playinfo || family === "other" || selector.droppedFamilies().includes(family)) return false;
      selector.dropFamily(family);
      try {
        const nextSelection = selector.select(playinfo, "auto");
        const nextVideo = selector.pick(nextSelection, Number(selectedVideo?.id) || wantedQualityId, maxAutoHeight());
        if (!nextVideo || codecFamily(nextVideo) === family) return false;
        log("这种编码在这台设备上放不了", `${CODEC_LABELS[family] || family} ${reason}，改用 ${CODEC_LABELS[codecFamily(nextVideo)] || "其他编码"}。`, "error", "playback");
        try { options.onFamilyDropped?.(family); } catch (_error) {}
        selection = nextSelection;
        startSession(nextVideo, { ...playbackState(), resume: true }).catch((error) => { if (session) fatal(session, error); });
        announceQualities();
        return true;
      } catch (_error) {
        return false;
      }
    }

    // Data is buffered right where the play head is, playback is wanted, and still nothing moves:
    // the decoder is stuck. Some devices do this instead of reporting an error for a stream they
    // cannot handle.
    function handleDecodeStall(candidate) {
      if (switchCodecFamily("一直解不出画面")) return;
      const now = performance.now();
      if (now - lastStallRebuildAt < 30000) return;
      lastStallRebuildAt = now;
      log("有缓冲却一直不动", "正在原地重建播放器。", "error", "playback");
      startSession(selectedVideo, { ...playbackState(), resume: true }).catch((error) => { if (session) fatal(session, error); });
    }

    // A hole right in front of the play head that is shorter than a second (timestamps that do
    // not start at exactly zero, fragments that end a frame apart) would stall Safari for ever.
    function jumpSmallGap(candidate) {
      if (!candidate.playbackActivated || video.seeking || candidate.internalSeekTarget !== null) return false;
      const current = Number(video.currentTime) || 0;
      if (candidate.tracks.every((track) => isStrictlyBufferedAt(track.sourceBuffer, current))) return false;
      const starts = candidate.tracks.map((track) => isStrictlyBufferedAt(track.sourceBuffer, current)
        ? current
        : nextBufferedStart(track.sourceBuffer, current));
      if (starts.some((value) => value === null)) return false;
      const target = Math.max(...starts);
      if (target - current <= 0 || target - current > 1) return false;
      if (!candidate.tracks.every((track) => isStrictlyBufferedAt(track.sourceBuffer, target + 0.1))) return false;
      gapJumps += 1;
      log("跳过了一小段空隙", `从 ${current.toFixed(2)} 秒跳到 ${(target + 0.05).toFixed(2)} 秒。`, "info", "buffer");
      setCurrentTimeInternal(candidate, target + 0.05);
      return true;
    }

    // The play head sits on data that is gone (ManagedMediaSource evicted it, or a quota clean-up
    // removed it) and the downloader has already moved past that position: rebuild from here.
    function repairHole(candidate) {
      if (!candidate.playbackActivated || candidate.fatal || video.seeking || seekTimer) return false;
      if (candidate.internalSeekTarget !== null || video.ended) return false;
      const current = Number(video.currentTime) || 0;
      const duration = Number(candidate.mediaSource.duration);
      if (Number.isFinite(duration) && current >= duration - 0.5) return false;
      const lost = candidate.tracks.filter((track) => {
        if (isBufferedAt(track.sourceBuffer, current)) return false;
        const next = track.sidx.segments[track.nextIndex];
        return track.complete || !next || next.startTime > current + 0.25;
      });
      if (!lost.length) return false;
      const now = performance.now();
      if (now - lastRepairAt < 3000) return false;
      lastRepairAt = now;
      holeRepairs += 1;
      log("播放位置的缓冲不见了", `浏览器回收了 ${current.toFixed(1)} 秒附近的数据，正在从这里重新缓冲。`, "info", "buffer");
      startSession(selectedVideo, { ...playbackState(), time: current, resume: userWantsPlayback || !video.paused }).catch((error) => {
        if (session) fatal(session, error);
      });
      return true;
    }

    function ensureBuffer(candidate = session) {
      if (!candidate || !sessionIsCurrent(candidate) || candidate.fatal || !candidate.tracks.length) return;
      for (const track of candidate.tracks) fillTrack(candidate, track);
      activateWhenReady(candidate);
      const current = Number(video.currentTime) || candidate.startTime;
      const ready = candidate.tracks.every((track) => isBufferedAt(track.sourceBuffer, current));
      const ahead = ready ? Math.max(0, Math.min(...candidate.tracks.map((track) => bufferedEndAt(track.sourceBuffer, current))) - current) : 0;
      if (candidate.recovering && ready) {
        const remaining = Math.max(0.5, (Number(candidate.mediaSource.duration) || current + candidate.recoveryTargetSeconds) - current);
        if (ahead >= Math.min(candidate.recoveryTargetSeconds, remaining)) {
          candidate.recovering = false;
          log("缓冲补好了，可以继续播放", `已经备好接下来 ${ahead.toFixed(1)} 秒的数据。`, "success", "buffer");
          candidate.playAttempted = false;
          attemptAutoplay(candidate);
        }
      }
      if (candidate.playbackActivated) {
        const now = performance.now();
        const stalled = !video.paused && !video.seeking && !video.ended && video.readyState < 3;
        candidate.stalledSince = stalled ? (candidate.stalledSince || now) : 0;
        if (!ready || (stalled && now - candidate.stalledSince >= 1000)) {
          if (!jumpSmallGap(candidate) && !ready) repairHole(candidate);
        }
        const stuckWithData = stalled && !candidate.recovering && candidate.tracks.every((track) => isStrictlyBufferedAt(track.sourceBuffer, current)) && ahead >= 3;
        candidate.decodeStallSince = stuckWithData ? (candidate.decodeStallSince || now) : 0;
        if (stuckWithData && now - candidate.decodeStallSince >= 8000) {
          candidate.decodeStallSince = 0;
          decodeStalls += 1;
          handleDecodeStall(candidate);
          return;
        }
      }
      publishState();
    }

    function prune(candidate = session) {
      if (!candidate || !sessionIsCurrent(candidate) || candidate.fatal || video.currentTime < 75) return;
      const end = video.currentTime - 30;
      const stale = candidate.tracks.filter((track) => {
        const first = firstBufferedStart(track.sourceBuffer);
        return first !== null && first < end - 10;
      });
      if (!stale.length) return;
      Promise.all(stale.map((track) => removeRange(candidate, track, 0, end).catch(() => {}))).catch(() => {});
    }

    /* ---------------- session life cycle ---------------- */

    function detachSource() {
      for (const node of Array.from(video.querySelectorAll("source[data-btr]"))) node.remove();
      video.removeAttribute("src");
    }

    function disposeSession(candidate, detach = true) {
      if (!candidate || candidate.disposed) return;
      candidate.disposed = true;
      candidate.generation = ++generationSequence;
      candidate.controller.abort(abortError());
      clearInterval(candidate.timer);
      clearTimeout(candidate.endRetryTimer);
      if (detach) {
        enginePause();
        detachSource();
        try { video.load(); } catch (_error) {}
      }
      try { URL.revokeObjectURL(candidate.objectUrl); } catch (_error) {}
    }

    function fatal(candidate, error) {
      if (!sessionIsCurrent(candidate) || candidate.fatal || error?.name === "AbortError") return;
      candidate.fatal = true;
      candidate.controller.abort(abortError("播放内核发生错误"));
      clearInterval(candidate.timer);
      const message = String(error?.message || error).slice(0, 200);
      log("播放内核出错了", message, "error", "playback");
      publishState({ playerState: "error", lastError: message });
      try { options.onFatal?.(error); } catch (_error) {}
    }

    function attachSource(candidate) {
      detachSource();
      if (flavour.managed) {
        // ManagedMediaSource never opens while AirPlay could take the element over.
        try { video.disableRemotePlayback = true; } catch (_error) {}
        video.setAttribute("x-webkit-airplay", "deny");
        const source = document.createElement("source");
        source.type = "video/mp4";
        source.src = candidate.objectUrl;
        source.dataset.btr = "1";
        video.appendChild(source);
      } else {
        video.src = candidate.objectUrl;
      }
      video.load();
    }

    async function startSession(representation, state) {
      if (destroyed) return;
      const family = CODEC_LABELS[codecFamily(representation)];
      log("正在准备播放器", `使用 ${qualityLabel(representation)}${family ? ` ${family}` : ""}，从 ${Number(state.time || 0).toFixed(2)} 秒开始。`, "info", "takeover");
      const previous = session;
      selectedVideo = representation;
      const mediaSource = new flavour.ctor();
      const objectUrl = URL.createObjectURL(mediaSource);
      const videoRepresentation = withDonorUrl(representation);
      const audioRepresentation = withDonorUrl(selection.audio);
      const candidate = {
        disposed: false, fatal: false, generation: ++generationSequence,
        controller: new AbortController(), mediaSource, objectUrl,
        timer: null, endRetryTimer: null, tracks: [], ending: false, streamEnded: false,
        playAttempted: false, playbackActivated: false, playbackActivatedAt: 0,
        recovering: false, recoveryTargetSeconds: STARTUP_RECOVERY_SECONDS, stalledSince: 0, decodeStallSince: 0,
        startupCompletedBytes: 0, startupPrefetchLaunched: false, startupStartedAt: performance.now(),
        progressiveAppends: 0, needsTap: false,
        startupTargetSeconds: 6, startupThroughputBps: 0, mediaBytesPerSecond: 0,
        startupWaitingEvents: 0, resumeWanted: Boolean(state.resume),
        playbackRate: Number(state.playbackRate) || 1,
        startTime: Math.max(0, Number(state.time) || 0),
        internalSeekTarget: null,
        videoResolver: resolverFactory.createResolver(videoRepresentation, () => settings().mode, cdnBans),
        audioResolver: resolverFactory.createResolver(audioRepresentation, () => settings().mode, cdnBans)
      };
      session = candidate;
      if (previous) disposeSession(previous, false);
      enginePause();
      attachSource(candidate);
      video.playbackRate = candidate.playbackRate;
      publishState({ playerState: "loading", lastError: "" });
      if (flavour.managed) {
        mediaSource.addEventListener("startstreaming", () => ensureBuffer(candidate), { signal: candidate.controller.signal });
        mediaSource.addEventListener("endstreaming", () => publishState(), { signal: candidate.controller.signal });
      }
      try {
        if (mediaSource.readyState !== "open") {
          await waitEvent(mediaSource, "sourceopen", "error", candidate.controller.signal, SOURCE_OPEN_TIMEOUT_MS,
            "浏览器一直没有打开媒体源（请确认页面在前台；iPhone 需要 iOS 17.1 以上）");
        }
        if (!sessionIsCurrent(candidate)) return;
        const videoBuffer = mediaSource.addSourceBuffer(selector.playableMime(representation, "video"));
        const audioBuffer = mediaSource.addSourceBuffer(selector.playableMime(selection.audio, "audio"));
        const [videoTrack, audioTrack] = await Promise.all([
          loadTrack(candidate, "video", videoRepresentation, candidate.videoResolver, videoBuffer, candidate.startTime),
          loadTrack(candidate, "audio", audioRepresentation, candidate.audioResolver, audioBuffer, candidate.startTime)
        ]);
        if (!sessionIsCurrent(candidate)) return;
        candidate.tracks = [videoTrack, audioTrack];
        if (flavour.managed) {
          for (const track of candidate.tracks) {
            track.sourceBuffer.addEventListener("bufferedchange", () => ensureBuffer(candidate), { signal: candidate.controller.signal });
          }
        }
        const duration = Math.max(
          Number(selection.dash.duration) || 0,
          videoTrack.sidx.segments.at(-1)?.endTime || 0,
          audioTrack.sidx.segments.at(-1)?.endTime || 0
        );
        if (duration > 0) mediaSource.duration = duration;
        if (candidate.startTime > 0 && Number.isFinite(mediaSource.duration)) {
          setCurrentTimeInternal(candidate, Math.min(candidate.startTime, Math.max(0, mediaSource.duration - 0.1)));
        }
        candidate.startupStartedAt = performance.now();
        candidate.timer = setInterval(() => { ensureBuffer(candidate); prune(candidate); }, 750);
        ensureBuffer(candidate);
      } catch (error) {
        if (sessionIsCurrent(candidate)) fatal(candidate, error);
      }
    }

    async function seek() {
      const candidate = session;
      if (!candidate || !sessionIsCurrent(candidate) || !candidate.tracks.length) return;
      const target = Number(video.currentTime) || 0;
      if (candidate.internalSeekTarget !== null && Math.abs(target - candidate.internalSeekTarget) < 0.25) {
        candidate.internalSeekTarget = null;
        return;
      }
      if (candidate.tracks.every((track) => isBufferedAt(track.sourceBuffer, target))) {
        ensureBuffer(candidate);
        return;
      }
      // Safari reports the engine's own initial positioning late, as if it were a seek. The session
      // is already buffering exactly there; rebuilding it would only start the wait over.
      if (!candidate.playbackActivated && Math.abs(target - candidate.startTime) < 0.75) {
        ensureBuffer(candidate);
        return;
      }
      seekReloads += 1;
      log("你跳到的位置还需要加载", `正在为 ${target.toFixed(2)} 秒的位置重新准备数据。`, "info", "buffer");
      await startSession(selectedVideo, { ...playbackState(), time: target, resume: userWantsPlayback || !video.paused });
    }

    function scheduleSeek() {
      clearTimeout(seekTimer);
      seekTimer = setTimeout(() => {
        seekTimer = null;
        seek().catch((error) => { if (session && sessionIsCurrent(session)) fatal(session, error); });
      }, 220);
    }

    function playbackState() {
      return {
        time: Number(video.currentTime) || 0,
        resume: userWantsPlayback,
        playbackRate: video.playbackRate || 1
      };
    }

    /* ---------------- <video> events ---------------- */

    const listen = (name, handler) => video.addEventListener(name, handler, { signal: eventController.signal });
    listen("seeking", scheduleSeek);
    listen("timeupdate", () => ensureBuffer());
    listen("play", () => {
      userWantsPlayback = true;
      const candidate = session;
      if (candidate && sessionIsCurrent(candidate)) {
        candidate.resumeWanted = true;
        candidate.needsTap = false;
      }
      publishState();
    });
    listen("pause", () => {
      // The engine pauses by itself while it rebuilds or tops up the buffer. Only a pause that the
      // person (or iOS: a phone call, unplugged headphones) caused cancels the automatic resume.
      const engineDidIt = performance.now() - enginePausedAt < ENGINE_PAUSE_WINDOW_MS;
      const candidate = session;
      if (!engineDidIt && !video.ended && !video.seeking) {
        userWantsPlayback = false;
        if (candidate && sessionIsCurrent(candidate)) candidate.resumeWanted = false;
      }
      publishState();
    });
    listen("waiting", () => {
      const candidate = session;
      if (candidate && sessionIsCurrent(candidate) && candidate.playbackActivated) {
        candidate.startupWaitingEvents += 1;
        if (performance.now() - candidate.playbackActivatedAt <= STARTUP_PROTECTION_MS && !candidate.recovering && !video.seeking) {
          candidate.recovering = true;
          candidate.resumeWanted = true;
          candidate.playAttempted = false;
          candidate.recoveryTargetSeconds = Math.min(STARTUP_BUFFER_MAX_SECONDS, Math.max(STARTUP_RECOVERY_SECONDS, candidate.startupTargetSeconds + 2));
          log("刚开始播放就卡住了", `先暂停一下，多缓冲 ${candidate.recoveryTargetSeconds.toFixed(0)} 秒再继续。`, "info", "buffer");
          enginePause();
        }
        ensureBuffer(candidate);
      }
    });
    listen("ended", () => {
      publishState({ playerState: "ended", bufferedAhead: 0 });
      try { options.onEnded?.(); } catch (_error) {}
    });
    listen("error", () => {
      const candidate = session;
      if (!candidate || !sessionIsCurrent(candidate) || candidate.fatal) return;
      const mediaError = video.error;
      if (!mediaError) return;
      const decodeProblem = mediaError.code === 3 || mediaError.code === 4;
      // A codec the browser claimed to support but cannot actually decode: try the next family.
      if (decodeProblem && switchCodecFamily("解码失败")) return;
      fatal(candidate, new Error(`浏览器报告媒体错误（代码 ${mediaError.code}）${mediaError.message ? `：${mediaError.message}` : ""}`));
    });

    /* ---------------- public API ---------------- */

    function qualities() {
      return (selection?.videos || []).map((item) => ({
        id: Number(item.id) || 0,
        label: qualityLabel(item),
        codec: codecFamily(item),
        codecLabel: CODEC_LABELS[codecFamily(item)] || "",
        width: Number(item.width) || 0,
        height: Number(item.height) || 0,
        bandwidth: Number(item.bandwidth) || 0,
        selected: Boolean(selectedVideo && sameRepresentation(item, selectedVideo))
      }));
    }

    function announceQualities() {
      try { options.onQualities?.(qualities()); } catch (_error) {}
    }

    async function load(request) {
      if (destroyed) throw new Error("播放内核已经销毁");
      playinfo = request.playinfo;
      cdnBans.reset();
      aheadBytesCap = DEFAULT_AHEAD_BYTES;
      selection = selector.select(playinfo, String(getSettings()?.codec || "auto"));
      wantedQualityId = Math.max(0, Number(request.qualityId) || 0);
      const chosen = selector.pick(selection, wantedQualityId, maxAutoHeight());
      userWantsPlayback = request.autoplay !== false;
      selectedVideo = chosen;
      announceQualities();
      await startSession(chosen, {
        time: Math.max(0, Number(request.startTime) || 0),
        resume: userWantsPlayback,
        playbackRate: video.playbackRate || 1
      });
    }

    async function setQuality(id) {
      if (!selection || destroyed) return;
      wantedQualityId = Math.max(0, Number(id) || 0);
      const next = selector.pick(selection, wantedQualityId, maxAutoHeight());
      if (!next || (selectedVideo && sameRepresentation(next, selectedVideo))) return;
      const state = playbackState();
      selectedVideo = next;
      announceQualities();
      await startSession(next, state);
    }

    // Codec preference changed: choose again, keep the quality.
    async function reselect() {
      if (!playinfo || destroyed) return;
      selection = selector.select(playinfo, String(getSettings()?.codec || "auto"));
      const next = selector.pick(selection, Number(selectedVideo?.id) || wantedQualityId, maxAutoHeight());
      if (next && !(selectedVideo && sameRepresentation(next, selectedVideo))) {
        const state = playbackState();
        selectedVideo = next;
        await startSession(next, state);
      }
      announceQualities();
    }

    // Must be called synchronously from a tap/click handler.
    function userPlay() {
      userWantsPlayback = true;
      const candidate = session;
      if (candidate && sessionIsCurrent(candidate)) {
        candidate.resumeWanted = true;
        candidate.needsTap = false;
        if (candidate.playbackActivated && !candidate.recovering) {
          candidate.playAttempted = true;
          tryPlay(candidate);
          publishState();
          return;
        }
        candidate.playAttempted = false;
      }
      // Nothing to show yet. A play() inside the tap still unlocks the element for the engine's
      // own play() later on; the immediate pause keeps half-buffered video from flashing by.
      try {
        const promise = video.play();
        if (promise && typeof promise.catch === "function") promise.catch(() => {});
      } catch (_error) {}
      enginePause();
      if (candidate && sessionIsCurrent(candidate)) ensureBuffer(candidate);
      publishState();
    }

    function stop() {
      if (session) disposeSession(session, true);
      session = null;
      selection = null;
      selectedVideo = null;
      playinfo = null;
      publishState({ playerState: "idle" });
    }

    function destroy() {
      if (destroyed) return;
      clearTimeout(seekTimer);
      if (session) disposeSession(session, true);
      destroyed = true;
      session = null;
      eventController.abort();
    }

    return Object.freeze({
      load,
      stop,
      destroy,
      setQuality,
      reselect,
      userPlay,
      qualities,
      applySettings() { ensureBuffer(); },
      isManaged: () => flavour.managed,
      isUnlocked: () => gestureUnlocked,
      getDebug: () => ({
        engine: "btr-ios-progressive-mse",
        upstream: "bilibili-thread-ripper 0.9.1.3",
        managed: flavour.managed,
        quality: selectedVideo ? qualityLabel(selectedVideo) : "",
        qualityId: Number(selectedVideo?.id) || 0,
        codec: selectedVideo ? codecFamily(selectedVideo) : "",
        currentTime: Number(video.currentTime) || 0,
        mediaSourceState: session?.mediaSource?.readyState || "closed",
        playbackActivated: Boolean(session?.playbackActivated),
        recovering: Boolean(session?.recovering),
        needsTap: Boolean(session?.needsTap),
        userWantsPlayback,
        sessionStartTime: session?.startTime || 0,
        startupBufferSeconds: session?.startupTargetSeconds || 0,
        startupWaitingEvents: session?.startupWaitingEvents || 0,
        progressiveAppends: session?.progressiveAppends || 0,
        aheadBytesCap,
        seekReloads,
        holeRepairs,
        gapJumps,
        quotaEvents,
        decodeStalls,
        appleWebKit: isAppleWebKit(),
        droppedCodecFamilies: selector.droppedFamilies(),
        bannedHosts: cdnBans.hosts(),
        tracks: (session?.tracks || []).map((track) => ({ kind: track.kind, nextIndex: track.nextIndex, segments: track.sidx.segments.length, complete: track.complete }))
      })
    });
  }

  root.__BTRI_ENGINE__ = Object.freeze({
    createEngine,
    createSelector,
    isAppleWebKit,
    appleCodecString,
    relabelSampleEntryForApple,
    isSupportedPlatform,
    mediaSourceFlavour,
    qualityLabel,
    codecFamily,
    withDonorUrl,
    bufferedEndAt
  });
})(globalThis);
