// 初始化 Star 历史（一次性运行，拉取全部历史 stargazer 时间数据）
// 用法：node init-star-history.mjs
// 环境变量：OWNER, REPO, STAR_HISTORY_TOKEN（需管理员/协作者的 PAT，建议 fine-grained 只读 Metadata，用完即删）
//
// 原理：GitHub 已限制 /repos/{owner}/{repo}/stargazers 接口仅管理员可访问，
//       因此初始化必须用有权限的 token 拉取所有 stargazer 的 starred_at 时间，
//       按日聚合成 {date, count} 快照，写入 repo/history.json。
//       后续每日运行 daily 模式只需 GITHUB_TOKEN 读 stargazers_count 即可。

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const OWNER = process.env.OWNER;
const REPO = process.env.REPO;
const TOKEN = process.env.STAR_HISTORY_TOKEN;
const DATA_DIR = process.env.DATA_DIR || './repo';
const HISTORY_FILE = `${DATA_DIR}/history.json`;
const SVG_FILE = `${DATA_DIR}/star-history.svg`;

if (!OWNER || !REPO) {
  console.error('缺少 OWNER 或 REPO 环境变量');
  process.exit(1);
}
if (!TOKEN) {
  console.error('init 模式必须提供 STAR_HISTORY_TOKEN（管理员 PAT）');
  console.error('注意：自 2026-06-30 起 GitHub 限制 stargazers 接口仅管理员可访问');
  console.error('请在仓库 Settings → Secrets and variables → Actions 添加 STAR_HISTORY_TOKEN');
  process.exit(1);
}

const headers = {
  Accept: 'application/vnd.github.star+json',
  'X-GitHub-Api-Version': '2022-11-28',
  Authorization: `Bearer ${TOKEN}`,
  'User-Agent': 'star-history-init-bot',
};

// 拉取所有 stargazer 的 starred_at 时间
async function fetchAllStarredAt() {
  const starredAtList = [];
  let page = 1;
  const perPage = 100;
  // 安全上限：10 万 star
  const MAX_PAGES = 1000;

  while (page <= MAX_PAGES) {
    const url = `https://api.github.com/repos/${OWNER}/${REPO}/stargazers?per_page=${perPage}&page=${page}`;
    console.log(`拉取第 ${page} 页...`);
    const res = await fetch(url, { headers });

    if (res.status === 403 || res.status === 404) {
      console.error(`\n❌ 无法访问 stargazers 接口 (${res.status})`);
      console.error('可能原因：');
      console.error('  1. STAR_HISTORY_TOKEN 无权限（需仓库管理员/协作者的 PAT）');
      console.error('  2. fine-grained PAT 未勾选 Metadata 只读权限');
      console.error('  3. classic PAT 未勾选 public_repo / repo 权限');
      const body = await res.text();
      console.error(`响应: ${body.slice(0, 300)}`);
      process.exit(2);
    }
    if (!res.ok) {
      console.error(`请求失败: ${res.status} ${res.statusText}`);
      const body = await res.text();
      console.error(`响应: ${body.slice(0, 300)}`);
      process.exit(2);
    }

    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;

    for (const item of data) {
      if (item.starred_at) {
        starredAtList.push(item.starred_at);
      }
    }
    console.log(`  本页 ${data.length} 条，累计 ${starredAtList.length} 条`);

    if (data.length < perPage) break;
    page++;

    // 避免触发次要速率限制
    await new Promise((r) => setTimeout(r, 200));
  }

  return starredAtList;
}

// 按日聚合成累计快照
function aggregateByDay(starredAtList) {
  const dayCount = new Map();
  for (const iso of starredAtList) {
    const day = iso.slice(0, 10);
    dayCount.set(day, (dayCount.get(day) || 0) + 1);
  }
  const days = [...dayCount.keys()].sort();
  if (days.length === 0) return [];

  const points = [];
  let cumulative = 0;
  for (const day of days) {
    cumulative += dayCount.get(day);
    points.push({ date: day, count: cumulative });
  }
  return points;
}

// 合并已有 history.json（避免覆盖 daily 模式新追加的点）
function mergePoints(oldPoints, newPoints) {
  const map = new Map();
  for (const p of newPoints) map.set(p.date, p.count);
  for (const p of oldPoints) {
    // 旧数据有但新初始化没有的日期（可能是 init 之后 daily 记录的），保留旧值
    if (!map.has(p.date)) map.set(p.date, p.count);
  }
  const merged = [...map.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return merged;
}

async function loadExisting() {
  if (existsSync(HISTORY_FILE)) {
    try {
      const raw = await readFile(HISTORY_FILE, 'utf8');
      return JSON.parse(raw);
    } catch {
      /* ignore */
    }
  }
  return { repo: `${OWNER}/${REPO}`, points: [] };
}

// 复用 generate 脚本的 SVG 生成逻辑（内联简化版，保证 init 后立即有图）
function generateSVG(points) {
  const W = 720, H = 260, PAD_L = 56, PAD_R = 24, PAD_T = 24, PAD_B = 36;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  if (points.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" role="img"><rect width="${W}" height="${H}" fill="#fff"/><text x="${W/2}" y="${H/2}" text-anchor="middle" fill="#888">暂无数据</text></svg>`;
  }
  const minC = Math.min(...points.map(p => p.count));
  const maxC = Math.max(...points.map(p => p.count));
  const range = Math.max(1, maxC - minC);
  const n = points.length;
  const xOf = i => PAD_L + (n === 1 ? plotW/2 : (i/(n-1))*plotW);
  const yOf = c => PAD_T + plotH - ((c-minC)/range)*plotH;
  const linePath = points.map((p,i)=>`${i===0?'M':'L'} ${xOf(i).toFixed(2)} ${yOf(p.count).toFixed(2)}`).join(' ');
  const areaPath = `M ${xOf(0).toFixed(2)} ${(PAD_T+plotH).toFixed(2)} ` + points.map((p,i)=>`L ${xOf(i).toFixed(2)} ${yOf(p.count).toFixed(2)}`).join(' ') + ` L ${xOf(n-1).toFixed(2)} ${(PAD_T+plotH).toFixed(2)} Z`;
  const yTicks = [0,0.25,0.5,0.75,1].map(r=>({c:Math.round(minC+r*range),y:yOf(Math.round(minC+r*range))}));
  const xLabels = [0, Math.floor((n-1)/2), n-1].filter((v,i,a)=>a.indexOf(v)===i).map(i=>points[i]?{x:xOf(i),label:points[i].date.slice(5)}:null).filter(Boolean);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Star History">
<title>Star History for ${OWNER}/${REPO}</title>
<desc>从 ${points[0].date} 到 ${points[n-1].date}，star 数从 ${points[0].count} 增长到 ${points[n-1].count}</desc>
<style>
  .bg{fill:#fff}.grid{stroke:#e5e7eb;stroke-width:1}.axis{stroke:#9ca3af;stroke-width:1}
  .area{fill:rgba(59,130,246,0.15)}.line{fill:none;stroke:#3b82f6;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
  .dot{fill:#3b82f6}.tlabel{fill:#6b7280;font-family:-apple-system,sans-serif;font-size:11px}
  .title{fill:#111827;font-family:-apple-system,sans-serif;font-size:13px;font-weight:600}
  @media(prefers-color-scheme:dark){.bg{fill:#0d1117}.grid{stroke:#21262d}.axis{stroke:#484f58}.area{fill:rgba(58,132,255,0.18)}.line{stroke:#58a6ff}.dot{fill:#58a6ff}.tlabel{fill:#8b949e}.title{fill:#c9d1d9}}
</style>
<rect class="bg" width="${W}" height="${H}"/>
<text class="title" x="${PAD_L}" y="${PAD_T-8}">${OWNER}/${REPO} · Star History</text>
${yTicks.map(t=>`<line class="grid" x1="${PAD_L}" y1="${t.y.toFixed(2)}" x2="${W-PAD_R}" y2="${t.y.toFixed(2)}"/>`).join('\n')}
${yTicks.map(t=>`<text class="tlabel" x="${PAD_L-8}" y="${(t.y+3).toFixed(2)}" text-anchor="end">${t.c}</text>`).join('\n')}
<line class="axis" x1="${PAD_L}" y1="${PAD_T+plotH}" x2="${W-PAD_R}" y2="${PAD_T+plotH}"/>
<path class="area" d="${areaPath}"/>
<path class="line" d="${linePath}"/>
${points.map((p,i)=>`<circle class="dot" cx="${xOf(i).toFixed(2)}" cy="${yOf(p.count).toFixed(2)}" r="2.5"/>`).join('\n')}
${xLabels.map(l=>`<text class="tlabel" x="${l.x.toFixed(2)}" y="${PAD_T+plotH+20}" text-anchor="middle">${l.label}</text>`).join('\n')}
<text class="tlabel" x="${W-PAD_R}" y="${PAD_T+plotH+20}" text-anchor="end">${points[n-1].count} ★</text>
</svg>`;
}

async function main() {
  console.log(`初始化 ${OWNER}/${REPO} 的 star 历史...`);
  console.log('⚠️  此操作会调用受限的 stargazers 接口，需要管理员 PAT\n');

  const starredAtList = await fetchAllStarredAt();
  console.log(`\n共获取 ${starredAtList.length} 条 star 记录`);

  const newPoints = aggregateByDay(starredAtList);
  console.log(`聚合为 ${newPoints.length} 个日期点`);
  if (newPoints.length > 0) {
    console.log(`  最早: ${newPoints[0].date} (${newPoints[0].count} ★)`);
    console.log(`  最新: ${newPoints[newPoints.length-1].date} (${newPoints[newPoints.length-1].count} ★)`);
  }

  const existing = await loadExisting();
  const mergedPoints = mergePoints(existing.points || [], newPoints);
  const history = { repo: `${OWNER}/${REPO}`, points: mergedPoints };

  await writeFile(HISTORY_FILE, JSON.stringify(history, null, 2) + '\n', 'utf8');
  await writeFile(SVG_FILE, generateSVG(mergedPoints) + '\n', 'utf8');
  console.log(`\n✅ 已写入 ${HISTORY_FILE}（${mergedPoints.length} 个点）和 ${SVG_FILE}`);
}

main().catch((err) => {
  console.error('执行失败:', err);
  process.exit(1);
});
