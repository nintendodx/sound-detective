const $ = s => document.querySelector(s);
let usersById = new Map();

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

function scoreCell(user) {
  const total = Number(user.total || 0);
  const correct = Number(user.correct || 0);
  const score = Number(user.score ?? correct) || 0;
  return `<b>${score} 分</b><small>累计答对 ${correct} 题，已答 ${total} 题</small>`;
}

function clientText(user = {}) {
  const client = user.client || {};
  if (user.clientLabel) return user.clientLabel;
  const os = [client.os, client.osVersion].filter(Boolean).join(' ');
  const browser = [client.browser, client.browserVersion].filter(Boolean).join(' ');
  return [os, browser].filter(Boolean).join(' / ');
}

function deviceTypeLabel(type) {
  return {
    mobile: '手机',
    tablet: '平板',
    desktop: '电脑'
  }[String(type || '')] || '';
}

function clientCell(user) {
  const client = user.client || {};
  const text = clientText(user);
  if (!text) return '<span class="history-empty">暂无数据</span>';
  const notes = [
    deviceTypeLabel(client.deviceType),
    client.updatedAt ? `更新 ${date(client.updatedAt)}` : ''
  ].filter(Boolean);
  return `<b>${esc(text)}</b>${notes.length ? `<small>${esc(notes.join(' · '))}</small>` : ''}`;
}

function inputModeLabel(mode) {
  return {
    text: '文字',
    voice: '语音',
    speech: '语音',
    recovered: '恢复记录'
  }[String(mode || '').toLowerCase()] || '未知方式';
}

function statusClass(record) {
  if (!record.answered) return 'missing';
  return record.correct ? 'ok' : 'bad';
}

function answerText(record) {
  const text = String(record.answer || '').trim();
  if (text) return text;
  if (!record.answered) return '未作答';
  if (record.recognized === false || (record.transcriptionStatus && record.transcriptionStatus !== 'ok')) return '未识别到文字';
  return '空白回答';
}

function roundTime(round) {
  const started = date(round.startedAt);
  const completed = date(round.completedAt);
  if (started === completed || completed === '-') return started;
  return `${started} - ${completed}`;
}

function answerMeta(record) {
  const parts = [];
  if (record.answeredAt) parts.push(date(record.answeredAt));
  if (record.inputMode) parts.push(inputModeLabel(record.inputMode));
  if (record.transcriptionReason) parts.push(record.transcriptionReason);
  return parts.join(' · ') || '-';
}

function renderAnswerRecord(record) {
  return `
    <div class="answer-record-row ${statusClass(record)}">
      <div class="answer-index">${Number(record.index || 0)}</div>
      <div class="answer-record-main">
        <div class="answer-record-head">
          <b>正确答案：${esc(record.soundName)}</b>
          <span class="answer-status ${statusClass(record)}">${esc(record.statusLabel)}</span>
        </div>
        <div class="answer-pair">
          <span>用户回答</span>
          <strong>${esc(answerText(record))}</strong>
        </div>
        <small>${esc(answerMeta(record))}</small>
      </div>
    </div>
  `;
}

function renderRound(round) {
  return `
    <section class="round-section">
      <div class="round-head">
        <div>
          <h3>第 ${Number(round.roundIndex || 0)} 轮</h3>
          <small>${esc(roundTime(round))}</small>
        </div>
        <div class="round-score">
          <b>${Number(round.correct || 0)} / ${Number(round.total || 0)}</b>
          <span>答对 ${Number(round.correct || 0)} 题，已答 ${Number(round.answered || 0)} 题</span>
        </div>
      </div>
      <div class="answer-record-list">
        ${(round.records || []).map(renderAnswerRecord).join('')}
      </div>
    </section>
  `;
}

function renderAnswerHistory(payload) {
  const rounds = Array.isArray(payload.rounds) ? payload.rounds : [];
  const totalAnswers = rounds.reduce((sum, r) => sum + Number(r.answered || 0), 0);
  const totalCorrect = rounds.reduce((sum, r) => sum + Number(r.correct || 0), 0);
  const client = clientText(payload.user || {});
  $('#answerDialogTitle').textContent = `${payload.user?.name || '用户'} 的回答记录`;
  $('#answerDialogMeta').textContent = `共 ${rounds.length} 轮，${totalCorrect} / ${totalAnswers} 题答对${client ? ` · ${client}` : ''}`;
  $('#answerDialogBody').innerHTML = rounds.length
    ? rounds.map(renderRound).join('')
    : '<div class="history-empty answer-empty">这个用户还没有答题记录</div>';
}

function openDialog(dialog) {
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDialog(dialog) {
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

async function openUserAnswers(userId) {
  const dialog = $('#answerDialog');
  const user = usersById.get(userId);
  $('#answerDialogTitle').textContent = `${user?.name || '用户'} 的回答记录`;
  $('#answerDialogMeta').textContent = '正在加载';
  $('#answerDialogBody').innerHTML = '<div class="history-empty answer-empty">正在加载回答记录...</div>';
  if (!dialog.open) openDialog(dialog);
  try {
    const r = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/answers?t=${Date.now()}`, { cache: 'no-store' });
    const payload = await r.json();
    if (!r.ok) throw new Error(payload.error || '加载失败');
    renderAnswerHistory(payload);
  } catch (e) {
    $('#answerDialogMeta').textContent = '加载失败';
    $('#answerDialogBody').innerHTML = `<div class="history-empty answer-empty">加载失败：${esc(e.message)}</div>`;
  }
}

async function loadUsers() {
  const r = await fetch(`/api/admin/users?t=${Date.now()}`, { cache: 'no-store' });
  const users = await r.json();
  if (!r.ok) throw new Error(users.error || '加载失败');
  usersById = new Map(users.map(u => [u.id, u]));
  $('#userRows').innerHTML = users.map(u => `
    <tr>
      <td><b>${esc(u.name)}</b></td>
      <td>${clientCell(u)}</td>
      <td>${date(u.firstSeen)}</td>
      <td>${date(u.lastSeen)}</td>
      <td>${Number(u.total || 0)} 题</td>
      <td>${scoreCell(u)}</td>
      <td><button class="history-open user-answer-open" type="button" data-user-id="${esc(u.id)}">回答记录</button></td>
    </tr>
  `).join('') || '<tr><td colspan="7">尚无用户数据</td></tr>';
}

$('#userRows').addEventListener('click', e => {
  const button = e.target.closest('.user-answer-open');
  if (!button) return;
  openUserAnswers(button.dataset.userId);
});

$('#answerDialogClose').addEventListener('click', () => closeDialog($('#answerDialog')));
$('#answerDialog').addEventListener('click', e => {
  if (e.target === $('#answerDialog')) closeDialog($('#answerDialog'));
});

loadUsers().catch(e => {
  $('#userRows').innerHTML = `<tr><td colspan="7">加载失败：${esc(e.message)}</td></tr>`;
});
