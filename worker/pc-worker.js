// 二级批改工人：在你自己的 PC 上运行，轮询服务器队列，用本地 ZCode 无头批改后回传
// 用法：SERVER=http://服务器:端口 WORKER_TOKEN=xxx npm run worker
const SERVER = process.env.SERVER || 'http://127.0.0.1:3210';
const TOKEN = process.env.WORKER_TOKEN || '';
if (!TOKEN) { console.error('请设置 WORKER_TOKEN（与服务器 settings 表 worker_token 一致）'); process.exit(1); }
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const BANK_DIR = process.env.FAKAO_DATA_DIR || path.resolve(__dirname, '..', '..', '题库数据');
const GRADER_CMD = process.env.GRADER_CMD || 'zcode -p {prompt}';

async function poll() {
  const r = await fetch(SERVER + '/api/worker/poll', { headers: { 'X-Worker-Token': TOKEN } });
  return r.json();
}
async function report(task, md, json) {
  const r = await fetch(SERVER + '/api/worker/report', { method: 'POST', headers: { 'X-Worker-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ attemptId: task.attemptId, md, json }) });
  return r.json();
}
function runHeadless(prompt) {
  return new Promise((resolve) => {
    const parts = GRADER_CMD.trim().split(/\s+/).map(p => (p === '{prompt}' ? prompt : p));
    const child = spawn(parts[0], parts.slice(1), { stdio: 'ignore', env: { ...process.env, FAKAO_DATA_DIR: BANK_DIR } });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 15 * 60 * 1000);
    child.on('exit', c => { clearTimeout(t); resolve(c); });
    child.on('error', () => { clearTimeout(t); resolve(-1); });
  });
}
async function main() {
  console.log('PC 批改工人启动，服务器:', SERVER, '题库:', BANK_DIR);
  while (true) {
    try {
      const { task } = await poll();
      if (!task) { await new Promise(r => setTimeout(r, 20000)); continue; }
      console.log('领取任务 attempt#' + task.attemptId, task.snText);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fk-'));
      const mdFile = path.join(dir, 'report.md'), jsonFile = path.join(dir, 'report.json');
      const skill = process.env.GRADER_SKILL_PATH || path.join(process.env.USERPROFILE || '', '.zcode', 'skills', 'fakao-grader', 'SKILL.md');
      const prompt = `你是法考主观题评分老师。先读取并严格遵循评分手册：${skill}\n本次批改：${task.snText}。题库数据目录：${BANK_DIR}\n考生作答：\n${JSON.stringify(task.answers)}\n批改完成后：Markdown 报告写入 ${mdFile}；结构化 JSON 报告写入 ${jsonFile}，格式：{"subject":"","snText":"","score":0,"fullScore":0,"band":[0,0],"tier":"","subs":[{"subOrder":1,"max":6,"score":0,"points":[{"id":1,"verdict":"✓","type":"结论","confidence":"高"}]}],"missTypes":{"结论":0,"依据":0,"分析":0},"summary":"","generatedAt":""}。不要输出到对话，只写文件。`;
      const code = await runHeadless(prompt);
      if (code === 0 && fs.existsSync(jsonFile)) {
        const r = await report(task, fs.existsSync(mdFile) ? fs.readFileSync(mdFile, 'utf8') : '', fs.readFileSync(jsonFile, 'utf8'));
        console.log('回传结果:', JSON.stringify(r));
      } else {
        console.log('无头批改失败（exit ' + code + '），任务保持 grading 状态，可重试');
        await fetch(SERVER + '/api/worker/report', { method: 'POST', headers: { 'X-Worker-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ attemptId: task.attemptId }) }).catch(() => {});
      }
    } catch (e) { console.error('worker error:', e.message); await new Promise(r => setTimeout(r, 30000)); }
  }
}
main();
