// 批改流水线：AI API（一级，默认）→ 报告采集入库 → 错题本派生
// CLI 模式（调用本地 AI 编码 CLI + 评分技能）为高级备选；
// 二级（PC 工人）与三级（对话批改后导入）最终都走 importReportFiles 入库
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { db, getSetting, DATA_DIR } = require('./db');
const { byQid } = require('./questions').loadAll();
const { DATA_DIR: BANK_DIR } = require('./questions');

const ANSWER_DIR = path.join(DATA_DIR, '作答');
const RECORD_DIR = path.join(DATA_DIR, '批改记录');
const GRADER_CMD = process.env.GRADER_CMD || 'zcode -p {prompt}';
const GRADER_SKILL = process.env.GRADER_SKILL_PATH || path.join(process.env.USERPROFILE || process.env.HOME || '', '.zcode', 'skills', 'fakao-grader', 'SKILL.md');
const TIMEOUT_MS = 15 * 60 * 1000;
const AI_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS) || 16000;

function getAttempt(id) { return db.prepare('SELECT * FROM attempts WHERE id=?').get(id); }

// ---- AI 配置：设置页（settings 表）优先，其次环境变量 ----
function aiField(settingKey, envName) {
  const s = getSetting(settingKey);
  return ((s && String(s).trim()) || process.env[envName] || '').trim();
}
function getAiConfig() {
  const mode = aiField('ai_mode', 'AI_MODE') ||
    (process.env.GRADER_CMD ? 'cli' : 'api'); // 部署过 CLI 的老环境保持 CLI，新装默认 API
  return {
    mode,
    format: aiField('ai_format', 'AI_FORMAT') || 'openai',   // openai | anthropic
    baseUrl: aiField('ai_base_url', 'AI_BASE_URL'),           // 如 https://api.openai.com/v1
    apiKey: aiField('ai_api_key', 'AI_API_KEY'),
    model: aiField('ai_model', 'AI_MODEL'),
  };
}

// 把作答写成 markdown（三级导入/人工核对也用）
function writeAttemptMd(attempt) {
  const q = byQid[attempt.question_id];
  if (!q) throw new Error('question not found: ' + attempt.question_id);
  const answers = JSON.parse(attempt.answers_json || '{}');
  const lines = [`# ${q.snText} 作答`, ''];
  lines.push('## 题干', '', q.stem, '');
  for (const s of q.subs) {
    lines.push(`## 第${s.subOrder}问（${s.subScore}分）`, '', s.subQuestion, '', '【考生作答】', '', String(answers[s.subOrder] || '（未作答）').trim(), '');
  }
  const file = path.join(ANSWER_DIR, `attempt-${attempt.id}.md`);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return { file, q };
}

function reportPaths(attemptId) {
  const base = path.join(RECORD_DIR, `attempt-${attemptId}-评`);
  return { md: base + '.md', json: base + '.json' };
}

function rubricLine(p, i) {
  const wl = (p.whiteList || []).map(w => w.text).filter(Boolean);
  const bl = (p.blackList || []).map(w => w.text).filter(Boolean);
  return `P${i + 1}（${p.score}分）${p.text}` + (wl.length ? `｜等价表述：${wl.join('、')}` : '') + (bl.length ? `｜黑名单：${bl.join('、')}` : '');
}

// API 模式提示词：评分规则内嵌（与 fakao-grader 技能同源的精简版），数据自包含
function buildApiPrompt(attempt, q) {
  const answers = JSON.parse(attempt.answers_json || '{}');
  const alias = q.alias || '';
  const out = [];
  out.push('你是法考主观题评分老师。严格按以下规则与采分点判卷，不臆造采分点。', '');
  out.push('【评分规则】');
  out.push('1. 逐采分点判定：✓ 完全命中（得该点满分）；△ 部分命中（得该点一半分）；✗ 未命中（0 分）。不倒扣分。');
  out.push('2. 结论性定性错误 → 依赖该结论的分析/依据点判 ✗（连锁失分），并在报告中专节警示。');
  out.push('3. 黑名单词只在考生自己写的结论性语句中生效；转述材料原文、假设性表述不算命中黑名单。');
  out.push('4. 存疑从宽：拿不准是否等价表述时按 ✓/△ 判并标 confidence「低」，复核后仍不确定的维持从宽；等价简称（如"民族复兴"≈"中华民族伟大复兴"）算命中。');
  out.push('5. 每个点标 type：结论（定性/定调）/ 依据（规范表述、法条、固定论断）/ 分析（涵摄、说理）。');
  out.push('6. 预估带 band=[低,高]：真实阅卷是"先定档、档内采点"的整体印象制，band 为按该口径的考场分数区间。');
  out.push('7. 报告为中文 Markdown 深度复盘，须含：逐问采分点对照表（判定+依据句）、连锁失分警示、原文与参考答案关键段对照、提分建议（按性价比排序）。');
  out.push('');
  out.push(`【本次批改】科目：${alias || q.subjectKey}　题目：${q.snText}（满分 ${q.score} 分，${q.subs.length} 问）`);
  out.push('【题干】', q.stem, '');
  for (const s of q.subs) {
    out.push(`【第${s.subOrder}问】（${s.subScore}分）${s.subQuestion}`);
    if (s.answer) out.push('【参考答案】', s.answer);
    if (s.points && s.points.length) {
      out.push('【采分点】');
      s.points.forEach((p, i) => out.push(rubricLine(p, i)));
    } else {
      out.push('【采分点】（本题无结构化采分点，按参考答案的规范表述句自行拆点，每点 1~3 分，总分不超过该问分值）');
    }
    out.push('【考生作答】', String(answers[s.subOrder] || '（未作答）').trim(), '');
  }
  out.push('【输出格式】只输出以下两段标记内容，标记名与顺序不得改动：');
  out.push('<<<REPORT_MD>>>', '（Markdown 深度复盘报告全文）', '<<<END_REPORT_MD>>>');
  out.push('<<<REPORT_JSON>>>', '{"subject":"科目名","snText":"题号","score":数字,"fullScore":数字,"band":[低,高],"tier":"档位描述","subs":[{"subOrder":1,"max":6,"score":4.5,"points":[{"id":1,"verdict":"✓|△|✗","type":"结论|依据|分析","confidence":"高|中|低"}]}],"missTypes":{"结论":0,"依据":0,"分析":0},"summary":"一句话主因","generatedAt":"ISO时间"}', '<<<END_REPORT_JSON>>>');
  out.push('JSON 要求：严格合法 JSON（UTF-8，无注释/尾逗号）；points[].id 对应采分点 P 序号；各 subs[].score 之和 = score；fullScore = ' + q.score + '。');
  return out.join('\n');
}

// 从模型输出中提取标记段
function extractApiReport(text) {
  if (!text) return null;
  const grab = (tag) => {
    const m = text.match(new RegExp(`<<<${tag}>>>\\s*([\\s\\S]*?)\\s*<<<END_${tag}>>>`));
    return m ? m[1].trim() : '';
  };
  const md = grab('REPORT_MD');
  const jsonRaw = grab('REPORT_JSON');
  if (!jsonRaw) return null;
  let json;
  try { json = JSON.parse(jsonRaw); } catch { return null; }
  if (typeof json.score !== 'number' || !Array.isArray(json.subs)) return null;
  return { md: md || '（模型未返回 Markdown 报告正文，仅返回结构化结果。）', json };
}

function logApiDebug(msg) {
  try { fs.appendFileSync(path.join(DATA_DIR, 'claude-debug.log'), `[api ${new Date().toISOString()}] ${msg}\n`); } catch {}
}

// 调用兼容 API：openai = /chat/completions，anthropic = /v1/messages
async function callGraderApi(prompt, cfg) {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let url, headers, body;
    if (cfg.format === 'anthropic') {
      url = base + '/v1/messages';
      headers = { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' };
      body = { model: cfg.model, max_tokens: AI_MAX_TOKENS, messages: [{ role: 'user', content: prompt }] };
    } else {
      url = base + '/chat/completions';
      headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey };
      body = { model: cfg.model, max_tokens: AI_MAX_TOKENS, messages: [{ role: 'user', content: prompt }] };
    }
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 500);
      logApiDebug(`HTTP ${r.status} ${url} ${detail}`);
      return { ok: false, error: `AI API 返回 ${r.status}：${detail}` };
    }
    const data = await r.json();
    const text = cfg.format === 'anthropic'
      ? (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
      : data.choices?.[0]?.message?.content;
    if (!text) { logApiDebug('响应无正文 ' + JSON.stringify(data).slice(0, 500)); return { ok: false, error: 'AI API 响应无正文' }; }
    return { ok: true, text };
  } catch (e) {
    logApiDebug('请求异常 ' + url + ' ' + e.message);
    return { ok: false, error: 'AI API 请求失败：' + (e.name === 'AbortError' ? '超时（15 分钟）' : e.message) };
  } finally { clearTimeout(t); }
}

// CLI 模式（高级）：调用本地 AI 编码 CLI + fakao-grader 评分技能
function buildPrompt(attempt, q, paths) {
  return [
    `你是法考主观题评分老师。先读取并严格遵循评分手册：${GRADER_SKILL}`,
    `本次批改：科目别名=${q.alias || ''}，题目=${q.snText}（题目ID ${attempt.question_id}）。`,
    `考生作答文件（题干与每问作答已内含）：${paths.file}`,
    `题库数据目录（评分标准/参考答案在这里）：${BANK_DIR}`,
    `批改完成后，务必产出两个文件：`,
    `1) Markdown 深度复盘报告，写入：${reportPaths(attempt.id).md}`,
    `2) 结构化 JSON 报告，写入：${reportPaths(attempt.id).json}，格式（严格 JSON，UTF-8）：`,
    `{"subject":"科目名","snText":"题号","score":数字,"fullScore":数字,"band":[低,高],"tier":"档位描述",`,
    ` "subs":[{"subOrder":1,"max":6,"score":4.5,"points":[{"id":1,"verdict":"✓|△|✗","type":"结论|依据|分析","confidence":"高|中|低"}]}],`,
    ` "missTypes":{"结论":0,"依据":0,"分析":0},"summary":"一句话主因","generatedAt":"ISO时间"}`,
    `不要输出报告到对话，只写文件。`,
  ].join('\n');
}

function runHeadless(prompt) {
  return new Promise((resolve) => {
    const parts = GRADER_CMD.trim().split(/\s+/);
    const args = [];
    for (const p of parts) args.push(p === '{prompt}' ? prompt : p);
    const child = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FAKAO_DATA_DIR: BANK_DIR } });
    let dbg = '';
    child.stdout.on('data', d => { dbg += d; });
    child.stderr.on('data', d => { dbg += d; });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(t);
      try { fs.writeFileSync(path.join(DATA_DIR, 'claude-debug.log'), '[argv] ' + args.join(' ').slice(0, 200) + '\n' + dbg.slice(-3000)); } catch {}
      resolve(code);
    });
    child.on('error', (e) => {
      clearTimeout(t);
      try { fs.writeFileSync(path.join(DATA_DIR, 'claude-debug.log'), '[spawn-error] ' + e.message + '\n[argv0] ' + args[0]); } catch {}
      resolve(-1);
    });
  });
}

function fail(attemptId, error) {
  db.prepare("UPDATE attempts SET status='failed' WHERE id=?").run(attemptId);
  return { ok: false, error };
}

function ingest(attemptId, source) {
  const attempt = getAttempt(attemptId);
  const { md, json } = reportPaths(attemptId);
  if (!fs.existsSync(json)) {
    return fail(attemptId, 'JSON 报告未生成：' + json);
  }
  let data;
  try { data = JSON.parse(fs.readFileSync(json, 'utf8')); }
  catch (e) { return fail(attemptId, 'JSON 解析失败: ' + e.message); }
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO gradings(attempt_id,source,score,full_score,band_low,band_high,md_path,data_json,created_at)
              VALUES(?,?,?,?,?,?,?,?,?)`).run(
    attemptId, source, data.score ?? null, data.fullScore ?? null,
    Array.isArray(data.band) ? data.band[0] : null, Array.isArray(data.band) ? data.band[1] : null,
    fs.existsSync(md) ? md : null, JSON.stringify(data), now);
  // 错题本派生：每个 ✗ 点（及答非满分的问）入错题（按作答者隔离）
  const q = byQid[attempt.question_id];
  for (const s of (data.subs || [])) {
    for (const p of (s.points || [])) {
      if (p.verdict === '✗') {
        db.prepare(`INSERT INTO wrongbook(user_id,question_id,subject_key,sub_order,reason_type,detail,created_at)
                    VALUES(?,?,?,?,?,?,?)`).run(attempt.user_id, attempt.question_id, attempt.subject_key, s.subOrder, p.type || '未知', `第${s.subOrder}问 P${p.id} 未命中（置信度${p.confidence || '?'}）`, now);
      }
    }
    const max = Number(s.max) || 0, sc = Number(s.score) || 0;
    if (max > 0 && sc < max && !(s.points || []).some(p => p.verdict === '✗')) {
      db.prepare(`INSERT INTO wrongbook(user_id,question_id,subject_key,sub_order,reason_type,detail,created_at)
                  VALUES(?,?,?,?,?,?,?)`).run(attempt.user_id, attempt.question_id, attempt.subject_key, s.subOrder, '部分命中', `第${s.subOrder}问 ${sc}/${max}`, now);
    }
  }
  db.prepare("UPDATE attempts SET status='graded' WHERE id=?").run(attemptId);
  return { ok: true, gradingId: db.prepare('SELECT id FROM gradings WHERE attempt_id=?').get(attemptId).id };
}

async function processOne(attemptId, source = 'headless') {
  const attempt = getAttempt(attemptId);
  if (!attempt || attempt.status !== 'queued') return { ok: false, error: '状态不是 queued' };
  db.prepare("UPDATE attempts SET status='grading', submitted_at=? WHERE id=?").run(new Date().toISOString(), attemptId);
  const { file, q } = writeAttemptMd(attempt);
  const rp = reportPaths(attemptId);
  const ai = getAiConfig();
  let done = false;
  if (ai.mode === 'api') {
    if (!ai.baseUrl || !ai.apiKey || !ai.model) {
      return fail(attemptId, 'AI API 未配置完整：请在「设置」页填写 Base URL / API Key / 模型（或在环境变量 AI_BASE_URL / AI_API_KEY / AI_MODEL 配置）。');
    }
    const r = await callGraderApi(buildApiPrompt(attempt, q), ai);
    if (!r.ok) return fail(attemptId, r.error + '。可在「报告导入」页人工导入，或改用 CLI/工人模式。');
    const rep = extractApiReport(r.text);
    if (!rep) {
      logApiDebug('报告段解析失败，原文尾部：' + r.text.slice(-800));
      return fail(attemptId, 'AI 返回内容未通过报告格式校验（缺少标记段或 JSON 非法），已重试价值低；可在「报告导入」页人工导入。');
    }
    fs.writeFileSync(rp.md, rep.md, 'utf8');
    fs.writeFileSync(rp.json, JSON.stringify(rep.json), 'utf8');
    done = true;
  } else {
    const code = await runHeadless(buildPrompt(attempt, q, { file }));
    done = code === 0 && fs.existsSync(rp.json);
    if (!done) {
      return fail(attemptId, `无头批改未产出报告（exit ${code}）。可用 PC 工人（npm run worker）重试，或在对话批改后用报告页“导入”按钮上传。`);
    }
  }
  if (!done) return { ok: false, error: '批改未完成' };
  return ingest(attemptId, source);
}

function submit(attemptId) {
  db.prepare("UPDATE attempts SET status='queued' WHERE id=? AND status IN ('draft','failed')").run(attemptId);
  setImmediate(() => processOne(attemptId).catch(() => {}));
}

// 三级导入 / 二级工人回传
function importReportFiles(attemptId, mdContent, jsonContent, source = 'chat') {
  const rp = reportPaths(attemptId);
  if (mdContent) fs.writeFileSync(rp.md, mdContent, 'utf8');
  if (!jsonContent) return fail(attemptId, '缺少 JSON 结构化报告');
  fs.writeFileSync(rp.json, jsonContent, 'utf8');
  return ingest(attemptId, source);
}

module.exports = { submit, processOne, ingest, importReportFiles, writeAttemptMd, reportPaths, buildApiPrompt, extractApiReport, getAiConfig };
