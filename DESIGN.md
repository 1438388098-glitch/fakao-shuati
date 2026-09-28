# DESIGN — 关键设计决策记录

> **TL;DR**: fakao-shuati is a self-hosted bar-exam essay practice platform: a
> single-process Express app on Node's built-in `node:sqlite` (Node ≥ 22.5) — zero
> native dependencies, runs on one cheap VPS. AI grading has a three-tier fallback
> (on-server direct API, with a local AI coding CLI as an advanced alternative → a
> polling PC worker → manual report import); every path converges into one ingest
> function. Question banks, answers and reports never enter the database or the
> repo — file-based data directories only. Rendering is server-side EJS; the zh/en
> UI language rides a cookie + localStorage pair.

## 1. 存储：node:sqlite（Node ≥ 22.5）

- 决策：`src/db.js` 用内置 `node:sqlite` 的 `DatabaseSync`（WAL）；`package.json` engines 声明 `node>=22.5`，与 README、CI（node 22）一致。
- 备选项：better-sqlite3 / sqlite3（原生编译）；PostgreSQL / MySQL（独立数据库服务）；纯 JSON 文件。
- 理由：运行依赖仅 express + ejs 两个纯 JS 包，`npm install` 零编译、单目录部署；一台便宜 VPS 上 node + npm start 即可跑，无需外部数据库进程；同步 API 与单进程模型契合。
- 代价：锁死 Node ≥ 22.5（CI 注释：node:sqlite 需 ≥22.5、22.13 起免 flag，故不用 node 18/20）；SQLite 单写者，多实例不能共享一个库。

## 2. AI 批改三级兜底链路

- 决策：一级在服务器本机完成（`src/grader.js` `processOne`：API 直连为默认，本地 AI 编码 CLI + fakao-grader 评分技能为高级备选）；二级为 PC 工人（`worker/pc-worker.js` 凭 WORKER_TOKEN 轮询 `/api/worker/poll`，回传 `/api/worker/report`）；三级为「报告导入」页人工粘贴 JSON+Markdown。三条路终点统一：`importReportFiles` → `ingest()` 写 gradings 表并派生错题本。
- 备选项：仅 API 单点（失败即断流）；外置队列（Redis/BullMQ）+ 常驻批改服务。
- 理由：与 README「Three grading modes / second-level fallback」及 grader.js 头注释如实对应；服务器无 AI 出口网络时，由有 AI 环境的机器兜底；人工导入保证任何失败都可收尾。
- 代价：CLI/工人依赖那台机器上的 AI 编码 CLI 与技能配置；任务失败标 failed 后靠工人认领或人工重试，无自动重试；单次批改 15 分钟超时（`TIMEOUT_MS`）。

## 3. 数据边界：题库/答案/报告不入库、数据目录约定

- 决策：题库只从 `FAKAO_DATA_DIR`（默认 `./题库数据`）的 `*_raw.json` 只读加载（`src/questions.js`），不进 SQLite；运行数据集中在 `DATA_DIR`（默认 `./data`）：`shuati.db` + `作答/`（考生作答 md）+ `批改记录/`（报告 md/json），由 `src/db.js` 启动时创建；`.gitignore` 排除 `data/`、`题库数据/` 等目录。
- 备选项：题库导入数据库；作答与报告全量入库（行 / BLOB 存储）。
- 理由：本仓库是纯工具，不含任何题目/答案/采分点数据（README 顶部声明）；文件即数据，用户放入合法题库即可用，报告目录可与本地批改记录互通、随时导出（设置页文案）。
- 代价：gradings 表仅存报告路径（`md_path`），数据目录需整体搬移；题库改动即时生效、无版本化；API Key 存本机 SQLite，设置页仅回显后 4 位。

## 4. 前端渲染：EJS 服务端模板 + i18n 双轨

- 决策：EJS 服务端渲染（`views/`），无前端框架、无构建步骤；i18n 为内置中/英字典（`src/i18n.js`），服务端按 cookie `fklang` 取词渲染（`src/routes.js`）；「中/EN」切换写 localStorage（主存）+ cookie（供服务端渲染），`views/partials/head.ejs` 内联脚本检测两者不一致时回写 cookie，下次导航生效。
- 备选项：SPA（React/Vue）+ 纯 API；仅 cookie 单轨；客户端运行时翻译 DOM。
- 理由：页面以表单与列表为主，服务端渲染足够且免构建；cookie 保证首屏即为正确语言，localStorage 作主存兼容用户既有偏好；翻译范围仅界面框架文案，题干/答案/AI 报告等动态数据不翻译（i18n.js 头注释约定）。
- 代价：切换语言需一次导航刷新才完全生效；含 HTML 的词条须约束输出点（仅经 `<%- %>` 输出服务端生成内容，注释已约定）。

## 5. 已知取舍

- 单进程不横向扩展：express 单实例默认监听 127.0.0.1（`server.js`），批改经 `setImmediate` 在同进程内执行（`submit()`），无独立队列、无多实例方案；SQLite WAL 单写者。定位为朋友间共享的私人站，非高并发服务。
- 批改质量依赖所配置的模型与 subKeyWord 采分点数据质量（README：「the heart of AI grading quality」）；结果仅供练习参考，与真实阅卷有差异（README 免责声明）。
- 安全按私有自托管设计：noindex 响应头、站点密码、工人接口随机 token（settings 表 `worker_token`）；公网暴露需自加反代认证（README「Deployment & Security」）。
