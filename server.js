// 入口
const express = require('express');
const path = require('path');
const fs = require('fs');
const { router } = require('./src/routes');

const app = express();
const PORT = Number(process.env.PORT) || 3210;
const BASE = process.env.BASE_PATH || '';   // 子路径部署，如 /shuati
// 静态资源版本号 = app.css/app.js 的最新 mtime；每次部署自动变化，浏览器缓存随之失效
app.locals.assetV = Math.floor(Math.max(
  fs.statSync(path.join(__dirname, 'public', 'app.css')).mtimeMs,
  fs.statSync(path.join(__dirname, 'public', 'app.js')).mtimeMs,
));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
const staticOpts = { etag: true, lastModified: true, maxAge: 0 }; // 强制协商缓存：发版即刻生效
if (BASE) app.use(BASE, express.static(path.join(__dirname, 'public'), staticOpts));
else app.use(express.static(path.join(__dirname, 'public'), staticOpts));
// 极简 cookie 解析 + 模板公共变量
app.use((req, res, next) => {
  req.cookies = {};
  const raw = req.headers.cookie || '';
  for (const kv of raw.split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) req.cookies[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
  }
  res.locals.query = req.query;
  next();
});
// 安全响应头
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
// 子路径部署：所有重定向自动加 BASE 前缀（BASE 已在文件顶部定义）
if (BASE) {
  app.use((req, res, next) => {
    const orig = res.redirect.bind(res);
    res.redirect = (p) => orig(typeof p === 'string' && p.startsWith('/') ? BASE + p : p);
    next();
  });
}

if (BASE) app.use(BASE, router);
else app.use(router);

if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => console.log(`fakao-shuati listening on http://127.0.0.1:${PORT}`));
}
module.exports = { app };
