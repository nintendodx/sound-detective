import { Buffer } from "node:buffer";
import { healthyProviderIds } from "../shared/asr-health-worker.mjs";
import { createAsrSessionTicket, verifyAsrSessionTicket } from "../shared/asr-session-ticket.mjs";
import * as sharedCloudflareAsr from "../shared/asr-cloudflare-core.mjs";
import "../shared/voice-game-contract.js";

const voiceGameContract = globalThis.VoiceGameContract;

const ANALYTICS_MAX_EVENTS = 50000;
const SOUND_EVENTS_KEY = "games/sound/events";
const PERSISTED_DIAGNOSTIC_EVENTS = new Set(["answer_response", "round_complete", "library_complete", "asr_retry"]);

function shouldPersistDiagnosticEvent(type) {
  const value = String(type || "").slice(0, 80).toLowerCase();
  return PERSISTED_DIAGNOSTIC_EVENTS.has(value)
    || /(?:error|failed|failure|timeout|permission|denied|dismissed|blocked|unavailable|no[_-]?speech|empty|retry_required)$/.test(value);
}
const DEFAULT_USER_NAMES = new Set(["匿名玩家", "匿名", "游客", "未命名", "无名", "无名侦探", "头号玩家"]);
const ASR_PROVIDER_LABELS = sharedCloudflareAsr.ASR_PROVIDER_LABELS;

const SEMANTIC_INTENTS = {
  "sound-breaking-a-cup": ["杯子摔碎", "杯子碎了", "打碎杯子", "玻璃杯碎", "玻璃碎", "杯子破了", "碎裂", "摔杯子", "砸杯子", "打碎玻璃", "玻璃打碎", "阿碎玻璃"],
  "sound-door-chime": ["门铃", "按门铃", "门铃响", "铃声", "叮咚", "有人按门铃"],
  "sound-entering-a-house": ["进门", "开门进屋", "开门进来", "开门回家", "回家开门", "进屋", "入门", "房门打开", "打开木门"],
  "sound-knocking-an-iron-door": ["敲铁门", "敲门", "拍门", "门响", "铁门响", "铁门声", "有人敲门", "敲门声"],
  "sound-lighting-a-match": ["划火柴", "擦火柴", "点火柴", "火柴点燃", "点燃火柴", "火柴", "划着火柴"],
  "sound-out-of-a-toilet": ["马桶冲水", "冲马桶", "厕所冲水", "卫生间冲水", "抽水马桶", "冲水", "上厕所冲水", "马桶"],
  "sound-scissors": ["剪刀", "剪东西", "剪纸", "裁剪", "剪开", "用剪刀", "剪刀剪"],
  "sound-vinyl-bag": ["塑料袋", "揉塑料袋", "搓塑料袋", "塑料袋揉搓", "袋子揉搓", "包装袋", "塑料包装", "塑料声"],
  "sound-writing-in-a-pen": ["写字", "用笔写字", "笔写字", "钢笔写字", "铅笔写字", "笔划纸", "书写", "写东西", "纸上写字", "黑板上写字", "板书", "粉笔写字"],
  "sound-small-car-engine": ["汽车发动机", "汽车发动", "发动汽车", "引擎发动", "汽车引擎"]
};


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

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: noStoreHeaders(headers) });
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

function soundAsrHotwords(data, soundIds = []) {
  const words = [];
  const selected = new Set(rows(soundIds).map(String));
  for (const sound of rows(data?.sounds)) {
    if (!sound || sound.enabled === false) continue;
    if (selected.size && !selected.has(String(sound.id))) continue;
    if (sound.name) words.push(sound.name);
    for (const tag of [...rows(sound.tags), ...rows(sound.aliases)]) words.push(tag);
  }
  words.push("声音", "音效", "掌声", "猫", "狗", "下雨", "雨声", "门铃", "敲门", "火柴", "剪刀", "键盘", "地铁", "洗衣机", "蝉鸣");
  return [...new Set(words.map((word) => String(word || "").trim()).filter(Boolean))].slice(0, 300);
}

const SOUND_ASR_RUNTIME = { gameId:"sound", cuid:"voice-detective-demo", labels:ASR_PROVIDER_LABELS };
function realtimeProviderConfigs(env) { return sharedCloudflareAsr.realtimeProviderConfigs(env, SOUND_ASR_RUNTIME); }
function availableAsrProviders(env) { return sharedCloudflareAsr.availableAsrProviders(env, SOUND_ASR_RUNTIME); }
function tencentRealtimeConfig(env) { return realtimeProviderConfigs(env)["tencent-realtime-v2"]; }
async function tencentRealtimeUrl(env, config, hotwords = []) { return sharedCloudflareAsr.tencentRealtimeUrl(config, hotwords, () => uuid()); }
const soundAsrHealth = sharedCloudflareAsr.createSharedAsrHealthService({ ...SOUND_ASR_RUNTIME, healthUid:"voice-detective-health", makeId:() => uuid() });

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
  const [legacy, central] = await Promise.all([
    env.SOUND_DETECTIVE_DATA?.get("store.json", "json"),
    env.ADMIN_HUB_DATA?.get("games/sound/store.json", "json")
  ]);
  if (legacy && central) return mergeStoreData(legacy, central);
  return ensureStoreShape(central || legacy);
}

async function readAnalyticsJournal(env) {
  const [legacy, central] = await Promise.all([
    env.SOUND_DETECTIVE_DATA?.get("events.json", "json"),
    env.ADMIN_HUB_DATA?.get(SOUND_EVENTS_KEY, "json")
  ]);
  return byIdMerge(rows(legacy), rows(central), (a, b) => ({ ...a, ...b }))
    .sort((a, b) => timeValue(a.at) - timeValue(b.at))
    .slice(-ANALYTICS_MAX_EVENTS);
}

async function writeAnalyticsJournal(env, events) {
  if (!env.ADMIN_HUB_DATA) throw new Error("缺少 ADMIN_HUB_DATA KV 绑定");
  const serialized = JSON.stringify(rows(events).slice(-ANALYTICS_MAX_EVENTS));
  await env.ADMIN_HUB_DATA.put(SOUND_EVENTS_KEY, serialized);
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
  if (!env.ADMIN_HUB_DATA) throw new Error("缺少 ADMIN_HUB_DATA KV 绑定");
  const latest = options.replace ? null : await readStore(env);
  const next = latest ? mergeStoreData(latest, data) : normalizeStoreForWrite(data);
  const serialized = JSON.stringify(next);
  await env.ADMIN_HUB_DATA.put("games/sound/store.json", serialized);
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

function judgeAnswer(sound, answer) {
  const judgment = voiceGameContract.judgeAnswer({ gameId:"sound", transcript:answer, question:{ name:sound.name, tags:sound.tags, aliases:sound.aliases, semanticIntents:rows(SEMANTIC_INTENTS[sound.id]) } });
  const hit = judgment.matches[0];
  const match = { ok:judgment.correct, score:Number(hit?.confidence || 0), type:hit?.type || judgment.reason, matched:hit?.matched || "" };
  return {
    correct: judgment.correct,
    message: judgment.correct ? "答对了！你听得很准。" : `差一点，正确答案是「${sound.name}」`,
    match,
    judgment
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
  const result = judgeAnswer(sound, text);
  if (!text) result.message = "没有识别到文字";
  const answeredAt = options.at || new Date().toISOString();
  const answerRecord = {
    soundId: sound.id,
    answer: text,
    correct: result.correct,
    at: answeredAt,
    inputMode: options.inputMode || "text"
  };
  answerRecord.judgment = result.judgment;
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
  const requestedName = cleanUserName(input.name);
  const userNameChanged = Boolean(requestedName && user.name !== requestedName);
  if (userNameChanged) user.name = requestedName;
  normalizeUserIdentity(user, [input.deviceId]);
  applyUserClientInfo(user, input, request);

  const startToken = String(input.startToken || "").trim().slice(0, 100);
  if (startToken) {
    const existing = sessionsFor(data).find((session) => session.userId === user.id && session.startToken === startToken);
    if (existing) {
      if (userNameChanged) await writeStore(env, data);
      const questions = rows(existing.soundIds).map((id) => data.sounds.find((sound) => sound.id === id)).filter(Boolean);
      const asrTicket = await createAsrSessionTicket(env, { sessionId:existing.id, provider:existing.asrProvider, questionIds:existing.soundIds });
      return json({ sessionId:existing.id, questions:questions.map(publicSound), playthrough:existing.playthrough || 1, asrProvider:existing.asrProvider || "", asrProviderLabel:existing.asrProviderLabel || "", asrTicket, reused:true });
    }
  }

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
  const asrProvider = voiceGameContract.selectAsrProvider(providers);
  const session = {
    id: uuid(),
    startToken,
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
  const asrTicket = await createAsrSessionTicket(env, { sessionId:session.id, provider:asrProvider, questionIds:session.soundIds });
  return json({ sessionId: session.id, questions: questions.map(publicSound), playthrough, asrProvider, asrProviderLabel: session.asrProviderLabel, asrTicket });
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
  if (!shouldPersistDiagnosticEvent(input.type)) return json({ ok: true, skipped: true });
  const events = await readAnalyticsJournal(env);
  const event = analyticsEvent({
    ...input,
    details:{ message:String(input.message || "客户端事件").slice(0, 120), ...(input.details || {}) }
  }, request);
  events.push(event);
  await writeAnalyticsJournal(env, events);
  return json({ ok: true, event });
}

async function handleAnalyticsEvent(request, env) {
  const input = await readJsonBody(request);
  if (isLightTestRequest(request, new URL(request.url), input, env)) return json({ ok: true, skipped: true, testMode: true });
  if (!shouldPersistDiagnosticEvent(input.type)) return json({ ok: true, skipped: true });
  const events = await readAnalyticsJournal(env);
  const event = analyticsEvent(input, request);
  events.push(event);
  await writeAnalyticsJournal(env, events);
  return json({ ok: true, id: event.id });
}

async function handleAsrConfig(env) {
  const data = await readStore(env);
  const hotwords = soundAsrHotwords(data);
  return json(sharedCloudflareAsr.providerStatus(env, hotwords, SOUND_ASR_RUNTIME));
}

export async function handleLightGameApi(request, env, pathname) {
  if (!env.SOUND_DETECTIVE_DATA) return null;
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && pathname === "/api/asr/config") return handleAsrConfig(env);
    if (request.method === "GET" && pathname === "/api/voice/contract") return json(voiceGameContract.describeContract());
    if (request.method === "POST" && pathname === "/api/asr/tencent-session") {
      const input = await readJsonBody(request);
      const data = await readStore(env);
      let signedSoundIds = [];
      if (!input.probe) {
        const session = getSessionById(data, String(input.sessionId || ""));
        const questionId = String(input.questionId || input.soundId || "");
        const ticket = await verifyAsrSessionTicket(env, input.asrTicket, { sessionId:input.sessionId, provider:"tencent-realtime-v2", questionId });
        const sound = data.sounds.find((item) => item.id === questionId);
        if (!sound || (!session && !ticket) || (session && !rows(session.soundIds).includes(questionId))) return json({ error:"本轮验证已失效，请返回首页重新开始" }, 401);
        if ((session?.asrProvider || ticket?.provider) !== "tencent-realtime-v2") return json({ error:"本轮未分配腾讯实时语音识别" }, 409);
        signedSoundIds = rows(session?.soundIds).length ? rows(session.soundIds) : rows(ticket?.questionIds);
      }
      const config = tencentRealtimeConfig(env);
      if (!config.enabled) return json({ error:"腾讯实时语音识别未配置" }, 503);
      const cf = request.cf || {};
      return json({
        url:await tencentRealtimeUrl(env, config, soundAsrHotwords(data, signedSoundIds)),
        expiresAt:new Date(Date.now() + 120000).toISOString(),
        serviceRuntime:"cloudflare-pages-signer",
        requestHost:url.host,
        edgeColo:String(cf.colo || ""),
        edgeCountry:String(cf.country || "")
      });
    }
    if (request.method === "GET" && pathname === "/api/health") {
      return json({ ok:true, runtime:"cloudflare-pages", version:"0.3.8-20261009" }, 200, { "Cache-Control":"public, max-age=30, stale-while-revalidate=120" });
    }
    if (request.method === "GET" && pathname === "/api/asr/health") {
      const data = await readStore(env);
      return json(await soundAsrHealth.check(env, soundAsrHotwords(data), url.searchParams.get("force") === "1"), 200, { "Cache-Control":"public, max-age=60, stale-while-revalidate=300" });
    }
    if (pathname === "/ws/asr") return json({ error:"音频代理已停用，请刷新页面使用腾讯直连" }, 410);
    if (request.method === "GET" && pathname === "/api/sounds") {
      const data = await readStore(env);
      return json(data.sounds.map(publicSound));
    }
    if (request.method === "GET" && pathname === "/api/rankings") {
      const data = await readStore(env);
      const query = Object.fromEntries(url.searchParams.entries());
      const limit = 10;
      const currentUser = resolveExistingRealUser(data, query);
      const ranking = scoreRankingRows(data);
      const currentRank = currentUser ? ranking.find((item) => item.id === currentUser.id) : null;
      return json({
        ranking: ranking.slice(0, limit),
        user: currentRank
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
