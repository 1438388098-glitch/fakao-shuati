// 认证：多用户登录 + HMAC 签名 Cookie 会话 + 登录限速
const crypto = require('crypto');
const { db, getSetting, setSetting, verifyHash, getUser } = require('./db');

const COOKIE = 'fks_session';
const fails = new Map(); // ip -> {count, until}

function secret() {
  let s = getSetting('secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); setSetting('secret', s); }
  return s;
}
function sign(v) { return crypto.createHmac('sha256', secret()).update(v).digest('hex'); }

function makeCookie(userId) {
  const exp = Date.now() + 30 * 24 * 3600 * 1000;
  return `${userId}.${exp}.` + sign(`${userId}.${exp}`);
}
function parseCookie(v) {
  if (!v) return null;
  const parts = String(v).split('.');
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  if (Number(exp) < Date.now()) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(sign(`${uid}.${exp}`), 'hex'))) return null;
  } catch { return null; }
  return Number(uid);
}

function isLocked(ip) {
  const f = fails.get(ip);
  return !!(f && f.until > Date.now());
}
function recordFail(ip) {
  const f = fails.get(ip) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= 5) { f.until = Date.now() + 10 * 60 * 1000; f.count = 0; }
  fails.set(ip, f);
}

function hasUsers() { return !!db.prepare('SELECT id FROM users LIMIT 1').get(); }
function createUser(username, pw) {
  return db.prepare('INSERT INTO users(username,password_hash,created_at) VALUES(?,?,?)')
    .run(username, require('./db').hashPassword(pw), new Date().toISOString()).lastInsertRowid;
}
function checkLogin(username, pw) {
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username || '').trim());
  if (!u) return null;
  return verifyHash(pw, u.password_hash) ? u : null;
}

function requireAuth(req, res, next) {
  if (!hasUsers()) return res.redirect('/setup');
  const uid = parseCookie(req.cookies && req.cookies[COOKIE]);
  if (uid) {
    const u = getUser(uid);
    if (u) {
      req.user = { id: u.id, username: u.username };
      res.locals.user = req.user;
      return next();
    }
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  res.redirect('/login');
}
function attachCookie(res, userId) {
  res.setHeader('Set-Cookie', `${COOKIE}=${makeCookie(userId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
}

module.exports = { COOKIE, hasUsers, createUser, checkLogin, isLocked, recordFail, requireAuth, attachCookie, clearCookie };
