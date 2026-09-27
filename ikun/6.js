/*!
 * @name ikun音源
 * @description 请不要分享此音源，谢谢 951962664
 * @version v6
 * @author ikunshare
 */

const DEV_ENABLE = false
const UPDATE_ENABLE = true
const API_URL = "https://api.ikunshare.com"
const API_KEY = ""
const MUSIC_QUALITY = JSON.parse('{"kw":["128k","320k","flac","hires","atmos","atmos_plus","master"],"kg":["128k","320k","flac","hires","atmos","master"],"tx":["128k","320k","flac","hires","atmos","atmos_plus","master"],"wy":["128k","320k","flac","hires","atmos","master"],"mg":["128k","320k","flac","hires"]}');
const MUSIC_SOURCE = Object.keys(MUSIC_QUALITY);

const { EVENT_NAMES, request, on, send, utils, env, version } = globalThis.lx;

const SCRIPT_MD5 = "7aa01490ebe2c9d46e0711518d8217d6";

const httpFetch = (url, options = { method: "GET" }) => {
  return new Promise((resolve, reject) => {
    console.log("--- start --- " + url);
    request(url, options, (err, resp) => {
      if (err) return reject(err);
      console.log("API Response: ", resp);
      resolve(resp);
    });
  });
};

const handleGetMusicUrl = async (source, musicInfo, quality) => {
  const songId = musicInfo.hash ?? musicInfo.songmid;
  const request = await httpFetch(
    `${API_URL}/url?source=${source}&songId=${songId}&quality=${quality}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `${
          env ? `lx-music-${env}/${version}` : `lx-music-request/${version}`
        }`,
        "X-Request-Key": API_KEY,
      },
      follow_max: 5,
    }
  );
  const { body } = request;
  if (!body || isNaN(Number(body.code))) throw new Error("unknow error");
  if (env != "mobile") console.groupEnd();
  switch (body.code) {
    case 200:
      console.log(
        `handleGetMusicUrl(${source}_${musicInfo.songmid}, ${quality}) success, URL: ${body.data}`
      );
      return body.data;
    case 403:
      console.log(
        `handleGetMusicUrl(${source}_${musicInfo.songmid}, ${quality}) failed: ip被封禁`
      );
      throw new Error("IP被封禁");
    case 500:
      console.log(
        `handleGetMusicUrl(${source}_${musicInfo.songmid}, ${quality}) failed, ${body.msg}`
      );
      throw new Error("获取URL失败");
    case 429:
      console.log(
        `handleGetMusicUrl(${source}_${musicInfo.songmid}, ${quality}) failed, 请求过于频繁，请休息一下吧`
      );
      throw new Error("请求过速");
    default:
      console.log(
        `handleGetMusicUrl(${source}_${
          musicInfo.songmid
        }, ${quality}) failed, ${body.msg ? body.msg : "未知错误"}`
      );
      throw new Error(body.msg ?? "未知错误");
  }
};

const checkUpdate = async () => {
  const request = await httpFetch(
    `${API_URL}/script?key=${API_KEY}&checkUpdate=${SCRIPT_MD5}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `${
          env ? `lx-music-${env}/${version}` : `lx-music-request/${version}`
        }`,
      },
    }
  );
  const { body } = request;

  if (!body || body.code !== 200) console.log("checkUpdate failed");
  else {
    console.log("checkUpdate success");
    if (body.data != null) {
      globalThis.lx.send(lx.EVENT_NAMES.updateAlert, {
        log: body.data.updateMsg,
        updateUrl: body.data.updateUrl,
      });
    }
  }
};

const musicSources = {};
MUSIC_SOURCE.forEach((item) => {
  musicSources[item] = {
    name: item,
    type: "music",
    actions: ["musicUrl"],
    qualitys: MUSIC_QUALITY[item],
  };
});

on(EVENT_NAMES.request, ({ action, source, info }) => {
  switch (action) {
    case "musicUrl":
      if (env != "mobile") {
        console.group(`Handle Action(musicUrl)`);
        console.log("source", source);
        console.log("quality", info.type);
        console.log("musicInfo", info.musicInfo);
      } else {
        console.log(`Handle Action(musicUrl)`);
        console.log("source", source);
        console.log("quality", info.type);
        console.log("musicInfo", info.musicInfo);
      }
      return handleGetMusicUrl(source, info.musicInfo, info.type)
        .then((data) => Promise.resolve(data))
        .catch((err) => Promise.reject(err));
    default:
      console.error(`action(${action}) not support`);
      return Promise.reject("action not support");
  }
});

if (UPDATE_ENABLE) checkUpdate();

send(EVENT_NAMES.inited, {
  status: true,
  openDevTools: DEV_ENABLE,
  sources: musicSources,
});
