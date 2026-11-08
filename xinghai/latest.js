/*!
 * @name         星海音乐源
 * @description  GDAPI | 聚合 | ChKSz API | 全平台支持 24bit FLAC，网易、酷狗、QQ 最高支持母带｜建议与反馈：https://yy.zddyr.top/survey.php?k=192ee708d4721bc9077f8f1738296c1b
 * @version      v3.2.18
 * @author       万去了了 / 科学大魔王
 * @homepage     https://zddyr.top/
 * @see          http://gc.kxwa.top/
 * @lastUpdate   2026-11-08
 * @update       优化酷我：修复部分歌曲取链接失败
 * @update       使用体验反馈：https://yy.zddyr.top/survey.php?k=192ee708d4721bc9077f8f1738296c1b
 * @license      仅供学习交流，请支持正版
 */

const { EVENT_NAMES, request, on, send, env } = globalThis.lx;

// ==================== 用户配置区域 ====================
const KW_DECRYPT_PROXY = {
    url: '',
    allowEncryptedLossless: false,
    urlParamName: 'url',
    ekeyParamName: 'ekey',
};

const CHKSZ_CONFIG = {
    apikey: '',
    enableNetease: true,
    enableQQ: true,
};

// 卡密（可选）：填了就能用 QQ 等「仅认证用户」音源，不填只能走基础音源
const LICENSE_CONFIG = {
    code: '',
};
// ====================================================

const URL_CONFIG = {
    domains: {
        primary: 'yy.zddyr.top',
        gdStudio: 'music-api.gdstudio.xyz',
        chkszNew: 'api.chksz.com'
    },
    paths: {
        backend: '/lx/api/',
        version: '/lx/versionh2.php',
        update: '/lx/vers.php',
        ip: '/ip.php',
        gdApi: '/api.php',
        chkszNetease: '/api/163_music',
        chkszQQ: '/api/qq_music'
    },
    gdParams: 'use_xbridge3=true&loader_name=forest&need_sec_link=1&sec_link_scene=im&theme=light'
};

const buildUrl = (domainKey, pathKey, extraQuery = '') => {
    const domain = URL_CONFIG.domains[domainKey];
    const path = URL_CONFIG.paths[pathKey];
    if (!domain || !path) throw new Error(`URL配置错误: ${domainKey} / ${pathKey}`);
    let url = `https://${domain}${path}`;
    if (extraQuery) {
        if (extraQuery.startsWith('&') && !path.includes('?')) {
            url += '?' + extraQuery.substring(1);
        } else {
            url += extraQuery;
        }
    }
    return url;
};

const SCRIPT_VERSION = 'v3.2.18';
const SCRIPT_NAME = 'XingHaiMusicSource';
const SOURCE_MAP = { tx: 'qq', mg: 'migu', kw: 'kw', kg: 'kg', qs: 'qs' };
const PLATFORM_NAMES = { wy: '网易云音乐', tx: 'QQ音乐', kw: '酷我音乐', kg: '酷狗音乐', mg: '咪咕音乐', qs: '汽水音乐' };
const MUSIC_QUALITIES = {
    wy: ['128k','320k','flac','hires','atmos','master'],
    tx: ['128k','192k','320k','flac','hires','atmos','atmos_plus','master'],
    // 上游没有真母带：master / hires 与 flac 拿到的是同一个文件（16bit/44.1kHz），
    // 有全景声资源的曲子还会给 4 声道有损 Ogg，兼容性反而更差。最高只留无损。
    kw: ['128k','320k','flac'],
    kg: ['128k','320k','flac','hires','atmos','master'],
    mg: ['128k','320k','flac'],
    qs: ['128k','320k','flac','spatial','hires']
};

const CHKSZ_NETEASE_LEVEL_MAP = {
    '128k': 'standard', '320k': 'exhigh', 'flac': 'lossless',
    'hires': 'hires', 'atmos': 'jymaster', 'master': 'jymaster'
};

const CHKSZ_QQ_SIZE_MAP = {
    '128k': '128k', '192k': '320k', '320k': '320k',
    'flac': 'flac', 'hires': 'hires',
    'atmos': 'master', 'atmos_plus': 'master', 'master': 'master'
};

const GD_BR_MAP = { '128k':'128', '320k':'320', 'flac':'740', 'hires':'999' };
const GD_SUPPORTED_QUALITIES = new Set(['128k','320k','flac','hires']);

const TOKEN_TTL = 4 * 60 * 1000;   // 服务端有效期 5 分钟，本地提前 1 分钟换新，避开边界过期

let userIp = null;
let userToken = '';
let tokenTimestamp = 0;
let clientHeader = '';
let deviceId = '';
let availablePlatforms = [];
let backendAggBlocked = false;
const extraCache = new Map();

// -------------------- 工具函数 --------------------
function isBuffer(obj) {
    return obj && typeof obj === 'object' &&
        ((typeof Buffer !== 'undefined' && Buffer.isBuffer(obj)) ||
        (typeof obj.constructor === 'function' && obj.constructor.name === 'Buffer'));
}

function safeParseBody(body) {
    if (typeof body === 'string') {
        const trimmed = body.trim();
        if (/^[{["]/.test(trimmed)) { try { return JSON.parse(trimmed); } catch (e) {} }
        return body;
    }
    if (typeof body === 'object' && body !== null) {
        try { if (typeof body.toString === 'function' && body.toString() !== '[object Object]') body = body.toString('utf-8'); } catch (e) {}
        if (typeof body === 'object' && !isBuffer(body)) return body;
    }
    try {
        if (isBuffer(body)) {
            if (globalThis.lx?.utils?.buffer?.bufToString) body = globalThis.lx.utils.buffer.bufToString(body, 'utf-8');
            else if (typeof Buffer !== 'undefined') body = Buffer.from(body).toString('utf-8');
            else body = String(body);
        }
    } catch (e) {}
    if (typeof body === 'string') {
        const trimmed = body.trim();
        if (/^[{["]/.test(trimmed)) { try { return JSON.parse(trimmed); } catch (e) {} }
    }
    return body;
}

function safeBase64Encode(str) {
    try {
        if (globalThis.lx?.utils?.buffer?.from) {
            const buf = globalThis.lx.utils.buffer.from(str, 'utf-8');
            return globalThis.lx.utils.buffer.bufToString(buf, 'base64');
        }
        if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf-8').toString('base64');
        return btoa(unescape(encodeURIComponent(str)));
    } catch (e) {
        return str;
    }
}

function simpleGetQueryParam(url, key) {
    if (typeof url !== 'string' || !url) return null;
    const qIdx = url.indexOf('?');
    if (qIdx < 0) return null;
    let query = url.substring(qIdx + 1);
    const hashIdx = query.indexOf('#');
    if (hashIdx >= 0) query = query.substring(0, hashIdx);
    const pairs = query.split('&');
    for (const p of pairs) {
        const eq = p.indexOf('=');
        if (eq < 0) continue;
        if (p.substring(0, eq) === key) {
            try { return decodeURIComponent(p.substring(eq + 1)); } catch (e) { return p.substring(eq + 1); }
        }
    }
    return null;
}

function generateDeviceId() {
    return 'lx-online-' + Math.random().toString(36).substring(2, 8) + Date.now().toString(36).slice(-4);
}

function buildClientHeader() {
    let deviceType = 'unknown';
    try {
        const p = (env?.platform || '').toLowerCase();
        if (p.includes('android')) deviceType = 'Android';
        else if (p.includes('ios')) deviceType = 'iOS';
        else if (p.includes('win')) deviceType = 'Windows';
        else if (p.includes('mac')) deviceType = 'macOS';
        else if (p.includes('linux')) deviceType = 'Linux';
    } catch (e) {}
    return `${SCRIPT_NAME}/${SCRIPT_VERSION} (${deviceType})`;
}

// 令牌只能由服务器签发（/lx/api/token.php）。
// 以前是本地拼一段 base64 就当令牌，服务端从 2026-11 起不再承认这种自签令牌，
// 必须拿服务器用私有密钥签出的 xh3. 令牌，否则一律 403。
let tokenPromise = null;

function fetchServerToken() {
    if (!deviceId) deviceId = generateDeviceId();
    const url = `${buildUrl('primary', 'backend')}token.php?device_id=${encodeURIComponent(deviceId)}`;
    return new Promise((resolve) => {
        request(url, {
            method: 'GET',
            timeout: 6000,
            headers: { 'User-Agent': 'lx-music', 'X-Client': clientHeader || 'LX-Music-Mobile' }
        }, (err, resp) => {
            if (err) return resolve('');
            try {
                const b = safeParseBody(resp.body);
                const tk = b && b.data && b.data.token;
                resolve(typeof tk === 'string' ? tk : '');
            } catch (e) { resolve(''); }
        });
    });
}

async function ensureTokenFresh(force = false) {
    if (!force && userToken && (Date.now() - tokenTimestamp) <= TOKEN_TTL) return;
    if (!tokenPromise) tokenPromise = fetchServerToken();
    let tk = '';
    try { tk = await tokenPromise; } catch (e) { tk = ''; }
    tokenPromise = null;
    if (tk) {
        userToken = tk;
        tokenTimestamp = Date.now();
    }
}

// 服务端判定令牌不可用（过期 / 换网导致 IP 不符 / 非服务器签发）时刷新一次重试
function needRefreshToken(resp) {
    const a = resp && resp.body && resp.body.auth;
    if (!a) return false;
    if (a.tk_mismatch === true) return true;
    if (a.device_id === 'untrusted-token' || a.tk_error) return true;
    return false;
}

// 所有请求都必须带服务器签发的令牌。
// 拿不到令牌就不发请求 —— 没有令牌的请求服务端一律按未授权处理，
// 与其发出去被拒，不如把原因直接抛给上层。
const httpFetch = async (url, options = {}, retried = false) => {
    await ensureTokenFresh();
    if (!userToken) throw new Error('获取服务器令牌失败，请检查网络后重试');
    const headers = { ...(options.headers || {}) };
    headers['X-Token'] = userToken;
    if (clientHeader) headers['X-Client'] = clientHeader;
    const code = (LICENSE_CONFIG.code || '').trim();
    if (code) headers['X-License'] = code;
    if (!headers['User-Agent']) headers['User-Agent'] = 'lx-music';
    const out = await new Promise((resolve, reject) => {
        request(url, { ...options, headers }, (err, resp) => {
            if (err) return reject(err);
            resolve({ body: safeParseBody(resp.body), statusCode: resp.statusCode, headers: resp.headers || {} });
        });
    });
    if (!retried && needRefreshToken(out)) {
        userToken = '';
        tokenTimestamp = 0;
        tokenPromise = null;
        await ensureTokenFresh(true);
        return httpFetch(url, options, true);
    }
    return out;
};

function mapQuality(target, avail) {
    const pm = {
        '臻品母带': 'jymaster', '臻品音质2.0': 'sky', '臻品音质AI': 'jyeffect',
        '臻品音质': 'jyeffect', 'Hires 无损24-Bit': 'hires', 'Hi-Res': 'hires',
        'FLAC': 'flac', '320k': '320k', '192k': '192k', '128k': '128k',
        '空间音频': 'spatial', 'Spatial': 'spatial'
    };
    if (avail.includes(target)) return target;
    const m = pm[target]; if (m && avail.includes(m)) return m;
    const order = ['jymaster', 'sky', 'jyeffect', 'hires', 'flac24bit', 'spatial', 'master', 'flac', '320k', '192k', '128k'];
    for (const q of order) if (avail.includes(q)) return q;
    return avail[0] || '128k';
}

// -------------------- 酷我加密链接处理 --------------------
function processKwEncryptedUrl(data, source) {
    if (source !== 'kw' || !KW_DECRYPT_PROXY.allowEncryptedLossless) {
        return data?.url || '';
    }
    let ekey = null;
    if (data?.ekey) {
        ekey = typeof data.ekey === 'string' ? data.ekey.trim() : String(data.ekey).trim();
    }
    if (!ekey && data?.url && typeof data.url === 'string') {
        ekey = simpleGetQueryParam(data.url, 'ekey');
    }
    if (!ekey || !KW_DECRYPT_PROXY.url) {
        return data?.url || '';
    }
    const rawUrl = typeof data.url === 'string' ? data.url : String(data.url);
    try {
        return `${KW_DECRYPT_PROXY.url}?${KW_DECRYPT_PROXY.urlParamName}=${encodeURIComponent(rawUrl)}&${KW_DECRYPT_PROXY.ekeyParamName}=${encodeURIComponent(ekey)}`;
    } catch (e) {
        return rawUrl;
    }
}

// -------------------- 网络接口 --------------------
async function fetchIp() {
    try {
        const r = await httpFetch(buildUrl('primary', 'ip'), { timeout: 3000 });
        if (r.body?.ip) {
            userIp = r.body.ip;
        }
    } catch (e) {}
}

async function getWyChkszUrl(id, quality) {
    const level = CHKSZ_NETEASE_LEVEL_MAP[quality];
    if (!level) throw new Error('chksz不支持该品质');
    const url = `https://${URL_CONFIG.domains.chkszNew}${URL_CONFIG.paths.chkszNetease}?id=${id}&level=${level}&apikey=${encodeURIComponent(CHKSZ_CONFIG.apikey)}`;
    const resp = await httpFetch(url, { headers: { 'User-Agent': 'LX-Music-Mobile' }, timeout: 8000 });
    if (resp.statusCode !== 200 || resp.body.code !== 200 || !resp.body.data?.url) {
        throw new Error(`chksz网易失败(${resp.statusCode}): ${resp.body?.msg || '未返回url'}`);
    }
    return { url: resp.body.data.url, lyric: null, cover: resp.body.data.picUrl || null };
}

async function getTxChkszUrl(musicInfo, quality) {
    const size = CHKSZ_QQ_SIZE_MAP[quality];
    if (!size) throw new Error('chksz不支持该品质');
    const mid = musicInfo.songmid || musicInfo.id;
    if (!mid) throw new Error('缺少QQ mid');
    const url = `https://${URL_CONFIG.domains.chkszNew}${URL_CONFIG.paths.chkszQQ}?mid=${mid}&size=${size}&type=json&apikey=${encodeURIComponent(CHKSZ_CONFIG.apikey)}`;
    const resp = await httpFetch(url, { headers: { 'User-Agent': 'LX-Music-Mobile' }, timeout: 8000 });
    if (resp.statusCode !== 200 || resp.body.code !== 200 || !resp.body.url) {
        throw new Error(`chksz QQ失败(${resp.statusCode}): ${resp.body?.msg || '未返回url'}`);
    }
    return { url: resp.body.url, lyric: resp.body.lrc || null, cover: resp.body.cover || null };
}

async function getWyGDUrl(id, q) {
    const br = GD_BR_MAP[q] || '320';
    const url = buildUrl('gdStudio', 'gdApi', `&${URL_CONFIG.gdParams}&types=url&source=netease&id=${id}&br=${br}`);
    let resp = await httpFetch(url, { headers: { 'User-Agent': 'LX-Music-Mobile' }, timeout: 8000 });
    if (q === 'hires' && (resp.statusCode !== 200 || !resp.body.url)) {
        const fallbackUrl = buildUrl('gdStudio', 'gdApi', `&${URL_CONFIG.gdParams}&types=url&source=netease&id=${id}&br=740`);
        resp = await httpFetch(fallbackUrl, { headers: { 'User-Agent': 'LX-Music-Mobile' }, timeout: 8000 });
    }
    if (resp.statusCode !== 200 || !resp.body.url) {
        throw new Error(`GD接口状态${resp.statusCode}，未返回音频`);
    }
    return { url: resp.body.url, lyric: null, cover: null };
}

// 自建后端接口（通用）
async function getUrlFromBackend(source, musicInfo, quality) {
    const backendSource = SOURCE_MAP[source] || source;
    const baseUrl = buildUrl('primary', 'backend');
    const params = {};
    if (backendSource === 'kg') {
        const types = musicInfo._types || {};
        params.source = 'kg';
        params.quality = quality || '';
        params.songmid = musicInfo.songmid || musicInfo.id || '';
        params.albumId = musicInfo.albumId || '';
        params.mainHash = musicInfo.hash || '';
        if (types[quality]?.hash) params.hash = types[quality].hash;
    } else {
        params.source = backendSource;
        params.name = musicInfo.name || '';
        params.singer = musicInfo.singer || '';
        params.songmid = musicInfo.songmid || musicInfo.id || '';
        params.interval = musicInfo.interval || '';
        params.albumName = musicInfo.albumName || musicInfo.album || '';
        params.quality = quality || '';
    }
    const query = Object.keys(params).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
    const url = `${baseUrl}?${query}`;
    const resp = await httpFetch(url, { method: 'GET', timeout: 8000 });

    if (resp.statusCode === 403) {
        backendAggBlocked = true;
        throw new Error('后端聚合接口返回403，已屏蔽');
    }

    if (resp.statusCode !== 200) throw new Error(`后端接口状态${resp.statusCode}`);

    const data = resp.body;
    if (data.code !== 200) throw new Error(data.msg || '后端无可用链接');

    // 汽水音乐专用分支 —— 抖音加密流
    if (backendSource === 'qs') {
        const d = data.data || {};
        let streamUrl = d.url || '';

        if (streamUrl && d.key && !/[?&]key=/.test(streamUrl)) {
            streamUrl += (streamUrl.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(d.key);
        }

        if (!streamUrl) streamUrl = d.source_url || '';
        if (!streamUrl) throw new Error('汽水后端未返回流媒体链接');

        return {
            url: streamUrl,
            lyric: d.lyric || d.lrc || null,
            cover: d.cover || d.picture || d.album_pic || null,
        };
    }

    if (!data.url) throw new Error(data.msg || '后端无可用链接');
    const finalUrl = processKwEncryptedUrl(data, backendSource);
    return { url: finalUrl, lyric: data.lrc || null, cover: data.picture || null };
}

// -------------------- 核心：获取音乐URL --------------------
async function fetchMusicUrl(source, musicInfo, quality) {
    const id = musicInfo.hash ?? musicInfo.songmid ?? musicInfo.id;
    if (!id) throw new Error('缺少 songId');
    let actualQuality = mapQuality(quality, MUSIC_QUALITIES[source] || ['128k','320k','flac']);

    if (source === 'kw' && !KW_DECRYPT_PROXY.allowEncryptedLossless) {
        actualQuality = mapQuality(quality, ['128k','320k','flac']);
    }

    let result = { url: '', lyric: null, cover: null };
    let lastError = '';
    const chkszEnabled = !!(CHKSZ_CONFIG.apikey && CHKSZ_CONFIG.apikey.trim());

    // --- 酷我音乐 ---
    if (source === 'kw') {
        // 统一走本站取链：音质兜底、短链签名、加密解密都在服务端完成，
        // 插件里不再直连酷我，避免本地链路失效时整首放不出来。
        try {
            result = await getUrlFromBackend('kw', musicInfo, actualQuality);
        } catch (e) {
            lastError = `酷我取链失败: ${e.message}`;
        }
    }
    // --- 网易云音乐 ---
    else if (source === 'wy') {
        if (chkszEnabled && CHKSZ_CONFIG.enableNetease) {
            try {
                result = await getWyChkszUrl(id, actualQuality);
            } catch (e) {
                lastError = `chksz网易失败: ${e.message}`;
            }
        }

        if (!result.url && !backendAggBlocked) {
            try {
                result = await getUrlFromBackend('wy', musicInfo, actualQuality);
            } catch (e) {
                lastError = `后端聚合失败: ${e.message}`;
            }
        }

        if (!result.url && GD_SUPPORTED_QUALITIES.has(actualQuality)) {
            try {
                result = await getWyGDUrl(id, actualQuality);
            } catch (e) {
                lastError = `GD接口失败: ${e.message}`;
            }
        }
    }
    // --- QQ 音乐 ---
    else if (source === 'tx') {
        if (chkszEnabled && CHKSZ_CONFIG.enableQQ) {
            try {
                result = await getTxChkszUrl(musicInfo, actualQuality);
            } catch (e) { lastError = `chksz QQ失败: ${e.message}`; }
        }

        if (!result.url) {
            try {
                result = await getUrlFromBackend(source, musicInfo, actualQuality);
            } catch (e) { lastError = `后端失败: ${e.message}`; }
        }
    }
    // --- 汽水音乐 ---
    else if (source === 'qs') {
        try {
            result = await getUrlFromBackend('qs', musicInfo, actualQuality);
        } catch (e) {
            lastError = `汽水后端失败: ${e.message}`;
        }
    }
    // --- 其他平台 ---
    else {
        try {
            result = await getUrlFromBackend(source, musicInfo, actualQuality);
        } catch (e) { lastError = `后端失败: ${e.message}`; }
    }

    extraCache.set(id, { lyric: result.lyric, cover: result.cover });

    const trimmedUrl = typeof result.url === 'string' ? result.url.trim() : '';
    if (typeof result.url !== 'string' || trimmedUrl.length < 1 || !trimmedUrl.match(/^https?:\/\//i)) {
        throw new Error(lastError || '获取播放链接失败');
    }

    return trimmedUrl;
}

// -------------------- 更新检查 --------------------
async function checkUpdate() {
    try {
        const resp = await httpFetch(
            buildUrl('primary', 'version') + '?ver=' + encodeURIComponent(SCRIPT_VERSION),
            { timeout: 5000 }
        );
        if (resp.statusCode === 200 && resp.body && resp.body.update_url) {
            send(EVENT_NAMES.updateAlert, {
                log: resp.body.changelog || resp.body.message || `发现新版本 ${resp.body.version || ''}`,
                updateUrl: resp.body.update_url
            });
        }
    } catch (e) {}
}

// -------------------- 事件处理 --------------------
on(EVENT_NAMES.request, async ({ action, source, info }) => {
    if (!source || !MUSIC_QUALITIES[source]) throw new Error(`不支持的音乐源: ${source}`);

    if (action === 'musicUrl') {
        if (!info?.musicInfo || !info.type) throw new Error('参数不完整');
        return fetchMusicUrl(source, info.musicInfo, info.type);
    }

    const id = info?.musicInfo?.hash ?? info?.musicInfo?.songmid ?? info?.musicInfo?.id;
    const cached = extraCache.get(id);
    if (action === 'lyric') return cached?.lyric ? { lyric: cached.lyric, tlyric: '' } : null;
    if (action === 'pic') return cached?.cover || null;
    throw new Error(`不支持的操作: ${action}`);
});

// -------------------- 启动 --------------------
(async () => {
    deviceId = generateDeviceId();
    clientHeader = buildClientHeader();
    ensureTokenFresh();
    availablePlatforms = ['wy', 'tx', 'kg', 'kw', 'mg', 'qs'];
    const sources = {};
    availablePlatforms.forEach(p => { sources[p] = { name: PLATFORM_NAMES[p], type: 'music', actions: ['musicUrl', 'lyric', 'pic'], qualitys: MUSIC_QUALITIES[p] }; });
    send(EVENT_NAMES.inited, { openDevMode: false, status: true, sources });
    fetchIp();
    checkUpdate();
})();