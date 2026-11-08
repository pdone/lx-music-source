/**
 * @name 轻量音源（四平台多源并行）
 * @description QQ/网易/酷狗/酷我多线路并发取链，谁先通过音频头校验用谁；含超时取消与冷却。
 * @version 2.1.0
 * @author 本地定制
 * @license MIT
 */
(function () {
  'use strict';
  var lx = globalThis.lx;
  if (!lx || !lx.request || !lx.on || !lx.send) throw new Error('播放器未提供 LX 音源接口');

  // 当前默认只显示 QQ/网易，并关闭跨平台换歌。
  // 需要旧版的五平台同曲兜底时，可将下面两项分别改为 false / true。
  var DEFAULTS = {
    focusQQWY: false,
    allowSameSongFallback: true,
    requestTimeoutMs: 3000,
    headTimeoutMs: 1500,
    totalTimeoutMs: 6000,
    hedgeDelayMs: 0,
    cooldownMs: 45000,
    cacheTtlMs: 75000,
    cacheRecheckMs: 20000,
    maxCacheEntries: 96,
    maxHttpRequests: 5,
    maxResolverJobs: 3,
    disabledProviders: [],
    // wy-ffapi 与 wy-bileizhen 已适配，但本次有超时样本，默认不排入队列。
    extraProviders: ['qq-lzm', 'wy-yutang', 'wy-kangqi', 'wy-qjqq', 'wy-lzm']
  };
  // 可选的宿主配置，仅覆盖已知键；不使用浏览器或 Node API。
  var CONFIG = Object.assign({}, DEFAULTS);
  var override = globalThis.__QINGLIU_CONFIG__;
  if (override) Object.keys(DEFAULTS).forEach(function (key) {
    if (override[key] !== undefined) CONFIG[key] = override[key];
  });

  var UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36';
  var aliases = { qq: 'tx', tencent: 'tx', netease: 'wy', kuwo: 'kw', kugou: 'kg', migu: 'mg' };
  var names = { tx: 'QQ音乐', wy: '网易云音乐', kw: '酷我音乐', kg: '酷狗音乐', mg: '咪咕音乐' };
  var cache = new Map(), pending = new Map(), health = new Map();
  var httpActive = 0, httpQueue = [], gdTimes = [];

  function fail(message, kind) {
    var error = new Error(message);
    error.kind = kind || 'network';
    return error;
  }
  function first(info, fields) {
    for (var i = 0; i < fields.length; i++) {
      var value = info[fields[i]];
      if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) return String(value).trim();
      if (info.meta) {
        value = info.meta[fields[i]];
        if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) return String(value).trim();
      }
    }
    return '';
  }
  function getId(source, info) {
    var fields = source === 'kg' ? ['hash', 'songmid', 'id'] :
      source === 'mg' ? ['copyrightId', 'songmid', 'id'] :
      source === 'kw' ? ['rid', 'songmid', 'id', 'hash'] : ['songmid', 'mid', 'id', 'hash'];
    return first(info, fields).replace(source === 'kw' ? /^MUSIC_/ : /$^/, '');
  }
  function duration(info) {
    var value = info.interval || info.duration || info.DURATION || 0;
    if (typeof value === 'string' && value.indexOf(':') >= 0) {
      return value.split(':').reduce(function (a, b) { return a * 60 + Number(b); }, 0) || 0;
    }
    value = Number(value) || 0;
    return value > 10000 ? value / 1000 : value;
  }
  function normalized(value) {
    return String(value || '').toLowerCase().replace(/&nbsp;/gi, '').replace(/（/g, '(').replace(/）/g, ')').replace(/\s+/g, '');
  }
  function singerKey(value) {
    return String(value || '').split(/\s*[、/&＆;,，]\s*/).map(normalized).filter(Boolean).sort().join('|');
  }
  function query(values) {
    return Object.keys(values).map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(values[key]); }).join('&');
  }
  function json(value) {
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch (_) { throw fail('接口未返回 JSON', 'business'); }
    }
    return value;
  }
  function searchJson(text) {
    if (typeof text !== 'string') return text;
    try { return JSON.parse(text); } catch (_) {}
    // 旧搜索 API 使用单引号字符串；逐字符转义为 JSON，绝不 eval。
    var out = '', i = 0;
    while (i < text.length) {
      var ch = text[i++];
      if (ch === "'" || ch === '"') {
        var quote = ch, value = '', closed = false;
        while (i < text.length) {
          ch = text[i++];
          if (ch === quote) { closed = true; break; }
          if (ch !== '\\') { value += ch; continue; }
          ch = text[i++];
          var simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', "'": "'", '"': '"', '/': '/' };
          if (Object.prototype.hasOwnProperty.call(simple, ch)) value += simple[ch];
          else if ((ch === 'u' && /^[0-9a-f]{4}$/i.test(text.slice(i, i + 4))) || (ch === 'x' && /^[0-9a-f]{2}$/i.test(text.slice(i, i + 2)))) {
            var length = ch === 'u' ? 4 : 2;
            value += String.fromCharCode(parseInt(text.slice(i, i + length), 16));
            i += length;
          } else value += '\\' + ch;
        }
        if (!closed) throw fail('备用搜索返回不完整', 'business');
        out += JSON.stringify(value);
      } else if (/[A-Za-z_]/.test(ch)) {
        var word = ch;
        while (i < text.length && /[A-Za-z_]/.test(text[i])) word += text[i++];
        out += ({ True: 'true', False: 'false', None: 'null' })[word] || word;
      } else out += ch;
    }
    try { return JSON.parse(out); } catch (_) { throw fail('备用搜索格式无法解析', 'business'); }
  }
  function urlFrom(data) {
    data = json(data);
    if (!data || typeof data !== 'object') throw fail('接口返回空数据', 'business');
    if (data.code === 429 || data.code === 401 || data.code === 403 || data.code === 'APP_UPGRADE_REQUIRED') {
      throw fail('接口限流或需要授权', 'limited');
    }
    var url = data.url || (data.data && data.data.url);
    if (typeof url !== 'string' || !/^https?:\/\/[^\s]+$/i.test(url.trim())) throw fail('该接口无可用歌曲', 'business');
    return url.trim();
  }
  function makeContext() {
    var listeners = [];
    return {
      stopped: false,
      deadline: Date.now() + CONFIG.totalTimeoutMs,
      add: function (fn) { listeners.push(fn); return fn; },
      remove: function (fn) { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
      stop: function () {
        if (this.stopped) return;
        this.stopped = true;
        listeners.slice().forEach(function (fn) { fn(); });
        listeners = [];
      }
    };
  }
  function drain() {
    while (httpActive < CONFIG.maxHttpRequests && httpQueue.length) {
      var item = httpQueue.shift();
      if (!item.done()) item.start();
    }
  }
  function http(ctx, url, options, timeout) {
    return new Promise(function (resolve, reject) {
      var settled = false, started = false, abort = null;
      var remaining = ctx.deadline - Date.now();
      var wanted = timeout || CONFIG.requestTimeoutMs;
      var wait = Math.min(wanted, remaining);
      var deadlineLimited = remaining <= wanted;
      var timer;
      function finish(error, response, cancel) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.remove(onCancel);
        if (cancel && typeof abort === 'function') { try { abort(); } catch (_) {} }
        if (started) httpActive--;
        if (error) reject(error); else resolve(response);
        drain();
      }
      function onCancel() { finish(fail('请求已取消', 'cancel'), null, true); }
      var item = {
        done: function () { return settled || ctx.stopped; },
        start: function () {
          started = true;
          httpActive++;
          try {
            abort = lx.request(url, Object.assign({ method: 'GET', headers: { 'User-Agent': UA }, timeout: wait }, options || {}), function (error, response, body) {
              if (error) return finish(fail('网络请求失败', 'network'));
              response = response || {};
              if (response.body === undefined) response.body = body;
              if (Number(response.statusCode) === 429) return finish(fail('接口限流', 'limited'));
              if (Number(response.statusCode) >= 400) return finish(fail('HTTP ' + response.statusCode, Number(response.statusCode) >= 500 ? 'network' : 'business'));
              finish(null, response);
            });
          } catch (_) { finish(fail('宿主请求异常', 'network')); }
          // 兼容同步 callback 以及宿主随后才返回取消句柄的情况。
          if (settled && ctx.stopped && typeof abort === 'function') { try { abort(); } catch (_) {} }
        }
      };
      if (ctx.stopped || wait <= 0) return reject(fail('总等待时间已用完', 'cancel'));
      ctx.add(onCancel);
      timer = setTimeout(function () {
        if (deadlineLimited) ctx.stop();
        else finish(fail('接口超时', started ? 'network' : 'cancel'), null, true);
      }, wait);
      httpQueue.push(item);
      drain();
    });
  }
  function header(headers, name) {
    headers = headers || {};
    var keys = Object.keys(headers);
    for (var i = 0; i < keys.length; i++) if (keys[i].toLowerCase() === name) return String(headers[keys[i]]);
    return '';
  }
  function verify(ctx, url, info) {
    return http(ctx, url, { method: 'HEAD', headers: { 'User-Agent': UA } }, CONFIG.headTimeoutMs).then(function (response) {
      if (![200, 206].includes(Number(response.statusCode))) throw fail('音频链接状态异常', 'media');
      var type = header(response.headers, 'content-type').toLowerCase();
      if (!/audio|octet-stream|application\/ogg/.test(type) || /html|json|text\//.test(type)) throw fail('返回的不是音频', 'media');
      var size = Number(header(response.headers, 'content-length')) || 0;
      var seconds = duration(info);
      // 阻止错误提示音及明显短于目标曲目的试听片段；这不是完整音轨/编码校验。
      var minimum = Math.max(128000, seconds * 3000);
      if (size > 0 && size < minimum) throw fail('返回的是短片段或提示音', 'media');
      return url;
    }).catch(function (error) {
      if (error.kind === 'business' && /HTTP 40[13]/.test(error.message)) error.kind = 'media';
      throw error;
    });
  }
  function post(ctx, url, body) {
    return http(ctx, url, { method: 'POST', headers: { 'User-Agent': 'lx-music-mobile/2.0.0', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return urlFrom(r.body); });
  }
  function wwwweb(ctx, source, info, quality) {
    return post(ctx, 'https://c.wwwweb.top/music/url', { source: source, musicId: getId(source, info), quality: quality });
  }
  function qqResolve(ctx, info) {
    return http(ctx, 'https://api.xunhuisi.store/API/QQMusic/Song.php?' + query({ mid: getId('tx', info), type: 'json' })).then(function (r) {
      var data = json(r.body);
      if (!data || Number(data.code) !== 200 || typeof data.music_url !== 'string') throw fail('QQ 专用接口没有可播音频', 'business');
      var url = data.music_url.trim();
      if (!/^https?:\/\/[^\s]+$/i.test(url)) throw fail('QQ 音频地址无效', 'business');
      return url;
    });
  }
  function pathValue(data, path) {
    var keys = path.split('.');
    for (var i = 0; i < keys.length; i++) {
      if (data === null || data === undefined) return undefined;
      data = data[keys[i]];
    }
    return data;
  }
  function apiUrl(response, paths) {
    var data = json(response.body);
    if (!data || typeof data !== 'object') throw fail('备用接口无歌曲数据', 'business');
    var code = data.code === undefined ? data.status : data.code;
    if ([401, 403, 429].indexOf(Number(code)) >= 0) throw fail('备用接口需要授权或被限流', 'limited');
    for (var i = 0; i < paths.length; i++) {
      var value = pathValue(data, paths[i]);
      if (typeof value === 'string' && /^https?:\/\/[^\s]+$/i.test(value.trim())) return value.trim();
    }
    throw fail('备用接口没有音频地址', 'business');
  }
  function formRequest(ctx, url, values, referer) {
    var headers = { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' };
    if (referer) headers.Referer = referer;
    return http(ctx, url, { method: 'POST', headers: headers, body: query(values) });
  }
  // 不使用共享账号卡密；每个接口只读取明确的音频字段。
  var EXTRA = {
    'qq-lzm': { source: 'tx', qualities: ['128k', '320k'], run: function (ctx, info) {
      return formRequest(ctx, 'https://music.lzmhhh.com/api/music/url', { id: getId('tx', info), type: 'qq' }, 'https://music.lzmhhh.com/').then(function (r) { return apiUrl(r, ['data', 'data.url']); });
    } },
    'wy-yutang': { source: 'wy', qualities: ['128k', '320k', 'flac'], run: function (ctx, info, quality) {
      return http(ctx, 'https://api.yutangxiaowu.cn/api/music/Song_V1?' + query({ url: getId('wy', info), level: level(quality), type: 'json' })).then(function (r) { return apiUrl(r, ['url', 'data.url']); });
    } },
    'wy-kangqi': { source: 'wy', qualities: ['128k', '320k', 'flac'], run: function (ctx, info, quality) {
      return formRequest(ctx, 'https://ncm.kangqiovo.com/Song_V1', { url: getId('wy', info), level: level(quality), type: 'json' }, 'https://ncm.kangqiovo.com/').then(function (r) { return apiUrl(r, ['data.url', 'url']); });
    } },
    'wy-qjqq': { source: 'wy', qualities: ['128k', '320k', 'flac'], run: function (ctx, info, quality) {
      return formRequest(ctx, 'https://metings.qjqq.cn/Song_V1', { url: getId('wy', info), level: level(quality), type: 'json' }).then(function (r) { return apiUrl(r, ['data.url', 'url']); });
    } },
    'wy-ffapi': { source: 'wy', qualities: ['128k', '320k', 'flac'], run: function (ctx, info, quality) {
      return http(ctx, 'https://ffapi.cn/int/v1/netease_url?' + query({ id: getId('wy', info), quality: level(quality) })).then(function (r) { return apiUrl(r, ['url', 'data.url']); });
    } },
    'wy-bileizhen': { source: 'wy', qualities: ['128k', '320k', 'flac'], run: function (ctx, info, quality) {
      // 这是音频流型接口；直接交给统一 HEAD 校验，不能先下载整首再当 JSON 解析。
      return Promise.resolve('https://api.bileizhen.top/api/netease?' + query({ id: getId('wy', info), level: level(quality) }));
    } },
    'wy-lzm': { source: 'wy', qualities: ['320k'], run: function (ctx, info) {
      // 该接口固定返回其服务端音质，不把它当作 FLAC 或低码率专线。
      return formRequest(ctx, 'https://music.lzmhhh.com/api/music/url', { id: getId('wy', info), type: 'wy' }, 'https://music.lzmhhh.com/').then(function (r) { return apiUrl(r, ['data', 'data.url']); });
    } }
  };
  function level(quality) { return { '128k': 'standard', '320k': 'exhigh', flac: 'lossless' }[quality]; }

  // ==== 酷狗（kg）直连通道 ====
  function kugouMobile(ctx, info) {
    var hash = getId('kg', info);
    if (!hash) return Promise.reject(fail('酷狗歌曲缺少 hash', 'business'));
    return http(ctx, 'https://m.kugou.com/app/i/getSongInfo.php?' + query({ cmd: 'playInfo', hash: hash }), {
      headers: { 'User-Agent': UA, 'Referer': 'https://m.kugou.com/' }
    }).then(function (r) {
      var data = json(r.body);
      var url = data && (data.url || (data.data && data.data.url));
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw fail('酷狗 playInfo 没有返回播放地址', 'business');
      return url;
    });
  }
  function kugouWebApi(ctx, info) {
    var hash = getId('kg', info);
    if (!hash) return Promise.reject(fail('酷狗歌曲缺少 hash', 'business'));
    var mid = ''; for (var i = 0; i < 32; i++) mid += '0123456789abcdef'[Math.floor(Math.random() * 16)];
    var dfid = '1' + Math.random().toString(16).slice(2, 10) + '9';
    var albumId = first(info, ['albumId', 'album_id', 'albumid']);
    return http(ctx, 'https://wwwapi.kugou.com/yy/index.php?' + query({ r: 'play/getdata', hash: hash, album_id: albumId, dfid: dfid, mid: mid, platid: '4' }), {
      headers: { 'User-Agent': UA, 'Referer': 'https://www.kugou.com/', 'Cookie': 'kg_mid=' + mid + '; kg_dfid=' + dfid + ';' }
    }).then(function (r) {
      var data = json(r.body);
      var url = data && data.data && (data.data.play_url || data.data.play_backup_url);
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw fail('酷狗接口没有返回播放地址', 'business');
      return url;
    });
  }
  function kuwoDirect(ctx, info, quality) {
    var br = { '128k': '128kmp3', '320k': '320kmp3', flac: '2000kflac' }[quality];
    return http(ctx, 'http://nmobi.kuwo.cn/mobi.s?' + query({ f: 'web', user: 0, source: 'kwplayerhd_ar_1.1.4.5_tianbao_T1A_qirui.apk', type: 'convert_url_with_sign', rid: getId('kw', info), br: br })).then(function (r) { return urlFrom(r.body); });
  }
  function gd(ctx, info, quality) {
    var now = Date.now();
    gdTimes = gdTimes.filter(function (t) { return now - t < 300000; });
    if (gdTimes.length >= 40) return Promise.reject(fail('GD 公共接口暂缓请求', 'limited'));
    gdTimes.push(now);
    return http(ctx, 'https://music-api.gdstudio.xyz/api.php?' + query({ types: 'url', source: 'netease', id: getId('wy', info), br: { '128k': 128, '320k': 320, flac: 740 }[quality] })).then(function (r) { return urlFrom(r.body); });
  }
  function sameSong(info, candidate) {
    var title = normalized(info.name || info.songname || info.songName);
    var artist = singerKey(info.singer || info.artist);
    // 使用 SONGNAME 保留伴奏/现场/片段标记，不能只看接口的通用 NAME 字段。
    if (!title || !artist || title !== normalized(candidate.SONGNAME || candidate.NAME) || artist !== singerKey(candidate.ARTIST)) return false;
    var targetDuration = duration(info), candidateDuration = duration(candidate);
    if (targetDuration && candidateDuration && Math.abs(targetDuration - candidateDuration) > 4) return false;
    var album = normalized(info.albumName || info.album);
    var candidateAlbum = normalized(candidate.ALBUM);
    if (album && candidateAlbum && album !== candidateAlbum) return false;
    // 没有时长可交叉核对时，必须有相同专辑。
    if (!(targetDuration && candidateDuration) && !(album && candidateAlbum && album === candidateAlbum)) return false;
    return true;
  }
  function matchKuwo(ctx, info) {
    var title = info.name || info.songname || info.songName;
    var artist = info.singer || info.artist;
    if (!title || !artist) return Promise.reject(fail('缺少歌名或歌手，未启用同曲换源', 'business'));
    return http(ctx, 'https://search.kuwo.cn/r.s?' + query({ all: title + ' ' + artist, ft: 'music', itemset: 'web_2013', client: 'kt', pn: 0, rn: 8, rformat: 'json', encoding: 'utf8' })).then(function (r) {
      var data = searchJson(r.body);
      var candidates = data && data.abslist || [];
      var found = candidates.filter(function (item) { return sameSong(info, item); })[0];
      if (!found) throw fail('没有找到歌名、歌手和版本一致的备用歌曲', 'business');
      return Object.assign({}, info, { rid: String(found.MUSICRID).replace(/^MUSIC_/, ''), hash: '', songmid: '', id: '' });
    });
  }
  function state(key) {
    if (!health.has(key)) health.set(key, { failures: 0, until: 0 });
    return health.get(key);
  }
  function note(key, error) {
    var s = state(key);
    if (!error) { s.failures = 0; s.until = 0; return; }
    if (error.kind === 'cancel' || error.kind === 'business') return;
    s.failures++;
    if (error.kind === 'limited' || s.failures >= 2) s.until = Date.now() + CONFIG.cooldownMs;
  }
  function jobs(ctx, source, info, quality) {
    var result = [], gdAdded = false;
    function add(key, run) {
      var disabled = Array.isArray(CONFIG.disabledProviders) && CONFIG.disabledProviders.some(function (id) { return key === id || key.indexOf(id + ':') === 0; });
      if (disabled) return;
      if (state(key).until <= Date.now()) result.push({ key: key, run: run });
    }
    if (source === 'tx' && quality === '128k') add('qq-dedicated', function () { return qqResolve(ctx, info); });
    if (source !== 'mg' && source !== 'tx') add('wwwweb:' + source + ':' + quality, function () { return wwwweb(ctx, source, info, quality); });
    // 快速候选排在旧的公共备用之前。这里只是候选队列，不会同时请求全部接口。
    (Array.isArray(CONFIG.extraProviders) ? CONFIG.extraProviders : []).forEach(function (id) {
      var provider = EXTRA[id];
      if (provider && provider.source === source && provider.qualities.indexOf(quality) >= 0) {
        add(id + ':' + quality, function () { return provider.run(ctx, info, quality); });
        if (source === 'wy' && !gdAdded) {
          add('gd:' + quality, function () { return gd(ctx, info, quality); });
          gdAdded = true;
        }
      }
    });
    if (source === 'tx') add('wwwweb:' + source + ':' + quality, function () { return wwwweb(ctx, source, info, quality); });
    if (source === 'kw') add('kuwo-direct:' + quality, function () { return kuwoDirect(ctx, info, quality); });
    if (source === 'kg') {
      add('kg-mobile:' + quality, function () { return kugouMobile(ctx, info); });
      add('kg-webapi:' + quality, function () { return kugouWebApi(ctx, info); });
    }
    if (source === 'wy') {
      if (!gdAdded) add('gd:' + quality, function () { return gd(ctx, info, quality); });
      if (quality === '128k') add('netease-free', function () { return Promise.resolve('https://music.163.com/song/media/outer/url?id=' + encodeURIComponent(getId('wy', info)) + '.mp3'); });
    }
    if (source !== 'kw' && CONFIG.allowSameSongFallback) {
      var match;
      function matched() { if (!match) match = matchKuwo(ctx, info); return match; }
      add('same-song:wwwweb:' + quality, function () { return matched().then(function (candidate) { return wwwweb(ctx, 'kw', candidate, quality); }); });
      add('same-song:kuwo-direct:' + quality, function () { return matched().then(function (candidate) { return kuwoDirect(ctx, candidate, quality); }); });
    }
    return result;
  }
  function race(ctx, candidates, info) {
    return new Promise(function (resolve, reject) {
      var count = candidates.length, complete = false, errors = [], timers = [];
      var next = 0, active = 0, hedged = false;
      if (!count) return reject(fail('没有可用候选：接口已停用或冷却中', 'business'));
      function finish(error, url) {
        if (complete) return;
        complete = true;
        timers.forEach(clearTimeout);
        ctx.stop();
        if (error) reject(error); else resolve(url);
      }
      timers.push(setTimeout(function () { finish(fail('取链超过 ' + (CONFIG.totalTimeoutMs / 1000) + ' 秒，已停止等待')); }, Math.max(1, ctx.deadline - Date.now())));
      function pump() {
        if (complete) return;
        var limit = hedged ? Math.max(1, Math.min(2, CONFIG.maxResolverJobs)) : 1;
        while (active < limit && next < candidates.length) launch(candidates[next++]);
      }
      function launch(candidate) {
          if (complete) return;
          active++;
          Promise.resolve().then(candidate.run).then(function (url) { return verify(ctx, url, info); }).then(function (url) {
            if (complete) return;
            note(candidate.key, null);
            finish(null, url);
          }, function (error) {
            if (complete) return;
            if (ctx.stopped) return finish(fail('取链超过 ' + (CONFIG.totalTimeoutMs / 1000) + ' 秒，已停止等待'));
            active--;
            note(candidate.key, error);
            errors.push(candidate.key + ': ' + error.message);
            if (--count === 0) finish(fail('当前歌曲未找到可播链接：' + errors.join('；'), 'business'));
            else pump();
          });
      }
      // 解析任务包括取链和 HEAD 校验。最多两条任务占位，避免大量 API 请求把已拿到的音频校验堵在队尾。
      timers.push(setTimeout(function () { hedged = true; pump(); }, CONFIG.hedgeDelayMs));
      pump();
    });
  }
  function store(key, url) {
    cache.delete(key);
    cache.set(key, { url: url, at: Date.now() });
    while (cache.size > CONFIG.maxCacheEntries) cache.delete(cache.keys().next().value);
  }
  function resolveMusic(source, info, quality) {
    source = aliases[source] || source;
    if (!names[source] || (CONFIG.focusQQWY && source !== 'tx' && source !== 'wy')) return Promise.reject(fail('本版重点支持 QQ 和网易云', 'business'));
    if (['128k', '320k', 'flac'].indexOf(quality) < 0) return Promise.reject(fail('请使用标准、320k 或 FLAC 音质', 'business'));
    var id = getId(source, info);
    if (!id) return Promise.reject(fail('歌曲缺少平台 ID，请重新搜索', 'business'));
    var key = [source, id, quality, info.name || '', info.singer || ''].join('|');
    if (pending.has(key)) return pending.get(key);
    var ctx = makeContext(), cached = cache.get(key);
    var work, fresh = false;
    if (cached && Date.now() - cached.at < CONFIG.cacheTtlMs) {
      work = Date.now() - cached.at < CONFIG.cacheRecheckMs ? Promise.resolve(cached.url) : verify(ctx, cached.url, info).then(function (url) { fresh = true; return url; });
      work = work.catch(function () { cache.delete(key); return race(ctx, jobs(ctx, source, info, quality), info).then(function (url) { fresh = true; return url; }); });
    } else work = race(ctx, jobs(ctx, source, info, quality), info).then(function (url) { fresh = true; return url; });
    work = work.then(function (url) { ctx.stop(); if (fresh) store(key, url); pending.delete(key); return url; }, function (error) { ctx.stop(); pending.delete(key); cache.delete(key); throw error; });
    pending.set(key, work);
    return work;
  }
  lx.on(lx.EVENT_NAMES.request, function (event) {
    if (!event || event.action !== 'musicUrl') return Promise.reject(fail('仅支持歌曲播放取链', 'business'));
    return resolveMusic(event.source, event.info && event.info.musicInfo || {}, event.info && event.info.type || '128k');
  });
  var sources = {};
  (CONFIG.focusQQWY ? ['tx', 'wy'] : ['tx', 'wy', 'kw', 'kg']).forEach(function (source) {
    sources[source] = { name: names[source], type: 'music', actions: ['musicUrl'], qualitys: source === 'tx' ? ['128k'] : ['128k', '320k', 'flac'] };
  });
  lx.send(lx.EVENT_NAMES.inited, { status: true, sources: sources });
})();
