// 冒烟测试：题库加载 / 认证流程 / 报告采集入库 / Markdown 渲染
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fks-test-'));
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.FAKAO_DATA_DIR = path.join(TMP, 'bank');
process.env.PORT = '0';
fs.mkdirSync(path.join(TMP, 'bank'), { recursive: true });

// 合成测试题库（非真实内容）
const fixture = {
  data: [{
    id: 1, question: '<p>这是测试题干，包含事实与设问。</p>', score: 12, sn: 'T-01', snText: '测试第1题',
    subList: [
      { subOrder: 1, subQuestion: '第一小问怎么处理？', subScore: 6, answer: '参考答案要点。', subKeyWord: JSON.stringify([{ id: 1, text: '结论正确', score: 3, whiteList: [{ text: '结论成立' }], blackList: [] }, { id: 2, text: '依据完整', score: 3, whiteList: [], blackList: [] }]) },
      { subOrder: 2, subQuestion: '第二小问怎么看？', subScore: 6, answer: '另一问答案。', subKeyWord: '[]' },
    ],
  }],
};
fs.writeFileSync(path.join(TMP, 'bank', '刑法_raw.json'), JSON.stringify(fixture), 'utf8');
// 自定义科目清单（也作为 subjects.json 格式的用法示范）
fs.writeFileSync(path.join(TMP, 'bank', 'subjects.json'), JSON.stringify([
  { file: '刑法_raw.json', key: 'xingfa', name: '刑法（示例）', alias: '刑法', group: '示例题库' },
]), 'utf8');

const qmod = require('../src/questions');
const { db } = require('../src/db');
const grader = require('../src/grader');
const { render } = require('../src/md');

test('题库加载：科目/题目/采分点', () => {
  const { subjects, byQid } = qmod.loadAll();
  assert.equal(subjects.length, 1);
  assert.equal(subjects[0].questions.length, 1);
  const q = byQid['xingfa:1'];
  assert.ok(q, 'qid 索引存在');
  assert.equal(q.subs.length, 2);
  assert.equal(q.subs[0].points.length, 2);
  assert.equal(q.subs[0].points[0].score, 3);
  assert.ok(q.subs[0].points[0].whiteList.some(w => w.text === '结论成立'));
});

test('报告采集：入库 + 错题本派生', () => {
  db.prepare("INSERT INTO attempts(question_id,subject_key,created_at,status,answers_json) VALUES(?,?,?,?,?)")
    .run('xingfa:1', 'xingfa', new Date().toISOString(), 'grading', '{"1":"我的作答"}');
  const a = db.prepare('SELECT * FROM attempts ORDER BY id DESC LIMIT 1').get();
  const json = JSON.stringify({
    subject: '测试', snText: '测试第1题', score: 4.5, fullScore: 12, band: [4, 7], tier: '二类',
    subs: [
      { subOrder: 1, max: 6, score: 4.5, points: [{ id: 1, verdict: '✓', type: '结论', confidence: '高' }, { id: 2, verdict: '✗', type: '依据', confidence: '中' }] },
      { subOrder: 2, max: 6, score: 0, points: [] },
    ],
    missTypes: { 结论: 0, 依据: 3, 分析: 0 }, summary: '测试主因', generatedAt: new Date().toISOString(),
  });
  const r = grader.importReportFiles(a.id, '# 报告\n内容', json, 'chat');
  assert.ok(r.ok, '采集成功: ' + (r.error || ''));
  const g = db.prepare('SELECT * FROM gradings WHERE attempt_id=?').get(a.id);
  assert.equal(g.score, 4.5);
  assert.equal(g.source, 'chat');
  const wb = db.prepare('SELECT * FROM wrongbook WHERE question_id=?').all('xingfa:1');
  assert.ok(wb.length >= 2, '错题本应含 ✗ 点与零分问');
  const st = db.prepare('SELECT status FROM attempts WHERE id=?').get(a.id).status;
  assert.equal(st, 'graded');
});

test('Markdown 渲染：表格/粗体/引用', () => {
  const html = render('# 标题\n\n| a | b |\n|---|---|\n| **x** | y |\n\n> 引用');
  assert.ok(html.includes('<h1>标题</h1>'));
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<strong>x</strong>'));
  assert.ok(html.includes('<blockquote>'));
});

test('API 批改：提示词含题干与采分点，标记段解析', () => {
  const { byQid } = qmod.loadAll();
  const q = byQid['xingfa:1'];
  db.prepare("INSERT INTO attempts(question_id,subject_key,created_at,status,answers_json) VALUES(?,?,?,?,?)")
    .run('xingfa:1', 'xingfa', new Date().toISOString(), 'grading', '{"1":"考生写了结论成立"}');
  const a = db.prepare('SELECT * FROM attempts ORDER BY id DESC LIMIT 1').get();
  const prompt = grader.buildApiPrompt(a, q);
  assert.ok(prompt.includes('测试题干'), '提示词含题干');
  assert.ok(prompt.includes('结论正确'), '提示词含采分点');
  assert.ok(prompt.includes('等价表述：结论成立'), '提示词含白名单');
  assert.ok(prompt.includes('<<<REPORT_JSON>>>'), '提示词含输出格式标记');

  const rep = grader.extractApiReport('废话\n<<<REPORT_MD>>># 报告\n正文<<<END_REPORT_MD>>>\n<<<REPORT_JSON>>>' + JSON.stringify({
    subject: '测试', snText: 'T', score: 3, fullScore: 12, band: [3, 5], tier: '三类',
    subs: [{ subOrder: 1, max: 6, score: 3, points: [{ id: 1, verdict: '△', type: '结论', confidence: '高' }] }],
    missTypes: { 结论: 0, 依据: 0, 分析: 0 }, summary: 'x', generatedAt: '2026-01-01T00:00:00Z',
  }) + '<<<END_REPORT_JSON>>>\n结尾');
  assert.ok(rep, '标记段解析成功');
  assert.equal(rep.md.startsWith('# 报告'), true);
  assert.equal(rep.json.score, 3);
  assert.equal(grader.extractApiReport('没有标记段'), null, '缺标记段返回 null');
  assert.equal(grader.extractApiReport('<<<REPORT_JSON>>>{"bad":1}<<<END_REPORT_JSON>>>'), null, '缺字段返回 null');
});

test('API 批改端到端：mock OpenAI 兼容端点 → 入库 + 报告落盘', async () => {
  const http = require('node:http');
  let seenPrompt = '';
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      seenPrompt = JSON.parse(body).messages[0].content;
      const json = {
        subject: '测试', snText: 'T', score: 6, fullScore: 12, band: [5, 8], tier: '二类',
        subs: [
          { subOrder: 1, max: 6, score: 6, points: [{ id: 1, verdict: '✓', type: '结论', confidence: '高' }, { id: 2, verdict: '✓', type: '依据', confidence: '高' }] },
          { subOrder: 2, max: 6, score: 0, points: [] },
        ],
        missTypes: { 结论: 0, 依据: 0, 分析: 0 }, summary: 'x', generatedAt: new Date().toISOString(),
      };
      const content = '<<<REPORT_MD>>># 报告\n正文<<<END_REPORT_MD>>>\n<<<REPORT_JSON>>>' + JSON.stringify(json) + '<<<END_REPORT_JSON>>>';
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  process.env.AI_MODE = 'api';
  process.env.AI_FORMAT = 'openai';
  process.env.AI_BASE_URL = `http://127.0.0.1:${srv.address().port}/v1`;
  process.env.AI_API_KEY = 'test-key';
  process.env.AI_MODEL = 'mock-model';
  db.prepare("INSERT INTO attempts(question_id,subject_key,created_at,status,answers_json) VALUES(?,?,?,?,?)")
    .run('xingfa:1', 'xingfa', new Date().toISOString(), 'draft', '{"1":"答","2":"答"}');
  const a = db.prepare('SELECT * FROM attempts ORDER BY id DESC LIMIT 1').get();
  grader.submit(a.id);
  let st = '';
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    st = db.prepare('SELECT status FROM attempts WHERE id=?').get(a.id).status;
    if (st === 'graded' || st === 'failed') break;
  }
  srv.close();
  assert.equal(st, 'graded', '端到端批改应成功（状态=' + st + '）');
  assert.ok(seenPrompt.includes('测试题干'), '请求应含题目内容');
  const g = db.prepare('SELECT * FROM gradings WHERE attempt_id=?').get(a.id);
  assert.equal(g.score, 6);
  assert.ok(fs.existsSync(grader.reportPaths(a.id).md), 'Markdown 报告应落盘');
});
