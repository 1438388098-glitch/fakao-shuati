// 全部路由（多用户，数据按 user_id 隔离）
const express = require('express');
const fs = require('fs');
const { db, getSetting, setSetting } = require('./db');
const { loadAll } = require('./questions');
const auth = require('./auth');
const grader = require('./grader');
const { render } = require('./md');

const router = express.Router();
const BANK = loadAll();
const now = () => new Date().toISOString();

router.use((req, res, next) => {
  res.locals.base = process.env.BASE_PATH || '';
  res.locals.countdownTarget = getSetting('countdown_date') || '';
  res.locals.query = req.query;
  res.locals.user = req.user || null;
  next();
});

function redirectIfAuthed(req, res, next) {
  if (auth.hasUsers() && req.user) return res.redirect('/');
  next();
}

// ---- 初始化（仅无用户时）与登录 ----
router.get('/setup', (req, res, next) => { if (auth.hasUsers()) return res.redirect('/login'); next(); }, redirectIfAuthed, (req, res) => {
  res.render('setup', { title: '初始化', error: null });
});
router.post('/setup', (req, res, next) => { if (auth.hasUsers()) return res.redirect('/login'); next(); }, (req, res) => {
  const { username, password } = req.body || {};
  const name = String(username || '').trim();
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,16}$/.test(name)) return res.status(400).render('setup', { title: '初始化', error: '用户名 2~16 位，可中文/字母/数字/下划线' });
  if (!password || String(password).length < 4) return res.status(400).render('setup', { title: '初始化', error: '密码至少 4 位' });
  auth.attachCookie(res, auth.createUser(name, password));
  res.redirect('/');
});
router.get('/login', (req, res, next) => { if (!auth.hasUsers()) return res.redirect('/setup'); next(); }, redirectIfAuthed, (req, res) => {
  res.render('login', { title: '登录', error: null });
});
router.post('/login', (req, res, next) => { if (!auth.hasUsers()) return res.redirect('/setup'); next(); }, (req, res) => {
  const ip = req.socket.remoteAddress || '';
  if (auth.isLocked(ip)) return res.status(429).render('login', { title: '登录', error: '尝试过多，请 10 分钟后再试' });
  const u = auth.checkLogin(req.body?.username, req.body?.password);
  if (!u) { auth.recordFail(ip); return res.status(401).render('login', { title: '登录', error: '用户名或密码错误' }); }
  auth.attachCookie(res, u.id);
  res.redirect('/');
});
router.post('/logout', (req, res) => { auth.clearCookie(res); res.redirect('/login'); });

// ---- 题库 ----
router.get('/', auth.requireAuth, (req, res) => {
  const uid = req.user.id;
  const subjects = BANK.subjects.map(s => ({
    ...s,
    questions: s.questions.map(q => {
      const a = db.prepare(`SELECT id,status FROM attempts WHERE question_id=? AND user_id=? ORDER BY id DESC LIMIT 1`).get(q.qid, uid);
      const g = a ? db.prepare(`SELECT score,full_score FROM gradings WHERE attempt_id=?`).get(a.id) : null;
      return { ...q, attempt: a, grading: g };
    }),
  }));
  const gradedCount = db.prepare(`SELECT COUNT(DISTINCT question_id) AS n FROM attempts WHERE user_id=? AND status='graded'`).get(uid).n;
  res.render('bank', { title: '题库', subjects, groups: BANK.groups, gradedCount });
});

// ---- 做题 ----
router.get('/attempt/:qid', auth.requireAuth, (req, res) => {
  const uid = req.user.id;
  const q = BANK.byQid[req.params.qid];
  if (!q) return res.status(404).send('题目不存在');
  let attempt = req.query.retry === '1' ? null
    : db.prepare(`SELECT * FROM attempts WHERE question_id=? AND user_id=? AND status='draft' ORDER BY id DESC LIMIT 1`).get(q.qid, uid);
  if (!attempt) {
    const r = db.prepare(`INSERT INTO attempts(question_id,subject_key,user_id,created_at) VALUES(?,?,?,?)`).run(q.qid, q.subjectKey, uid, now());
    attempt = db.prepare('SELECT * FROM attempts WHERE id=?').get(r.lastInsertRowid);
  }
  const subject = BANK.subjects.find(s => s.key === q.subjectKey);
  res.render('attempt', { title: q.snText, q, attempt, subject });
});
router.post('/api/attempt', auth.requireAuth, (req, res) => {
  const { attemptId, answers, durationSec } = req.body || {};
  const a = db.prepare('SELECT * FROM attempts WHERE id=? AND user_id=?').get(attemptId, req.user.id);
  if (!a || a.status !== 'draft') return res.status(400).json({ error: '不可保存' });
  db.prepare('UPDATE attempts SET answers_json=?, duration_sec=? WHERE id=?')
    .run(JSON.stringify(answers || {}), Math.max(0, Number(durationSec) || 0), attemptId);
  res.json({ ok: true });
});
router.post('/api/attempt/:id/submit', auth.requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM attempts WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (a.status === 'draft') {
    db.prepare('UPDATE attempts SET answers_json=?, duration_sec=?, submitted_at=? WHERE id=?')
      .run(JSON.stringify(req.body?.answers || a.answers_json), Number(req.body?.durationSec) || a.duration_sec || 0, now(), a.id);
  }
  grader.submit(a.id);
  res.json({ ok: true, status: 'queued' });
});
router.get('/api/attempt/:id/status', auth.requireAuth, (req, res) => {
  const a = db.prepare('SELECT status FROM attempts WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  const g = db.prepare('SELECT id FROM gradings WHERE attempt_id=?').get(req.params.id);
  res.json({ status: a?.status, gradingId: g?.id || null });
});

// ---- 报告 ----
router.get('/report/:gradingId', auth.requireAuth, (req, res) => {
  const g = db.prepare(`SELECT g.* FROM gradings g JOIN attempts a ON a.id=g.attempt_id WHERE g.id=? AND a.user_id=?`).get(req.params.gradingId, req.user.id);
  if (!g) return res.status(404).send('报告不存在');
  const a = db.prepare('SELECT * FROM attempts WHERE id=?').get(g.attempt_id);
  const q = BANK.byQid[a.question_id];
  const data = JSON.parse(g.data_json || '{}');
  const mdHtml = g.md_path && fs.existsSync(g.md_path) ? render(fs.readFileSync(g.md_path, 'utf8')) : '<p>（无 Markdown 报告）</p>';
  res.render('report', { title: '批改报告', g, q, a, data, mdHtml });
});
router.get('/import/:attemptId', auth.requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM attempts WHERE id=? AND user_id=?').get(req.params.attemptId, req.user.id);
  if (!a) return res.status(404).send('不存在');
  res.render('import', { title: '导入报告', attemptId: req.params.attemptId, error: null });
});
router.post('/import/:attemptId', auth.requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM attempts WHERE id=? AND user_id=?').get(req.params.attemptId, req.user.id);
  if (!a) return res.status(404).send('不存在');
  try {
    const r = grader.importReportFiles(a.id, req.body?.md || '', req.body?.json || '', 'chat');
    if (!r.ok) throw new Error(r.error);
    res.redirect('/report/' + r.gradingId);
  } catch (e) {
    res.status(400).render('import', { title: '导入报告', attemptId: req.params.attemptId, error: e.message });
  }
});

// ---- 看板 ----
router.get('/dashboard', auth.requireAuth, (req, res) => {
  const uid = req.user.id;
  const gradings = db.prepare(`SELECT g.*, a.question_id, a.subject_key FROM gradings g JOIN attempts a ON a.id=g.attempt_id WHERE a.user_id=? ORDER BY g.created_at`).all(uid);
  const points = gradings.map(g => {
    const d = JSON.parse(g.data_json || '{}');
    const misses = { 结论: 0, 依据: 0, 分析: 0 };
    for (const s of (d.subs || [])) for (const p of (s.points || [])) if (p.verdict === '✗' && misses[p.type] != null) misses[p.type] += 1;
    const totalPts = (d.subs || []).reduce((a, s) => a + (s.points || []).length, 0);
    const hitPts = (d.subs || []).reduce((a, s) => a + (s.points || []).filter(p => p.verdict === '✓').length, 0);
    return { date: g.created_at?.slice(0, 10), label: d.snText || g.question_id, pct: g.full_score ? Math.round(g.score / g.full_score * 100) : 0, misses, hitRate: totalPts ? Math.round(hitPts / totalPts * 100) : 0 };
  });
  const cover = BANK.subjects.map(s => {
    const total = s.questions.length;
    const done = s.questions.filter(q => db.prepare(`SELECT g.id FROM gradings g JOIN attempts a ON a.id=g.attempt_id WHERE a.question_id=? AND a.user_id=?`).get(q.qid, uid)).length;
    return { name: s.name, done, total };
  });
  res.render('dashboard', { title: '统计看板', points: JSON.stringify(points), cover, gradings });
});

// ---- 错题本 ----
router.get('/wrongbook', auth.requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT * FROM wrongbook WHERE user_id=? AND resolved=0 ORDER BY id DESC`).all(req.user.id);
  res.render('wrongbook', { title: '错题本', rows: rows.map(w => ({ ...w, q: BANK.byQid[w.question_id] })) });
});
router.post('/wrongbook/:id/rebrush', auth.requireAuth, (req, res) => {
  const w = db.prepare('SELECT * FROM wrongbook WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!w) return res.status(404).send('不存在');
  const r = db.prepare(`INSERT INTO attempts(question_id,subject_key,user_id,created_at) VALUES(?,?,?,?)`).run(w.question_id, w.subject_key, req.user.id, now());
  db.prepare('UPDATE wrongbook SET rebrush_attempt_id=? WHERE id=?').run(r.lastInsertRowid, w.id);
  res.redirect('/attempt/' + w.question_id);
});

// ---- 背诵 ----
router.get('/recite', auth.requireAuth, (req, res) => {
  const uid = req.user.id;
  const subjects = BANK.subjects;
  const cur = subjects.find(s => s.key === req.query.s) || subjects[0];
  const mastered = new Set(db.prepare(`SELECT question_id||':'||sub_order AS k FROM recite WHERE user_id=?`).all(uid).map(r => r.k));
  const cards = cur.questions.flatMap(q => q.subs.map(s => ({
    qid: q.qid, snText: q.snText, subOrder: s.subOrder, subQuestion: s.subQuestion,
    answer: s.answer, points: s.points, subScore: s.subScore,
    mastered: mastered.has(q.qid + ':' + s.subOrder),
  })));
  res.render('recite', { title: '采分点背诵', subjects, cur, cards });
});
router.post('/api/recite/toggle', auth.requireAuth, (req, res) => {
  const { qid, subOrder } = req.body || {};
  const k = db.prepare('SELECT 1 FROM recite WHERE question_id=? AND user_id=? AND sub_order=?').get(qid, req.user.id, subOrder);
  if (k) db.prepare('DELETE FROM recite WHERE question_id=? AND user_id=? AND sub_order=?').run(qid, req.user.id, subOrder);
  else db.prepare('INSERT INTO recite(question_id,user_id,sub_order,mastered_at) VALUES(?,?,?,?)').run(qid, req.user.id, subOrder, now());
  res.json({ ok: true, mastered: !k });
});

// ---- 设置 ----
function settingsVars() {
  const key = getSetting('ai_api_key') || process.env.AI_API_KEY || '';
  return {
    countdown: getSetting('countdown_date') || '',
    aiMode: getSetting('ai_mode') || process.env.AI_MODE || 'auto',
    aiFormat: getSetting('ai_format') || process.env.AI_FORMAT || 'openai',
    aiBaseUrl: getSetting('ai_base_url') || process.env.AI_BASE_URL || '',
    aiModel: getSetting('ai_model') || process.env.AI_MODEL || '',
    aiKeyMask: key ? '已配置（····' + key.slice(-4) + '）' : '',
  };
}
router.get('/settings', auth.requireAuth, (req, res) => {
  res.render('settings', { title: '设置', ...settingsVars(), saved: req.query.saved === '1', error: null });
});
router.post('/settings', auth.requireAuth, (req, res) => {
  const { countdown_date, old_password, new_password, ai_mode, ai_format, ai_base_url, ai_model, ai_api_key, ai_clear_key } = req.body || {};
  if (countdown_date) setSetting('countdown_date', countdown_date);
  if (ai_mode) setSetting('ai_mode', ai_mode === 'auto' ? '' : ai_mode);
  if (ai_format) setSetting('ai_format', ai_format);
  if (ai_base_url && String(ai_base_url).trim()) setSetting('ai_base_url', String(ai_base_url).trim());
  if (ai_model && String(ai_model).trim()) setSetting('ai_model', String(ai_model).trim());
  if (ai_api_key && String(ai_api_key).trim()) setSetting('ai_api_key', String(ai_api_key).trim());
  if (ai_clear_key) setSetting('ai_api_key', '');
  const errRender = (error) => res.status(400).render('settings', { title: '设置', ...settingsVars(), saved: false, error });
  if (new_password) {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    const okOld = require('./db').verifyHash(String(old_password || ''), u.password_hash);
    if (!okOld) return errRender('旧密码错误');
    if (String(new_password).length < 4) return errRender('新密码至少 4 位');
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(require('./db').hashPassword(new_password), req.user.id);
  }
  res.redirect('/settings?saved=1');
});

// ---- 二级工人接口 ----
function workerAuth(req, res, next) {
  const token = getSetting('worker_token');
  if (token && req.get('X-Worker-Token') === token) return next();
  res.status(401).json({ error: 'worker token invalid' });
}
router.get('/api/worker/poll', workerAuth, (req, res) => {
  const a = db.prepare(`SELECT * FROM attempts WHERE status='failed' OR status='queued' ORDER BY id ASC LIMIT 1`).get();
  if (!a) return res.json({ task: null });
  const q = BANK.byQid[a.question_id];
  db.prepare("UPDATE attempts SET status='grading' WHERE id=?").run(a.id);
  res.json({ task: { attemptId: a.id, subjectAlias: (BANK.subjects.find(s => s.key === a.subject_key) || {}).alias, snText: q.snText, answers: JSON.parse(a.answers_json || '{}') } });
});
router.post('/api/worker/report', workerAuth, (req, res) => {
  const { attemptId, md, json } = req.body || {};
  const r = grader.importReportFiles(Number(attemptId), md, json, 'worker');
  res.json(r);
});

module.exports = { router };
