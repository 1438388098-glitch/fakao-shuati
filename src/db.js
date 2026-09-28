// SQLite（node:sqlite）+ 用户体系 + 数据隔离
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, '作答'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, '批改记录'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'shuati.db'));
db.exec('PRAGMA journal_mode = WAL');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function verifyHash(pw, stored) {
  const [salt, h] = String(stored || '').split(':');
  if (!salt || !h) return false;
  try { return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(crypto.scryptSync(pw, salt, 32).toString('hex'), 'hex')); }
  catch { return false; }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  question_id TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  duration_sec INTEGER DEFAULT 0,
  answers_json TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft'
);
CREATE TABLE IF NOT EXISTS gradings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL UNIQUE,
  source TEXT NOT NULL,
  score REAL, full_score REAL,
  band_low REAL, band_high REAL,
  md_path TEXT, data_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wrongbook (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  question_id TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  sub_order INTEGER NOT NULL,
  reason_type TEXT,
  detail TEXT,
  created_at TEXT NOT NULL,
  resolved INTEGER DEFAULT 0,
  rebrush_attempt_id INTEGER
);
CREATE TABLE IF NOT EXISTS recite (
  question_id TEXT NOT NULL,
  user_id INTEGER NOT NULL DEFAULT 1,
  sub_order INTEGER NOT NULL,
  mastered_at TEXT NOT NULL,
  PRIMARY KEY (question_id, user_id, sub_order)
);
`);

// 旧库迁移：补 user_id 列
for (const [table, def] of [['attempts', 'DEFAULT 1'], ['wrongbook', 'DEFAULT 1'], ['recite', 'DEFAULT 1']]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (cols.length && !cols.includes('user_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER ${def}`);
}

// 不预置任何账号：首次访问 /setup 创建管理员账号

// 首次启动生成二级工人 token
if (!db.prepare("SELECT value FROM settings WHERE key='worker_token'").get()) {
  db.prepare("INSERT INTO settings(key,value) VALUES('worker_token',?)").run(crypto.randomBytes(16).toString('hex'));
}

function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}
function getUser(id) { return db.prepare('SELECT * FROM users WHERE id=?').get(id); }
function findUser(username) { return db.prepare('SELECT * FROM users WHERE username=?').get(String(username || '').trim()); }

module.exports = { db, DATA_DIR, getSetting, setSetting, hashPassword, verifyHash, getUser, findUser };
