const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
let WebSocket = globalThis.WebSocket;
try {
  const ws = require('ws');
  WebSocket = ws.WebSocket || WebSocket;
} catch {}
const { createNodeAsrToolkit } = require('./shared/asr-node.cjs');
const voiceGameContract = require('./shared/voice-game-contract.js');
const asrSessionTicketPromise = import('./shared/asr-session-ticket.mjs');

const ROOT = typeof __dirname === 'string' ? __dirname : (globalThis.__DX100_ROOT || '.');
const DOWNLOADS_ROOT = path.resolve(ROOT, '..');
const UNIFIED_ADMIN_ROOT = path.join(DOWNLOADS_ROOT, 'text color');
loadEnvFile(UNIFIED_ADMIN_ROOT);
const DEFAULT_DATA_ROOT = fs.existsSync(UNIFIED_ADMIN_ROOT)
  ? path.join(UNIFIED_ADMIN_ROOT, 'data', 'admin-hub-source', 'sound', 'data')
  : path.join(ROOT, 'data');
const DATA_ROOT = envValue('DX100_DATA_ROOT') ? path.resolve(envValue('DX100_DATA_ROOT')) : DEFAULT_DATA_ROOT;
const STORE = path.join(DATA_ROOT, 'store.json');
const EVENTS_STORE = path.join(DATA_ROOT, 'events.json');
const UPLOADS = path.join(ROOT, 'uploads');
const ANALYTICS_MAX_EVENTS = 50000;
const asrToolkit = createNodeAsrToolkit({ crypto, WebSocket, defaultCuid:'voice-detective-demo', gameId:'sound', envValue });
const ASR_PROVIDER_LABELS = Object.freeze(asrToolkit.labels);
const CLOUD_CONTEXT = new AsyncLocalStorage();
const PORT = Number(envValue('PORT') || 3000);
const APP_VERSION = '0.3.8-20261009';
const PUBLIC_MODE = envFlag('PUBLIC_MODE');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.m4a':'audio/mp4', '.ogg':'audio/ogg', '.webm':'audio/webm', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.svg':'image/svg+xml; charset=utf-8' };
const NO_STORE_HEADERS = {'Cache-Control':'no-store, no-cache, must-revalidate, max-age=0', Pragma:'no-cache', Expires:'0'};
const TEST_USERS = new Map();
const TEST_SESSIONS = new Map();
const RATE_LIMIT_BUCKETS = new Map();
const REQUEST_GUARDS = new Map();

function loadEnvFile(root) {
  const file = path.join(root, '.env');
  let text = '';
  try {
    if (!fs.existsSync(file)) return;
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}
function envValue(key, fallback='') {
  return process.env[key] ?? fallback;
}
function envFlag(key) {
  return truthy(envValue(key));
}
function activeCloudContext() {
  return CLOUD_CONTEXT.getStore()||null;
}
function isCloudRuntime() {
  return Boolean(activeCloudContext());
}
async function withCloudRequest(store, fn) {
  if(!store) throw Error('缺少云端数据存储');
  const remote=await store.get('store.json',{type:'json'});
  const data=remote&&typeof remote==='object' ? remote : seed();
  let dirty=false;
  if(normalizeStoreState(data)) dirty=true;
  const ctx={store,data,dirty,sidecars:[]};
  return CLOUD_CONTEXT.run(ctx, async () => {
    const result=await fn();
    await flushCloudStore();
    return result;
  });
}
async function flushCloudStore() {
  const ctx=activeCloudContext();
  if(!ctx||(!ctx.dirty&&!(ctx.sidecars||[]).length)) return;
  for(const item of ctx.sidecars||[]) {
    await ctx.store.setJSON(item.key,item.value);
  }
  ctx.sidecars=[];
  if(!ctx.dirty) return;
  let next=ctx.data;
  for(let attempt=0; attempt<4; attempt++) {
    const latest=await ctx.store.get('store.json',{type:'json'});
    next=latest&&typeof latest==='object' ? mergeStoreData(latest,next) : next;
    normalizeStoreState(next);
    await ctx.store.setJSON('store.json',next);
    await sleep(120+Math.floor(Math.random()*120));
    const persisted=await ctx.store.get('store.json',{type:'json'});
    const verified=persisted&&typeof persisted==='object' ? mergeStoreData(persisted,next) : next;
    normalizeStoreState(verified);
    if(JSON.stringify(persisted||{})===JSON.stringify(verified)) {
      next=verified;
      break;
    }
    next=verified;
    await sleep(80*(attempt+1));
  }
  await ctx.store.setJSON('store.json',next);
  ctx.data=next;
  ctx.dirty=false;
}
async function listCloudJson(store, prefix) {
  const { blobs } = await store.list({ prefix });
  const out=[];
  for(const item of blobs||[]) {
    const value=await store.get(item.key,{type:'json'});
    if(value&&typeof value==='object') out.push(value);
  }
  return out;
}
function applyCloudSessionSidecar(data, session) {
  if(!session||!session.id) return false;
  if(!Array.isArray(data.sessions)) data.sessions=[];
  const existing=data.sessions.find(s=>s.id===session.id);
  const before=JSON.stringify(existing||null);
  if(existing) Object.assign(existing,mergeSession(existing,session));
  else data.sessions.push(session);
  const after=JSON.stringify(existing||session);
  return before!==after;
}
function applyCloudAnswerSidecar(data, item) {
  const sessionId=String(item?.sessionId||'');
  const answer=item?.answer;
  if(!sessionId||!answer||!answer.soundId) return false;
  if(!Array.isArray(data.sessions)) data.sessions=[];
  const session=data.sessions.find(s=>s.id===sessionId);
  if(!session) return false;
  const before=JSON.stringify(session.answers||[]);
  session.answers=mergeAnswers(session.answers,[answer]);
  return before!==JSON.stringify(session.answers||[]);
}
function markCloudDirty(changed) {
  const ctx=activeCloudContext();
  if(ctx&&changed) ctx.dirty=true;
  return changed;
}
async function hydrateCloudSidecars(store, data) {
  let changed=false;
  if(!Array.isArray(data.sessions)) data.sessions=[];
  const sessions=await listCloudJson(store,'sessions/');
  for(const session of sessions) {
    if(applyCloudSessionSidecar(data,session)) changed=true;
  }
  const answers=await listCloudJson(store,'answers/');
  for(const item of answers) {
    if(applyCloudAnswerSidecar(data,item)) changed=true;
  }
  if(changed) normalizeStoreState(data);
  return markCloudDirty(changed);
}
async function hydrateCloudSessionSidecars(data, sessionId) {
  const ctx=activeCloudContext();
  const cleanSessionId=String(sessionId||'').trim();
  if(!ctx||!cleanSessionId) return false;
  let changed=false;
  const session=await ctx.store.get(`sessions/${cleanSessionId}.json`,{type:'json'});
  if(session&&typeof session==='object'&&applyCloudSessionSidecar(data,session)) changed=true;
  const answers=await listCloudJson(ctx.store,`answers/${cleanSessionId}/`);
  for(const item of answers) {
    if(applyCloudAnswerSidecar(data,item)) changed=true;
  }
  if(changed) normalizeStoreState(data);
  return markCloudDirty(changed);
}
async function hydrateCloudUserSidecars(data, userId, options={}) {
  const ctx=activeCloudContext();
  const cleanUserId=String(userId||'').trim();
  if(!ctx||!cleanUserId) return false;
  let changed=false;
  let sessions=await listCloudJson(ctx.store,`user-sessions/${cleanUserId}/`);
  if(!sessions.length&&options.fallbackAll!==false) {
    sessions=(await listCloudJson(ctx.store,'sessions/')).filter(s=>s&&s.userId===cleanUserId);
  }
  for(const session of sessions) {
    if(applyCloudSessionSidecar(data,session)) changed=true;
  }
  const sessionIds=new Set((data.sessions||[]).filter(s=>s&&s.userId===cleanUserId).map(s=>s.id));
  const indexedAnswers=await listCloudJson(ctx.store,`user-answers/${cleanUserId}/`);
  if(indexedAnswers.length) {
    for(const item of indexedAnswers) {
      if(applyCloudAnswerSidecar(data,item)) changed=true;
    }
  } else if(options.fallbackAll!==false) {
    for(const sessionId of sessionIds) {
      const answers=await listCloudJson(ctx.store,`answers/${sessionId}/`);
      for(const item of answers) {
        if(applyCloudAnswerSidecar(data,item)) changed=true;
      }
    }
  }
  if(changed) normalizeStoreState(data);
  return markCloudDirty(changed);
}
function queueCloudSidecar(key, value) {
  const ctx=activeCloudContext();
  if(!ctx) return;
  ctx.sidecars=Array.isArray(ctx.sidecars)?ctx.sidecars:[];
  ctx.sidecars.push({key,value});
}
function queueCloudSessionSidecar(session) {
  if(!isCloudRuntime()||!session?.id||isTestSession(session)) return;
  queueCloudSidecar(`sessions/${session.id}.json`,session);
  if(session.userId) queueCloudSidecar(`user-sessions/${session.userId}/${session.id}.json`,session);
}
function queueCloudAnswerSidecar(session, answer) {
  if(!isCloudRuntime()||!session?.id||!answer?.soundId||isTestSession(session)) return;
  const value={
    sessionId:session.id,
    userId:session.userId,
    answer
  };
  queueCloudSidecar(`answers/${session.id}/${answer.soundId}.json`,value);
  if(session.userId) queueCloudSidecar(`user-answers/${session.userId}/${session.id}/${answer.soundId}.json`,value);
}
function seed() { return {
  sounds: [
    ['地铁报站提示音', ['地铁', '地铁报站', '地铁提示音', '站台'], 'metro'],
    ['下雨声', ['雨', '下雨', '雨声', '暴雨'], 'rain'],
    ['敲击键盘', ['键盘', '打字', '敲键盘', '键盘声'], 'keyboard'],
    ['洗衣机运转', ['洗衣机', '洗衣机声音', '洗衣服'], 'washer'],
    ['蝉鸣', ['蝉', '知了', '蝉叫', '知了叫'], 'cicada']
  ].map(([name, tags, demo], i) => ({ id:`demo-${demo}`, originalName:`${name}.wav`, name, tags, createdAt:new Date(Date.now()-i*86400000).toISOString(), enabled:true, plays:0, correct:0, demo })),
  users: [], sessions: []
}; }
function truthy(value) {
  return ['1','true','yes','on'].includes(String(value||'').trim().toLowerCase());
}
function looksLikeCodexTest(input={}, req={headers:{}}) {
  const ua=String(req.headers['user-agent']||'');
  const deviceId=String(input.deviceId||'');
  const name=String(input.name||'');
  return Boolean(
    truthy(input.testMode)||truthy(input.isTest)||truthy(input.__test)||
    /^codex[-_]|^test[-_]|^playwright[-_]/i.test(deviceId)||
    /codex|playwright|smoke|自动化测试|测试用户/i.test(name)||
    /HeadlessChrome|Playwright|Codex/i.test(ua)
  );
}
function allowVolatileTestMode() {
  return !isCloudRuntime()||envFlag('DX100_ALLOW_CLOUD_TEST_MODE');
}
function isTestRequest(req, url, input={}) {
  return allowVolatileTestMode()&&Boolean(
    truthy(url.searchParams.get('test'))||
    truthy(url.searchParams.get('codexTest'))||
    truthy(req.headers['x-codex-test'])||
    truthy(req.headers['x-voice-game-test'])||
    looksLikeCodexTest(input,req)
  );
}
function isTestUser(u) {
  return Boolean(u?.isTest)||String(u?.id||'').startsWith('test-user-');
}
function isTestSession(s) {
  return Boolean(s?.isTest)||String(s?.id||'').startsWith('test-session-');
}
function testUserPublic(u, sounds) {
  return userPublic(u,sounds,[...TEST_SESSIONS.values()]);
}
const DEFAULT_USER_NAMES = new Set(['匿名玩家','匿名','游客','未命名','无名','无名侦探','头号玩家']);
function cleanUserName(name) {
  return String(name||'').trim().slice(0,20);
}
function displayUserName(name) {
  return cleanUserName(name)||'匿名玩家';
}
function isMergeableUserName(name) {
  const clean=cleanUserName(name);
  return Boolean(clean&&!DEFAULT_USER_NAMES.has(clean));
}
function cleanDeviceId(value) {
  return String(value||'').trim().slice(0,80);
}
function cleanUserAgent(value) {
  return String(value||'').trim().slice(0,240);
}
function browserMajor(version='') {
  const major=String(version||'').split('.')[0];
  return /^\d+$/.test(major) ? major : '';
}
function parseClientInfo(userAgent='') {
  const ua=cleanUserAgent(userAgent);
  let browser='未知', browserVersion='', match;
  const browserRules=[
    ['微信',/MicroMessenger\/(\d+(?:\.\d+)*)/],
    ['Edge',/Edg\/(\d+(?:\.\d+)*)/],
    ['Chrome',/(?:CriOS|Chrome)\/(\d+(?:\.\d+)*)/],
    ['Firefox',/(?:FxiOS|Firefox)\/(\d+(?:\.\d+)*)/],
    ['Safari',/Version\/(\d+(?:\.\d+)*).*Safari/]
  ];
  for(const [name,re] of browserRules) {
    match=ua.match(re);
    if(match) {
      browser=name;
      browserVersion=match[1]||'';
      break;
    }
  }
  let os='未知', osVersion='';
  if((match=ua.match(/iPhone OS ([\d_]+)/))) {
    os='iOS';
    osVersion=match[1].replace(/_/g,'.');
  } else if((match=ua.match(/CPU OS ([\d_]+)/))) {
    os='iPadOS';
    osVersion=match[1].replace(/_/g,'.');
  } else if((match=ua.match(/Android ([\d.]+)/))) {
    os='Android';
    osVersion=match[1];
  } else if((match=ua.match(/Mac OS X ([\d_]+)/))) {
    os='macOS';
    osVersion=match[1].replace(/_/g,'.');
  } else if((match=ua.match(/Windows NT ([\d.]+)/))) {
    os='Windows';
    osVersion=match[1];
  }
  let deviceType='desktop';
  if(/iPhone|Android.*Mobile|Mobile/i.test(ua)) deviceType='mobile';
  else if(/iPad|Tablet|Android/i.test(ua)) deviceType='tablet';
  if(/MicroMessenger/i.test(ua)) deviceType=deviceType==='desktop'?'desktop':deviceType;
  return {
    userAgent:ua,
    os,
    osVersion,
    browser,
    browserVersion,
    browserMajor:browserMajor(browserVersion),
    deviceType
  };
}
function clientLabel(client={}) {
  const os=[client.os,client.osVersion].filter(Boolean).join(' ')||'未知系统';
  const browser=[client.browser,client.browserVersion].filter(Boolean).join(' ')||'未知浏览器';
  return `${os} / ${browser}`;
}
function clientInfoFrom(input={}, req=null, at='') {
  const userAgent=cleanUserAgent(input.userAgent||req?.headers?.['user-agent']||'');
  if(!userAgent) return null;
  return {...parseClientInfo(userAgent), updatedAt:at||new Date().toISOString()};
}
function mergeClientInfo(a=null, b=null) {
  if(!a&&!b) return null;
  if(!a) return {...b};
  if(!b) return {...a};
  return new Date(b.updatedAt||0)>=new Date(a.updatedAt||0) ? {...a,...b} : {...b,...a};
}
function applyUserClientInfo(user, input={}, req=null, at='') {
  if(!user) return false;
  const next=clientInfoFrom(input,req,at);
  if(!next) return false;
  const merged=mergeClientInfo(user.client,next);
  if(JSON.stringify(user.client||null)===JSON.stringify(merged)) return false;
  user.client=merged;
  return true;
}
function deviceIdsFor(...items) {
  const ids=[];
  const add=value=>{
    const id=cleanDeviceId(value);
    if(id&&!ids.includes(id)) ids.push(id);
  };
  for(const item of items) {
    if(!item) continue;
    if(typeof item==='string') add(item);
    else {
      add(item.deviceId);
      if(Array.isArray(item.deviceIds)) item.deviceIds.forEach(add);
    }
  }
  return ids.slice(0,40);
}
function normalizeUserIdentity(user, extraDeviceIds=[]) {
  if(!user) return false;
  let changed=false;
  const name=displayUserName(user.name);
  if(user.name!==name) { user.name=name; changed=true; }
  const deviceId=cleanDeviceId(user.deviceId);
  if(user.deviceId!==deviceId) { user.deviceId=deviceId; changed=true; }
  const deviceIds=deviceIdsFor(user,...extraDeviceIds);
  if(!user.deviceId&&deviceIds.length) { user.deviceId=deviceIds[0]; changed=true; }
  if(JSON.stringify(user.deviceIds||[])!==JSON.stringify(deviceIds)) {
    user.deviceIds=deviceIds;
    changed=true;
  }
  return changed;
}
function findRealUserByDeviceId(data, deviceId) {
  const id=cleanDeviceId(deviceId);
  if(!id) return null;
  return (data.users||[]).find(u=>!isTestUser(u)&&(cleanDeviceId(u.deviceId)===id||deviceIdsFor(u).includes(id)))||null;
}
function findRealUserByName(data, name) {
  const clean=cleanUserName(name);
  if(!isMergeableUserName(clean)) return null;
  return (data.users||[]).find(u=>!isTestUser(u)&&cleanUserName(u.name)===clean)||null;
}
function remapUserReferences(data, userIdMap) {
  let changed=false;
  if(!userIdMap||!userIdMap.size) return false;
  const remap=id=>userIdMap.get(id)||id;
  for(const session of data.sessions||[]) {
    const next=remap(session.userId);
    if(next!==session.userId) { session.userId=next; changed=true; }
  }
  for(const sound of data.sounds||[]) {
    for(const item of Array.isArray(sound.answerHistory)?sound.answerHistory:[]) {
      const next=remap(item.userId);
      if(next!==item.userId) { item.userId=next; changed=true; }
    }
  }
  for(const event of data.analyticsEvents||[]) {
    const next=remap(event.userId);
    if(next!==event.userId) { event.userId=next; changed=true; }
    if(event.details&&typeof event.details==='object') {
      const detailUser=remap(event.details.userId);
      if(detailUser!==event.details.userId) { event.details.userId=detailUser; changed=true; }
    }
  }
  return changed;
}
function mergeUserInto(data, canonical, duplicate) {
  if(!canonical||!duplicate||canonical.id===duplicate.id) return false;
  const canonicalId=canonical.id;
  const canonicalName=isMergeableUserName(canonical.name) ? cleanUserName(canonical.name) : cleanUserName(duplicate.name);
  const total=Number(canonical.total||0)+Number(duplicate.total||0);
  const correct=Number(canonical.correct||0)+Number(duplicate.correct||0);
  const merged=mergeUser(canonical,duplicate);
  Object.assign(canonical,merged,{
    id:canonicalId,
    name:displayUserName(canonicalName),
    deviceId:cleanDeviceId(duplicate.deviceId)||cleanDeviceId(canonical.deviceId),
    total,
    correct
  });
  normalizeUserIdentity(canonical,deviceIdsFor(canonical,duplicate));
  data.users=(data.users||[]).filter(u=>u&&u.id!==duplicate.id);
  remapUserReferences(data,new Map([[duplicate.id,canonicalId]]));
  return true;
}
function mergeDuplicateNamedUsers(data) {
  let changed=false;
  const groups=new Map();
  for(const user of data.users||[]) {
    if(!user||isTestUser(user)) continue;
    normalizeUserIdentity(user);
    if(!isMergeableUserName(user.name)) continue;
    const key=cleanUserName(user.name);
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(user);
  }
  for(const [name,users] of groups.entries()) {
    if(users.length<2) continue;
    const sorted=[...users].sort((a,b)=>
      new Date(a.firstSeen||0)-new Date(b.firstSeen||0) ||
      new Date(b.lastSeen||0)-new Date(a.lastSeen||0)
    );
    const canonical=sorted[0];
    canonical.name=name;
    for(const duplicate of sorted.slice(1)) {
      if(mergeUserInto(data,canonical,duplicate)) changed=true;
    }
  }
  return changed;
}
function syncStoredUserTotals(data) {
  let changed=false;
  const sessions=Array.isArray(data.sessions)?data.sessions:[];
  for(const user of data.users||[]) {
    if(!user||!sessions.some(s=>s.userId===user.id)) continue;
    const totals=userAnswerTotals(user,sessions);
    if(Number(user.total||0)!==totals.total) {
      user.total=totals.total;
      changed=true;
    }
    if(Number(user.correct||0)!==totals.correct) {
      user.correct=totals.correct;
      changed=true;
    }
  }
  return changed;
}
function syncStoredUserAnswers(data) {
  let changed=false;
  const sessions=Array.isArray(data.sessions)?data.sessions:[];
  for(const user of data.users||[]) {
    if(!user||isTestUser(user)) continue;
    const ids=[...new Set(sessions
      .filter(session=>session&&session.userId===user.id&&!isTestSession(session))
      .flatMap(session=>Array.isArray(session.answers)?session.answers:[])
      .map(answer=>answer&&answer.soundId)
      .filter(Boolean))];
    if(JSON.stringify(user.answers||[])!==JSON.stringify(ids)) {
      user.answers=ids;
      changed=true;
    }
  }
  return changed;
}
function getUserById(data, id) {
  return data.users.find(u=>u.id===id)||TEST_USERS.get(id)||null;
}
function getSessionById(data, id) {
  return data.sessions.find(s=>s.id===id)||TEST_SESSIONS.get(id)||null;
}
function sessionsFor(data, entity) {
  const base=data.sessions||[];
  if(isTestUser(entity)||isTestSession(entity)) return [...base,...TEST_SESSIONS.values()];
  return base;
}
function upsertTestUser(input={}) {
  const now=new Date().toISOString();
  const deviceId=String(input.deviceId||`codex-test-${crypto.randomUUID()}`).slice(0,80);
  let u=[...TEST_USERS.values()].find(x=>x.deviceId===deviceId);
  if(!u) {
    u={id:`test-user-${crypto.randomUUID()}`,deviceId,name:(input.name||'Codex 测试用户').slice(0,20),firstSeen:now,lastSeen:now,total:0,correct:0,answers:[],playthrough:1,libraryCompletionPending:null,libraryCompletionShown:[],isTest:true};
    TEST_USERS.set(u.id,u);
  } else {
    u.name=(input.name||u.name).slice(0,20);
    u.lastSeen=now;
  }
  return u;
}
function upsertRealUser(data, input={}) {
  const now=new Date().toISOString();
  const deviceId=cleanDeviceId(input.deviceId);
  const inputName=cleanUserName(input.name);
  if(!deviceId) return null;
  const byDevice=findRealUserByDeviceId(data,deviceId);
  const byName=isMergeableUserName(inputName) ? findRealUserByName(data,inputName) : null;
  let u=byName||byDevice;
  if(byName&&byDevice&&byName.id!==byDevice.id) {
    mergeUserInto(data,byName,byDevice);
    u=byName;
  }
  if(!u) {
    u={id:crypto.randomUUID(),deviceId,name:displayUserName(inputName),firstSeen:now,lastSeen:now,total:0,correct:0,answers:[],playthrough:1,libraryCompletionPending:null,libraryCompletionShown:[],deviceIds:[deviceId]};
    applyUserClientInfo(u,input,null,now);
    data.users.push(u);
  } else {
    if(inputName) u.name=inputName;
    u.deviceId=deviceId;
    normalizeUserIdentity(u,[deviceId]);
    applyUserClientInfo(u,input,null,now);
    u.lastSeen=now;
  }
  return u;
}
function answerHistoryId(soundId, sessionId, at, answer) {
  return crypto.createHash('sha1').update([soundId, sessionId, at, answer].join('|')).digest('hex').slice(0,16);
}
function answerHistoryKey(soundId, sessionId, at, answer) {
  return [soundId||'', sessionId||'', at||'', String(answer||'').trim()].join('|');
}
function answerHistoryRecord(soundId, session, answer) {
  const text=String(answer?.answer||'').trim();
  if(!text) return null;
  const at=answer?.at||session?.startedAt||new Date().toISOString();
  const sessionId=session?.id||answer?.sessionId||'';
  return {
    id:answerHistoryId(soundId,sessionId,at,text),
    sessionId,
    userId:session?.userId||answer?.userId||'',
    answer:text.slice(0,500),
    correct:Boolean(answer?.correct),
    at
  };
}
function buildAnswerTextStats(sound) {
  const stats=new Map();
  for(const h of Array.isArray(sound.answerHistory)?sound.answerHistory:[]) {
    const answer=String(h?.answer||'').trim();
    if(!answer) continue;
    const current=stats.get(answer)||{
      answer,
      count:0,
      correctCount:0,
      incorrectCount:0,
      latestAt:'',
      firstAt:''
    };
    current.count++;
    if(h.correct) current.correctCount++;
    else current.incorrectCount++;
    const at=h.at||'';
    if(at&&(!current.latestAt||new Date(at)>new Date(current.latestAt))) current.latestAt=at;
    if(at&&(!current.firstAt||new Date(at)<new Date(current.firstAt))) current.firstAt=at;
    stats.set(answer,current);
  }
  return [...stats.values()].sort((a,b) =>
    b.count-a.count ||
    new Date(b.latestAt||0)-new Date(a.latestAt||0) ||
    a.answer.localeCompare(b.answer,'zh-CN')
  );
}
function refreshAnswerTextStats(sound) {
  const next=buildAnswerTextStats(sound);
  const changed=JSON.stringify(sound.answerTextStats||[])!==JSON.stringify(next);
  sound.answerTextStats=next;
  return changed;
}
function syncSoundAnswerTotals(sound) {
  const history=Array.isArray(sound.answerHistory)?sound.answerHistory:[];
  const plays=history.length;
  const correct=history.filter(h=>h&&h.correct).length;
  let changed=false;
  if(Number(sound.plays||0)!==plays) {
    sound.plays=plays;
    changed=true;
  }
  if(Number(sound.correct||0)!==correct) {
    sound.correct=correct;
    changed=true;
  }
  return changed;
}
function appendSoundAnswerHistory(sound, session, answer) {
  if(!sound) return false;
  const rec=answerHistoryRecord(sound.id,session,answer);
  if(!rec) return false;
  sound.answerHistory=Array.isArray(sound.answerHistory)?sound.answerHistory:[];
  const key=answerHistoryKey(sound.id,rec.sessionId,rec.at,rec.answer);
  if(sound.answerHistory.some(h=>answerHistoryKey(sound.id,h.sessionId,h.at,h.answer)===key)) return false;
  sound.answerHistory.push(rec);
  refreshAnswerTextStats(sound);
  return true;
}
function normalizeAnswerHistory(data) {
  let changed=false;
  const sounds=Array.isArray(data.sounds)?data.sounds:[];
  const byId=new Map(sounds.map(s=>[s.id,s]));
  const sessionKeysBySound=new Map();
  const sessionRecordsBySound=new Map();
  const sessionIds=new Set();
  for(const session of Array.isArray(data.sessions)?data.sessions:[]) {
    if(session?.id) sessionIds.add(session.id);
    for(const answer of Array.isArray(session.answers)?session.answers:[]) {
      const sound=byId.get(answer.soundId);
      if(!sound) continue;
      const rec=answerHistoryRecord(sound.id,session,answer);
      if(!rec) continue;
      const key=answerHistoryKey(sound.id,rec.sessionId,rec.at,rec.answer);
      if(!sessionKeysBySound.has(sound.id)) sessionKeysBySound.set(sound.id,new Set());
      sessionKeysBySound.get(sound.id).add(key);
      if(!sessionRecordsBySound.has(sound.id)) sessionRecordsBySound.set(sound.id,new Map());
      sessionRecordsBySound.get(sound.id).set(key,rec);
    }
  }
  const seenBySound=new Map();
  for(const sound of sounds) {
    const clean=[], seen=new Set();
    const validSessionKeys=sessionKeysBySound.get(sound.id)||new Set();
    for(const raw of Array.isArray(sound.answerHistory)?sound.answerHistory:[]) {
      const answer=String(raw?.answer||'').trim();
      if(!answer) { changed=true; continue; }
      const at=raw.at||raw.createdAt||new Date(0).toISOString();
      const sessionId=String(raw.sessionId||'');
      const rec={
        id:raw.id||answerHistoryId(sound.id,sessionId,at,answer),
        sessionId,
        userId:String(raw.userId||''),
        answer:answer.slice(0,500),
        correct:Boolean(raw.correct),
        at
      };
      const key=answerHistoryKey(sound.id,rec.sessionId,rec.at,rec.answer);
      if(rec.sessionId&&sessionIds.has(rec.sessionId)&&!validSessionKeys.has(key)) { changed=true; continue; }
      const sessionRec=sessionRecordsBySound.get(sound.id)?.get(key);
      if(sessionRec&&rec.correct!==Boolean(sessionRec.correct)) {
        rec.correct=Boolean(sessionRec.correct);
        changed=true;
      }
      if(seen.has(key)) { changed=true; continue; }
      seen.add(key);
      clean.push(rec);
    }
    if(!Array.isArray(sound.answerHistory)||clean.length!==sound.answerHistory.length) changed=true;
    sound.answerHistory=clean;
    seenBySound.set(sound.id,seen);
  }
  for(const session of Array.isArray(data.sessions)?data.sessions:[]) {
    for(const answer of Array.isArray(session.answers)?session.answers:[]) {
      const sound=byId.get(answer.soundId);
      if(!sound) continue;
      const rec=answerHistoryRecord(sound.id,session,answer);
      if(!rec) continue;
      const seen=seenBySound.get(sound.id)||new Set();
      const key=answerHistoryKey(sound.id,rec.sessionId,rec.at,rec.answer);
      if(seen.has(key)) continue;
      sound.answerHistory.push(rec);
      seen.add(key);
      seenBySound.set(sound.id,seen);
      changed=true;
    }
  }
  for(const sound of sounds) {
    if(refreshAnswerTextStats(sound)) changed=true;
    if(syncSoundAnswerTotals(sound)) changed=true;
  }
  return changed;
}
function cleanRecoveredAnswer(value) {
  return String(value||'').trim().replace(/\s+/g,' ');
}
function monitorDetails(event) {
  return event?.details&&typeof event.details==='object' ? event.details : {};
}
function monitorEventKey(event) {
  return String(event?.id||[event?.at||'',event?.type||'',event?.details?.answer||''].join('|'));
}
function buildMonitorAnswerContext(session) {
  const validSoundIds=new Set(session.soundIds||[]);
  const events=[...(Array.isArray(session.monitor)?session.monitor:[])].sort((a,b)=>new Date(a.at||0)-new Date(b.at||0));
  const responses=new Map();
  const submissions=[];
  let currentSoundId='';
  let lastSubmission=null;
  for(const event of events) {
    const details=monitorDetails(event);
    if(details.soundId&&validSoundIds.has(details.soundId)) currentSoundId=details.soundId;
    if(event.type==='question_rendered'&&details.soundId&&validSoundIds.has(details.soundId)) currentSoundId=details.soundId;
    if(event.type==='answer_submit'&&details.answer) {
      const soundId=validSoundIds.has(details.soundId) ? details.soundId : currentSoundId;
      const submission={
        event,
        soundId,
        answer:details.answer,
        cleanAnswer:cleanRecoveredAnswer(details.answer),
        inputMode:details.inputMode||'text',
        at:event.at||''
      };
      if(soundId) submissions.push(submission);
      lastSubmission=submission;
    }
    if(event.type==='answer_response'&&details.recorded&&details.answer) {
      const responseAnswer=cleanRecoveredAnswer(details.answer);
      let soundId=validSoundIds.has(details.soundId) ? details.soundId : '';
      const matchedSubmission=Boolean(lastSubmission&&lastSubmission.cleanAnswer===responseAnswer&&(!soundId||lastSubmission.soundId===soundId));
      if(!soundId&&matchedSubmission) soundId=lastSubmission.soundId;
      responses.set(monitorEventKey(event),{
        event,
        soundId,
        answer:details.answer,
        cleanAnswer:responseAnswer,
        inputMode:details.inputMode||lastSubmission?.inputMode||'text',
        at:event.at||'',
        matchedSubmission
      });
      lastSubmission=null;
    }
  }
  return {events,responses,submissions,validSoundIds};
}
function repairTextAnswersFromSubmissions(data, session) {
  if(!session||!Array.isArray(session.answers)||!Array.isArray(session.monitor)||!Array.isArray(session.soundIds)) return false;
  const soundsById=new Map((data.sounds||[]).map(s=>[s.id,s]));
  const {submissions,validSoundIds}=buildMonitorAnswerContext(session);
  if(!submissions.length) return false;
  let changed=false;
  const repairedNow=new Date().toISOString();
  for(const answer of session.answers) {
    if(!answer||answer.removed||answer.audioAnswerId||answer.inputMode==='voice'||!validSoundIds.has(answer.soundId)) continue;
    const actual=[...submissions].reverse().find(item=>item.soundId===answer.soundId&&item.cleanAnswer);
    if(!actual) continue;
    const current=cleanRecoveredAnswer(answer.answer);
    const sameAnswer=actual.cleanAnswer===current;
    if(sameAnswer&&!answer.recovered) continue;
    const sound=soundsById.get(answer.soundId);
    if(!sound) continue;
    const previousAnswer=answer.answer||'';
    const previousCorrect=Boolean(answer.correct);
    const result=sameAnswer ? {correct:Boolean(answer.correct)} : judgeAnswer(sound,actual.answer);
    if(!sameAnswer) answer.answer=String(actual.answer||'').trim().slice(0,500);
    if(!sameAnswer) answer.correct=result.correct;
    answer.at=actual.at||answer.at;
    answer.inputMode=actual.inputMode||answer.inputMode||'text';
    answer.repairedFromSubmit=true;
    answer.repairedAt=repairedNow;
    answer.repairedPreviousAnswer=String(previousAnswer).slice(0,120);
    answer.repairedPreviousCorrect=previousCorrect;
    delete answer.recovered;
    delete answer.recoveredFromEventId;
    appendMonitor(session,'server','answer_submit_repaired','已用同题提交文本修正答题记录',{
      soundId:answer.soundId,
      answer:answer.answer.slice(0,80),
      previousAnswer:String(previousAnswer).slice(0,80)
    });
    if(!isTestSession(session)) queueCloudAnswerSidecar(session,answer);
    changed=true;
  }
  return changed;
}
function repairRecoveredAnswerDrift(data, session) {
  if(!session||!Array.isArray(session.answers)||!Array.isArray(session.monitor)||!Array.isArray(session.soundIds)) return false;
  const soundsById=new Map((data.sounds||[]).map(s=>[s.id,s]));
  const {responses,submissions,validSoundIds}=buildMonitorAnswerContext(session);
  let changed=false;
  const repairedNow=new Date().toISOString();
  const nextAnswers=[];
  for(const answer of session.answers) {
    let keepAnswer=true;
    if(!answer?.recovered||!answer.recoveredFromEventId||!validSoundIds.has(answer.soundId)) {
      nextAnswers.push(answer);
      continue;
    }
    const response=responses.get(String(answer.recoveredFromEventId));
    const cleanAnswer=cleanRecoveredAnswer(answer.answer);
    const invalidRecovery=!response||!response.matchedSubmission;
    const drifted=response&&response.soundId&&response.soundId!==answer.soundId&&response.cleanAnswer===cleanAnswer;
    if(!drifted&&!invalidRecovery) {
      nextAnswers.push(answer);
      continue;
    }
    const recoveredAt=eventTime({at:answer.at});
    const actual=submissions.find(item =>
      item.soundId===answer.soundId &&
      item.cleanAnswer &&
      eventTime(item.event)>=recoveredAt-1000 &&
      eventTime(item.event)<=recoveredAt+30*60*1000
    );
    if(!actual) {
      const tombstone={
        soundId:answer.soundId,
        removed:true,
        at:repairedNow,
        updatedAt:repairedNow,
        repairedFromRecovery:true,
        repairedFromEventId:String(answer.recoveredFromEventId),
        repairedFromSoundId:String(response?.soundId||'')
      };
      appendMonitor(session,'server','answer_recovery_removed','已移除错误恢复到本题的答题记录',{
        soundId:answer.soundId,
        fromSoundId:response?.soundId||'',
        eventId:response?.event?.id||''
      });
      if(!isTestSession(session)) queueCloudAnswerSidecar(session,tombstone);
      keepAnswer=false;
      changed=true;
    } else {
      const sound=soundsById.get(answer.soundId);
      if(!sound) {
        nextAnswers.push(answer);
        continue;
      }
      const result=judgeAnswer(sound,actual.answer);
      answer.answer=String(actual.answer||'').trim().slice(0,500);
      answer.correct=result.correct;
      answer.at=actual.at||answer.at;
      answer.inputMode=actual.inputMode||'text';
      answer.repairedFromRecovery=true;
      answer.repairedAt=repairedNow;
      answer.repairedFromEventId=String(answer.recoveredFromEventId);
      answer.repairedFromSoundId=String(response?.soundId||'');
      delete answer.recovered;
      delete answer.recoveredFromEventId;
      appendMonitor(session,'server','answer_recovery_repaired','已用同题文字提交修正错误恢复的答题记录',{
        soundId:answer.soundId,
        fromSoundId:response?.soundId||'',
        eventId:response?.event?.id||'',
        answer:answer.answer.slice(0,80)
      });
      if(!isTestSession(session)) queueCloudAnswerSidecar(session,answer);
      changed=true;
    }
    if(keepAnswer) nextAnswers.push(answer);
  }
  if(changed) session.answers=nextAnswers;
  return changed;
}
function rejudgeStoredAnswers(data) {
  let changed=false;
  const soundsById=new Map((data.sounds||[]).map(s=>[s.id,s]));
  const now=new Date().toISOString();
  for(const session of data.sessions||[]) {
    if(!session||isTestSession(session)||!Array.isArray(session.answers)) continue;
    for(const answer of session.answers) {
      if(!answer||answer.removed||!String(answer.answer||'').trim()) continue;
      const sound=soundsById.get(answer.soundId);
      if(!sound) continue;
      const result=judgeAnswer(sound,answer.answer);
      if(Boolean(answer.correct)===Boolean(result.correct)) continue;
      answer.rejudgedAt=now;
      answer.rejudgedPreviousCorrect=Boolean(answer.correct);
      answer.correct=Boolean(result.correct);
      appendMonitor(session,'server','answer_rejudged','已按当前题目标签重新计算答题结果',{
        soundId:answer.soundId,
        answer:String(answer.answer||'').slice(0,80),
        correct:answer.correct
      });
      queueCloudAnswerSidecar(session,answer);
      changed=true;
    }
  }
  return changed;
}
function recoverAnswersFromMonitor(data, session) {
  if(!session||!Array.isArray(session.monitor)||!Array.isArray(session.soundIds)) return false;
  session.answers=Array.isArray(session.answers)?session.answers:[];
  const answered=new Set(session.answers.map(a=>a&&a.soundId).filter(Boolean));
  const usedRecoveryEvents=new Set(session.answers.map(a=>a&&a.recoveredFromEventId).filter(Boolean));
  const soundsById=new Map((data.sounds||[]).map(s=>[s.id,s]));
  const {events,responses,validSoundIds}=buildMonitorAnswerContext(session);
  let changed=false;
  const recover=(soundId, answer, event, inputMode='text') => {
    const eventKey=monitorEventKey(event);
    if(eventKey&&usedRecoveryEvents.has(eventKey)) return false;
    const cleanSoundId=String(soundId||'');
    const text=String(answer||'').trim();
    if(!cleanSoundId||!text||answered.has(cleanSoundId)||!validSoundIds.has(cleanSoundId)) return false;
    const sound=soundsById.get(cleanSoundId);
    if(!sound) return false;
    const recorded=recordJudgedAnswer(data,session,sound,text,{
      inputMode,
      at:event?.at||new Date().toISOString(),
      recovered:true,
      recoveredFromEventId:eventKey
    });
    if(!recorded.ok) return false;
    answered.add(cleanSoundId);
    if(eventKey) usedRecoveryEvents.add(eventKey);
    appendMonitor(session,'server','answer_recovered','从客户端成功响应事件恢复答题记录',{soundId:cleanSoundId,answer:text.slice(0,80),eventId:event?.id||'',eventType:event?.type||''});
    return true;
  };
  for(const event of events) {
    const details=monitorDetails(event);
    if(event.type==='answer_response'&&details.recorded&&details.answer) {
      const response=responses.get(monitorEventKey(event));
      if(!response?.matchedSubmission) continue;
      if(recover(response?.soundId||'',response?.answer||'',event,response?.inputMode||'text')) changed=true;
    }
  }
  return changed;
}
function normalizeStoreState(data) {
  let changed=false;
  if(!Array.isArray(data.sounds)) { data.sounds=[]; changed=true; }
  if(!Array.isArray(data.users)) { data.users=[]; changed=true; }
  if(!Array.isArray(data.sessions)) { data.sessions=[]; changed=true; }
  if(!Array.isArray(data.analyticsEvents)) { data.analyticsEvents=[]; changed=true; }
  for(const sound of data.sounds) {
    if(typeof sound.listens!=='number') {
      sound.listens=Number(sound.plays||0);
      changed=true;
    }
  }
  for(const user of data.users) {
    if(normalizeUserIdentity(user)) changed=true;
    const playthrough=Number(user.playthrough||1);
    if(!Number.isFinite(playthrough)||playthrough<1||Math.floor(playthrough)!==user.playthrough) {
      user.playthrough=Number.isFinite(playthrough)&&playthrough>=1 ? Math.floor(playthrough) : 1;
      changed=true;
    }
    if(!Array.isArray(user.answers)) { user.answers=[]; changed=true; }
    if(!Array.isArray(user.libraryCompletionShown)) { user.libraryCompletionShown=[]; changed=true; }
    const cleanShown=mergeCompletionShown(user.libraryCompletionShown,[]);
    if(JSON.stringify(user.libraryCompletionShown)!==JSON.stringify(cleanShown)) {
      user.libraryCompletionShown=cleanShown;
      changed=true;
    }
    if(user.libraryCompletionPending&&typeof user.libraryCompletionPending!=='object') {
      user.libraryCompletionPending=null;
      changed=true;
    }
  }
  if(mergeDuplicateNamedUsers(data)) changed=true;
  for(const session of data.sessions) {
    const playthrough=Number(session.playthrough||1);
    if(!Number.isFinite(playthrough)||playthrough<1||Math.floor(playthrough)!==session.playthrough) {
      session.playthrough=Number.isFinite(playthrough)&&playthrough>=1 ? Math.floor(playthrough) : 1;
      changed=true;
    }
    if(!Array.isArray(session.audioAnswers)) { session.audioAnswers=[]; changed=true; }
    for(const answer of session.audioAnswers) {
      const processingStale=answer&&answer.status==='processing'&&Date.now()-new Date(answer.updatedAt||answer.createdAt||0).getTime()>120000;
      if(processingStale) {
        answer.status='queued';
        answer.updatedAt=new Date().toISOString();
        changed=true;
      }
    }
  }
  for(const session of data.sessions) {
    if(repairTextAnswersFromSubmissions(data,session)) changed=true;
    if(repairRecoveredAnswerDrift(data,session)) changed=true;
    if(recoverAnswersFromMonitor(data,session)) changed=true;
  }
  if(rejudgeStoredAnswers(data)) changed=true;
  for(const user of data.users) {
    if(normalizeUserProgressState(data,user)) changed=true;
  }
  if(syncStoredUserAnswers(data)) changed=true;
  if(syncStoredUserTotals(data)) changed=true;
  if(data.analyticsEvents.length>ANALYTICS_MAX_EVENTS) {
    data.analyticsEvents=data.analyticsEvents.slice(-ANALYTICS_MAX_EVENTS);
    changed=true;
  }
  if(normalizeAnswerHistory(data)) changed=true;
  return changed;
}
function readStore() {
  const cloud=activeCloudContext();
  if(cloud) {
    if(!cloud.data) cloud.data=seed();
    if(normalizeStoreState(cloud.data)) cloud.dirty=true;
    return cloud.data;
  }
  if(!fs.existsSync(STORE)) {
    const d=seed();
    normalizeStoreState(d);
    writeStore(d,{replace:true});
    return d;
  }
  const d=JSON.parse(fs.readFileSync(STORE,'utf8'));
  if(normalizeStoreState(d)) writeStore(d);
  return d;
}
function readEventJournal() { try { const value=JSON.parse(fs.readFileSync(EVENTS_STORE,'utf8')); return Array.isArray(value)?value:[]; } catch { return []; } }
function writeEventJournal(events) { fs.mkdirSync(path.dirname(EVENTS_STORE),{recursive:true}); fs.writeFileSync(EVENTS_STORE,JSON.stringify((events||[]).slice(-ANALYTICS_MAX_EVENTS),null,2)); }
function minIso(a,b) {
  if(!a) return b||'';
  if(!b) return a||'';
  return new Date(a) <= new Date(b) ? a : b;
}
function maxIso(a,b) {
  if(!a) return b||'';
  if(!b) return a||'';
  return new Date(a) >= new Date(b) ? a : b;
}
function answerRevisionTime(answer={}) {
  const t=new Date(answer.updatedAt||answer.rejudgedAt||answer.repairedAt||answer.at||0).getTime();
  return Number.isFinite(t) ? t : 0;
}
function byIdMerge(base=[], incoming=[], mergeItem=(a,b)=>({...a,...b})) {
  const out=[], map=new Map();
  for(const item of Array.isArray(base)?base:[]) {
    if(item&&item.id) map.set(item.id,{...item});
    else out.push(item);
  }
  for(const item of Array.isArray(incoming)?incoming:[]) {
    if(item&&item.id) map.set(item.id,map.has(item.id)?mergeItem(map.get(item.id),item):{...item});
    else out.push(item);
  }
  return [...map.values(),...out];
}
function mergeAnswers(a=[], b=[]) {
  const map=new Map();
  for(const answer of [...(Array.isArray(a)?a:[]),...(Array.isArray(b)?b:[])]) {
    if(!answer) continue;
    const key=answer.soundId||[answer.at,answer.answer].join('|');
    const prev=map.get(key);
    if(!prev||answerRevisionTime(answer)>=answerRevisionTime(prev)) map.set(key,{...prev,...answer});
  }
  return [...map.values()].filter(answer=>!answer.removed).sort((x,y)=>new Date(x.at||0)-new Date(y.at||0));
}
function mergeAudioAnswers(a=[], b=[]) {
  const map=new Map();
  for(const answer of [...(Array.isArray(a)?a:[]),...(Array.isArray(b)?b:[])]) {
    if(!answer) continue;
    const key=answer.id||[answer.sessionId,answer.soundId,answer.createdAt,answer.audioFile].join('|');
    const prev=map.get(key);
    if(!prev||new Date(answer.updatedAt||answer.createdAt||0)>=new Date(prev.updatedAt||prev.createdAt||0)) map.set(key,{...prev,...answer});
  }
  return [...map.values()].sort((x,y)=>new Date(x.createdAt||0)-new Date(y.createdAt||0));
}
function mergeMonitor(a=[], b=[]) {
  return byIdMerge(a,b,(x,y)=>({...x,...y})).sort((x,y)=>new Date(x.at||0)-new Date(y.at||0));
}
function mergeAnswerHistory(a=[], b=[]) {
  const map=new Map();
  for(const item of [...(Array.isArray(a)?a:[]),...(Array.isArray(b)?b:[])]) {
    if(!item) continue;
    const key=item.id||answerHistoryKey('',item.sessionId,item.at,item.answer);
    if(!map.has(key)||new Date(item.at||0)>=new Date(map.get(key).at||0)) map.set(key,{...item});
  }
  return [...map.values()].sort((x,y)=>new Date(x.at||0)-new Date(y.at||0));
}
function mergeSound(a={}, b={}) {
  return {
    ...a,
    ...b,
    plays:Math.max(Number(a.plays||0),Number(b.plays||0)),
    correct:Math.max(Number(a.correct||0),Number(b.correct||0)),
    listens:Math.max(Number(a.listens||0),Number(b.listens||0)),
    answerHistory:mergeAnswerHistory(a.answerHistory,b.answerHistory)
  };
}
function completionShownKey(item={}) {
  return [Number(item.playthrough||0)||0,String(item.sessionId||''),String(item.completedAt||'')].join('|');
}
function mergeCompletionShown(a=[], b=[]) {
  const map=new Map();
  for(const item of [...(Array.isArray(a)?a:[]),...(Array.isArray(b)?b:[])]) {
    if(!item) continue;
    const key=completionShownKey(item);
    const prev=map.get(key);
    if(!prev||new Date(item.shownAt||item.completedAt||0)>=new Date(prev.shownAt||prev.completedAt||0)) map.set(key,{...prev,...item});
  }
  return [...map.values()].sort((x,y)=>new Date(x.completedAt||x.shownAt||0)-new Date(y.completedAt||y.shownAt||0));
}
function mergeUser(a={}, b={}) {
  const deviceIds=deviceIdsFor(a,b);
  const name=cleanUserName(b.name)||cleanUserName(a.name)||'匿名玩家';
  const hasIncomingPending=Object.prototype.hasOwnProperty.call(b,'libraryCompletionPending');
  return {
    ...a,
    ...b,
    name,
    deviceId:cleanDeviceId(b.deviceId)||cleanDeviceId(a.deviceId)||deviceIds[0]||'',
    deviceIds,
    firstSeen:minIso(a.firstSeen,b.firstSeen),
    lastSeen:maxIso(a.lastSeen,b.lastSeen),
    total:Math.max(Number(a.total||0),Number(b.total||0)),
    correct:Math.max(Number(a.correct||0),Number(b.correct||0)),
    answers:[...new Set([...(a.answers||[]),...(b.answers||[])])],
    client:mergeClientInfo(a.client,b.client),
    libraryCompletionPending:hasIncomingPending ? b.libraryCompletionPending : (a.libraryCompletionPending||null),
    libraryCompletionShown:mergeCompletionShown(a.libraryCompletionShown,b.libraryCompletionShown)
  };
}
function mergeSession(a={}, b={}) {
  return {
    ...a,
    ...b,
    startedAt:minIso(a.startedAt,b.startedAt),
    soundIds:[...new Set([...(a.soundIds||[]),...(b.soundIds||[])])],
    answers:mergeAnswers(a.answers,b.answers),
    audioAnswers:mergeAudioAnswers(a.audioAnswers,b.audioAnswers),
    monitor:mergeMonitor(a.monitor,b.monitor)
  };
}
function mergeStoreData(base={}, incoming={}) {
  const merged={
    ...base,
    ...incoming,
    sounds:byIdMerge(base.sounds,incoming.sounds,mergeSound),
    users:byIdMerge(base.users,incoming.users,mergeUser),
    sessions:byIdMerge(base.sessions,incoming.sessions,mergeSession),
    analyticsEvents:byIdMerge(base.analyticsEvents,incoming.analyticsEvents,(a,b)=>({...a,...b}))
      .sort((a,b)=>new Date(a.at||0)-new Date(b.at||0))
      .slice(-ANALYTICS_MAX_EVENTS)
  };
  normalizeStoreState(merged);
  return merged;
}
function writeStore(data, options={}) {
  const cloud=activeCloudContext();
  if(cloud) {
    const next=!options.replace&&cloud.data ? mergeStoreData(cloud.data,data) : data;
    normalizeStoreState(next);
    cloud.data=next;
    cloud.dirty=true;
    return;
  }
  fs.mkdirSync(path.dirname(STORE), {recursive:true});
  const latest=!options.replace&&fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE,'utf8')) : null;
  const next=latest ? mergeStoreData(latest,data) : data;
  normalizeStoreState(next);
  const temp=`${STORE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2));
  fs.renameSync(temp, STORE);
}
function cleanupRuntimeMaps() {
  const now=Date.now();
  if(RATE_LIMIT_BUCKETS.size>3000) {
    for(const [key,bucket] of RATE_LIMIT_BUCKETS.entries()) {
      if(!bucket.last||now-bucket.last>120000) RATE_LIMIT_BUCKETS.delete(key);
    }
  }
  if(REQUEST_GUARDS.size>2000) {
    for(const [key,guard] of REQUEST_GUARDS.entries()) {
      if(!guard.inFlight&&(!guard.expiresAt||now>guard.expiresAt)) REQUEST_GUARDS.delete(key);
    }
  }
}
function clientIp(req) {
  const forwarded=String(req.headers['cf-connecting-ip']||req.headers['x-real-ip']||req.headers['x-forwarded-for']||'').split(',')[0].trim();
  return forwarded||req.socket?.remoteAddress||'unknown-ip';
}
function requestIdentity(req,input={}) {
  return String(input.sessionId||input.userId||input.deviceId||clientIp(req)||'anonymous').slice(0,120);
}
function requestKey(req,url,input={},scope='') {
  const sound=input.soundId?`:sound:${String(input.soundId).slice(0,80)}`:'';
  return [req.method,url.pathname,clientIp(req),requestIdentity(req,input),scope].filter(Boolean).join('|')+sound;
}
function takeRateLimit(key,{windowMs=1000,max=1,minIntervalMs=0}={}) {
  const now=Date.now();
  const bucket=RATE_LIMIT_BUCKETS.get(key)||{hits:[],last:0};
  bucket.hits=bucket.hits.filter(t=>now-t<windowMs);
  if(minIntervalMs&&bucket.last&&now-bucket.last<minIntervalMs) {
    bucket.last=now;
    RATE_LIMIT_BUCKETS.set(key,bucket);
    return false;
  }
  if(bucket.hits.length>=max) {
    bucket.last=now;
    RATE_LIMIT_BUCKETS.set(key,bucket);
    return false;
  }
  bucket.hits.push(now);
  bucket.last=now;
  RATE_LIMIT_BUCKETS.set(key,bucket);
  cleanupRuntimeMaps();
  return true;
}
function enterRequestGuard(key,cooldownMs=0,ttlMs=60000) {
  const now=Date.now();
  const guard=REQUEST_GUARDS.get(key);
  if(guard?.inFlight) return false;
  if(guard?.doneAt&&cooldownMs&&now-guard.doneAt<cooldownMs) return false;
  REQUEST_GUARDS.set(key,{inFlight:true,startedAt:now,doneAt:0,expiresAt:now+ttlMs});
  cleanupRuntimeMaps();
  return true;
}
function leaveRequestGuard(key,cooldownMs=0,ttlMs=60000) {
  if(!key) return;
  const now=Date.now();
  REQUEST_GUARDS.set(key,{inFlight:false,doneAt:now,expiresAt:now+Math.max(ttlMs,cooldownMs+1000)});
}
function sendRateLimited(res,message='操作太频繁，请稍后再试',retryAfterMs=1000) {
  return send(res,429,{error:message,retryAfterMs},{'Retry-After':String(Math.max(1,Math.ceil(retryAfterMs/1000)))});
}
function analyticsRateLimited(req,url,input={}) {
  const details=input.details&&typeof input.details==='object'?input.details:{};
  const identity=requestIdentity(req,input);
  const globalKey=`analytics:${clientIp(req)}:${identity}`;
  if(!takeRateLimit(globalKey,{windowMs:60000,max:120,minIntervalMs:0})) return true;
  const type=String(input.type||'event').slice(0,80);
  const scopedKey=`analytics:${clientIp(req)}:${identity}:${type}:${details.soundId||''}:${details.url||''}:${input.page||''}`;
  return !takeRateLimit(scopedKey,{windowMs:1000,max:4,minIntervalMs:180});
}
function send(res, status, data, headers={}) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', ...headers}); res.end(JSON.stringify(data)); }
function body(req) { return new Promise((resolve,reject) => { let chunks=[]; let size=0; req.on('data', c=>{size+=c.length; if(size>15*1024*1024) reject(Error('文件不能超过15MB')); else chunks.push(c)}); req.on('end',()=>resolve(Buffer.concat(chunks))); req.on('error',reject); }); }
const SEMANTIC_INTENTS = {
  'sound-breaking-a-cup': ['杯子摔碎','杯子碎了','打碎杯子','玻璃杯碎','玻璃碎','杯子破了','碎裂','摔杯子','砸杯子','打碎玻璃','玻璃打碎','阿碎玻璃'],
  'sound-door-chime': ['门铃','按门铃','门铃响','铃声','叮咚','有人按门铃'],
  'sound-entering-a-house': ['进门','开门进屋','开门进来','开门回家','回家开门','进屋','入门','房门打开','打开木门'],
  'sound-knocking-an-iron-door': ['敲铁门','敲门','拍门','门响','铁门响','铁门声','有人敲门','敲门声'],
  'sound-lighting-a-match': ['划火柴','擦火柴','点火柴','火柴点燃','点燃火柴','火柴','划着火柴'],
  'sound-out-of-a-toilet': ['马桶冲水','冲马桶','厕所冲水','卫生间冲水','抽水马桶','冲水','上厕所冲水','马桶'],
  'sound-scissors': ['剪刀','剪东西','剪纸','裁剪','剪开','用剪刀','剪刀剪'],
  'sound-vinyl-bag': ['塑料袋','揉塑料袋','搓塑料袋','塑料袋揉搓','袋子揉搓','包装袋','塑料包装','塑料声'],
  'sound-writing-in-a-pen': ['写字','用笔写字','笔写字','钢笔写字','铅笔写字','笔划纸','书写','写东西','纸上写字','黑板上写字','板书','粉笔写字'],
  'sound-small-car-engine': ['汽车发动机','汽车发动','发动汽车','引擎发动','汽车引擎']
};
function publicSound(s) { const {correct, answerHistory, answerTextStats, ...safe}=s; return {...safe, listens:Number(s.listens||0), accuracy:s.plays ? Math.round(s.correct/s.plays*100) : 0}; }
function currentPlaythrough(u) {
  const n=Number(u?.playthrough||1);
  return Number.isFinite(n)&&n>=1 ? Math.floor(n) : 1;
}
function sessionPlaythrough(s) {
  const n=Number(s?.playthrough||1);
  return Number.isFinite(n)&&n>=1 ? Math.floor(n) : 1;
}
function completionShownList(u) {
  return Array.isArray(u?.libraryCompletionShown) ? u.libraryCompletionShown : [];
}
function libraryCompletionWasShown(u, playthrough, sessionId='') {
  return completionShownList(u).some(x =>
    Number(x?.playthrough)===Number(playthrough) || (sessionId&&x?.sessionId===sessionId)
  );
}
function activeLibraryCompletionPending(u) {
  const pending=u?.libraryCompletionPending;
  if(!pending||pending.shownAt) return null;
  if(libraryCompletionWasShown(u,pending.playthrough,pending.sessionId)) return null;
  return pending;
}
function ensureLibraryCompletionPending(u, session, progress) {
  if(!u||!session||!progress.libraryComplete||Boolean(session.libraryCompleteBefore)) return null;
  const playthrough=sessionPlaythrough(session);
  if(libraryCompletionWasShown(u,playthrough,session.id)) return null;
  const pending=activeLibraryCompletionPending(u);
  if(pending&&Number(pending.playthrough)===playthrough) return pending;
  const now=new Date().toISOString();
  u.libraryCompletionPending={
    sessionId:session.id,
    playthrough,
    completedAt:now,
    libraryAnswered:progress.libraryAnswered,
    libraryTotal:progress.libraryTotal
  };
  return u.libraryCompletionPending;
}
function markLibraryCompletionShown(u, sessionId) {
  const pending=activeLibraryCompletionPending(u);
  if(!pending||pending.sessionId!==sessionId) return {ok:false, reason:'没有待展示的全部完成页'};
  const now=new Date().toISOString();
  const playthrough=Number(pending.playthrough)||currentPlaythrough(u);
  u.libraryCompletionShown=completionShownList(u).filter(x => x.sessionId!==sessionId&&Number(x.playthrough)!==playthrough);
  u.libraryCompletionShown.push({...pending, shownAt:now});
  u.libraryCompletionPending=null;
  if(currentPlaythrough(u)<=playthrough) u.playthrough=playthrough+1;
  u.lastSeen=now;
  return {ok:true, playthrough:u.playthrough};
}
function sessionAnsweredSoundIds(session) {
  return [...new Set((Array.isArray(session?.answers)?session.answers:[])
    .map(a=>a&&a.soundId)
    .filter(Boolean))];
}
function answeredSoundIdsForSessions(sessions=[]) {
  return sessions.flatMap(sessionAnsweredSoundIds);
}
function libraryProgress(u, allSounds, sessions=[], playthrough=currentPlaythrough(u)) {
  const enabled=allSounds.filter(s=>s.enabled);
  const enabledIds=new Set(enabled.map(s=>s.id));
  const cycleSessions=Array.isArray(sessions)&&sessions.length ? userGameSessions(u.id,sessions,playthrough) : [];
  const answeredSource=cycleSessions.length ? answeredSoundIdsForSessions(cycleSessions) : (Number(playthrough)===1 ? (u.answers||[]) : []);
  const answered=[...new Set(answeredSource)].filter(id=>enabledIds.has(id));
  const total=enabled.length;
  return {
    libraryTotal:total,
    libraryAnswered:answered.length,
    libraryCompletion:total ? Math.round(answered.length/total*100) : 0,
    libraryComplete:total>0&&answered.length>=total,
    playthrough:Number(playthrough)||1
  };
}
function normalizeUserProgressState(data, user) {
  if(!user||isTestUser(user)) return false;
  let changed=false;
  const sessions=sessionsFor(data,user);
  const validShown=completionShownList(user).filter(item =>
    item&&libraryProgress(user,data.sounds,sessions,Number(item.playthrough||1)).libraryComplete
  );
  const cleanShown=mergeCompletionShown(validShown,[]);
  if(JSON.stringify(user.libraryCompletionShown||[])!==JSON.stringify(cleanShown)) {
    user.libraryCompletionShown=cleanShown;
    changed=true;
  }
  const pending=user.libraryCompletionPending;
  if(pending) {
    const pendingPlaythrough=Number(pending.playthrough||currentPlaythrough(user));
    const validPending=libraryProgress(user,data.sounds,sessions,pendingPlaythrough).libraryComplete&&!libraryCompletionWasShown(user,pendingPlaythrough,pending.sessionId);
    if(!validPending) {
      user.libraryCompletionPending=null;
      changed=true;
    }
  }
  const current=currentPlaythrough(user);
  let nextPlaythrough=1;
  for(let pt=1; pt<current; pt++) {
    const complete=libraryProgress(user,data.sounds,sessions,pt).libraryComplete;
    const shown=libraryCompletionWasShown(user,pt);
    if(complete&&shown) nextPlaythrough=pt+1;
    else break;
  }
  if(current!==nextPlaythrough) {
    user.playthrough=nextPlaythrough;
    changed=true;
  }
  return changed;
}
function userAnswerTotals(u, sessions=[]) {
  const seen=new Set();
  const includeTest=isTestUser(u);
  let total=0, correct=0;
  for(const session of sessions||[]) {
    if(!session||session.userId!==u.id) continue;
    if(isTestSession(session)!==includeTest) continue;
    for(const answer of Array.isArray(session.answers)?session.answers:[]) {
      const key=[session.id,answer.soundId||'',answer.at||'',answer.answer||''].join('|');
      if(seen.has(key)) continue;
      seen.add(key);
      total++;
      if(answer.correct) correct++;
    }
  }
  return {total,correct,score:correct};
}
function userPublic(u, allSounds, sessions=[]) { const progress=libraryProgress(u, allSounds, sessions); const totals=userAnswerTotals(u,sessions); return { ...u, ...totals, answeredCount:progress.libraryAnswered, completion:progress.libraryCompletion, ...progress, libraryCompletionPending:Boolean(activeLibraryCompletionPending(u)) }; }
function completeRankingForUsers(data, currentUser=null) {
  const currentId=currentUser?.id||'';
  const rows=(data.users||[]).filter(u=>!isTestUser(u)).map(u=>{
    const latest=completionShownList(u)
      .filter(item=>item&&(item.shownAt||item.completedAt))
      .sort((a,b)=>new Date(b.shownAt||b.completedAt||0)-new Date(a.shownAt||a.completedAt||0))[0];
    if(!latest) return null;
    const totals=userAnswerTotals(u,data.sessions||[]);
    return {
      id:u.id,
      name:cleanUserName(u.name)||'匿名玩家',
      total:totals.total,
      correct:totals.correct,
      score:totals.score,
      playthrough:Number(latest.playthrough||1)||1,
      completedAt:latest.shownAt||latest.completedAt||'',
      shownAt:latest.shownAt||'',
      current:Boolean(currentId&&u.id===currentId)
    };
  }).filter(Boolean).sort((a,b)=>Number(b.score||0)-Number(a.score||0)||new Date(a.completedAt||0)-new Date(b.completedAt||0));
  if(currentId) {
    const index=rows.findIndex(x=>x.id===currentId);
    if(index>0) rows.unshift(rows.splice(index,1)[0]);
    if(rows[0]&&rows[0].id===currentId) rows[0].current=true;
  }
  return rows.slice(0,10);
}
function completedRoundsForUser(userId, sessions) { return sessions.filter(s=>s.userId===userId&&(s.soundIds||[]).length>0&&(s.answers||[]).length>=(s.soundIds||[]).length).length; }
function scoreRankingRows(data) {
  return (data.users||[])
    .filter(u=>!isTestUser(u))
    .map(u=>({...userPublic(u,data.sounds,data.sessions),completedRounds:completedRoundsForUser(u.id,data.sessions)}))
    .filter(u=>u.completedRounds>=1)
    .sort((a,b)=>Number(b.score||0)-Number(a.score||0)||Number(b.completedRounds||0)-Number(a.completedRounds||0)||Number(b.total||0)-Number(a.total||0)||new Date(b.lastSeen||0)-new Date(a.lastSeen||0))
    .map((row,index)=>({...row,rank:index+1}));
}
function resultProfileKeyForScore(score, total=5) {
  const value=Number(score)||0;
  const fullScore=Math.max(1,Number(total)||5);
  if(value>=fullScore) return 'perfect';
  if(value>=3) return 'good';
  if(value>=1) return 'low';
  return 'zero';
}
function resultProfileFile(profileKey) {
  return {
    zero:'马什么梅老人.jpeg',
    low:'梵高.jpeg',
    good:'蜘蛛侠.jpeg',
    perfect:'葫芦娃二娃.jpeg',
    complete:'贝多芬.png'
  }[profileKey]||'马什么梅老人.jpeg';
}
function sessionCompletedAt(session) {
  const answers=Array.isArray(session.answers)?session.answers:[];
  return answers.map(a=>a.at).filter(Boolean).sort().at(-1)||session.completedAt||session.startedAt||'';
}
function roundHistoryForUser(userId, sessions=[]) {
  return userGameSessions(userId,sessions)
    .filter(s=>(s.soundIds||[]).length>0&&(s.answers||[]).length>=(s.soundIds||[]).length)
    .map(s=>{
      const total=(s.soundIds||[]).length;
      const correct=(s.answers||[]).filter(a=>a.correct).length;
      const profileKey=resultProfileKeyForScore(correct,total);
      return {
        sessionId:s.id,
        startedAt:s.startedAt||'',
        completedAt:sessionCompletedAt(s),
        score:correct,
        correct,
        total,
        profileKey,
        profileFile:resultProfileFile(profileKey)
      };
    })
    .sort((a,b)=>new Date(b.completedAt||b.startedAt||0)-new Date(a.completedAt||a.startedAt||0));
}
function userHistoryPublic(data, u) {
  const sessionList=sessionsFor(data,u);
  const progress=libraryProgress(u,data.sounds,sessionList,currentPlaythrough(u));
  return {
    user:userPublic(u,data.sounds,sessionList),
    progress,
    rounds:roundHistoryForUser(u.id,sessionList)
  };
}
function resolveExistingRealUser(data, query={}) {
  const userId=String(query.userId||'').trim();
  if(userId) {
    const byId=(data.users||[]).find(u=>!isTestUser(u)&&u.id===userId);
    if(byId) return byId;
  }
  const byDevice=findRealUserByDeviceId(data,query.deviceId);
  if(byDevice) return byDevice;
  const byName=findRealUserByName(data,query.name);
  return byName||null;
}
function shuffle(list) {
  const out=[...list];
  for(let i=out.length-1;i>0;i--) {
    const j=Math.floor(Math.random()*(i+1));
    [out[i],out[j]]=[out[j],out[i]];
  }
  return out;
}
function soundAccuracyValue(sound) {
  return sound.plays ? sound.correct / sound.plays : 1;
}
function isLowAccuracySound(sound) {
  return Number(sound.plays||0)>=3 && soundAccuracyValue(sound)<.5;
}
function userGameSessions(userId, sessions, playthrough) {
  const scoped=playthrough!==undefined&&playthrough!==null;
  return (sessions||[])
    .filter(s=>s.userId===userId&&Array.isArray(s.soundIds)&&s.soundIds.length&&(!scoped||sessionPlaythrough(s)===Number(playthrough)))
    .sort((a,b)=>new Date(b.startedAt||0)-new Date(a.startedAt||0));
}
function uniqueCandidateOrder(pools) {
  const seen=new Set(), out=[];
  for(const pool of pools) {
    for(const sound of shuffle(pool)) {
      if(!sound||seen.has(sound.id)) continue;
      seen.add(sound.id);
      out.push(sound);
    }
  }
  return out;
}
function selectRoundSounds(user, data, size=5) {
  const enabled=(data.sounds||[]).filter(s=>s.enabled);
  const target=Math.min(size,enabled.length);
  if(!target) return {questions:[],meta:{reason:'no_enabled_sounds'}};

  const playthrough=currentPlaythrough(user);
  const sessions=userGameSessions(user.id,data.sessions,playthrough);
  const answeredIds=new Set(answeredSoundIdsForSessions(sessions));
  const recentIds=new Set(sessions.slice(0,3).flatMap(s=>s.soundIds||[]));
  const unanswered=enabled.filter(s=>!answeredIds.has(s.id));
  const unansweredIds=new Set(unanswered.map(s=>s.id));
  const selected=[];
  const selectedIds=new Set();
  const add=s => {
    if(!s||selectedIds.has(s.id)||selected.length>=target) return false;
    selected.push(s);
    selectedIds.add(s.id);
    return true;
  };
  const lowCount=()=>selected.filter(isLowAccuracySound).length;
  const addOneLow=pool => {
    const sound=shuffle(pool.filter(s=>isLowAccuracySound(s)&&!selectedIds.has(s.id)))[0];
    return add(sound);
  };
  const addNonLow=pool => {
    for(const sound of shuffle(pool.filter(s=>!isLowAccuracySound(s)))) add(sound);
  };
  const addLow=pool => {
    for(const sound of shuffle(pool.filter(isLowAccuracySound))) {
      if(lowCount()>=3) break;
      add(sound);
    }
  };
  const addAny=pool => {
    for(const sound of shuffle(pool)) add(sound);
  };

  if(unanswered.length) {
    if(unanswered.length<=target) addAny(unanswered);
    else {
      addOneLow(unanswered);
      addNonLow(unanswered);
      addLow(unanswered);
      addAny(unanswered);
    }
    const fillPools=[
      enabled.filter(s=>!unansweredIds.has(s.id)&&!recentIds.has(s.id)),
      enabled.filter(s=>!unansweredIds.has(s.id))
    ];
    for(const pool of fillPools) {
      if(selected.length>=target) break;
      if(!lowCount()&&pool.length<target-selected.length) addOneLow(pool);
      addNonLow(pool);
      addLow(pool);
      addAny(pool);
    }
  } else {
    const recentSafe=enabled.filter(s=>!recentIds.has(s.id));
    const pools=[recentSafe, enabled];
    const primary=recentSafe.length>=target ? recentSafe : uniqueCandidateOrder(pools);
    addOneLow(primary);
    addNonLow(primary);
    addLow(primary);
    addAny(primary);
  }
  const lowSelected=selected.filter(isLowAccuracySound);
  return {
    questions:selected,
    meta:{
      strategy:unanswered.length?'unanswered_first':'avoid_recent_rounds',
      playthrough,
      answeredCount:[...answeredIds].filter(id=>enabled.some(s=>s.id===id)).length,
      unansweredBefore:unanswered.length,
      recentAvoidedCount:[...recentIds].filter(id=>enabled.some(s=>s.id===id)&&!selectedIds.has(id)).length,
      lowAccuracySelected:lowSelected.map(s=>s.id),
      lowAccuracyCount:lowSelected.length
    }
  };
}
const ENGINEERING_EXTENSIONS=new Set(['.js','.mjs','.html','.css','.toml','.json','.md','.sql']);
const ENGINEERING_EXCLUDED_DIRS=['.git','.netlify','.certs','node_modules','dist','data','uploads','图片文件','声音文件','tools/whisper-local','tools/sensevoice'];
const ENGINEERING_EXCLUDED_FILES=new Set(['package-lock.json']);
function engineeringRelative(file, root=ROOT) {
  return path.relative(root,file).split(path.sep).join('/');
}
function isExcludedEngineeringDir(rel) {
  return ENGINEERING_EXCLUDED_DIRS.some(dir=>rel===dir||rel.startsWith(`${dir}/`));
}
function isExcludedEngineeringFile(rel) {
  return ENGINEERING_EXCLUDED_FILES.has(rel);
}
function engineeringCategory(rel) {
  if(rel.startsWith('public/')&&/\.(?:html|css|js)$/i.test(rel)) return '前端界面';
  if(rel==='server.js'||rel.startsWith('cloudflare/')) return '服务端/API';
  if(rel.startsWith('scripts/')||rel.startsWith('docs/')||rel.startsWith('tools/')||rel==='wrangler.jsonc'||rel==='package.json'||rel==='README.md'||rel==='DX100-声音游戏.md') return '脚本/配置';
  return '其他工程文件';
}
function countEngineeringLines(text) {
  if(!text) return {sourceLines:0,codeLines:0};
  return {
    sourceLines:(text.match(/\n/g)||[]).length+(text.endsWith('\n')?0:1),
    codeLines:text.split(/\r?\n/).filter(line=>line.trim()).length
  };
}
function scanEngineeringStats(root=ROOT) {
  const stack=[root], files=[], categories={};
  let sourceLines=0, codeLines=0, sourceBytes=0;
  while(stack.length) {
    const dir=stack.pop();
    let entries=[];
    try { entries=fs.readdirSync(dir,{withFileTypes:true}); } catch { continue; }
    for(const entry of entries) {
      const file=path.join(dir,entry.name);
      const rel=engineeringRelative(file,root);
      if(entry.isDirectory()) {
        if(!isExcludedEngineeringDir(rel)) stack.push(file);
        continue;
      }
      if(!entry.isFile()) continue;
      if(!ENGINEERING_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      if(isExcludedEngineeringDir(path.dirname(rel))||isExcludedEngineeringFile(rel)) continue;
      let text='';
      try { text=fs.readFileSync(file,'utf8'); } catch { continue; }
      const lines=countEngineeringLines(text);
      const category=engineeringCategory(rel);
      categories[category] ||= {fileCount:0,codeLines:0,sourceLines:0};
      categories[category].fileCount+=1;
      categories[category].codeLines+=lines.codeLines;
      categories[category].sourceLines+=lines.sourceLines;
      files.push(rel);
      codeLines+=lines.codeLines;
      sourceLines+=lines.sourceLines;
      sourceBytes+=Buffer.byteLength(text);
    }
  }
  return {
    source:'runtime-source-scan',
    updatedAt:new Date().toISOString(),
    rootName:path.basename(root),
    fileCount:files.length,
    codeLines,
    sourceLines,
    sourceBytes,
    categories,
    excludes:'不含声音素材、图片素材、题库数据、录音和依赖包'
  };
}
function readEngineeringManifest() {
  const embedded=globalThis.__DX100_ENGINEERING_STATS;
  if(embedded?.codeLines&&embedded?.fileCount) return {...embedded,source:embedded.source||'build-metrics-manifest'};
  const candidates=[
    envValue('DX100_ENGINEERING_STATS_PATH'),
    path.join(ROOT,'data','engineering-stats.json')
  ].filter(Boolean);
  for(const file of candidates) {
    try {
      if(!fs.existsSync(file)) continue;
      const stats=JSON.parse(fs.readFileSync(file,'utf8'));
      if(stats?.codeLines&&stats?.fileCount) return {...stats, source:stats.source||'build-metrics-manifest'};
    } catch {}
  }
  return null;
}
function codebaseStats() {
  let scanned=null;
  try { scanned=scanEngineeringStats(ROOT); } catch { scanned=null; }
  const manifest=readEngineeringManifest();
  const chosen=manifest&&(!scanned||manifest.fileCount>=scanned.fileCount) ? manifest : scanned;
  return chosen||{
    source:'codebase-metrics-unavailable',
    updatedAt:new Date().toISOString(),
    fileCount:0,
    codeLines:0,
    sourceLines:0,
    sourceBytes:0,
    categories:{},
    excludes:'不含声音素材、图片素材、题库数据、录音和依赖包'
  };
}
function asrTranscriptionCount(data=readStore()) {
  const seen=new Set();
  const eventSoundKeys=new Set();
  const asrResultTypes=new Set(['speech_transcribed','speech_empty','transcribe_failed']);
  for(const session of data.sessions||[]) {
    if(isTestSession(session)) continue;
    for(const event of Array.isArray(session.monitor)?session.monitor:[]) {
      if(!asrResultTypes.has(event?.type)) continue;
      const soundId=String(event.details?.soundId||'');
      if(soundId) eventSoundKeys.add(`${session.id}:${soundId}`);
      seen.add(`event:${session.id}:${soundId}:${event.at||''}:${event.type}`);
    }
    for(const answer of Array.isArray(session.audioAnswers)?session.audioAnswers:[]) {
      const status=String(answer.transcriptionStatus||answer.status||'');
      const called=Boolean(answer.transcriptionProvider)||Number(answer.asrDurationMs||0)>0||['ok','empty','failed','completed'].includes(status);
      if(!called||['queued','processing'].includes(status)) continue;
      if(eventSoundKeys.has(`${session.id}:${answer.soundId||''}`)) continue;
      seen.add(answer.id||`${session.id}:${answer.soundId||''}:${answer.createdAt||answer.updatedAt||''}`);
    }
  }
  return seen.size;
}
function teamStats() {
  const asrTranscriptionCountValue=asrTranscriptionCount();
  return { ...codebaseStats(), asrTranscriptionCount:asrTranscriptionCountValue };
}
function fileMeta(file) {
  try {
    const st=fs.statSync(file);
    return {
      file:path.basename(file),
      sizeMB:Number((st.size/1024/1024).toFixed(1)),
      updatedAt:st.mtime.toISOString()
    };
  } catch {
    return {file:path.basename(file), missing:true};
  }
}
function teamModels() {
  return {
    updatedAt:new Date().toISOString(),
    activeSttProvider:'tencent-realtime-v2',
    items:[
      {
        stage:'语音识别',
        model:'腾讯实时语音识别 2.0',
        version:'浏览器实时直连',
        usage:'服务端只签发短时连接，语音由浏览器直接发送到腾讯，长期密钥不进入前端'
      },
      {
        stage:'答案判定',
        model:'本地语义规则匹配器',
        version:'v0.1017',
        usage:'匹配声音名称、标签和同义表达，用于判断玩家回答'
      },
      {
        stage:'题目推荐',
        model:'本地周目推荐策略',
        version:'v0.1039',
        usage:'优先未听过声音，完成后进入下一周目，并控制低正确率题分布'
      }
    ]
  };
}
function eventTime(e) {
  const t=new Date(e?.at||0).getTime();
  return Number.isFinite(t) ? t : 0;
}
function analyticsEvent(input={}, req) {
  const details=input.details&&typeof input.details==='object' ? input.details : {};
  const userAgent=cleanUserAgent(input.userAgent||req.headers['user-agent']||'');
  const event={
    id:crypto.randomUUID(),
    at:new Date().toISOString(),
    clientAt:String(input.at||'').slice(0,40),
    type:String(input.type||'event').slice(0,80),
    deviceId:String(input.deviceId||'').slice(0,80),
    userId:String(input.userId||'').slice(0,80),
    sessionId:String(input.sessionId||'').slice(0,80),
    pageViewId:String(input.pageViewId||'').slice(0,80),
    page:String(input.page||'').slice(0,80),
    path:String(input.path||'').slice(0,160),
    appVersion:String(input.appVersion||'').slice(0,40),
    userAgent,
    client:userAgent ? parseClientInfo(userAgent) : null,
    viewport:input.viewport&&typeof input.viewport==='object' ? {
      width:Number(input.viewport.width||0),
      height:Number(input.viewport.height||0)
    } : null,
    durationMs:Number(input.durationMs||details.durationMs||0)||0,
    details:cleanDetails(details)
  };
  return event;
}
function appendAnalyticsEvent(data, input, req) {
  const event=analyticsEvent(input,req);
  data.analyticsEvents=Array.isArray(data.analyticsEvents)?data.analyticsEvents:[];
  data.analyticsEvents.push(event);
  if(data.analyticsEvents.length>ANALYTICS_MAX_EVENTS) data.analyticsEvents=data.analyticsEvents.slice(-ANALYTICS_MAX_EVENTS);
  const u=(event.userId&&getUserById(data,event.userId))||findRealUserByDeviceId(data,event.deviceId);
  if(u&&!isTestUser(u)) applyUserClientInfo(u,{userAgent:event.userAgent},null,event.at);
  return event;
}
function cleanDetails(details={}) { return Object.fromEntries(Object.entries(details).map(([k,v]) => [k, typeof v==='string' ? v.slice(0,200) : v])); }
function appendMonitor(session, source, type, message, details={}) { session.monitor=session.monitor||[]; const event={id:crypto.randomUUID(),at:new Date().toISOString(),source,type,message,details:cleanDetails(details)}; session.monitor.push(event); if(session.monitor.length>200) session.monitor=session.monitor.slice(-200); return event; }
function judgeAnswer(sound, answer) { const judgment=voiceGameContract.judgeAnswer({ gameId:'sound', transcript:answer, question:{ name:sound.name, tags:sound.tags, aliases:sound.aliases, semanticIntents:SEMANTIC_INTENTS[sound.id] } }); const hit=judgment.matches[0]; const match={ ok:judgment.correct, score:Number(hit?.confidence || 0), type:hit?.type || judgment.reason, matched:hit?.matched || '' }; return { correct:judgment.correct, message:judgment.correct ? '答对了！你听得很准。' : `差一点，正确答案是「${sound.name}」`, match, judgment }; }
function recordJudgedAnswer(data, session, sound, answer, options={}) {
  const u=session&&getUserById(data,session.userId);
  if(!session||!u||!sound) return {ok:false,error:'题目不存在'};
  if(session.answers.some(a=>a.soundId===sound.id)) return {ok:false,duplicate:true,user:u};
  const text=String(answer||'').trim().slice(0,500);
  const result=judgeAnswer(sound,text);
  if(!text) result.message='没有识别到文字';
  const answeredAt=options.at||new Date().toISOString();
  const answerRecord={
    soundId:sound.id,
    answer:text,
    correct:result.correct,
    at:answeredAt,
    inputMode:options.inputMode||'text'
  };
  answerRecord.judgment=result.judgment;
  if(options.provider) answerRecord.provider=String(options.provider).slice(0,80);
  if(options.asrProvider) answerRecord.asrProvider=String(options.asrProvider).slice(0,80);
  if(Number(options.asrDurationMs||0)>0) answerRecord.asrDurationMs=Number(options.asrDurationMs||0);
  if(options.audioAnswerId) answerRecord.audioAnswerId=String(options.audioAnswerId);
  if(options.transcriptionStatus) answerRecord.transcriptionStatus=String(options.transcriptionStatus);
  if(options.transcriptionReason) answerRecord.transcriptionReason=String(options.transcriptionReason).slice(0,200);
  if(options.recognized===false) answerRecord.recognized=false;
  if(options.recovered) answerRecord.recovered=true;
  if(options.recoveredFromEventId) answerRecord.recoveredFromEventId=String(options.recoveredFromEventId);
  session.answers.push(answerRecord);
  const testMode=isTestSession(session)||isTestUser(u)||Boolean(options.testMode);
  if(!testMode) queueCloudAnswerSidecar(session,answerRecord);
  const countSoundStats=options.countSoundStats!==false&&Boolean(text);
  if(!testMode&&countSoundStats) {
    appendSoundAnswerHistory(sound,session,answerRecord);
    sound.plays=Number(sound.plays||0)+1;
    if(result.correct)sound.correct=Number(sound.correct||0)+1;
  }
  if(options.countUserStats!==false) {
    u.total=Number(u.total||0)+1;
    if(result.correct)u.correct=Number(u.correct||0)+1;
    u.answers=[...new Set([...(u.answers||[]),sound.id])];
  }
  u.lastSeen=new Date().toISOString();
  return {ok:true,result,answerRecord,user:u,testMode};
}
function wavDemo(kind) { const rate=16000, seconds=3.5, len=rate*seconds, out=Buffer.alloc(44+len*2); out.write('RIFF'); out.writeUInt32LE(36+len*2,4); out.write('WAVEfmt ',8); out.writeUInt32LE(16,16); out.writeUInt16LE(1,20); out.writeUInt16LE(1,22); out.writeUInt32LE(rate,24); out.writeUInt32LE(rate*2,28); out.writeUInt16LE(2,32); out.writeUInt16LE(16,34); out.write('data',36); out.writeUInt32LE(len*2,40);
  for(let i=0;i<len;i++){ const t=i/rate; let v=0; if(kind==='rain') v=(Math.random()*2-1)*.19*(.45+.55*Math.sin(t*1.7)**2); if(kind==='washer') v=.18*Math.sin(t*2*Math.PI*105)+.04*Math.sin(t*2*Math.PI*210)+(Math.random()-.5)*.025; if(kind==='keyboard') { const p=(t*7)%1; v=p<.035?(Math.random()*2-1)*.8*Math.exp(-p*60):0; } if(kind==='metro') { const p=t%1.4; v=(p<.55?Math.sin(t*2*Math.PI*660):Math.sin(t*2*Math.PI*880))*.3*Math.exp(-(p<.55?p:p-.55)*2); } if(kind==='cicada') v=.14*Math.sin(t*2*Math.PI*(3900+250*Math.sin(t*2*Math.PI*4)))*(.4+.6*Math.sin(t*2*Math.PI*12)**8); out.writeInt16LE(Math.max(-1,Math.min(1,v))*32767,44+i*2); } return out;
}
function cloudAssetKey(safe) {
  const normalized=safe.split(path.sep).join('/');
  if(normalized.startsWith('uploads/')) return normalized;
  if(normalized.startsWith('图片文件/')) return `images/${path.basename(normalized)}`;
  return '';
}
function requestHeader(req, name) {
  const headers=req?.headers||{};
  return headers[name]||headers[name.toLowerCase()]||headers[name.toUpperCase()]||'';
}
function parseByteRange(header, totalSize) {
  const raw=String(header||'').trim();
  if(!raw) return null;
  if(totalSize<=0) return {unsatisfiable:true};
  const match=raw.match(/^bytes=(\d*)-(\d*)$/);
  if(!match) return {unsatisfiable:true};
  const [,startText,endText]=match;
  if(!startText&&!endText) return {unsatisfiable:true};
  let start;
  let end;
  if(!startText) {
    const suffix=Number(endText);
    if(!Number.isSafeInteger(suffix)||suffix<=0) return {unsatisfiable:true};
    start=Math.max(totalSize-suffix,0);
    end=totalSize-1;
  } else {
    start=Number(startText);
    end=endText ? Number(endText) : totalSize-1;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)) return {unsatisfiable:true};
    if(end>=totalSize) end=totalSize-1;
  }
  if(start<0||end<start||start>=totalSize) return {unsatisfiable:true};
  return {start,end};
}
function fileResponseHeaders(targetName, totalSize, headers={}, defaultCache='no-cache') {
  return {
    ...headers,
    'Content-Type':headers['Content-Type']||MIME[path.extname(targetName).toLowerCase()]||'application/octet-stream',
    'Cache-Control':headers['Cache-Control']||defaultCache,
    'Accept-Ranges':'bytes',
    'Content-Length':String(totalSize)
  };
}
function sendRangeNotSatisfiable(req,res,targetName,totalSize,headers={},defaultCache='no-cache') {
  res.writeHead(416,{
    ...fileResponseHeaders(targetName,0,headers,defaultCache),
    'Content-Range':`bytes */${totalSize}`,
    'Content-Length':'0'
  });
  return res.end();
}
function serveBuffer(req,res,buffer,targetName,headers={},defaultCache='no-cache') {
  const payload=Buffer.isBuffer(buffer)?buffer:Buffer.from(buffer);
  const totalSize=payload.length;
  const range=parseByteRange(requestHeader(req,'range'),totalSize);
  if(range?.unsatisfiable) return sendRangeNotSatisfiable(req,res,targetName,totalSize,headers,defaultCache);
  if(range) {
    const chunk=payload.subarray(range.start,range.end+1);
    res.writeHead(206,{
      ...fileResponseHeaders(targetName,chunk.length,headers,defaultCache),
      'Content-Range':`bytes ${range.start}-${range.end}/${totalSize}`
    });
    return req.method==='HEAD' ? res.end() : res.end(chunk);
  }
  res.writeHead(200,fileResponseHeaders(targetName,totalSize,headers,defaultCache));
  return req.method==='HEAD' ? res.end() : res.end(payload);
}
function serveLocalFile(req,res,target,headers={}) {
  const totalSize=fs.statSync(target).size;
  const range=parseByteRange(requestHeader(req,'range'),totalSize);
  if(range?.unsatisfiable) return sendRangeNotSatisfiable(req,res,target,totalSize,headers,'no-cache');
  if(range) {
    res.writeHead(206,{
      ...fileResponseHeaders(target,range.end-range.start+1,headers,'no-cache'),
      'Content-Range':`bytes ${range.start}-${range.end}/${totalSize}`
    });
    return req.method==='HEAD' ? res.end() : fs.createReadStream(target,{start:range.start,end:range.end}).pipe(res);
  }
  res.writeHead(200,fileResponseHeaders(target,totalSize,headers,'no-cache'));
  return req.method==='HEAD' ? res.end() : fs.createReadStream(target).pipe(res);
}
async function serveFile(req, res, file, headers={}) {
  const safe=path.normalize(file).replace(/^\.\.(\/|\\|$)/,'');
  if(isCloudRuntime()) {
    const cloud=activeCloudContext();
    const key=cloudAssetKey(safe);
    if(key) {
      const value=await cloud.store.get(key,{type:'arrayBuffer'});
      if(!value) return send(res,404,{error:'未找到资源'});
      return serveBuffer(req,res,Buffer.from(value),path.basename(key),headers,'public, max-age=3600');
    }
    if(typeof cloud.store.fetchAsset==='function') {
      const served=await cloud.store.fetchAsset(req,res,safe,headers);
      if(served) return;
      return send(res,404,{error:'未找到资源'});
    }
  }
  const target=path.join(ROOT,safe);
  if(!target.startsWith(ROOT)||!fs.existsSync(target)||fs.statSync(target).isDirectory()) return send(res,404,{error:'未找到资源'});
  return serveLocalFile(req,res,target,headers);
}
function soundAsrHotwords(data=null, soundIds=[]) {
  const source=data&&Array.isArray(data.sounds) ? data : readStore();
  const words=[];
  const selected=new Set((Array.isArray(soundIds)?soundIds:[]).map(String));
  for(const sound of source.sounds||[]) {
    if(!sound||sound.enabled===false) continue;
    if(selected.size&&!selected.has(String(sound.id))) continue;
    if(sound.name) words.push(sound.name);
    for(const tag of [...(Array.isArray(sound.tags)?sound.tags:[]),...(Array.isArray(sound.aliases)?sound.aliases:[])]) words.push(tag);
  }
  words.push('声音','音效','掌声','猫','狗','下雨','雨声','门铃','敲门','火柴','剪刀','键盘','地铁','洗衣机','蝉鸣');
  return [...new Set(words.map(word=>String(word||'').trim()).filter(Boolean))].slice(0,300);
}
function tencentRealtimeConfig() {
  return asrToolkit.tencentRealtimeConfig();
}
function realtimeProviderConfigs() {
  return asrToolkit.realtimeProviderConfigs();
}
function availableAsrProviders() {
  return asrToolkit.availableAsrProviders();
}
function sleep(ms) {
  return new Promise(resolve=>setTimeout(resolve,ms));
}
async function handleRequest(req,res) { try {
  const url=new URL(req.url, `http://${req.headers.host}`), p=url.pathname;
  if(req.method==='GET'&&p==='/api/health') return send(res,200,{ok:true,runtime:'node-local',version:APP_VERSION},NO_STORE_HEADERS);
  if(p.startsWith('/api/demo-audio/')) return serveBuffer(req,res,wavDemo(p.split('/').pop()),`${p.split('/').pop()||'demo'}.wav`,{},'no-store');
  if(p.startsWith('/uploads/')) return serveFile(req,res,p.slice(1));
  if(p.startsWith('/images/')) return serveFile(req,res,path.join('图片文件',path.basename(decodeURIComponent(p.slice('/images/'.length)))));
  if(req.method==='GET'&&p==='/api/team-stats') return send(res,200,teamStats());
  if(req.method==='GET'&&p==='/api/team-models') return send(res,200,teamModels());
  if(req.method==='GET'&&p==='/api/asr/config') {
    const storeData=readStore();
    return send(res,200,asrToolkit.configPayload(soundAsrHotwords(storeData)),NO_STORE_HEADERS);
  }
  if(req.method==='GET'&&p==='/api/voice/contract') return send(res,200,voiceGameContract.describeContract(),NO_STORE_HEADERS);
  if(req.method==='POST'&&p==='/api/asr/tencent-session') {
    const input=JSON.parse((await body(req)).toString()||'{}');
    const storeData=readStore();
    let signedSoundIds=[];
    if(!input.probe) {
      const session=getSessionById(storeData,String(input.sessionId||''));
      const soundId=String(input.soundId||input.questionId||'');
      const sound=storeData.sounds.find(item=>item.id===soundId&&item.enabled!==false);
      const {verifyAsrSessionTicket}=await asrSessionTicketPromise;
      const ticket=await verifyAsrSessionTicket(process.env,input.asrTicket,{sessionId:input.sessionId,provider:'tencent-realtime-v2',questionId:soundId});
      if(!session||!sound||!ticket||!(session.soundIds||[]).includes(soundId)) {
        return send(res,401,{error:'本轮验证已失效，请返回首页重新开始'},NO_STORE_HEADERS);
      }
      if((session.answers||[]).some(item=>item.soundId===soundId)) return send(res,409,{error:'题目已经作答'},NO_STORE_HEADERS);
      if(session.asrProvider!=='tencent-realtime-v2') return send(res,409,{error:'本轮未分配腾讯实时语音识别'},NO_STORE_HEADERS);
      signedSoundIds=session.soundIds||[];
    }
    const config=asrToolkit.tencentRealtimeConfig();
    if(!config.enabled) return send(res,503,{error:'腾讯实时语音识别未配置'},NO_STORE_HEADERS);
    return send(res,200,{
      url:asrToolkit.tencentRealtimeUrl(config,soundAsrHotwords(storeData,signedSoundIds)),
      expiresAt:new Date(Date.now()+120000).toISOString(),
      serviceRuntime:'node-local-signer',
      requestHost:req.headers.host||''
    },NO_STORE_HEADERS);
  }
  if(req.method==='GET'&&p==='/api/asr/health') {
    const storeData=readStore();
    return send(res,200,await asrToolkit.providerHealthPayload(soundAsrHotwords(storeData),{force:url.searchParams.get('force')==='1'}),NO_STORE_HEADERS);
  }
  if(req.method==='POST'&&p==='/api/game/audio-check') return send(res,410,{error:'录音上传识别已停用，请使用腾讯实时语音识别'},NO_STORE_HEADERS);
  if(req.method==='POST'&&p==='/api/analytics/event') {
    const raw=(await body(req)).toString();
    const x=raw ? JSON.parse(raw) : {};
    if(isTestRequest(req,url,x)) return send(res,200,{ok:true,skipped:true,testMode:true});
    if(analyticsRateLimited(req,url,x)) return send(res,200,{ok:true,skipped:true,reason:'rate_limited'});
    const journal={analyticsEvents:readEventJournal(),users:[]};
    const event=appendAnalyticsEvent(journal,x,req);
    writeEventJournal(journal.analyticsEvents);
    return send(res,200,{ok:true,id:event.id});
  }
  const data=readStore();
  if(req.method==='GET'&&p==='/api/sounds') return send(res,200,data.sounds.map(publicSound));
  if(req.method==='GET'&&p==='/api/rankings') {
    const query=Object.fromEntries(url.searchParams.entries());
    const limit=10;
    if(isCloudRuntime()) await hydrateCloudSidecars(activeCloudContext().store,data);
    const currentUser=resolveExistingRealUser(data,query);
    const ranking=scoreRankingRows(data);
    const currentRank=currentUser ? ranking.find(x=>x.id===currentUser.id) : null;
    return send(res,200,{
      ranking:ranking.slice(0,limit),
      user:currentRank
    });
  }
  if(req.method==='GET'&&p==='/api/users/me') {
    const query=Object.fromEntries(url.searchParams.entries());
    if(isTestRequest(req,url,query)) {
      const u=[...TEST_USERS.values()].find(x=>x.id===query.userId||x.deviceId===query.deviceId);
      if(!u)return send(res,404,{error:'用户不存在',testMode:true});
      return send(res,200,{...testUserPublic(u,data.sounds),testMode:true});
    }
    const u=resolveExistingRealUser(data,query);
    if(!u)return send(res,404,{error:'用户不存在'});
    return send(res,200,userPublic(u,data.sounds,data.sessions));
  }
  if(req.method==='GET'&&p==='/api/users/history') {
    const query=Object.fromEntries(url.searchParams.entries());
    if(isTestRequest(req,url,query)) {
      const u=[...TEST_USERS.values()].find(x=>x.id===query.userId||x.deviceId===query.deviceId);
      if(!u)return send(res,404,{error:'用户不存在',progress:{libraryTotal:data.sounds.filter(s=>s.enabled).length,libraryAnswered:0,libraryCompletion:0},rounds:[],testMode:true});
      return send(res,200,{...userHistoryPublic(data,u),testMode:true});
    }
    const u=resolveExistingRealUser(data,query);
    if(!u)return send(res,404,{error:'用户不存在',progress:{libraryTotal:data.sounds.filter(s=>s.enabled).length,libraryAnswered:0,libraryCompletion:0},rounds:[]});
    await hydrateCloudUserSidecars(data,u.id);
    return send(res,200,userHistoryPublic(data,u));
  }
  if(req.method==='POST'&&p==='/api/users') {
    const x=JSON.parse((await body(req)).toString());
    x.userAgent=x.userAgent||req.headers['user-agent']||'';
    const userGuardKey=requestKey(req,url,x,'user-upsert');
    if(!enterRequestGuard(userGuardKey,900,15000)) return sendRateLimited(res,'正在准备用户信息，请稍候',900);
    try {
    if(isTestRequest(req,url,x)) {
      const u=upsertTestUser(x);
      return send(res,200,{...testUserPublic(u,data.sounds),testMode:true});
    }
    const u=upsertRealUser(data,x);
    if(!u)return send(res,400,{error:'缺少设备标识'});
    writeStore(data);
    return send(res,200,userPublic(u,data.sounds,data.sessions));
    } finally {
      leaveRequestGuard(userGuardKey,900,15000);
    }
  }
  if(req.method==='POST'&&p==='/api/game/start') {
    const x=JSON.parse((await body(req)).toString());
    x.userAgent=x.userAgent||req.headers['user-agent']||'';
    const startRequestTest=isTestRequest(req,url,x);
    let u=getUserById(data,x.userId);
    if(!u&&x.deviceId) u=startRequestTest ? upsertTestUser(x) : upsertRealUser(data,x);
    if(!u)return send(res,404,{error:'用户不存在'});
    const startGuardKey=requestKey(req,url,x,'game-start');
    if(!enterRequestGuard(startGuardKey,2200,20000)) return sendRateLimited(res,'正在进入下一轮，请稍候',1600);
    try {
    const testMode=isTestUser(u)||startRequestTest;
    if(!testMode) applyUserClientInfo(u,x,req);
    if(!testMode) await hydrateCloudUserSidecars(data,u.id,{fallbackAll:false});
    const sessionList=sessionsFor(data,u);
    const startToken=String(x.startToken||'').trim().slice(0,100);
    const existingStart=startToken ? sessionList.find(session=>session.startToken===startToken) : null;
    if(existingStart) {
      const questions=(existingStart.soundIds||[]).map(id=>data.sounds.find(sound=>sound.id===id)).filter(Boolean);
      const {createAsrSessionTicket}=await asrSessionTicketPromise;
      const asrTicket=await createAsrSessionTicket(process.env,{sessionId:existingStart.id,userId:existingStart.userId,provider:existingStart.asrProvider,questionIds:existingStart.soundIds||[]});
      return send(res,200,{sessionId:existingStart.id,questions:questions.map(publicSound),playthrough:existingStart.playthrough||1,asrProvider:existingStart.asrProvider||'',asrProviderLabel:existingStart.asrProviderLabel||'',asrTicket,reused:true,testMode});
    }
    const pending=activeLibraryCompletionPending(u);
    if(pending&&sessionList.some(s=>s.id===pending.sessionId)) {
      const marked=markLibraryCompletionShown(u,pending.sessionId);
      const pendingSession=getSessionById(data,pending.sessionId);
      if(pendingSession) appendMonitor(pendingSession,'server','library_completion_dismissed_on_home_start','用户从首页开始新挑战，旧完成页不再直接展示',{shownSessionId:pending.sessionId,nextPlaythrough:marked.playthrough||currentPlaythrough(u)});
    } else if(pending) {
      u.libraryCompletionPending=null;
    }
    const playthrough=currentPlaythrough(u);
    const progress=libraryProgress(u,data.sounds,sessionList,playthrough);
    const picked=selectRoundSounds(u,{...data,sessions:sessionList},5), q=picked.questions;
    if(!testMode) q.forEach(sound=>{ sound.listens=Number(sound.listens||0)+1; });
    const health=await asrToolkit.providerHealthPayload(soundAsrHotwords(data));
    const requested=Array.isArray(x.availableAsrProviders) ? new Set(x.availableAsrProviders.map(String)) : null;
    const providers=health.availableProviders.filter(provider=>!requested||requested.has(provider));
    if(!providers.length) return send(res,503,{error:'当前没有可用的实时语音识别服务',asrHealth:health});
    const asrProvider=voiceGameContract.selectAsrProvider(providers);
    const session={id:`${testMode?'test-session-':''}${crypto.randomUUID()}`,startToken,userId:u.id,soundIds:q.map(s=>s.id),answers:[],monitor:[],startedAt:new Date().toISOString(),playthrough,libraryCompleteBefore:progress.libraryComplete,libraryAnsweredBefore:progress.libraryAnswered,libraryTotal:progress.libraryTotal,recommendation:picked.meta,asrProvider,asrProviderLabel:ASR_PROVIDER_LABELS[asrProvider]||'实时语音识别未配置',isTest:testMode};
    appendMonitor(session,'server','session_started','后端已创建本轮答题',{questionCount:q.length,soundIds:q.map(s=>s.id),playthrough,libraryCompleteBefore:progress.libraryComplete,libraryAnsweredBefore:progress.libraryAnswered,libraryTotal:progress.libraryTotal,recommendation:picked.meta,asrProvider,asrProviderLabel:session.asrProviderLabel});
    const {createAsrSessionTicket}=await asrSessionTicketPromise;
    const asrTicket=await createAsrSessionTicket(process.env,{sessionId:session.id,userId:session.userId,provider:session.asrProvider,questionIds:session.soundIds});
    if(testMode) {
      TEST_SESSIONS.set(session.id,session);
      return send(res,200,{sessionId:session.id,questions:q.map(publicSound),playthrough,asrProvider,asrProviderLabel:session.asrProviderLabel,asrTicket,testMode:true});
    }
    queueCloudSessionSidecar(session);
    data.sessions.push(session);
    writeStore(data);
    return send(res,200,{sessionId:session.id,questions:q.map(publicSound),playthrough,asrProvider,asrProviderLabel:session.asrProviderLabel,asrTicket});
    } finally {
      leaveRequestGuard(startGuardKey,2200,20000);
    }
  }
  if(req.method==='GET'&&p.startsWith('/api/game/monitor/')) { const sessionId=p.split('/').pop(); await hydrateCloudSessionSidecars(data,sessionId); if(!takeRateLimit(requestKey(req,url,{sessionId},'monitor-poll'),{windowMs:3000,max:6,minIntervalMs:350})) return sendRateLimited(res,'监控刷新太频繁，请稍后再试',800); const s=getSessionById(data,sessionId);if(!s)return send(res,404,{error:'监控记录不存在'});return send(res,200,{sessionId:s.id,startedAt:s.startedAt,answeredCount:(s.answers||[]).length,total:s.soundIds.length,events:s.monitor||[]}); }
  if(req.method==='POST'&&p==='/api/game/monitor-event') { const x=JSON.parse((await body(req)).toString()); const journal={analyticsEvents:readEventJournal(),users:[]}; const event=appendAnalyticsEvent(journal,{...x,details:{message:String(x.message||'客户端事件').slice(0,120),...(x.details||{})}},req); writeEventJournal(journal.analyticsEvents); return send(res,200,{ok:true,event}); }
  if(req.method==='POST'&&p==='/api/game/answer-text') {
    const x=JSON.parse((await body(req)).toString());
    await hydrateCloudSessionSidecars(data,x.sessionId);
    const session=getSessionById(data,x.sessionId);
    const u=session&&getUserById(data,session.userId);
    const soundId=String(x.soundId||x.questionId||'');
    const sound=session&&data.sounds.find(s=>s.id===soundId);
    if(!session||!u||!sound||!(session.soundIds||[]).includes(sound.id)) return send(res,404,{error:'题目不存在'});
    const answerGuardKey=requestKey(req,url,{sessionId:x.sessionId,soundId},'answer-text');
    if(!enterRequestGuard(answerGuardKey,2200,20000)) return sendRateLimited(res,'本题语音判断正在提交，请稍候',1400);
    try {
      const testMode=isTestSession(session)||isTestUser(u)||isTestRequest(req,url,x);
      const transcript=String(x.transcript||x.answer||'').trim();
      if(!transcript) return send(res,422,{error:'没有识别到文字，请再试一次'});
      const existingAnswer=session.answers.find(a=>a.soundId===sound.id);
      if(existingAnswer) {
        appendMonitor(session,'server','answer_duplicate_accepted','本题已记录，后端按幂等成功返回',{soundId:sound.id,inputMode:'voice'});
        if(!testMode) writeStore(data);
        return send(res,200,{ok:true,duplicate:true,transcript:existingAnswer.answer||'',answer:existingAnswer.answer||'',correct:Boolean(existingAnswer.correct),provider:existingAnswer.provider||session.asrProvider||'',asrDurationMs:existingAnswer.asrDurationMs||0,testMode});
      }
      const provider=String(session.asrProvider||x.provider||'').slice(0,80);
      const asrDurationMs=Number(x.asrDurationMs||0);
      appendMonitor(session,'server','speech_transcribed','实时语音识别已返回文字',{soundId:sound.id,transcript:transcript.slice(0,120),provider,durationMs:asrDurationMs});
      const recorded=recordJudgedAnswer(data,session,sound,transcript,{
        inputMode:'voice',
        provider,
        asrProvider:provider,
        asrDurationMs,
        transcriptionStatus:'ok',
        testMode
      });
      if(!recorded.ok&&recorded.duplicate) return send(res,200,{ok:true,duplicate:true,transcript,answer:transcript,testMode});
      if(!recorded.ok) return send(res,404,{error:recorded.error||'题目不存在'});
      appendMonitor(session,'server','judge_completed','后端已完成实时语音判题',{soundId:sound.id,recorded:true,correct:Boolean(recorded.result?.correct),provider});
      if(!testMode) writeStore(data);
      return send(res,200,{ok:true,transcript:recorded.answerRecord.answer,answer:recorded.answerRecord.answer,correct:Boolean(recorded.answerRecord.correct),provider,asrDurationMs,testMode});
    } finally {
      leaveRequestGuard(answerGuardKey,2200,20000);
    }
  }
  if(req.method==='GET'&&p.startsWith('/api/game/result/')) {
    const sessionId=p.split('/').pop();
    const resultData=data;
    const s=getSessionById(resultData,sessionId);
    if(!s)return send(res,404,{error:'记录不存在'});
    const u=getUserById(resultData,s.userId);
    if(!u)return send(res,404,{error:'用户不存在'});
    const testMode=isTestSession(s)||isTestUser(u);
    const sessionList=sessionsFor(resultData,s);
    const correct=s.answers.filter(a=>a.correct).length, total=s.soundIds.length, score=correct;
    const progress=libraryProgress(u,resultData.sounds,sessionList,sessionPlaythrough(s));
    const pending=ensureLibraryCompletionPending(u,s,progress);
    const libraryCompletedThisRound=Boolean(pending&&pending.sessionId===s.id);
    const answerBySound=new Map((s.answers||[]).map(a=>[a.soundId,a]));
    const audioBySound=new Map((s.audioAnswers||[]).map(a=>[a.soundId,a]));
    const answerReview=(s.soundIds||[]).map((soundId,i)=>{
      const a=answerBySound.get(soundId);
      const audioState=audioBySound.get(soundId);
      const recognized=a ? a.recognized!==false&&Boolean(a.answer) : false;
      return {
        index:i+1,
        answer:String(a?.answer||'').slice(0,80),
        correct:Boolean(a?.correct),
        answered:Boolean(a),
        recognized,
        statusText:a ? (recognized ? '' : '未识别到文字') : audioState ? '未识别到文字' : ''
      };
    });
    const ranking=scoreRankingRows(resultData);
    const currentRank=ranking.find(x=>x.id===u.id)||null;
    appendMonitor(s,'server','result_requested','后端已返回结算结果',{correct,total,score,playthrough:sessionPlaythrough(s),libraryAnswered:progress.libraryAnswered,libraryTotal:progress.libraryTotal,libraryCompletedThisRound,libraryCompletionPending:Boolean(pending),pendingRecognitions:0});
    if(!testMode) writeStore(resultData);
    return send(res,200,{correct,total,score,answerReview,ranking:ranking.slice(0,10),completeRanking:completeRankingForUsers(resultData,u),user:currentRank||userPublic(u,resultData.sounds,sessionList),finishedRank:currentRank?.rank||0,...progress,libraryCompletedThisRound,libraryCompletionPending:Boolean(pending),completionSessionId:pending?.sessionId||'',pendingRecognitions:0,testMode});
  }
  if(req.method==='POST'&&p==='/api/game/complete-shown') {
    const x=JSON.parse((await body(req)).toString());
    await hydrateCloudSessionSidecars(data,x.sessionId);
    const session=getSessionById(data,x.sessionId);
    const u=(session&&getUserById(data,session.userId))||getUserById(data,x.userId);
    if(!u)return send(res,404,{error:'用户不存在'});
    const completeGuardKey=requestKey(req,url,x,'complete-shown');
    if(!enterRequestGuard(completeGuardKey,2200,20000)) return sendRateLimited(res,'完成页正在确认，请稍候',1600);
    try {
    const testMode=isTestSession(session)||isTestUser(u)||isTestRequest(req,url,x);
    const playthrough=session ? sessionPlaythrough(session) : Number(x.playthrough||currentPlaythrough(u));
    const sessionList=sessionsFor(data,session||u);
    if(libraryCompletionWasShown(u,playthrough,x.sessionId)) return send(res,200,{ok:true,playthrough:currentPlaythrough(u),user:userPublic(u,data.sounds,sessionList),completeRanking:completeRankingForUsers(data,u),testMode});
    const marked=markLibraryCompletionShown(u,x.sessionId);
    if(!marked.ok)return send(res,409,{error:marked.reason});
    if(session) appendMonitor(session,'server','library_completion_shown','用户已查看全部完成页，进入下一周目',{shownSessionId:x.sessionId,nextPlaythrough:marked.playthrough});
    if(!testMode) writeStore(data);
    return send(res,200,{ok:true,playthrough:marked.playthrough,user:userPublic(u,data.sounds,sessionList),completeRanking:completeRankingForUsers(data,u),testMode});
    } finally {
      leaveRequestGuard(completeGuardKey,2200,20000);
    }
  }
  if(p==='/'||p==='/index.html')return serveFile(req,res,'public/index.html'); if(p==='/team.html')return serveFile(req,res,'public/team.html'); if(p.startsWith('/public/'))return serveFile(req,res,p.slice(1));return send(res,404,{error:'未找到页面'});
} catch(e) { console.error(e); send(res,400,{error:e.message||'请求处理失败'}); }}

if(require.main===module) {
  const server=http.createServer(handleRequest);
  server.listen(PORT,'0.0.0.0',()=>console.log(`声音侦探已启动：http://localhost:${PORT}${PUBLIC_MODE?'（公网模式）':''}`));
}

module.exports={
  handleRequest,
  withCloudRequest,
  flushCloudStore,
  envValue,
};
