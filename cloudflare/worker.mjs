import { Buffer } from "node:buffer";
import { Readable, Writable } from "node:stream";
import { handleLightGameApi } from "./light-game.mjs";
import engineeringStats from "../data/engineering-stats.json" with { type:"json" };

globalThis.__DX100_ENGINEERING_STATS ||= engineeringStats;

let appPromise = null;

const ADMIN_ASSET_PATHS = new Map([
  ["/admin.html", "/admin.html"],
  ["/admin-users.html", "/admin-users.html"],
  ["/admin-tags.html", "/admin-tags.html"],
  ["/admin-analytics.html", "/admin-analytics.html"]
]);

const ADMIN_ALIAS_PATHS = new Map([
  ["/admin", "/admin.html"],
  ["/admin/users", "/admin-users.html"],
  ["/admin/tags", "/admin-tags.html"],
  ["/admin/analytics", "/admin-analytics.html"]
]);

const MIME = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8"
};

const ASR_PROVIDER_LABELS = {
  "tencent-realtime-v2": "腾讯实时语音识别 2.0",
  "doubao-streaming-v2": "豆包双向流式 2.0",
  "baidu-realtime": "百度实时语音识别"
};

function syncProcessEnv(env) {
  if (!globalThis.process?.env) return;
  for (const [key, value] of Object.entries(env || {})) {
    if (typeof value === "string" && process.env[key] !== value) process.env[key] = value;
  }
}

async function loadApp(env) {
  syncProcessEnv(env);
  globalThis.__DX100_ROOT ||= ".";
  appPromise ||= import("../server.js");
  const mod = await appPromise;
  return mod.default || mod;
}

function headersFromRequest(request) {
  const headers = {};
  for (const [key, value] of request.headers.entries()) headers[key.toLowerCase()] = value;
  const url = new URL(request.url);
  if (!headers.host) headers.host = url.host;
  return headers;
}

function requestBodyAllowed(method) {
  return !["GET", "HEAD"].includes(String(method || "GET").toUpperCase());
}

async function bodyBuffer(request) {
  if (!requestBodyAllowed(request.method)) return Buffer.alloc(0);
  return Buffer.from(await request.arrayBuffer());
}

function toNodeRequest(request, body) {
  const url = new URL(request.url);
  const nodeReq = Readable.from(body.length ? [body] : []);
  nodeReq.method = request.method;
  nodeReq.url = `${url.pathname}${url.search}`;
  nodeReq.headers = headersFromRequest(request);
  nodeReq.socket = {
    remoteAddress:
      request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-forwarded-for") ||
      ""
  };
  return nodeReq;
}

function appendHeaders(target, values = {}) {
  for (const [key, value] of Object.entries(values || {})) {
    if (Array.isArray(value)) {
      for (const item of value) target.append(key, String(item));
    } else if (value !== undefined) {
      target.set(key, String(value));
    }
  }
}

function responseHeadersObject(headers) {
  const out = {};
  for (const [key, value] of headers.entries()) out[key] = value;
  return out;
}

function methodCanServeAsset(request) {
  return request.method === "GET" || request.method === "HEAD";
}

function normalizePathname(pathname) {
  return String(pathname || "/").replace(/\/+$/, "") || "/";
}

function isAdminAssetPath(pathname) {
  return ADMIN_ASSET_PATHS.has(pathname) || ADMIN_ALIAS_PATHS.has(pathname) || /^\/public\/admin(?:[-.]|$)/.test(pathname);
}

function adminSecretPath(env) {
  const raw = String(env.ADMIN_SECRET_PATH || env.DX100_ADMIN_PATH || "").trim();
  return raw ? `/${raw.replace(/^\/+|\/+$/g, "")}` : "";
}

function adminSecretAsset(pathname, env) {
  const base = adminSecretPath(env);
  if (!base) return "";
  if (pathname === base) return "/admin.html";
  if (pathname === `${base}/users`) return "/admin-users.html";
  if (pathname === `${base}/analytics`) return "/admin-analytics.html";
  if (pathname === `${base}/tags`) return "/admin-tags.html";
  return "";
}

function cookieValue(request, name) {
  const cookies = String(request.headers.get("cookie") || "").split(";");
  for (const item of cookies) {
    const idx = item.indexOf("=");
    if (idx < 0) continue;
    const key = item.slice(0, idx).trim();
    if (key === name) return decodeURIComponent(item.slice(idx + 1).trim());
  }
  return "";
}

function publicMode(env) {
  return ["1", "true", "yes", "on"].includes(String(env.PUBLIC_MODE || "").trim().toLowerCase());
}

function adminToken(env) {
  return String(env.ADMIN_TOKEN || env.DX100_ADMIN_TOKEN || "").trim();
}

function isAdminAuthorized(request, env) {
  return true;
}

function noStoreHeaders(extra = {}) {
  return {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    ...extra
  };
}

function adminCookieHeader(env) {
  const token = adminToken(env);
  if (!token) return "";
  return `dx100_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure`;
}

function notFound() {
  return Response.json({ error: "未找到页面" }, { status: 404 });
}

function unifiedDataEnabled(env) {
  return Boolean(env.ADMIN_HUB_DATA);
}

function dataKv(env) {
  return env.ADMIN_HUB_DATA || env.SOUND_DETECTIVE_DATA;
}

function dataKey(env, key) {
  return unifiedDataEnabled(env) ? `games/sound/${key}` : key;
}

function assetBucket(env) {
  return env.ADMIN_HUB_ASSETS || null;
}

function assetKey(env, key) {
  return unifiedDataEnabled(env) ? `games/sound/${key}` : key;
}

async function getDataValue(env, key, type = "") {
  const kv = dataKv(env);
  if (!kv) return null;
  const primaryKey = dataKey(env, key);
  const read = (store, targetKey) => type ? store.get(targetKey, type) : store.get(targetKey);
  const value = await read(kv, primaryKey);
  if (value !== null && value !== undefined) return value;
  if (unifiedDataEnabled(env) && env.SOUND_DETECTIVE_DATA) return read(env.SOUND_DETECTIVE_DATA, key);
  return value;
}

async function getAssetValue(env, key) {
  const bucket = assetBucket(env);
  if (bucket) {
    const object = await bucket.get(assetKey(env, key));
    if (object) {
      return {
        body: await object.arrayBuffer(),
        contentType: object.httpMetadata?.contentType || ""
      };
    }
  }
  const value = await getDataValue(env, key, "arrayBuffer");
  return value ? { body: value, contentType: "" } : null;
}

function assetRequest(request, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers: request.headers
  });
}

async function serveStaticAsset(request, env, pathname, extraHeaders = {}) {
  if (!env.ASSETS) return notFound();
  const response = await env.ASSETS.fetch(assetRequest(request, pathname));
  if (response.status === 404) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(extraHeaders || {})) {
    if (value) headers.set(key, String(value));
  }
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function publicStaticAsset(pathname) {
  if (isAdminAssetPath(pathname)) return "";
  if (pathname === "/") return "/index.html";
  if (pathname === "/index.html" || pathname === "/team.html") return pathname;
  if (pathname.startsWith("/public/")) return pathname;
  return "";
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function basename(value) {
  const decoded = safeDecode(value);
  return decoded.split(/[\\/]/).filter(Boolean).pop() || "";
}

function kvAssetKey(pathname) {
  if (pathname.startsWith("/uploads/")) {
    const name = basename(pathname.slice("/uploads/".length));
    return name ? `uploads/${name}` : "";
  }
  if (pathname.startsWith("/images/")) {
    const name = basename(pathname.slice("/images/".length));
    return name ? `images/${name}` : "";
  }
  return "";
}

function extension(name) {
  const clean = String(name || "").toLowerCase();
  const idx = clean.lastIndexOf(".");
  return idx >= 0 ? clean.slice(idx) : "";
}

function parseByteRange(header, totalSize) {
  const raw = String(header || "").trim();
  if (!raw) return null;
  if (totalSize <= 0) return { unsatisfiable: true };
  const match = raw.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return { unsatisfiable: true };
  const [, startText, endText] = match;
  if (!startText && !endText) return { unsatisfiable: true };
  let start;
  let end;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { unsatisfiable: true };
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : totalSize - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { unsatisfiable: true };
    if (end >= totalSize) end = totalSize - 1;
  }
  if (start < 0 || end < start || start >= totalSize) return { unsatisfiable: true };
  return { start, end };
}

async function serveKvAsset(request, env, key) {
  if (!dataKv(env) && !assetBucket(env)) return notFound();
  const asset = await getAssetValue(env, key);
  if (!asset) return notFound();
  const value = asset.body;
  const totalSize = value.byteLength;
  const headers = {
    "Content-Type": asset.contentType || MIME[extension(key)] || "application/octet-stream",
    "Cache-Control": "public, max-age=3600",
    "Accept-Ranges": "bytes"
  };
  const range = parseByteRange(request.headers.get("range"), totalSize);
  if (range?.unsatisfiable) {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${totalSize}`, "Content-Length": "0" }
    });
  }
  if (range) {
    const chunk = value.slice(range.start, range.end + 1);
    return new Response(request.method === "HEAD" ? null : chunk, {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${totalSize}`,
        "Content-Length": String(chunk.byteLength)
      }
    });
  }
  return new Response(request.method === "HEAD" ? null : value, {
    status: 200,
    headers: { ...headers, "Content-Length": String(totalSize) }
  });
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: noStoreHeaders()
  });
}

function rows(input) {
  return Array.isArray(input) ? input : [];
}

async function readGameStore(env) {
  const data = await getDataValue(env, "store.json", "json");
  return {
    ...(data && typeof data === "object" ? data : {}),
    sounds: rows(data?.sounds),
    users: rows(data?.users),
    sessions: rows(data?.sessions),
    analyticsEvents: rows(data?.analyticsEvents)
  };
}

function timeValue(value) {
  const t = new Date(value || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

function isTestUser(user) {
  return Boolean(user?.isTest) || String(user?.id || "").startsWith("test-user-");
}

function isTestSession(session) {
  return Boolean(session?.isTest) || String(session?.id || "").startsWith("test-session-");
}

function cleanUserName(name) {
  return String(name || "").trim().slice(0, 20);
}

function statRows(map, limit = 12) {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function inc(map, key, amount = 1) {
  map.set(key || "未分类", (map.get(key || "未分类") || 0) + amount);
}

function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item) || "未分类";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function avg(values) {
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx];
}

function browserMajor(version = "") {
  const major = String(version || "").split(".")[0];
  return /^\d+$/.test(major) ? major : "";
}

function cleanUserAgent(value) {
  return String(value || "").trim().slice(0, 240);
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

function clientLabel(client = {}) {
  const os = [client.os, client.osVersion].filter(Boolean).join(" ") || "未知系统";
  const browser = [client.browser, client.browserVersion].filter(Boolean).join(" ") || "未知浏览器";
  return `${os} / ${browser}`;
}

function clientInfoFromEvent(event) {
  if (event?.client?.userAgent) return { ...event.client, updatedAt: event.at || event.client.updatedAt || "" };
  const userAgent = cleanUserAgent(event?.userAgent || event?.client?.userAgent || "");
  return userAgent ? { ...parseClientInfo(userAgent), updatedAt: event?.at || "" } : null;
}

function deviceIdsFor(user = {}) {
  return [...new Set([user.deviceId, ...rows(user.deviceIds)].map(value => String(value || "").trim()).filter(Boolean))];
}

function latestClientForUser(data, user) {
  if (user?.client?.userAgent) return user.client;
  const ids = new Set(deviceIdsFor(user));
  const events = data.analyticsEvents
    .filter(event => event && ((user?.id && event.userId === user.id) || (event.deviceId && ids.has(event.deviceId))) && cleanUserAgent(event.userAgent || event.client?.userAgent || ""))
    .sort((a, b) => timeValue(b.at) - timeValue(a.at));
  return clientInfoFromEvent(events[0]) || null;
}

function userAnswerTotals(user, sessions) {
  const seen = new Set();
  let total = 0;
  let correct = 0;
  for (const session of sessions) {
    if (!session || session.userId !== user.id || isTestSession(session)) continue;
    for (const answer of rows(session.answers)) {
      const key = [session.id, answer?.soundId || "", answer?.at || "", answer?.answer || ""].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      total++;
      if (answer?.correct) correct++;
    }
  }
  return { total, correct, score: correct };
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

function adminSound(sound, users) {
  const names = new Map(users.map(user => [user.id, user.name || "匿名玩家"]));
  const history = rows(sound.answerHistory)
    .slice()
    .sort((a, b) => timeValue(b.at) - timeValue(a.at))
    .map(item => ({ ...item, userName: names.get(item.userId) || "匿名玩家" }));
  return {
    ...publicSound(sound),
    answerHistory: history,
    answerHistoryCount: history.length,
    answerTextStats: buildAnswerTextStats(sound)
  };
}

function adminUsers(data) {
  const sessions = data.sessions.filter(session => !isTestSession(session));
  return data.users
    .filter(user => !isTestUser(user))
    .map(user => {
      const totals = userAnswerTotals(user, sessions);
      const client = latestClientForUser(data, user);
      return {
        ...user,
        ...totals,
        client,
        clientLabel: client ? clientLabel(client) : ""
      };
    })
    .sort((a, b) => timeValue(b.lastSeen) - timeValue(a.lastSeen));
}

function sessionCompletedAt(session) {
  return rows(session.answers).map(answer => answer?.at).filter(Boolean).sort().at(-1) || session.completedAt || session.startedAt || "";
}

function answerStatusLabel(answer) {
  if (!answer) return "未答";
  if (answer.recognized === false) return "未识别";
  if (answer.transcriptionStatus && answer.transcriptionStatus !== "ok") return "识别失败";
  return answer.correct ? "答对" : "答错";
}

function adminAnswerRecord(soundId, sound, answer, index) {
  return {
    index,
    soundId,
    soundName: sound?.name || "未知题目",
    originalName: sound?.originalName || "",
    tags: rows(sound?.tags).slice(0, 6),
    answer: answer?.answer || "",
    correct: Boolean(answer?.correct),
    answered: Boolean(answer),
    answeredAt: answer?.at || "",
    inputMode: answer?.recovered ? "recovered" : (answer?.inputMode || ""),
    recognized: answer ? answer.recognized !== false : false,
    provider: answer?.provider || answer?.asrProvider || "",
    asrDurationMs: Number(answer?.asrDurationMs || 0) || 0,
    transcriptionStatus: answer?.transcriptionStatus || "",
    transcriptionReason: answer?.transcriptionReason || "",
    statusLabel: answerStatusLabel(answer)
  };
}

function hasAnswerEvidence(session) {
  if (rows(session?.answers).some(answer => answer && !answer.removed)) return true;
  if (rows(session?.audioAnswers).length) return true;
  return rows(session?.monitor).some(event => ["answer_submit", "audio_received", "audio_asr_queued", "speech_transcribed", "speech_empty", "transcribe_failed"].includes(event?.type));
}

function adminUserAnswerHistory(data, user) {
  const soundsById = new Map(data.sounds.map(sound => [sound.id, sound]));
  const sessionList = data.sessions
    .filter(session => session && session.userId === user.id && !isTestSession(session) && rows(session.soundIds).length && hasAnswerEvidence(session))
    .sort((a, b) => timeValue(a.startedAt) - timeValue(b.startedAt));
  const rounds = sessionList.map((session, roundIndex) => {
    const answers = rows(session.answers);
    const answersBySound = new Map(answers.filter(answer => answer?.soundId).map(answer => [answer.soundId, answer]));
    const soundIds = rows(session.soundIds);
    const records = soundIds.map((soundId, index) => adminAnswerRecord(soundId, soundsById.get(soundId), answersBySound.get(soundId) || null, index + 1));
    const listedSoundIds = new Set(soundIds);
    const extraAnswers = answers.filter(answer => answer?.soundId && !listedSoundIds.has(answer.soundId)).sort((a, b) => timeValue(a.at) - timeValue(b.at));
    for (const answer of extraAnswers) records.push(adminAnswerRecord(answer.soundId, soundsById.get(answer.soundId), answer, records.length + 1));
    const answered = records.filter(record => record.answered).length;
    const correct = records.filter(record => record.correct).length;
    return {
      sessionId: session.id,
      roundIndex: roundIndex + 1,
      playthrough: Number(session.playthrough || 1) || 1,
      startedAt: session.startedAt || "",
      completedAt: sessionCompletedAt(session),
      total: records.length,
      answered,
      correct,
      score: correct,
      records
    };
  });
  const client = latestClientForUser(data, user);
  return {
    user: { ...user, ...userAnswerTotals(user, sessionList), client, clientLabel: client ? clientLabel(client) : "" },
    generatedAt: new Date().toISOString(),
    rounds
  };
}

function eventClient(event = {}) {
  return clientInfoFromEvent(event) || { os: "未知", browser: "未知", deviceType: "unknown" };
}

function osBucket(client = {}) {
  return [client.os, client.osVersion ? String(client.osVersion).split(".")[0] : ""].filter(Boolean).join(" ") || "未知系统";
}

function browserBucket(client = {}) {
  return [client.browser, client.browserMajor || browserMajor(client.browserVersion)].filter(Boolean).join(" ") || "未知浏览器";
}

function clientStats(data) {
  const os = new Map();
  const browsers = new Map();
  const combos = new Map();
  const devices = new Map();
  const users = data.users.filter(user => !isTestUser(user)).map(user => {
    const client = latestClientForUser(data, user);
    if (client) {
      inc(os, osBucket(client));
      inc(browsers, browserBucket(client));
      inc(combos, clientLabel(client));
      inc(devices, client.deviceType || "unknown");
    }
    return {
      userId: user.id,
      name: cleanUserName(user.name) || "匿名玩家",
      client,
      label: client ? clientLabel(client) : "暂无数据",
      os: client?.os || "",
      osVersion: client?.osVersion || "",
      browser: client?.browser || "",
      browserVersion: client?.browserVersion || "",
      deviceType: client?.deviceType || "",
      lastSeen: user.lastSeen || ""
    };
  }).sort((a, b) => timeValue(b.lastSeen) - timeValue(a.lastSeen));
  return {
    identifiedUsers: users.filter(user => user.client).length,
    missingUsers: users.filter(user => !user.client).length,
    os: statRows(os),
    browsers: statRows(browsers),
    combos: statRows(combos),
    devices: statRows(devices),
    users: users.slice(0, 80)
  };
}

function recordingStatsByClient(events) {
  const groups = new Map();
  const ensure = label => {
    if (!groups.has(label)) groups.set(label, { client: label, recordClicks: 0, recordStarted: 0, micOpened: 0, audioUploaded: 0, transcribed: 0, noText: 0, errors: 0, playIssues: 0, asrReady: 0, asrFinals: 0 });
    return groups.get(label);
  };
  for (const event of events) {
    const row = ensure(clientLabel(eventClient(event)));
    if (event.type === "record_click") row.recordClicks++;
    if (event.type === "record_started") row.recordStarted++;
    if (event.type === "mic_opened") row.micOpened++;
    if (event.type === "asr_ready") row.asrReady++;
    if (event.type === "asr_final") row.asrFinals++;
    if (event.type === "audio_probe_uploaded") row.audioUploaded++;
    if (event.type === "audio_only_transcribed" || event.type === "speech_recognized" || event.type === "asr_final") row.transcribed++;
    if (event.type === "audio_only_received" || event.type === "speech_ended_empty" || event.type === "speech_empty") row.noText++;
    if (["mic_error", "speech_error", "audio_probe_upload_failed", "audio_probe_error", "audio_probe_empty", "api_error", "asr_error", "answer_error"].includes(event.type)) row.errors++;
    if (["audio_play_failed", "audio_play_unconfirmed", "record_blocked_audio_unconfirmed"].includes(event.type)) row.playIssues++;
  }
  return [...groups.values()]
    .filter(row => row.recordClicks || row.recordStarted || row.audioUploaded || row.errors || row.playIssues || row.noText || row.asrReady || row.asrFinals)
    .map(row => ({
      ...row,
      startRate: row.recordClicks ? Math.round(row.recordStarted / row.recordClicks * 100) : 0,
      uploadRate: row.recordStarted ? Math.round(row.audioUploaded / row.recordStarted * 100) : 0,
      connectRate: row.recordStarted ? Math.round(row.asrReady / row.recordStarted * 100) : 0,
      transcribeRate: row.recordStarted ? Math.round(row.transcribed / row.recordStarted * 100) : 0
    }))
    .sort((a, b) => (b.errors + b.playIssues + b.noText) - (a.errors + a.playIssues + a.noText) || b.recordClicks - a.recordClicks)
    .slice(0, 20);
}

function audioAnswerSummary(data) {
  const audioAnswers = data.sessions
    .filter(session => !isTestSession(session))
    .flatMap(session => rows(session.audioAnswers).map(answer => ({ ...answer, sessionId: session.id, userId: session.userId })));
  const audioStatus = new Map();
  const transcriptionStatus = new Map();
  const mimeTypes = new Map();
  const actualDurations = [];
  const asrDurations = [];
  const durationLosses = [];
  for (const answer of audioAnswers) {
    inc(audioStatus, answer.audioStatus || "unknown");
    inc(transcriptionStatus, answer.transcriptionStatus || answer.status || "unknown");
    inc(mimeTypes, answer.mimeType || "unknown");
    if (Number(answer.actualDurationMs || 0) > 0) actualDurations.push(Number(answer.actualDurationMs));
    if (Number(answer.asrDurationMs || 0) > 0) asrDurations.push(Number(answer.asrDurationMs));
    if (Number(answer.durationLossMs || 0) > 0) durationLosses.push(Number(answer.durationLossMs));
  }
  return {
    count: audioAnswers.length,
    audioStatus: statRows(audioStatus),
    transcriptionStatus: statRows(transcriptionStatus),
    mimeTypes: statRows(mimeTypes),
    actualDurationMs: { avg: avg(actualDurations), p50: percentile(actualDurations, 0.5), p95: percentile(actualDurations, 0.95) },
    asrDurationMs: { avg: avg(asrDurations), p50: percentile(asrDurations, 0.5), p95: percentile(asrDurations, 0.95) },
    durationLossMs: { avg: avg(durationLosses), p95: percentile(durationLosses, 0.95) }
  };
}

function compatibilityStats(data, events) {
  const issueTypes = new Set(["audio_play_failed", "audio_play_unconfirmed", "record_blocked_audio_unconfirmed", "mic_error", "speech_error", "audio_probe_upload_failed", "audio_probe_error", "audio_probe_empty", "audio_only_received", "speech_ended_empty", "api_error", "asr_error", "answer_error"]);
  const issueEvents = events.filter(event => issueTypes.has(event.type));
  const issueCounts = [...groupBy(issueEvents, event => event.type)].map(([type, items]) => ({ type, count: items.length, latestAt: items.at(-1)?.at || "" })).sort((a, b) => b.count - a.count);
  const monitorIssueTypes = new Set(["speech_missing", "audio_incomplete", "audio_health_unknown", "speech_empty", "transcribe_failed", "audio_asr_ignored", "audio_answer_rejected"]);
  const monitorEvents = data.sessions
    .filter(session => !isTestSession(session))
    .flatMap(session => rows(session.monitor).map(event => ({ ...event, sessionId: session.id, userId: session.userId })))
    .filter(event => monitorIssueTypes.has(event.type));
  const monitorIssueCounts = [...groupBy(monitorEvents, event => event.type)].map(([type, items]) => ({ type, count: items.length, latestAt: items.at(-1)?.at || "" })).sort((a, b) => b.count - a.count);
  return {
    issueEvents: issueEvents.length,
    issueCounts,
    monitorIssueCounts,
    recordingByClient: recordingStatsByClient(events),
    recentIssues: issueEvents.slice(-40).reverse(),
    recentMonitorIssues: monitorEvents.slice(-40).reverse()
  };
}

function ratio(part, total) {
  return total ? Math.round(part / total * 1000) / 10 : 0;
}

function asrExperimentStats(data) {
  const sessions = data.sessions.filter(session => session && !isTestSession(session));
  return Object.keys(ASR_PROVIDER_LABELS).map(provider => {
    const providerSessions = sessions.filter(session => session.asrProvider === provider);
    const sessionIds = new Set(providerSessions.map(session => session.id));
    const events = data.analyticsEvents.filter(event => sessionIds.has(event.sessionId));
    const answers = providerSessions.flatMap(session => rows(session.answers).filter(answer => (answer.provider || answer.asrProvider || provider) === provider));
    const count = type => events.filter(event => event.type === type).length;
    const values = (type, key) => events
      .filter(event => event.type === type)
      .map(event => Number(event.details?.[key] || event.durationMs || 0))
      .filter(value => Number.isFinite(value) && value > 0);
    const attempts = count("asr_connect_started");
    const ready = count("asr_ready");
    const recordStarts = count("record_started");
    const finals = count("asr_final");
    const retries = count("asr_retry");
    const errors = new Set(events.filter(event => ["asr_error", "answer_error", "mic_error"].includes(event.type)).map(event => event.details?.asrAttemptId || event.id)).size;
    const completedRounds = providerSessions.filter(session => rows(session.answers).length >= rows(session.soundIds).length).length;
    const correct = answers.filter(answer => answer.correct).length;
    return {
      provider,
      label: ASR_PROVIDER_LABELS[provider],
      configured: providerSessions.length > 0 || attempts > 0,
      assignedRounds: providerSessions.length,
      uniqueUsers: new Set(providerSessions.map(session => session.userId).filter(Boolean)).size,
      completedRounds,
      completionRate: ratio(completedRounds, providerSessions.length),
      answered: answers.length,
      correct,
      answerAccuracy: ratio(correct, answers.length),
      connectAttempts: attempts,
      ready,
      connectSuccessRate: ratio(ready, attempts),
      recordStarts,
      finals,
      recognitionSuccessRate: ratio(finals, recordStarts),
      retries,
      retryRate: ratio(retries, recordStarts),
      errors,
      errorRate: ratio(errors, Math.max(1, attempts || recordStarts)),
      firstTextP50: percentile(values("asr_first_partial", "firstTextMs"), 0.5),
      firstTextP95: percentile(values("asr_first_partial", "firstTextMs"), 0.95),
      finalP50: percentile(values("asr_final", "finalMs"), 0.5),
      finalP95: percentile(values("asr_final", "finalMs"), 0.95),
      answerP50: percentile(values("answer_response", "asrDurationMs"), 0.5),
      answerP95: percentile(values("answer_response", "asrDurationMs"), 0.95)
    };
  });
}

function analyticsSummary(data) {
  const events = data.analyticsEvents.slice().sort((a, b) => timeValue(a.at) - timeValue(b.at));
  const now = Date.now();
  const recent = events.filter(event => now - timeValue(event.at) <= 30 * 60 * 1000);
  const byType = [...groupBy(events, event => event.type)].map(([type, items]) => ({ type, count: items.length, latestAt: items.at(-1)?.at || "" })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  const pageLeaves = events.filter(event => (event.type === "page_leave" || event.type === "section_leave") && event.durationMs > 0);
  const pageStats = [...groupBy(pageLeaves, event => event.path || event.page)].map(([page, items]) => {
    const durations = items.map(event => event.durationMs).filter(Boolean);
    return { page, count: items.length, avgDurationMs: avg(durations), p95DurationMs: percentile(durations, 0.95), maxDurationMs: Math.max(0, ...durations) };
  }).sort((a, b) => b.count - a.count);
  const apiEvents = events.filter(event => event.type === "api_response" || event.type === "api_error");
  const apiStats = [...groupBy(apiEvents, event => event.details?.url || "unknown")].map(([url, items]) => {
    const durations = items.map(event => Number(event.details?.durationMs || event.durationMs || 0)).filter(Boolean);
    const errors = items.filter(event => event.type === "api_error" || event.details?.ok === false).length;
    return { url, count: items.length, errors, avgMs: avg(durations), p95Ms: percentile(durations, 0.95), latestAt: items.at(-1)?.at || "" };
  }).sort((a, b) => b.errors - a.errors || b.count - a.count);
  const roundDurations = events.filter(event => event.type === "round_complete").map(event => Number(event.durationMs || event.details?.durationMs || 0)).filter(Boolean);
  const libraryDurations = events.filter(event => event.type === "library_complete").map(event => Number(event.durationMs || event.details?.durationMs || 0)).filter(Boolean);
  const startedRounds = events.filter(event => event.type === "game_started").length;
  const completedRounds = events.filter(event => event.type === "round_complete").length;
  const recording = {
    recordClicks: events.filter(event => event.type === "record_click").length,
    recordStarted: events.filter(event => event.type === "record_started").length,
    recordStops: events.filter(event => event.type === "record_stop_click").length,
    recordAutoStops: events.filter(event => event.type === "record_auto_stopped").length,
    micOpened: events.filter(event => event.type === "mic_opened").length,
    audioUploaded: events.filter(event => event.type === "audio_probe_uploaded").length,
    asrConnectStarted: events.filter(event => event.type === "asr_connect_started").length,
    asrReady: events.filter(event => event.type === "asr_ready").length,
    asrFinals: events.filter(event => event.type === "asr_final").length,
    transcribed: events.filter(event => event.type === "audio_only_transcribed" || event.type === "speech_recognized" || event.type === "asr_final").length,
    audioReceivedNoText: events.filter(event => event.type === "audio_only_received" || event.type === "speech_ended_empty" || event.type === "speech_empty").length,
    errors: events.filter(event => ["mic_error", "speech_error", "audio_probe_upload_failed", "audio_probe_error", "asr_error", "answer_error"].includes(event.type)).length
  };
  recording.clickToStartRate = recording.recordClicks ? Math.round(recording.recordStarted / recording.recordClicks * 100) : 0;
  recording.startToUploadRate = recording.recordStarted ? Math.round(recording.audioUploaded / recording.recordStarted * 100) : 0;
  recording.connectSuccessRate = recording.asrConnectStarted ? Math.round(recording.asrReady / recording.asrConnectStarted * 100) : 0;
  recording.startToTranscribedRate = recording.recordStarted ? Math.round(recording.transcribed / recording.recordStarted * 100) : 0;
  recording.uploadToTranscribedRate = recording.audioUploaded ? Math.round(recording.transcribed / recording.audioUploaded * 100) : 0;
  return {
    generatedAt: new Date().toISOString(),
    totalEvents: events.length,
    recentEvents: recent.length,
    uniqueDevices: new Set(events.map(event => event.deviceId).filter(Boolean)).size,
    uniqueUsers: new Set(events.map(event => event.userId).filter(Boolean)).size,
    startedRounds,
    completedRounds,
    abandonedRounds: Math.max(0, startedRounds - completedRounds),
    avgRoundMs: avg(roundDurations),
    p95RoundMs: percentile(roundDurations, 0.95),
    avgLibraryMs: avg(libraryDurations),
    p95LibraryMs: percentile(libraryDurations, 0.95),
    recording,
    clients: clientStats(data),
    asrExperiments: asrExperimentStats(data),
    audioAnswers: audioAnswerSummary(data),
    compatibility: compatibilityStats(data, events),
    eventCounts: byType.slice(0, 40),
    pageStats,
    apiStats,
    recent: events.slice(-80).reverse()
  };
}

async function handleLightAdminApi(request, env, pathname) {
  if (request.method !== "GET" || !pathname.startsWith("/api/admin/")) return null;
  try {
    const data = await readGameStore(env);
    if (pathname === "/api/admin/sounds") return json(data.sounds.map(sound => adminSound(sound, data.users)));
    if (pathname === "/api/admin/users") return json(adminUsers(data));
    if (pathname === "/api/admin/analytics") return json(analyticsSummary(data));
    if (pathname === "/api/admin/asr-experiments") return json({ generatedAt: new Date().toISOString(), providers: asrExperimentStats(data) });
    const match = pathname.match(/^\/api\/admin\/users\/([^/]+)\/answers$/);
    if (match) {
      const userId = safeDecode(match[1]);
      const user = data.users.find(item => !isTestUser(item) && item.id === userId);
      if (!user) return json({ error: "用户不存在" }, 404);
      return json(adminUserAnswerHistory(data, user));
    }
    return null;
  } catch (error) {
    console.error("light-admin-api", error);
    return json({ error: error?.message || "后台接口读取失败" }, 500);
  }
}

class CloudflareKvStore {
  constructor(env) {
    this.env = env;
    this.kv = dataKv(env);
    this.assets = env.ASSETS;
  }

  key(key) {
    return dataKey(this.env, key);
  }

  async get(key, options = {}) {
    if (!this.kv) return null;
    if (options.type === "json") return getDataValue(this.env, key, "json");
    if (options.type === "arrayBuffer") return getDataValue(this.env, key, "arrayBuffer");
    return getDataValue(this.env, key);
  }

  async setJSON(key, value) {
    if (!this.kv) throw new Error("缺少 Cloudflare KV 绑定 ADMIN_HUB_DATA 或 SOUND_DETECTIVE_DATA");
    await this.kv.put(this.key(key), JSON.stringify(value));
  }

  async set(key, value) {
    if (!this.kv) throw new Error("缺少 Cloudflare KV 绑定 ADMIN_HUB_DATA 或 SOUND_DETECTIVE_DATA");
    const body = Buffer.isBuffer(value)
      ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
      : value;
    await this.kv.put(this.key(key), body);
  }

  async delete(key) {
    if (!this.kv) throw new Error("缺少 Cloudflare KV 绑定 ADMIN_HUB_DATA 或 SOUND_DETECTIVE_DATA");
    await this.kv.delete(this.key(key));
  }

  async list(options = {}) {
    if (!this.kv) return { blobs: [] };
    const keyPrefix = dataKey(this.env, options.prefix || "");
    const blobs = [];
    let cursor = undefined;
    do {
      const result = await this.kv.list({ prefix:keyPrefix, cursor });
      for (const item of result.keys || []) blobs.push({ key: unifiedDataEnabled(this.env) ? item.name.replace(/^games\/sound\//, "") : item.name });
      cursor = result.cursor;
      if (result.list_complete) break;
    } while (cursor);
    return { blobs };
  }

  async fetchAsset(req, res, safe, headers = {}) {
    if (!this.assets) return false;
    const host = req.headers.host || "sound-detective.local";
    const pathname = `/${String(safe || "").replace(/^\/+/, "")}`;
    const assetUrl = new URL(pathname, `https://${host}`);
    const response = await this.assets.fetch(new Request(assetUrl, {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      headers: new Headers(req.headers || {})
    }));
    if (response.status === 404) return false;
    const outHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(headers || {})) outHeaders.set(key, String(value));
    const payload = req.method === "HEAD" ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, responseHeadersObject(outHeaders));
    res.end(payload);
    return true;
  }
}

async function runNodeHandler(app, request, env) {
  const body = await bodyBuffer(request);
  const nodeReq = toNodeRequest(request, body);
  const chunks = [];
  const headers = new Headers();
  let status = 200;

  const nodeRes = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      callback();
    }
  });

  nodeRes.writeHead = (statusCode, statusMessageOrHeaders, maybeHeaders) => {
    status = statusCode;
    if (typeof statusMessageOrHeaders === "object") appendHeaders(headers, statusMessageOrHeaders);
    appendHeaders(headers, maybeHeaders);
    return nodeRes;
  };
  nodeRes.setHeader = (key, value) => {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, String(item));
    } else {
      headers.set(key, String(value));
    }
  };
  nodeRes.getHeader = (key) => headers.get(key);

  const finished = new Promise((resolve, reject) => {
    nodeRes.on("finish", () => resolve(new Response(Buffer.concat(chunks), { status, headers })));
    nodeRes.on("error", reject);
  });

  await app.handleRequest(nodeReq, nodeRes);
  return finished;
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const pathname = normalizePathname(url.pathname);
      if (methodCanServeAsset(request)) {
        if (isAdminAssetPath(pathname) || adminSecretAsset(pathname, env)) return notFound();

        const secretAsset = adminSecretAsset(pathname, env);
        if (secretAsset) {
          return serveStaticAsset(request, env, secretAsset, noStoreHeaders({
            "Set-Cookie": adminCookieHeader(env)
          }));
        }

        if (isAdminAssetPath(pathname)) {
          if (!isAdminAuthorized(request, env)) return notFound();
          return serveStaticAsset(request, env, ADMIN_ASSET_PATHS.get(pathname) || ADMIN_ALIAS_PATHS.get(pathname) || pathname, noStoreHeaders());
        }

        const staticAsset = publicStaticAsset(pathname);
        if (staticAsset) return serveStaticAsset(request, env, staticAsset);

        const key = kvAssetKey(pathname);
        if (key) return serveKvAsset(request, env, key);
      }

      if (pathname.startsWith("/api/admin/")) return notFound();

      const lightGameResponse = await handleLightGameApi(request, env, pathname);
      if (lightGameResponse) return lightGameResponse;

      const app = await loadApp(env);
      const store = new CloudflareKvStore(env);
      return await app.withCloudRequest(store, () => runNodeHandler(app, request, env));
    } catch (error) {
      console.error(error);
      return Response.json(
        { error: error?.message || "Cloudflare 请求处理失败" },
        { status: 500 }
      );
    }
  }
};
