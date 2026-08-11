function esc(s = '') {
  return String(s).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function modelRow(item = {}) {
  return `
    <div class="model-row">
      <span>${esc(item.stage)}</span>
      <b>${esc(item.model)}</b>
      <strong>${esc(item.version)}</strong>
      <small>${esc(item.usage)}</small>
    </div>
  `;
}

async function fetchJson(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function loadModelStats() {
  const list = document.querySelector('#modelList');
  if (!list) return;
  try {
    const [models, stats] = await Promise.all([fetchJson('/api/team-models'), fetchJson('/api/team-stats')]);
    const tokenText = stats.totalTokens ? `${Number(stats.totalTokens).toLocaleString('zh-CN')} tokens` : '暂时无法读取';
    const tokenMeta = stats.totalTokens
      ? `Codex 项目协作累计 · ${Number(stats.sessionCount || 0)} 个相关线程 · 更新于 ${new Date(stats.updatedAt).toLocaleString('zh-CN')}`
      : '未找到可用的 Codex 会话 token 统计';
    const asrCount = Number(stats.asrTranscriptionCount || 0);
    const rows = [
      ...(Array.isArray(models.items) ? models.items.slice(0, 1) : []),
      {
        stage: '项目消耗',
        model: 'Codex Token 消耗',
        version: tokenText,
        usage: tokenMeta
      },
      {
        stage: '语音识别统计',
        model: '累计识别语音',
        version: `${asrCount.toLocaleString('zh-CN')} 次`,
        usage: '统计已完成 ASR 调用的用户语音，不包含仍在排队的录音'
      },
      ...(Array.isArray(models.items) ? models.items.slice(1) : [])
    ];
    list.innerHTML = rows.map(modelRow).join('');
  } catch (e) {
    list.innerHTML = '<div class="model-row"><span>模型信息</span><b>暂时无法读取</b><small>请稍后刷新页面</small></div>';
  }
}

loadModelStats();
