/*!
 * @name 溯音音源
 * @description 集成QQ、网易、酷我、咪咕音乐平台 ，QQ群1078955749
 * @version v1
 * @author 竹佀
 */

const { EVENT_NAMES, request, on, send } = globalThis.lx

// ========== 全局配置 ==========
let QQ_API_KEY = 'oiapi-ef6133b7-ac2f-dc7d-878c-d3e207a82575'

// ========== 缓存配置 ==========
const cache = new Map()
const CACHE_TTL = 300000 // 5分钟缓存

// ========== QQ音乐配置 ==========
const QQ_QUALITY_MAP = {
    '128k': { br: 7, format: 'mp3' },
    '320k': { br: 5, format: 'mp3' },
    'flac': { br: 4, format: 'flac' },
    'hires': { br: 3, format: 'flac' },
    'atmos': { br: 2, format: 'flac' },
    'master': { br: 1, format: 'flac' }
}

// ========== 主事件处理器 ==========
on(EVENT_NAMES.request, async ({ action, source, info }) => {
    try {
        switch (action) {
            case 'musicUrl':
                return await handleMusicUrl(source, info)
            case 'search':
                return await handleSearch(source, info)
            default:
                throw new Error('不支持的操作')
        }
    } catch (error) {
        console.error(`[溯音音源] ${source} ${action} 错误:`, error.message)
        throw error
    }
})

// ========== 获取音乐URL ==========
async function handleMusicUrl(source, info) {
    if (!info?.musicInfo) throw new Error('需要歌曲信息')
    
    const musicInfo = info.musicInfo
    const quality = info.type || '128k'
    
    switch (source) {
        case 'tx':
            return await getQqMusicUrl(musicInfo, quality)
        case 'wy':
            return await getWyMusicUrl(musicInfo)
        case 'kw':
            return await getKwMusicUrl(musicInfo, quality)
        case 'mg':
            return await getMgMusicUrl(musicInfo)
        default:
            throw new Error('不支持的平台')
    }
}

// ========== QQ音乐模块 ==========
async function getQqMusicUrl(musicInfo, quality) {
    if (!QQ_API_KEY) throw new Error('请先配置QQ音乐API Key')
    
    const songId = getQqSongId(musicInfo)
    if (!songId) throw new Error('歌曲缺少ID信息')
    
    const qualityConfig = QQ_QUALITY_MAP[quality] || QQ_QUALITY_MAP['128k']
    
    try {
        const params = {
            key: QQ_API_KEY,
            type: 'json',
            br: qualityConfig.br,
            n: 1
        }
        
        if (songId.type === 'mid') {
            params.mid = songId.value
        } else {
            params.songid = songId.value
        }
        
        const data = await sendRequest('https://oiapi.net/api/QQ_Music', params)
        return extractQqAudioUrl(data)
    } catch (error) {
        return await tryQqQualityFallback(songId, qualityConfig.br)
    }
}

function getQqSongId(musicInfo) {
    const mid = musicInfo.meta?.qq?.mid || 
               musicInfo.meta?.mid || 
               musicInfo.songmid ||
               (musicInfo.id && typeof musicInfo.id === 'string' && !/^\d+$/.test(musicInfo.id) ? musicInfo.id : null)
    
    if (mid) return { type: 'mid', value: mid }
    
    const songid = musicInfo.meta?.qq?.songid || 
                  musicInfo.meta?.songid || 
                  (musicInfo.id && /^\d+$/.test(musicInfo.id) ? parseInt(musicInfo.id) : null)
    
    if (songid) return { type: 'songid', value: songid }
    
    return null
}

function extractQqAudioUrl(data) {
    if (data?.music) return data.music
    if (data?.url) return data.url
    if (data?.message) {
        const match = data.message.match(/音频链接：(.+?)(?:\n|$)/)
        if (match && match[1]) return match[1]
    }
    throw new Error('未找到音频链接')
}

async function tryQqQualityFallback(songId, originalBr) {
    const brValues = [1, 2, 3, 4, 5, 7]
    
    for (const br of brValues) {
        if (br === originalBr) continue
        
        try {
            const params = {
                key: QQ_API_KEY,
                type: 'json',
                br: br,
                n: 1
            }
            
            if (songId.type === 'mid') {
                params.mid = songId.value
            } else {
                params.songid = songId.value
            }
            
            const data = await sendRequest('https://oiapi.net/api/QQ_Music', params)
            return extractQqAudioUrl(data)
        } catch (error) {
            continue
        }
    }
    
    throw new Error('所有音质尝试均失败')
}

// ========== 网易云音乐模块 ==========
async function getWyMusicUrl(musicInfo) {
    const songId = musicInfo.songmid || musicInfo.id
    if (!songId) throw new Error('缺少ID')
    
    const data = await sendRequest(`https://oiapi.net/api/Music_163?id=${songId}`)
    
    if (data.code === 0 && data.data) {
        const song = Array.isArray(data.data) ? data.data[0] : data.data
        if (song.url) return song.url
    }
    throw new Error('获取失败')
}

// ========== 酷我音乐模块 ==========
const KW_QUALITY_MAP = {
    'flac': 1,   // 无损
    '320k': 2,   // 高品质
    '128k': 3    // 标准
}

async function getKwMusicUrl(musicInfo, quality) {
    if (!musicInfo.name) throw new Error('需要歌曲名')
    
    const cacheKey = `kw_${musicInfo.name}_${musicInfo.albumName || ''}_${musicInfo.singer || ''}_${quality}`
    if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey)
        if (Date.now() - cached.timestamp < CACHE_TTL) {
            return cached.url
        }
    }
    
    const br = KW_QUALITY_MAP[quality] || 3
    const searchPriority = getSearchPriority(musicInfo)
    
    for (const term of searchPriority) {
        try {
            console.log(`[溯音音源-酷我] 尝试搜索: ${term.keyword} (严格: ${term.strict}) 音质: ${quality}`)
            const url = await fetchKwAudio(term.keyword, br, term.strict ? musicInfo : null)
            if (url) {
                cache.set(cacheKey, { url, timestamp: Date.now() })
                return url
            }
        } catch (error) {
            console.log(`[溯音音源-酷我] 搜索失败: ${term.keyword} - ${error.message}`)
        }
    }
    
    throw new Error('无法获取音频链接')
}

async function fetchKwAudio(keyword, br, checkInfo = null) {
    const data = await sendRequest('https://oiapi.net/api/Kuwo', {
        msg: keyword,
        n: 1,
        br: br
    })
    
    if (data.data?.url) {
        if (checkInfo && !checkKwMatch(data, checkInfo)) {
            throw new Error('歌曲信息不匹配')
        }
        return data.data.url
    }
    
    if (data.message) {
        const match = data.message.match(/音乐链接：(\S+)/)
        if (match) {
            if (checkInfo) {
                const songInfo = parseKwFromMessage(data.message)
                if (songInfo && !checkKwMatch(songInfo, checkInfo)) {
                    throw new Error('歌曲信息不匹配')
                }
            }
            return match[1]
        }
    }
    
    throw new Error('未找到链接')
}

function checkKwMatch(apiData, musicInfo) {
    const apiTitle = (apiData.song || apiData.data?.song || '').toLowerCase()
    const apiArtist = (apiData.singer || apiData.data?.singer || '').toLowerCase()
    const apiAlbum = (apiData.album || apiData.data?.album || '').toLowerCase()
    
    const songName = (musicInfo.name || '').toLowerCase()
    const singer = (musicInfo.singer || '').toLowerCase()
    const album = ((musicInfo.albumName || musicInfo.album) || '').toLowerCase()
    
    if (!apiTitle.includes(songName) && !songName.includes(apiTitle)) {
        return false
    }
    
    if (album && apiAlbum && !apiAlbum.includes(album) && !album.includes(apiAlbum)) {
        return false
    }
    
    if (singer && apiArtist && !apiArtist.includes(singer) && !singer.includes(apiArtist)) {
        return false
    }
    
    return true
}

function parseKwFromMessage(message) {
    if (!message) return null
    
    const lines = message.split('\n')
    const result = {}
    
    for (const line of lines) {
        if (line.includes('歌名：')) {
            result.song = line.replace('歌名：', '').trim()
        } else if (line.includes('歌手：')) {
            result.singer = line.replace('歌手：', '').trim()
        } else if (line.includes('专辑：')) {
            result.album = line.replace('专辑：', '').trim()
        }
    }
    
    return result.song ? result : null
}

// ========== 咪咕音乐模块 ==========
async function getMgMusicUrl(musicInfo) {
    if (!musicInfo.name) throw new Error('需要歌曲名称')
    
    const cacheKey = `mg_${musicInfo.name}_${musicInfo.albumName || ''}_${musicInfo.singer || ''}`
    if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey)
        if (Date.now() - cached.timestamp < CACHE_TTL) {
            return cached.url
        }
    }
    
    const searchPriority = getSearchPriority(musicInfo)
    
    for (const term of searchPriority) {
        try {
            console.log(`[溯音音源-咪咕] 尝试搜索: ${term.keyword} (严格: ${term.strict})`)
            const data = await sendRequest('https://api.xcvts.cn/api/music/migu', {
                gm: term.keyword,
                n: 1,
                num: 1,
                type: 'json'
            })
            
            if (data.code === 200 && data.music_url) {
                if (term.strict && !checkMgMatch(data, musicInfo)) {
                    console.log(`[溯音音源-咪咕] 信息不匹配: ${data.title} vs ${musicInfo.name}`)
                    throw new Error('歌曲信息不匹配')
                }
                
                cache.set(cacheKey, { url: data.music_url, timestamp: Date.now() })
                return data.music_url
            }
        } catch (error) {
            console.log(`[溯音音源-咪咕] 搜索失败: ${term.keyword} - ${error.message}`)
        }
    }
    
    throw new Error('未找到咪咕音乐链接')
}

function checkMgMatch(apiData, musicInfo) {
    const apiTitle = (apiData.title || '').toLowerCase()
    const apiArtist = (apiData.artist || '').toLowerCase()
    const apiAlbum = (apiData.album || '').toLowerCase()
    
    const songName = (musicInfo.name || '').toLowerCase()
    const singer = (musicInfo.singer || '').toLowerCase()
    const album = ((musicInfo.albumName || musicInfo.album) || '').toLowerCase()
    
    if (!apiTitle.includes(songName) && !songName.includes(apiTitle)) {
        return false
    }
    
    if (album && apiAlbum && !apiAlbum.includes(album) && !album.includes(apiAlbum)) {
        return false
    }
    
    if (singer && apiArtist && !apiArtist.includes(singer) && !singer.includes(apiArtist)) {
        return false
    }
    
    return true
}

// ========== 搜索功能 ==========
async function handleSearch(source, info) {
    if (!info?.keyword) throw new Error('需要搜索关键词')
    
    const keyword = info.keyword.trim()
    const page = info.page || 1
    const limit = Math.min(info.limit || 20, 30)
    
    switch (source) {
        case 'kw':
            return await searchKwMusic(keyword, page, limit)
        case 'mg':
            return await searchMgMusic(keyword, page, limit)
        default:
            throw new Error('该平台不支持搜索')
    }
}

async function searchKwMusic(keyword, page, limit) {
    const results = []
    const maxPages = Math.ceil(limit / 5)
    
    for (let i = page; i <= maxPages && results.length < limit; i++) {
        try {
            const data = await sendRequest('https://oiapi.net/api/Kuwo', {
                msg: keyword,
                n: i
            })
            
            const song = parseKwSong(data)
            if (song) {
                results.push(song)
            }
        } catch {}
    }
    
    if (results.length === 0) throw new Error('未找到相关歌曲')
    return results
}

async function searchMgMusic(keyword, page, limit) {
    const results = []
    
    for (let i = page; i <= page + 2 && results.length < limit; i++) {
        try {
            const data = await sendRequest('https://api.xcvts.cn/api/music/migu', {
                gm: keyword,
                n: i,
                num: 1,
                type: 'json'
            })
            
            if (data.code === 200) {
                results.push({
                    name: data.title || keyword,
                    singer: data.artist || '',
                    albumName: data.album || '',
                    id: `mg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                    source: 'mg',
                    interval: data.duration || '00:00'
                })
            }
        } catch {}
    }
    
    if (results.length === 0) throw new Error('未找到相关歌曲')
    return results
}

// ========== 核心工具函数 ==========
function getSearchPriority(musicInfo) {
    const priority = []
    
    // 第一优先级：歌名 + 专辑
    if (musicInfo.albumName || musicInfo.album) {
        const album = musicInfo.albumName || musicInfo.album
        const keyword = cleanText(musicInfo.name + album)
        if (keyword) {
            priority.push({
                keyword: keyword,
                strict: true,
                type: 'name+album'
            })
        }
    }
    
    // 第二优先级：歌名 + 歌手
    if (musicInfo.singer) {
        const keyword = cleanText(musicInfo.name + musicInfo.singer)
        if (keyword) {
            priority.push({
                keyword: keyword,
                strict: true,
                type: 'name+singer'
            })
        }
    }
    
    // 第三优先级：仅歌名
    const keyword = cleanText(musicInfo.name)
    if (keyword) {
        priority.push({
            keyword: keyword,
            strict: false,
            type: 'name'
        })
    }
    
    return priority
}

function parseKwSong(data) {
    const songInfo = data.data || data
    if (!songInfo?.song) {
        if (data.message) {
            const parsed = parseKwFromMessage(data.message)
            if (parsed?.song) {
                songInfo.song = parsed.song
                songInfo.singer = parsed.singer
                songInfo.album = parsed.album
            }
        }
    }
    
    if (!songInfo?.song) return null
    
    const duration = parseInt(songInfo.time) || 0
    const minutes = Math.floor(duration / 60)
    const seconds = duration % 60
    
    return {
        name: songInfo.song,
        singer: songInfo.singer || '',
        albumName: songInfo.album || '',
        id: songInfo.rid || `kw_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        source: 'kw',
        interval: `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`,
        meta: {
            picture: songInfo.picture || ''
        }
    }
}

function sendRequest(baseUrl, params = {}) {
    return new Promise((resolve, reject) => {
        const query = Object.keys(params)
            .map(k => `${k}=${encodeURIComponent(params[k])}`)
            .join('&')
        const url = `${baseUrl}${query ? '?' + query : ''}`
        
        request(url, {
            method: 'GET',
            timeout: 8000
        }, (err, resp) => {
            if (err) {
                reject(new Error(`请求失败: ${err.message}`))
                return
            }
            
            try {
                const data = typeof resp.body === 'string' ? JSON.parse(resp.body) : resp.body
                resolve(data)
            } catch (e) {
                reject(new Error('响应格式错误'))
            }
        })
    })
}

function cleanText(text) {
    if (!text) return ''
    return text
        .replace(/\(\s*Live\s*\)/gi, '')
        .replace(/\([^)]*\)/g, '')
        .replace(/\s+/g, '')
        .replace(/[^\w\u4e00-\u9fa5]/g, '')
        .trim()
}

// ========== 配置界面 ==========
on(EVENT_NAMES.showConfigView, () => {
    const view = {
        title: '溯音音源配置',
        width: 450,
        height: 200,
        config: [{
            key: 'qq_api_key',
            type: 'input',
            title: 'QQ音乐API Key',
            placeholder: '输入oiapi密钥',
            value: QQ_API_KEY,
            description: '用于获取QQ音乐的高品质音源'
        }],
        onSave: (config) => {
            QQ_API_KEY = config.qq_api_key.trim()
            return {
                result: true,
                message: QQ_API_KEY ? '密钥已保存' : '密钥已清空'
            }
        }
    }
    
    send(EVENT_NAMES.showConfigView, view)
})

// ========== 初始化 ==========
const registeredSources = {
    tx: {
        name: 'QQ音乐',
        type: 'music',
        actions: ['musicUrl'],
        qualitys: Object.keys(QQ_QUALITY_MAP),
        features: ['idOnly'],
        defaultQuality: '128k'
    },
    wy: {
        name: '网易云音乐',
        type: 'music',
        actions: ['musicUrl'],
        qualitys: ['128k', '320k', 'flac']
    },
    kw: {
        name: '酷我音乐',
        type: 'music',
        actions: ['musicUrl', 'search'],
        qualitys: ['128k', '320k', 'flac'],
        supportSearchSuggestions: true
    },
    mg: {
        name: '咪咕音乐',
        type: 'music',
        actions: ['musicUrl', 'search'],
        qualitys: ['128k', '320k'],
        supportSearchSuggestions: false
    }
}

send(EVENT_NAMES.inited, {
    openDevTools: false,
    sources: registeredSources
})

console.log('[溯音音源] v1 已加载 - 支持QQ、网易、酷我、咪咕音乐')