/*!
 * @name 全豆要[聚合音源]
 * @description 迭代9.3版本，聚合 星海/溯音/念心/长青/歌一刀专属汽水音乐，多链路自动回退
 * @version 9.3 93特供版 DeepSeek优化
 * @author 全豆要 and Gemini优化 Toskysun去混淆 TZB679兼容性处理
 * @contribution DeepSeek优化
 */

// --- 常量定义 ---
const CACHE_TTL_MS = 21600000;        // 6小时
const CACHE_MAX_SIZE = 500;
const HTTP_URL_REGEX = /^https?:\/\//i;

// API 端点
const XINGHAI_MAIN_API = "https://music-api.gdstudio.xyz/api.php?use_xbridge3=true&loader_name=forest&need_sec_link=1&sec_link_scene=im&theme=light";
const XINGHAI_BACKUP_API = "https://music-dl.sayqz.com/api/";
const SUYIN_QQ_API = "https://oiapi.net/api/QQ_Music";
const SUYIN_QQ_KEY = "oiapi-ef6133b7-ac2f-dc7d-878c-d3e207a82575";
const SUYIN_163_API = "https://oiapi.net/api/Music_163";
const SUYIN_KUWO_API = "https://oiapi.net/api/Kuwo";
const SUYIN_MIGU_API = "https://api.xcvts.cn/api/music/migu";

// Huibq / 聆川 API（需自行配置有效地址与密钥）
const HUIBQ_API = "https://api.huibq.com/api";           // 请替换为实际地址
const HUIBQ_REQUEST_KEY = "your_key_here";               // 请替换为实际密钥
const LINGCHUAN_API = "https://api.lingchuan.com/v1";    // 请替换为实际地址

// 长青SVIP URL模板
const CHANGQING_URL_TEMPLATES = {
  tx: "http://175.27.166.236/kgqq/qq.php?type=mp3&id={id}&level={level}",
  wy: "http://175.27.166.236/wy/wy.php?type=mp3&id={id}&level={level}",
  kw: "https://musicapi.haitangw.net/music/kw.php?type=mp3&id={id}&level={level}",
  kg: "https://music.haitangw.cc/kgqq/kg.php?type=mp3&id={id}&level={level}",
  mg: "https://music.haitangw.cc/musicapi/mg.php?type=mp3&id={id}&level={level}"
};

// 念心SVIP URL模板
const NIANXIN_URL_TEMPLATES = {
  tx: "https://music.nxinxz.com/kgqq/tx.php?id={id}&level={level}&type=mp3",
  wy: "http://music.nxinxz.com/wy.php?id={id}&level={level}&type=mp3",
  kw: "http://music.nxinxz.com/kw.php?id={id}&level={level}&type=mp3",
  kg: "https://music.nxinxz.com/kgqq/kg.php?id={id}&level={level}&type=mp3",
  mg: "http://music.nxinxz.com/mg.php?id={id}&level={level}&type=mp3"
};

// 汽水VIP
const QISHUI_SOURCE_ID = "qsvip";
const QISHUI_SOURCE_NAME = "汽水VIP";
const QISHUI_API_HTTPS = "https://api.vsaa.cn/api/music.qishui.vip";
const QISHUI_API_HTTP = "http://api.vsaa.cn/api/music.qishui.vip";
const QISHUI_PROXY_API = "https://proxy.qishui.vsaa.cn/qishui/proxy";

// 各平台支持的音质列表
const PLATFORM_QUALITIES = {
  wy: ["24bit", "flac", "320k", "192k", "128k"],
  tx: ["24bit", "flac", "320k", "192k", "128k"],
  kw: ["24bit", "flac", "320k", "192k", "128k"],
  kg: ["24bit", "flac", "320k", "192k", "128k"],
  mg: ["24bit", "flac", "320k", "192k", "128k"]
};

// 平台ID映射到星海主API名称
const PLATFORM_TO_XINGHAI = {
  wy: "netease",
  tx: "tencent",
  kw: "kuwo",
  kg: "kugou",
  mg: "migu"
};

// 音质到星海主API码率参数
const QUALITY_TO_BR = {
  "128k": "128",
  "192k": "192",
  "320k": "320",
  flac: "740",
  flac24bit: "999",
  "24bit": "999"
};

// 平台ID映射到星海备API名称
const PLATFORM_TO_XINGHAI_BACKUP = {
  wy: "netease",
  tx: "qq",
  kw: "kuwo"
};

// 音质到溯音QQ码率参数
const QUALITY_TO_SUYIN_QQ_BR = {
  "128k": 7,
  "320k": 5,
  flac: 4,
  hires: 3,
  atmos: 2,
  master: 1,
  "24bit": 1
};

// 音质到溯音酷我码率参数
const QUALITY_TO_KUWO_BR = {
  flac: 1,
  "320k": 5,
  "128k": 7,
  "24bit": 1
};

// 高品质音质集合
const HIRES_QUALITY_SET = new Set(["24bit", "flac", "flac24bit", "hires", "master", "atmos"]);

// 音质优先级（用于选择最接近请求质量的可用音质）
const QUALITY_PRIORITY = ["flac24bit", "flac", "320k", "192k", "128k"];

// URL缓存（简单的Map，按写入顺序淘汰最早条目）
const urlCache = new Map();

const { EVENT_NAMES, request, on, send } = globalThis.lx;

// --- 辅助函数 ---

/**
 * 发起HTTP请求，返回 Promise<{statusCode, headers, body}>
 */
function httpRequest(url, options = { method: "GET" }) {
  return new Promise((resolve, reject) => {
    request(url, { timeout: 2000, ...options }, (err, res) => {
      if (err) return reject(new Error(`请求错误: ${err.message}`));
      let body = res?.body;
      if (typeof body === "string") {
        const trimmed = body.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')) {
          try {
            body = JSON.parse(trimmed);
          } catch (e) { /* 保持原始字符串 */ }
        }
      }
      resolve({
        statusCode: res?.statusCode ?? 0,
        headers: res?.headers || {},
        body
      });
    });
  });
}

/**
 * GET请求，自动拼接查询参数，返回响应body（已解析）
 */
async function httpGet(url, params = {}) {
  const queryStr = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const fullUrl = url + (queryStr ? (url.includes("?") ? "&" : "?") + queryStr : "");
  const res = await httpRequest(fullUrl, { method: "GET", timeout: 2000 });
  if (res.statusCode >= 400) throw new Error(`HTTP错误: ${res.statusCode}`);
  return res.body;
}

/**
 * POST请求，body为JSON，返回响应body
 */
async function httpPost(url, body = {}, timeout = 5000) {
  const res = await httpRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    timeout
  });
  if (res.statusCode >= 400) throw new Error(`HTTP错误: ${res.statusCode}`);
  return res.body;
}

/**
 * 带fallback的GET请求（汽水VIP自动尝试https/http）
 */
async function httpGetWithFallback(url, params = {}, timeout = 5000) {
  const urls = url === QISHUI_API_HTTPS ? [QISHUI_API_HTTPS, QISHUI_API_HTTP] : [url];
  let lastError = null;
  for (const u of urls) {
    try {
      const fullUrl = u + buildQueryString(params);
      const res = await httpRequest(fullUrl, { method: "GET", timeout });
      if (res.statusCode >= 400) throw new Error(`HTTP ${res.statusCode}`);
      return res.body;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("汽水VIP请求失败");
}

/**
 * 构建查询字符串（不带问号，仅参数部分）
 */
function buildQueryString(params = {}) {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? "?" + parts.join("&") : "";
}

/**
 * 标准化音质字符串（低/标准/无损）
 */
function normalizeQuality(quality) {
  const q = String(quality || "").toLowerCase();
  if (q === "128k") return "low";
  if (q === "320k") return "standard";
  if (q === "flac" || q === "flac24bit") return "lossless";
  return "128k";
}

/**
 * 从支持的音质列表中选择最接近请求音质的实际可用音质
 */
function selectQuality(requestedQuality, supportedQualities) {
  const requested = String(requestedQuality || "128k").toLowerCase();
  if (supportedQualities.includes(requested)) return requested;
  const idx = QUALITY_PRIORITY.indexOf(requested);
  const start = idx >= 0 ? idx : QUALITY_PRIORITY.length - 1;
  for (let i = start; i < QUALITY_PRIORITY.length; i++) {
    if (supportedQualities.includes(QUALITY_PRIORITY[i])) return QUALITY_PRIORITY[i];
  }
  for (let i = QUALITY_PRIORITY.length - 1; i >= 0; i--) {
    if (supportedQualities.includes(QUALITY_PRIORITY[i])) return QUALITY_PRIORITY[i];
  }
  return supportedQualities[0] || "128k";
}

/**
 * 将音质转换为网易云/长青/念心所需的level格式
 */
function qualityToNetease(quality) {
  const q = String(quality || "128k").toLowerCase();
  if (q === "flac" || q === "flac24bit" || q === "hires" || q === "master" || q === "atmos") return "lossless";
  if (q === "320k" || q === "192k") return "exhigh";
  return "standard";
}

/**
 * 将音质转换为溯音QQ码率参数
 */
function qualityToSuyinQQ(quality) {
  const q = String(quality || "128k").toLowerCase();
  if (q === "flac24bit") return "hires";
  if (q === "192k") return "320k";
  return QUALITY_TO_SUYIN_QQ_BR[q] ? q : "128k";
}

/**
 * 获取移动端User-Agent
 */
function getMobileUserAgent() {
  return "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
}

/**
 * 从歌曲信息中提取各种可能的ID
 */
function getSongId(songInfo) {
  return (songInfo?.id || songInfo?.songmid || songInfo?.songId || songInfo?.hash || songInfo?.rid || songInfo?.mid || songInfo?.strMediaMid || songInfo?.mediaId || "").toString();
}

/**
 * 获取歌曲的hash或mid（优先hash）
 */
function getHashOrMid(songInfo) {
  return songInfo?.hash ?? songInfo?.songmid ?? songInfo?.id ?? null;
}

/**
 * 获取QQ音乐歌曲ID（区分mid和songid）
 */
function getQQSongId(songInfo) {
  const mid = songInfo?.meta?.qq?.mid || songInfo?.meta?.mid || songInfo?.songmid ||
    (typeof songInfo?.id === "string" && !/^\d+$/.test(songInfo.id) ? songInfo.id : null);
  if (mid) return { type: "mid", value: mid };
  const songid = songInfo?.meta?.qq?.songid || songInfo?.meta?.songid ||
    (typeof songInfo?.id === "number" ? songInfo.id :
      (typeof songInfo?.id === "string" && /^\d+$/.test(songInfo.id) ? Number(songInfo.id) : null));
  if (songid) return { type: "songid", value: songid };
  return null;
}

/**
 * 标准化歌曲信息（供汽水VIP搜索使用）
 */
function normalizeSongInfo(raw) {
  const id = raw?.id || raw?.vid ? String(raw.id || raw.vid) : "";
  return {
    id,
    songmid: id,
    hash: id,
    name: raw?.name ? String(raw.name) : "未知歌曲",
    singer: raw?.artists ? String(raw.artists) : "未知歌手",
    albumName: raw?.album ? String(raw.album) : "",
    duration: raw?.duration ? Math.floor(Number(raw.duration) / 1000) : 0,
    pic: raw?.cover || raw?.pic ? String(raw.cover || raw.pic) : "",
    _raw: raw || {}
  };
}

/**
 * 获取响应数据中的第一条记录
 */
function getFirstData(response) {
  const data = response?.data;
  if (Array.isArray(data)) return data[0] || null;
  if (data && typeof data === "object" && data[0]) return data[0];
  return null;
}

/**
 * 标准化关键词（去除括号、空格、特殊字符，转小写）
 */
function normalizeKeyword(keyword) {
  if (!keyword) return "";
  return String(keyword)
    .replace(/\(\s*Live\s*\)/gi, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, "")
    .replace(/[^\w\u4e00-\u9fa5]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * 标题模糊匹配（双向包含）
 */
function titleMatch(a, b) {
  const na = normalizeKeyword(a);
  const nb = normalizeKeyword(b);
  if (!na || !nb) return true;
  return na.includes(nb) || nb.includes(na);
}

/**
 * 构建搜索关键词列表（标题+专辑、标题+歌手、仅标题）
 */
function buildSearchKeywords(songInfo) {
  const keywords = [];
  const name = songInfo?.name || "";
  const album = songInfo?.albumName || songInfo?.album || "";
  const singer = songInfo?.singer || "";
  if (name && album) {
    const kw = normalizeKeyword(name + album);
    if (kw) keywords.push({ keyword: kw, strict: true });
  }
  if (name && singer) {
    const kw = normalizeKeyword(name + singer);
    if (kw) keywords.push({ keyword: kw, strict: true });
  }
  if (name) {
    const kw = normalizeKeyword(name);
    if (kw) keywords.push({ keyword: kw, strict: false });
  }
  return keywords;
}

/**
 * 歌曲信息匹配（用于溯音酷我）
 */
function songInfoMatch(responseData, songInfo) {
  const song = responseData?.song || responseData?.data?.song || "";
  const singer = responseData?.singer || responseData?.data?.singer || "";
  const album = responseData?.album || responseData?.data?.album || "";
  if (!titleMatch(song, songInfo?.name || "")) return false;
  if (songInfo?.singer && singer && !titleMatch(singer, songInfo.singer)) return false;
  if ((songInfo?.albumName || songInfo?.album) && album && !titleMatch(album, songInfo.albumName || songInfo.album)) return false;
  return true;
}

/**
 * 歌曲标题匹配（用于溯音咪咕）
 */
function songTitleMatch(responseData, songInfo) {
  if (!titleMatch(responseData?.title || "", songInfo?.name || "")) return false;
  if (songInfo?.singer && responseData?.artist && !titleMatch(responseData.artist, songInfo.singer)) return false;
  if ((songInfo?.albumName || songInfo?.album) && responseData?.album && !titleMatch(responseData.album, songInfo.albumName || songInfo.album)) return false;
  return true;
}

/**
 * 从消息文本中解析歌曲信息（歌名/歌手/专辑）
 */
function parseMessageSongInfo(message) {
  if (!message) return null;
  const result = {};
  const lines = String(message).split("\n");
  for (const line of lines) {
    if (line.startsWith("歌名：")) result.song = line.replace("歌名：", "").trim();
    if (line.startsWith("歌手：")) result.singer = line.replace("歌手：", "").trim();
    if (line.startsWith("专辑：")) result.album = line.replace("专辑：", "").trim();
  }
  return result.song ? result : null;
}

/**
 * 验证URL合法性
 */
function validateUrl(url, sourceName) {
  if (!url || typeof url !== "string") throw new Error(`${sourceName}返回空URL`);
  if (!HTTP_URL_REGEX.test(url.trim())) throw new Error(`${sourceName}非法URL格式`);
  return url;
}

// --- 缓存相关 ---
function buildCacheKey(prefix, songInfo, quality = "") {
  const name = songInfo?.name || "";
  const singer = songInfo?.singer || "";
  const album = songInfo?.albumName || songInfo?.album || "";
  // 简单拼接，Map大小有限，无需哈希
  return `${prefix}_${name}_${singer}_${album}_${quality}`;
}

function getCachedUrl(cacheKey) {
  const entry = urlCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.timestamp >= CACHE_TTL_MS) {
    urlCache.delete(cacheKey);
    return null;
  }
  return entry.url;
}

function setCachedUrl(cacheKey, url) {
  urlCache.set(cacheKey, { url, timestamp: Date.now() });
  if (urlCache.size > CACHE_MAX_SIZE) {
    const oldestKey = urlCache.keys().next().value;
    if (oldestKey !== undefined) urlCache.delete(oldestKey);
  }
}

// --- 各音源获取URL的具体实现 ---

/* 星海主 */
async function xinghaiMainGetUrl(platform, songId, quality, songInfo) {
  const source = PLATFORM_TO_XINGHAI[platform];
  if (!source) throw new Error("星海主API不支持该平台");
  const id = songId ?? getHashOrMid(songInfo);
  if (!id) throw new Error("缺少songId");
  const selectedQuality = selectQuality(quality, ["128k", "192k", "320k", "flac", "flac24bit"]);
  const br = QUALITY_TO_BR[selectedQuality];
  if (!br) throw new Error("星海主API音质映射失败");
  const url = `${XINGHAI_MAIN_API}&types=url&source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}&br=${br}`;
  const res = await httpRequest(url, { method: "GET", headers: { "User-Agent": "LX-Music-Mobile", Accept: "application/json" } });
  const body = res.body;
  if (!body || typeof body !== "object" || !body.url) throw new Error(body?.message || "星海主API未返回可用URL");
  return body.url;
}

/* 星海备 */
async function xinghaiBackupGetUrl(platform, songId, quality, songInfo) {
  const source = PLATFORM_TO_XINGHAI_BACKUP[platform];
  if (!source) throw new Error("星海备API不支持该平台");
  const id = songId ?? getHashOrMid(songInfo);
  if (!id) throw new Error("缺少songId");
  const selectedQuality = selectQuality(quality, ["128k", "192k", "320k", "flac", "flac24bit"]);
  return `${XINGHAI_BACKUP_API}?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}&type=url&br=${encodeURIComponent(selectedQuality)}`;
}

/* Huibq */
async function huibqGetUrl(platform, songId, quality, songInfo) {
  if (!HUIBQ_API || !HUIBQ_REQUEST_KEY) throw new Error("Huibq未配置");
  const hashOrMid = songInfo?.hash ?? songInfo?.songmid;
  if (!hashOrMid) throw new Error("Huibq缺少hash/songmid");
  const selectedQuality = selectQuality(quality, ["320k", "128k"]);
  const url = `${HUIBQ_API}/url/${platform}/${encodeURIComponent(hashOrMid)}/${encodeURIComponent(selectedQuality)}`;
  const res = await httpRequest(url, {
    method: "GET",
    headers: { "Content-Type": "application/json", "User-Agent": getMobileUserAgent(), "X-Request-Key": HUIBQ_REQUEST_KEY }
  });
  const body = res.body;
  if (!body || typeof body !== "object" || Number.isNaN(Number(body.code))) throw new Error("Huibq返回无效");
  switch (Number(body.code)) {
    case 0:
      if (!body.url) throw new Error("Huibq返回空URL");
      return body.url;
    case 1: throw new Error("Huibq block ip");
    case 2: throw new Error("Huibq get music url failed");
    case 4: throw new Error("Huibq too many requests");
    case 5: throw new Error("Huibq param error");
    case 6: throw new Error("Huibq internal server error");
    default: throw new Error(body.message || "Huibq unknown error");
  }
}

/* 聆川 */
async function lingchuanGetUrl(platform, songId, quality, songInfo) {
  if (!LINGCHUAN_API) throw new Error("聆川未配置");
  const hashOrMid = songInfo?.hash ?? songInfo?.songmid;
  if (!hashOrMid) throw new Error("聆川缺少hash/songmid");
  const selectedQuality = selectQuality(quality, ["320k", "128k"]);
  const url = `${LINGCHUAN_API}/url?source=${encodeURIComponent(platform)}&songId=${encodeURIComponent(hashOrMid)}&quality=${encodeURIComponent(selectedQuality)}`;
  const res = await httpRequest(url, {
    method: "GET",
    headers: { "Content-Type": "application/json", "User-Agent": getMobileUserAgent() },
    follow_max: 5
  });
  const body = res.body;
  if (!body || typeof body !== "object" || Number.isNaN(Number(body.code))) throw new Error("聆川返回无效");
  switch (Number(body.code)) {
    case 200:
      if (!body.url) throw new Error("聆川返回空URL");
      return body.url;
    case 403: throw new Error("聆川403 forbidden");
    case 429: throw new Error("聆川429 rate limit");
    case 500: throw new Error(`聆川500 ${body.message || "server error"}`);
    default: throw new Error(body.message || "聆川未知错误");
  }
}

/* 溯音QQ */
async function suyinQQGetUrl(songInfo, quality) {
  const qqId = getQQSongId(songInfo);
  if (!qqId) throw new Error("溯音QQ缺少songmid/id");
  const normalizedQuality = qualityToSuyinQQ(quality);
  const startBr = QUALITY_TO_SUYIN_QQ_BR[normalizedQuality] || QUALITY_TO_SUYIN_QQ_BR["128k"];
  const brList = [startBr, 4, 5, 7]
    .filter((val, idx, arr) => arr.indexOf(val) === idx && val >= startBr)
    .sort((a, b) => a - b);
  let lastError = null;
  for (const br of brList) {
    try {
      const reqParams = { key: SUYIN_QQ_KEY, type: "json", br, n: 1 };
      if (qqId.type === "mid") reqParams.mid = qqId.value;
      else reqParams.songid = qqId.value;
      const res = await httpGet(SUYIN_QQ_API, reqParams);
      if (res?.music) return res.music;
      if (res?.url) return res.url;
      if (res?.message) {
        const match = String(res.message).match(/音频链接[：:](.+?)(?:\n|$)/);
        if (match && match[1]) return match[1].trim();
      }
      throw new Error("溯音QQ未找到音频链接");
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`溯音QQ全部音质尝试失败: ${lastError?.message || "unknown"}`);
}

/* 溯音163 */
async function suyin163GetUrl(songInfo) {
  const id = songInfo?.songmid || songInfo?.id;
  if (!id) throw new Error("溯音163缺少songmid/id");
  const res = await httpGet(SUYIN_163_API, { id });
  if (res?.code === 0 && res?.data) {
    const item = Array.isArray(res.data) ? res.data[0] : res.data;
    if (item?.url) return item.url;
  }
  throw new Error("溯音163获取失败");
}

/* 溯音酷我（搜索） */
async function suyinKuwoSearch(keyword, br, songInfo = null) {
  const res = await httpGet(SUYIN_KUWO_API, { msg: keyword, n: 1, br });
  if (res?.data?.url) {
    if (songInfo && !songInfoMatch(res, songInfo)) throw new Error("溯音酷我歌曲信息不匹配");
    return res.data.url;
  }
  if (res?.message) {
    const match = String(res.message).match(/音乐链接[：:](\S+)/);
    if (match && match[1]) {
      if (songInfo) {
        const parsed = parseMessageSongInfo(res.message);
        if (parsed && !songInfoMatch(parsed, songInfo)) throw new Error("溯音酷我歌曲信息不匹配");
      }
      return match[1];
    }
  }
  throw new Error("溯音酷我未找到链接");
}

async function suyinKuwoGetUrl(songInfo, quality) {
  if (!songInfo?.name) throw new Error("溯音酷我需要歌曲名");
  const cacheKey = buildCacheKey("kw", songInfo, quality);
  const cached = getCachedUrl(cacheKey);
  if (cached) return cached;
  const selectedQuality = selectQuality(quality, ["flac", "320k", "128k"]);
  const br = QUALITY_TO_KUWO_BR[selectedQuality] || 1;
  const keywords = buildSearchKeywords(songInfo);
  let lastError = null;
  for (const item of keywords) {
    try {
      const url = await suyinKuwoSearch(item.keyword, br, item.strict ? songInfo : null);
      if (url) {
        setCachedUrl(cacheKey, url);
        return url;
      }
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`溯音酷我失败: ${lastError?.message || "unknown"}`);
}

/* 溯音咪咕 */
async function suyinMiguGetUrl(songInfo) {
  if (!songInfo?.name) throw new Error("溯音咪咕需要歌曲名");
  const cacheKey = buildCacheKey("mg", songInfo);
  const cached = getCachedUrl(cacheKey);
  if (cached) return cached;
  const keywords = buildSearchKeywords(songInfo);
  let lastError = null;
  for (const item of keywords) {
    try {
      const res = await httpGet(SUYIN_MIGU_API, { gm: item.keyword, n: 1, num: 1, type: "json" });
      if (res?.code === 200 && res?.musicInfo) {
        if (item.strict && !songTitleMatch(res, songInfo)) throw new Error("溯音咪咕歌曲信息不匹配");
        setCachedUrl(cacheKey, res.musicInfo);
        return res.musicInfo;
      }
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`溯音咪咕失败: ${lastError?.message || "unknown"}`);
}

/* 溯音统一入口 */
async function suyinGetUrl(platform, songId, quality, songInfo) {
  switch (platform) {
    case "tx": return suyinQQGetUrl(songInfo, quality);
    case "wy": return suyin163GetUrl(songInfo);
    case "kw": return suyinKuwoGetUrl(songInfo, quality);
    case "mg": return suyinMiguGetUrl(songInfo);
    default: throw new Error("溯音不支持该平台");
  }
}

/* 长青SVIP */
async function changqingGetUrl(platform, songId, quality, songInfo) {
  const template = CHANGQING_URL_TEMPLATES[platform];
  if (!template) throw new Error("长青SVIP不支持该平台");
  const id = getPlatformSongId(platform, songInfo);
  if (!id) throw new Error("长青SVIP缺少songId");
  const level = qualityToNetease(quality);
  return template.replace("{id}", encodeURIComponent(String(id))).replace("{level}", encodeURIComponent(level));
}

/* 念心SVIP */
async function nianxinGetUrl(platform, songId, quality, songInfo) {
  const template = NIANXIN_URL_TEMPLATES[platform];
  if (!template) throw new Error("念心SVIP不支持该平台");
  const id = getPlatformSongId(platform, songInfo);
  if (!id) throw new Error("念心SVIP缺少songId");
  const level = qualityToNetease(quality);
  return template.replace("{id}", encodeURIComponent(String(id))).replace("{level}", encodeURIComponent(level));
}

/* 汽水VIP */
async function qishuiSearch(keyword, page = 1, pageSize = 30) {
  if (!keyword) return { isEnd: true, list: [] };
  const res = await httpGetWithFallback(QISHUI_API_HTTPS, {
    act: "search", keywords: keyword, page, pagesize: pageSize, type: "music"
  }, 15000);
  const list = Array.isArray(res?.data?.lists) ? res.data.lists : [];
  const total = res?.data?.total ? Number(res.data.total) : list.length;
  return {
    isEnd: list.length < pageSize,
    list: list.map(normalizeSongInfo),
    total
  };
}

async function qishuiGetUrl(songInfo, quality) {
  const songId = getSongId(songInfo);
  if (!songId) throw new Error("汽水VIP缺少歌曲ID");
  const res = await httpGetWithFallback(QISHUI_API_HTTPS, {
    act: "song", id: songId, quality: normalizeQuality(quality)
  }, 20000);
  const data = getFirstData(res);
  if (!data?.url) throw new Error("汽水VIP未返回可用URL");
  if (data.ekey) {
    const proxyRes = await httpPost(QISHUI_PROXY_API, {
      url: data.url, key: data.ekey, filename: data.filename || "KMusic", ext: data.fileExtension || "aac"
    }, 60000);
    if (Number(proxyRes?.code) === 200 && proxyRes?.url) return String(proxyRes.url);
    throw new Error("汽水VIP代理解密失败");
  }
  return String(data.url);
}

async function qishuiGetLyric(songInfo) {
  const songId = getSongId(songInfo);
  if (!songId) return { lyric: "" };
  const res = await httpGetWithFallback(QISHUI_API_HTTPS, { act: "song", id: songId }, 15000);
  const data = getFirstData(res);
  return { lyric: data?.lyric ? String(data.lyric) : "" };
}

async function qishuiHandler(action, params = {}) {
  if (action === "musicSearch" || action === "search") {
    const keyword = params?.keyword ? String(params.keyword) : "";
    const page = params?.page ? Number(params.page) : 1;
    const pageSize = params?.pagesize ? Number(params.pagesize) : 30;
    return qishuiSearch(keyword, page, pageSize);
  }
  if (action === "musicUrl") {
    if (!params?.musicInfo) throw new Error("请求参数不完整");
    const url = await qishuiGetUrl(params.musicInfo, params.type);
    return validateUrl(url, "汽水VIP");
  }
  if (action === "lyric") return qishuiGetLyric(params?.musicInfo || {});
  throw new Error("action not support");
}

// --- 工具函数：获取平台对应的歌曲ID ---
function getPlatformSongId(platform, songInfo) {
  if (platform === "kg") return songInfo?.hash || songInfo?.songmid || songInfo?.id || songInfo?.rid || songInfo?.mid || null;
  if (platform === "tx") {
    const qqId = getQQSongId(songInfo);
    if (qqId?.value) return qqId.value;
  }
  return songInfo?.songmid || songInfo?.id || songInfo?.songId || songInfo?.rid || songInfo?.hash || null;
}

// --- 音源处理器注册表 ---
const SOURCE_HANDLERS = {
  xinghai: { name: "星海主", fn: xinghaiMainGetUrl },
  xinghaiBackup: { name: "星海备", fn: xinghaiBackupGetUrl },
  huibq: { name: "Huibq", fn: huibqGetUrl },
  lingchuan: { name: "聆川", fn: lingchuanGetUrl },
  suyinQQ: { name: "溯音QQ", fn: (platform, songId, quality, songInfo) => suyinGetUrl("tx", songId, quality, songInfo) },
  suyin163: { name: "溯音163", fn: (platform, songId, quality, songInfo) => suyinGetUrl("wy", songId, quality, songInfo) },
  suyinSearch: { name: "溯音搜索", fn: (platform, songId, quality, songInfo) => suyinGetUrl("kw", songId, quality, songInfo) },
  suyinMigu: { name: "溯音咪咕", fn: (platform, songId, quality, songInfo) => suyinGetUrl("mg", songId, quality, songInfo) },
  changqingVip: { name: "长青SVIP", fn: changqingGetUrl },
  nianxinVip: { name: "念心SVIP", fn: nianxinGetUrl }
};

// --- 构建音源链（按平台和是否高品质排序）---
function buildSourceChain(platform, isHires, quality) {
  const chain = [];
  // 基础链：星海主、Huibq、溯音各平台、聆川、长青、念心
  if (SOURCE_HANDLERS.xinghai) chain.push(SOURCE_HANDLERS.xinghai);
  if (SOURCE_HANDLERS.huibq) chain.push(SOURCE_HANDLERS.huibq);
  if (platform === "wy" && SOURCE_HANDLERS.suyin163) chain.push(SOURCE_HANDLERS.suyin163);
  if (platform === "tx" && SOURCE_HANDLERS.suyinQQ) chain.push(SOURCE_HANDLERS.suyinQQ);
  if (platform === "kw" && SOURCE_HANDLERS.suyinSearch) chain.push(SOURCE_HANDLERS.suyinSearch);
  if (platform === "mg" && SOURCE_HANDLERS.suyinMigu) chain.push(SOURCE_HANDLERS.suyinMigu);
  if (SOURCE_HANDLERS.lingchuan) chain.push(SOURCE_HANDLERS.lingchuan);
  if (SOURCE_HANDLERS.changqingVip) chain.push(SOURCE_HANDLERS.changqingVip);
  if (SOURCE_HANDLERS.nianxinVip) chain.push(SOURCE_HANDLERS.nianxinVip);
  return chain;
}

// --- 带fallback获取URL（并发前3个，失败后顺序剩余）---
async function getUrlWithFallback(platform, songInfo, quality) {
  if (!platform || typeof platform !== "string" || !PLATFORM_QUALITIES[platform]) {
    throw new Error("无效的平台参数");
  }
  if (!songInfo || typeof songInfo !== "object") {
    throw new Error("无效的歌曲信息");
  }
  const resolvedQuality = quality || "128k";
  const selectedQuality = selectQuality(resolvedQuality, PLATFORM_QUALITIES[platform]);
  const songId = getHashOrMid(songInfo);
  const isHires = HIRES_QUALITY_SET.has(resolvedQuality.toLowerCase());
  const chain = buildSourceChain(platform, isHires, selectedQuality);
  if (!chain.length) throw new Error("未找到可用fallback链");

  const errors = [];
  // 并发尝试前3个源
  const firstBatch = chain.slice(0, 3);
  if (firstBatch.length) {
    const results = await Promise.allSettled(firstBatch.map(handler =>
      handler.fn(platform, songId, selectedQuality, songInfo).then(url => validateUrl(url, handler.name))
    ));
    for (const result of results) {
      if (result.status === "fulfilled") return result.value;
      errors.push(result.reason?.message || "unknown");
    }
  }
  // 顺序尝试剩余源
  for (const handler of chain.slice(3)) {
    try {
      const url = await handler.fn(platform, songId, selectedQuality, songInfo);
      return validateUrl(url, handler.name);
    } catch (e) {
      errors.push(`${handler.name}: ${e.message}`);
    }
  }
  throw new Error(`所有源均失败: ${errors.join("; ")}`);
}

// --- 音源配置与注册 ---
const sourceConfig = {};
const PLATFORM_NAMES = {
  wy: "网易云音乐", tx: "QQ音乐", kw: "酷我音乐", kg: "酷狗音乐", mg: "咪咕音乐"
};
Object.keys(PLATFORM_QUALITIES).forEach(platform => {
  sourceConfig[platform] = {
    name: PLATFORM_NAMES[platform],
    type: "music",
    actions: ["musicUrl"],
    qualitys: PLATFORM_QUALITIES[platform]
  };
});
sourceConfig[QISHUI_SOURCE_ID] = {
  name: QISHUI_SOURCE_NAME,
  type: "music",
  actions: ["musicSearch", "musicUrl", "lyric"],
  qualitys: ["128k", "320k", "flac", "flac24bit"]
};

// --- 事件监听 ---
on(EVENT_NAMES.request, ({ action, source, info }) => {
  if (source === QISHUI_SOURCE_ID) {
    return qishuiHandler(action, info);
  }
  if (action !== "musicUrl") {
    return Promise.reject(new Error("action not support"));
  }
  if (!info?.musicInfo) {
    return Promise.reject(new Error("请求参数不完整"));
  }
  return getUrlWithFallback(source, info.musicInfo, info.type || "128k")
    .then(url => Promise.resolve(url))
    .catch(err => Promise.reject(err));
});

send(EVENT_NAMES.inited, {
  openDevTools: false,
  sources: sourceConfig
});

// 简单日志，供调试
console.log("全豆要聚合音源 v9.3 已加载");