#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RECORDING_DIR = path.join(ROOT, 'data', 'asr-recordings');
const OUTPUT_DIR = path.join(ROOT, 'data', 'asr-comparisons');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function loadServerApi() {
  const code = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').split('http.createServer')[0];
  return new Function('require', '__dirname', `${code}\nreturn { ASR_RECORDINGS, sttConfig, transcribeAudioBaidu, fs, path };`)(require, ROOT);
}

function loadRecordings(limit = 0) {
  if (!fs.existsSync(RECORDING_DIR)) return [];
  const rows = fs.readdirSync(RECORDING_DIR)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => {
      const metaPath = path.join(RECORDING_DIR, name);
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const audioPath = path.join(RECORDING_DIR, meta.audioFile || '');
      if (!fs.existsSync(audioPath)) return null;
      return { meta, audioPath };
    })
    .filter(Boolean);
  return limit ? rows.slice(-limit) : rows;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.h) {
    console.log('Usage: node tools/asr-compare-baidu.js [--limit 5]');
    return;
  }
  const api = loadServerApi();
  const cfg = api.sttConfig();
  if (cfg.provider !== 'baidu') {
    console.log(`当前 STT_PROVIDER=${cfg.provider}。对比工具会临时按 baidu 配置运行。`);
    cfg.provider = 'baidu';
  }
  if (!cfg.apiKey || !cfg.secretKey) throw new Error('缺少 BAIDU_API_KEY 或 BAIDU_SECRET_KEY。');
  const recordings = loadRecordings(Number(args.limit || 0) || 0);
  if (!recordings.length) throw new Error('没有找到可对比的留存音频。');

  const startedAt = new Date().toISOString();
  const results = [];
  for (const row of recordings) {
    const started = Date.now();
    const file = {
      data: fs.readFileSync(row.audioPath),
      type: row.meta.mimeType,
      filename: row.meta.originalFilename || row.meta.audioFile
    };
    const base = {
      createdAt: row.meta.createdAt,
      soundId: row.meta.soundId,
      soundName: row.meta.soundName,
      currentProvider: row.meta.transcriptionProvider,
      currentModel: row.meta.transcriptionModel,
      currentTranscript: row.meta.transcript,
      durationMs: row.meta.durationMs,
      audioFile: row.meta.audioFile
    };
    try {
      const baidu = await api.transcribeAudioBaidu(file, cfg);
      results.push({
        ...base,
        baiduStatus: baidu.status,
        baiduText: baidu.text || '',
        baiduModel: baidu.model || '',
        baiduDurationMs: baidu.durationMs || Date.now() - started,
        baiduReason: baidu.reason || ''
      });
    } catch (e) {
      results.push({
        ...base,
        baiduStatus: 'failed',
        baiduError: e.message,
        baiduDurationMs: Date.now() - started
      });
    }
    const last = results[results.length - 1];
    console.log(`${last.soundName || last.soundId}: ${last.baiduStatus} · ${last.baiduText || last.baiduError || last.baiduReason || ''}`);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const stamp = startedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const output = path.join(OUTPUT_DIR, `baidu-${stamp}.json`);
  fs.writeFileSync(output, JSON.stringify({
    provider: 'baidu',
    endpoint: cfg.endpoint,
    model: cfg.model,
    devPid: cfg.devPid,
    format: cfg.format,
    rate: cfg.rate,
    startedAt,
    finishedAt: new Date().toISOString(),
    count: results.length,
    results
  }, null, 2));
  console.log(`\n报告已保存：${path.relative(ROOT, output)}`);
}

main().catch(e => {
  console.error(e.message);
  process.exit(1);
});
