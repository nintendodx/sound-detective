#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RECORDING_DIR = path.join(ROOT, 'data', 'asr-recordings');
const OUTPUT_DIR = path.join(ROOT, 'data', 'asr-comparisons');

function loadEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    value = value.replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function help() {
  return `
MiniMax ASR comparison

Usage:
  node tools/asr-compare-minimax.js --list-models
  node tools/asr-compare-minimax.js --endpoint <url> --model <model>

Env:
  MINIMAX_API_KEY        MiniMax API key
  MINIMAX_BASE_URL       Default: https://api.minimax.io/v1
  MINIMAX_ASR_ENDPOINT   ASR endpoint provided by MiniMax
  MINIMAX_ASR_MODEL      ASR model name
  MINIMAX_ASR_MODE       multipart | json-base64, default multipart
  MINIMAX_ASR_LANGUAGE   Default: zh

Notes:
  MiniMax's public OpenAI-compatible text API is not an ASR endpoint. If your
  MiniMax account has a private/new ASR route, put that URL in MINIMAX_ASR_ENDPOINT.
`.trim();
}

function mimeFromName(name) {
  const ext = path.extname(name).toLowerCase();
  return {
    '.m4a': 'audio/mp4',
    '.mp4': 'audio/mp4',
    '.aac': 'audio/aac',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.webm': 'audio/webm',
    '.ogg': 'audio/ogg'
  }[ext] || 'application/octet-stream';
}

function findText(input) {
  if (!input || typeof input !== 'object') return '';
  return String(
    input.text ||
    input.transcript ||
    input.result?.text ||
    input.result?.transcript ||
    input.data?.text ||
    input.data?.transcript ||
    input.output_text ||
    input.choices?.[0]?.message?.content ||
    ''
  ).trim();
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.text();
  let json = {};
  try {
    json = JSON.parse(body);
  } catch (e) {
    json = { raw: body };
  }
  if (!response.ok) {
    const error = json.error?.message || json.message || body.slice(0, 400) || `HTTP ${response.status}`;
    throw new Error(error);
  }
  return json;
}

async function listModels(cfg) {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/models`;
  const json = await requestJson(url, {
    headers: { Authorization: `Bearer ${cfg.key}` }
  });
  return json;
}

async function transcribeMultipart(recording, cfg) {
  const form = new FormData();
  form.append('model', cfg.model);
  form.append('language', cfg.language);
  form.append('response_format', 'json');
  form.append('file', new Blob([recording.audio], { type: recording.mimeType }), recording.filename);
  return requestJson(cfg.endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.key}` },
    body: form
  });
}

async function transcribeJsonBase64(recording, cfg) {
  const payload = {
    model: cfg.model,
    language: cfg.language,
    audio: {
      filename: recording.filename,
      mime_type: recording.mimeType,
      data: recording.audio.toString('base64')
    },
    instruction: '请只输出这段中文音频的转写文字。'
  };
  return requestJson(cfg.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
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
      const audio = fs.readFileSync(audioPath);
      return {
        metaPath,
        audioPath,
        audio,
        filename: meta.originalFilename || meta.audioFile || path.basename(audioPath),
        mimeType: meta.mimeType || mimeFromName(audioPath),
        meta
      };
    })
    .filter(Boolean);
  return limit ? rows.slice(-limit) : rows;
}

function buildConfig(args) {
  return {
    key: args.key || process.env.MINIMAX_API_KEY || '',
    baseUrl: args['base-url'] || process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1',
    endpoint: args.endpoint || process.env.MINIMAX_ASR_ENDPOINT || '',
    model: args.model || process.env.MINIMAX_ASR_MODEL || '',
    mode: args.mode || process.env.MINIMAX_ASR_MODE || 'multipart',
    language: args.language || process.env.MINIMAX_ASR_LANGUAGE || 'zh',
    limit: Number(args.limit || process.env.MINIMAX_ASR_LIMIT || 0) || 0
  };
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv);
  if (args.help || args.h) {
    console.log(help());
    return;
  }
  const cfg = buildConfig(args);
  if (!cfg.key) throw new Error('缺少 MINIMAX_API_KEY，请先在 .env 中填写。');

  if (args['list-models']) {
    const models = await listModels(cfg);
    console.log(JSON.stringify(models, null, 2));
    return;
  }

  if (!cfg.endpoint) {
    throw new Error('缺少 MINIMAX_ASR_ENDPOINT。MiniMax 公开 OpenAI-compatible 文本接口不是 ASR 接口；请填写你拿到的 MiniMax ASR endpoint。');
  }
  if (!cfg.model) throw new Error('缺少 MINIMAX_ASR_MODEL，请填写要对比的 MiniMax ASR 模型名。');
  if (!['multipart', 'json-base64'].includes(cfg.mode)) throw new Error('MINIMAX_ASR_MODE 只能是 multipart 或 json-base64。');

  const recordings = loadRecordings(cfg.limit);
  if (!recordings.length) throw new Error(`没有找到留存音频：${path.relative(ROOT, RECORDING_DIR)}`);

  const startedAt = new Date().toISOString();
  const results = [];
  for (const recording of recordings) {
    const started = Date.now();
    const base = {
      createdAt: recording.meta.createdAt,
      soundId: recording.meta.soundId,
      soundName: recording.meta.soundName,
      currentProvider: recording.meta.transcriptionProvider,
      currentModel: recording.meta.transcriptionModel,
      currentTranscript: recording.meta.transcript,
      durationMs: recording.meta.durationMs,
      audioFile: recording.meta.audioFile
    };
    try {
      const json = cfg.mode === 'json-base64'
        ? await transcribeJsonBase64(recording, cfg)
        : await transcribeMultipart(recording, cfg);
      results.push({
        ...base,
        minimaxStatus: 'ok',
        minimaxText: findText(json),
        minimaxDurationMs: Date.now() - started,
        raw: json
      });
    } catch (e) {
      results.push({
        ...base,
        minimaxStatus: 'failed',
        minimaxError: e.message,
        minimaxDurationMs: Date.now() - started
      });
    }
    const last = results[results.length - 1];
    console.log(`${last.soundName || last.soundId}: ${last.minimaxStatus} · ${last.minimaxText || last.minimaxError || ''}`);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const stamp = startedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const output = path.join(OUTPUT_DIR, `minimax-${stamp}.json`);
  fs.writeFileSync(output, JSON.stringify({
    provider: 'minimax',
    endpoint: cfg.endpoint,
    model: cfg.model,
    mode: cfg.mode,
    language: cfg.language,
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
