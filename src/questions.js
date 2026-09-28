// 题库加载：读取数据目录下的 *_raw.json，构建科目/题目索引（只读，不进数据库）
// 科目清单由数据目录下 subjects.json 定义（可选）；缺省时扫描目录内全部 *_raw.json
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.FAKAO_DATA_DIR || path.join(__dirname, '..', '题库数据');

// subjects.json 格式：[{ "file": "刑法_raw.json", "key": "xingfa", "name": "刑法（真题）", "alias": "刑法", "group": "历年真题" }]
// key 用于 URL 与数据库关联（建库后不可更改）；alias 为批改提示词中的科目别名；group 用于题库页分组
function loadSubjectDefs(dataDir) {
  const custom = path.join(dataDir, 'subjects.json');
  if (fs.existsSync(custom)) {
    const defs = JSON.parse(fs.readFileSync(custom, 'utf8'));
    if (Array.isArray(defs) && defs.length) return defs;
  }
  const seen = new Set();
  return fs.readdirSync(dataDir)
    .filter(f => f.endsWith('_raw.json'))
    .map(f => {
      const name = f.replace(/_raw\.json$/, '');
      let key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'bank';
      while (seen.has(key)) key += '-2';
      seen.add(key);
      return { file: f, key, name, alias: '', group: '题库' };
    });
}

function parseRubric(str) {
  try {
    const arr = JSON.parse(str || '[]');
    return Array.isArray(arr) ? arr.filter(p => p && p.text && Number(p.score) > 0) : [];
  } catch { return []; }
}

function yearOf(q) {
  const m = String(q.sn || '').match(/^(\d{4})/);
  return m ? m[1] : (String(q.snText || '').match(/(\d{4})/) || [])[1] || '';
}

function loadAll() {
  const subjects = [];   // {key,name,alias,group,questions:[...]}
  const byQid = {};      // qid -> question
  for (const def of loadSubjectDefs(DATA_DIR)) {
    const fp = path.join(DATA_DIR, def.file);
    if (!fs.existsSync(fp)) continue;
    const { data } = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const questions = (data || []).map(q => ({
      qid: def.key + ':' + q.id,
      subjectKey: def.key,
      alias: def.alias || '',
      sn: q.sn || '', snText: q.snText || q.sn || '',
      year: yearOf(q),
      score: q.score != null ? q.score : (q.subList || []).reduce((a, s) => a + (Number(s.subScore) || 0), 0),
      stem: String(q.question || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim(),
      subs: (q.subList || []).slice().sort((a, b) => (a.subOrder || 0) - (b.subOrder || 0)).map(s => ({
        subOrder: s.subOrder,
        subQuestion: String(s.subQuestion || '').trim(),
        subScore: Number(s.subScore) || 0,
        answer: String(s.answer || '').replace(/<[^>]+>/g, '').trim(),
        points: parseRubric(s.subKeyWord),
      })),
    }));
    subjects.push({ key: def.key, name: def.name || def.key, alias: def.alias || '', group: def.group || '题库', questions });
    for (const q of questions) byQid[q.qid] = q;
  }
  return { subjects, byQid, groups: [...new Set(subjects.map(s => s.group))] };
}

module.exports = { loadAll, DATA_DIR };
