# AGENTS.md

本项目是洛雪音乐源仓库，包含多个音乐源的 JS 文件。

## 项目结构

- `changqing/` - 长青 SVIP 音源
- `fish/` - fish_music 音源
- `flower/` - 野花源
- `grass/` - Grass 源
- `helloworld/` - hello world 聚合音源
- `huanyin/` - 幻音音源
- `huibq/` - Huibq 源
- `hyw/` - HYWmusic 公益版
- `ikun/` - ikun 源
- `jiexiang/` - 杰翔聚合音源
- `juhe/` - 聚合 API 源
- `lx/` - 洛雪官方源
- `qdy/` - 全豆要聚合音源
- `sixyin/` - 六音源
- `xinghai/` - 星海源
- `yuningxi/` - lx-玉宁熙-Pro 音源
- `CreateLatest.py` - 更新 latest.js 的脚本
- `probe.py` - 音源可用性探测脚本（本地打印表格，`--svg` 时生成报告图片）
- `health-status` 分支 - 数据分支（orphan），仅存放 `status.svg` 报告与 `health-state.json` 探测状态

## 命令

### 更新 latest.js

```bash
python CreateLatest.py
```

将各源的版本文件复制为 latest.js。

### 运行可用性探测

```bash
python probe.py                  # 只在标准输出打印表格
python probe.py --svg status.svg # 额外把报告写成 SVG 图片
```

- 仅用标准库，静态提取上游主机名，不执行音源脚本
- 探测状态读写在 `.health-state.json`（本地生成，已在 `.gitignore` 中）
- 脚本不修改 `README.md`；CI 只在状态变化时把报告与状态推送到 `health-status` 分支，`README.md` 以固定链接引用该图片

### 添加新版本

1. 将新版本 JS 文件放入对应源目录（如 `sixyin/1.2.2.js`）；文件名取自该文件头部 `@version` 去掉前导 `v`，上游随包文件名不作依据（如上游 `星海音乐源 v2.3.17.js` 的 `@version` 为 `v3.2.17`，入库名为 `3.2.17.js`）
2. 编辑 `CreateLatest.py`，更新 `VERSIONS` 字典中的版本号
3. 运行 `python CreateLatest.py`

### 新增音源

1. 完成"添加新版本"的三个步骤
2. 在 `README.md` 的"在线导入"章节按音源名字母升序插入对应小节，格式为：小节标题上方添加显式锚点 `<a id="<目录名>"></a>`（锚点名与音源目录名一致，供"在线导入"章节内部跳转；可用性报告为图片，不依赖锚点），小节内含两个独立代码块（第一个为原始链接、第二个为加速链接，含义见章节开头说明）

## 代码风格

### JS 文件规范

- 文件头部必须包含注释块，包含：
  - `@name` - 音源名称
  - `@description` - 描述和版本信息
  - `@version` - 版本号
  - `@author` - 作者
  - `@homepage` - 主页（可选）
  - `@repository` - 仓库地址（可选）
  - `@netease` / `@tencent` - 平台标识（可选）

示例：
```javascript
/*!
 * @name 六音音源
 * @description v1.2.1
 * @version v1.2.1
 * @author 六音
 * @homepage www.sixyin.com
 * @netease MUSIC_U=;
 * @tencent ts_last=y.qq.com/n/ryqq/album;
 * @preserve
 */
```

- `@preserve` 标记表示保留注释，防止被压缩工具移除

### Python 脚本规范

- 使用 Python 3
- 遵循 PEP 8 风格指南
- 使用类型提示（PEP 484）
- 注释使用中文

### 版本命名

- 使用语义化版本号（如 `1.2.0`, `4`）
- 版本号对应文件名（如 `1.2.0.js`）
- latest.js 始终指向当前最新版本

### Git 提交

- 标题格式为 `<type>: <中文描述>`，类型与描述之间用半角冒号加一个空格，描述使用中文
- 允许的类型：`feat`、`fix`、`docs`、`chore`、`refactor`、`perf`、`ci`、`build`、`test`、`style`
- 场景映射：新增音源用 `feat`；音源版本更新用 `chore`；修复缺陷用 `fix`；README、规格等文档改动用 `docs`；GitHub Actions 工作流改动用 `ci`
- 标题保持单行，不以句号等句末标点结尾；不使用 `[源名]` 前缀，也不要只写描述而省略类型
- 需要说明原因或影响范围时，在标题下方补正文；正文非必填
- 完整判定条件以本地 OpenSpec 工作区的 `commit-conventions` 规格为准（`openspec/` 未纳入版本跟踪，规则要点以本节为准）

示例：`feat: 新增星澜音源`、`fix: 修复 flower/grass 探测失真`、`docs: 更新 README 数据来源`、`chore: 更新 xinghai 到 v3.2.18`、`ci: 调整健康检查工作流`

反例：`Add xinglan source`、`[sixyin] 更新到 v1.2.1`、`feat 新增音源`、`feat：新增音源`

## 注意事项

- JS 文件通常是混淆或压缩后的代码，无需手动编辑
- 如需更新源，请从上游项目获取最新版本
- 保持各源目录结构一致
