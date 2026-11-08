/*!
 * @name 非常刀
 * @description 聚合音源，进群链接 https://t.me/gydjlfk
 * @version v5
 * @author 群主要进去
 */

const { EVENT_NAMES, request, on, send } = globalThis.lx

// ========== API 端点 ==========
const CHKSZ_API = 'https://api.chksz.top/api'
const XINGHAI_API = 'https://music-api.gdstudio.xyz/api.php?use_xbridge3=true&loader_name=forest&need_sec_link=1&sec_link_scene=im&theme=light'
const SUYIN_QQ_API = 'https://oiapi.net/api/QQ_Music'
const SUYIN_QQ_KEY = 'oiapi-ef6133b7-ac2f-dc7d-878c-d3e207a82575'
const SUYIN_163_API = 'https://oiapi.net/api/Music_163'
const SUYIN_KW_API = 'https://oiapi.net/api/Kuwo'
const SUYIN_MG_API = 'https://api.xcvts.cn/api/music/migu'
const QISHUI_SEARCH_API = 'https://api-vehicle.volcengine.com/v2/search/type'
const QISHUI_H5_API = 'https://api.qishui.com/luna/h5/track'

// ========== 音质映射 ==========
const CHKSZ_LEVEL = { '128k': 'standard', '320k': 'exhigh', 'flac': 'lossless', 'flac24bit': 'jymaster' }
const CHKSZ_FALLBACK = {
  jymaster: ['jymaster', 'lossless', 'exhigh', 'standard'],
  lossless: ['lossless', 'exhigh', 'standard'],
  exhigh: ['exhigh', 'standard'],
  standard: ['standard'],
}
const XINGHAI_BR = { '128k': '128', '192k': '192', '320k': '320', 'flac': '740', 'flac24bit': '999' }
const XINGHAI_SRC = { wy: 'netease', tx: 'tencent', kw: 'kuwo', kg: 'kugou', mg: 'migu' }
const SUYIN_QQ_BR = { '128k': 7, '320k': 5, 'flac': 4, 'hires': 3, 'flac24bit': 1, 'master': 1 }
const SUYIN_KW_BR = { 'flac': 1, '320k': 5, '128k': 7 }

// ========== 长青/念心 URL 模板 ==========
const CHANGQING = {
  tx: 'http://175.27.166.236/kgqq/qq.php?type=mp3&id={id}&level={level}',
  wy: 'http://175.27.166.236/wy/wy.php?type=mp3&id={id}&level={level}',
  kw: 'https://musicapi.haitangw.net/music/kw.php?type=mp3&id={id}&level={level}',
  kg: 'https://music.haitangw.cc/kgqq/kg.php?type=mp3&id={id}&level={level}',
  mg: 'https://music.haitangw.cc/musicapi/mg.php?type=mp3&id={id}&level={level}',
}
const NIANXIN = {
  tx: 'https://music.nxinxz.com/kgqq/tx.php?id={id}&level={level}&type=mp3',
  wy: 'http://music.nxinxz.com/wy.php?id={id}&level={level}&type=mp3',
  kw: 'http://music.nxinxz.com/kw.php?id={id}&level={level}&type=mp3',
  kg: 'https://music.nxinxz.com/kgqq/kg.php?id={id}&level={level}&type=mp3',
  mg: 'http://music.nxinxz.com/mg.php?id={id}&level={level}&type=mp3',
}

// ========== 缓存 ==========
const cache = new Map()
const CACHE_TTL = 300000
const CACHE_MAX = 200

function cacheGet(key) {
  const c = cache.get(key)
  if (!c) return null
  if (Date.now() - c.ts > CACHE_TTL) { cache.delete(key); return null }
  return c.val
}

function cacheSet(key, val) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
  cache.set(key, { val, ts: Date.now() })
}

// ========== 工具函数 ==========
function httpGet(url, { timeout = 10000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    request(url, { method: 'GET', timeout, headers: { Accept: 'application/json', ...headers } }, (err, resp) => {
      if (err) return reject(new Error(err.message))
      try {
        resolve(typeof resp.body === 'string' ? JSON.parse(resp.body) : resp.body)
      } catch { reject(new Error('响应解析失败')) }
    })
  })
}

function validateUrl(url) {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) return url
  throw new Error('无效URL')
}

function getSongId(info) {
  return (info.hash || info.songmid || info.id || info.rid || info.songId || '').toString()
}

function getQqSongId(info) {
  const mid = info.meta?.qq?.mid || info.meta?.mid || info.songmid || (typeof info.id === 'string' && !/^\d+$/.test(info.id) ? info.id : null)
  if (mid) return { type: 'mid', value: mid }
  const songid = info.meta?.qq?.songid || info.meta?.songid || info.id
  if (songid) return { type: 'songid', value: songid }
  return null
}

function qualityToLevel(q) {
  if (['flac', 'flac24bit', '24bit', 'hires', 'master'].includes(q)) return 'lossless'
  if (['320k', '192k'].includes(q)) return 'exhigh'
  return 'standard'
}

function cleanText(text) {
  if (!text) return ''
  return text.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, '').replace(/[【】《》"""'''·,，。!！?？:：;；/\\|\-]/g, '').trim().toLowerCase()
}

function formatDuration(ms) {
  const sec = typeof ms === 'number' ? Math.floor(ms > 1000 ? ms / 1000 : ms) : 0
  if (sec <= 0) return '00:00'
  return `${Math.floor(sec / 60).toString().padStart(2, '0')}:${(sec % 60).toString().padStart(2, '0')}`
}

function buildSearchKeywords(info) {
  const kws = []
  if (info.singer) kws.push({ kw: `${info.name} ${info.singer}`, strict: true })
  if (info.albumName || info.album) kws.push({ kw: `${info.name} ${info.albumName || info.album}`, strict: true })
  kws.push({ kw: info.name, strict: false })
  return kws
}

function checkSongMatch(apiName, apiArtist, musicInfo) {
  const a = cleanText(apiName), b = cleanText(musicInfo.name || '')
  if (!a || !b || (!a.includes(b) && !b.includes(a))) return false
  const singer = cleanText(musicInfo.singer || '')
  if (singer) {
    const c = cleanText(apiArtist || '')
    if (c && !c.includes(singer) && !singer.includes(c)) return false
  }
  return true
}

// ========== Provider: CHKSZ (网易云) ==========
async function chkszGetUrl(info, quality) {
  const level = CHKSZ_LEVEL[quality] || 'standard'
  const levels = CHKSZ_FALLBACK[level] || ['standard']
  const id = getSongId(info)
  if (!id) throw new Error('缺少ID')
  for (const lv of levels) {
    try {
      const body = await httpGet(`${CHKSZ_API}/163_music?id=${id}&level=${lv}`, { headers: { Referer: 'https://cp.chksz.top/' } })
      if (body?.code === 200 && body.data?.url) return body.data.url
    } catch { continue }
  }
  throw new Error('CHKSZ失败')
}

// ========== Provider: 星海 (全平台) ==========
async function xinghaiGetUrl(platform, info, quality) {
  const source = XINGHAI_SRC[platform]
  const br = XINGHAI_BR[quality] || '320'
  const id = getSongId(info)
  if (!source || !id) throw new Error('参数缺失')
  const body = await httpGet(`${XINGHAI_API}&types=url&source=${source}&id=${encodeURIComponent(id)}&br=${br}`)
  return validateUrl(body?.url)
}

// ========== Provider: 溯音QQ ==========
async function suyinQQGetUrl(info, quality) {
  const qqId = getQqSongId(info)
  if (!qqId) throw new Error('缺少QQ歌曲ID')
  const startBr = SUYIN_QQ_BR[quality] || 5
  const brs = [...new Set([startBr, 4, 5, 7])]
  for (const br of brs) {
    try {
      const params = `key=${SUYIN_QQ_KEY}&type=json&br=${br}&n=1&${qqId.type}=${qqId.value}`
      const body = await httpGet(`${SUYIN_QQ_API}?${params}`)
      const url = body?.data?.music || body?.data?.url || extractUrlFromMsg(body?.data?.message || body?.message)
      if (url) return validateUrl(url)
    } catch { continue }
  }
  throw new Error('溯音QQ失败')
}

function extractUrlFromMsg(msg) {
  if (!msg) return null
  const m = msg.match(/https?:\/\/[^\s"'<>]+/)
  return m ? m[0] : null
}

// ========== Provider: 溯音163 ==========
async function suyin163GetUrl(info) {
  const id = getSongId(info)
  if (!id) throw new Error('缺少ID')
  const body = await httpGet(`${SUYIN_163_API}?id=${id}`)
  const data = Array.isArray(body?.data) ? body.data[0] : body?.data
  return validateUrl(data?.url)
}

// ========== Provider: 溯音酷我 (搜索式) ==========
async function suyinKwGetUrl(info, quality) {
  const br = SUYIN_KW_BR[quality] || 5
  for (const { kw, strict } of buildSearchKeywords(info)) {
    try {
      const body = await httpGet(`${SUYIN_KW_API}?msg=${encodeURIComponent(kw)}&n=1&br=${br}`)
      const url = body?.data?.url || extractUrlFromMsg(body?.data?.message || body?.message)
      if (url && (!strict || checkSongMatch(body?.data?.song || '', body?.data?.singer || '', info)))
        return validateUrl(url)
    } catch { continue }
  }
  throw new Error('溯音酷我失败')
}

// ========== Provider: 溯音咪咕 (搜索式) ==========
async function suyinMgGetUrl(info) {
  for (const { kw, strict } of buildSearchKeywords(info)) {
    try {
      const body = await httpGet(`${SUYIN_MG_API}?gm=${encodeURIComponent(kw)}&n=1&num=1&type=json`)
      if (body?.code === 200 && body?.music_url) {
        if (!strict || checkSongMatch(body.title || '', body.artist || '', info))
          return validateUrl(body.music_url)
      }
    } catch { continue }
  }
  throw new Error('溯音咪咕失败')
}

// ========== Provider: 模板URL (长青/念心) ==========
async function templateGetUrl(platform, info, quality, templates) {
  const tpl = templates[platform]
  if (!tpl) throw new Error('模板不支持该平台')
  const id = getSongId(info)
  if (!id) throw new Error('缺少ID')
  const level = qualityToLevel(quality)
  const url = tpl.replace('{id}', encodeURIComponent(id)).replace('{level}', level)
  const body = await httpGet(url)
  return validateUrl(body?.url || body?.data?.url || extractUrlFromMsg(typeof body === 'string' ? body : JSON.stringify(body)))
}

// ========== Provider: 汽水H5 (免费直链) ==========
async function qishuiH5GetUrl(info) {
  const id = getSongId(info)
  if (!id) throw new Error('缺少ID')
  const body = await httpGet(`${QISHUI_H5_API}?track_id=${id}`)
  const songStr = body?.track_player?.video_model
  if (!songStr) throw new Error('汽水H5无数据')
  const song = JSON.parse(songStr).video_list?.[0]
  if (!song?.main_url) throw new Error('汽水H5无链接')
  return validateUrl(song.main_url)
}

// ========== 回退链 ==========
const CHAINS = {
  wy: [
    { name: 'CHKSZ', fn: (si, q) => chkszGetUrl(si, q) },
    { name: '星海', fn: (si, q) => xinghaiGetUrl('wy', si, q) },
    { name: '溯音163', fn: (si, q) => suyin163GetUrl(si) },
    { name: '长青', fn: (si, q) => templateGetUrl('wy', si, q, CHANGQING) },
    { name: '念心', fn: (si, q) => templateGetUrl('wy', si, q, NIANXIN) },
  ],
  tx: [
    { name: '溯音QQ', fn: (si, q) => suyinQQGetUrl(si, q) },
    { name: '星海', fn: (si, q) => xinghaiGetUrl('tx', si, q) },
    { name: '长青', fn: (si, q) => templateGetUrl('tx', si, q, CHANGQING) },
    { name: '念心', fn: (si, q) => templateGetUrl('tx', si, q, NIANXIN) },
  ],
  kw: [
    { name: '星海', fn: (si, q) => xinghaiGetUrl('kw', si, q) },
    { name: '溯音酷我', fn: (si, q) => suyinKwGetUrl(si, q) },
    { name: '长青', fn: (si, q) => templateGetUrl('kw', si, q, CHANGQING) },
    { name: '念心', fn: (si, q) => templateGetUrl('kw', si, q, NIANXIN) },
  ],
  kg: [
    { name: '星海', fn: (si, q) => xinghaiGetUrl('kg', si, q) },
    { name: '长青', fn: (si, q) => templateGetUrl('kg', si, q, CHANGQING) },
    { name: '念心', fn: (si, q) => templateGetUrl('kg', si, q, NIANXIN) },
  ],
  mg: [
    { name: '星海', fn: (si, q) => xinghaiGetUrl('mg', si, q) },
    { name: '溯音咪咕', fn: (si, q) => suyinMgGetUrl(si) },
    { name: '长青', fn: (si, q) => templateGetUrl('mg', si, q, CHANGQING) },
    { name: '念心', fn: (si, q) => templateGetUrl('mg', si, q, NIANXIN) },
  ],
  qs: [
    { name: '汽水H5', fn: (si, q) => qishuiH5GetUrl(si) },
  ],
}

async function getUrlWithFallback(platform, songInfo, quality) {
  const chain = CHAINS[platform]
  if (!chain) throw new Error('不支持的平台')

  const key = `url_${platform}_${getSongId(songInfo)}_${quality}`
  const cached = cacheGet(key)
  if (cached) return cached

  // Phase 1: 前3个源并发竞速
  const concurrent = chain.slice(0, 3)
  try {
    const url = await Promise.any(concurrent.map(s => s.fn(songInfo, quality).then(validateUrl)))
    cacheSet(key, url)
    return url
  } catch {}

  // Phase 2: 剩余源顺序尝试
  for (const s of chain.slice(3)) {
    try {
      const url = validateUrl(await s.fn(songInfo, quality))
      cacheSet(key, url)
      return url
    } catch { continue }
  }

  throw new Error('所有音源均失败')
}

// ========== 事件处理 ==========
on(EVENT_NAMES.request, async ({ action, source, info }) => {
  try {
    switch (action) {
      case 'musicUrl': return await handleMusicUrl(source, info)
      case 'search': return await handleSearch(source, info)
      case 'lyric': return await handleLyric(source, info)
      default: throw new Error('不支持的操作')
    }
  } catch (error) {
    console.error(`[非常刀] ${source} ${action} 错误:`, error.message)
    throw error
  }
})

async function handleMusicUrl(source, info) {
  if (!info?.musicInfo) throw new Error('需要歌曲信息')
  return await getUrlWithFallback(source, info.musicInfo, info.type || '128k')
}

// ========== 搜索 ==========
async function handleSearch(source, info) {
  if (!info?.keyword) throw new Error('需要搜索关键词')
  const keyword = info.keyword.trim()
  const limit = Math.min(info.limit || 20, 30)

  switch (source) {
    case 'wy': return await searchChksz(keyword, limit)
    case 'kw': return await searchKuwo(keyword, limit)
    case 'mg': return await searchMigu(keyword, limit)
    case 'qs': return await searchQishui(keyword, limit)
    default: throw new Error('该平台不支持搜索')
  }
}

async function searchChksz(keyword, limit) {
  const body = await httpGet(`${CHKSZ_API}/163_search?keyword=${encodeURIComponent(keyword)}&limit=${limit}`, { headers: { Referer: 'https://cp.chksz.top/' } })
  if (body?.code !== 200) throw new Error('搜索失败')
  const items = Array.isArray(body.data) ? body.data : (body.data?.songs || [])
  if (!items.length) throw new Error('未找到相关歌曲')
  return items.slice(0, limit).map(s => ({
    name: s.name || '', singer: s.artists || '',
    albumName: typeof s.album === 'string' ? s.album : (s.album?.name || ''),
    id: s.id, source: 'wy', interval: formatDuration(s.duration),
    meta: { picture: s.picUrl || '', wy: { id: s.id, url_id: s.id, lyric_id: s.id } }
  }))
}

async function searchKuwo(keyword, limit) {
  const results = []
  for (let page = 1; results.length < limit && page <= 3; page++) {
    try {
      const body = await httpGet(`${SUYIN_KW_API}?msg=${encodeURIComponent(keyword)}&n=${page}`)
      const d = body?.data
      if (!d?.song) break
      results.push({
        name: d.song || '', singer: d.singer || '', albumName: d.album || '',
        id: d.rid || `kw_${Date.now()}_${page}`, source: 'kw',
        interval: formatDuration(d.duration || d.time),
        meta: { kw: { id: d.rid || d.id } }
      })
    } catch { break }
  }
  if (!results.length) throw new Error('未找到相关歌曲')
  return results
}

async function searchMigu(keyword, limit) {
  const results = []
  for (let page = 1; results.length < limit && page <= 3; page++) {
    try {
      const body = await httpGet(`${SUYIN_MG_API}?gm=${encodeURIComponent(keyword)}&n=${page}&num=1&type=json`)
      if (body?.code !== 200 || !body.title) break
      results.push({
        name: body.title || '', singer: body.artist || '', albumName: body.album || '',
        id: `mg_${Date.now()}_${page}`, source: 'mg', interval: body.duration || '00:00',
        meta: { mg: { id: body.id || '' } }
      })
    } catch { break }
  }
  if (!results.length) throw new Error('未找到相关歌曲')
  return results
}

// ========== 歌词 ==========
async function handleLyric(source, info) {
  if (source !== 'qs') throw new Error('该平台不支持歌词')
  const id = getSongId(info?.musicInfo || {})
  if (!id) throw new Error('缺少ID')
  const body = await httpGet(`${QISHUI_H5_API}?track_id=${id}`)
  const raw = body?.lyric?.content || ''
  if (!raw) throw new Error('无歌词')
  return { lyric: krcToLrc(raw) }
}

function krcToLrc(krc) {
  const lines = krc.split('\n')
  const result = []
  for (const line of lines) {
    const m = line.match(/^\[(\d+),(\d+)\](.*)$/)
    if (!m) continue
    const startMs = parseInt(m[1])
    const min = Math.floor(startMs / 60000)
    const sec = Math.floor((startMs % 60000) / 1000)
    const ms = Math.floor((startMs % 1000) / 10)
    const text = m[3].replace(/<\d+,\d+,\d+>/g, '')
    if (text.trim()) result.push(`[${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}.${String(ms).padStart(2,'0')}]${text}`)
  }
  return result.join('\n')
}

async function searchQishui(keyword, limit) {
  const body = await httpGet(`${QISHUI_SEARCH_API}?keyword=${encodeURIComponent(keyword)}&search_type=music&limit=${limit}&real_offset=0&search_source=qishui`)
  const items = body?.data?.list
  if (!Array.isArray(items) || !items.length) throw new Error('未找到相关歌曲')
  return items.slice(0, limit).map(s => ({
    name: s.title || '', singer: s.author_info?.name || '', albumName: '',
    id: s.item_id, source: 'qs', interval: formatDuration(s.duration),
    img: s.cover_url || '',
    meta: { picture: s.cover_url || '', qs: { id: s.item_id } }
  }))
}

// ========== 初始化 ==========
send(EVENT_NAMES.inited, {
  openDevTools: false,
  sources: {
    wy: { name: '网易云音乐', type: 'music', actions: ['musicUrl', 'search'], qualitys: ['128k', '320k', 'flac', 'flac24bit'], defaultQuality: 'flac' },
    tx: { name: 'QQ音乐', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac', 'flac24bit'] },
    kw: { name: '酷我音乐', type: 'music', actions: ['musicUrl', 'search'], qualitys: ['128k', '320k', 'flac'] },
    kg: { name: '酷狗音乐', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac', 'flac24bit'] },
    mg: { name: '咪咕音乐', type: 'music', actions: ['musicUrl', 'search'], qualitys: ['128k', '320k', 'flac'] },
    qs: { name: '汽水音乐', type: 'music', actions: ['musicUrl', 'search', 'lyric'], qualitys: ['128k'] },
  }
})

console.log('[非常刀] v4 已加载 - 网易/QQ/酷我/酷狗/咪咕/汽水 多源聚合')