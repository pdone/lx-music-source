/*!
 * @name 星澜聚合音源 (StellarWave)
 * @description 星澜 v4.0.2 与墨澜 v2.3.6 融合版：落月 QQ 主线路 + 云记（海堂）/HYWmusic/星海/念心等备用后端，支持母带/全景声/汽水音乐
 * @version v4.0.2
 * @author 星澜团队
 * @homepage https://github.com/your-repo/StellarWave
 * @license MIT
 * @update 2026-11-06
 * @changelog
 *   - v4.0.2 (2026-11-06)
 *     · QQ 音乐主线路改为「落月」API（api.vkeys.cn），v2 geturl 失败自动降级到 v3 song/link
 *     · 落月音质映射：6=128k 8=320k 10=flac 11=hires 13=atmos 16=atmos_plus 14=master
 *     · 修复 HYWmusic 后端：卡密 6C1F-53W0-GRKI-EVFG，完整 musicInfo 参数（对齐 HYWmusic v1.2.0）
 *     · QQ / 酷狗后端池 HYWmusic 提升到可用位置
 *     · QQ 官方后端从 Cookie 提取真实 uin，检测试听片段（freeTrialInfo / RS0），避免只播放几秒
 *     · 各平台 HYWmusic 后端统一 getHYWMusicUrl 实现，按平台做音质降级映射
 *     · 白姬KG 卡密同步更新为 6C1F-53W0-GRKI-EVFG
 *   - v4.0.1 (2026-11-05) 修复与合并版本
 *     · 融合墨澜 v2.3.5：QQ / 咪咕 / 酷狗采用云记（海堂）resolve-url 为主线路
 *     · 新增汽水音乐 (qs) 音源（星海汽水双线路）
 *     · 咪咕：云记主线路 + 音质路径改写与降级探测
 *     · 网易云官方 enhance/player/url/v1：ids 改为 "[id]" 字符串，immerseType 仅 sky 携带
 *     · QQ 官方文件前缀：臻品母带 AI00、臻品音质 Q000、全景声 Q001/Q003
 *     · 移除 QQ 越权后端；URL 缓存 20 分钟；并发合并；滑动窗口限流
 *     · 请求 body 统一序列化为 JSON，全部请求增加超时兜底
 *     · 酷我：高音质走流媒体直链，普通音质跳过流媒体直链
 */

const { EVENT_NAMES, request, on, send, utils, env, version, currentScriptInfo } = globalThis.lx

// ==================== URL 解码函数 ====================
const _u = (str) => str.split('').map(c => String.fromCharCode(c.charCodeAt(0) + 5)).join('');

// ==================== 解析头部注解（支持 Cookie） ====================
const currentScript = currentScriptInfo
  ? currentScriptInfo.rawScript
  : (typeof document !== 'undefined' ? document.currentScript?.textContent || '' : '')

const parseHeader = (str) => {
  const comment = /^\/\*!(?:.|\n)+?\*\//.exec(str)?.[0]
  if (!comment) return {}
  const result = {}
  const pairs = [
    { key: 'tx_cookie', regex: /\*\s*@tx_cookie\s+(.+)/ },
    { key: 'wy_cookie', regex: /\*\s*@wy_cookie\s+(.+)/ },
  ]
  for (const { key, regex } of pairs) {
    const match = regex.exec(comment)
    const val = match?.[1]?.trim()
    result[key] = (!val || val === 'null') ? '' : val
  }
  return result
}

const config = parseHeader(currentScript)
const TX_COOKIE = config.tx_cookie
const WY_COOKIE = config.wy_cookie
const HAS_TX_COOKIE = !!TX_COOKIE
const HAS_WY_COOKIE = !!WY_COOKIE

// ==================== 音质列表（每平台独立） ====================
const MUSIC_QUALITY = {
  tx: ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'atmos_plus', 'master'],
  wy: HAS_WY_COOKIE
    ? ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'master']
    : ['128k', '320k', 'flac'],
  kw: ['128k', '192k', '320k', 'flac', 'flac24bit'],
  kg: ['128k', '320k', 'flac', 'hires', 'atmos', 'master'],
  mg: ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'master'],
  qs: ['128k', '320k', 'flac', 'spatial', 'hires'],
}

const MUSIC_SOURCE = Object.keys(MUSIC_QUALITY)

// ==================== 工具函数 ====================
const isBufferLike = (obj) => obj && typeof obj === 'object' && (
  (typeof Buffer !== 'undefined' && typeof Buffer.isBuffer === 'function' && Buffer.isBuffer(obj)) ||
  (typeof obj.constructor === 'function' && obj.constructor.name === 'Buffer')
)

const parseBody = (body) => {
  if (body == null) return body
  const tryJson = (str) => {
    if (typeof str !== 'string') return str
    const trimmed = str.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
      try { return JSON.parse(trimmed) } catch (e) {}
    }
    return str
  }
  if (typeof body === 'string') return tryJson(body)
  if (isBufferLike(body)) {
    try {
      const text = globalThis.lx?.utils?.buffer?.bufToString
        ? globalThis.lx.utils.buffer.bufToString(body, 'utf-8')
        : (typeof Buffer !== 'undefined' ? Buffer.from(body).toString('utf-8') : String(body))
      return tryJson(text)
    } catch (e) {
      return body
    }
  }
  return body
}

const normalizeOptions = (options) => {
  const opts = { ...options }
  if (opts.body != null && typeof opts.body === 'object' && !isBufferLike(opts.body)) {
    opts.body = JSON.stringify(opts.body)
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  }
  return opts
}

const httpFetch = (url, options = { method: 'GET' }) => new Promise((resolve, reject) => {
  const timeout = options.timeout || 15000
  let settled = false
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    reject(new Error('请求超时 ' + timeout + 'ms'))
  }, timeout)
  request(url, { ...normalizeOptions(options), timeout }, (err, resp) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (err) return reject(err)
    resolve({ body: parseBody(resp.body), statusCode: resp.statusCode, headers: resp.headers || {} })
  })
})

const md5 = (str) => utils.crypto.md5(str)

const randomGuid = () => {
  const hex = '0123456789abcdef'
  let guid = ''
  for (let i = 0; i < 32; i++) guid += hex[Math.floor(Math.random() * 16)]
  return guid
}

const aesEncrypt = (data, key, iv, mode) => {
  if (!version) mode = mode.split('-').pop()
  return utils.crypto.aesEncrypt(data, mode, key, iv)
}

const buf2hex = (buffer) => {
  return version
    ? utils.buffer.bufToString(buffer, 'hex')
    : [...new Uint8Array(buffer)].map(x => x.toString(16).padStart(2, '0')).join('')
}

const wyEapi = (url, object) => {
  const eapiKey = 'e82ckenh8dichen8'
  const text = typeof object === 'object' ? JSON.stringify(object) : object
  const digest = md5('nobody' + url + 'use' + text + 'md5forencrypt')
  const data = url + '-36cd479b6b5-' + text + '-36cd479b6b5-' + digest
  return { params: buf2hex(aesEncrypt(data, eapiKey, '', 'aes-128-ecb')).toUpperCase() }
}

const objToForm = (obj) => Object.keys(obj).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k])).join('&')

const extractUrl = (obj, paths) => {
  const candidates = []
  for (const path of paths) {
    let val = obj
    for (const key of path) {
      if (val == null) { val = undefined; break }
      val = val[key]
    }
    if (Array.isArray(val)) candidates.push(...val)
    else if (val != null) candidates.push(val)
  }
  for (const val of candidates) {
    if (typeof val !== 'string') continue
    if (val.startsWith('http://') || val.startsWith('https://')) return val
    if (val.startsWith('//')) return 'https:' + val
  }
  return ''
}

const cleanUrl = (url) => {
  if (!url) return ''
  const s = String(url).replace(/\\?u0026/gi, '&').replace(/\\&/g, '&').replace(/\$/g, '&')
  const idx = s.indexOf('?')
  return idx > 0 ? s.substring(0, idx) : s
}

const qualityToLevel = (quality) => {
  const map = {
    '128k': 'standard', '192k': 'standard', '320k': 'exhigh',
    'flac': 'lossless', 'flac24bit': 'lossless', 'hires': 'lossless',
    'atmos': 'lossless', 'atmos_plus': 'lossless', 'master': 'lossless',
  }
  return map[quality] || 'standard'
}

// ==================== SHA256 工具 ====================
const sha256 = (function () {
  const HEX_CHARS = '0123456789abcdef'.split('');
  function Sha256() {
    this.blocks = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
    this.h0 = 0x6a09e667; this.h1 = 0xbb67ae85; this.h2 = 0x3c6ef372; this.h3 = 0xa54ff53a;
    this.h4 = 0x510e527f; this.h5 = 0x9b05688c; this.h6 = 0x1f83d9ab; this.h7 = 0x5be0cd19;
    this.block = this.start = this.bytes = this.hBytes = 0;
    this.finalized = this.hashed = false; this.first = true;
  }
  Sha256.prototype.update = function (message) {
    if (this.finalized) return;
    const notString = typeof message !== 'string';
    const blocks = this.blocks;
    for (let i = 0; i < message.length; i++) {
      if (this.hashed) {
        this.hashed = false; blocks[0] = this.block;
        blocks[16] = blocks[1] = blocks[2] = blocks[3] = blocks[4] = blocks[5] = blocks[6] = blocks[7] = blocks[8] = blocks[9] = blocks[10] = blocks[11] = blocks[12] = blocks[13] = blocks[14] = blocks[15] = 0;
      }
      const code = notString ? message[i] : message.charCodeAt(i);
      blocks[this.start >> 2] |= code << (24 - (this.start % 4) * 8);
      this.start++;
      if (this.start === 64) {
        this.block = blocks[16]; this.start = 0; this.hash(); this.hashed = true;
      }
    }
    this.bytes += message.length;
    if (this.bytes > 4294967295) { this.hBytes += this.bytes / 4294967296 << 0; this.bytes = this.bytes % 4294967296; }
    return this;
  };
  Sha256.prototype.finalize = function () {
    if (this.finalized) return;
    this.finalized = true;
    const blocks = this.blocks;
    let i = this.start;
    blocks[16] = this.block;
    blocks[i >> 2] |= 0x80 << (24 - (i % 4) * 8);
    this.block = blocks[16];
    if (i >= 56) {
      if (!this.hashed) this.hash();
      blocks[0] = this.block;
      blocks[16] = blocks[1] = blocks[2] = blocks[3] = blocks[4] = blocks[5] = blocks[6] = blocks[7] = blocks[8] = blocks[9] = blocks[10] = blocks[11] = blocks[12] = blocks[13] = blocks[14] = blocks[15] = 0;
    }
    blocks[14] = this.hBytes << 3 | this.bytes >>> 29;
    blocks[15] = this.bytes << 3;
    this.hash();
  };
  Sha256.prototype.hash = function () {
    const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    let a = this.h0, b = this.h1, c = this.h2, d = this.h3, e = this.h4, f = this.h5, g = this.h6, h = this.h7;
    const blocks = this.blocks;
    for (let j = 0; j < 64; j++) {
      if (j >= 16) {
        const w0 = blocks[j - 15], w1 = blocks[j - 2];
        const s0 = ((w0 >>> 7) | (w0 << 25)) ^ ((w0 >>> 18) | (w0 << 14)) ^ (w0 >>> 3);
        const s1 = ((w1 >>> 17) | (w1 << 15)) ^ ((w1 >>> 19) | (w1 << 13)) ^ (w1 >>> 10);
        blocks[j] = blocks[j - 16] + s0 + blocks[j - 7] + s1;
      }
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ ((~e) & g);
      const temp1 = h + S1 + ch + K[j] + (blocks[j] >>> 0);
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = S0 + maj;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    this.h0 = (this.h0 + a) >>> 0; this.h1 = (this.h1 + b) >>> 0;
    this.h2 = (this.h2 + c) >>> 0; this.h3 = (this.h3 + d) >>> 0;
    this.h4 = (this.h4 + e) >>> 0; this.h5 = (this.h5 + f) >>> 0;
    this.h6 = (this.h6 + g) >>> 0; this.h7 = (this.h7 + h) >>> 0;
  };
  Sha256.prototype.hex = function () {
    this.finalize();
    const { h0, h1, h2, h3, h4, h5, h6, h7 } = this;
    return [h0, h1, h2, h3, h4, h5, h6, h7].map(x =>
      HEX_CHARS[(x >> 28) & 0x0F] + HEX_CHARS[(x >> 24) & 0x0F] + HEX_CHARS[(x >> 20) & 0x0F] + HEX_CHARS[(x >> 16) & 0x0F] +
      HEX_CHARS[(x >> 12) & 0x0F] + HEX_CHARS[(x >> 8) & 0x0F] + HEX_CHARS[(x >> 4) & 0x0F] + HEX_CHARS[x & 0x0F]
    ).join('');
  };
  return function (message) { return new Sha256().update(message).hex(); };
})();

const HELLO_WORLD_SECRET_KEY = 'JaJ?a7Nwk_Fgj?2o:znAkst';
const HELLO_WORLD_SCRIPT_MD5 = '1888f9865338afe6d5534b35171c61a4';
const HYW_API_BASE = 'https://103.79.184.97'
const HYW_CARD_KEY = '6C1F-53W0-GRKI-EVFG'

// ==================== HYWmusic 通用参数收集 & 请求（对齐 HYWmusic v1.2.0） ====================

const collectMusicInfoParams = (musicInfo, platform) => {
  if (!musicInfo) return {}
  const params = {}
  const songId = musicInfo.songmid || musicInfo.songId || musicInfo.id || musicInfo.hash
    || musicInfo.rid || musicInfo.musicId || musicInfo.copyrightId || musicInfo.songid || ''
  if (songId) params.songId = songId
  if (musicInfo.songmid) params.songmid = musicInfo.songmid
  if (musicInfo.hash) params.hash = musicInfo.hash

  const fields = ['albumAudioId', 'strMediaMid', 'mediaMid', 'copyrightId', 'rid', 'musicId',
    'albumId', 'albumName', 'albumMid', 'songname', 'songName', 'name', 'singer', 'singers', 'artist']
  for (const f of fields) {
    if (musicInfo[f] !== undefined && musicInfo[f] !== null && musicInfo[f] !== '') params[f] = musicInfo[f]
    if (musicInfo.meta && musicInfo.meta[f] !== undefined && musicInfo.meta[f] !== null && musicInfo.meta[f] !== '') params[f] = musicInfo.meta[f]
  }
  params.platform = platform
  params.source = platform
  return params
}

const HYW_QUALITY_MAP = {
  tx: { '128k': '128k', '320k': '320k', flac: 'flac', flac24bit: 'flac24bit', hires: 'flac24bit', atmos: 'flac24bit', atmos_plus: 'flac24bit', master: 'flac24bit' },
  kg: { '128k': '128k', '320k': '320k', flac: 'flac', flac24bit: 'flac24bit', hires: 'flac24bit', atmos: 'flac24bit', atmos_plus: 'flac24bit', master: 'flac24bit' },
  wy: { '128k': '128k', '320k': '320k', flac: 'flac', flac24bit: 'flac24bit', hires: 'flac24bit', atmos: 'flac24bit', master: 'flac24bit' },
  kw: { '128k': '128k', '320k': '320k', flac: 'flac', flac24bit: 'flac24bit' },
  mg: { '128k': '128k', '320k': '320k' },
}

const getHYWMusicUrl = async (source, songmid, quality, musicInfo) => {
  const params = collectMusicInfoParams(musicInfo, source)
  if (!params.songId && songmid) params.songId = songmid
  if (quality) {
    const map = HYW_QUALITY_MAP[source]
    params.quality = (map && map[quality]) ? map[quality] : quality
  }
  if (HYW_CARD_KEY) params.key = HYW_CARD_KEY

  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => k + '=' + encodeURIComponent(String(v)))
    .join('&')
  const url = HYW_API_BASE + '/api/music/url' + (query ? '?' + query : '')

  const res = await httpFetch(url, {
    method: 'GET', timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  })
  const d = res.body
  if (!d || typeof d !== 'object') throw new Error('HYWmusic: 空响应')
  if (d.code === 200) {
    if (d.url) return d.url
    if (d.data && d.data.url) return d.data.url
    if (typeof d.data === 'string' && d.data.startsWith('http')) return d.data
  }
  if (d.code === 401 || d.code === 403) throw new Error('HYWmusic: 鉴权失败')
  if (d.code === 429) throw new Error('HYWmusic: 请求过速')
  throw new Error('HYWmusic: ' + (d.message || d.msg || ('code=' + d.code)))
}

const extractUinFromCookie = (cookie) => {
  if (!cookie) return '0'
  const match = /(?:^|;\s*)uin=o?(\d+)/.exec(cookie)
  return match ? match[1] : '0'
}

// ==================== 音质映射表 ====================
const TX_FILE_CONFIG = {
  '128k': { s: 'M500', e: '.mp3' }, '320k': { s: 'M800', e: '.mp3' },
  flac: { s: 'F000', e: '.flac' }, flac24bit: { s: 'Q000', e: '.flac' },
  hires: { s: 'Q000', e: '.flac' }, atmos: { s: 'Q001', e: '.flac' },
  atmos_plus: { s: 'Q003', e: '.flac' }, master: { s: 'AI00', e: '.flac' },
}
const WY_LEVEL_MAP = { '128k': 'standard', '320k': 'exhigh', flac: 'lossless', flac24bit: 'hires', hires: 'hires', atmos: 'sky', master: 'jymaster' }
const KW_LEVEL_MAP = { '128k': '128k', '192k': '128k', '320k': '320k', flac: 'lossless', flac24bit: 'lossless' }
const KG_LEVEL_MAP = { '128k': 'standard', '192k': 'standard', '320k': 'exhigh', flac: 'lossless', flac24bit: 'hires', hires: 'hires', atmos: 'atmos', atmos_plus: 'atmos', master: 'clear' }
const KW_STREAM_LEVEL_MAP = { '128k': '128k', '192k': '128k', '320k': '320k', flac: 'flac', flac24bit: 'flac', hires: 'hires', atmos: 'atmos', atmos_plus: 'atmos_plus', master: 'master' }

// 落月 QQ 音质 → 落月 quality 参数
const LUOYUE_TX_QUALITY = {
  '128k': 6,
  '320k': 8,
  flac: 10,
  flac24bit: 10,
  hires: 11,
  atmos: 13,
  atmos_plus: 16,
  master: 14,
}

// ==================== 运行参数（缓存 / 限流） ====================

const CACHE_TTL = 1200000
const CACHE_MAX_ENTRIES = 500
const RATE_LIMIT_MAX = 3
const RATE_LIMIT_WINDOW = 1000
const RATE_LIMIT_MAX_WAIT = 1500
const LOG_DEBUG = false

const DEBUGLog = (...args) => {
  if (LOG_DEBUG) console.log('[星澜-DEBUG]', ...args)
}

// ==================== baimusic QQ 加密工具（备用后端） ====================

const _u8 = (arr) => {
  const bytes = new Uint8Array(arr.length)
  for (let i = 0; i < arr.length; i++) bytes[i] = arr[i]
  return bytes
}

const _utf8Encode = (str) => {
  const bytes = []
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        i++
      }
    }
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63))
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
  }
  return _u8(bytes)
}

const _base64Encode = (bytes) => {
  const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += b64[b0 >> 2]
    out += b64[((b0 & 3) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? b64[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? b64[b2 & 63] : '='
  }
  return out
}

const _base64Decode = (str) => {
  const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const map = {}
  for (let i = 0; i < b64.length; i++) map[b64[i]] = i
  str = str.replace(/=+$/, '')
  const out = []
  let buffer = 0, bits = 0
  for (let i = 0; i < str.length; i++) {
    buffer = (buffer << 6) | map[str[i]]
    bits += 6
    if (bits >= 8) { bits -= 8; out.push((buffer >> bits) & 0xff) }
  }
  return _u8(out)
}

const _hexDecode = (hex) => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

const _sha256 = (bytes) => {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]
  const l = bytes.length
  const bitLen = l * 8
  const padded = new Uint8Array(((l + 8) >> 6 << 6) + 64)
  padded.set(bytes)
  padded[l] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 4, bitLen >>> 0, false)
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false)
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
  const w = new Array(64)
  const rotr = (x, n) => (x >>> n) | (x << (32 - n))
  for (let i = 0; i < padded.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4, false)
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + K[t] + w[t]) | 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) | 0
      h = g; g = f; f = e; e = (d + temp1) | 0
      d = c; c = b; b = a; a = (temp1 + temp2) | 0
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0
  }
  const toHex = (x) => ('00000000' + (x >>> 0).toString(16)).slice(-8)
  return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4) + toHex(h5) + toHex(h6) + toHex(h7)
}

const _hmacSha256Hex = (key, msg) => {
  const k = key.length > 64 ? _hexDecode(_sha256(key)) : key
  const ipad = new Uint8Array(64)
  const opad = new Uint8Array(64)
  for (let i = 0; i < 64; i++) ipad[i] = 0x36
  for (let i = 0; i < 64; i++) opad[i] = 0x5c
  for (let i = 0; i < k.length; i++) { ipad[i] ^= k[i]; opad[i] ^= k[i] }
  const inner = new Uint8Array(ipad.length + msg.length)
  inner.set(ipad); inner.set(msg, ipad.length)
  const outer = new Uint8Array(opad.length + 32)
  outer.set(opad); outer.set(_hexDecode(_sha256(inner)), opad.length)
  return _sha256(outer)
}

const _SBOX = [
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]

const _buildMagicSbox = () => {
  const s = _SBOX.slice()
  const swaps = [[0, 99], [82, 120], [160, 224], [27, 212]]
  for (const [a, b] of swaps) { const t = s[a]; s[a] = s[b]; s[b] = t }
  return s
}

const _REQ_KEY = _u8([0x4b, 0x72, 0x9a, 0xf3, 0x1d, 0x88, 0xc5, 0x07, 0xbe, 0x34, 0x61, 0xaa, 0x09, 0x55, 0xe2, 0x7c])
const _REQ_IV = _u8([0x3f, 0x91, 0x6d, 0x04, 0xba, 0x27, 0xcc, 0x58, 0x14, 0xf9, 0x8b, 0xe0, 0x72, 0x4a, 0xd6, 0x01])
const _RESP_KEY = _u8([0x9c, 0x4e, 0x71, 0xb2, 0xda, 0x38, 0x06, 0xf5, 0x83, 0xcc, 0x1a, 0x47, 0x29, 0xe8, 0x5d, 0xbf])
const _HMAC_KEY = _u8([0x5a, 0x1f, 0x8e, 0x3c, 0xb7, 0x92, 0x64, 0x0d, 0xfa, 0x48, 0x15, 0x7b, 0xe3, 0xc9, 0x2a, 0x86])

const _magicAesEncrypt = (plaintext) => {
  const bytes = _utf8Encode(plaintext)
  const padLen = 16 - (bytes.length % 16)
  const padByte = padLen ^ 90
  const padded = new Uint8Array(bytes.length + padLen)
  padded.set(bytes)
  for (let i = bytes.length; i < padded.length; i++) padded[i] = padByte
  const sbox = _buildMagicSbox()
  const key = _REQ_KEY
  const iv = _REQ_IV.slice()
  const out = new Uint8Array(padded.length)
  for (let i = 0; i < padded.length; i += 16) {
    const block = new Array(16)
    for (let j = 0; j < 16; j++) block[j] = (padded[i + j] & 0xff) ^ iv[j]
    for (let j = 0; j < 16; j++) block[j] = sbox[block[j]]
    for (let j = 0; j < 16; j++) block[j] = block[j] ^ key[j]
    const shifted = new Array(16)
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++) shifted[r * 4 + c] = block[r * 4 + ((c + r) % 4)]
    for (let j = 0; j < 16; j++) { out[i + j] = shifted[j]; iv[j] = shifted[j] }
  }
  return _base64Encode(out)
}

const _rc4Decrypt = (b64) => {
  const data = _base64Decode(b64)
  const key = _RESP_KEY
  const s = new Array(256)
  for (let i = 0; i < 256; i++) s[i] = i
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff
    const t = s[i]; s[i] = s[j]; s[j] = t
  }
  const out = new Uint8Array(data.length)
  let i = 0; j = 0
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff
    j = (j + s[i]) & 0xff
    const t = s[i]; s[i] = s[j]; s[j] = t
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff]
  }
  let result = ''
  for (let ci = 0; ci < out.length;) {
    const b = out[ci]
    if (b < 0x80) { result += String.fromCharCode(b); ci++ }
    else if (b >= 0xc0 && b < 0xe0) { result += String.fromCharCode(((b & 31) << 6) | (out[ci + 1] & 63)); ci += 2 }
    else if (b >= 0xe0 && b < 0xf0) { result += String.fromCharCode(((b & 15) << 12) | ((out[ci + 1] & 63) << 6) | (out[ci + 2] & 63)); ci += 3 }
    else { const cp = ((b & 7) << 18) | ((out[ci + 1] & 63) << 12) | ((out[ci + 2] & 63) << 6) | (out[ci + 3] & 63); result += String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 1023)); ci += 4 }
  }
  return result
}

// ==================== 云记（海堂）通用接口 ====================

const HTS_API_HOSTS = [
  'https://musicserver.haitangw.cc/v1/',
  'https://qt.haitangw.net/v1/',
]

const HTS_UA = 'Mozilla/5.0 (Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'

const genRequestId = () => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let suffix = ''
  for (let i = 0; i < 10; i++) suffix += chars[Math.floor(Math.random() * chars.length)]
  return 'qm-muwat0on-' + suffix
}

const HTS_TX_LEVEL = {
  '128k': 'standard', '320k': 'exhigh', flac: 'lossless', flac24bit: 'hires',
  hires: 'hires', atmos: 'hires', atmos_plus: 'sur', master: 'jymaster',
}

const htsResolveUrl = async (source, rid, level) => {
  const errors = []
  for (const host of HTS_API_HOSTS) {
    try {
      const res = await httpFetch(host + 'music/resolve-url', {
        method: 'POST', timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': HTS_UA,
          'x-request-id': genRequestId(),
        },
        body: { source: source, rid: String(rid), level: level },
      })
      const d = res.body
      if (d && d.data && d.data.url) return d.data.url
      errors.push(host + ' -> ' + ((d && (d.message || d.msg)) || ('HTTP ' + res.statusCode)))
    } catch (e) {
      errors.push(host + ' -> ' + e.message)
    }
  }
  throw new Error(errors.join(' | ') || '无可用播放链接')
}

// ==================== 咪咕音质路径重写（取自云记） ====================
const MG_PATH_DEFAULT = '标清高清/MP3_128_16_Stero'

const MG_QUALITY_PATH = {
  '128k': { dir: MG_PATH_DEFAULT, ext: '.mp3' },
  '320k': { dir: '标清高清/MP3_320_16_Stero', ext: '.mp3' },
  flac: { dir: '歌曲下载/flac', ext: '.flac' },
  flac24bit: { dir: '歌曲下载/flac_24bit', ext: '.flac' },
  hires: { dir: '歌曲下载/flac_24bit', ext: '.flac' },
  atmos: { dir: '歌曲下载/wav_3d', ext: '.wav' },
  master: { dir: '歌曲下载/wav_32bit', ext: '.wav' },
}

const rewriteMiguUrl = (rawUrl, quality) => {
  if (typeof rawUrl !== 'string' || !rawUrl) return rawUrl
  const target = MG_QUALITY_PATH[quality]
  if (!target) return rawUrl
  try {
    let u = decodeURIComponent(rawUrl).split('?')[0]
    const before = u
    u = u.replace(MG_PATH_DEFAULT, target.dir)
    u = u.replace(/\.mp3$/, target.ext)
    if (u === before && quality !== '128k') {
      console.log('[mg] 云记咪咕: 链接未命中音质路径，返回原始链接（可能仍为 128k）')
    }
    return encodeURI(u)
  } catch (e) {
    DEBUGLog('[mg] URL 重写失败，返回原始链接', e.message)
    return rawUrl
  }
}

const MG_QUALITY_CHAIN = {
  master: ['master', 'flac', '320k', '128k'],
  atmos: ['atmos', 'flac', '320k', '128k'],
  hires: ['hires', 'flac', '320k', '128k'],
  flac24bit: ['flac24bit', 'flac', '320k', '128k'],
  flac: ['flac', '320k', '128k'],
  '320k': ['320k', '128k'],
  '128k': ['128k'],
}

const probePlayable = async (url) => {
  try {
    const res = await httpFetch(url, {
      method: 'HEAD', timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36' },
    })
    return res.statusCode >= 200 && res.statusCode < 400
  } catch (e) { return true }
}

const resolveMiguUrl = async (rawUrl, quality) => {
  if (typeof rawUrl !== 'string' || !rawUrl) return rawUrl
  const chain = MG_QUALITY_CHAIN[quality] || [quality]
  let lastUrl = rawUrl
  for (let i = 0; i < chain.length; i++) {
    const url = rewriteMiguUrl(rawUrl, chain[i])
    if (!url) continue
    if (url === lastUrl && i > 0) continue
    lastUrl = url
    if (url === rawUrl) return url
    if (i === chain.length - 1) return url
    if (await probePlayable(url)) return url
    DEBUGLog('[mg] 档位不可用，降级重试:', chain[i], '->', chain[i + 1])
  }
  return lastUrl
}

// ==================== Fish API ====================
const FISH_DOMAIN = 'music.gdstudio.xyz'
const FISH_VERSION = '20260510'
const fishSign = async (secret) => {
  const timeRes = await httpFetch(_u('cookn5**') + FISH_DOMAIN + '/time', { method: 'GET', timeout: 10000 })
  const timeStr = String(Number(timeRes.body) || Date.now()).slice(0, 9)
  const signInput = FISH_DOMAIN + '|' + FISH_VERSION + '|' + timeStr + '|' + secret
  return md5(signInput).slice(-8).toUpperCase()
}
const fishPost = async (params, secret) => {
  const sign = await fishSign(secret)
  params.s = sign
  const body = objToForm(params)
  const res = await httpFetch(_u('cookn5**') + FISH_DOMAIN + '/api.php', {
    method: 'POST', timeout: 15000,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Origin: _u('cookn5**') + FISH_DOMAIN,
      Referer: _u('cookn5**') + FISH_DOMAIN + '/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body,
  })
  return res.body
}

// -------- ygking QQ --------
const getYgkingTx = async (songId, quality, musicInfo) => {
  const mid = musicInfo?.songmid || musicInfo?.strMediaMid || musicInfo?.mediaMid || songId
  if (!mid) throw new Error('ygking: 缺少 mid')
  const qMap = { '128k':'128','192k':'320','320k':'320','flac':'flac','flac24bit':'hires','hires':'hires','master':'master','atmos':'master','atmos_plus':'master' }
  const q = qMap[quality] || '320'
  const url = _u('cookn5**\\kd)tbfdib)^i*\\kd*njib*pmg:hd_8') + encodeURIComponent(mid) + _u('!lp\\gdot8') + q
  const resp = await httpFetch(url, { method: 'GET', timeout: 8000 })
  const d = resp.body
  if (d?.code === 0 && d?.data?.[mid]) return d.data[mid]
  throw new Error('ygking 失败')
}

// -------- 残像 WY --------
const getCanxiang = async (songId, quality, musicInfo) => {
  const id = musicInfo?.songId || musicInfo?.id || songId
  const name = musicInfo?.songName || musicInfo?.name || ''
  const singer = musicInfo?.singer || ''
  const qMap = { '128k':'128k','192k':'320k','320k':'320k','flac':'flac','flac24bit':'hires','hires':'hires','master':'jymaster','atmos':'jymaster','atmos_plus':'jymaster' }
  const type = qMap[quality] || '320k'
  const token = 'canxiang_token_2026'
  const params = { token, type }
  if (id) params.id = String(id)
  else if (name) { params.msg = name + (singer ? ' ' + singer : ''); params.n = 1 }
  else throw new Error('残像: 缺少 id 或歌名')
  const query = Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&')
  const url = _u('cookn5**\\kd)^\\isd\\ib)^i*\\kd*rtthpnd^:') + query
  const resp = await httpFetch(url, { method: 'GET', timeout: 8000 })
  const d = resp.body
  if (d?.code === 200 && d?.data?.url) return d.data.url
  throw new Error('残像 失败')
}

// -------- 星海聚合（通用） --------
const getXinghai = async (platform, songId, quality, musicInfo) => {
  const sourceMap = { kw: 'kw', kg: 'kg', mg: 'migu' }
  const source = sourceMap[platform]
  if (!source) throw new Error('星海聚合: 不支持平台 ' + platform)
  const id = platform === 'kg' ? (musicInfo?.hash || songId) : (musicInfo?.songmid || musicInfo?.rid || songId)
  if (!id) throw new Error('星海聚合: 缺少 id')
  const name = musicInfo?.name || musicInfo?.songName || ''
  const singer = musicInfo?.singer || ''
  const qMap = { '128k':'128kmp3','192k':'320kmp3','320k':'320kmp3','flac':'flac','flac24bit':'hires','hires':'hires','master':'flac','atmos':'flac','atmos_plus':'flac' }
  const qualityParam = qMap[quality] || '320kmp3'
  const url = _u('cookn5**\\kd)sdibc\\d)^jh*gs*\\kd*:njpm^`8') + source + _u('!i\\h`8') + encodeURIComponent(name + ' ' + singer) + _u('!njibhd_8') + encodeURIComponent(id) + _u('!lp\\gdot8') + qualityParam
  const resp = await httpFetch(url, { method: 'GET', timeout: 8000 })
  const d = resp.body
  if (d?.code === 200 && d?.url) return d.url
  throw new Error('星海聚合 失败')
}
const getXinghaiKw = (s, q, m) => getXinghai('kw', s, q, m)
const getXinghaiKg = (s, q, m) => getXinghai('kg', s, q, m)
const getXinghaiMg = (s, q, m) => getXinghai('mg', s, q, m)

// -------- yunmge 酷我 --------
const getYunmgeKw = async (songId, quality, musicInfo) => {
  const id = musicInfo?.rid || musicInfo?.songmid || songId
  if (!id) throw new Error('yunmge: 缺少 id')
  const brMap = { '128k':128, '192k':192, '320k':320, 'flac':2000, 'flac24bit':2000, 'hires':4000, 'master':4000 }
  const wantBr = brMap[quality] || 320
  const url = _u('cookn5**\\kd)tpihb`)^jh*fprj:f`t8tpihb`Zf`t!ojf`i8tpihb`Zojf`i!d_8') + encodeURIComponent(id)
  const resp = await httpFetch(url, { method: 'GET', timeout: 8000 })
  const d = resp.body
  if (d?.code === 200 && d?.data?.all_bitrates) {
    const list = d.data.all_bitrates
    for (const br of [4000, 2000, 320, 192, 128]) {
      if (br < wantBr) continue
      const item = list.find(b => b.bitrate === br || String(b.bitrate) === String(br))
      if (item && item.play_url) return item.play_url
    }
    const fallback = list.find(b => b.play_url)
    if (fallback) return fallback.play_url
  }
  throw new Error('yunmge 失败')
}

// -------- 念心酷狗 --------
const getNianxinKg = async (songId, quality, musicInfo) => {
  const hash = musicInfo?.hash || musicInfo?.songmid || songId
  if (!hash) throw new Error('念心: 缺少 hash')
  const levelMap = { '128k':'128kmp3','192k':'320kmp3','320k':'320kmp3','flac':'2000kflac','flac24bit':'4000kflac','hires':'hires','master':'4000kflac','atmos':'4000kflac','atmos_plus':'4000kflac' }
  const level = levelMap[quality] || '320kmp3'
  const url = _u('cookn5**h^k)id\\isdisu)^jh*fbll*fb)kck:d_8') + encodeURIComponent(hash) + _u('!g`q`g8') + level + _u('!otk`8hk.')
  const resp = await httpFetch(url, { method: 'GET', timeout: 8000 })
  const d = resp.body
  if (d?.code === 200 && d?.url) return d.url
  if (typeof d === 'string' && d.startsWith('http')) return d
  throw new Error('念心 失败')
}

// ==================== FFAPI 通用 ====================
const extractFFURL = (d) => {
  if (!d || typeof d !== 'object') return ''
  if (typeof d.url === 'string' && d.url.startsWith('http')) return d.url
  if (d.data) {
    if (typeof d.data === 'string' && d.data.startsWith('http')) return d.data
    if (typeof d.data.url === 'string' && d.data.url.startsWith('http')) return d.data.url
    if (typeof d.data.play_url === 'string' && d.data.play_url.startsWith('http')) return d.data.play_url
    if (d.data.vipmusic && typeof d.data.vipmusic.url === 'string' && d.data.vipmusic.url.startsWith('http')) return d.data.vipmusic.url
    if (Array.isArray(d.data) && d.data[0]) {
      if (typeof d.data[0].url === 'string' && d.data[0].url.startsWith('http')) return d.data[0].url
      if (typeof d.data[0] === 'string' && d.data[0].startsWith('http')) return d.data[0]
    }
  }
  return ''
}
const getFFAPI = async (songmid, quality, musicInfo) => {
  const src = (musicInfo && musicInfo.source) || ''
  const id = songmid || ''
  if (!id) return ''
  let page = ''
  if (src === 'tx') page = 'https://y.qq.com/n/ryqq/songDetail/' + id
  else if (src === 'wy') page = 'https://music.163.com/song?id=' + id
  else if (src === 'kw') page = 'https://www.kuwo.cn/play_detail/' + id
  else if (src === 'kg') page = 'https://www.kugou.com/song/#hash=' + id
  else if (src === 'mg') page = 'https://music.migu.cn/v3/music/song/' + id
  else return ''
  const res = await httpFetch('https://ffapi.cn/int/v2/songurl?url=' + encodeURIComponent(page), { method: 'GET', timeout: 10000 })
  const d = res && res.body
  if (typeof d === 'string') {
    try { return extractFFURL(JSON.parse(d)) } catch (e) { return '' }
  }
  return extractFFURL(d)
}

// ==================== QQ 音乐后端池（v4.0.2 落月主线路） ====================
const TX_BACKENDS = [
  // === 主接口: 落月 QQ（api.vkeys.cn，v4.0.2 重写） ===
  {
    name: '落月QQ',
    fetch: async (songmid, quality, musicInfo) => {
      const mid = String(musicInfo?.songmid || musicInfo?.strMediaMid || musicInfo?.mediaMid || songmid || '')
      if (!mid) throw new Error('落月QQ: 缺少歌曲 mid')
      const q = LUOYUE_TX_QUALITY[quality]
      if (!q) throw new Error('落月QQ: 不支持音质 ' + quality)
      // 线路1: v2 geturl
      try {
        const res = await httpFetch(`https://api.vkeys.cn/v2/music/tencent/geturl?mid=${encodeURIComponent(mid)}&quality=${q}`, {
          method: 'GET', timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        })
        const d = res.body
        const url = d?.data?.url || (typeof d?.data === 'string' && d.data.startsWith('http') ? d.data : '')
        if (url && isHttpUrl(url)) return url
      } catch (e) {
        DEBUGLog('[落月QQ] v2 geturl 失败:', e.message)
      }
      // 线路2: v3 song/link
      try {
        const res = await httpFetch(`https://api.vkeys.cn/music/tencent/song/link?mid=${encodeURIComponent(mid)}&quality=${q}`, {
          method: 'GET', timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        })
        const d = res.body
        const url = d?.data?.url || (typeof d?.data === 'string' && d.data.startsWith('http') ? d.data : '')
        if (url && isHttpUrl(url)) return url
      } catch (e) {
        DEBUGLog('[落月QQ] v3 song/link 失败:', e.message)
      }
      throw new Error('落月QQ: 两线路均未返回有效 URL')
    },
  },

  // === 备用接口: 云记（海堂） ===
  {
    name: '云记QQ(海堂)',
    fetch: async (songmid, quality, musicInfo) => {
      const mid = String(musicInfo?.songmid || musicInfo?.id || songmid || '')
      if (!mid) throw new Error('云记QQ: 缺少歌曲ID')
      const level = HTS_TX_LEVEL[quality]
      if (!level) throw new Error('云记QQ: 不支持音质 ' + quality)
      return await htsResolveUrl('tx', mid, level)
    },
  },

  // === 备用接口: HYWmusic QQ ===
  {
    name: 'HYWmusic QQ',
    fetch: async (songmid, quality, musicInfo) => {
      return await getHYWMusicUrl('tx', songmid, quality, musicInfo)
    },
  },

  // === 备用接口: baimusic QQ ===
  {
    name: 'baimusic QQ',
    fetch: async (songmid, quality, musicInfo) => {
      const mid = String(musicInfo?.songmid ?? '')
      if (!mid) throw new Error('baimusic QQ: 缺少歌曲ID')
      const q = quality === 'hires' ? 'flac24bit' : quality
      const plain = JSON.stringify({ mid: mid, quality: q })
      const enc = _magicAesEncrypt(plain)
      const sig = _hmacSha256Hex(_HMAC_KEY, _utf8Encode(enc))
      const res = await httpFetch('http://106.55.0.102/baimusic/qqhoturl.php', {
        method: 'POST', timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 15; V2453A Build/AP3A.240905.015.A2_V000L1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.5 Mobile Safari/537.36',
          Accept: '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Content-Type': 'application/octet-stream',
          'X-Sig': sig,
        },
        body: enc,
      })
      const d = res.body
      if (!d || typeof d !== 'object' || !d.d) {
        throw new Error('baimusic QQ: 响应缺少d字段' + (d?.error ? ': ' + d.error : ''))
      }
      const dec = JSON.parse(_rc4Decrypt(d.d))
      if (!dec.url) throw new Error('baimusic QQ: ' + (dec.error || '获取URL失败'))
      return dec.url
    },
  },

  {
    name: 'QQ官方',
    fetch: async (songmid, quality) => {
      const fileInfo = TX_FILE_CONFIG[quality]
      if (!fileInfo) throw new Error('不支持的音质')
      const guid = randomGuid()
      const file = fileInfo.s + songmid + fileInfo.e
      const uin = HAS_TX_COOKIE ? extractUinFromCookie(TX_COOKIE) : '0'
      const reqData = {
        req_0: {
          module: 'vkey.GetVkeyServer', method: 'CgiGetVkey',
          param: { filename: [file], guid, songmid: [songmid], songtype: [0], uin, loginflag: HAS_TX_COOKIE ? 1 : 0, platform: '20' },
        },
        loginUin: uin,
        comm: { uin, format: 'json', ct: 24, cv: 0 },
      }
      const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', Referer: _u('cookn5**t)ll)^jh*') }
      if (HAS_TX_COOKIE) headers.Cookie = TX_COOKIE
      const res = await httpFetch(_u('cookn5**p)t)ll)^jh*^bd(]di*hpnd^p)a^b'), { method: 'POST', headers, body: JSON.stringify(reqData) })
      const d = res.body
      const info = d?.req_0?.data?.midurlinfo?.[0]
      if (info?.purl) {
        if (info.freeTrialInfo || /RS0/i.test(info.purl)) {
          throw new Error('QQ官方: 仅返回试听片段（VIP歌曲需在头部配置 @tx_cookie）')
        }
        const sip = d.req_0.data.sip || [_u('cookn5**dnpm`)nom`\\h)llhpnd^)ll)^jh*')]
        return sip[Math.floor(Math.random() * sip.length)] + info.purl
      }
      throw new Error('QQ官方: 无数据')
    },
  },
  {
    name: '星海主后端',
    fetch: async (songmid, quality) => {
      const res = await httpFetch(_u('cookn5**tt)u__tm)ojk*gs*\\kd*:njpm^`8ll!njibhd_8') + songmid + '&quality=' + quality, { method: 'GET', timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } })
      const d = res.body
      if (d?.code === 200 && d.url) return d.url
      throw new Error('星海主后端: ' + (d?.msg || '无数据'))
    },
  },
  {
    name: 'HelloWorld QQ',
    fetch: async (songmid, quality, musicInfo) => {
      const keyword = encodeURIComponent(musicInfo?.name || musicInfo?.songName || '')
      if (!keyword) throw new Error('HelloWorld QQ: 缺少歌曲名')
      const qMap = { '128k': '0', '320k': '1', flac: '4', master: '5' }
      const type = qMap[quality] || '1'
      const url = _u('cookn5**\\)\\\\)^\\]*ll)hpnd^:hnb8') + keyword + _u('!i8,!otk`8') + type
      const res = await httpFetch(url, { method: 'GET', timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } })
      const d = res.body
      if (d?.data?.music?.startsWith?.('http')) return d.data.music
      if (d?.playUrl?.startsWith?.('http')) return d.playUrl
      if (d?.url?.startsWith?.('http')) return d.url
      if (d?.data?.url?.startsWith?.('http')) return d.data.url
      throw new Error('HelloWorld QQ: 无有效链接')
    },
  },
  {
    name: 'vkeys',
    fetch: async (songmid, quality) => {
      const qualityMap = { '128k': '8', '320k': '9', flac: '10', flac24bit: '16', hires: '14', atmos: '13', atmos_plus: '12', master: '11' }
      const q = qualityMap[quality]
      if (!q) throw new Error('vkeys 不支持的音质')
      const res = await httpFetch(_u('cookn5**\\kd)qf`tn)^i*q-*hpnd^*o`i^`io*b`opmg:hd_8') + songmid + '&quality=' + q, { method: 'GET', timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } })
      const d = res.body
      if (d?.data?.url) return d.data.url
      if (d?.url) return d.url
      throw new Error('vkeys: 无数据')
    },
  },
  {
    name: '317ak',
    fetch: async (songmid, quality) => {
      const brMap = { '128k': '5', '320k': '6', flac: '8', flac24bit: '7', hires: '9', atmos: '10', atmos_plus: '10', master: '10' }
      const br = brMap[quality] || '5'
      const res = await httpFetch(_u('cookn5**\\kd).,2\\f)^i*\\kd*tditp`*lltditp`:^f`t8UF21LE>DC0KKD>EJJSPC!d8') + songmid + '&br=' + br + '&type=json&lrc=1', { method: 'GET', timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } })
      const url = extractUrl(res.body, [['url'], ['data', 'url']])
      if (url) return url
      throw new Error('317ak: 无数据')
    },
  },
  {
    name: '念心直链',
    fetch: async (songmid, quality) => {
      const res = await httpFetch(_u('cookn5**hpnd^)isdisu)^jh*fbll*os)kck:d_8') + songmid + '&level=' + quality + '&type=mp3', { method: 'GET', timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } })
      const d = res.body
      if (typeof d === 'string' && (d.startsWith(_u('cook5**')) || d.startsWith(_u('cookn5**')))) return d
      if (d?.url) return d.url
      throw new Error('念心直链: 无数据')
    },
  },
  {
    name: 'FishAPI',
    fetch: async (songmid, quality) => {
      const brMap = { '128k': 128, '320k': 320, flac: 740, flac24bit: 999 }
      const br = brMap[quality]
      if (!br) throw new Error('FishAPI 不支持的音质')
      const result = await fishPost({ types: 'url', id: songmid, source: 'qq', br }, encodeURIComponent(songmid))
      const url = result && result.url ? cleanUrl(String(result.url)) : ''
      if (url.startsWith('http')) return url
      throw new Error('FishAPI: 无数据')
    },
  },
  { name: 'ygking QQ', fetch: getYgkingTx },
  { name: 'FFAPI', fetch: getFFAPI },
]

// ==================== 网易云后端池 ====================
const WY_BACKENDS = [
  {
    name: '网易云官方',
    fetch: async (songmid, quality) => {
      const level = WY_LEVEL_MAP[quality] || 'standard'
      const targetUrl = _u('cookn5**dio`ma\\^`.)hpnd^),1.)^jh*`\\kd*njib*`ic\\i^`*kg\\t`m*pmg*q,')
      const eapiUrl = '/api/song/enhance/player/url/v1'
      const payload = { ids: '[' + String(songmid) + ']', level, encodeType: 'flac' }
      if (level === 'sky') payload.immerseType = 'c51'
      const encrypted = wyEapi(eapiUrl, payload)
      let cookieValue = 'os=pc; appver=2.10.2.200154; osver=; deviceId=pyncm!'
      if (HAS_WY_COOKIE) cookieValue = WY_COOKIE + '; ' + cookieValue
      const res = await httpFetch(targetUrl, {
        method: 'POST', timeout: 10000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/2.10.2.200154',
          Referer: _u('cookn5**hpnd^),1.)^jh*'),
          Cookie: cookieValue,
        },
        body: 'params=' + encrypted.params,
      })
      const d = res.body
      if (d?.data?.[0]?.url && !d.data[0].freeTrialInfo) return d.data[0].url
      if (d?.data?.[0]?.freeTrialInfo) throw new Error('VIP歌曲仅试听（配置Cookie后可用完整版）')
      if (d?.code && d.code !== 200) throw new Error('网易云官方: code ' + d.code + ' ' + (d.message || ''))
      throw new Error('网易云官方: 无数据')
    },
  },
  {
    name: 'ikun网易云',
    fetch: async (songmid, quality, musicInfo) => {
      const songId = musicInfo?.hash ?? songmid
      const res = await httpFetch(_u('cookn5**^)rrrr`])ojk*hpnd^*pmg'), {
        method: 'POST', timeout: 10000,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'lx-music-request/2.9.0', 'X-Api-Key': '' },
        body: JSON.stringify({ source: 'wy', musicId: songId, quality }),
        follow_max: 5,
      })
      const d = res.body
      if (!d || isNaN(Number(d.code))) throw new Error('ikun网易云: 未知错误')
      if (d.code === 200 && d.url) return d.url
      if (d.code === 403) throw new Error('ikun网易云: 鉴权失败')
      if (d.code === 429) throw new Error('ikun网易云: 请求过速')
      throw new Error('ikun网易云: ' + (d.message || '获取URL失败'))
    },
  },
  {
    name: '笒鬼鬼',
    fetch: async (songmid, quality) => {
      const level = WY_LEVEL_MAP[quality] || 'standard'
      const res = await httpFetch(_u('cookn5**\\kd)^`ibpdbpd)^i*\\kd*i`o`\\n`*hpnd^Zq,)kck:d_8') + songmid + '&type=json&level=' + level, { method: 'GET', timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } })
      const d = res.body
      if (d?.data?.url) return d.data.url
      if (d?.url) return d.url
      throw new Error('笒鬼鬼: 无数据')
    },
  },
  {
    name: '星海主后端',
    fetch: async (songmid, quality) => {
      const res = await httpFetch(_u('cookn5**tt)u__tm)ojk*gs*\\kd*:njpm^`8i`o`\\n`!njibhd_8') + songmid + '&quality=' + quality, { method: 'GET', timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } })
      const d = res.body
      if (d?.code === 200 && d.url) return d.url
      throw new Error('星海主后端: ' + (d?.msg || '无数据'))
    },
  },
  {
    name: '念心直链',
    fetch: async (songmid, quality) => {
      const res = await httpFetch(_u('cook5**hpnd^)isdisu)^jh*rt)kck:d_8') + songmid + '&level=' + quality + '&type=mp3', { method: 'GET', timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } })
      const d = res.body
      if (typeof d === 'string' && (d.startsWith(_u('cook5**')) || d.startsWith(_u('cookn5**')))) return d
      if (d?.url) return d.url
      throw new Error('念心直链: 无数据')
    },
  },
  {
    name: 'FishAPI',
    fetch: async (songmid, quality) => {
      const brMap = { '128k': 128, '320k': 320, flac: 740, flac24bit: 999 }
      const br = brMap[quality]
      if (!br) throw new Error('FishAPI 不支持的音质')
      const result = await fishPost({ types: 'url', id: songmid, source: 'netease', br }, encodeURIComponent(songmid))
      const url = result && result.url ? cleanUrl(String(result.url)) : ''
      if (url.startsWith('http')) return url
      throw new Error('FishAPI: 无数据')
    },
  },
  {
    name: 'HYWmusic WY',
    fetch: async (songmid, quality, musicInfo) => {
      return await getHYWMusicUrl('wy', songmid, quality, musicInfo)
    },
  },
  { name: '残像 WY', fetch: (songmid, quality) => getCanxiang(songmid, quality, { songId: songmid, songName: '', singer: '' }) },
  { name: 'FFAPI', fetch: getFFAPI },
]

// ==================== 酷我后端池 ====================
const KW_BACKENDS = [
  {
    name: '酷我流媒体',
    fetch: async (songmid, quality, musicInfo) => {
      const level = KW_STREAM_LEVEL_MAP[quality] || 'master'
      const songIdTmp = musicInfo?.songmid || musicInfo?.id || musicInfo?.hash || musicInfo?.songId || musicInfo?.musicId || songmid
      if (!songIdTmp) throw new Error('酷我流媒体: 找不到歌曲ID')
      const songId = String(songIdTmp).trim()
      return _u('cook5**,20)-2),11)-.1534-3*frnom`\\h:d_8') + encodeURIComponent(songId) + '&level=' + level + '&stream=1'
    },
  },
  {
    name: '星海主后端',
    fetch: async (songmid, quality, musicInfo) => {
      const name = musicInfo?.name || '', singer = musicInfo?.singer || '', interval = musicInfo?.interval || '', albumName = musicInfo?.albumName || musicInfo?.album || ''
      const res = await httpFetch(_u('cookn5**tt)u__tm)ojk*gs*\\kd*:njpm^`8fr!i\\h`8') + encodeURIComponent(name) + '&singer=' + encodeURIComponent(singer) + '&songmid=' + encodeURIComponent(songmid) + '&interval=' + encodeURIComponent(interval) + '&albumName=' + encodeURIComponent(albumName) + '&quality=' + quality, { method: 'GET', timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } })
      const d = res.body
      if (d?.code === 200 && d.url) return d.url
      throw new Error('星海主后端: ' + (d?.msg || '无数据'))
    },
  },
  {
    name: 'HelloWorld KW 主API',
    fetch: async (songmid, quality, musicInfo) => {
      const hash = musicInfo?.hash || musicInfo?.songmid || musicInfo?.rid || musicInfo?.id || songmid
      if (!hash) throw new Error('HelloWorld KW 主API: 找不到歌曲ID')
      const levelMap = { atmos: 'atmos', atmos_plus: 'atmos_plus', master: 'master' }
      const level = levelMap[quality]
      if (!level) throw new Error('HelloWorld KW 主API: 不支持音质')
      const res = await httpFetch('https://musicserver.haitangw.cc/v1/music/resolve-url', {
        method: 'POST', timeout: 10000,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: { source: 'kw', rid: hash, level: level },
      })
      const d = res.body
      if (d?.data?.url) return d.data.url
      throw new Error('HelloWorld KW 主API: 无数据')
    },
  },
  {
    name: 'HelloWorld KW 备用API',
    fetch: async (songmid, quality, musicInfo) => {
      const hash = musicInfo?.hash || musicInfo?.songmid || musicInfo?.rid || musicInfo?.id || songmid
      if (!hash) throw new Error('HelloWorld KW 备用API: 找不到歌曲ID')
      const qMap = { '128k': '128k', '320k': '320k', flac: 'flac', flac24bit: 'flac24bit', hires: 'hires' }
      const q = qMap[quality]
      if (!q) throw new Error('HelloWorld KW 备用API: 不支持音质')
      const res = await httpFetch('https://c.wwwweb.top/music/url', {
        method: 'POST', timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'lx-music-desktop/2.10.1',
          'X-Api-Key': '',
        },
        body: { source: 'kw', musicId: hash, quality: q },
        follow_max: 5,
      })
      const d = res.body
      if (!d || isNaN(Number(d.code))) throw new Error('HelloWorld KW 备用API: 未知错误')
      if (d.code === 200 && d.url) return d.url
      if (d.code === 403) throw new Error('HelloWorld KW 备用API: 鉴权失败')
      if (d.code === 429) throw new Error('HelloWorld KW 备用API: 请求过速')
      throw new Error('HelloWorld KW 备用API: ' + (d.message || '获取URL失败'))
    },
  },
  {
    name: '酷我官方',
    fetch: async (songmid, quality, musicInfo) => {
      const brMap = { '128k': '128kmp3', '192k': '128kmp3', '320k': '320kmp3', flac: '2000kflac', flac24bit: '4000kflac' }
      const br = brMap[quality]
      if (!br) throw new Error('酷我官方 不支持的音质')
      let rid = musicInfo?.rid || ''
      if (!rid && musicInfo?.musicrid) rid = String(musicInfo.musicrid).replace(/^MUSIC_/, '')
      if (!rid) rid = songmid
      const res = await httpFetch(_u('cookn5**hj]d)fprj)^i*hj]d)n:a8r`]!md_8') + rid + '&br=' + br + '&source=jiakong&type=convert_url_with_sign&surl=1', { method: 'GET', timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Mobile Safari/537.36' } })
      const d = res.body
      if (d?.code === 200 && d?.data?.surl) return d.data.surl
      if (d?.code === 200 && d?.data?.url) return d.data.url
      throw new Error('酷我官方: 无数据')
    },
  },
  {
    name: '酷我手机版',
    fetch: async (songmid, quality) => {
      const brMap = { '128k': '128kmp3', '192k': '128kmp3', '320k': '320kmp3', flac: '2000kflac', flac24bit: '4000kflac' }
      const br = brMap[quality]
      if (!br) throw new Error('酷我手机版 不支持的音质')
      const res = await httpFetch(_u('cookn5**ihj]d)fprj)^i*hj]d)n:a8r`]!pn`m8+!njpm^`8frkg\\t`mc_Z\\mZ/).)+)3Zod\\i]\\jZO,<Zldmpd)\\kf!otk`8^jiq`moZpmgZrdocZndbi!md_8') + songmid + '&br=' + br, { method: 'GET', timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36' } })
      const d = res.body
      if (d?.code === 200 && d?.data?.url) return d.data.url
      if (d?.code === 200 && d?.data?.surl) return d.data.surl
      throw new Error('酷我手机版: 无数据')
    },
  },
  {
    name: '念心直链',
    fetch: async (songmid, quality) => {
      const level = qualityToLevel(quality)
      const res = await httpFetch(_u('cookn5**hpnd^)isdisu)^jh*fbll*fr)kck:d_8') + songmid + '&level=' + level + '&type=mp3', { method: 'GET', timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } })
      const d = res.body
      if (typeof d === 'string' && (d.startsWith(_u('cook5**')) || d.startsWith(_u('cookn5**')))) return d
      if (d?.url) return d.url
      throw new Error('念心直链: 无数据')
    },
  },
  {
    name: 'HYWmusic KW',
    fetch: async (songmid, quality, musicInfo) => {
      return await getHYWMusicUrl('kw', songmid, quality, musicInfo)
    },
  },
  { name: 'yunmge酷我', fetch: getYunmgeKw },
  { name: '星海酷我', fetch: getXinghaiKw },
  { name: 'FFAPI', fetch: getFFAPI },
]

// ==================== 酷狗后端池 ====================
const KG_BACKENDS = [
  {
    name: '海堂KG',
    fetch: async (songmid, quality, musicInfo) => {
      const hash = musicInfo?.hash || musicInfo?.songmid || musicInfo?.id || songmid
      if (!hash) throw new Error('海堂KG: 找不到歌曲ID')
      const levelMap = { '128k': 'standard', '320k': 'exhigh', flac: 'lossless', hires: 'hires', atmos: 'atmos', master: 'clear' }
      const level = levelMap[quality]
      if (!level) throw new Error('海堂KG: 不支持音质')
      const res = await httpFetch('https://musicserver.haitangw.cc/v1/music/resolve-url', {
        method: 'POST', timeout: 10000,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: { source: 'kg', rid: hash, level: level },
      })
      const d = res.body
      if (d?.data?.url) return d.data.url
      throw new Error('海堂KG: 无数据')
    },
  },
  {
    name: 'HYWmusic KG',
    fetch: async (songmid, quality, musicInfo) => {
      return await getHYWMusicUrl('kg', songmid, quality, musicInfo)
    },
  },
  {
    name: '白姬KG',
    fetch: async (songmid, quality, musicInfo) => {
      const id = musicInfo?.hash || musicInfo?.songmid || musicInfo?.id || songmid
      if (!id) throw new Error('白姬KG: 找不到歌曲ID')
      const qMap = { '128k': '128k', '320k': '320k', flac: 'flac' }
      const q = qMap[quality]
      if (!q) throw new Error('白姬KG: 不支持音质')
      const url = 'https://103.79.184.97/api/music/url?source=kg&songId={id}&quality={quality}&key=6C1F-53W0-GRKI-EVFG'
        .replace('{id}', encodeURIComponent(id))
        .replace('{quality}', encodeURIComponent(q))
      const res = await httpFetch(url, { method: 'GET', timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } })
      const d = res.body
      if (d && d.url) return d.url
      if (d && d.data && d.data.url) return d.data.url
      throw new Error('白姬KG: 无数据')
    },
  },
  {
    name: '星海KG',
    fetch: async (songmid, quality, musicInfo) => {
      const id = musicInfo?.hash || musicInfo?.songmid || musicInfo?.id || songmid
      if (!id) throw new Error('星海KG: 找不到歌曲ID')
      const qMap = { '128k': '128k', '320k': '320k', flac: 'flac', hires: 'hires', atmos: 'atmos', master: 'master' }
      const q = qMap[quality]
      if (!q) throw new Error('星海KG: 不支持音质')
      const url = 'https://yy.zddyr.top/lx/api/?source=kg&quality={quality}&mainHash={id}'
        .replace('{id}', encodeURIComponent(id))
        .replace('{quality}', encodeURIComponent(q))
      const res = await httpFetch(url, { method: 'GET', timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } })
      const d = res.body
      if (d?.url) return d.url
      throw new Error('星海KG: ' + (d?.msg || '无数据'))
    },
  },
  {
    name: '星海主后端',
    fetch: async (songmid, quality, musicInfo) => {
      const hash = musicInfo?.hash || (musicInfo?._types?.[quality]?.hash) || songmid
      const albumId = musicInfo?.albumId || ''
      const res = await httpFetch(_u('cookn5**tt)u__tm)ojk*gs*\\kd*:njpm^`8fb!lp\\gdot8') + quality + '&songmid=' + (musicInfo?.songmid || songmid) + '&albumId=' + albumId + '&mainHash=' + hash + '&hash=' + hash, { method: 'GET', timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } })
      const d = res.body
      if (d?.code === 200 && d.url) return d.url
      throw new Error('星海主后端: ' + (d?.msg || '无数据'))
    },
  },
  {
    name: '长青海棠',
    fetch: async (songmid, quality, musicInfo) => {
      const level = KG_LEVEL_MAP[quality] || 'standard'
      const hash = musicInfo?.hash || musicInfo?.songmid || songmid
      const res = await httpFetch(_u('cookn5**hpnd^n`mq`m)c\\do\\ibr)^^*q,*hpnd^*m`njgq`(pmg'), { method: 'POST', timeout: 10000, headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }, body: JSON.stringify({ source: 'kg', rid: hash, level }) })
      const d = res.body
      if (d?.code === 0 && d?.data?.url) return d.data.url
      throw new Error('长青海棠: ' + (d?.msg || '无数据'))
    },
  },
  {
    name: '酷狗官方',
    fetch: async (songmid, quality, musicInfo) => {
      const hash = musicInfo?.hash || songmid
      const albumId = musicInfo?.albumId || ''
      const res = await httpFetch(_u('cookn5**rrr\\kd)fpbjp)^jh*tt*di_`s)kck:m8kg\\t*b`o_\\o\\!c\\nc8') + hash + '&platid=4&album_id=' + albumId + '&mid=00000000000000000000000000000000', { method: 'GET', timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0', Referer: _u('cookn5**rrr)fpbjp)^jh*') } })
      const d = res.body
      if (d?.status === 1 && d?.data?.play_backup_url) return d.data.play_backup_url
      if (d?.status === 1 && d?.data?.play_url) return d.data.play_url
      throw new Error('酷狗官方: 无数据')
    },
  },
  {
    name: '念心KG',
    fetch: async (songmid, quality) => {
      const level = KG_LEVEL_MAP[quality] || 'standard'
      const res = await httpFetch(_u('cookn5**hpnd^)isdisu)^jh*fbll*fb)kck:d_8') + songmid + '&level=' + level + '&type=mp3', { method: 'GET', timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } })
      const d = res.body
      if (d?.code === 200 && d.url) return d.url
      if (typeof d === 'string' && (d.startsWith(_u('cook5**')) || d.startsWith(_u('cookn5**')))) return d
      throw new Error('念心KG: 无数据')
    },
  },
  { name: '星海酷狗', fetch: getXinghaiKg },
  { name: '念心酷狗', fetch: getNianxinKg },
  { name: 'FFAPI', fetch: getFFAPI },
]

// ==================== 咪咕后端池 ====================
const MG_BACKENDS = [
  {
    name: '云记咪咕(海堂)',
    fetch: async (songmid, quality, musicInfo) => {
      const rid = String(musicInfo?.songmid || musicInfo?.id || songmid || '')
      if (!rid) throw new Error('云记咪咕: 缺少歌曲ID')
      const rawUrl = await htsResolveUrl('mg', rid, 'standard')
      return await resolveMiguUrl(rawUrl, quality)
    },
  },
  {
    name: '星海主后端',
    fetch: async (songmid, quality) => {
      const res = await httpFetch(_u('cookn5**tt)u__tm)ojk*gs*\\kd*:njpm^`8hdbp!njibhd_8') + songmid + '&quality=' + quality, { method: 'GET', timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } })
      const d = res.body
      if (d?.code === 200 && d.url) return d.url
      throw new Error('星海主后端: ' + (d?.msg || '无数据'))
    },
  },
  {
    name: 'Migu直接源',
    fetch: async (songmid, quality) => {
      const level = qualityToLevel(quality)
      const res = await httpFetch(_u('cookn5**hpnd^)hdbp)^i*q.*\\kd*hpnd^*\\p_djKg\\t`m*b`oKg\\tDiaj:^jktmdbcoD_8') + encodeURIComponent(String(songmid)) + '&level=' + level, { method: 'GET', timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Referer: _u('cookn5**hpnd^)hdbp)^i*') } })
      const d = res.body
      if (d?.data?.playUrl) return d.data.playUrl
      if (d?.url) return d.url
      if (d?.playUrl) return d.playUrl
      throw new Error('Migu直接源: 无数据')
    },
  },
  {
    name: 'Migu API',
    fetch: async (songmid, quality) => {
      const levelMap = { '128k': 'PQ', '320k': 'HQ', flac: 'SQ', flac24bit: 'ZQ' }
      const level = levelMap[quality] || 'HQ'
      const res = await httpFetch(_u('cookn5**\\kk)^)ia)hdbp)^i*HDBPH-)+*nom\\o`bt*gdno`i(pmg*q-)-:^jktmdbcoD_8') + encodeURIComponent(String(songmid)) + '&quality=' + level, { method: 'GET', timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36', Referer: _u('cookn5**\\kk)^)ia)hdbp)^i*') } })
      const d = res.body
      if (d?.data?.url) return d.data.url
      if (d?.url) return d.url
      if (d?.data?.playUrl) return d.data.playUrl
      throw new Error('Migu API: 无数据')
    },
  },
  {
    name: 'HYWmusic MG',
    fetch: async (songmid, quality, musicInfo) => {
      return await getHYWMusicUrl('mg', songmid, quality, musicInfo)
    },
  },
  { name: '星海咪咕', fetch: getXinghaiMg },
  { name: 'FFAPI', fetch: getFFAPI },
]

// ==================== 汽水音乐(qs) 后端接口列表 ====================
const createXinghaiQsBackend = (name, host) => ({
  name: name,
  fetch: async (songmid, quality, musicInfo) => {
    const id = String(musicInfo?.songmid || musicInfo?.id || songmid || '')
    if (!id) throw new Error(name + ': 缺少歌曲ID')
    const params = {
      source: 'qs',
      name: musicInfo?.name || '',
      singer: musicInfo?.singer || '',
      songmid: id,
      interval: musicInfo?.interval || '',
      albumName: musicInfo?.albumName || musicInfo?.album || '',
      quality: quality || '',
    }
    const query = Object.keys(params)
      .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
      .join('&')
    const res = await httpFetch('https://' + host + '/lx/api/?' + query, {
      method: 'GET', timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'X-Client': 'XingHaiMusicSource' },
    })
    const d = res.body
    if (!d || Number(d.code) !== 200) {
      throw new Error(name + ': ' + ((d && d.msg) || '接口无数据'))
    }
    const data = d.data || {}
    let streamUrl = data.url || ''
    if (streamUrl && data.key && !/[?&]key=/.test(streamUrl)) {
      streamUrl += (streamUrl.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(data.key)
    }
    if (!streamUrl) streamUrl = data.source_url || ''
    if (!streamUrl) throw new Error(name + ': 未返回流媒体链接')
    return streamUrl
  },
})

const QS_BACKENDS = [
  createXinghaiQsBackend('星海汽水主线路', 'yy.zddyr.top'),
  createXinghaiQsBackend('星海汽水备用线路', 'zrcdy.dpdns.org'),
]

// ==================== URL 缓存 + 限流 ====================

const URL_CACHE = new Map()
const INFLIGHT = new Map()
const requestTimeList = []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const acquireRateSlot = async () => {
  const deadline = Date.now() + RATE_LIMIT_MAX_WAIT
  for (;;) {
    const now = Date.now()
    while (requestTimeList.length > 0 && now - requestTimeList[0] >= RATE_LIMIT_WINDOW) {
      requestTimeList.shift()
    }
    if (requestTimeList.length < RATE_LIMIT_MAX) {
      requestTimeList.push(now)
      return
    }
    const wait = RATE_LIMIT_WINDOW - (now - requestTimeList[0]) + 10
    if (Date.now() + wait > deadline) {
      throw new Error('请求过于频繁，限制' + RATE_LIMIT_MAX + '次/' + (RATE_LIMIT_WINDOW / 1000) + '秒，请稍后重试')
    }
    DEBUGLog('[限流] 窗口已满，等待', wait, 'ms')
    await sleep(wait)
  }
}

const pruneCache = () => {
  const now = Date.now()
  for (const [key, val] of URL_CACHE) {
    if (val.expire <= now) URL_CACHE.delete(key)
  }
  while (URL_CACHE.size > CACHE_MAX_ENTRIES) {
    const oldest = URL_CACHE.keys().next()
    if (oldest.done) break
    URL_CACHE.delete(oldest.value)
  }
}

const withUrlCache = async (cacheKey, loader) => {
  const now = Date.now()
  const cached = URL_CACHE.get(cacheKey)
  if (cached) {
    if (cached.expire > now) return cached.url
    URL_CACHE.delete(cacheKey)
  }
  const pending = INFLIGHT.get(cacheKey)
  if (pending) return pending
  const task = (async () => {
    await acquireRateSlot()
    const url = await loader()
    URL_CACHE.set(cacheKey, { url: url, expire: Date.now() + CACHE_TTL })
    if (URL_CACHE.size > CACHE_MAX_ENTRIES) pruneCache()
    return url
  })()
  INFLIGHT.set(cacheKey, task)
  try { return await task }
  finally { INFLIGHT.delete(cacheKey) }
}

// ==================== 后端池与选择 ====================

const BACKEND_POOLS = { tx: TX_BACKENDS, wy: WY_BACKENDS, kw: KW_BACKENDS, kg: KG_BACKENDS, mg: MG_BACKENDS, qs: QS_BACKENDS }
const KW_HIGH_QUALITY = ['atmos', 'atmos_plus', 'master']
const KW_STREAM_BACKEND = '酷我流媒体'

const isHttpUrl = (u) => typeof u === 'string' && (u.startsWith('http://') || u.startsWith('https://'))

const pickBackends = (source, quality, backends) => {
  if (source !== 'kw') return backends
  if (KW_HIGH_QUALITY.includes(quality)) return backends.filter((b) => b.name === KW_STREAM_BACKEND)
  return backends.filter((b) => b.name !== KW_STREAM_BACKEND)
}

const resolveFromBackends = async (backends, songId, quality, musicInfo) => {
  if (!backends.length) throw new Error('无可用后端')
  const errors = []
  const head = backends.slice(0, 3)
  const tail = backends.slice(3)

  if (head.length) {
    try {
      return await Promise.any(head.map(async (backend) => {
        try {
          const url = await backend.fetch(songId, quality, musicInfo)
          if (isHttpUrl(url)) return url
          throw new Error('返回无效URL')
        } catch (e) {
          throw new Error(backend.name + ': ' + e.message)
        }
      }))
    } catch (err) {
      if (err && err.errors) err.errors.forEach((e) => errors.push(e.message))
      else errors.push(err.message)
    }
  }

  for (const backend of tail) {
    try {
      const url = await backend.fetch(songId, quality, musicInfo)
      if (isHttpUrl(url)) return url
      errors.push(backend.name + ': 返回无效URL')
    } catch (e) {
      errors.push(backend.name + ': ' + e.message)
    }
  }

  throw new Error('所有后端均失败（共 ' + backends.length + ' 个）\n' + errors.join('\n'))
}

// ==================== 获取音乐URL ====================

const handleGetMusicUrl = async (source, musicInfo, quality) => {
  const songId = musicInfo?.hash ?? musicInfo?.songmid ?? musicInfo?.id
  if (!songId) throw new Error('无法获取歌曲ID')

  const pool = BACKEND_POOLS[source]
  if (!pool) throw new Error('未知音源: ' + source)

  const supported = MUSIC_QUALITY[source] || ['128k']
  const targetQuality = supported.includes(quality) ? quality : (supported[supported.length - 1] || '128k')

  const cacheKey = source + '-' + songId + '-' + targetQuality
  return withUrlCache(cacheKey, () =>
    resolveFromBackends(pickBackends(source, targetQuality, pool), String(songId), targetQuality, musicInfo)
  )
}

// ==================== 注册请求事件 ====================

on(EVENT_NAMES.request, ({ action, source, info }) => {
  switch (action) {
    case 'musicUrl':
      return handleGetMusicUrl(source, info.musicInfo, info.type)
    default:
      return Promise.reject('action not support: ' + action)
  }
})

// ==================== 初始化音源 ====================

const SOURCE_NAMES = { tx: 'QQ音乐', wy: '网易云音乐', kw: '酷我音乐', kg: '酷狗音乐', mg: '咪咕音乐', qs: '汽水音乐' }
const musicSources = {}
MUSIC_SOURCE.forEach((item) => {
  musicSources[item] = {
    name: SOURCE_NAMES[item] || item,
    type: 'music',
    actions: ['musicUrl'],
    qualitys: MUSIC_QUALITY[item],
  }
})

send(EVENT_NAMES.inited, { status: true, openDevTools: false, sources: musicSources })

console.log('[星澜] v4.0.2 聚合音源已加载完成')
console.log('[星澜] 平台: ' + MUSIC_SOURCE.join(', '))
console.log('[星澜] QQ 主线路: 落月（api.vkeys.cn）；备用: 云记 / HYWmusic / baimusic / 官方 / 星海 / vkeys 等')
console.log('[星澜] 后端数 QQ:' + TX_BACKENDS.length + ' 网易:' + WY_BACKENDS.length + ' 酷我:' + KW_BACKENDS.length + ' 酷狗:' + KG_BACKENDS.length + ' 咪咕:' + MG_BACKENDS.length + ' 汽水:' + QS_BACKENDS.length)
console.log('[星澜] QQ Cookie: ' + (HAS_TX_COOKIE ? '已配置' : '未配置') + ' | 网易 Cookie: ' + (HAS_WY_COOKIE ? '已配置' : '未配置'))
console.log('[星澜] 缓存 ' + (CACHE_TTL / 60000) + ' 分钟 | 限流 ' + RATE_LIMIT_MAX + ' 次/' + (RATE_LIMIT_WINDOW / 1000) + ' 秒')