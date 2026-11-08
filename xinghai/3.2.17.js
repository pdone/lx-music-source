/*!
 * @name         星海音乐源
 * @description  GDAPI | 聚合 | ChKSz API | 全平台支持 24bit FLAC，网易、酷狗、QQ 最高支持母带
 * @version      v3.2.17
 * @author       万去了了 / 科学大魔王
 * @homepage     https://zddyr.top/
 * @see          http://gc.kxwa.top/
 * @lastUpdate   2026-11-04
 * @update       优化
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

const KW_LOCAL_CONFIG = {
    enabled: true,
    strictHighEnd: true,
    fallbackToBackend: true,
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

const SCRIPT_VERSION = 'v3.2.17';
const SCRIPT_NAME = 'XingHaiMusicSource';
const SOURCE_MAP = { tx: 'qq', mg: 'migu', kw: 'kw', kg: 'kg', qs: 'qs' };
const PLATFORM_NAMES = { wy: '网易云音乐', tx: 'QQ音乐', kw: '酷我音乐', kg: '酷狗音乐', mg: '咪咕音乐', qs: '汽水音乐' };
const MUSIC_QUALITIES = {
    wy: ['128k','320k','flac','hires','atmos','master'],
    tx: ['128k','192k','320k','flac','hires','atmos','atmos_plus','master'],
    kw: ['128k','320k','flac','hires','atmos','master'],
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

// ==================== 酷我本地直连配置 ====================
const KW_UA_MOBI = 'okhttp/3.10.0';
const KW_UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const KW_TIMEOUT = 15000;

const KW_QUALITIES = {
    '128k':  { br: '128kmp3',    format: 'mp3',   desc: '标准 128k',      min_kbps: 96,   max_kbps: 192,  target_kbps: 128 },
    '192k':  { br: '192kmp3',    format: 'mp3',   desc: '中品 192k',      min_kbps: 161,  max_kbps: 255,  target_kbps: 192 },
    '320k':  { br: '320kmp3',    format: 'mp3',   desc: '高品 320k',      min_kbps: 256,  max_kbps: 360,  target_kbps: 320 },
    'flac':  { br: '2000kflac',  format: 'flac',  desc: '无损 FLAC',      min_kbps: 800,  max_kbps: 3000, target_kbps: 2000 },
    'hires': { br: '4000kflac',  format: 'flac',  desc: 'Hi-Res 母带',    min_kbps: 3000, max_kbps: 20000,target_kbps: 4000 },
    'hifi':  { br: '6000kflac',  format: 'mflac', desc: '超高音质(加密)', min_kbps: 4000, max_kbps: 20000,target_kbps: 6000 },
    'master':{ br: '4000kflac',  format: 'flac',  desc: '母带(Hi-Res)',   min_kbps: 3000, max_kbps: 20000,target_kbps: 4000 },
    'atmos': { br: '20501kzpga', format: 'mflac', desc: '臻品全景声(加密)',min_kbps: 3000,max_kbps: 23000,target_kbps: 20501 },
    'zpga':  { br: '20501kzpga', format: 'mflac', desc: '臻品全景声(加密)',min_kbps: 3000,max_kbps: 23000,target_kbps: 20501 },
    'sur':   { br: '20501kzpga', format: 'mflac', desc: '臻品全景音(加密)',min_kbps: 3000,max_kbps: 23000,target_kbps: 20501 },
    'atmos_plus': { br: '24900kszpga', format: 'mflac', desc: '臻品全景声Atmos+(加密)', min_kbps: 22000, max_kbps: 26000, target_kbps: 24900 },
    'zp':    { br: '20900kzply', format: 'mflac', desc: '臻品母带(加密mgg)', min_kbps: 3000, max_kbps: 25000, target_kbps: 20900 },
    'jymaster': { br: '28000kzlmaster', format: 'mgg', desc: '臻品母带极致(加密mgg)', min_kbps: 24000, max_kbps: 32000, target_kbps: 28000 },
};

const KW_QUALITIES_ALIAS = {
    'atmos+': 'atmos_plus', 'atmosplus': 'atmos_plus', 'atmos2': 'atmos_plus',
    'sur+': 'atmos_plus',
    'zp+': 'jymaster', 'zpplus': 'jymaster', 'zp2': 'jymaster',
};

const KW_PLUGIN_TO_LOCAL = {
    '128k': '128k', '320k': '320k', 'flac': 'flac',
    'hires': 'hires', 'atmos': 'atmos', 'master': 'master',
};

const KW_BR_CHAIN = {
    '128k':  ['128kmp3'],
    '192k':  ['192kmp3', '128kmp3'],
    '320k':  ['320kmp3', '192kmp3', '128kmp3'],
    'flac':  ['2000kflac', '320kmp3', '192kmp3'],
    'hires': ['4000kflac', '2000kflac', '320kmp3'],
    'hifi':  ['6000kflac', '4000kflac', '2000kflac', '320kmp3'],
    'atmos': ['20501kzpga', '2000kflac', '320kmp3'],
    'master':['4000kflac', '2000kflac', '320kmp3'],
    'zpga':  ['20501kzpga', '2000kflac', '320kmp3'],
    'sur':   ['20501kzpga', '2000kflac', '320kmp3'],
    'atmos_plus': ['24900kszpga', '20501kzpga', '2000kflac', '320kmp3'],
    'zp':    ['20900kzply', '2000kflac', '320kmp3'],
    'jymaster': ['28000kzlmaster', '20900kzply', '2000kflac', '320kmp3'],
};

const KW_LOSSLESS_PLUS = new Set(['flac','hires','hifi','atmos','master','zp','zpga','sur','atmos_plus','jymaster']);
const KW_LOSSLESS_FMTS = new Set(['flac','mgg','mflac']);
const KW_ENCRYPTED_FMTS = new Set(['mgg','mflac']);
const KW_HIGH_END = new Set(['hires','hifi','master','atmos','zp','zpga','sur','atmos_plus','jymaster']);

const KW_CHANNELS_PREMIUM = [
    { name: 'car_conv2', url: 'http://anymatch.kuwo.cn/mobi.s', type: 'convert_url2', source: 'kwplayercar_ar_6.0.0.9_B_jiakong_vh.apk' },
    { name: 'mobi_conv2', url: 'http://mobi.kuwo.cn/mobi.s', type: 'convert_url2', source: 'kwplayer_ar_8.5.5.0_apk_keluze.apk' },
];
const KW_CHANNELS_STABLE = [
    { name: 'mobi_with_sign', url: 'https://mobi.kuwo.cn/mobi.s', type: 'convert_url_with_sign', source: 'kwplayer_ar_8.5.5.0_apk_keluze.apk' },
    { name: 'car_sign_6005', url: 'http://nmobi.kuwo.cn/mobi.s', type: 'convert_url_with_sign', source: 'kwplayercar_ar_6.0.0.5_B_jiakong_vh.apk' },
    { name: 'car_sign_6100', url: 'http://nmobi.kuwo.cn/mobi.s', type: 'convert_url_with_sign', source: 'kwplayercar_ar_6.1.0.0_B_jiakong_vh.apk' },
];
const KW_CHANNELS_FALLBACK = [
    { name: 'sign_mobi_http', url: 'http://mobi.kuwo.cn/mobi.s', type: 'convert_url_with_sign', source: 'kwplayer_ar_8.5.5.0_apk_keluze.apk' },
];

const kwUrlCache = new Map();
const KW_CACHE_TTL = 30 * 60 * 1000;

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

// ==================== 酷我本地直连工具函数 ====================
function kwResolveQuality(q) {
    if (!q) return q;
    q = String(q).trim().toLowerCase();
    if (KW_QUALITIES_ALIAS[q]) return KW_QUALITIES_ALIAS[q];
    if (KW_QUALITIES[q]) return q;
    const raw = q.replace(/\+/g, 'plus').replace(/[-_]/g, '');
    for (const k of Object.keys(KW_QUALITIES_ALIAS)) {
        const kk = k.replace(/\+/g, 'plus').replace(/[-_]/g, '');
        if (kk === raw) return KW_QUALITIES_ALIAS[k];
    }
    return q;
}

function kwNormalizeFmt(fmt) {
    fmt = String(fmt || '').toLowerCase().trim();
    fmt = fmt.replace(/^\d+k/, '');
    return fmt;
}

function kwExtractEkeyFromUrl(url) {
    const result = {};
    if (!url) return result;
    try {
        const qIdx = url.indexOf('?');
        if (qIdx < 0) return result;
        const query = url.substring(qIdx + 1).split('#')[0];
        const pairs = query.split('&');
        for (const p of pairs) {
            const eq = p.indexOf('=');
            if (eq < 0) continue;
            const k = p.substring(0, eq);
            const v = decodeURIComponent(p.substring(eq + 1));
            if (['ekey','album_id','encrypt','sign','key'].includes(k) && v.length > 3) {
                result[k] = v;
            }
        }
    } catch (e) {}
    return result;
}

function kwExtractEkeyDeep(data, depth = 0, maxDepth = 5) {
    const found = {};
    if (depth > maxDepth || data == null) return found;
    const EKEY_KEYS = ['ekey','album_id','albumid','secret','seckey','decrypt_key','decryptkey','mkey','music_key','k','key'];
    if (typeof data === 'object' && !Array.isArray(data)) {
        for (const [k, v] of Object.entries(data)) {
            const lk = String(k).toLowerCase();
            if (EKEY_KEYS.includes(lk) && typeof v === 'string' && v.length >= 8) {
                found[lk] = v;
            }
            if (typeof v === 'string' && v.length >= 16 && v.length <= 512 && ['data','info','extra','msg','message','result'].includes(lk)) {
                try {
                    const sub = JSON.parse(v);
                    Object.assign(found, kwExtractEkeyDeep(sub, depth + 1, maxDepth));
                } catch (e) {}
            }
            if (typeof v === 'object' && v !== null) {
                Object.assign(found, kwExtractEkeyDeep(v, depth + 1, maxDepth));
            }
        }
    } else if (Array.isArray(data)) {
        for (const item of data) {
            Object.assign(found, kwExtractEkeyDeep(item, depth + 1, maxDepth));
        }
    }
    return found;
}

function kwParseBrEntry(brStr, defaultFmt) {
    brStr = String(brStr);
    const kIdx = brStr.toLowerCase().lastIndexOf('k');
    if (kIdx < 0) return { br: brStr, format: defaultFmt };
    let fmt = brStr.substring(kIdx + 1);
    if (!fmt) return { br: brStr, format: defaultFmt };
    const fmtL = fmt.toLowerCase();
    if (['zply','mgg'].includes(fmtL)) fmt = 'mgg';
    else if (['zpga','szpga','mflac','zlmaster'].includes(fmtL)) fmt = 'mflac';
    else if (fmtL === 'flac') fmt = 'flac';
    else if (fmtL === 'mp3') fmt = 'mp3';
    return { br: brStr, format: fmt };
}

const kwHttpFetch = (url, options = {}) => new Promise((resolve, reject) => {
    const headers = { 'User-Agent': KW_UA_MOBI, ...(options.headers || {}) };
    request(url, { ...options, headers, timeout: options.timeout || KW_TIMEOUT }, (err, resp) => {
        if (err) return reject(err);
        resolve({ body: safeParseBody(resp.body), statusCode: resp.statusCode, headers: resp.headers || {}, rawBody: resp.body });
    });
});

async function kwTryChannel(ch, rid, qCfg) {
    let info = null;
    let rawResp = null;

    if (ch.type === 'convert_url_with_sign') {
        const params = new URLSearchParams();
        params.set('user', '0');
        params.set('source', ch.source);
        params.set('type', ch.type);
        params.set('br', qCfg.br);
        params.set('format', qCfg.format);
        params.set('sig', '0');
        params.set('rid', rid);
        params.set('network', 'WIFI');
        params.set('f', 'web');
        const url = `${ch.url}?${params.toString()}`;
        const resp = await kwHttpFetch(url);
        const d = resp.body;
        if (d && d.code === 200 && d.data && d.data.url) {
            info = {
                br: d.data.bitrate,
                format: d.data.format,
                url: d.data.url,
                ekey: d.data.ekey || '',
            };
            rawResp = d;
        }
    } else if (ch.type === 'convert_url2') {
        const params = new URLSearchParams();
        params.set('user', '0');
        params.set('source', ch.source);
        params.set('type', ch.type);
        params.set('br', qCfg.br);
        params.set('format', qCfg.format);
        params.set('rid', rid);
        params.set('network', 'WIFI');
        params.set('f', 'web');
        params.set('mode', 'download');
        const url = `${ch.url}?${params.toString()}`;
        const resp = await kwHttpFetch(url);
        const text = typeof resp.body === 'string' ? resp.body : String(resp.body || '');
        const d = {};
        for (const line of text.split(/\r?\n/)) {
            const eq = line.indexOf('=');
            if (eq > 0) d[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
        }
        if (d.url && !d.url.startsWith('None')) {
            info = {
                br: d.bitrate,
                format: d.format,
                url: d.url,
                ekey: d.ekey || '',
            };
            rawResp = d;
        }
    }

    if (!info) return null;

    let ekeyFinal = info.ekey || '';
    if (!ekeyFinal) {
        const urlEk = kwExtractEkeyFromUrl(info.url);
        if (urlEk.ekey) ekeyFinal = urlEk.ekey;
    }
    if (!ekeyFinal && rawResp) {
        const extraEk = kwExtractEkeyDeep(rawResp);
        if (extraEk.ekey) ekeyFinal = extraEk.ekey;
        else if (extraEk.album_id) ekeyFinal = extraEk.album_id;
    }
    info.ekey = ekeyFinal;
    return info;
}

async function kwGetContentLength(url) {
    try {
        const resp = await kwHttpFetch(url, { method: 'HEAD', timeout: 8000 });
        const cl = resp.headers['Content-Length'] || resp.headers['content-length'];
        if (cl) return parseInt(cl, 10);
    } catch (e) {}
    return null;
}

async function kwGetExtra(rid) {
    const result = {
        lrc: '', lrc_line: [], album: '', album_id: '',
        artist: '', song_name: '', album_pic: '', artist_pic: '',
    };
    if (!rid) return result;

    const ridS = String(rid);
    const h5Url = `http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${ridS}&httpsStatus=1`;

    try {
        const resp = await kwHttpFetch(h5Url, { headers: { 'User-Agent': KW_UA_WEB }, timeout: 8000 });
        const d = resp.body;
        const data = d && d.data ? d.data : {};
        const songinfo = data.songinfo || {};
        const lrclist = data.lrclist || [];

        if (songinfo) {
            result.album = String(songinfo.album || '');
            result.album_id = String(songinfo.albumId || '');
            result.artist = String(songinfo.artist || '');
            result.song_name = String(songinfo.songName || '');
        }

        if (Array.isArray(lrclist) && lrclist.length) {
            result.lrc_line = lrclist;
            const lines = [];
            for (const row of lrclist) {
                if (typeof row !== 'object') continue;
                const tm = parseFloat(row.time || '0') || 0;
                const mm = Math.floor(tm / 60);
                const ss = tm - mm * 60;
                const lyric = row.lineLyric || row.lyric || '';
                lines.push(`[${String(mm).padStart(2,'0')}:${ss.toFixed(2).padStart(5,'0')}]${lyric}`);
            }
            result.lrc = lines.join('\n');
        }

        const picRaw = String(songinfo.pic || '').trim();
        if (picRaw) {
            let u = picRaw;
            if (u.startsWith('//')) u = 'https:' + u;
            if (!u.startsWith('http')) u = 'https://img1.kwcdn.kuwo.cn' + (u.startsWith('/') ? '' : '/') + u;
            result.album_pic = u;
        }

        const artistId = String(songinfo.artistId || '0');
        if (artistId && artistId !== '0') {
            const a = artistId.length >= 2 ? artistId[artistId.length - 2] : '0';
            const b = artistId.length >= 1 ? artistId[artistId.length - 1] : '0';
            result.artist_pic = `https://img1.kwcdn.kuwo.cn/star/starheads/500/${a}/${b}/${artistId}.jpg`;
        } else if (picRaw) {
            result.artist_pic = result.album_pic;
        }
    } catch (e) {}

    return result;
}

async function kwGetUrlLocal(rid, quality, durationSec) {
    const localQ = KW_PLUGIN_TO_LOCAL[quality] || kwResolveQuality(quality);
    if (!KW_QUALITIES[localQ]) throw new Error(`酷我不支持音质: ${quality}`);

    const cacheKey = `${rid}:${localQ}`;
    const cached = kwUrlCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < KW_CACHE_TTL) {
        return cached.value;
    }

    const cfg = KW_QUALITIES[localQ];
    const isHighEnd = KW_HIGH_END.has(localQ);
    const wantLossless = KW_LOSSLESS_PLUS.has(localQ);
    const strictHighEnd = KW_LOCAL_CONFIG.strictHighEnd;

    let bestResult = null;
    let bestEkeyResult = null;
    let extraLoaded = null;

    const loadExtraOnce = async () => {
        if (extraLoaded === null) {
            try { extraLoaded = await kwGetExtra(rid); } catch (e) { extraLoaded = {}; }
        }
        return extraLoaded;
    };

    const finalize = async (resCh) => {
        if (!resCh) return null;
        const [res, chName] = resCh;
        const extra = await loadExtraOnce();
        if (extra) {
            for (const [k, v] of Object.entries(extra)) {
                if (res[k] === undefined) res[k] = v;
            }
        }
        res.channel = chName;
        kwUrlCache.set(cacheKey, { value: res, ts: Date.now() });
        return res;
    };

    let chain = KW_BR_CHAIN[localQ];
    if (!chain) {
        if (['atmos_plus','sur'].includes(localQ)) chain = KW_BR_CHAIN.zpga || [];
        else if (localQ === 'jymaster') chain = KW_BR_CHAIN.zp || [];
        else if (localQ === 'hifi') chain = KW_BR_CHAIN.hires || [];
        else chain = [cfg.br];
    }

    const stagePlan = (brIdx) => {
        if (isHighEnd && brIdx === 0) {
            return [
                ['premium', KW_CHANNELS_PREMIUM, true],
                ['stable', KW_CHANNELS_STABLE, false],
                ['fallback', KW_CHANNELS_FALLBACK, false],
            ];
        }
        return [
            ['stable', KW_CHANNELS_STABLE, false],
            ['fallback', KW_CHANNELS_FALLBACK, false],
        ];
    };

    for (let idx = 0; idx < chain.length; idx++) {
        const brEntry = chain[idx];
        const { br: brStr, format: brFmt } = kwParseBrEntry(brEntry, cfg.format);
        const qCfg = { ...cfg, br: brStr, format: brFmt };
        const baseStrict = strictHighEnd && isHighEnd && idx === 0;

        for (const [stageName, stageChannels, stageIsPremium] of stagePlan(idx)) {
            const doStrict = baseStrict && stageIsPremium;

            for (const ch of stageChannels) {
                let info;
                try {
                    info = await kwTryChannel(ch, rid, qCfg);
                } catch (e) { info = null; }
                if (!info) continue;
                if (String(info.br) === '6') continue;

                const fmt = kwNormalizeFmt(info.format);
                if (wantLossless && !KW_LOSSLESS_FMTS.has(fmt)) continue;

                const result = {
                    url: info.url, format: fmt, br: info.br,
                    br_req: brStr, ekey: info.ekey || '', stage: stageName,
                };

                if (doStrict) {
                    const wantFmt = kwNormalizeFmt(qCfg.format);
                    if (KW_ENCRYPTED_FMTS.has(wantFmt) && !KW_ENCRYPTED_FMTS.has(fmt)) {
                        if (!bestResult) bestResult = [result, ch.name];
                        continue;
                    }

                    let brVal = null;
                    try {
                        const brRaw = info.br;
                        if (typeof brRaw === 'string' && brRaw.toLowerCase().endsWith('k')) {
                            brVal = parseFloat(brRaw.slice(0, -1));
                        } else if (brRaw != null) {
                            brVal = parseFloat(String(brRaw).replace(/[kK]/g, ''));
                        }
                    } catch (e) {}
                    if (brVal != null && brVal < (qCfg.min_kbps || 0)) {
                        if (!bestResult) bestResult = [result, ch.name];
                        continue;
                    }

                    if (durationSec && durationSec > 0) {
                        const cl = await kwGetContentLength(info.url);
                        if (cl) {
                            result.content_length = cl;
                            const estKbps = (cl * 8) / 1000 / durationSec;
                            result.estimated_kbps_by_head = Math.round(estKbps * 10) / 10;
                            if (estKbps < (qCfg.min_kbps || 0)) {
                                if (!bestResult) bestResult = [result, ch.name];
                                continue;
                            }
                        }
                    }
                }

                if (result.ekey) {
                    if (!bestEkeyResult) {
                        bestEkeyResult = [result, ch.name];
                        if (stageIsPremium && KW_ENCRYPTED_FMTS.has(fmt)) {
                            return finalize([result, ch.name]);
                        }
                    }
                }
                if (!bestResult) bestResult = [result, ch.name];
            }
        }

        if (bestEkeyResult) return finalize(bestEkeyResult);
        if (bestResult) return finalize(bestResult);
    }

    if (bestResult) return finalize(bestResult);
    return null;
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
        if (KW_LOCAL_CONFIG.enabled) {
            try {
                const durationSec = musicInfo.interval ? parseInt(musicInfo.interval, 10) : null;
                const kwResult = await kwGetUrlLocal(id, actualQuality, durationSec);
                if (kwResult && kwResult.url) {
                    let finalUrl = kwResult.url;
                    if (KW_DECRYPT_PROXY.allowEncryptedLossless && KW_ENCRYPTED_FMTS.has(kwResult.format)) {
                        finalUrl = processKwEncryptedUrl({ url: kwResult.url, ekey: kwResult.ekey }, 'kw');
                    }
                    result = { url: finalUrl, lyric: kwResult.lrc || null, cover: kwResult.album_pic || null };
                }
            } catch (e) {
                lastError = `酷我本地直连失败: ${e.message}`;
            }
        }

        if (!result.url && KW_LOCAL_CONFIG.fallbackToBackend && !backendAggBlocked) {
            try {
                result = await getUrlFromBackend('kw', musicInfo, actualQuality);
            } catch (e) {
                lastError = `后端聚合失败: ${e.message}`;
            }
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