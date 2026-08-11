const $ = s => document.querySelector(s);
let sounds = [];
let previewAudio;
let previewId;
const actionLocks = new Map();
const actionCooldowns = new Map();

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[c]));

const date = s => {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('zh-CN', { hour12: false });
};

async function api(url, opts = {}) {
  const r = await fetch(url, opts);
  const x = await r.json();
  if (!r.ok) throw Error(x.error || '操作失败');
  return x;
}

function noteAction(key, cooldownMs = 0) {
  const now = Date.now();
  const last = actionCooldowns.get(key) || 0;
  if (cooldownMs && now - last < cooldownMs) return false;
  actionCooldowns.set(key, now);
  if (actionCooldowns.size > 120) {
    for (const [k, v] of actionCooldowns.entries()) {
      if (now - v > 60000) actionCooldowns.delete(k);
    }
  }
  return true;
}

function beginAction(key, cooldownMs = 0) {
  if (actionLocks.has(key) || !noteAction(key, cooldownMs)) return false;
  actionLocks.set(key, Date.now());
  return true;
}

function endAction(key) {
  actionLocks.delete(key);
}

function setButtonBusy(button, busy, busyText = '') {
  if (!button) return;
  if (busy) {
    if (!button.dataset.idleText) button.dataset.idleText = button.textContent;
    button.disabled = true;
    if (busyText) button.textContent = busyText;
    return;
  }
  button.disabled = false;
  if (button.dataset.idleText) button.textContent = button.dataset.idleText;
  delete button.dataset.idleText;
}

function historySearchText(sound) {
  const stats = Array.isArray(sound.answerTextStats) ? sound.answerTextStats : [];
  if (stats.length) return stats.map(h => h.answer).join(' ');
  return (sound.answerHistory || []).map(h => h.answer).join(' ');
}

function renderHistory(sound) {
  const stats = Array.isArray(sound.answerTextStats) ? sound.answerTextStats : [];
  const history = stats.length ? stats : (sound.answerHistory || []).map(h => ({
    answer: h.answer,
    count: 1,
    correctCount: h.correct ? 1 : 0,
    incorrectCount: h.correct ? 0 : 1,
    latestAt: h.at
  }));
  if (!history.length) return '<div class="history-empty">暂无</div>';
  return `
    <div class="history-cell">
      <b class="history-count">共 ${sound.answerHistoryCount || history.reduce((n, h) => n + h.count, 0)} 条 · ${history.length} 种说法</b>
      <button class="history-open" type="button" onclick="openHistory('${sEsc(sound.id)}')">查看历史回答</button>
    </div>
  `;
}

function draw() {
  const q = $('#search').value.trim().toLowerCase();
  const list = sounds.filter(s => {
    const haystack = `${s.name} ${s.originalName || ''} ${s.tags.join(' ')} ${historySearchText(s)}`.toLowerCase();
    return !q || haystack.includes(q);
  });
  $('#soundCount').textContent = `共 ${list.length} 条`;
  $('#sounds').innerHTML = list.map(s => `
    <tr>
      <td><b>${esc(s.name)}</b><small>${esc(s.originalName)}</small></td>
      <td>${s.tags.map(t => `<i class="tag">${esc(t)}</i>`).join('')}</td>
      <td>${date(s.createdAt)}</td>
      <td>${s.plays}</td>
      <td>${s.accuracy}%</td>
      <td>${renderHistory(s)}</td>
      <td><button class="switch ${s.enabled ? 'on' : ''}" onclick="toggle(this,'${s.id}',${!s.enabled})"><i></i></button></td>
      <td>
        <button class="link" onclick="previewSound(this,'${s.id}')">${previewId === s.id ? '停止' : '试听'}</button>
        <button class="link" onclick="editSound('${s.id}')">编辑</button>
        <button class="link danger" onclick="removeSound(this,'${s.id}')">删除</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="8">暂无匹配的声音</td></tr>';
}

async function load() {
  sounds = await api('/api/admin/sounds');
  draw();
}

window.previewSound = (button, id) => {
  if (!noteAction(`preview:${id}`, 900)) return;
  const s = sounds.find(x => x.id === id);
  if (!s) return;
  if (previewId === id) {
    previewAudio.pause();
    previewAudio.currentTime = 0;
    previewId = null;
    draw();
    return;
  }
  if (previewAudio) previewAudio.pause();
  previewId = id;
  previewAudio = new Audio(s.demo ? `/api/demo-audio/${s.demo}` : `/uploads/${s.file}`);
  previewAudio.onended = () => {
    previewId = null;
    draw();
  };
  previewAudio.onerror = () => {
    previewId = null;
    draw();
    alert('该声音暂时无法播放');
  };
  previewAudio.play().catch(() => alert('浏览器阻止了播放，请再点击一次'));
  draw();
};

window.toggle = async (button, id, enabled) => {
  const key = `toggle:${id}`;
  if (!beginAction(key, 900)) return;
  setButtonBusy(button, true);
  try {
    await api('/api/admin/sounds/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    await load();
  } catch (e) {
    alert(e.message);
  } finally {
    setButtonBusy(button, false);
    endAction(key);
  }
};

window.removeSound = async (button, id) => {
  const key = `delete:${id}`;
  if (!beginAction(key, 1800)) return;
  if (confirm('确定删除这个声音吗？删除后不可恢复。')) {
    setButtonBusy(button, true, '删除中');
    try {
      await api('/api/admin/sounds/' + id, { method: 'DELETE' });
      await load();
    } catch (e) {
      alert(e.message);
    } finally {
      setButtonBusy(button, false);
      endAction(key);
    }
    return;
  }
  endAction(key);
};

window.editSound = id => {
  location.href = `/admin-tags.html?id=${encodeURIComponent(id)}`;
};

function renderHistoryStats(sound) {
  const stats = Array.isArray(sound.answerTextStats) ? sound.answerTextStats : [];
  if (!stats.length) return '<div class="history-empty">暂无高频说法</div>';
  return stats.map(h => `
    <div class="history-item ${h.correctCount >= h.incorrectCount ? 'ok' : 'bad'}" title="最近：${esc(date(h.latestAt))}">
      <i>×${h.count}</i>
      <span>${esc(h.answer)}</span>
      <small>对 ${h.correctCount || 0} · 错 ${h.incorrectCount || 0}</small>
    </div>
  `).join('');
}

function renderHistoryRecords(sound) {
  const records = Array.isArray(sound.answerHistory) ? sound.answerHistory : [];
  if (!records.length) return '<div class="history-empty">暂无历史记录</div>';
  return records.map(h => `
    <div class="history-record ${h.correct ? 'ok' : 'bad'}">
      <i>${h.correct ? '对' : '错'}</i>
      <div>
        <b>${esc(h.answer)}</b>
        <small>${esc(h.userName || '匿名玩家')} · ${esc(date(h.at))}</small>
      </div>
    </div>
  `).join('');
}

function sEsc(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

window.openHistory = id => {
  const sound = sounds.find(s => s.id === id);
  if (!sound) return;
  $('#historyTitle').textContent = sound.name;
  $('#historyStats').innerHTML = renderHistoryStats(sound);
  $('#historyRecords').innerHTML = renderHistoryRecords(sound);
  $('#historyDialog').showModal();
};

$('#search').oninput = draw;
$('#openUpload').onclick = () => $('#upload').showModal();
$('#historyClose').onclick = () => $('#historyDialog').close();
$('#uploadForm').onsubmit = async e => {
  e.preventDefault();
  const key = 'upload-sound';
  if (!beginAction(key, 2500)) return;
  const button = e.submitter || e.target.querySelector('.save');
  setButtonBusy(button, true, '上传中...');
  const f = new FormData(e.target);
  try {
    await api('/api/admin/sounds', { method: 'POST', body: f });
    $('#upload').close();
    e.target.reset();
    await load();
  } catch (e) {
    alert(e.message);
  } finally {
    setButtonBusy(button, false);
    endAction(key);
  }
};

load();
