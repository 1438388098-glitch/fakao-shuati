// 极简 Markdown 渲染：标题/表格/粗体/引用/列表/段落（报告格式已知，够用）
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function inline(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
function render(md) {
  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  let i = 0;
  const flushP = (buf) => { if (buf.length) out.push('<p>' + buf.map(inline).join('<br>') + '</p>'); };
  while (i < lines.length) {
    const l = lines[i];
    if (/^####\s/.test(l)) { flushP(out.p = []); out.push('<h4>' + inline(l.replace(/^####\s/, '')) + '</h4>'); i++; continue; }
    if (/^###\s/.test(l)) { out.push('<h3>' + inline(l.replace(/^###\s/, '')) + '</h3>'); i++; continue; }
    if (/^##\s/.test(l)) { out.push('<h2>' + inline(l.replace(/^##\s/, '')) + '</h2>'); i++; continue; }
    if (/^#\s/.test(l)) { out.push('<h1>' + inline(l.replace(/^#\s/, '')) + '</h1>'); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i].trim()); i++; }
      if (rows.length >= 2 && /^\s*\|[\s:|-]+\|\s*$/.test(rows[1])) {
        const cells = r => r.slice(1, -1).split('|').map(c => c.trim());
        out.push('<table><thead><tr>' + cells(rows[0]).map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
        for (const r of rows.slice(2)) out.push('<tr>' + cells(r).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>');
        out.push('</tbody></table>');
      } else { flushP(rows); }
      continue;
    }
    if (/^>\s?/.test(l)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push('<blockquote>' + buf.map(inline).join('<br>') + '</blockquote>');
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const buf = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '$1 ')); i++; }
      out.push('<ul>' + buf.map(b => '<li>' + inline(b) + '</li>').join('') + '</ul>');
      continue;
    }
    if (/^---+\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (!l.trim()) { i++; continue; }
    const buf = [l]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>|\s*[-*]\s|\s*\d+\.\s|\||---)/.test(lines[i])) { buf.push(lines[i]); i++; }
    flushP(buf);
  }
  return out.join('\n');
}
module.exports = { render };
