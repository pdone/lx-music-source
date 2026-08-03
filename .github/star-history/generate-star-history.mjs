// 生成 Star 历史图表 SVG（零依赖，仅用 Node 标准库）
// 用法：node generate-star-history.mjs
// 环境变量：OWNER, REPO, GITHUB_TOKEN
// 读取 repo/history.json，追加今日 stargazers_count 快照，生成 SVG

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const OWNER = process.env.OWNER;
const REPO = process.env.REPO;
const TOKEN = process.env.GITHUB_TOKEN;
const DATA_DIR = process.env.DATA_DIR || './repo';
const HISTORY_FILE = `${DATA_DIR}/history.json`;
const SVG_FILE = `${DATA_DIR}/star-history.svg`;

if (!OWNER || !REPO) {
  console.error('缺少 OWNER 或 REPO 环境变量');
  process.exit(1);
}

// 获取当前 star 总数（公开数据，GITHUB_TOKEN 即可）
async function fetchStarCount() {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}`;
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'star-history-bot',
  };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`获取仓库信息失败: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data.stargazers_count ?? 0;
}

// 读取现有历史数据，不存在则初始化
async function loadHistory() {
  if (existsSync(HISTORY_FILE)) {
    const raw = await readFile(HISTORY_FILE, 'utf8');
    try {
      return JSON.parse(raw);
    } catch {
      console.warn('history.json 解析失败，重新初始化');
    }
  }
  return { repo: `${OWNER}/${REPO}`, points: [] };
}

// 追加今日快照（同日覆盖，幂等）
function appendSnapshot(history, date, count) {
  const points = history.points || [];
  const idx = points.findIndex((p) => p.date === date);
  if (idx >= 0) {
    // 同日重复运行：仅当数量变化时更新，避免空提交
    if (points[idx].count === count) return false;
    points[idx].count = count;
  } else {
    points.push({ date, count });
  }
  history.points = points;
  return true;
}

// 生成 SVG 图表
function generateSVG(history) {
  const points = history.points || [];
  const W = 720;
  const H = 260;
  const PAD_L = 56;
  const PAD_R = 24;
  const PAD_T = 24;
  const PAD_B = 36;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  if (points.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" role="img" aria-label="Star History">
<title>Star History for ${OWNER}/${REPO}</title>
<desc>暂无数据</desc>
<rect width="${W}" height="${H}" fill="#ffffff"/>
<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#888" font-family="sans-serif" font-size="14">暂无 star 历史数据</text>
</svg>`;
  }

  const minCount = Math.min(...points.map((p) => p.count));
  const maxCount = Math.max(...points.map((p) => p.count));
  const range = Math.max(1, maxCount - minCount);

  const n = points.length;
  const xOf = (i) => PAD_L + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yOf = (c) => PAD_T + plotH - ((c - minCount) / range) * plotH;

  // 构造折线路径
  const linePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xOf(i).toFixed(2)} ${yOf(p.count).toFixed(2)}`)
    .join(' ');

  // 构造填充区域路径
  const areaPath =
    `M ${xOf(0).toFixed(2)} ${(PAD_T + plotH).toFixed(2)} ` +
    points.map((p, i) => `L ${xOf(i).toFixed(2)} ${yOf(p.count).toFixed(2)}`).join(' ') +
    ` L ${xOf(n - 1).toFixed(2)} ${(PAD_T + plotH).toFixed(2)} Z`;

  // Y 轴刻度（4 档）
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((r) => {
    const c = Math.round(minCount + r * range);
    const y = yOf(c);
    return { c, y };
  });

  // X 轴标签（首、尾、中间）
  const xLabels = [];
  const labelIdx = [0, Math.floor((n - 1) / 2), n - 1];
  labelIdx.forEach((i) => {
    if (points[i]) {
      xLabels.push({ x: xOf(i), label: points[i].date.slice(5) }); // MM-DD
    }
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Star History">
<title>Star History for ${OWNER}/${REPO}</title>
<desc>从 ${points[0].date} 到 ${points[n - 1].date}，star 数从 ${points[0].count} 增长到 ${points[n - 1].count}</desc>
<style>
  .bg { fill: #ffffff; }
  .grid { stroke: #e5e7eb; stroke-width: 1; }
  .axis { stroke: #9ca3af; stroke-width: 1; }
  .area { fill: rgba(59, 130, 246, 0.15); }
  .line { fill: none; stroke: #3b82f6; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .dot { fill: #3b82f6; }
  .tlabel { fill: #6b7280; font-family: -apple-system, sans-serif; font-size: 11px; }
  .title { fill: #111827; font-family: -apple-system, sans-serif; font-size: 13px; font-weight: 600; }
  @media (prefers-color-scheme: dark) {
    .bg { fill: #0d1117; }
    .grid { stroke: #21262d; }
    .axis { stroke: #484f58; }
    .area { fill: rgba(58, 132, 255, 0.18); }
    .line { stroke: #58a6ff; }
    .dot { fill: #58a6ff; }
    .tlabel { fill: #8b949e; }
    .title { fill: #c9d1d9; }
  }
</style>
<rect class="bg" width="${W}" height="${H}"/>
<text class="title" x="${PAD_L}" y="${PAD_T - 8}">${OWNER}/${REPO} · Star History</text>
${yTicks.map((t) => `<line class="grid" x1="${PAD_L}" y1="${t.y.toFixed(2)}" x2="${W - PAD_R}" y2="${t.y.toFixed(2)}"/>`).join('\n')}
${yTicks.map((t) => `<text class="tlabel" x="${PAD_L - 8}" y="${(t.y + 3).toFixed(2)}" text-anchor="end">${t.c}</text>`).join('\n')}
<line class="axis" x1="${PAD_L}" y1="${PAD_T + plotH}" x2="${W - PAD_R}" y2="${PAD_T + plotH}"/>
<path class="area" d="${areaPath}"/>
<path class="line" d="${linePath}"/>
${points.map((p, i) => `<circle class="dot" cx="${xOf(i).toFixed(2)}" cy="${yOf(p.count).toFixed(2)}" r="2.5"/>`).join('\n')}
${xLabels.map((l) => `<text class="tlabel" x="${l.x.toFixed(2)}" y="${PAD_T + plotH + 20}" text-anchor="middle">${l.label}</text>`).join('\n')}
<text class="tlabel" x="${W - PAD_R}" y="${PAD_T + plotH + 20}" text-anchor="end">${points[n - 1].count} ★</text>
</svg>`;

  return svg;
}

async function main() {
  console.log(`获取 ${OWNER}/${REPO} 当前 star 数...`);
  const count = await fetchStarCount();
  console.log(`当前 star 数: ${count}`);

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const history = await loadHistory();
  const changed = appendSnapshot(history, today, count);

  if (!changed) {
    console.log('今日快照无变化，跳过更新');
  } else {
    console.log(`更新快照: ${today} = ${count}`);
  }

  // 无论是否变化都重新生成 SVG（确保 SVG 存在且最新）
  const svg = generateSVG(history);
  await writeFile(HISTORY_FILE, JSON.stringify(history, null, 2) + '\n', 'utf8');
  await writeFile(SVG_FILE, svg + '\n', 'utf8');
  console.log(`已写入 ${HISTORY_FILE} 和 ${SVG_FILE}`);
}

main().catch((err) => {
  console.error('执行失败:', err);
  process.exit(1);
});
