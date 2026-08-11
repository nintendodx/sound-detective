const $ = s => document.querySelector(s);
let analyticsLoading = false;
let lastAnalyticsLoadAt = 0;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[c]));

const eventLabels = {
  page_load: '页面加载',
  page_leave: '离开页面',
  section_enter: '进入区块',
  section_leave: '离开区块',
  start_click: '开始挑战',
  start_success: '开始成功',
  start_error: '开始失败',
  game_started: '本轮开始',
  question_rendered: '题目展示',
  audio_play_request: '请求播音',
  audio_playing: '正在播音',
  audio_play_failed: '播音失败',
  record_click: '点击回答',
  record_started: '开始录音',
  record_stop_click: '手动结束录音',
  record_auto_stopped: '自动结束录音',
  mic_opened: '麦克风打开',
  mic_error: '麦克风失败',
  audio_probe_started: '录音采集',
  audio_probe_uploaded: '录音上传',
  audio_probe_upload_failed: '上传失败',
  audio_probe_error: '录音失败',
  audio_probe_empty: '录音为空',
  audio_only_transcribed: '本地转写成功',
  audio_only_received: '收到音频未转写',
  speech_started: '浏览器识别启动',
  speech_recognized: '浏览器识别成功',
  speech_error: '浏览器识别失败',
  speech_ended_empty: '浏览器识别为空',
  speech_start_failed: '识别启动失败',
  answer_submit: '提交判断',
  answer_response: '判题返回',
  answer_error: '判题失败',
  round_complete: '完成 5 题',
  library_complete: '完成全题库'
};

function eventName(type) {
  return eventLabels[type] || type || '-';
}

function date(s) {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('zh-CN', { hour12: false });
}

function duration(ms) {
  const n = Number(ms || 0);
  if (!n) return '-';
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}s`;
  return `${Math.floor(n / 60000)}分${Math.round((n % 60000) / 1000)}秒`;
}

function number(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

function metric(label, value, note = '') {
  return `
    <div class="metric-card">
      <span>${esc(label)}</span>
      <b>${esc(value)}</b>
      ${note ? `<small>${esc(note)}</small>` : ''}
    </div>
  `;
}

function objectSummary(input) {
  const details = input && typeof input === 'object' ? input : {};
  const pairs = Object.entries(details)
    .filter(([, value]) => value !== '' && value !== null && value !== undefined)
    .slice(0, 8)
    .map(([key, value]) => {
      const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
      return `${key}: ${text}`;
    });
  return pairs.length ? pairs.join(' · ') : '-';
}

function renderRows(selector, rows, empty, render) {
  const el = $(selector);
  el.innerHTML = rows.length ? rows.map(render).join('') : `<tr><td colspan="8">${esc(empty)}</td></tr>`;
}

function renderMetrics(data) {
  $('#metricGrid').innerHTML = [
    metric('总事件', number(data.totalEvents), `近 30 分钟 ${number(data.recentEvents)} 条`),
    metric('设备数', number(data.uniqueDevices), `用户数 ${number(data.uniqueUsers)}`),
    metric('开始轮次', number(data.startedRounds), `完成 ${number(data.completedRounds)} 轮`),
    metric('疑似中断', number(data.abandonedRounds), '已开始但未完成 5 题'),
    metric('5 题平均用时', duration(data.avgRoundMs), `P95 ${duration(data.p95RoundMs)}`),
    metric('全题库平均用时', duration(data.avgLibraryMs), `P95 ${duration(data.p95LibraryMs)}`)
  ].join('');

  const r = data.recording || {};
  $('#recordingGrid').innerHTML = [
    metric('点击回答', number(r.recordClicks)),
    metric('开始录音', number(r.recordStarted)),
    metric('手动结束', number(r.recordStops)),
    metric('5 秒自动结束', number(r.recordAutoStops)),
    metric('麦克风打开', number(r.micOpened)),
    metric('音频上传', number(r.audioUploaded)),
    metric('识别出文字', number(r.transcribed)),
    metric('收到但无文字', number(r.audioReceivedNoText)),
    metric('录音/识别错误', number(r.errors))
  ].join('');
}

function renderTables(data) {
  renderRows('#pageRows', data.pageStats || [], '暂无页面停留数据', row => `
    <tr>
      <td><b>${esc(row.page)}</b></td>
      <td>${number(row.count)}</td>
      <td>${duration(row.avgDurationMs)}</td>
      <td>${duration(row.p95DurationMs)}</td>
      <td>${duration(row.maxDurationMs)}</td>
    </tr>
  `);

  renderRows('#apiRows', data.apiStats || [], '暂无接口数据', row => `
    <tr>
      <td><b>${esc(row.url)}</b></td>
      <td>${number(row.count)}</td>
      <td class="${row.errors ? 'danger' : ''}">${number(row.errors)}</td>
      <td>${duration(row.avgMs)}</td>
      <td>${duration(row.p95Ms)}</td>
      <td>${date(row.latestAt)}</td>
    </tr>
  `);

  $('#eventCounts').innerHTML = (data.eventCounts || []).map(item => `
    <span class="event-pill"><b>${esc(eventName(item.type))}</b><i>${number(item.count)}</i></span>
  `).join('') || '<span class="history-empty">暂无事件</span>';

  renderRows('#recentRows', data.recent || [], '暂无事件记录', row => `
    <tr>
      <td>${date(row.at)}</td>
      <td><b>${esc(eventName(row.type))}</b><small>${esc(row.type)}</small></td>
      <td><small>${esc(row.userId || '未登录')}</small><small>${esc(row.deviceId || '无设备')}</small></td>
      <td>${esc(row.page || row.path || '-')}</td>
      <td><small>${esc(objectSummary(row.details))}</small></td>
    </tr>
  `);
}

async function loadAnalytics() {
  const now = Date.now();
  if (analyticsLoading || now - lastAnalyticsLoadAt < 1000) return;
  analyticsLoading = true;
  lastAnalyticsLoadAt = now;
  const refresh = $('#refreshAnalytics');
  if (refresh) {
    refresh.disabled = true;
    refresh.textContent = '刷新中...';
  }
  const status = $('#analyticsUpdated');
  status.textContent = '正在读取埋点数据...';
  try {
    const res = await fetch('/api/admin/analytics');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '读取失败');
    renderMetrics(data);
    renderTables(data);
    status.textContent = `更新于 ${date(data.generatedAt)}`;
  } catch (e) {
    status.textContent = `读取失败：${e.message}`;
    $('#metricGrid').innerHTML = metric('统计分析', '读取失败', e.message);
  } finally {
    analyticsLoading = false;
    if (refresh) {
      refresh.disabled = false;
      refresh.textContent = '刷新';
    }
  }
}

$('#refreshAnalytics').onclick = loadAnalytics;
loadAnalytics();
