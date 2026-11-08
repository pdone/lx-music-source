#!/usr/bin/env python3
"""音源可用性探测脚本。

遍历仓库内各音源的 latest.js，通过三种静态手段提取上游主机名
（明文 URL、十六进制转义字符串解码、头部 SERVER_SCRIPT_CONFIG
配置块），对去重后的主机发起 HTTP GET 探测并按响应分类，最终渲染
一份可用性报告。

报告有两种呈现：标准输出上的 markdown 表格（本地调试用，含锚点链接），
以及 --svg 指定的 SVG 图片（主分支 README 通过固定链接引用数据分支上
的该图片）。脚本不再修改 README.md。

状态文件记录各主机的连续失败计数、聚合后的音源状态与「状态更新于」
时刻：连续失败计数封顶于 FAIL_THRESHOLD，音源状态未变化的轮次沿用旧
时刻，因此状态没有变化时脚本不会产生任何文件差异（也就不会产生提交）。

约定：
- 仅使用 Python 标准库；
- 不执行任何音源脚本代码（安全边界）；
- 检测时间一律按北京时间（UTC+8）呈现。
"""

import argparse
import json
import re
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import urlsplit
from xml.sax.saxutils import escape as xml_escape

ROOT = Path(__file__).resolve().parent
STATE_PATH = ROOT / '.health-state.json'

# 兼容 Windows GBK 控制台，避免状态 emoji 输出导致 UnicodeEncodeError
# （与 CreateLatest.py 保持一致的做法）
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

PROBE_TIMEOUT = 10  # 单目标探测超时（秒）
MAX_WORKERS = 8     # 并发探测线程上限
FAIL_THRESHOLD = 2  # 连续失败多少次判定为"失效"
USER_AGENT = 'lx-music-source-health-check/1.0 (+https://github.com/pdone/lx-music-source)'
BEIJING_TZ = timezone(timedelta(hours=8))  # 北京时间（UTC+8）

# 探测状态
STATUS_OK = '可用'
STATUS_WARN = '异常'
STATUS_DEAD = '失效'
STATUS_UNKNOWN = '无法探测'
# 状态圆形标识（仅用于标准输出）：绿=可用，黄=异常，红=失效
STATUS_ICON = {
    STATUS_OK: '🟢',
    STATUS_WARN: '🟡',
    STATUS_DEAD: '🔴',
    STATUS_UNKNOWN: '⚪',
}

# 主机名（兼容 punycode 域名，如 88.lxmusic.xn--fiqs8s）
RE_HOST = re.compile(r'https?://((?:[A-Za-z0-9-]+\.)+(?:xn--[A-Za-z0-9-]+|[A-Za-z]{2,}))')
# IPv4 字面量（qdy 含裸 IP 链路）
RE_IPV4 = re.compile(r'https?://((?:\d{1,3}\.){3}\d{1,3})')
# 裸 IPv4 字面量（探测时判断是否走 http，不含 scheme）
RE_IPV4_LITERAL = re.compile(r'(?:\d{1,3}\.){3}\d{1,3}')
# 连续十六进制转义串（字符串阵列混淆，如 flower/grass）。
# 用 chr(92) 构字面反斜杠，避免源码转义层级歧义。
_BS = chr(92)
RE_HEX_RUN = re.compile(r'(?:' + re.escape(_BS) + r'x[0-9a-fA-F]{2}){4,}')
RE_HEX_BYTE = re.compile(re.escape(_BS) + r'x([0-9a-fA-F]{2})')
# 带 scheme 的片段起始。混淆阵列把一条 URL 拆进多个数组元素时，
# 只有首段带 scheme（如 'http://97.'），续段是纯数字与点（如 '64.37.235/'）。
RE_SCHEME_HEAD = re.compile(r'^https?://')
# 地址续段：仅数字与点，可带一个结尾斜杠。限定字符集是为了避免把
# 相邻但无关的文本片段拼进 URL（如 'js.org/flo' 属于另一条 URL）。
RE_ADDR_TAIL = re.compile(r'^[\d.]+/?$')
# 拼合上限：单条 URL 最多 3 段（首段 + 2 个续段），续段候选数上限 32，
# 拼合结果长度上限 256 字符，防止组合爆炸与跨值误拼。
MAX_URL_PARTS = 3
MAX_TAIL_CANDIDATES = 32
MAX_URL_LEN = 256
# 头部服务端下发配置块（lx 音源的 apiUrl 为 JSON 转义斜杠，明文正则匹配不到）
RE_SERVER_CONFIG = re.compile(r"SERVER_SCRIPT_CONFIG'?\]?\s*=\s*(\{[^{}]*\})")

# 明显不属于上游服务的域名黑名单：
#   www.w3.org  —— XML 命名空间噪音；
#   gistry.npm  —— registry.npmjs.org 被混淆阵列拆断后的碎片，非真实主机。
DOMAIN_BLOCKLIST = {'www.w3.org', 'gistry.npm'}

# SVG 报告排版参数。状态以图形圆点呈现，不依赖 emoji 字形；
# 整图绘制不透明底色，避免深色主题下的对比度问题。
SVG_WIDTH = 380
SVG_HEAD_H = 46
SVG_ROW_H = 26
SVG_FOOT_H = 32
SVG_NAME_X = 24
SVG_DOT_X = 228
SVG_STATUS_X = 244
SVG_FONT = ("-apple-system, BlinkMacSystemFont, 'Segoe UI', "
            "'Noto Sans SC', 'Microsoft YaHei', sans-serif")
# 状态圆点对应的 CSS 类（配色写在 <style> 里，浅色/深色各一套）
STATUS_CLASS = {
    STATUS_OK: 'ok',
    STATUS_WARN: 'warn',
    STATUS_DEAD: 'dead',
    STATUS_UNKNOWN: 'na',
}


def _decode_hex_fragments(text):
    """按源码出现顺序返回十六进制转义串解码出的 ASCII 片段。"""
    fragments = []
    for run in RE_HEX_RUN.findall(text):
        try:
            decoded = bytes(int(h, 16) for h in RE_HEX_BYTE.findall(run)).decode('ascii')
        except (ValueError, UnicodeDecodeError):
            continue
        fragments.append(decoded)
    return fragments


def _iter_join_parts(tails):
    """产出地址续段的拼合组合：单段，以及两段（不超过 MAX_URL_PARTS 段）。"""
    for tail in tails:
        yield [tail]
    if MAX_URL_PARTS < 3:
        return
    for first in tails:
        for second in tails:
            if first is not second:
                yield [first, second]


def _joined_ipv4_hosts(fragments):
    """把被阵列切碎的地址片段拼回 IPv4 主机名。

    混淆阵列的元素顺序不等于原文顺序（'http://97.' 的下一个元素往往是
    另一条 URL 的片段，如 'js.org/flo'），因此不做顺序拼接，而以带 scheme
    的首段为锚点与纯数字/点的续段组合；只有拼出完整 IPv4 才采纳，
    避免把无关片段拼成一个看似合法的域名。
    """
    heads = [f for f in fragments if RE_SCHEME_HEAD.match(f)]
    tails = [f for f in fragments if RE_ADDR_TAIL.fullmatch(f)][:MAX_TAIL_CANDIDATES]
    hosts = set()
    for head in heads:
        for parts in _iter_join_parts(tails):
            url = head + ''.join(parts)
            if len(url) > MAX_URL_LEN:
                continue
            host = urlsplit(url).hostname
            if host and RE_IPV4_LITERAL.fullmatch(host):
                hosts.add(host.lower())
    return hosts


def extract_hosts(text):
    """从音源源码中静态提取上游主机名，不执行脚本代码。"""
    hosts = set()
    for regex in (RE_HOST, RE_IPV4):
        hosts.update(m.lower() for m in regex.findall(text))
    # 十六进制转义字符串解码（flower/grass 的上游地址以此形式存储）
    fragments = _decode_hex_fragments(text)
    for decoded in fragments:
        # 片段本身就是带 scheme 的完整 URL
        for regex in (RE_HOST, RE_IPV4):
            hosts.update(m.lower() for m in regex.findall(decoded))
    # 被阵列切碎的地址：拼回完整 IPv4（如 'http://97.' + '64.37.235/'）
    hosts.update(_joined_ipv4_hosts(fragments))
    # 头部服务端下发配置（lx 音源的 apiUrl 是 JSON 转义斜杠，只能整块解析）
    for raw in RE_SERVER_CONFIG.findall(text):
        try:
            config = json.loads(raw)
        except ValueError:
            continue
        api_url = config.get('apiUrl') or config.get('api_url')
        if api_url:
            host = urlsplit(api_url).hostname
            if host:
                hosts.add(host.lower())
    return sorted(hosts - DOMAIN_BLOCKLIST)


def discover_sources():
    """返回 [(音源名, [上游主机...]), ...]，按目录名排序保证输出稳定。"""
    sources = []
    for latest in sorted(ROOT.glob('*/latest.js')):
        name = latest.parent.name
        text = latest.read_text(encoding='utf-8', errors='ignore')
        sources.append((name, extract_hosts(text)))
    return sources


def _elapsed_ms(start):
    """自 start（time.monotonic）以来的耗时毫秒数。"""
    return int((time.monotonic() - start) * 1000)


def probe_host(host, port=None):
    """对单个上游发起 GET 探测。

    返回 (raw, http_code, elapsed_ms)，raw 取值：
      'ok'     —— 2xx 响应；
      'warn'   —— 获得 HTTP 响应但非 2xx（401/403/429/5xx 等，上游存活）；
      'failed' —— 连接拒绝 / DNS 失败 / TLS 失败 / 超时等不可达情形。

    port 仅供测试注入（本地构造目标），生产调用不传。
    """
    # IPv4 字面量无 TLS 证书，走 http；其余走 https
    scheme = 'http' if RE_IPV4_LITERAL.fullmatch(host) else 'https'
    authority = host if port is None else '{}:{}'.format(host, port)
    url = '{}://{}/'.format(scheme, authority)
    start = time.monotonic()
    try:
        req = urllib_request.Request(url, method='GET', headers={'User-Agent': USER_AGENT})
        with urllib_request.urlopen(req, timeout=PROBE_TIMEOUT) as resp:
            code = resp.status
            raw = 'ok' if 200 <= code < 300 else 'warn'
            return raw, code, _elapsed_ms(start)
    except urllib_error.HTTPError as exc:
        # 能拿到 HTTP 状态码说明上游存活
        return 'warn', exc.code, _elapsed_ms(start)
    except Exception:
        # 其余（连接拒绝/DNS/TLS/超时等）一律视为不可达
        return 'failed', None, _elapsed_ms(start)


def resolve_status(raw, prev_fail_count):
    """结合历史失败计数做滞后判定。

    返回 (状态, 新的连续失败计数)：
      2xx         → 可用，计数清零（单次成功立即恢复）；
      非 2xx HTTP → 异常，计数清零（有响应即证明上游存活）；
      不可达      → 计数 +1，未达阈值显示异常，达到阈值才判失效。

    计数封顶于 FAIL_THRESHOLD：判定失效后不再继续递增，避免长期失效的
    主机让状态文件每天产生无意义差异。
    """
    if raw == 'ok':
        return STATUS_OK, 0
    if raw == 'warn':
        return STATUS_WARN, 0
    fail_count = min(prev_fail_count + 1, FAIL_THRESHOLD)
    if fail_count >= FAIL_THRESHOLD:
        return STATUS_DEAD, fail_count
    return STATUS_WARN, fail_count


# 状态聚合优先级：数值越小越优先（用于挑选代表性链路与音源级状态）
# “无法探测”不进入报告（run 层直接跳过），此处给最低档位仅作防御。
STATUS_PRIORITY = {STATUS_OK: 0, STATUS_WARN: 1, STATUS_DEAD: 2, STATUS_UNKNOWN: 3}


def aggregate_by_source(link_rows):
    """把按链路的结果聚合为每个音源一行。

    聚合规则：
      - 任一路线"可用" → 音源"可用"；
      - 否则任一路线"异常" → 音源"异常"；
      - 全部路线"失效" → 音源"失效"。
    输出按可用性排序：状态优先级 可用 → 异常 → 失效，状态相同时按音源名字母升序。
    """
    grouped = {}
    for row in link_rows:
        grouped.setdefault(row['source'], []).append(row)
    aggregated = []
    for source, rows in grouped.items():
        status = min((r['status'] for r in rows), key=lambda s: STATUS_PRIORITY[s])
        aggregated.append({'source': source, 'status': status})
    aggregated.sort(key=lambda r: (STATUS_PRIORITY[r['status']], r['source']))
    return aggregated


def render_table(rows):
    """渲染标准输出的 markdown 表格（表头 + 数据行，仅音源/状态两列）。

    音源列输出为指向 README"在线导入"章节中该音源小节显式锚点的
    markdown 链接，格式为 [<音源名>](#<音源名>)，锚点名与音源目录名
    一致（如 juhe 对应 <a id="juhe"></a>，而非标题 JuheApi 的自动
    slug）。排序在聚合阶段（aggregate_by_source）基于裸音源名完成，
    链接标记不参与排序。

    该表格仅用于本地查看；图片报告（render_svg）不包含任何链接。
    """
    lines = [
        '| 音源 | 状态 |',
        '| --- | --- |',
    ]
    for row in rows:
        lines.append('| [{}](#{}) | {} {} |'.format(
            row['source'], row['source'], STATUS_ICON[row['status']], row['status']))
    return '\n'.join(lines)


def render_time_line(updated_at):
    """渲染「状态更新于」行（北京时间，纯文本无引用前缀）。"""
    return '状态更新于：{}（北京时间）'.format(updated_at)


def _svg_style():
    """返回内嵌样式：浅色为默认配色，深色由 prefers-color-scheme 覆盖。

    配色与排版取值与仓库内的 Star History 图（star-history.svg）保持一致，
    使两张图在同一页面下观感统一。
    """
    return '\n'.join([
        '<style>',
        '  .bg{fill:#ffffff}',
        '  .rule{stroke:#e5e7eb;stroke-width:1}',
        '  .fg{fill:#111827}',
        '  .muted{fill:#6b7280}',
        '  .fg,.muted{font-family:' + SVG_FONT + '}',
        '  .h{font-size:15px;font-weight:600}',
        '  .cell{font-size:13px;font-weight:400}',
        '  .foot{font-size:12px;font-weight:400}',
        '  .ok{fill:#1a7f37}.warn{fill:#9a6700}.dead{fill:#cf222e}.na{fill:#8250df}',
        '  @media (prefers-color-scheme: dark){',
        '    .bg{fill:#0d1117}',
        '    .rule{stroke:#21262d}',
        '    .fg{fill:#c9d1d9}',
        '    .muted{fill:#8b949e}',
        '    .ok{fill:#3fb950}.warn{fill:#d29922}.dead{fill:#f85149}.na{fill:#a371f7}',
        '  }',
        '</style>',
    ])


def _svg_text(x, y, content, classes):
    """生成一个 SVG text 元素（内容按 XML 规则转义，样式由 class 提供）。"""
    return '  <text class="{}" x="{}" y="{}">{}</text>'.format(
        classes, x, y, xml_escape(content))


def render_svg(rows, updated_at):
    """把聚合后的结果渲染为 SVG 报告文本。

    布局：底色 + 表头 + 每音源一行（音源名 / 状态圆点 / 状态文字）
    + 底部的状态更新时刻。状态以 <circle> 绘制，报告不含 emoji 字符，
    也不含任何超链接（音源名不可点击）。底色与文字颜色由内嵌样式决定，
    在深色主题下自动切换为 GitHub 深色画布配色。
    """
    height = SVG_HEAD_H + SVG_ROW_H * len(rows) + SVG_FOOT_H
    desc = '共 {} 个音源的状态检测结果，状态更新于 {}（北京时间）'.format(len(rows), updated_at)
    parts = [
        ('<svg xmlns="http://www.w3.org/2000/svg" width="{0}" height="{1}" '
         'viewBox="0 0 {0} {1}" role="img" aria-labelledby="health-title health-desc">'
         ).format(SVG_WIDTH, height),
        '  <title id="health-title">音源可用性</title>',
        '  <desc id="health-desc">{}</desc>'.format(xml_escape(desc)),
        _svg_style(),
        '  <rect class="bg" width="{}" height="{}"/>'.format(SVG_WIDTH, height),
        _svg_text(SVG_NAME_X, 28, '音源', 'fg h'),
        _svg_text(SVG_DOT_X, 28, '状态', 'fg h'),
        '  <line class="rule" x1="{}" y1="38" x2="{}" y2="38"/>'.format(
            SVG_NAME_X, SVG_WIDTH - SVG_NAME_X),
    ]
    for index, row in enumerate(rows):
        baseline = SVG_HEAD_H + index * SVG_ROW_H + 17
        parts.append(_svg_text(SVG_NAME_X, baseline, row['source'], 'fg cell'))
        parts.append('  <circle class="dot {}" cx="{}" cy="{}" r="5"/>'.format(
            STATUS_CLASS.get(row['status'], 'na'), SVG_DOT_X, baseline - 4))
        parts.append(_svg_text(SVG_STATUS_X, baseline, row['status'], 'fg cell'))
    foot_y = SVG_HEAD_H + SVG_ROW_H * len(rows)
    parts.append('  <line class="rule" x1="{}" y1="{}" x2="{}" y2="{}"/>'.format(
        SVG_NAME_X, foot_y, SVG_WIDTH - SVG_NAME_X, foot_y))
    parts.append(_svg_text(
        SVG_NAME_X, foot_y + 20,
        '状态更新于 {}（北京时间）'.format(updated_at), 'muted foot'))
    parts.append('</svg>')
    return '\n'.join(parts) + '\n'


def load_state():
    """读取探测状态。

    返回 {'updated_at': str|None, 'hosts': {...}, 'sources': {...}}。
    文件缺失或损坏时按空状态处理；旧版扁平格式（形如
    {host: {consecutive_failures, last_status}}）按旧格式加载，
    updated_at 与 sources 视为未知，下一次运行时自然迁移为新结构。
    """
    empty = {'updated_at': None, 'hosts': {}, 'sources': {}}
    try:
        data = json.loads(STATE_PATH.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return empty
    if not isinstance(data, dict):
        return empty
    hosts = data.get('hosts')
    if isinstance(hosts, dict):
        sources = data.get('sources')
        updated_at = data.get('updated_at')
        return {
            'updated_at': updated_at if isinstance(updated_at, str) else None,
            'hosts': {h: v for h, v in hosts.items() if isinstance(v, dict)},
            'sources': sources if isinstance(sources, dict) else {},
        }
    # 旧版扁平格式
    return {
        'updated_at': None,
        'hosts': {h: v for h, v in data.items() if isinstance(v, dict)},
        'sources': {},
    }


def save_state(state):
    """写回状态文件（键排序 + 中文不转义，保证 diff 稳定）。"""
    payload = {
        'updated_at': state.get('updated_at'),
        'hosts': state.get('hosts') or {},
        'sources': state.get('sources') or {},
    }
    STATE_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + '\n',
        encoding='utf-8',
    )


def run(svg_path=None):
    """执行一轮探测。

    svg_path 非空时把报告写成 SVG 到该路径；状态文件仅在内容变化时重写，
    因此无状态变化的运行不产生任何文件差异。
    """
    sources = discover_sources()
    # 同一域名只探测一次（满足频率约束，多音源共享链路时复用结果）
    unique_hosts = sorted({host for _, hosts in sources for host in hosts})
    probe_results = {}
    if unique_hosts:
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            for host, result in zip(unique_hosts, pool.map(probe_host, unique_hosts)):
                probe_results[host] = result

    state = load_state()
    current_time = datetime.now(BEIJING_TZ).strftime('%Y-%m-%d %H:%M')
    link_rows = []
    new_hosts = {}
    for name, hosts in sources:
        if not hosts:
            # 无法静态提取上游域名的音源：不进入报告（探测与状态持久化也不涉及）
            continue
        for host in hosts:
            raw = probe_results[host][0]
            prev_fail_count = state['hosts'].get(host, {}).get('consecutive_failures', 0)
            status, fail_count = resolve_status(raw, prev_fail_count)
            new_hosts[host] = {'consecutive_failures': fail_count, 'last_status': status}
            # 报告仅两列，code/elapsed 不进入行数据（探测结果本身已在 probe_host 内记录）
            link_rows.append({'source': name, 'host': host, 'status': status})

    # 渲染层聚合：每个音源仅一行
    rows = aggregate_by_source(link_rows)
    new_sources = {row['source']: row['status'] for row in rows}
    report_changed = new_sources != state['sources']
    # 时间戳由状态变化驱动：音源级状态集合没变则沿用旧时刻，
    # 于是无变化的一轮渲染出的报告与旧文件逐字节相同。
    if report_changed or not state['updated_at']:
        updated_at = current_time
    else:
        updated_at = state['updated_at']
    new_state = {'updated_at': updated_at, 'hosts': new_hosts, 'sources': new_sources}

    print(render_table(rows))
    print()
    print(render_time_line(updated_at))

    if svg_path is not None:
        target = Path(svg_path)
        if target.parent and not target.parent.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(render_svg(rows, updated_at), encoding='utf-8')

    # 状态文件只在「报告变化」或「尚无状态文件 / 仍是旧格式」时落盘：
    # 时间戳刷新与连续失败计数递增（衍生态）不单独构成提交理由。
    # 计数未落盘的代价仅是极少数边角情形下判定「失效」晚一轮。
    state_changed = report_changed or not state['updated_at'] or not STATE_PATH.exists()
    if state_changed:
        save_state(new_state)
    print('状态文件 {}，报告 {}'.format(
        '已更新' if state_changed else '无变化',
        '无输出' if svg_path is None else '已写出'), file=sys.stderr)


def parse_args(argv=None):
    """解析命令行参数。"""
    parser = argparse.ArgumentParser(description='音源可用性探测')
    parser.add_argument(
        '--svg', metavar='PATH', default=None,
        help='把可用性报告写成 SVG 图片到指定路径（默认只在标准输出打印表格）')
    return parser.parse_args(argv)


def main(argv=None):
    """入口；脚本自身异常时以非零退出码结束。"""
    args = parse_args(argv)
    try:
        run(args.svg)
    except Exception:
        traceback.print_exc()
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
