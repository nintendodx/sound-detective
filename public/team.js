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
    const modelItems = Array.isArray(models.items) ? models.items : [];
    const asr = modelItems.find(item => String(item.stage || '').includes('语音'));
    const judge = modelItems.find(item => String(item.stage || '').includes('答案判定'));
    const codeLines = Number(stats.codeLines || stats.sourceLines || 0);
    const fileCount = Number(stats.fileCount || 0);
    const codeText = codeLines ? `${codeLines.toLocaleString('zh-CN')} 行代码` : '暂时无法读取';
    const codeMeta = codeLines
      ? `${fileCount.toLocaleString('zh-CN')} 个工程文件，不含素材、数据、录音和依赖。`
      : '统计不含素材、数据、录音和依赖。';
    const rows = [
      {
        stage: '声音判题',
        model: judge?.model || '本地语义规则匹配器',
        version: judge?.version || '',
        usage: '匹配声音名称、标签和同义表达，用于判断玩家回答。'
      },
      {
        stage: '语音识别',
        model: asr?.model || '实时语音识别',
        version: '服务端实时转写',
        usage: '实时 ASR 配置由服务端读取，密钥只保存在 Cloudflare，不进入前端。'
      },
      {
        stage: '工程量统计',
        model: '代码规模',
        version: codeText,
        usage: codeMeta
      }
    ];
    list.innerHTML = rows.map(modelRow).join('');
  } catch (e) {
    list.innerHTML = '<div class="model-row"><span>模型信息</span><b>暂时无法读取</b><small>请稍后刷新页面</small></div>';
  }
}

loadModelStats();
