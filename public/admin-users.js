const $ = s => document.querySelector(s);

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[c]));

function date(s) {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('zh-CN', { hour12: false });
}

function accuracyCell(user) {
  const total = Number(user.total || 0);
  const correct = Number(user.correct || 0);
  const accuracy = total ? Math.round(correct / total * 100) : 0;
  return `<b>${accuracy}%</b><small>累计答对 ${correct} / ${total} 题</small>`;
}

async function loadUsers() {
  const r = await fetch('/api/admin/users');
  const users = await r.json();
  if (!r.ok) throw new Error(users.error || '加载失败');
  $('#userRows').innerHTML = users.map(u => `
    <tr>
      <td><b>${esc(u.name)}</b></td>
      <td>${date(u.firstSeen)}</td>
      <td>${date(u.lastSeen)}</td>
      <td>${Number(u.total || 0)} 题</td>
      <td>${accuracyCell(u)}</td>
    </tr>
  `).join('') || '<tr><td colspan="5">尚无用户数据</td></tr>';
}

loadUsers().catch(e => {
  $('#userRows').innerHTML = `<tr><td colspan="5">加载失败：${esc(e.message)}</td></tr>`;
});
