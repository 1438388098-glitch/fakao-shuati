# 法考主观题刷题平台（fakao-shuati）

> **English TL;DR** — A self-hosted bar-exam (法考) essay practice platform: question bank browsing, timed answering, **AI grading against official scoring points** (✓ full / △ partial / ✗ miss), deep review reports, statistics dashboard, error book and recitation mode. Single-process Express + Node's built-in SQLite — zero native dependencies, runs on a cheap VPS. 5 smoke tests covering the full grading chain with a mocked AI API.

自托管的法考主观题备考站：题库浏览、限时作答、**AI 按采分点批改**、深度复盘报告、统计看板、错题本、采分点背诵。单进程 Express + Node 内置 SQLite，零原生依赖，一台便宜 VPS 即可跑。

> 本仓库**不含任何题目、答案或评分标准数据**。你需要自备拥有合法使用权的题库文件（格式见下文），放入数据目录即可。

## 功能

- **题库**：按科目/分组浏览，题目状态跟踪（未做/草稿/已批改）
- **作答**：左右卡片布局（题干常驻左侧），多小问独立作答框，5 秒自动保存，考前倒计时，模拟计时器
- **AI 批改**：一键提交，AI 逐采分点判定（✓ 全对 / △ 半对 / ✗ 未命中），输出深度复盘报告（逐点对照、连锁失分警示、原文对照、提分建议）
- **报告**：Markdown 深度复盘 + 结构化得分数据，支持人工导入第三方报告
- **统计看板**：得分率与采分点命中率趋势、丢分点类型分布（结论/依据/分析）、科目覆盖进度
- **错题本**：按未命中采分点自动派生，支持重刷销号
- **背诵**：翻卡式采分点背诵模式，标记已掌握
- **多用户**：数据按账号隔离（适合和朋友拼一台服务器）
- **深浅色主题**：跟随系统 + 手动切换

## 快速开始

要求 Node.js ≥ 22.5（用到内置 `node:sqlite`）。

```bash
npm install
FAKAO_DATA_DIR=./题库数据 npm start   # 默认 http://127.0.0.1:3210
```

1. 首次访问 `/setup` 创建管理员账号（不预置任何账号）。
2. 把题库文件放进 `FAKAO_DATA_DIR` 目录（默认 `./题库数据`），格式见下文。
3. 在「设置」页填写 AI API（或用环境变量，见下文）。
4. 去做题，交卷，等报告。

### 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 监听端口 | `3210` |
| `BASE_PATH` | 反向代理子路径部署（如 `/shuati`） | 空 |
| `DATA_DIR` | 运行数据目录（SQLite、作答、批改记录） | `./data` |
| `FAKAO_DATA_DIR` | 题库数据目录（只读） | `./题库数据` |
| `AI_MODE` | `api` / `cli` / 留空自动 | 自动 |
| `AI_FORMAT` | API 格式：`openai`（/chat/completions）或 `anthropic`（/v1/messages） | `openai` |
| `AI_BASE_URL` | API 端点，到版本号为止，如 `https://api.deepseek.com/v1` | — |
| `AI_API_KEY` | API Key（也可在设置页填，存服务器数据库，页面回显只留尾 4 位） | — |
| `AI_MODEL` | 模型名，如 `deepseek-chat` / `glm-4.7-flash` / `gpt-4o-mini` | — |
| `AI_MAX_TOKENS` | 单次批改输出上限 | `16000` |

任何 OpenAI 兼容端点（OpenAI / DeepSeek / 智谱 GLM / Kimi / 本地 ollama+网关等）与 Anthropic 兼容端点都可用，设置页填 Base URL + Key + 模型名即可，**换模型不用改一行代码**。

## 题库数据格式

`FAKAO_DATA_DIR` 下每个科目一个 `*_raw.json`，科目清单由同目录 `subjects.json` 定义（缺省时自动扫描目录内全部 `*_raw.json`，示例见 [`examples/subjects.example.json`](examples/subjects.example.json)）：

```json
[
  { "file": "刑法_raw.json", "key": "xingfa", "name": "刑法（真题）", "alias": "刑法", "group": "历年真题" }
]
```

- `key`：URL 与数据库里的科目标识，建库后**不可更改**
- `alias`：批改提示词里的科目叫法
- `group`：题库页的分组标题（如「历年真题」「冲刺专项」）

题目文件格式：

```json
{
  "data": [{
    "id": 12345,
    "sn": "2025",
    "snText": "2025年·真题·第2题",
    "question": "题干（支持换行，HTML 标签会被剥离）",
    "score": 32,
    "subList": [{
      "subOrder": 1,
      "subQuestion": "第1问：分析甲的刑事责任。",
      "subScore": 6,
      "answer": "参考答案全文……",
      "subKeyWord": "[{\"text\":\"甲构成故意杀人罪\",\"score\":3,\"whiteList\":[{\"text\":\"故意杀人\"}],\"blackList\":[]}]"
    }]
  }]
}
```

`subKeyWord` 是**采分点评分标准**（JSON 字符串），这是 AI 批改的质量核心：

| 字段 | 说明 |
|---|---|
| `text` | 采分点表述（AI 判定的目标） |
| `score` | 该点分值（各点之和 = 小问分值） |
| `whiteList` | 等价表述白名单（命中即算该点成立） |
| `blackList` | 黑名单表述（考生自己写出的错误定性，触发连锁失分） |

测试夹具 [`test/smoke.test.cjs`](test/smoke.test.cjs) 里有一个最小可运行的完整示例。

## AI 批改原理

提交作答后，平台把题干、逐问采分点（含白/黑名单）、参考答案与评分规则组装成提示词发给 AI，要求其：

1. 逐点判定（✓ 满分 / △ 半分 / ✗ 零分，不倒扣），标注点类型（结论/依据/分析）与置信度；
2. 结论性定性错误触发连锁失分；
3. 输出结构化 JSON（入库、派生错题本）+ Markdown 深度复盘报告（落盘到 `data/批改记录/`）。

批改方式三选一（设置页可切换）：

- **API 直连**（推荐）：上面表格里的三个字段填上就行；
- **本地 CLI**（高级）：调用本机 AI 编码 CLI（`GRADER_CMD`，如 `claude -p {prompt}`）配合 [fakao-grader 评分技能](https://github.com/1438388098-glitch/fakao-grader)；
- **人工导入**：任何方式失败时，可在报告导入页粘贴 JSON + Markdown 补录。

另有二级兜底：`WORKER_TOKEN=xxx SERVER=https://你的域名 npm run worker` 可在一台有 AI 环境的电脑上跑批改工人，自动认领服务器上失败的任务。

## 部署与安全

- 本项目为**私人自托管**设计：全站密码保护、`noindex` 响应头、worker 接口走随机 token。请勿公开暴露在无防护的公网域名下，或至少加一层反代 basic auth。
- API Key 存在你自己的服务器 SQLite 里，不进代码、不进日志。
- 反代示例（nginx，子路径）：

```nginx
location ^~ /shuati/ {
    proxy_pass http://127.0.0.1:3210;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

## 测试

```bash
npm test
```

5 个冒烟测试：题库加载、认证流程数据链、报告采集入库、Markdown 渲染、**mock API 端到端批改**（起本地假端点走完整 `processOne` 链路）。

## 版权与免责声明

- 本仓库是纯工具，**不含任何受版权保护的题目、答案、解析或评分标准**。
- 使用者需自行准备拥有合法使用权的题库数据，并仅限个人学习使用，不得传播。
- AI 批改结果仅供练习参考，与真实阅卷评分存在差异。

## License

[MIT](LICENSE)
