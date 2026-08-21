import { Buffer } from "node:buffer";
import { gzipSync, gunzipSync } from "node:zlib";
import { createWorkerAsrHealthService, healthyProviderIds } from "../shared/asr-health-worker.mjs";

const ANALYTICS_MAX_EVENTS = 50000;
const DEFAULT_USER_NAMES = new Set(["匿名玩家", "匿名", "游客", "未命名", "无名", "无名侦探"]);
const ASR_PROVIDER_LABELS = Object.freeze({
  "tencent-realtime-v2": "腾讯实时语音识别 2.0",
  "doubao-streaming-v2": "豆包双向流式 2.0",
  "baidu-realtime": "百度实时语音识别"
});

const SEMANTIC_INTENTS = {
  "sound-breaking-a-cup": ["杯子摔碎", "杯子碎了", "打碎杯子", "玻璃杯碎", "玻璃碎", "杯子破了", "碎裂", "摔杯子", "砸杯子"],
  "sound-door-chime": ["门铃", "按门铃", "门铃响", "铃声", "叮咚", "有人按门铃"],
  "sound-entering-a-house": ["进门", "开门进屋", "开门进来", "开门回家", "回家开门", "进屋", "入门", "房门打开"],
  "sound-knocking-an-iron-door": ["敲铁门", "敲门", "拍门", "门响", "铁门响", "铁门声", "有人敲门", "敲门声"],
  "sound-lighting-a-match": ["划火柴", "擦火柴", "点火柴", "火柴点燃", "点燃火柴", "火柴", "划着火柴"],
  "sound-out-of-a-toilet": ["马桶冲水", "冲马桶", "厕所冲水", "卫生间冲水", "抽水马桶", "冲水", "上厕所冲水", "马桶"],
  "sound-scissors": ["剪刀", "剪东西", "剪纸", "裁剪", "剪开", "用剪刀", "剪刀剪"],
  "sound-vinyl-bag": ["塑料袋", "揉塑料袋", "搓塑料袋", "塑料袋揉搓", "袋子揉搓", "包装袋", "塑料包装", "塑料声"],
  "sound-writing-in-a-pen": ["写字", "用笔写字", "笔写字", "钢笔写字", "铅笔写字", "笔划纸", "书写", "写东西", "纸上写字", "黑板上写字", "板书", "粉笔写字"]
};

const FILLER_PATTERNS = [
  "这是", "这个是", "应该是", "可能是", "好像是", "听起来像", "我觉得", "感觉是", "就是",
  "有点像", "像是", "大概是", "应该就是", "一个", "一种", "有人在", "有人", "正在",
  "发出来的", "发出的", "传来的", "的声音", "这个声音", "声音", "音效", "里面", "外面"
];

function rows(input) {
  return Array.isArray(input) ? input : [];
}

function noStoreHeaders(extra = {}) {
  return {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    ...extra
  };
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: noStoreHeaders() });
}

function uuid() {
  return globalThis.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function envValue(env, key, fallback = "") {
  const value = env?.[key];
  return value === undefined || value === null || String(value) === "" ? fallback : value;
}

function soundAsrHotwords(data) {
  const words = [];
  for (const sound of rows(data?.sounds)) {
    if (!sound || sound.enabled === false) continue;
    if (sound.name) words.push(sound.name);
    for (const tag of [...rows(sound.tags), ...rows(sound.aliases)]) words.push(tag);
  }
  words.push("声音", "音效", "掌声", "猫", "狗", "下雨", "雨声", "门铃", "敲门", "火柴", "剪刀", "键盘", "地铁", "洗衣机", "蝉鸣");
  return [...new Set(words.map((word) => String(word || "").trim()).filter(Boolean))].slice(0, 300);
}

function baiduRealtimeConfig(env) {
  const configured = Boolean(envValue(env, "BAIDU_APP_ID") && envValue(env, "BAIDU_API_KEY"));
  const enabledByOperator = !/^(0|false|no|off)$/i.test(String(envValue(env, "BAIDU_REALTIME_ASR_ENABLED", envValue(env, "BAIDU_REALTIME_ENABLED", "true"))).trim());
  return {
    configured,
    enabled: configured && enabledByOperator,
    disabledReason: configured ? "百度实时识别已由配置停用" : "缺少百度实时识别密钥",
    appId: envValue(env, "BAIDU_APP_ID"),
    appKey: envValue(env, "BAIDU_API_KEY"),
    endpoint: envValue(env, "BAIDU_REALTIME_ASR_ENDPOINT", "wss://vop.baidu.com/realtime_asr"),
    devPid: Number(envValue(env, "BAIDU_REALTIME_ASR_DEV_PID", "15372")),
    lmId: Number(envValue(env, "BAIDU_REALTIME_ASR_LM_ID", "0")),
    cuid: envValue(env, "BAIDU_ASR_CUID", "voice-detective-demo"),
    sampleRate: 16000,
    format: "pcm"
  };
}

function tencentRealtimeConfig(env) {
  const noiseValue = String(envValue(env, "TENCENT_ASR_NOISE_THRESHOLD")).trim();
  const credentials = Boolean(
    (envValue(env, "TENCENT_ASR_APP_ID") || envValue(env, "TENCENT_APP_ID")) &&
    (envValue(env, "TENCENT_ASR_SECRET_ID") || envValue(env, "TENCENT_SECRET_ID")) &&
    (envValue(env, "TENCENT_ASR_SECRET_KEY") || envValue(env, "TENCENT_SECRET_KEY"))
  );
  const tencentEnabled = !/^(0|false|no|off)$/i.test(String(envValue(env, "TENCENT_ASR_ENABLED", "true")).trim());
  return {
    configured: credentials,
    enabled: credentials && tencentEnabled,
    disabledReason: credentials ? "腾讯实时识别已由配置停用" : "缺少腾讯实时识别密钥",
    appId: envValue(env, "TENCENT_ASR_APP_ID") || envValue(env, "TENCENT_APP_ID"),
    secretId: envValue(env, "TENCENT_ASR_SECRET_ID") || envValue(env, "TENCENT_SECRET_ID"),
    secretKey: envValue(env, "TENCENT_ASR_SECRET_KEY") || envValue(env, "TENCENT_SECRET_KEY"),
    endpoint: envValue(env, "TENCENT_ASR_ENDPOINT", "wss://asr.cloud.tencent.com/asr/v2"),
    engineModelType: envValue(env, "TENCENT_ASR_ENGINE_MODEL_TYPE", "16k_zh_en_speaker"),
    vadSilenceTime: Number(envValue(env, "TENCENT_ASR_VAD_SILENCE_TIME", "800")),
    noiseThreshold: noiseValue === "" ? null : Number(noiseValue),
    hotwordId: envValue(env, "TENCENT_ASR_HOTWORD_ID"),
    hotwordLimit: Math.min(128, Math.max(20, Number(envValue(env, "TENCENT_ASR_HOTWORD_LIMIT", envValue(env, "ASR_REALTIME_HOTWORD_LIMIT", "128"))))),
    sampleRate: 16000,
    format: "pcm"
  };
}

function doubaoRealtimeConfig(env) {
  return {
    enabled: Boolean(envValue(env, "DOUBAO_ASR_API_KEY") || envValue(env, "VOLCENGINE_ASR_API_KEY")) && envValue(env, "DOUBAO_ASR_ENABLED", "true") !== "false",
    apiKey: envValue(env, "DOUBAO_ASR_API_KEY") || envValue(env, "VOLCENGINE_ASR_API_KEY"),
    endpoint: envValue(env, "DOUBAO_ASR_ENDPOINT", "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"),
    resourceId: envValue(env, "DOUBAO_ASR_RESOURCE_ID", "volc.bigasr.sauc.duration"),
    endWindowSize: Number(envValue(env, "DOUBAO_ASR_END_WINDOW_SIZE", "800")),
    forceToSpeechTime: Number(envValue(env, "DOUBAO_ASR_FORCE_TO_SPEECH_TIME", "1000")),
    sampleRate: 16000,
    format: "pcm"
  };
}

function realtimeProviderConfigs(env) {
  return {
    "tencent-realtime-v2": tencentRealtimeConfig(env),
    "doubao-streaming-v2": doubaoRealtimeConfig(env),
    "baidu-realtime": baiduRealtimeConfig(env)
  };
}

function availableAsrProviders(env) {
  const configs = realtimeProviderConfigs(env);
  return Object.keys(ASR_PROVIDER_LABELS).filter((provider) => configs[provider]?.enabled);
}

function randomAsrProvider(env) {
  const providers = availableAsrProviders(env);
  return providers.length ? providers[Math.floor(Math.random() * providers.length)] : "";
}

function base64FromBytes(bytes) {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}

async function hmacSha1Base64(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return base64FromBytes(new Uint8Array(signature));
}

async function tencentRealtimeUrl(env, config, hotwords = []) {
  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    secretid: config.secretId,
    engine_model_type: config.engineModelType,
    timestamp,
    expired: timestamp + 120,
    nonce: Math.floor(100000 + Math.random() * 900000),
    voice_id: uuid(),
    voice_format: 1,
    result_mod: 1,
    speaker_diarization: 0,
    needvad: 1,
    vad_silence_time: config.vadSilenceTime,
    reinforce_hotword: 1
  };
  const limitedHotwords = [...new Set(hotwords.map((word) => String(word || "").replace(/[^\p{L}\p{N}\s·.'-]/gu, " ").replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, Math.min(128, config.hotwordLimit || hotwords.length));
  if (limitedHotwords.length) params.hotword_list = limitedHotwords.map((word) => `${word}|11`).join(",");
  if (Number.isFinite(config.noiseThreshold)) params.noise_threshold = config.noiseThreshold;
  if (config.hotwordId) {
    params.hotword_id = config.hotwordId;
    delete params.hotword_list;
  }
  const query = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join("&");
  const endpoint = new URL(config.endpoint);
  const signTarget = `${endpoint.host}/asr/v2/${config.appId}?${query}`;
  const signature = await hmacSha1Base64(config.secretKey, signTarget);
  return `${endpoint.protocol}//${endpoint.host}/asr/v2/${config.appId}?${query}&signature=${encodeURIComponent(signature)}`;
}

function bufferToArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

async function arrayBufferFromWsData(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (typeof data === "string") return new TextEncoder().encode(data).buffer;
  if (data?.arrayBuffer) return data.arrayBuffer();
  return bufferToArrayBuffer(Buffer.from(data || ""));
}

function doubaoHeader(messageType, flags, serialization = 1, compression = 1) {
  return Buffer.from([0x11, (messageType << 4) | flags, (serialization << 4) | compression, 0]);
}

function doubaoRequest(messageType, sequence, payload, last = false, jsonPayload = false) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(jsonPayload ? JSON.stringify(payload) : payload || "");
  const compressed = gzipSync(data);
  const header = doubaoHeader(messageType, last ? 3 : 1, 1, 1);
  const packet = Buffer.alloc(header.length + 8 + compressed.length);
  header.copy(packet, 0);
  packet.writeInt32BE(last ? -Math.abs(sequence) : sequence, 4);
  packet.writeUInt32BE(compressed.length, 8);
  compressed.copy(packet, 12);
  return bufferToArrayBuffer(packet);
}

function parseDoubaoResponse(input) {
  const message = Buffer.from(input);
  if (message.length < 4) throw Error("豆包响应包不完整");
  const headerBytes = (message[0] & 0x0f) * 4;
  if (headerBytes < 4 || headerBytes > message.length) throw Error("豆包响应包头无效");
  const messageType = message[1] >> 4;
  const flags = message[1] & 0x0f;
  const serialization = message[2] >> 4;
  const compression = message[2] & 0x0f;
  let offset = headerBytes;
  let sequence = 0;
  let last = Boolean(flags & 0x02);
  let code = 0;
  const requireBytes = (size) => {
    if (offset + size > message.length) throw Error("豆包响应字段不完整");
  };
  if (flags & 0x01) {
    requireBytes(4);
    sequence = message.readInt32BE(offset);
    offset += 4;
  }
  if (flags & 0x04) {
    requireBytes(4);
    offset += 4;
  }
  if (messageType === 9) {
    requireBytes(4);
    offset += 4;
  } else if (messageType === 15) {
    requireBytes(8);
    code = message.readInt32BE(offset);
    offset += 8;
  }
  let payload = message.subarray(offset);
  if (compression === 1 && payload.length) payload = gunzipSync(payload);
  let body = null;
  if (serialization === 1 && payload.length) body = JSON.parse(payload.toString("utf8"));
  return { code, sequence, last, body };
}

function doubaoStartPayload(config, uid, hotwords = []) {
  return {
    user: { uid: String(uid || "voice-detective").slice(0, 64) },
    audio: { format: "pcm", codec: "raw", rate: config.sampleRate, bits: 16, channel: 1 },
    request: {
      model_name: "bigmodel",
      enable_nonstream: true,
      enable_itn: false,
      enable_punc: false,
      enable_ddc: false,
      show_utterances: true,
      result_type: "full",
      end_window_size: config.endWindowSize,
      force_to_speech_time: config.forceToSpeechTime,
      corpus: { context: JSON.stringify({ hotwords: [...new Set(hotwords)].slice(0, 200).map((word) => ({ word })) }) }
    }
  };
}

async function doubaoRealtimeSocket(config) {
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol === "wss:") endpoint.protocol = "https:";
  const response = await fetch(endpoint.toString(), {
    headers: {
      Upgrade: "websocket",
      "X-Api-Key": config.apiKey,
      "X-Api-Resource-Id": config.resourceId,
      "X-Api-Request-Id": uuid(),
      "X-Api-Sequence": "-1"
    }
  });
  if (response.status !== 101 || !response.webSocket) {
    const body = await response.text().catch(() => "");
    throw Error(body.slice(0, 160) || `豆包握手失败 ${response.status}`);
  }
  response.webSocket.binaryType = "arraybuffer";
  response.webSocket.accept();
  return response.webSocket;
}

const soundAsrHealth = createWorkerAsrHealthService({
  labels:ASR_PROVIDER_LABELS,
  configs:realtimeProviderConfigs,
  connect:async (provider, config, env, hotwords) => {
    if (provider === "baidu-realtime") {
      const endpoint = new URL(config.endpoint);
      endpoint.searchParams.set("sn", uuid());
      return new WebSocket(endpoint.toString());
    }
    if (provider === "tencent-realtime-v2") return new WebSocket(await tencentRealtimeUrl(env, config, hotwords));
    if (provider === "doubao-streaming-v2") return doubaoRealtimeSocket(config);
    throw Error("未知语音识别服务");
  },
  baiduStart:config => {
    const data = { appid:Number(config.appId), appkey:config.appKey, dev_pid:config.devPid, cuid:config.cuid, format:config.format, sample:config.sampleRate };
    if (config.lmId) data.lm_id = config.lmId;
    return JSON.stringify({ type:"START", data });
  },
  doubaoStart:(config, hotwords) => doubaoRequest(1, 1, doubaoStartPayload(config, "voice-detective-health", hotwords), false, true),
  doubaoFinish:() => doubaoRequest(2, 2, Buffer.alloc(3200), true, false),
  parseDoubao:async data => parseDoubaoResponse(await arrayBufferFromWsData(data)),
  textFromData:textFromWsData
});

function timeValue(value) {
  const t = new Date(value || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

function minIso(a, b) {
  if (!a) return b || "";
  if (!b) return a || "";
  return timeValue(a) <= timeValue(b) ? a : b;
}

function maxIso(a, b) {
  if (!a) return b || "";
  if (!b) return a || "";
  return timeValue(a) >= timeValue(b) ? a : b;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cleanUserName(name) {
  return String(name || "").trim().slice(0, 20);
}

function displayUserName(name) {
  return cleanUserName(name) || "匿名玩家";
}

function isMergeableUserName(name) {
  const clean = cleanUserName(name);
  return Boolean(clean && !DEFAULT_USER_NAMES.has(clean));
}

function cleanDeviceId(value) {
  return String(value || "").trim().slice(0, 80);
}

function cleanUserAgent(value) {
  return String(value || "").trim().slice(0, 240);
}

function browserMajor(version = "") {
  const major = String(version || "").split(".")[0];
  return /^\d+$/.test(major) ? major : "";
}

function parseClientInfo(userAgent = "") {
  const ua = cleanUserAgent(userAgent);
  let browser = "未知";
  let browserVersion = "";
  let match;
  const browserRules = [
    ["微信", /MicroMessenger\/(\d+(?:\.\d+)*)/],
    ["Edge", /Edg\/(\d+(?:\.\d+)*)/],
    ["Chrome", /(?:CriOS|Chrome)\/(\d+(?:\.\d+)*)/],
    ["Firefox", /(?:FxiOS|Firefox)\/(\d+(?:\.\d+)*)/],
    ["Safari", /Version\/(\d+(?:\.\d+)*).*Safari/]
  ];
  for (const [name, re] of browserRules) {
    match = ua.match(re);
    if (match) {
      browser = name;
      browserVersion = match[1] || "";
      break;
    }
  }
  let os = "未知";
  let osVersion = "";
  if ((match = ua.match(/iPhone OS ([\d_]+)/))) {
    os = "iOS";
    osVersion = match[1].replace(/_/g, ".");
  } else if ((match = ua.match(/CPU OS ([\d_]+)/))) {
    os = "iPadOS";
    osVersion = match[1].replace(/_/g, ".");
  } else if ((match = ua.match(/Android ([\d.]+)/))) {
    os = "Android";
    osVersion = match[1];
  } else if ((match = ua.match(/Mac OS X ([\d_]+)/))) {
    os = "macOS";
    osVersion = match[1].replace(/_/g, ".");
  } else if ((match = ua.match(/Windows NT ([\d.]+)/))) {
    os = "Windows";
    osVersion = match[1];
  }
  let deviceType = "desktop";
  if (/iPhone|Android.*Mobile|Mobile/i.test(ua)) deviceType = "mobile";
  else if (/iPad|Tablet|Android/i.test(ua)) deviceType = "tablet";
  return { userAgent: ua, os, osVersion, browser, browserVersion, browserMajor: browserMajor(browserVersion), deviceType };
}

function clientInfoFrom(input = {}, request = null, at = "") {
  const userAgent = cleanUserAgent(input.userAgent || request?.headers?.get?.("user-agent") || "");
  return userAgent ? { ...parseClientInfo(userAgent), updatedAt: at || new Date().toISOString() } : null;
}

function mergeClientInfo(a = null, b = null) {
  if (!a && !b) return null;
  if (!a) return { ...b };
  if (!b) return { ...a };
  return timeValue(b.updatedAt) >= timeValue(a.updatedAt) ? { ...a, ...b } : { ...b, ...a };
}

function applyUserClientInfo(user, input = {}, request = null, at = "") {
  if (!user) return false;
  const next = clientInfoFrom(input, request, at);
  if (!next) return false;
  const merged = mergeClientInfo(user.client, next);
  if (JSON.stringify(user.client || null) === JSON.stringify(merged)) return false;
  user.client = merged;
  return true;
}

function deviceIdsFor(...items) {
  const ids = [];
  const add = (value) => {
    const id = cleanDeviceId(value);
    if (id && !ids.includes(id)) ids.push(id);
  };
  for (const item of items) {
    if (!item) continue;
    if (typeof item === "string") add(item);
    else {
      add(item.deviceId);
      rows(item.deviceIds).forEach(add);
    }
  }
  return ids.slice(0, 40);
}

function normalizeUserIdentity(user, extraDeviceIds = []) {
  if (!user) return false;
  let changed = false;
  const name = displayUserName(user.name);
  if (user.name !== name) {
    user.name = name;
    changed = true;
  }
  const deviceId = cleanDeviceId(user.deviceId);
  if (user.deviceId !== deviceId) {
    user.deviceId = deviceId;
    changed = true;
  }
  const deviceIds = deviceIdsFor(user, ...extraDeviceIds);
  if (!user.deviceId && deviceIds.length) {
    user.deviceId = deviceIds[0];
    changed = true;
  }
  if (JSON.stringify(user.deviceIds || []) !== JSON.stringify(deviceIds)) {
    user.deviceIds = deviceIds;
    changed = true;
  }
  return changed;
}

function isTestUser(user) {
  return Boolean(user?.isTest) || String(user?.id || "").startsWith("test-user-");
}

function isTestSession(session) {
  return Boolean(session?.isTest) || String(session?.id || "").startsWith("test-session-");
}

function publicSound(sound = {}) {
  const { correct, answerHistory, answerTextStats, ...safe } = sound;
  const plays = Number(sound.plays || 0);
  return {
    ...safe,
    plays,
    listens: Number(sound.listens || 0),
    accuracy: plays ? Math.round(Number(sound.correct || 0) / plays * 100) : 0
  };
}

function ensureStoreShape(data) {
  const store = data && typeof data === "object" ? data : {};
  store.sounds = rows(store.sounds);
  store.users = rows(store.users);
  store.sessions = rows(store.sessions);
  store.analyticsEvents = rows(store.analyticsEvents);
  for (const sound of store.sounds) {
    if (typeof sound.listens !== "number") sound.listens = Number(sound.plays || 0);
    sound.tags = rows(sound.tags);
    sound.aliases = rows(sound.aliases);
    sound.deleted = Boolean(sound.deleted);
  }
  for (const user of store.users) {
    normalizeUserIdentity(user);
    user.answers = rows(user.answers);
    user.libraryCompletionShown = rows(user.libraryCompletionShown);
    if (user.libraryCompletionPending && typeof user.libraryCompletionPending !== "object") user.libraryCompletionPending = null;
    const playthrough = Number(user.playthrough || 1);
    user.playthrough = Number.isFinite(playthrough) && playthrough >= 1 ? Math.floor(playthrough) : 1;
  }
  for (const session of store.sessions) {
    session.soundIds = rows(session.soundIds);
    session.answers = rows(session.answers).filter((answer) => answer && !answer.removed);
    session.audioAnswers = rows(session.audioAnswers);
    session.monitor = rows(session.monitor);
    const playthrough = Number(session.playthrough || 1);
    session.playthrough = Number.isFinite(playthrough) && playthrough >= 1 ? Math.floor(playthrough) : 1;
  }
  return store;
}

async function readStore(env) {
  const data = await env.SOUND_DETECTIVE_DATA?.get("store.json", "json");
  return ensureStoreShape(data);
}

function answerHistoryId(soundId, sessionId, at, answer) {
  const raw = [soundId || "", sessionId || "", at || "", String(answer || "").trim()].join("|");
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36).slice(0, 16);
}

function answerHistoryKey(soundId, sessionId, at, answer) {
  return [soundId || "", sessionId || "", at || "", String(answer || "").trim()].join("|");
}

function answerHistoryRecord(soundId, session, answer) {
  const text = String(answer?.answer || "").trim();
  if (!text) return null;
  const at = answer?.at || session?.startedAt || new Date().toISOString();
  const sessionId = session?.id || answer?.sessionId || "";
  return {
    id: answerHistoryId(soundId, sessionId, at, text),
    sessionId,
    userId: session?.userId || answer?.userId || "",
    answer: text.slice(0, 500),
    correct: Boolean(answer?.correct),
    at
  };
}

function buildAnswerTextStats(sound = {}) {
  const stats = new Map();
  for (const item of rows(sound.answerHistory)) {
    const answer = String(item?.answer || "").trim();
    if (!answer) continue;
    const current = stats.get(answer) || { answer, count: 0, correctCount: 0, incorrectCount: 0, latestAt: "", firstAt: "" };
    current.count++;
    if (item.correct) current.correctCount++;
    else current.incorrectCount++;
    if (item.at && (!current.latestAt || timeValue(item.at) > timeValue(current.latestAt))) current.latestAt = item.at;
    if (item.at && (!current.firstAt || timeValue(item.at) < timeValue(current.firstAt))) current.firstAt = item.at;
    stats.set(answer, current);
  }
  return [...stats.values()].sort((a, b) => b.count - a.count || timeValue(b.latestAt) - timeValue(a.latestAt) || a.answer.localeCompare(b.answer, "zh-CN"));
}

function syncAnswerHistory(data) {
  const soundsById = new Map(data.sounds.map((sound) => [sound.id, sound]));
  const seenBySound = new Map();
  for (const sound of data.sounds) {
    const clean = [];
    const seen = new Set();
    for (const raw of rows(sound.answerHistory)) {
      const answer = String(raw?.answer || "").trim();
      if (!answer) continue;
      const rec = {
        id: raw.id || answerHistoryId(sound.id, raw.sessionId || "", raw.at || "", answer),
        sessionId: String(raw.sessionId || ""),
        userId: String(raw.userId || ""),
        answer: answer.slice(0, 500),
        correct: Boolean(raw.correct),
        at: raw.at || raw.createdAt || new Date(0).toISOString()
      };
      const key = answerHistoryKey(sound.id, rec.sessionId, rec.at, rec.answer);
      if (seen.has(key)) continue;
      seen.add(key);
      clean.push(rec);
    }
    sound.answerHistory = clean;
    seenBySound.set(sound.id, seen);
  }
  for (const session of data.sessions) {
    if (isTestSession(session)) continue;
    for (const answer of rows(session.answers)) {
      if (!answer || answer.removed) continue;
      const sound = soundsById.get(answer.soundId);
      if (!sound) continue;
      const rec = answerHistoryRecord(sound.id, session, answer);
      if (!rec) continue;
      const seen = seenBySound.get(sound.id) || new Set();
      const key = answerHistoryKey(sound.id, rec.sessionId, rec.at, rec.answer);
      if (seen.has(key)) continue;
      seen.add(key);
      sound.answerHistory.push(rec);
      seenBySound.set(sound.id, seen);
    }
  }
  for (const sound of data.sounds) {
    sound.answerHistory = rows(sound.answerHistory).sort((a, b) => timeValue(a.at) - timeValue(b.at));
    sound.answerTextStats = buildAnswerTextStats(sound);
    sound.plays = sound.answerHistory.length;
    sound.correct = sound.answerHistory.filter((item) => item && item.correct).length;
  }
}

function syncUserTotals(data) {
  for (const user of data.users) {
    if (isTestUser(user)) continue;
    const totals = userAnswerTotals(user, data.sessions);
    user.total = totals.total;
    user.correct = totals.correct;
    user.answers = [...new Set(data.sessions
      .filter((session) => session && session.userId === user.id && !isTestSession(session))
      .flatMap((session) => rows(session.answers))
      .filter((answer) => answer && !answer.removed)
      .map((answer) => answer.soundId)
      .filter(Boolean))];
  }
}

function normalizeStoreForWrite(data) {
  const store = ensureStoreShape(data);
  mergeDuplicateNamedUsers(store);
  syncAnswerHistory(store);
  syncUserTotals(store);
  if (store.analyticsEvents.length > ANALYTICS_MAX_EVENTS) store.analyticsEvents = store.analyticsEvents.slice(-ANALYTICS_MAX_EVENTS);
  return store;
}

function answerRevisionTime(answer = {}) {
  return timeValue(answer.updatedAt || answer.rejudgedAt || answer.repairedAt || answer.at);
}

function byIdMerge(base = [], incoming = [], mergeItem = (a, b) => ({ ...a, ...b })) {
  const out = [];
  const map = new Map();
  for (const item of rows(base)) {
    if (item && item.id) map.set(item.id, { ...item });
    else out.push(item);
  }
  for (const item of rows(incoming)) {
    if (item && item.id) map.set(item.id, map.has(item.id) ? mergeItem(map.get(item.id), item) : { ...item });
    else out.push(item);
  }
  return [...map.values(), ...out];
}

function mergeAnswers(a = [], b = []) {
  const map = new Map();
  for (const answer of [...rows(a), ...rows(b)]) {
    if (!answer) continue;
    const key = answer.soundId || [answer.at, answer.answer].join("|");
    const prev = map.get(key);
    if (!prev || answerRevisionTime(answer) >= answerRevisionTime(prev)) map.set(key, { ...prev, ...answer });
  }
  return [...map.values()].filter((answer) => !answer.removed).sort((x, y) => timeValue(x.at) - timeValue(y.at));
}

function mergeAudioAnswers(a = [], b = []) {
  const map = new Map();
  for (const answer of [...rows(a), ...rows(b)]) {
    if (!answer) continue;
    const key = answer.id || [answer.sessionId, answer.soundId, answer.createdAt, answer.audioFile].join("|");
    const prev = map.get(key);
    if (!prev || timeValue(answer.updatedAt || answer.createdAt) >= timeValue(prev.updatedAt || prev.createdAt)) map.set(key, { ...prev, ...answer });
  }
  return [...map.values()].sort((x, y) => timeValue(x.createdAt) - timeValue(y.createdAt));
}

function mergeMonitor(a = [], b = []) {
  return byIdMerge(a, b, (x, y) => ({ ...x, ...y })).sort((x, y) => timeValue(x.at) - timeValue(y.at));
}

function mergeAnswerHistory(a = [], b = []) {
  const map = new Map();
  for (const item of [...rows(a), ...rows(b)]) {
    if (!item) continue;
    const key = item.id || answerHistoryKey("", item.sessionId, item.at, item.answer);
    if (!map.has(key) || timeValue(item.at) >= timeValue(map.get(key).at)) map.set(key, { ...item });
  }
  return [...map.values()].sort((x, y) => timeValue(x.at) - timeValue(y.at));
}

function mergeSound(a = {}, b = {}) {
  return {
    ...a,
    ...b,
    plays: Math.max(Number(a.plays || 0), Number(b.plays || 0)),
    correct: Math.max(Number(a.correct || 0), Number(b.correct || 0)),
    listens: Math.max(Number(a.listens || 0), Number(b.listens || 0)),
    answerHistory: mergeAnswerHistory(a.answerHistory, b.answerHistory)
  };
}

function completionShownKey(item = {}) {
  return [Number(item.playthrough || 0) || 0, String(item.sessionId || ""), String(item.completedAt || "")].join("|");
}

function mergeCompletionShown(a = [], b = []) {
  const map = new Map();
  for (const item of [...rows(a), ...rows(b)]) {
    if (!item) continue;
    const key = completionShownKey(item);
    const prev = map.get(key);
    if (!prev || timeValue(item.shownAt || item.completedAt) >= timeValue(prev.shownAt || prev.completedAt)) map.set(key, { ...prev, ...item });
  }
  return [...map.values()].sort((x, y) => timeValue(x.completedAt || x.shownAt) - timeValue(y.completedAt || y.shownAt));
}

function mergeUser(a = {}, b = {}) {
  const deviceIds = deviceIdsFor(a, b);
  const name = cleanUserName(b.name) || cleanUserName(a.name) || "匿名玩家";
  const hasIncomingPending = Object.prototype.hasOwnProperty.call(b, "libraryCompletionPending");
  return {
    ...a,
    ...b,
    name,
    deviceId: cleanDeviceId(b.deviceId) || cleanDeviceId(a.deviceId) || deviceIds[0] || "",
    deviceIds,
    firstSeen: minIso(a.firstSeen, b.firstSeen),
    lastSeen: maxIso(a.lastSeen, b.lastSeen),
    total: Math.max(Number(a.total || 0), Number(b.total || 0)),
    correct: Math.max(Number(a.correct || 0), Number(b.correct || 0)),
    answers: [...new Set([...rows(a.answers), ...rows(b.answers)])],
    client: mergeClientInfo(a.client, b.client),
    libraryCompletionPending: hasIncomingPending ? b.libraryCompletionPending : (a.libraryCompletionPending || null),
    libraryCompletionShown: mergeCompletionShown(a.libraryCompletionShown, b.libraryCompletionShown)
  };
}

function mergeSession(a = {}, b = {}) {
  return {
    ...a,
    ...b,
    startedAt: minIso(a.startedAt, b.startedAt),
    soundIds: [...new Set([...rows(a.soundIds), ...rows(b.soundIds)])],
    answers: mergeAnswers(a.answers, b.answers),
    audioAnswers: mergeAudioAnswers(a.audioAnswers, b.audioAnswers),
    monitor: mergeMonitor(a.monitor, b.monitor)
  };
}

function mergeStoreData(base = {}, incoming = {}) {
  const merged = {
    ...base,
    ...incoming,
    sounds: byIdMerge(base.sounds, incoming.sounds, mergeSound),
    users: byIdMerge(base.users, incoming.users, mergeUser),
    sessions: byIdMerge(base.sessions, incoming.sessions, mergeSession),
    analyticsEvents: byIdMerge(base.analyticsEvents, incoming.analyticsEvents, (a, b) => ({ ...a, ...b }))
      .sort((a, b) => timeValue(a.at) - timeValue(b.at))
      .slice(-ANALYTICS_MAX_EVENTS)
  };
  return normalizeStoreForWrite(merged);
}

async function writeStore(env, data, options = {}) {
  if (!env.SOUND_DETECTIVE_DATA) throw new Error("缺少 Cloudflare KV 绑定 SOUND_DETECTIVE_DATA");
  const latest = options.replace ? null : await readStore(env);
  const next = latest ? mergeStoreData(latest, data) : normalizeStoreForWrite(data);
  await env.SOUND_DETECTIVE_DATA.put("store.json", JSON.stringify(next));
  return next;
}

function getUserById(data, id) {
  return data.users.find((user) => user.id === id) || null;
}

function getSessionById(data, id) {
  return data.sessions.find((session) => session.id === id) || null;
}

function sessionsFor(data) {
  return data.sessions || [];
}

function findRealUserByDeviceId(data, deviceId) {
  const id = cleanDeviceId(deviceId);
  if (!id) return null;
  return data.users.find((user) => !isTestUser(user) && (cleanDeviceId(user.deviceId) === id || deviceIdsFor(user).includes(id))) || null;
}

function findRealUserByName(data, name) {
  const clean = cleanUserName(name);
  if (!isMergeableUserName(clean)) return null;
  return data.users.find((user) => !isTestUser(user) && cleanUserName(user.name) === clean) || null;
}

function resolveExistingRealUser(data, query = {}) {
  const userId = String(query.userId || "").trim();
  if (userId) {
    const byId = data.users.find((user) => !isTestUser(user) && user.id === userId);
    if (byId) return byId;
  }
  const byDevice = findRealUserByDeviceId(data, query.deviceId);
  if (byDevice) return byDevice;
  return findRealUserByName(data, query.name) || null;
}

function remapUserReferences(data, userIdMap) {
  let changed = false;
  if (!userIdMap?.size) return false;
  const remap = (id) => userIdMap.get(id) || id;
  for (const session of data.sessions) {
    const next = remap(session.userId);
    if (next !== session.userId) {
      session.userId = next;
      changed = true;
    }
  }
  for (const sound of data.sounds) {
    for (const item of rows(sound.answerHistory)) {
      const next = remap(item.userId);
      if (next !== item.userId) {
        item.userId = next;
        changed = true;
      }
    }
  }
  for (const event of data.analyticsEvents) {
    const next = remap(event.userId);
    if (next !== event.userId) {
      event.userId = next;
      changed = true;
    }
  }
  return changed;
}

function mergeUserInto(data, canonical, duplicate) {
  if (!canonical || !duplicate || canonical.id === duplicate.id) return false;
  const canonicalId = canonical.id;
  const canonicalName = isMergeableUserName(canonical.name) ? cleanUserName(canonical.name) : cleanUserName(duplicate.name);
  Object.assign(canonical, mergeUser(canonical, duplicate), {
    id: canonicalId,
    name: displayUserName(canonicalName),
    deviceId: cleanDeviceId(duplicate.deviceId) || cleanDeviceId(canonical.deviceId)
  });
  normalizeUserIdentity(canonical, deviceIdsFor(canonical, duplicate));
  data.users = data.users.filter((user) => user && user.id !== duplicate.id);
  remapUserReferences(data, new Map([[duplicate.id, canonicalId]]));
  return true;
}

function mergeDuplicateNamedUsers(data) {
  let changed = false;
  const groups = new Map();
  for (const user of data.users) {
    if (!user || isTestUser(user)) continue;
    normalizeUserIdentity(user);
    if (!isMergeableUserName(user.name)) continue;
    const key = cleanUserName(user.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(user);
  }
  for (const users of groups.values()) {
    if (users.length < 2) continue;
    const sorted = [...users].sort((a, b) => timeValue(a.firstSeen) - timeValue(b.firstSeen) || timeValue(b.lastSeen) - timeValue(a.lastSeen));
    const canonical = sorted[0];
    for (const duplicate of sorted.slice(1)) if (mergeUserInto(data, canonical, duplicate)) changed = true;
  }
  return changed;
}

function upsertRealUser(data, input = {}, request = null) {
  const now = new Date().toISOString();
  const deviceId = cleanDeviceId(input.deviceId);
  const inputName = cleanUserName(input.name);
  if (!deviceId) return null;
  const byDevice = findRealUserByDeviceId(data, deviceId);
  const byName = isMergeableUserName(inputName) ? findRealUserByName(data, inputName) : null;
  let user = byName || byDevice;
  if (byName && byDevice && byName.id !== byDevice.id) {
    mergeUserInto(data, byName, byDevice);
    user = byName;
  }
  if (!user) {
    user = {
      id: uuid(),
      deviceId,
      name: displayUserName(inputName),
      firstSeen: now,
      lastSeen: now,
      total: 0,
      correct: 0,
      answers: [],
      playthrough: 1,
      libraryCompletionPending: null,
      libraryCompletionShown: [],
      deviceIds: [deviceId]
    };
    applyUserClientInfo(user, input, request, now);
    data.users.push(user);
  } else {
    if (inputName) user.name = inputName;
    user.deviceId = deviceId;
    normalizeUserIdentity(user, [deviceId]);
    applyUserClientInfo(user, input, request, now);
    user.lastSeen = now;
  }
  return user;
}

function currentPlaythrough(user) {
  const n = Number(user?.playthrough || 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function sessionPlaythrough(session) {
  const n = Number(session?.playthrough || 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function completionShownList(user) {
  return rows(user?.libraryCompletionShown);
}

function libraryCompletionWasShown(user, playthrough, sessionId = "") {
  return completionShownList(user).some((item) => Number(item?.playthrough) === Number(playthrough) || (sessionId && item?.sessionId === sessionId));
}

function activeLibraryCompletionPending(user) {
  const pending = user?.libraryCompletionPending;
  if (!pending || pending.shownAt) return null;
  if (libraryCompletionWasShown(user, pending.playthrough, pending.sessionId)) return null;
  return pending;
}

function ensureLibraryCompletionPending(user, session, progress) {
  if (!user || !session || !progress.libraryComplete || Boolean(session.libraryCompleteBefore)) return null;
  const playthrough = sessionPlaythrough(session);
  if (libraryCompletionWasShown(user, playthrough, session.id)) return null;
  const pending = activeLibraryCompletionPending(user);
  if (pending && Number(pending.playthrough) === playthrough) return pending;
  const now = new Date().toISOString();
  user.libraryCompletionPending = {
    sessionId: session.id,
    playthrough,
    completedAt: now,
    libraryAnswered: progress.libraryAnswered,
    libraryTotal: progress.libraryTotal
  };
  return user.libraryCompletionPending;
}

function markLibraryCompletionShown(user, sessionId) {
  const pending = activeLibraryCompletionPending(user);
  if (!pending || pending.sessionId !== sessionId) return { ok: false, reason: "没有待展示的全部完成页" };
  const now = new Date().toISOString();
  const playthrough = Number(pending.playthrough) || currentPlaythrough(user);
  user.libraryCompletionShown = completionShownList(user).filter((item) => item.sessionId !== sessionId && Number(item.playthrough) !== playthrough);
  user.libraryCompletionShown.push({ ...pending, shownAt: now });
  user.libraryCompletionPending = null;
  if (currentPlaythrough(user) <= playthrough) user.playthrough = playthrough + 1;
  user.lastSeen = now;
  return { ok: true, playthrough: user.playthrough };
}

function userGameSessions(userId, sessions, playthrough) {
  const scoped = playthrough !== undefined && playthrough !== null;
  return rows(sessions)
    .filter((session) => session.userId === userId && rows(session.soundIds).length && (!scoped || sessionPlaythrough(session) === Number(playthrough)))
    .sort((a, b) => timeValue(b.startedAt) - timeValue(a.startedAt));
}

function sessionAnsweredSoundIds(session) {
  return [...new Set(rows(session?.answers).filter((answer) => answer && !answer.removed).map((answer) => answer.soundId).filter(Boolean))];
}

function answeredSoundIdsForSessions(sessions = []) {
  return rows(sessions).flatMap(sessionAnsweredSoundIds);
}

function libraryProgress(user, allSounds, sessions = [], playthrough = currentPlaythrough(user)) {
  const enabled = rows(allSounds).filter((sound) => sound.enabled);
  const enabledIds = new Set(enabled.map((sound) => sound.id));
  const cycleSessions = rows(sessions).length ? userGameSessions(user.id, sessions, playthrough) : [];
  const answeredSource = cycleSessions.length ? answeredSoundIdsForSessions(cycleSessions) : (Number(playthrough) === 1 ? rows(user.answers) : []);
  const answered = [...new Set(answeredSource)].filter((id) => enabledIds.has(id));
  const total = enabled.length;
  return {
    libraryTotal: total,
    libraryAnswered: answered.length,
    libraryCompletion: total ? Math.round(answered.length / total * 100) : 0,
    libraryComplete: total > 0 && answered.length >= total,
    playthrough: Number(playthrough) || 1
  };
}

function userAnswerTotals(user, sessions = []) {
  const seen = new Set();
  let total = 0;
  let correct = 0;
  for (const session of rows(sessions)) {
    if (!session || session.userId !== user.id || isTestSession(session)) continue;
    for (const answer of rows(session.answers)) {
      if (!answer || answer.removed) continue;
      const key = [session.id, answer.soundId || "", answer.at || "", answer.answer || ""].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      total++;
      if (answer.correct) correct++;
    }
  }
  return { total, correct, score: correct };
}

function userPublic(user, allSounds, sessions = []) {
  const progress = libraryProgress(user, allSounds, sessions);
  const totals = userAnswerTotals(user, sessions);
  return {
    ...user,
    ...totals,
    answeredCount: progress.libraryAnswered,
    completion: progress.libraryCompletion,
    ...progress,
    libraryCompletionPending: Boolean(activeLibraryCompletionPending(user))
  };
}

function completedRoundsForUser(userId, sessions) {
  return rows(sessions).filter((session) => session.userId === userId && rows(session.soundIds).length > 0 && rows(session.answers).length >= rows(session.soundIds).length).length;
}

function scoreRankingRows(data) {
  return data.users
    .filter((user) => !isTestUser(user))
    .map((user) => ({ ...userPublic(user, data.sounds, data.sessions), completedRounds: completedRoundsForUser(user.id, data.sessions) }))
    .filter((user) => user.completedRounds >= 1)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.completedRounds || 0) - Number(a.completedRounds || 0) || Number(b.total || 0) - Number(a.total || 0) || timeValue(b.lastSeen) - timeValue(a.lastSeen))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function completeRankingForUsers(data, currentUser = null) {
  const currentId = currentUser?.id || "";
  const ranking = data.users
    .filter((user) => !isTestUser(user))
    .map((user) => {
      const latest = completionShownList(user)
        .filter((item) => item && (item.shownAt || item.completedAt))
        .sort((a, b) => timeValue(b.shownAt || b.completedAt) - timeValue(a.shownAt || a.completedAt))[0];
      if (!latest) return null;
      const totals = userAnswerTotals(user, data.sessions);
      return {
        id: user.id,
        name: cleanUserName(user.name) || "匿名玩家",
        total: totals.total,
        correct: totals.correct,
        score: totals.score,
        playthrough: Number(latest.playthrough || 1) || 1,
        completedAt: latest.shownAt || latest.completedAt || "",
        shownAt: latest.shownAt || "",
        current: Boolean(currentId && user.id === currentId)
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || timeValue(a.completedAt) - timeValue(b.completedAt));
  if (currentId) {
    const index = ranking.findIndex((item) => item.id === currentId);
    if (index > 0) ranking.unshift(ranking.splice(index, 1)[0]);
    if (ranking[0]?.id === currentId) ranking[0].current = true;
  }
  return ranking.slice(0, 10);
}

function sessionCompletedAt(session) {
  return rows(session.answers).map((answer) => answer?.at).filter(Boolean).sort().at(-1) || session.completedAt || session.startedAt || "";
}

function resultProfileKeyForScore(score, total = 5) {
  const value = Number(score) || 0;
  const fullScore = Math.max(1, Number(total) || 5);
  if (value >= fullScore) return "perfect";
  if (value >= 3) return "good";
  if (value >= 1) return "low";
  return "zero";
}

function resultProfileFile(profileKey) {
  return {
    zero: "马什么梅老人.jpeg",
    low: "梵高.jpeg",
    good: "蜘蛛侠.jpeg",
    perfect: "葫芦娃二娃.jpeg",
    complete: "贝多芬.png"
  }[profileKey] || "马什么梅老人.jpeg";
}

function roundHistoryForUser(userId, sessions = []) {
  return userGameSessions(userId, sessions)
    .filter((session) => rows(session.soundIds).length > 0 && rows(session.answers).length >= rows(session.soundIds).length)
    .map((session) => {
      const total = rows(session.soundIds).length;
      const correct = rows(session.answers).filter((answer) => answer && answer.correct).length;
      const profileKey = resultProfileKeyForScore(correct, total);
      return {
        sessionId: session.id,
        startedAt: session.startedAt || "",
        completedAt: sessionCompletedAt(session),
        score: correct,
        correct,
        total,
        profileKey,
        profileFile: resultProfileFile(profileKey)
      };
    })
    .sort((a, b) => timeValue(b.completedAt || b.startedAt) - timeValue(a.completedAt || a.startedAt));
}

function userHistoryPublic(data, user) {
  const sessionList = sessionsFor(data);
  const progress = libraryProgress(user, data.sounds, sessionList, currentPlaythrough(user));
  return {
    user: userPublic(user, data.sounds, sessionList),
    progress,
    rounds: roundHistoryForUser(user.id, sessionList)
  };
}

function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function soundAccuracyValue(sound) {
  return sound.plays ? sound.correct / sound.plays : 1;
}

function isLowAccuracySound(sound) {
  return Number(sound.plays || 0) >= 3 && soundAccuracyValue(sound) < 0.5;
}

function uniqueCandidateOrder(pools) {
  const seen = new Set();
  const out = [];
  for (const pool of pools) {
    for (const sound of shuffle(pool)) {
      if (!sound || seen.has(sound.id)) continue;
      seen.add(sound.id);
      out.push(sound);
    }
  }
  return out;
}

function selectRoundSounds(user, data, size = 5) {
  const enabled = rows(data.sounds).filter((sound) => sound.enabled && !sound.deleted);
  const target = Math.min(size, enabled.length);
  if (!target) return { questions: [], meta: { reason: "no_enabled_sounds" } };

  const playthrough = currentPlaythrough(user);
  const sessions = userGameSessions(user.id, data.sessions, playthrough);
  const answeredIds = new Set(answeredSoundIdsForSessions(sessions));
  const recentIds = new Set(sessions.slice(0, 3).flatMap((session) => rows(session.soundIds)));
  const unanswered = enabled.filter((sound) => !answeredIds.has(sound.id));
  const unansweredIds = new Set(unanswered.map((sound) => sound.id));
  const selected = [];
  const selectedIds = new Set();
  const add = (sound) => {
    if (!sound || selectedIds.has(sound.id) || selected.length >= target) return false;
    selected.push(sound);
    selectedIds.add(sound.id);
    return true;
  };
  const lowCount = () => selected.filter(isLowAccuracySound).length;
  const addOneLow = (pool) => add(shuffle(pool.filter((sound) => isLowAccuracySound(sound) && !selectedIds.has(sound.id)))[0]);
  const addNonLow = (pool) => {
    for (const sound of shuffle(pool.filter((item) => !isLowAccuracySound(item)))) add(sound);
  };
  const addLow = (pool) => {
    for (const sound of shuffle(pool.filter(isLowAccuracySound))) {
      if (lowCount() >= 3) break;
      add(sound);
    }
  };
  const addAny = (pool) => {
    for (const sound of shuffle(pool)) add(sound);
  };

  if (unanswered.length) {
    if (unanswered.length <= target) addAny(unanswered);
    else {
      addOneLow(unanswered);
      addNonLow(unanswered);
      addLow(unanswered);
      addAny(unanswered);
    }
    const fillPools = [
      enabled.filter((sound) => !unansweredIds.has(sound.id) && !recentIds.has(sound.id)),
      enabled.filter((sound) => !unansweredIds.has(sound.id))
    ];
    for (const pool of fillPools) {
      if (selected.length >= target) break;
      if (!lowCount() && pool.length < target - selected.length) addOneLow(pool);
      addNonLow(pool);
      addLow(pool);
      addAny(pool);
    }
  } else {
    const recentSafe = enabled.filter((sound) => !recentIds.has(sound.id));
    const primary = recentSafe.length >= target ? recentSafe : uniqueCandidateOrder([recentSafe, enabled]);
    addOneLow(primary);
    addNonLow(primary);
    addLow(primary);
    addAny(primary);
  }
  const lowSelected = selected.filter(isLowAccuracySound);
  return {
    questions: selected,
    meta: {
      strategy: unanswered.length ? "unanswered_first" : "avoid_recent_rounds",
      playthrough,
      answeredCount: [...answeredIds].filter((id) => enabled.some((sound) => sound.id === id)).length,
      unansweredBefore: unanswered.length,
      recentAvoidedCount: [...recentIds].filter((id) => enabled.some((sound) => sound.id === id) && !selectedIds.has(id)).length,
      lowAccuracySelected: lowSelected.map((sound) => sound.id),
      lowAccuracyCount: lowSelected.length
    }
  };
}

function normalize(text = "") {
  return String(text || "").toLowerCase()
    .replace(/[門]/g, "门").replace(/[鈴]/g, "铃").replace(/[進]/g, "进").replace(/[鐵]/g, "铁")
    .replace(/[寫]/g, "写").replace(/[筆]/g, "笔").replace(/[廁厠]/g, "厕").replace(/[馬]/g, "马")
    .replace(/[滿]/g, "满").replace(/[沖]/g, "冲").replace(/[劃]/g, "划").replace(/[廳]/g, "厅")
    .replace(/沫桶|满桶/g, "马桶").replace(/充水/g, "冲水").replace(/塑料代/g, "塑料袋")
    .replace(/钢比|刚笔/g, "钢笔").replace(/建刀/g, "剪刀").replace(/划柴|画火柴/g, "划火柴")
    .replace(/[\s，。！？、,.!?；;：:“”"'‘’（）()【】\[\]-]/g, "");
}

function collapseRepeatedText(text = "") {
  let out = text;
  for (let size = 2; size <= 8; size++) {
    const re = new RegExp(`(.{${size}})\\1+`, "g");
    out = out.replace(re, "$1");
  }
  return out;
}

function semanticText(text = "") {
  let out = normalize(text);
  for (const pattern of FILLER_PATTERNS.map(normalize).filter(Boolean)) out = out.replaceAll(pattern, "");
  return collapseRepeatedText(out);
}

function isNegatedAt(text, index) {
  const prefix = text.slice(Math.max(0, index - 5), index);
  return /不是|不像|没有|沒|不对|不太像|别是/.test(prefix);
}

function affirmativeText(text) {
  return text
    .replace(/不是(.+?)是/g, "")
    .replace(/不像(.+?)是/g, "")
    .replace(/不太像(.+?)是/g, "")
    .replace(/没有(.+?)是/g, "")
    .replace(/不是.+$/, "")
    .replace(/不像.+$/, "")
    .replace(/不太像.+$/, "")
    .replace(/没有.+$/, "");
}

function allSemanticTerms(sound) {
  return [...new Set([sound.name, ...rows(sound.tags), ...rows(sound.aliases), ...rows(SEMANTIC_INTENTS[sound.id])]
    .map(semanticText)
    .filter(Boolean))];
}

function uniqueTerms(sound) {
  return allSemanticTerms(sound).filter((term) => term.length >= 2);
}

function uniqueExactTerms(sound) {
  return allSemanticTerms(sound);
}

function charOverlap(a, b) {
  const aa = [...new Set([...a])];
  const bb = new Set([...b]);
  return aa.length ? aa.filter((c) => bb.has(c)).length / aa.length : 0;
}

function semanticMatch(sound, answer) {
  const answerText = affirmativeText(semanticText(answer));
  const exactTerms = uniqueExactTerms(sound);
  const terms = uniqueTerms(sound).sort((a, b) => b.length - a.length);
  if (!answerText) return { ok: false, score: 0, type: "empty", matched: "" };
  for (const term of exactTerms.filter((item) => item.length === 1)) {
    if (answerText === term && !isNegatedAt(answerText, 0)) return { ok: true, score: 1, type: "single_term_exact", matched: term };
  }
  for (const term of terms) {
    const at = answerText.indexOf(term);
    if (at >= 0 && !isNegatedAt(answerText, at)) return { ok: true, score: 1, type: "term_contains", matched: term };
    const reverse = term.indexOf(answerText);
    if (answerText.length >= 2 && reverse >= 0 && !isNegatedAt(answerText, 0)) return { ok: true, score: 0.92, type: "answer_contains", matched: term };
  }
  let best = { score: 0, term: "" };
  for (const term of terms.filter((item) => item.length >= 3)) {
    const at = answerText.indexOf(term);
    if (at >= 0 && isNegatedAt(answerText, at)) continue;
    const score = charOverlap(term, answerText);
    if (score > best.score) best = { score, term };
  }
  const ok = best.score >= 0.72 && answerText.length >= 2;
  return { ok, score: Number(best.score.toFixed(2)), type: ok ? "semantic_overlap" : "no_match", matched: best.term };
}

function judgeAnswer(sound, answer) {
  const match = semanticMatch(sound, answer);
  return {
    correct: match.ok,
    message: match.ok ? "答对了！你听得很准。" : `差一点，正确答案是「${sound.name}」`,
    match
  };
}

function cleanDetails(details = {}) {
  return Object.fromEntries(Object.entries(details || {}).map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 200) : value]));
}

function appendMonitor(session, source, type, message, details = {}) {
  session.monitor = rows(session.monitor);
  const event = {
    id: uuid(),
    at: new Date().toISOString(),
    source,
    type,
    message,
    details: cleanDetails(details)
  };
  session.monitor.push(event);
  if (session.monitor.length > 200) session.monitor = session.monitor.slice(-200);
  return event;
}

function recordJudgedAnswer(data, session, sound, answer, options = {}) {
  const user = session && getUserById(data, session.userId);
  if (!session || !user || !sound) return { ok: false, error: "题目不存在" };
  if (rows(session.answers).some((item) => item && !item.removed && item.soundId === sound.id)) return { ok: false, duplicate: true, user };
  const text = String(answer || "").trim().slice(0, 500);
  const result = text ? judgeAnswer(sound, text) : { correct: false, message: "没有识别到文字", match: { ok: false, score: 0, type: "empty", matched: "" } };
  const answeredAt = options.at || new Date().toISOString();
  const answerRecord = {
    soundId: sound.id,
    answer: text,
    correct: result.correct,
    at: answeredAt,
    inputMode: options.inputMode || "text"
  };
  if (options.provider) answerRecord.provider = String(options.provider).slice(0, 80);
  if (options.asrProvider) answerRecord.asrProvider = String(options.asrProvider).slice(0, 80);
  if (Number(options.asrDurationMs || 0) > 0) answerRecord.asrDurationMs = Number(options.asrDurationMs || 0);
  if (options.audioAnswerId) answerRecord.audioAnswerId = String(options.audioAnswerId);
  if (options.transcriptionStatus) answerRecord.transcriptionStatus = String(options.transcriptionStatus);
  if (options.transcriptionReason) answerRecord.transcriptionReason = String(options.transcriptionReason).slice(0, 200);
  if (options.recognized === false) answerRecord.recognized = false;
  session.answers.push(answerRecord);
  if (text) appendSoundAnswerHistory(sound, session, answerRecord);
  if (text) {
    sound.plays = Number(sound.plays || 0) + 1;
    if (result.correct) sound.correct = Number(sound.correct || 0) + 1;
  }
  user.total = Number(user.total || 0) + 1;
  if (result.correct) user.correct = Number(user.correct || 0) + 1;
  user.answers = [...new Set([...rows(user.answers), sound.id])];
  user.lastSeen = new Date().toISOString();
  return { ok: true, result, answerRecord, user };
}

function appendSoundAnswerHistory(sound, session, answer) {
  const rec = answerHistoryRecord(sound.id, session, answer);
  if (!rec) return false;
  sound.answerHistory = rows(sound.answerHistory);
  const key = answerHistoryKey(sound.id, rec.sessionId, rec.at, rec.answer);
  if (sound.answerHistory.some((item) => answerHistoryKey(sound.id, item.sessionId, item.at, item.answer) === key)) return false;
  sound.answerHistory.push(rec);
  sound.answerTextStats = buildAnswerTextStats(sound);
  return true;
}

function answerStatusLabel(answer) {
  if (!answer) return "未答";
  if (answer.recognized === false) return "未识别";
  if (answer.transcriptionStatus && answer.transcriptionStatus !== "ok") return "识别失败";
  return answer.correct ? "答对" : "答错";
}

function answerReviewRecord(soundId, sound, answer, index) {
  const recognized = answer ? answer.recognized !== false && Boolean(answer.answer) : false;
  return {
    index,
    answer: String(answer?.answer || "").slice(0, 80),
    correct: Boolean(answer?.correct),
    answered: Boolean(answer),
    recognized,
    statusText: answer ? (recognized ? "" : "未识别到文字") : "",
    soundId,
    soundName: sound?.name || "未知题目",
    provider: answer?.provider || answer?.asrProvider || "",
    asrDurationMs: Number(answer?.asrDurationMs || 0) || 0,
    statusLabel: answerStatusLabel(answer)
  };
}

function answerReview(data, session) {
  const soundsById = new Map(data.sounds.map((sound) => [sound.id, sound]));
  const answersBySound = new Map(rows(session.answers).filter((answer) => answer && answer.soundId).map((answer) => [answer.soundId, answer]));
  return rows(session.soundIds).map((soundId, index) => answerReviewRecord(soundId, soundsById.get(soundId), answersBySound.get(soundId) || null, index + 1));
}

function analyticsEvent(input = {}, request) {
  const details = input.details && typeof input.details === "object" ? input.details : {};
  const userAgent = cleanUserAgent(input.userAgent || request.headers.get("user-agent") || "");
  return {
    id: uuid(),
    at: new Date().toISOString(),
    clientAt: String(input.at || "").slice(0, 40),
    type: String(input.type || "event").slice(0, 80),
    deviceId: String(input.deviceId || "").slice(0, 80),
    userId: String(input.userId || "").slice(0, 80),
    sessionId: String(input.sessionId || "").slice(0, 80),
    pageViewId: String(input.pageViewId || "").slice(0, 80),
    page: String(input.page || "").slice(0, 80),
    path: String(input.path || "").slice(0, 160),
    appVersion: String(input.appVersion || "").slice(0, 40),
    userAgent,
    client: userAgent ? parseClientInfo(userAgent) : null,
    viewport: input.viewport && typeof input.viewport === "object" ? {
      width: Number(input.viewport.width || 0),
      height: Number(input.viewport.height || 0)
    } : null,
    durationMs: Number(input.durationMs || details.durationMs || 0) || 0,
    details: cleanDetails(details)
  };
}

function appendAnalyticsEvent(data, input, request) {
  const event = analyticsEvent(input, request);
  data.analyticsEvents.push(event);
  if (data.analyticsEvents.length > ANALYTICS_MAX_EVENTS) data.analyticsEvents = data.analyticsEvents.slice(-ANALYTICS_MAX_EVENTS);
  const user = (event.userId && getUserById(data, event.userId)) || findRealUserByDeviceId(data, event.deviceId);
  if (user && !isTestUser(user)) applyUserClientInfo(user, { userAgent: event.userAgent }, request, event.at);
  return event;
}

function isLightTestRequest(request, url, input = {}, env = {}) {
  if (!truthy(env.DX100_ALLOW_CLOUD_TEST_MODE)) return false;
  const ua = request.headers.get("user-agent") || "";
  const deviceId = String(input.deviceId || "");
  const name = String(input.name || "");
  return Boolean(
    truthy(url.searchParams.get("test")) ||
    truthy(url.searchParams.get("codexTest")) ||
    truthy(request.headers.get("x-codex-test")) ||
    truthy(request.headers.get("x-voice-game-test")) ||
    truthy(input.testMode) ||
    truthy(input.isTest) ||
    truthy(input.__test) ||
    /^codex[-_]|^test[-_]|^playwright[-_]/i.test(deviceId) ||
    /codex|playwright|smoke|自动化测试|测试用户/i.test(name) ||
    /HeadlessChrome|Playwright|Codex/i.test(ua)
  );
}

async function readJsonBody(request) {
  const text = await request.text();
  return text ? JSON.parse(text) : {};
}

async function handleUsersPost(request, env, url) {
  const input = await readJsonBody(request);
  input.userAgent ||= request.headers.get("user-agent") || "";
  const data = await readStore(env);
  if (isLightTestRequest(request, url, input, env)) input.name ||= "Codex 测试用户";
  const user = upsertRealUser(data, input, request);
  if (!user) return json({ error: "缺少设备标识" }, 400);
  const saved = await writeStore(env, data);
  const savedUser = getUserById(saved, user.id) || user;
  return json(userPublic(savedUser, saved.sounds, sessionsFor(saved)));
}

async function handleGameStart(request, env, url) {
  const input = await readJsonBody(request);
  input.userAgent ||= request.headers.get("user-agent") || "";
  const data = await readStore(env);
  let user = getUserById(data, String(input.userId || ""));
  if (!user && input.deviceId) user = upsertRealUser(data, input, request);
  if (!user) return json({ error: "用户不存在" }, 404);
  applyUserClientInfo(user, input, request);

  const sessionList = sessionsFor(data);
  const pending = activeLibraryCompletionPending(user);
  if (pending && sessionList.some((session) => session.id === pending.sessionId)) {
    const marked = markLibraryCompletionShown(user, pending.sessionId);
    const pendingSession = getSessionById(data, pending.sessionId);
    if (pendingSession) {
      appendMonitor(pendingSession, "server", "library_completion_dismissed_on_home_start", "用户从首页开始新挑战，旧完成页不再直接展示", {
        shownSessionId: pending.sessionId,
        nextPlaythrough: marked.playthrough || currentPlaythrough(user)
      });
    }
  } else if (pending) {
    user.libraryCompletionPending = null;
  }

  const playthrough = currentPlaythrough(user);
  const progress = libraryProgress(user, data.sounds, sessionList, playthrough);
  const picked = selectRoundSounds(user, { ...data, sessions: sessionList }, 5);
  const questions = picked.questions;
  for (const sound of questions) sound.listens = Number(sound.listens || 0) + 1;
  const health = await soundAsrHealth.check(env, soundAsrHotwords(data));
  const providers = healthyProviderIds(health, input.availableAsrProviders);
  if (!providers.length) return json({ error:"当前没有可用的实时语音识别服务", asrHealth:health }, 503);
  const asrProvider = providers[Math.floor(Math.random() * providers.length)];
  const session = {
    id: uuid(),
    userId: user.id,
    soundIds: questions.map((sound) => sound.id),
    answers: [],
    audioAnswers: [],
    monitor: [],
    startedAt: new Date().toISOString(),
    playthrough,
    libraryCompleteBefore: progress.libraryComplete,
    libraryAnsweredBefore: progress.libraryAnswered,
    libraryTotal: progress.libraryTotal,
    recommendation: picked.meta,
    asrProvider,
    asrProviderLabel: ASR_PROVIDER_LABELS[asrProvider] || "实时语音识别未配置"
  };
  appendMonitor(session, "server", "session_started", "后端已创建本轮答题", {
    questionCount: questions.length,
    soundIds: questions.map((sound) => sound.id),
    playthrough,
    libraryCompleteBefore: progress.libraryComplete,
    libraryAnsweredBefore: progress.libraryAnswered,
    libraryTotal: progress.libraryTotal,
    recommendation: picked.meta,
    asrProvider,
    asrProviderLabel: session.asrProviderLabel
  });
  data.sessions.push(session);
  await writeStore(env, data);
  return json({ sessionId: session.id, questions: questions.map(publicSound), playthrough, asrProvider, asrProviderLabel: session.asrProviderLabel });
}

async function handleAnswerPost(request, env) {
  const input = await readJsonBody(request);
  const data = await readStore(env);
  const session = getSessionById(data, input.sessionId);
  const user = session && getUserById(data, session.userId);
  const sound = session && data.sounds.find((item) => item.id === input.soundId);
  if (!session || !user || !sound || !rows(session.soundIds).includes(sound.id)) return json({ error: "题目不存在" }, 404);
  const existingAnswer = rows(session.answers).find((answer) => answer && !answer.removed && answer.soundId === sound.id);
  if (existingAnswer) {
    appendMonitor(session, "server", "answer_duplicate_accepted", "本题已记录，后端按幂等成功返回", { soundId: input.soundId });
    await writeStore(env, data);
    return json({ ok: true, duplicate: true, answer: existingAnswer.answer || "" });
  }
  appendMonitor(session, "server", "answer_received", "后端已收到文字答案", {
    soundId: sound.id,
    answer: String(input.answer || "").slice(0, 80),
    answerLength: String(input.answer || "").length
  });
  const recorded = recordJudgedAnswer(data, session, sound, input.answer, { inputMode: input.inputMode || "text" });
  if (!recorded.ok && recorded.duplicate) return json({ ok: true, duplicate: true, answer: String(input.answer || "") });
  if (!recorded.ok) return json({ error: recorded.error || "题目不存在" }, 404);
  appendMonitor(session, "server", "judge_completed", "后端已完成判题", { soundId: sound.id, recorded: true });
  await writeStore(env, data);
  return json({ ok: true, answer: recorded.answerRecord.answer });
}

async function handleAnswerTextPost(request, env) {
  const input = await readJsonBody(request);
  const data = await readStore(env);
  const session = getSessionById(data, input.sessionId);
  const user = session && getUserById(data, session.userId);
  const soundId = String(input.soundId || input.questionId || "");
  const sound = session && data.sounds.find((item) => item.id === soundId);
  if (!session || !user || !sound || !rows(session.soundIds).includes(sound.id)) return json({ error: "题目不存在" }, 404);
  const transcript = String(input.transcript || input.answer || "").trim();
  if (!transcript) return json({ error: "没有识别到文字，请再试一次" }, 422);
  const existingAnswer = rows(session.answers).find((answer) => answer && !answer.removed && answer.soundId === sound.id);
  if (existingAnswer) {
    appendMonitor(session, "server", "answer_duplicate_accepted", "本题已记录，后端按幂等成功返回", { soundId: sound.id, inputMode: "voice" });
    await writeStore(env, data);
    return json({
      ok: true,
      duplicate: true,
      transcript: existingAnswer.answer || "",
      answer: existingAnswer.answer || "",
      correct: Boolean(existingAnswer.correct),
      provider: existingAnswer.provider || session.asrProvider || "",
      asrDurationMs: existingAnswer.asrDurationMs || 0
    });
  }
  const provider = String(session.asrProvider || input.provider || "").slice(0, 80);
  const asrDurationMs = Number(input.asrDurationMs || 0);
  appendMonitor(session, "server", "speech_transcribed", "实时语音识别已返回文字", {
    soundId: sound.id,
    transcript: transcript.slice(0, 120),
    provider,
    durationMs: asrDurationMs
  });
  const recorded = recordJudgedAnswer(data, session, sound, transcript, {
    inputMode: "voice",
    provider,
    asrProvider: provider,
    asrDurationMs,
    transcriptionStatus: "ok"
  });
  if (!recorded.ok && recorded.duplicate) return json({ ok: true, duplicate: true, transcript, answer: transcript });
  if (!recorded.ok) return json({ error: recorded.error || "题目不存在" }, 404);
  appendMonitor(session, "server", "judge_completed", "后端已完成实时语音判题", {
    soundId: sound.id,
    recorded: true,
    correct: Boolean(recorded.result?.correct),
    provider
  });
  await writeStore(env, data);
  return json({
    ok: true,
    transcript: recorded.answerRecord.answer,
    answer: recorded.answerRecord.answer,
    correct: Boolean(recorded.answerRecord.correct),
    provider,
    asrDurationMs
  });
}

async function handleGameResult(env, sessionId) {
  const data = await readStore(env);
  const session = getSessionById(data, sessionId);
  if (!session) return json({ error: "记录不存在" }, 404);
  const user = getUserById(data, session.userId);
  if (!user) return json({ error: "用户不存在" }, 404);
  const correct = rows(session.answers).filter((answer) => answer && answer.correct).length;
  const total = rows(session.soundIds).length;
  const score = correct;
  const sessionList = sessionsFor(data);
  const progress = libraryProgress(user, data.sounds, sessionList, sessionPlaythrough(session));
  const pending = ensureLibraryCompletionPending(user, session, progress);
  const libraryCompletedThisRound = Boolean(pending && pending.sessionId === session.id);
  const ranking = scoreRankingRows(data);
  const currentRank = ranking.find((item) => item.id === user.id) || null;
  appendMonitor(session, "server", "result_requested", "后端已返回结算结果", {
    correct,
    total,
    score,
    playthrough: sessionPlaythrough(session),
    libraryAnswered: progress.libraryAnswered,
    libraryTotal: progress.libraryTotal,
    libraryCompletedThisRound,
    libraryCompletionPending: Boolean(pending),
    pendingRecognitions: 0
  });
  await writeStore(env, data);
  return json({
    correct,
    total,
    score,
    answerReview: answerReview(data, session),
    ranking: ranking.slice(0, 10),
    completeRanking: completeRankingForUsers(data, user),
    user: currentRank || userPublic(user, data.sounds, sessionList),
    finishedRank: currentRank?.rank || 0,
    ...progress,
    libraryCompletedThisRound,
    libraryCompletionPending: Boolean(pending),
    completionSessionId: pending?.sessionId || "",
    pendingRecognitions: 0
  });
}

async function handleCompleteShown(request, env) {
  const input = await readJsonBody(request);
  const data = await readStore(env);
  const session = getSessionById(data, input.sessionId);
  const user = (session && getUserById(data, session.userId)) || getUserById(data, input.userId);
  if (!user) return json({ error: "用户不存在" }, 404);
  const playthrough = session ? sessionPlaythrough(session) : Number(input.playthrough || currentPlaythrough(user));
  const sessionList = sessionsFor(data);
  if (libraryCompletionWasShown(user, playthrough, input.sessionId)) {
    return json({ ok: true, playthrough: currentPlaythrough(user), user: userPublic(user, data.sounds, sessionList), completeRanking: completeRankingForUsers(data, user) });
  }
  const marked = markLibraryCompletionShown(user, input.sessionId);
  if (!marked.ok) return json({ error: marked.reason }, 409);
  if (session) appendMonitor(session, "server", "library_completion_shown", "用户已查看全部完成页，进入下一周目", { shownSessionId: input.sessionId, nextPlaythrough: marked.playthrough });
  const saved = await writeStore(env, data);
  const savedUser = getUserById(saved, user.id) || user;
  return json({ ok: true, playthrough: marked.playthrough, user: userPublic(savedUser, saved.sounds, sessionsFor(saved)), completeRanking: completeRankingForUsers(saved, savedUser) });
}

async function handleMonitorGet(env, sessionId) {
  const data = await readStore(env);
  const session = getSessionById(data, sessionId);
  if (!session) return json({ error: "监控记录不存在" }, 404);
  return json({
    sessionId: session.id,
    startedAt: session.startedAt || "",
    answeredCount: rows(session.answers).length,
    total: rows(session.soundIds).length,
    events: rows(session.monitor)
  });
}

async function handleMonitorEvent(request, env) {
  const input = await readJsonBody(request);
  const data = await readStore(env);
  const session = getSessionById(data, input.sessionId);
  if (!session) return json({ error: "监控记录不存在" }, 404);
  const event = appendMonitor(
    session,
    "client",
    String(input.type || "client_event").slice(0, 60),
    String(input.message || "客户端事件").slice(0, 120),
    input.details || {}
  );
  await writeStore(env, data);
  return json({ ok: true, event });
}

async function handleAnalyticsEvent(request, env) {
  const input = await readJsonBody(request);
  const data = await readStore(env);
  if (isLightTestRequest(request, new URL(request.url), input, env)) return json({ ok: true, skipped: true, testMode: true });
  const event = appendAnalyticsEvent(data, input, request);
  await writeStore(env, data);
  return json({ ok: true, id: event.id });
}

function wsOpen(socket) {
  return socket && socket.readyState === 1;
}

function wsSendJson(socket, payload) {
  if (wsOpen(socket)) socket.send(JSON.stringify(payload));
}

function closeSocket(socket, code = 1000, reason = "") {
  try {
    if (socket && socket.readyState < 2) socket.close(code, reason);
  } catch {}
}

function textFromWsData(data) {
  if (typeof data === "string") return data;
  return new TextDecoder().decode(data);
}

async function handleAsrWebSocket(request, env) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "需要 WebSocket 连接" }, 426);
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  runAsrProxySocket(server, env).catch((error) => {
    console.error("asr-websocket", error);
    wsSendJson(server, { type: "ASR_ERROR", message: error?.message || "实时识别连接失败" });
    closeSocket(server, 1011, "ASR proxy error");
  });
  return new Response(null, { status: 101, webSocket: client });
}

async function runAsrProxySocket(client, env) {
  let upstream = null;
  let provider = "";
  let started = false;
  let finishing = false;
  let endedSent = false;
  let finishTimer = 0;
  let doubaoSequence = 1;
  let doubaoPending = null;
  let lastPartial = "";
  let lastFinal = "";

  const fail = (message) => {
    wsSendJson(client, { type: "ASR_ERROR", provider, message });
    closeSocket(upstream, 1011, "ASR upstream error");
    closeSocket(client, 1011, "ASR proxy error");
  };
  const ready = () => {
    if (started) return;
    started = true;
    wsSendJson(client, { type: "ASR_READY", provider, providerLabel: ASR_PROVIDER_LABELS[provider], sampleRate: 16000, frameBytes: 5120 });
  };
  const partial = (text) => {
    const value = String(text || "").trim();
    if (!value || value === lastPartial || value === lastFinal) return;
    lastPartial = value;
    wsSendJson(client, { type: "ASR_PARTIAL", provider, text: value });
  };
  const final = (text) => {
    const value = String(text || "").trim();
    if (!value || value === lastFinal) return;
    lastFinal = value;
    lastPartial = "";
    wsSendJson(client, { type: "ASR_FINAL", provider, text: value });
  };
  const ended = () => {
    if (endedSent) return;
    endedSent = true;
    clearTimeout(finishTimer);
    wsSendJson(client, { type: "ASR_ENDED", provider });
    closeSocket(client, 1000, "ASR finished");
  };
  const finishProvider = () => {
    if (!wsOpen(upstream)) return;
    if (provider === "baidu-realtime") upstream.send(JSON.stringify({ type: "FINISH" }));
    else if (provider === "tencent-realtime-v2") upstream.send(JSON.stringify({ type: "end" }));
    else if (provider === "doubao-streaming-v2") {
      doubaoSequence += 1;
      upstream.send(doubaoRequest(2, doubaoSequence, doubaoPending || Buffer.alloc(0), true, false));
      doubaoPending = null;
    }
  };
  const sendAudioFrame = async (data) => {
    if (!started || finishing || !wsOpen(upstream)) return;
    const frame = await arrayBufferFromWsData(data);
    if (frame.byteLength > 6400) return fail("音频分片过大");
    if (provider === "doubao-streaming-v2") {
      if (doubaoPending) {
        doubaoSequence += 1;
        upstream.send(doubaoRequest(2, doubaoSequence, doubaoPending, false, false));
      }
      doubaoPending = Buffer.from(frame);
      return;
    }
    upstream.send(frame);
  };
  const connectUpstream = async (payload) => {
    const data = await readStore(env);
    const session = getSessionById(data, String(payload.sessionId || ""));
    const soundId = String(payload.soundId || payload.questionId || "");
    const sound = session && data.sounds.find((item) => item.id === soundId);
    if (!session || !sound || !rows(session.soundIds).includes(sound.id) || rows(session.answers).some((item) => item.soundId === sound.id)) {
      fail("题目不存在或已经作答");
      return;
    }
    provider = session.asrProvider || randomAsrProvider(env) || "baidu-realtime";
    const config = realtimeProviderConfigs(env)[provider];
    if (!config?.enabled) {
      fail(`${ASR_PROVIDER_LABELS[provider] || "语音识别"}未配置`);
      return;
    }
    if (provider === "baidu-realtime") {
      const endpoint = new URL(config.endpoint);
      endpoint.searchParams.set("sn", uuid());
      upstream = new WebSocket(endpoint.toString());
      upstream.addEventListener("open", () => {
        const startData = {
          appid: Number(config.appId),
          appkey: config.appKey,
          dev_pid: config.devPid,
          cuid: config.cuid,
          format: config.format,
          sample: config.sampleRate
        };
        if (config.lmId) startData.lm_id = config.lmId;
        upstream.send(JSON.stringify({ type: "START", data: startData }));
        ready();
      });
      upstream.addEventListener("message", (event) => {
        let result;
        try { result = JSON.parse(textFromWsData(event.data)); } catch { return; }
        if (Number(result.err_no || 0) || /ERROR|FAIL/i.test(String(result.type || ""))) {
          return fail(result.err_msg || result.desc || `百度识别错误 ${result.err_no || result.error_code || result.type}`);
        }
        if (result.type === "MID_TEXT") partial(result.result);
        if (result.type === "FIN_TEXT") {
          final(result.result);
        }
      });
    } else if (provider === "tencent-realtime-v2") {
      const url = await tencentRealtimeUrl(env, config, soundAsrHotwords(data));
      upstream = new WebSocket(url);
      upstream.addEventListener("message", (event) => {
        let result;
        try { result = JSON.parse(textFromWsData(event.data)); } catch { return; }
        if (Number(result.code) !== 0) return fail(result.message || `腾讯识别错误 ${result.code}`);
        ready();
        const list = result.sentences?.sentence_list || [];
        const text = list.map((item) => item.sentence || "").join("").trim();
        if (list.some((item) => Number(item.sentence_type) === 1)) final(text);
        else partial(text);
        if (Number(result.final) === 1) {
          if (text) final(text);
          ended();
        }
      });
    } else if (provider === "doubao-streaming-v2") {
      const hotwords = soundAsrHotwords(data);
      upstream = await doubaoRealtimeSocket(config);
      upstream.addEventListener("message", (event) => {
        arrayBufferFromWsData(event.data).then((buffer) => {
          let result;
          try { result = parseDoubaoResponse(buffer); } catch (error) { return fail(`豆包响应解析失败：${error.message}`); }
          if (result.code) return fail(result.body?.message || `豆包识别错误 ${result.code}`);
          ready();
          const body = result.body?.result || {};
          const text = String(body.text || "").trim();
          const utterances = Array.isArray(body.utterances) ? body.utterances : [];
          if (result.last || utterances.some((item) => item.definite === true)) final(text);
          else partial(text);
          if (result.last) ended();
        }).catch((error) => fail(`豆包响应读取失败：${error.message || error}`));
      });
      upstream.send(doubaoRequest(1, doubaoSequence, doubaoStartPayload(config, session.userId, hotwords), false, true));
    } else {
      fail("Cloudflare 轻量链路暂未启用该 ASR 服务");
      return;
    }
    upstream.addEventListener("error", () => fail(`${ASR_PROVIDER_LABELS[provider]}连接失败`));
    upstream.addEventListener("close", () => {
      if (wsOpen(client)) ended();
    });
  };

  client.addEventListener("message", (event) => {
    const isBinary = typeof event.data !== "string";
    if (isBinary) {
      sendAudioFrame(event.data).catch(() => fail("音频分片发送失败"));
      return;
    }
    let payload;
    try { payload = JSON.parse(event.data); } catch { return fail("实时识别控制消息格式错误"); }
    if (payload.type === "START") {
      if (started || upstream) return fail("实时识别已经开始");
      connectUpstream(payload).catch((error) => fail(error?.message || "实时识别启动失败"));
      return;
    }
    if (payload.type === "FINISH" && started && !finishing) {
      finishing = true;
      finishProvider();
      finishTimer = setTimeout(() => closeSocket(upstream, 1000, "ASR finish timeout"), provider === "doubao-streaming-v2" ? 6500 : 4500);
      return;
    }
    if (payload.type === "CANCEL") {
      if (provider === "baidu-realtime" && wsOpen(upstream)) upstream.send(JSON.stringify({ type: "CANCEL" }));
      closeSocket(upstream, 1000, "ASR cancelled");
      closeSocket(client, 1000, "ASR cancelled");
    }
  });
  client.addEventListener("close", () => {
    clearTimeout(finishTimer);
    closeSocket(upstream, 1000, "client closed");
  });
  client.addEventListener("error", () => {
    clearTimeout(finishTimer);
    closeSocket(upstream, 1000, "client error");
  });
}

async function handleAsrConfig(env) {
  const data = await readStore(env);
  const configs = realtimeProviderConfigs(env);
  const hotwords = soundAsrHotwords(data);
  const providers = Object.keys(ASR_PROVIDER_LABELS).map((provider) => ({
    provider,
    label: ASR_PROVIDER_LABELS[provider],
    enabled: Boolean(configs[provider]?.enabled),
    configured: Boolean(configs[provider]?.configured || configs[provider]?.enabled),
    sampleRate: 16000,
    frameBytes: 5120,
    serverVad: provider !== "baidu-realtime",
    reason: configs[provider]?.enabled ? "" : configs[provider]?.disabledReason || "Cloudflare Pages 生产环境缺少该 ASR 服务密钥"
  }));
  const enabled = providers.filter((item) => item.enabled);
  return json({
    realtime: { enabled: Boolean(enabled.length), providers, sampleRate: 16000, frameBytes: 5120 },
    hotwords,
    hotwordCount: hotwords.length,
    status: enabled.length ? "ready" : "missing",
    missing: providers.filter((item) => !item.enabled).map((item) => item.provider)
  });
}

export async function handleLightGameApi(request, env, pathname) {
  if (!env.SOUND_DETECTIVE_DATA) return null;
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && pathname === "/api/asr/config") return handleAsrConfig(env);
    if (request.method === "GET" && pathname === "/api/asr/health") {
      const data = await readStore(env);
      return json(await soundAsrHealth.check(env, soundAsrHotwords(data), url.searchParams.get("force") === "1"));
    }
    if (pathname === "/ws/asr") return handleAsrWebSocket(request, env);
    if (request.method === "GET" && pathname === "/api/sounds") {
      const data = await readStore(env);
      return json(data.sounds.map(publicSound));
    }
    if (request.method === "GET" && pathname === "/api/rankings") {
      const data = await readStore(env);
      const query = Object.fromEntries(url.searchParams.entries());
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 10) || 10));
      const currentUser = resolveExistingRealUser(data, query);
      const ranking = scoreRankingRows(data);
      const currentRank = currentUser ? ranking.find((item) => item.id === currentUser.id) : null;
      return json({
        ranking: ranking.slice(0, limit),
        user: currentRank || (currentUser ? userPublic(currentUser, data.sounds, sessionsFor(data)) : null)
      });
    }
    if (request.method === "GET" && pathname === "/api/users/me") {
      const data = await readStore(env);
      const user = resolveExistingRealUser(data, Object.fromEntries(url.searchParams.entries()));
      if (!user) return json({ error: "用户不存在" }, 404);
      return json(userPublic(user, data.sounds, sessionsFor(data)));
    }
    if (request.method === "GET" && pathname === "/api/users/history") {
      const data = await readStore(env);
      const user = resolveExistingRealUser(data, Object.fromEntries(url.searchParams.entries()));
      if (!user) {
        return json({
          error: "用户不存在",
          progress: { libraryTotal: data.sounds.filter((sound) => sound.enabled && !sound.deleted).length, libraryAnswered: 0, libraryCompletion: 0 },
          rounds: []
        }, 404);
      }
      return json(userHistoryPublic(data, user));
    }
    if (request.method === "POST" && pathname === "/api/users") return handleUsersPost(request, env, url);
    if (request.method === "POST" && pathname === "/api/game/start") return handleGameStart(request, env, url);
    if (request.method === "POST" && pathname === "/api/game/answer-text") return handleAnswerTextPost(request, env);
    if (request.method === "POST" && pathname === "/api/game/answer") return handleAnswerPost(request, env);
    if (request.method === "POST" && pathname === "/api/game/complete-shown") return handleCompleteShown(request, env);
    if (request.method === "POST" && pathname === "/api/game/monitor-event") return handleMonitorEvent(request, env);
    if (request.method === "POST" && pathname === "/api/analytics/event") return handleAnalyticsEvent(request, env);
    const monitorMatch = pathname.match(/^\/api\/game\/monitor\/([^/]+)$/);
    if (request.method === "GET" && monitorMatch) return handleMonitorGet(env, safeDecode(monitorMatch[1]));
    const resultMatch = pathname.match(/^\/api\/game\/result\/([^/]+)$/);
    if (request.method === "GET" && resultMatch) return handleGameResult(env, safeDecode(resultMatch[1]));
    return null;
  } catch (error) {
    console.error("light-game-api", error);
    return json({ error: error?.message || "Cloudflare Pages 游戏接口处理失败" }, 500);
  }
}
