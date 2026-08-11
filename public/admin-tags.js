const $ = s => document.querySelector(s);
const id = new URLSearchParams(location.search).get('id');
let sound;
let tags = [];
let saveInFlight = false;
let lastSaveAt = 0;

const esc = s => String(s).replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[c]));

async function api(url, opts = {}) {
  const r = await fetch(url, opts);
  const x = await r.json();
  if (!r.ok) throw Error(x.error || '操作失败');
  return x;
}

function draw() {
  const list = $('#tags');
  list.innerHTML = tags.length
    ? tags.map((tag, i) => `<span class="editable-tag">${esc(tag)}<button class="remove-tag" onclick="removeTag(${i})" aria-label="删除 ${esc(tag)}">×</button></span>`).join('')
    : '<span style="color:#8a93a3">还没有标签，请在下方添加。</span>';
}

window.removeTag = i => {
  tags.splice(i, 1);
  draw();
};

function add() {
  const value = $('#newTag').value.trim();
  if (!value) return;
  if (tags.includes(value)) return alert('该标签已存在');
  tags.push(value);
  $('#newTag').value = '';
  draw();
}

$('#add').onclick = add;
$('#newTag').onkeydown = e => {
  if (e.key === 'Enter') add();
};

$('#save').onclick = async () => {
  const now = Date.now();
  if (saveInFlight || now - lastSaveAt < 1200) return;
  const name = $('#soundName').value.trim();
  if (!name) return alert('请填写声音名称');
  saveInFlight = true;
  lastSaveAt = now;
  const button = $('#save');
  const text = button.textContent;
  button.disabled = true;
  button.textContent = '保存中...';
  try {
    await api('/api/admin/sounds/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, tags })
    });
    location.href = '/admin.html';
  } catch (e) {
    alert(e.message);
  } finally {
    saveInFlight = false;
    button.disabled = false;
    button.textContent = text;
  }
};

(async () => {
  try {
    sound = (await api('/api/admin/sounds')).find(x => x.id === id);
    if (!sound) throw Error('未找到该声音');
    tags = [...sound.tags];
    $('#title').textContent = sound.name;
    $('#soundName').value = sound.name;
    $('#original').textContent = `原始文件名：${sound.originalName}`;
    draw();
  } catch (e) {
    $('#title').textContent = e.message;
  }
})();
