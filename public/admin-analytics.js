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
  audio_play_unconfirmed: '未确认播音',
  record_blocked_audio_unconfirmed: '播音未确认拦截录音',
  record_click: '点击回答',
  record_started: '开始录音',
  record_stop_click: '手动结束录音',
  record_auto_stopped: '自动结束录音',
  asr_config_error: 'ASR 配置失败',
  asr_connect_started: 'ASR 开始连接',
  asr_ready: 'ASR 已就绪',
  asr_first_partial: 'ASR 首字返回',
  asr_final: 'ASR 最终结果',
  asr_error: 'ASR 实时错误',
  asr_retry: '重新回答',
  mic_opened: '麦克风打开',
  mic_error: '麦克风失败',
  audio_probe_started: '录音采集',
  audio_probe_uploaded: '录音上传',
  audio_probe_upload_failed: '上传失败',
  audio_probe_error: '录音失败',
  audio_probe_empty: '录音为空',
  audio_incomplete: '录音不完整',
  audio_health_unknown: '音频质量未知',
  audio_only_transcribed: '本地转写成功',
  audio_only_received: '收到音频未转写',
  speech_missing: '未检测到人声',
  speech_empty: 'ASR 为空',
  transcribe_failed: 'ASR 失败',
  audio_asr_ignored: 'ASR 结果已忽略',
  audio_answer_rejected: '语音重复拒绝',
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

async function readJsonResponse(response, fallback = '读取失败') {
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    const type = response.headers.get('content-type') || '未知类型';
    throw new Error(`后台接口返回了非 JSON 内容（HTTP ${response.status}，${type}）`);
  }
  if (!response.ok) throw new Error(data.error || fallback);
  return data;
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

function renderRows(selector, rows, empty, render, colspan = 8) {
  const el = $(selector);
  el.innerHTML = rows.length ? rows.map(render).join('') : `<tr><td colspan="${colspan}">${esc(empty)}</td></tr>`;
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
    metric('ASR 连接', number(r.asrConnectStarted), `成功 ${number(r.asrReady)}`),
    metric('ASR 最终结果', number(r.asrFinals)),
    metric('识别出文字', number(r.transcribed)),
    metric('收到但无文字', number(r.audioReceivedNoText)),
    metric('录音/识别错误', number(r.errors)),
    metric('点击到开始率', `${number(r.clickToStartRate)}%`),
    metric('连接成功率', `${number(r.connectSuccessRate)}%`),
    metric('开始到识别率', `${number(r.startToTranscribedRate)}%`),
    metric('开始到上传率', `${number(r.startToUploadRate)}%`),
    metric('上传到识别率', `${number(r.uploadToTranscribedRate)}%`)
  ].join('');
}

function renderAsrExperiments(data) {
  renderRows('#asrRows', data.asrExperiments || [], '暂无 ASR 分组数据', row => `
    <tr>
      <td><b>${esc(row.label || row.provider)}</b><small>${esc(row.provider)}</small></td>
      <td>${row.configured ? '已配置' : '未配置'}</td>
      <td>${number(row.assignedRounds)}<small>${number(row.uniqueUsers)} 人</small></td>
      <td>${number(row.completionRate)}%</td>
      <td>${number(row.connectSuccessRate)}%<small>${number(row.ready)} / ${number(row.connectAttempts)}</small></td>
      <td>${number(row.recognitionSuccessRate)}%<small>${number(row.finals)} / ${number(row.recordStarts)}</small></td>
      <td class="${Number(row.errorRate || 0) ? 'danger' : ''}">${number(row.errorRate)}%</td>
      <td>${duration(row.firstTextP50)}</td>
      <td>${duration(row.finalP50)}</td>
    </tr>
  `, 9);
}

function statPills(rows = [], labelFn = row => row.key) {
  return rows.map(row => `
    <span class="event-pill"><b>${esc(labelFn(row))}</b><i>${number(row.count)}</i></span>
  `).join('') || '<span class="history-empty">暂无数据</span>';
}

function renderClientStats(data) {
  const clients = data.clients || {};
  const audio = data.audioAnswers || {};
  $('#clientGrid').innerHTML = [
    metric('已识别用户环境', number(clients.identifiedUsers), `缺少 ${number(clients.missingUsers)} 个用户`),
    metric('后端录音记录', number(audio.count), 'audioAnswers'),
    metric('录音时长 P50', duration(audio.actualDurationMs?.p50), `P95 ${duration(audio.actualDurationMs?.p95)}`),
    metric('ASR 耗时 P50', duration(audio.asrDurationMs?.p50), `P95 ${duration(audio.asrDurationMs?.p95)}`)
  ].join('');

  $('#clientPills').innerHTML = [
    statPills(clients.os || []),
    statPills(clients.browsers || []),
    statPills(audio.transcriptionStatus || [], row => `ASR ${row.key}`),
    statPills(audio.audioStatus || [], row => `音频 ${row.key}`)
  ].join('');

  renderRows('#clientRows', clients.users || [], '暂无用户环境数据', row => `
    <tr>
      <td><b>${esc(row.name || '匿名玩家')}</b><small>${esc(row.userId || '')}</small></td>
      <td>${esc([row.os, row.osVersion].filter(Boolean).join(' ') || '-')}</td>
      <td>${esc([row.browser, row.browserVersion].filter(Boolean).join(' ') || '-')}</td>
      <td>${esc(row.deviceType || '-')}</td>
      <td>${date(row.lastSeen)}</td>
    </tr>
  `, 5);
}

function renderCompatibility(data) {
  const compatibility = data.compatibility || {};
  const issues = [
    ...(compatibility.issueCounts || []).map(row => ({ ...row, source: '前端' })),
    ...(compatibility.monitorIssueCounts || []).map(row => ({ ...row, source: '后端' }))
  ].sort((a, b) => b.count - a.count || date(b.latestAt).localeCompare(date(a.latestAt)));
  const clientRows = compatibility.recordingByClient || [];
  const totals = clientRows.reduce((acc, row) => {
    acc.noText += Number(row.noText || 0);
    acc.errors += Number(row.errors || 0);
    acc.playIssues += Number(row.playIssues || 0);
    return acc;
  }, { noText: 0, errors: 0, playIssues: 0 });
  $('#issueGrid').innerHTML = [
    metric('问题事件', number(compatibility.issueEvents)),
    metric('无文字结果', number(totals.noText)),
    metric('录音/接口错误', number(totals.errors)),
    metric('播放确认问题', number(totals.playIssues))
  ].join('');

  renderRows('#issueRows', issues, '暂无语音链路问题', row => `
    <tr>
      <td><b>${esc(eventName(row.type))}</b><small>${esc(row.source)} · ${esc(row.type)}</small></td>
      <td>${number(row.count)}</td>
      <td>${date(row.latestAt)}</td>
    </tr>
  `, 3);

  renderRows('#clientRecordingRows', clientRows, '暂无按客户端拆分的录音数据', row => `
    <tr>
      <td><b>${esc(row.client)}</b></td>
      <td>${number(row.recordClicks)}</td>
      <td>${number(row.startRate)}%</td>
      <td>${number(row.uploadRate)}%</td>
      <td>${number(row.transcribeRate)}%</td>
      <td>${number(row.noText)}</td>
      <td>${number(Number(row.errors || 0) + Number(row.playIssues || 0))}</td>
    </tr>
  `, 7);
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
  `, 5);

  renderRows('#apiRows', data.apiStats || [], '暂无接口数据', row => `
    <tr>
      <td><b>${esc(row.url)}</b></td>
      <td>${number(row.count)}</td>
      <td class="${row.errors ? 'danger' : ''}">${number(row.errors)}</td>
      <td>${duration(row.avgMs)}</td>
      <td>${duration(row.p95Ms)}</td>
      <td>${date(row.latestAt)}</td>
    </tr>
  `, 6);

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
  `, 5);
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
    const res = await fetch(`/api/admin/analytics?t=${Date.now()}`, { cache: 'no-store', headers: { Accept: 'application/json' } });
    const data = await readJsonResponse(res);
    renderMetrics(data);
    renderAsrExperiments(data);
    renderClientStats(data);
    renderCompatibility(data);
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
