const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const childProcess = require('node:child_process');
const { AsyncLocalStorage } = require('node:async_hooks');

const ROOT = __dirname;
loadEnvFile(ROOT);
const STORE = path.join(ROOT, 'data', 'store.json');
const UPLOADS = path.join(ROOT, 'uploads');
const ASR_RECORDINGS = path.join(ROOT, 'data', 'asr-recordings');
const ASR_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ANALYTICS_MAX_EVENTS = 50000;
const BAIDU_TOKEN_SKEW_MS = 5 * 60 * 1000;
const CLOUD_CONTEXT = new AsyncLocalStorage();
const PORT = Number(envValue('PORT') || 3000);
const PUBLIC_MODE = envFlag('PUBLIC_MODE') || isNetlifyRuntime();
const MIME = { '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.m4a':'audio/mp4', '.ogg':'audio/ogg', '.webm':'audio/webm', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.svg':'image/svg+xml; charset=utf-8' };
let baiduTokenCache = null;
const TEST_USERS = new Map();
const TEST_SESSIONS = new Map();
const RATE_LIMIT_BUCKETS = new Map();
const REQUEST_GUARDS = new Map();
const AUDIO_ANSWER_JOBS = new Map();

function loadEnvFile(root) {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
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
  try {
    const value=globalThis.Netlify?.env?.get?.(key);
    if(value!==undefined&&value!==null&&String(value)!=='') return value;
  } catch {}
  return process.env[key] ?? fallback;
}
function envFlag(key) {
  return truthy(envValue(key));
}
function isNetlifyRuntime() {
  return envValue('NETLIFY')==='true'||envValue('DX100_STORAGE')==='netlify-blobs';
}
function activeCloudContext() {
  return CLOUD_CONTEXT.getStore()||null;
}
function isCloudRuntime() {
  return Boolean(activeCloudContext());
}
async function withCloudRequest(store, fn) {
  if(!store) throw Error('缺少 Netlify Blobs store');
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
const DEFAULT_USER_NAMES = new Set(['匿名玩家','匿名','游客','未命名','无名','无名侦探']);
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
    data.users.push(u);
  } else {
    if(inputName) u.name=inputName;
    u.deviceId=deviceId;
    normalizeUserIdentity(u,[deviceId]);
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
  const seenBySound=new Map();
  for(const sound of sounds) {
    const clean=[], seen=new Set();
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
  }
  return changed;
}
function recoverAnswersFromMonitor(data, session) {
  if(!session||!Array.isArray(session.monitor)||!Array.isArray(session.soundIds)) return false;
  session.answers=Array.isArray(session.answers)?session.answers:[];
  const answered=new Set(session.answers.map(a=>a&&a.soundId).filter(Boolean));
  const usedRecoveryEvents=new Set(session.answers.map(a=>a&&a.recoveredFromEventId).filter(Boolean));
  const soundsById=new Map((data.sounds||[]).map(s=>[s.id,s]));
  const validSoundIds=new Set(session.soundIds||[]);
  const events=[...session.monitor].sort((a,b)=>new Date(a.at||0)-new Date(b.at||0));
  let currentSoundId='';
  let lastSubmission=null;
  let changed=false;
  const nextUnansweredAfter = soundId => {
    const list=session.soundIds||[];
    const start=Math.max(0,list.indexOf(soundId));
    for(let offset=1; offset<=list.length; offset++) {
      const candidate=list[(start+offset)%list.length];
      if(candidate&&!answered.has(candidate)) return candidate;
    }
    return '';
  };
  const recover=(soundId, answer, event, inputMode='text') => {
    const eventKey=String(event?.id||[event?.at||'',event?.type||'',event?.details?.answer||''].join('|'));
    if(eventKey&&usedRecoveryEvents.has(eventKey)) return false;
    let cleanSoundId=String(soundId||'');
    if(cleanSoundId&&answered.has(cleanSoundId)) cleanSoundId=nextUnansweredAfter(cleanSoundId);
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
    const details=event?.details&&typeof event.details==='object' ? event.details : {};
    if(details.soundId&&validSoundIds.has(details.soundId)) currentSoundId=details.soundId;
    if(event.type==='question_rendered'&&details.soundId) currentSoundId=details.soundId;
    if(event.type==='answer_submit'&&details.answer) {
      lastSubmission={
        soundId:details.soundId||currentSoundId,
        answer:details.answer,
        inputMode:details.inputMode||'text',
        at:event.at
      };
    }
    if(event.type==='answer_response'&&details.recorded&&details.answer) {
      const soundId=details.soundId||lastSubmission?.soundId||currentSoundId;
      const inputMode=details.inputMode||lastSubmission?.inputMode||'text';
      if(recover(soundId,details.answer,event,inputMode)) changed=true;
      lastSubmission=null;
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
    if(recoverAnswersFromMonitor(data,session)) changed=true;
  }
  for(const user of data.users) {
    if(normalizeUserProgressState(data,user)) changed=true;
  }
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
    if(!prev||new Date(answer.at||0)>=new Date(prev.at||0)) map.set(key,{...prev,...answer});
  }
  return [...map.values()].sort((x,y)=>new Date(x.at||0)-new Date(y.at||0));
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
  'sound-breaking-a-cup': ['杯子摔碎','杯子碎了','打碎杯子','玻璃杯碎','玻璃碎','杯子破了','碎裂','摔杯子','砸杯子'],
  'sound-door-chime': ['门铃','按门铃','门铃响','铃声','叮咚','有人按门铃'],
  'sound-entering-a-house': ['进门','开门进屋','开门进来','开门回家','回家开门','进屋','入门','房门打开'],
  'sound-knocking-an-iron-door': ['敲铁门','敲门','拍门','门响','铁门响','铁门声','有人敲门','敲门声'],
  'sound-lighting-a-match': ['划火柴','擦火柴','点火柴','火柴点燃','点燃火柴','火柴','划着火柴'],
  'sound-out-of-a-toilet': ['马桶冲水','冲马桶','厕所冲水','卫生间冲水','抽水马桶','冲水','上厕所冲水','马桶'],
  'sound-scissors': ['剪刀','剪东西','剪纸','裁剪','剪开','用剪刀','剪刀剪'],
  'sound-vinyl-bag': ['塑料袋','揉塑料袋','搓塑料袋','塑料袋揉搓','袋子揉搓','包装袋','塑料包装','塑料声'],
  'sound-writing-in-a-pen': ['写字','用笔写字','笔写字','钢笔写字','铅笔写字','笔划纸','书写','写东西','纸上写字','黑板上写字','板书','粉笔写字']
};
const FILLER_PATTERNS = [
  '这是','这个是','应该是','可能是','好像是','听起来像','我觉得','感觉是','就是',
  '有点像','像是','大概是','应该就是','一个','一种','有人在','有人','正在',
  '发出来的','发出的','传来的','的声音','这个声音','声音','声','音效','里面','外面'
];
function normalize(s='') {
  return String(s||'').toLowerCase()
    .replace(/[門]/g,'门').replace(/[鈴]/g,'铃').replace(/[進]/g,'进').replace(/[鐵]/g,'铁')
    .replace(/[寫]/g,'写').replace(/[筆]/g,'笔').replace(/[廁厠]/g,'厕').replace(/[馬]/g,'马')
    .replace(/[滿]/g,'满').replace(/[沖]/g,'冲').replace(/[劃]/g,'划').replace(/[廳]/g,'厅')
    .replace(/沫桶|满桶/g,'马桶').replace(/充水/g,'冲水').replace(/塑料代/g,'塑料袋')
    .replace(/钢比|刚笔/g,'钢笔').replace(/建刀/g,'剪刀').replace(/划柴|画火柴/g,'划火柴')
    .replace(/[\s，。！？、,.!?；;：:“”"'‘’（）()【】\[\]-]/g,'');
}
function semanticText(s='') {
  let out=normalize(s);
  for (const p of FILLER_PATTERNS.map(normalize).filter(Boolean)) out=out.replaceAll(p,'');
  return collapseRepeatedText(out);
}
function collapseRepeatedText(s='') {
  let out=s;
  for (let size=2; size<=8; size++) {
    const re=new RegExp(`(.{${size}})\\1+`,'g');
    out=out.replace(re,'$1');
  }
  return out;
}
function isNegatedAt(text, index) {
  const prefix=text.slice(Math.max(0,index-5), index);
  return /不是|不像|没有|沒|不对|不太像|别是/.test(prefix);
}
function affirmativeText(text) {
  return text
    .replace(/不是(.+?)是/g,'')
    .replace(/不像(.+?)是/g,'')
    .replace(/不太像(.+?)是/g,'')
    .replace(/没有(.+?)是/g,'')
    .replace(/不是.+$/,'')
    .replace(/不像.+$/,'')
    .replace(/不太像.+$/,'')
    .replace(/没有.+$/,'');
}
function uniqueTerms(sound) {
  return [...new Set([sound.name, ...(sound.tags||[]), ...(SEMANTIC_INTENTS[sound.id]||[])]
    .map(semanticText).filter(t=>t.length>=2))];
}
function charOverlap(a,b) {
  const aa=[...new Set([...a])], bb=new Set([...b]);
  return aa.length ? aa.filter(c=>bb.has(c)).length/aa.length : 0;
}
function semanticMatch(sound, answer) {
  const answerText=affirmativeText(semanticText(answer));
  const terms=uniqueTerms(sound).sort((a,b)=>b.length-a.length);
  if(!answerText) return {ok:false, score:0, type:'empty', matched:''};
  for(const term of terms) {
    const at=answerText.indexOf(term);
    if(at>=0&&!isNegatedAt(answerText,at)) return {ok:true, score:1, type:'term_contains', matched:term};
    const reverse=term.indexOf(answerText);
    if(answerText.length>=2&&reverse>=0&&!isNegatedAt(answerText,0)) return {ok:true, score:.92, type:'answer_contains', matched:term};
  }
  let best={score:0, term:''};
  for(const term of terms.filter(t=>t.length>=3)) {
    const at=answerText.indexOf(term);
    if(at>=0&&isNegatedAt(answerText,at)) continue;
    const score=charOverlap(term,answerText);
    if(score>best.score) best={score,term};
  }
  const ok=best.score>=.72&&answerText.length>=2;
  return {ok, score:Number(best.score.toFixed(2)), type:ok?'semantic_overlap':'no_match', matched:best.term};
}
function publicSound(s) { const {correct, answerHistory, answerTextStats, ...safe}=s; return {...safe, listens:Number(s.listens||0), accuracy:s.plays ? Math.round(s.correct/s.plays*100) : 0}; }
function adminSound(s, users=[]) {
  const names=new Map(users.map(u=>[u.id,u.name||'匿名玩家']));
  const history=[...(s.answerHistory||[])]
    .sort((a,b)=>new Date(b.at)-new Date(a.at))
    .map(h=>({...h,userName:names.get(h.userId)||'匿名玩家'}));
  const stats=buildAnswerTextStats(s);
  return {...publicSound(s), answerHistory:history, answerHistoryCount:history.length, answerTextStats:stats};
}
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
  return {total,correct,accuracy:total ? Math.round(correct/total*100) : 0};
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
      accuracy:totals.accuracy,
      playthrough:Number(latest.playthrough||1)||1,
      completedAt:latest.shownAt||latest.completedAt||'',
      shownAt:latest.shownAt||'',
      current:Boolean(currentId&&u.id===currentId)
    };
  }).filter(Boolean).sort((a,b)=>new Date(b.completedAt||0)-new Date(a.completedAt||0));
  if(currentId) {
    const index=rows.findIndex(x=>x.id===currentId);
    if(index>0) rows.unshift(rows.splice(index,1)[0]);
    if(rows[0]&&rows[0].id===currentId) rows[0].current=true;
  }
  return rows.slice(0,10);
}
function completedRoundsForUser(userId, sessions) { return sessions.filter(s=>s.userId===userId&&(s.soundIds||[]).length>0&&(s.answers||[]).length>=(s.soundIds||[]).length).length; }
function resultProfileKeyForAccuracy(accuracy) {
  const value=Number(accuracy)||0;
  if(value>=100) return 'perfect';
  if(value>=60) return 'good';
  if(value>=20) return 'low';
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
      const accuracy=total?Math.round(correct/total*100):0;
      const profileKey=resultProfileKeyForAccuracy(accuracy);
      return {
        sessionId:s.id,
        startedAt:s.startedAt||'',
        completedAt:sessionCompletedAt(s),
        accuracy,
        profileKey,
        profileFile:resultProfileFile(profileKey)
      };
    })
    .sort((a,b)=>new Date(b.completedAt||b.startedAt||0)-new Date(a.completedAt||a.startedAt||0));
}
function answerStatusLabel(answer) {
  if(!answer) return '未答';
  if(answer.recognized===false) return '未识别';
  if(answer.transcriptionStatus&&answer.transcriptionStatus!=='ok') return '识别失败';
  return answer.correct ? '答对' : '答错';
}
function adminAnswerRecord(soundId, sound, answer, index) {
  return {
    index,
    soundId,
    soundName:sound?.name||'未知题目',
    originalName:sound?.originalName||'',
    tags:Array.isArray(sound?.tags)?sound.tags.slice(0,6):[],
    answer:answer?.answer||'',
    correct:Boolean(answer?.correct),
    answered:Boolean(answer),
    answeredAt:answer?.at||'',
    inputMode:answer?.recovered ? 'recovered' : (answer?.inputMode||''),
    recognized:answer ? answer.recognized!==false : false,
    transcriptionStatus:answer?.transcriptionStatus||'',
    transcriptionReason:answer?.transcriptionReason||'',
    statusLabel:answerStatusLabel(answer)
  };
}
function adminUserAnswerHistory(data, u) {
  const sessionList=sessionsFor(data,u)
    .filter(s=>s&&s.userId===u.id&&!isTestSession(s)&&Array.isArray(s.soundIds)&&s.soundIds.length)
    .sort((a,b)=>new Date(a.startedAt||0)-new Date(b.startedAt||0));
  const soundsById=new Map((data.sounds||[]).map(s=>[s.id,s]));
  const rounds=sessionList.map((session,roundIndex)=>{
    const answers=Array.isArray(session.answers)?session.answers:[];
    const answersBySound=new Map(answers.filter(a=>a&&a.soundId).map(a=>[a.soundId,a]));
    const soundIds=session.soundIds||[];
    const records=soundIds.map((soundId,index)=>{
      const sound=soundsById.get(soundId);
      const answer=answersBySound.get(soundId)||null;
      return adminAnswerRecord(soundId,sound,answer,index+1);
    });
    const listedSoundIds=new Set(soundIds);
    const extraAnswers=answers
      .filter(answer=>answer?.soundId&&!listedSoundIds.has(answer.soundId))
      .sort((a,b)=>new Date(a.at||0)-new Date(b.at||0));
    for(const answer of extraAnswers) {
      records.push(adminAnswerRecord(answer.soundId,soundsById.get(answer.soundId),answer,records.length+1));
    }
    const answered=records.filter(r=>r.answered).length;
    const correct=records.filter(r=>r.correct).length;
    const total=records.length;
    return {
      sessionId:session.id,
      roundIndex:roundIndex+1,
      playthrough:sessionPlaythrough(session),
      startedAt:session.startedAt||'',
      completedAt:sessionCompletedAt(session),
      total,
      answered,
      correct,
      accuracy:answered ? Math.round(correct/answered*100) : 0,
      records
    };
  });
  return {
    user:userPublic(u,data.sounds,sessionList),
    generatedAt:new Date().toISOString(),
    rounds
  };
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
function codexSessionFiles(dir=path.join(os.homedir(),'.codex','sessions'), out=[]) {
  if(!fs.existsSync(dir)) return out;
  for(const name of fs.readdirSync(dir)) {
    const file=path.join(dir,name);
    let st;
    try { st=fs.statSync(file); } catch { continue; }
    if(st.isDirectory()) codexSessionFiles(file,out);
    else if(name.endsWith('.jsonl')) out.push(file);
  }
  return out;
}
function latestTokenUsageFromText(text) {
  let latest=null;
  for(const line of text.split(/\r?\n/)) {
    if(!line.includes('"token_count"')) continue;
    let event;
    try { event=JSON.parse(line); } catch { continue; }
    const usage=event?.payload?.info?.total_token_usage;
    if(event?.type==='event_msg'&&event?.payload?.type==='token_count'&&usage?.total_tokens) {
      latest={timestamp:event.timestamp, usage};
    }
  }
  return latest;
}
function projectSessionScore(text) {
  const markers=[ROOT,path.basename(ROOT),'声音侦探','声音游戏','声音文件'];
  return markers.reduce((sum,marker)=>sum+(marker&&text.includes(marker)?1:0),0);
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
  const sessions=[];
  for(const file of codexSessionFiles()) {
    let text;
    try { text=fs.readFileSync(file,'utf8'); } catch { continue; }
    const score=projectSessionScore(text);
    if(!score) continue;
    const latest=latestTokenUsageFromText(text);
    if(!latest) continue;
    sessions.push({file,score,...latest});
  }
  if(!sessions.length) return { totalTokens:null, source:'codex-session-log', updatedAt:null, sessionCount:0, asrTranscriptionCount:asrTranscriptionCountValue };
  const total=sessions.reduce((acc,s)=>{
    const u=s.usage;
    acc.inputTokens+=u.input_tokens||0;
    acc.cachedInputTokens+=u.cached_input_tokens||0;
    acc.outputTokens+=u.output_tokens||0;
    acc.reasoningOutputTokens+=u.reasoning_output_tokens||0;
    acc.totalTokens+=u.total_tokens||0;
    return acc;
  },{inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalTokens:0});
  const updatedAt=sessions.map(s=>s.timestamp).filter(Boolean).sort().at(-1)||new Date().toISOString();
  return { ...total, source:'codex-session-log', sessionCount:sessions.length, updatedAt, asrTranscriptionCount:asrTranscriptionCountValue };
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
  const senseVoice=fileMeta(localSenseVoiceModel());
  const vad=fileMeta(localSenseVoiceVadModel());
  const whisper=fileMeta(localWhisperModel());
  const cfg=sttConfig();
  return {
    updatedAt:new Date().toISOString(),
    activeSttProvider:cfg.provider,
    items:[
      {
        stage:'工程协作',
        model:'Codex / GPT-5',
        version:'Codex Desktop · 2026-08-07',
        usage:'需求理解、代码实现、调试与诊断'
      },
      {
        stage:'首页视觉设计',
        model:'Visualize plugin',
        version:'openai-bundled visualize 1.0.19',
        usage:'品牌字标与玩法说明图的设计方向'
      },
      {
        stage:'语音转文字主链路',
        model:'FunAudioLLM SenseVoiceSmall-GGUF',
        version:senseVoice.file,
        usage:`本地 ASR，当前默认启用；运行时 ${path.basename(localSenseVoiceBin())}`,
        meta:senseVoice
      },
      {
        stage:'语音活动检测',
        model:'FunAudioLLM FSMN-VAD-GGUF',
        version:vad.file,
        usage:'SenseVoice 前置 VAD 分段',
        meta:vad
      },
      {
        stage:'语音转文字备用对照',
        model:'whisper.cpp base',
        version:whisper.file,
        usage:'本地 Whisper 对照测试，不是默认线上链路',
        meta:whisper
      },
      {
        stage:'云端转写配置',
        model:'OpenAI Audio Transcriptions',
        version:envValue('OPENAI_TRANSCRIBE_MODEL')||envValue('STT_MODEL')||'gpt-4o-mini-transcribe',
        usage:'已配置为可选云端 ASR；当前默认仍优先本地 SenseVoice'
      },
      {
        stage:'云端转写配置',
        model:'百度智能云短语音识别',
        version:envValue('BAIDU_ASR_MODEL')||`dev_pid-${envValue('BAIDU_ASR_DEV_PID')||'80001'}`,
        usage:`可选云端 ASR；当前 ${cfg.provider==='baidu'?'已启用':'未启用'}`
      },
      {
        stage:'ASR 对比诊断',
        model:'MiniMax ASR comparison tool',
        version:envValue('MINIMAX_ASR_MODEL')||'未配置',
        usage:'读取留存音频并调用可配置 MiniMax ASR endpoint，用于和当前转写结果对比'
      },
      {
        stage:'答案判定',
        model:'本地语义规则匹配器',
        version:'v0.1017',
        usage:'匹配重复说法、长描述和关键含义相同的表达'
      },
      {
        stage:'题目推荐',
        model:'本地周目推荐策略',
        version:'v0.1039',
        usage:'优先未听过声音，完成后进入下一周目，并控制低正确率题分布'
      },
      {
        stage:'行为统计',
        model:'本地埋点聚合器',
        version:'v0.1040',
        usage:'统计访问、页面停留、录音链路、接口耗时和完成耗时'
      }
    ]
  };
}
function percentile(values, p) {
  if(!values.length) return 0;
  const sorted=[...values].sort((a,b)=>a-b);
  const idx=Math.min(sorted.length-1,Math.max(0,Math.ceil(sorted.length*p)-1));
  return sorted[idx];
}
function avg(values) {
  return values.length ? Math.round(values.reduce((a,b)=>a+b,0)/values.length) : 0;
}
function eventTime(e) {
  const t=new Date(e?.at||0).getTime();
  return Number.isFinite(t) ? t : 0;
}
function groupBy(list, keyFn) {
  const map=new Map();
  for(const item of list) {
    const key=keyFn(item)||'未分类';
    if(!map.has(key)) map.set(key,[]);
    map.get(key).push(item);
  }
  return map;
}
function analyticsEvent(input={}, req) {
  const details=input.details&&typeof input.details==='object' ? input.details : {};
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
    userAgent:String(input.userAgent||req.headers['user-agent']||'').slice(0,240),
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
  return event;
}
function analyticsSummary(data) {
  const events=[...(data.analyticsEvents||[])].sort((a,b)=>eventTime(a)-eventTime(b));
  const now=Date.now();
  const recent=events.filter(e=>now-eventTime(e)<=30*60*1000);
  const uniqueDevices=new Set(events.map(e=>e.deviceId).filter(Boolean));
  const uniqueUsers=new Set(events.map(e=>e.userId).filter(Boolean));
  const byType=[...groupBy(events,e=>e.type)].map(([type,items])=>({
    type,
    count:items.length,
    latestAt:items.at(-1)?.at||''
  })).sort((a,b)=>b.count-a.count||a.type.localeCompare(b.type));
  const pageLeaves=events.filter(e=>(e.type==='page_leave'||e.type==='section_leave')&&e.durationMs>0);
  const pageStats=[...groupBy(pageLeaves,e=>e.path||e.page)].map(([page,items])=>{
    const durations=items.map(e=>e.durationMs).filter(Boolean);
    return {page,count:items.length,avgDurationMs:avg(durations),p95DurationMs:percentile(durations,.95),maxDurationMs:Math.max(0,...durations)};
  }).sort((a,b)=>b.count-a.count);
  const apiEvents=events.filter(e=>e.type==='api_response'||e.type==='api_error');
  const apiStats=[...groupBy(apiEvents,e=>e.details?.url||'unknown')].map(([url,items])=>{
    const durations=items.map(e=>Number(e.details?.durationMs||e.durationMs||0)).filter(Boolean);
    const errors=items.filter(e=>e.type==='api_error'||e.details?.ok===false).length;
    return {url,count:items.length,errors,avgMs:avg(durations),p95Ms:percentile(durations,.95),latestAt:items.at(-1)?.at||''};
  }).sort((a,b)=>b.errors-a.errors||b.count-a.count);
  const roundDurations=events.filter(e=>e.type==='round_complete').map(e=>Number(e.durationMs||e.details?.durationMs||0)).filter(Boolean);
  const libraryDurations=events.filter(e=>e.type==='library_complete').map(e=>Number(e.durationMs||e.details?.durationMs||0)).filter(Boolean);
  const startedRounds=events.filter(e=>e.type==='game_started').length;
  const completedRounds=events.filter(e=>e.type==='round_complete').length;
  const recording={
    recordClicks:events.filter(e=>e.type==='record_click').length,
    recordStarted:events.filter(e=>e.type==='record_started').length,
    recordStops:events.filter(e=>e.type==='record_stop_click').length,
    recordAutoStops:events.filter(e=>e.type==='record_auto_stopped').length,
    micOpened:events.filter(e=>e.type==='mic_opened').length,
    audioUploaded:events.filter(e=>e.type==='audio_probe_uploaded').length,
    transcribed:events.filter(e=>e.type==='audio_only_transcribed'||e.type==='speech_recognized').length,
    audioReceivedNoText:events.filter(e=>e.type==='audio_only_received'||e.type==='speech_ended_empty').length,
    errors:events.filter(e=>['mic_error','speech_error','audio_probe_upload_failed','audio_probe_error'].includes(e.type)).length
  };
  return {
    generatedAt:new Date().toISOString(),
    totalEvents:events.length,
    recentEvents:recent.length,
    uniqueDevices:uniqueDevices.size,
    uniqueUsers:uniqueUsers.size,
    startedRounds,
    completedRounds,
    abandonedRounds:Math.max(0,startedRounds-completedRounds),
    avgRoundMs:avg(roundDurations),
    p95RoundMs:percentile(roundDurations,.95),
    avgLibraryMs:avg(libraryDurations),
    p95LibraryMs:percentile(libraryDurations,.95),
    recording,
    eventCounts:byType.slice(0,40),
    pageStats,
    apiStats,
    recent:events.slice(-80).reverse()
  };
}
function cleanDetails(details={}) { return Object.fromEntries(Object.entries(details).map(([k,v]) => [k, typeof v==='string' ? v.slice(0,200) : v])); }
function appendMonitor(session, source, type, message, details={}) { session.monitor=session.monitor||[]; const event={id:crypto.randomUUID(),at:new Date().toISOString(),source,type,message,details:cleanDetails(details)}; session.monitor.push(event); if(session.monitor.length>200) session.monitor=session.monitor.slice(-200); return event; }
function judgeAnswer(sound, answer) { const m=semanticMatch(sound,answer); return { correct:m.ok, message:m.ok ? '答对了！你听得很准。' : `差一点，正确答案是「${sound.name}」`, match:m }; }
function recordJudgedAnswer(data, session, sound, answer, options={}) {
  const u=session&&getUserById(data,session.userId);
  if(!session||!u||!sound) return {ok:false,error:'题目不存在'};
  if(session.answers.some(a=>a.soundId===sound.id)) return {ok:false,duplicate:true,user:u};
  const text=String(answer||'').trim().slice(0,500);
  const result=text ? judgeAnswer(sound,text) : {correct:false,message:'没有识别到文字',match:{ok:false,score:0,type:'empty',matched:''}};
  const answeredAt=options.at||new Date().toISOString();
  const answerRecord={
    soundId:sound.id,
    answer:text,
    correct:result.correct,
    at:answeredAt,
    inputMode:options.inputMode||'text'
  };
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
function parseMultipart(buffer, contentType) { const boundary=contentType.match(/boundary=(.+)$/)?.[1]; if(!boundary) throw Error('缺少上传边界'); const parts=buffer.toString('binary').split(`--${boundary}`); const fields={}, files=[]; for(const p of parts){ const idx=p.indexOf('\r\n\r\n'); if(idx<0) continue; const head=p.slice(0,idx), content=p.slice(idx+4,-2); const name=head.match(/name="([^"]+)"/)?.[1]; const file=head.match(/filename="([^"]*)"/)?.[1]; if(!name) continue; if(file) files.push({name, filename:path.basename(file), type:head.match(/Content-Type: ([^\r]+)/)?.[1]||'application/octet-stream', data:Buffer.from(content,'binary')}); else fields[name]=content; } return {fields,files}; }
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
    const key=cloudAssetKey(safe);
    if(key) {
      const value=await activeCloudContext().store.get(key,{type:'arrayBuffer'});
      if(!value) return send(res,404,{error:'未找到资源'});
      return serveBuffer(req,res,Buffer.from(value),path.basename(key),headers,'public, max-age=3600');
    }
  }
  const target=path.join(ROOT,safe);
  if(!target.startsWith(ROOT)||!fs.existsSync(target)||fs.statSync(target).isDirectory()) return send(res,404,{error:'未找到资源'});
  return serveLocalFile(req,res,target,headers);
}
function isAdminAssetPath(p) {
  return /^\/public\/admin(?:[-.]|$)/.test(p);
}
function isAdminPath(p) { return p.startsWith('/api/admin/') || ['/admin.html','/admin-users.html','/admin-tags.html','/admin-analytics.html'].includes(p) || isAdminAssetPath(p); }
function adminSecretPath() {
  const raw=String(envValue('ADMIN_SECRET_PATH')||envValue('DX100_ADMIN_PATH')||'').trim();
  if(!raw) return '';
  return `/${raw.replace(/^\/+|\/+$/g,'')}`;
}
function adminToken() {
  return String(envValue('ADMIN_TOKEN')||envValue('DX100_ADMIN_TOKEN')||'').trim();
}
function cookieValue(req, name) {
  const cookies=String(req.headers?.cookie||'').split(';');
  for(const item of cookies) {
    const idx=item.indexOf('=');
    if(idx<0) continue;
    const key=item.slice(0,idx).trim();
    if(key===name) return decodeURIComponent(item.slice(idx+1).trim());
  }
  return '';
}
function isAdminAuthorized(req) {
  const token=adminToken();
  if(!token) return !PUBLIC_MODE;
  return cookieValue(req,'dx100_admin')===token||String(req.headers?.['x-dx100-admin-token']||'')===token;
}
function adminSecretFile(p) {
  const base=adminSecretPath();
  if(!base) return '';
  const clean=p.replace(/\/+$/,'')||'/';
  if(clean===base) return 'public/admin.html';
  if(clean===`${base}/users`) return 'public/admin-users.html';
  if(clean===`${base}/analytics`) return 'public/admin-analytics.html';
  if(clean===`${base}/tags`) return 'public/admin-tags.html';
  return '';
}
function adminCookieHeader() {
  const token=adminToken();
  if(!token) return '';
  const secure=isNetlifyRuntime()?'; Secure':'';
  return `dx100_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`;
}
async function serveAdminFile(req,res,file,setCookie=false) {
  if(!setCookie&&!isAdminAuthorized(req)) return send(res,404,{error:'未找到页面'});
  const headers={'Cache-Control':'no-store'};
  const cookie=setCookie?adminCookieHeader():'';
  if(cookie) headers['Set-Cookie']=cookie;
  return serveFile(req,res,file,headers);
}
async function writeUploadFile(filename, buffer) {
  const safe=path.basename(filename);
  if(isCloudRuntime()) {
    await activeCloudContext().store.set(`uploads/${safe}`,buffer);
    return;
  }
  fs.writeFileSync(path.join(UPLOADS,safe),buffer);
}
async function deleteUploadFile(filename) {
  const safe=path.basename(filename);
  if(isCloudRuntime()) {
    await activeCloudContext().store.delete(`uploads/${safe}`);
    return;
  }
  fs.rmSync(path.join(UPLOADS,safe),{force:true});
}
function audioExt(mime='') { const type=mime.split(';')[0].trim().toLowerCase(); return { 'audio/mp4':'.m4a', 'audio/x-m4a':'.m4a', 'audio/aac':'.aac', 'audio/mpeg':'.mp3', 'audio/mp3':'.mp3', 'audio/wav':'.wav', 'audio/x-wav':'.wav', 'audio/webm':'.webm', 'audio/ogg':'.ogg' }[type] || ''; }
function audioFilename(file) { const ext=audioExt(file.type)||path.extname(file.filename)||'.webm'; const base=path.parse(file.filename||'answer').name.replace(/[^\w.-]/g,'').slice(0,40)||'answer'; return `${base}${ext}`; }
function cleanupAsrRecordings(now=Date.now()) {
  if(!fs.existsSync(ASR_RECORDINGS)) return 0;
  const cutoff=now-ASR_RETENTION_MS;
  let removed=0;
  for(const name of fs.readdirSync(ASR_RECORDINGS)) {
    const file=path.join(ASR_RECORDINGS,name);
    let st;
    try { st=fs.statSync(file); } catch { continue; }
    if(st.isFile()&&st.mtimeMs<cutoff) {
      fs.rmSync(file,{force:true});
      removed++;
    }
  }
  return removed;
}
function saveAsrRecording(file, fields, session, sound) {
  cleanupAsrRecordings();
  fs.mkdirSync(ASR_RECORDINGS,{recursive:true});
  const now=new Date();
  const stamp=now.toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z');
  const ext=audioExt(file.type)||path.extname(file.filename)||'.webm';
  const base=`${stamp}-${crypto.randomUUID()}`;
  const audioFile=`${base}${ext}`;
  const metaFile=`${base}.json`;
  const audioPath=path.join(ASR_RECORDINGS,audioFile);
  const metaPath=path.join(ASR_RECORDINGS,metaFile);
  fs.writeFileSync(audioPath,file.data);
  const meta={
    id:base,
    createdAt:now.toISOString(),
    retentionDays:7,
    sessionId:session.id,
    userId:session.userId,
    soundId:fields.soundId||'',
    soundName:sound?.name||'',
    soundTags:sound?.tags||[],
    durationMs:Number(fields.durationMs||0),
    bytes:file.data.length,
    mimeType:file.type,
    originalFilename:audioFilename(file),
    audioFile,
    transcript:'',
    transcriptionStatus:'pending',
    transcriptionProvider:'',
    transcriptionModel:'',
    transcriptionReason:''
  };
  fs.writeFileSync(metaPath,JSON.stringify(meta,null,2));
  return {audioFile,metaFile,audioPath,metaPath,meta};
}
function updateAsrRecording(record, patch={}) {
  if(!record) return;
  const meta={...record.meta,...patch,updatedAt:new Date().toISOString()};
  record.meta=meta;
  fs.writeFileSync(record.metaPath,JSON.stringify(meta,null,2));
}
cleanupAsrRecordings();
setInterval(cleanupAsrRecordings, 60 * 60 * 1000).unref();
function errorSummary(e) { return [e.message, e.cause?.code, e.cause?.hostname, e.cause?.address, e.cause?.port].filter(Boolean).join(': '); }
function localSenseVoiceBin() { return path.resolve(ROOT, process.env.LOCAL_SENSEVOICE_BIN||'tools/sensevoice/llama-funasr-sensevoice'); }
function localSenseVoiceModel() { return path.resolve(ROOT, process.env.LOCAL_SENSEVOICE_MODEL||'tools/sensevoice/models/sensevoice-small-q8.gguf'); }
function localSenseVoiceVadModel() { return path.resolve(ROOT, process.env.LOCAL_SENSEVOICE_VAD_MODEL||'tools/sensevoice/models/fsmn-vad.gguf'); }
function hasLocalSenseVoice() { return fs.existsSync(localSenseVoiceBin())&&fs.existsSync(localSenseVoiceModel()); }
function localWhisperBin() { return path.resolve(ROOT, process.env.LOCAL_WHISPER_BIN||'tools/whisper-local/ggml-org-whisper.cpp-0b9af32/main'); }
function localWhisperModel() { return path.resolve(ROOT, process.env.LOCAL_WHISPER_MODEL||'tools/whisper-local/models/ggml-base-q5_1.bin'); }
function hasLocalWhisper() { return fs.existsSync(localWhisperBin())&&fs.existsSync(localWhisperModel()); }
function sttConfig() {
  const defaultProvider=isNetlifyRuntime()?'baidu':(hasLocalSenseVoice()?'sensevoice':hasLocalWhisper()?'local':envValue('GROQ_API_KEY')?'groq':'openai');
  const provider=(envValue('STT_PROVIDER')||defaultProvider).toLowerCase();
  if(provider==='sensevoice') return {
    provider,
    bin:localSenseVoiceBin(),
    model:localSenseVoiceModel(),
    vadModel:localSenseVoiceVadModel()
  };
  if(provider==='local'||provider==='whisper') return {
    provider,
    bin:localWhisperBin(),
    model:localWhisperModel(),
    language:envValue('LOCAL_WHISPER_LANGUAGE')||envValue('STT_LANGUAGE')||'zh',
    threads:envValue('LOCAL_WHISPER_THREADS')||'4'
  };
  if(provider==='groq') return {
    provider,
    apiKey:envValue('GROQ_API_KEY')||envValue('STT_API_KEY'),
    endpoint:envValue('GROQ_TRANSCRIBE_URL')||envValue('STT_TRANSCRIBE_URL')||'https://api.groq.com/openai/v1/audio/transcriptions',
    model:envValue('GROQ_TRANSCRIBE_MODEL')||envValue('STT_MODEL')||'whisper-large-v3-turbo',
    language:envValue('STT_LANGUAGE')||'zh'
  };
  if(provider==='baidu') return {
    provider,
    appId:envValue('BAIDU_APP_ID')||'',
    apiKey:envValue('BAIDU_API_KEY')||'',
    secretKey:envValue('BAIDU_SECRET_KEY')||'',
    tokenUrl:envValue('BAIDU_TOKEN_URL')||'https://aip.baidubce.com/oauth/2.0/token',
    endpoint:envValue('BAIDU_ASR_ENDPOINT')||'https://vop.baidu.com/pro_api',
    model:envValue('BAIDU_ASR_MODEL')||`dev_pid-${envValue('BAIDU_ASR_DEV_PID')||'80001'}`,
    devPid:Number(envValue('BAIDU_ASR_DEV_PID')||80001),
    format:(envValue('BAIDU_ASR_FORMAT')||'pcm').toLowerCase(),
    rate:Number(envValue('BAIDU_ASR_RATE')||16000),
    cuid:envValue('BAIDU_ASR_CUID')||'voice-detective-demo'
  };
  return {
    provider,
    apiKey:envValue('STT_API_KEY')||envValue('OPENAI_API_KEY'),
    endpoint:envValue('STT_TRANSCRIBE_URL')||envValue('OPENAI_TRANSCRIBE_URL')||'https://api.openai.com/v1/audio/transcriptions',
    model:envValue('STT_MODEL')||envValue('OPENAI_TRANSCRIBE_MODEL')||'gpt-4o-mini-transcribe',
    language:envValue('STT_LANGUAGE')||envValue('OPENAI_TRANSCRIBE_LANGUAGE')||'zh'
  };
}
async function transcribeAudio(file) {
  const cfg=sttConfig();
  if(cfg.provider==='sensevoice') return transcribeAudioSenseVoice(file,cfg);
  if(cfg.provider==='baidu') return transcribeAudioBaidu(file,cfg);
  if(cfg.provider==='local') return transcribeAudioLocal(file,cfg);
  if(cfg.provider==='whisper') return transcribeAudioLocal(file,cfg);
  if(!cfg.apiKey) return {status:'skipped', reason:`${cfg.provider} 语音转文字 API Key 未配置`};
  if(typeof fetch!=='function'||typeof FormData!=='function'||typeof Blob!=='function') return {status:'skipped', reason:'当前 Node.js 版本不支持 fetch/FormData，请使用 Node 20 或以上'};
  const started=Date.now();
  const form=new FormData();
  form.append('model',cfg.model);
  form.append('response_format','json');
  if(cfg.language) form.append('language',cfg.language);
  form.append('file',new Blob([file.data],{type:file.type||'application/octet-stream'}),audioFilename(file));
  const r=await fetch(cfg.endpoint,{method:'POST',headers:{Authorization:`Bearer ${cfg.apiKey}`},body:form});
  const text=await r.text();
  let json={};
  try{json=JSON.parse(text);}catch{}
  if(!r.ok) throw Error(json.error?.message||text.slice(0,200)||`转文字接口返回 ${r.status}`);
  return {status:'ok', text:String(json.text||json.transcript||'').trim(), provider:cfg.provider, model:cfg.model, durationMs:Date.now()-started};
}
function wavDataChunk(buffer) {
  const marker=Buffer.from('data');
  let offset=-1;
  for(let i=12;i<buffer.length-8;i++) {
    if(buffer[i]===marker[0]&&buffer[i+1]===marker[1]&&buffer[i+2]===marker[2]&&buffer[i+3]===marker[3]) {
      offset=i;
      break;
    }
  }
  if(offset<0) return buffer;
  const size=buffer.readUInt32LE(offset+4);
  return buffer.subarray(offset+8, Math.min(buffer.length, offset+8+size));
}
function audioDb(value) {
  return value>0 ? 20*Math.log10(value) : -120;
}
function percentile(values, p) {
  if(!values.length) return 0;
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.max(0,Math.min(sorted.length-1,Math.floor((sorted.length-1)*p)))];
}
function wavInfo(buffer) {
  if(!Buffer.isBuffer(buffer)||buffer.length<44||buffer.toString('ascii',0,4)!=='RIFF'||buffer.toString('ascii',8,12)!=='WAVE') return null;
  let offset=12, fmt=null, dataOffset=-1, dataSize=0;
  while(offset+8<=buffer.length) {
    const id=buffer.toString('ascii',offset,offset+4);
    const size=buffer.readUInt32LE(offset+4);
    if(id==='fmt ') fmt={format:buffer.readUInt16LE(offset+8),channels:buffer.readUInt16LE(offset+10),rate:buffer.readUInt32LE(offset+12),bits:buffer.readUInt16LE(offset+22)};
    if(id==='data') { dataOffset=offset+8; dataSize=size; break; }
    offset+=8+size+(size%2);
  }
  if(!fmt||dataOffset<0) return null;
  return {...fmt,dataOffset,dataSize};
}
function analyzeWavSpeech(buffer) {
  const fmt=wavInfo(buffer);
  if(!fmt||![1,0xfffe].includes(fmt.format)||fmt.bits!==16) return {status:'unknown',usable:true,reason:'无法解析 PCM 音频'};
  const bytesPerFrame=(fmt.bits/8)*fmt.channels;
  const sampleCount=Math.floor(fmt.dataSize/bytesPerFrame);
  const durationMs=Math.round(sampleCount/fmt.rate*1000);
  let totalSq=0, peak=0;
  const frameSamples=Math.max(1,Math.round(fmt.rate*0.02));
  const frames=[];
  for(let i=0;i<sampleCount;i+=frameSamples) {
    let sum=0, framePeak=0, n=0;
    const end=Math.min(sampleCount,i+frameSamples);
    for(let j=i;j<end;j++) {
      const pos=fmt.dataOffset+(j*bytesPerFrame);
      if(pos+1>=buffer.length) break;
      const value=buffer.readInt16LE(pos)/32768;
      const abs=Math.abs(value);
      sum+=value*value;
      totalSq+=value*value;
      if(abs>peak) peak=abs;
      if(abs>framePeak) framePeak=abs;
      n++;
    }
    frames.push({t:i/fmt.rate,rms:Math.sqrt(sum/Math.max(1,n)),peak:framePeak});
  }
  const rms=Math.sqrt(totalSq/Math.max(1,sampleCount));
  const rmsValues=frames.map(f=>f.rms).filter(Boolean);
  const noise=percentile(rmsValues,0.2);
  const thresholdDb=Math.max(-48,audioDb(noise)+14,audioDb(peak)-38);
  const active=frames.map(f=>({...f,active:audioDb(f.rms)>=thresholdDb||audioDb(f.peak)>=thresholdDb+6}));
  const first=active.find(f=>f.active);
  const last=[...active].reverse().find(f=>f.active);
  const activeMs=active.filter(f=>f.active).length*20;
  const leadingMs=first?Math.round(first.t*1000):durationMs;
  const trailingMs=last?Math.max(0,Math.round(durationMs-(last.t*1000)-20)):durationMs;
  const peakDb=audioDb(peak);
  const rmsDb=audioDb(rms);
  const noSpeech=durationMs<220||activeMs<140||peakDb<-45||rmsDb<-55;
  return {
    status:noSpeech?'no_speech':'ok',
    usable:!noSpeech,
    reason:noSpeech?'没有检测到可用人声':'',
    actualDurationMs:durationMs,
    activeMs,
    leadingSilenceMs:leadingMs,
    trailingSilenceMs:trailingMs,
    peakDb:Number(peakDb.toFixed(1)),
    rmsDb:Number(rmsDb.toFixed(1)),
    thresholdDb:Number(thresholdDb.toFixed(1))
  };
}
function audioHealthFromAnalysis(analysis, clientDurationMs=0) {
  const actualDurationMs=Number(analysis.actualDurationMs||0);
  const durationLossMs=Math.max(0,Number(clientDurationMs||0)-actualDurationMs);
  const incomplete=Number(clientDurationMs||0)>=2500&&actualDurationMs>0&&durationLossMs>900&&(actualDurationMs/Number(clientDurationMs||1))<0.85;
  const status=analysis.status==='no_speech'?'no_speech':incomplete?'incomplete':analysis.status;
  const reason=status==='incomplete'?'录音文件疑似不完整，请再录一次':analysis.reason||'';
  return {...analysis,status,reason,usable:status==='ok'||status==='unknown',clientDurationMs:Number(clientDurationMs||0),durationLossMs};
}
function inspectUploadedAudio(file, clientDurationMs=0) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dx100-audio-health-'));
  const input=path.join(dir,audioFilename(file));
  const wav=path.join(dir,'input-16k.wav');
  try {
    const direct=analyzeWavSpeech(file.data);
    if(direct.status!=='unknown') return audioHealthFromAnalysis(direct,clientDurationMs);
    fs.writeFileSync(input,file.data);
    childProcess.execFileSync('afconvert',['-f','WAVE','-d','LEI16@16000','-c','1',input,wav],{timeout:15000});
    return audioHealthFromAnalysis(analyzeWavSpeech(fs.readFileSync(wav)),clientDurationMs);
  } catch(e) {
    return {status:'unknown',usable:true,reason:`录音质量检测失败：${errorSummary(e)}`};
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
function convertAudioForBaidu(file,cfg) {
  const format=(cfg.format||'pcm').toLowerCase();
  const directInfo=wavInfo(file.data);
  if((format==='pcm'||format==='wav')&&directInfo&&[1,0xfffe].includes(directInfo.format)&&directInfo.bits===16&&directInfo.channels===1&&directInfo.rate===Number(cfg.rate||16000)) {
    return {
      data:format==='pcm'?wavDataChunk(file.data):file.data,
      format,
      direct:true,
      cleanup:()=>{}
    };
  }
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dx100-baidu-'));
  const input=path.join(dir,audioFilename(file));
  const wav=path.join(dir,'input-16k.wav');
  try {
    fs.writeFileSync(input,file.data);
    if(format==='pcm'||format==='wav') {
      childProcess.execFileSync('afconvert',['-f','WAVE','-d',`LEI16@${cfg.rate||16000}`,'-c','1',input,wav],{timeout:15000});
      const buffer=fs.readFileSync(wav);
      return {data:format==='pcm'?wavDataChunk(buffer):buffer, format, cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
    }
    return {data:file.data, format, cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
  } catch(e) {
    fs.rmSync(dir,{recursive:true,force:true});
    const stderr=e.stderr?String(e.stderr).slice(0,240):'';
    throw Error([`百度 ASR 音频转换失败：${e.message}`,stderr].filter(Boolean).join(': '));
  }
}
async function baiduAccessToken(cfg) {
  if(!cfg.apiKey||!cfg.secretKey) return {status:'skipped', reason:'百度 API Key 或 Secret Key 未配置'};
  if(typeof fetch!=='function') return {status:'skipped', reason:'当前 Node.js 版本不支持 fetch，请使用 Node 20 或以上'};
  const cacheKey=crypto.createHash('sha1').update([cfg.apiKey,cfg.secretKey,cfg.tokenUrl].join('|')).digest('hex');
  const now=Date.now();
  if(baiduTokenCache&&baiduTokenCache.key===cacheKey&&baiduTokenCache.expiresAt>now+BAIDU_TOKEN_SKEW_MS) {
    return {status:'ok', token:baiduTokenCache.token};
  }
  const url=new URL(cfg.tokenUrl);
  url.searchParams.set('grant_type','client_credentials');
  url.searchParams.set('client_id',cfg.apiKey);
  url.searchParams.set('client_secret',cfg.secretKey);
  const r=await fetch(url,{method:'POST'});
  const text=await r.text();
  let json={};
  try{json=JSON.parse(text);}catch{}
  if(!r.ok||!json.access_token) throw Error(json.error_description||json.error||text.slice(0,200)||`百度 token 接口返回 ${r.status}`);
  baiduTokenCache={
    key:cacheKey,
    token:json.access_token,
    expiresAt:now+(Number(json.expires_in||2592000)*1000)
  };
  return {status:'ok', token:json.access_token};
}
async function transcribeAudioBaidu(file,cfg) {
  const started=Date.now();
  const token=await baiduAccessToken(cfg);
  if(token.status!=='ok') return token;
  const converted=convertAudioForBaidu(file,cfg);
  try {
    const payload={
      format:converted.format,
      rate:Number(cfg.rate||16000),
      channel:1,
      cuid:String(cfg.cuid||'voice-detective-demo'),
      token:token.token,
      dev_pid:Number(cfg.devPid||80001),
      speech:converted.data.toString('base64'),
      len:converted.data.length
    };
    const r=await fetch(cfg.endpoint,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload)
    });
    const text=await r.text();
    let json={};
    try{json=JSON.parse(text);}catch{}
    if(!r.ok) throw Error(text.slice(0,240)||`百度 ASR 接口返回 ${r.status}`);
    if(Number(json.err_no)!==0) throw Error(`百度 ASR 错误 ${json.err_no}: ${json.err_msg||json.error_msg||'未知错误'}`);
    const result=Array.isArray(json.result)?json.result.join(''):String(json.result||json.text||'');
    return {status:'ok',text:result.trim(),provider:'baidu',model:cfg.model||`dev_pid-${cfg.devPid}`,durationMs:Date.now()-started};
  } finally {
    converted.cleanup();
  }
}
function cleanSenseVoiceText(text='') {
  return String(text||'')
    .replace(/\[[^\]]+\]/g,'')
    .replace(/<\|[^>]+?\|>/g,'')
    .replace(/\((?:字幕|翻译|校对|后期|制作|剪辑|出品)[^)]*\)/gi,'')
    .replace(/\s+/g,'')
    .trim();
}
async function transcribeAudioSenseVoice(file,cfg) {
  if(!fs.existsSync(cfg.bin)) return {status:'skipped', reason:`SenseVoice 程序不存在：${path.relative(ROOT,cfg.bin)}`};
  if(!fs.existsSync(cfg.model)) return {status:'skipped', reason:`SenseVoice 模型不存在：${path.relative(ROOT,cfg.model)}`};
  const started=Date.now();
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dx100-sensevoice-'));
  const input=path.join(dir,audioFilename(file));
  const wav=path.join(dir,'input-16k.wav');
  try {
    fs.writeFileSync(input,file.data);
    childProcess.execFileSync('afconvert',['-f','WAVE','-d','LEI16@16000','-c','1',input,wav],{timeout:15000});
    const args=['-m',cfg.model,'-a',wav];
    if(cfg.vadModel&&fs.existsSync(cfg.vadModel)) args.push('--vad',cfg.vadModel);
    const out=childProcess.execFileSync(cfg.bin,args,{timeout:15000,encoding:'utf8'});
    const text=cleanSenseVoiceText(out);
    return {status:'ok',text,provider:'sensevoice',model:path.basename(cfg.model),durationMs:Date.now()-started};
  } catch(e) {
    const stderr=e.stderr?String(e.stderr).slice(0,300):'';
    throw Error([e.message,stderr].filter(Boolean).join(': '));
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
async function transcribeAudioLocal(file,cfg) {
  if(!fs.existsSync(cfg.bin)) return {status:'skipped', reason:`本地 whisper 程序不存在：${path.relative(ROOT,cfg.bin)}`};
  if(!fs.existsSync(cfg.model)) return {status:'skipped', reason:`本地 whisper 模型不存在：${path.relative(ROOT,cfg.model)}`};
  const started=Date.now();
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dx100-whisper-'));
  const input=path.join(dir,audioFilename(file));
  const wav=path.join(dir,'input-16k.wav');
  const outBase=path.join(dir,'transcript');
  try {
    fs.writeFileSync(input,file.data);
    childProcess.execFileSync('afconvert',['-f','WAVE','-d','LEI16@16000','-c','1',input,wav],{timeout:15000});
    childProcess.execFileSync(cfg.bin,['-m',cfg.model,'-f',wav,'-l',cfg.language,'-t',String(cfg.threads),'-nt','-otxt','-of',outBase],{timeout:30000,encoding:'utf8'});
    const outFile=`${outBase}.txt`;
    const text=fs.existsSync(outFile)?fs.readFileSync(outFile,'utf8').replace(/\[[^\]]+\]/g,'').replace(/\s+/g,'').trim():'';
    return {status:'ok',text,provider:'local',model:path.basename(cfg.model),durationMs:Date.now()-started};
  } catch(e) {
    const stderr=e.stderr?String(e.stderr).slice(0,300):'';
    throw Error([e.message,stderr].filter(Boolean).join(': '));
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

function sleep(ms) {
  return new Promise(resolve=>setTimeout(resolve,ms));
}
function audioAnswerJobKey(sessionId, audioAnswerId) {
  return `${sessionId}:${audioAnswerId}`;
}
function createAudioAnswerRecord(fields, file, saved, audioHealth) {
  const now=new Date().toISOString();
  return {
    id:saved?.meta?.id||crypto.randomUUID(),
    sessionId:String(fields.sessionId||''),
    soundId:String(fields.soundId||''),
    status:'queued',
    createdAt:now,
    updatedAt:now,
    bytes:file.data.length,
    mimeType:file.type,
    originalFilename:audioFilename(file),
    clientDurationMs:Number(fields.durationMs||0),
    audioFile:saved?.audioFile||'',
    metaFile:saved?.metaFile||'',
    audioStatus:audioHealth.status,
    audioUsable:audioHealth.usable,
    actualDurationMs:audioHealth.actualDurationMs||0,
    durationLossMs:audioHealth.durationLossMs||0,
    activeMs:audioHealth.activeMs||0,
    leadingSilenceMs:audioHealth.leadingSilenceMs||0,
    trailingSilenceMs:audioHealth.trailingSilenceMs||0,
    peakDb:audioHealth.peakDb,
    rmsDb:audioHealth.rmsDb,
    transcript:'',
    transcriptionStatus:'queued',
    transcriptionProvider:'',
    transcriptionModel:'',
    transcriptionReason:'',
    asrDurationMs:0
  };
}
function audioAnswerRecordingHandle(audioAnswer) {
  if(!audioAnswer?.metaFile) return null;
  const metaPath=path.join(ASR_RECORDINGS,path.basename(audioAnswer.metaFile));
  let meta={};
  try {
    if(fs.existsSync(metaPath)) meta=JSON.parse(fs.readFileSync(metaPath,'utf8'));
  } catch {
    meta={};
  }
  return {metaPath,meta};
}
function audioFileFromAnswer(audioAnswer) {
  if(!audioAnswer?.audioFile) return null;
  const audioPath=path.join(ASR_RECORDINGS,path.basename(audioAnswer.audioFile));
  if(!fs.existsSync(audioPath)) return null;
  return {
    data:fs.readFileSync(audioPath),
    type:audioAnswer.mimeType||MIME[path.extname(audioPath).toLowerCase()]||'application/octet-stream',
    filename:audioAnswer.originalFilename||path.basename(audioPath)
  };
}
function pendingAudioAnswers(session) {
  const answered=new Set((session?.answers||[]).map(a=>a.soundId));
  return (session?.audioAnswers||[]).filter(a=>
    a&&!answered.has(a.soundId)&&['queued','processing'].includes(a.status)
  );
}
function recordUnrecognizedAudioAnswer(data, session, sound, audioAnswer, transcription={}) {
  const reason=transcription.reason||transcription.error||audioAnswer.transcriptionReason||'没有识别到文字';
  return recordJudgedAnswer(data,session,sound,'',{
    inputMode:'voice',
    audioAnswerId:audioAnswer.id,
    transcriptionStatus:transcription.status||audioAnswer.transcriptionStatus||'empty',
    transcriptionReason:reason,
    recognized:false,
    countSoundStats:false
  });
}
async function processAudioAnswerJob(sessionId, audioAnswerId, uploadedFile=null) {
  let data=readStore();
  await hydrateCloudSessionSidecars(data,sessionId);
  let session=getSessionById(data,sessionId);
  if(!session) return {ok:false,error:'session_missing'};
  let audioAnswer=(session.audioAnswers||[]).find(a=>a.id===audioAnswerId);
  if(!audioAnswer) return {ok:false,error:'audio_answer_missing'};
  if(!['queued','processing'].includes(audioAnswer.status)) return {ok:true,status:audioAnswer.status};
  const testMode=isTestSession(session);
  audioAnswer.status='processing';
  audioAnswer.transcriptionStatus='processing';
  audioAnswer.updatedAt=new Date().toISOString();
  appendMonitor(session,'server','audio_asr_started','后台开始识别上一题语音',{soundId:audioAnswer.soundId,audioAnswerId});
  if(!testMode) writeStore(data);

  let transcription;
  try {
    const file=uploadedFile||audioFileFromAnswer(audioAnswer);
    if(!file) {
      transcription={status:'failed',error:'录音文件不存在，无法识别'};
    } else {
      transcription=await transcribeAudio(file);
    }
  } catch(e) {
    transcription={status:'failed',error:errorSummary(e)};
  }

  data=readStore();
  await hydrateCloudSessionSidecars(data,sessionId);
  session=getSessionById(data,sessionId);
  if(!session) return {ok:false,error:'session_missing_after_transcribe'};
  audioAnswer=(session.audioAnswers||[]).find(a=>a.id===audioAnswerId);
  if(!audioAnswer) return {ok:false,error:'audio_answer_missing_after_transcribe'};
  const sound=(data.sounds||[]).find(s=>s.id===audioAnswer.soundId);
  if(!sound) {
    audioAnswer.status='failed';
    audioAnswer.transcriptionStatus='failed';
    audioAnswer.transcriptionReason='题目不存在';
    audioAnswer.updatedAt=new Date().toISOString();
    if(!testMode) writeStore(data);
    return {ok:false,error:'sound_missing'};
  }

  audioAnswer.transcript=String(transcription.text||'').trim();
  audioAnswer.transcriptionStatus=transcription.status||'failed';
  audioAnswer.transcriptionProvider=transcription.provider||'';
  audioAnswer.transcriptionModel=transcription.model||'';
  audioAnswer.transcriptionReason=transcription.reason||transcription.error||'';
  audioAnswer.asrDurationMs=transcription.durationMs||0;
  audioAnswer.updatedAt=new Date().toISOString();
  const recording=audioAnswerRecordingHandle(audioAnswer);
  if(recording) {
    updateAsrRecording(recording,{
      transcript:audioAnswer.transcript,
      transcriptionStatus:audioAnswer.transcriptionStatus,
      transcriptionProvider:audioAnswer.transcriptionProvider,
      transcriptionModel:audioAnswer.transcriptionModel,
      transcriptionReason:audioAnswer.transcriptionReason,
      asrDurationMs:audioAnswer.asrDurationMs,
      audioStatus:audioAnswer.audioStatus,
      audioUsable:audioAnswer.audioUsable,
      actualDurationMs:audioAnswer.actualDurationMs,
      durationLossMs:audioAnswer.durationLossMs,
      activeMs:audioAnswer.activeMs,
      leadingSilenceMs:audioAnswer.leadingSilenceMs,
      trailingSilenceMs:audioAnswer.trailingSilenceMs,
      peakDb:audioAnswer.peakDb,
      rmsDb:audioAnswer.rmsDb
    });
  }

  if(session.answers.some(a=>a.soundId===sound.id)) {
    audioAnswer.status='ignored';
    appendMonitor(session,'server','audio_asr_ignored','后台识别完成，但本题已经有答案',{soundId:sound.id,audioAnswerId});
  } else if(transcription.status==='ok'&&audioAnswer.transcript) {
    audioAnswer.status='completed';
    appendMonitor(session,'server','speech_transcribed','后台已识别出文字',{soundId:sound.id,transcript:audioAnswer.transcript,provider:transcription.provider,model:transcription.model,durationMs:transcription.durationMs});
    const recorded=recordJudgedAnswer(data,session,sound,audioAnswer.transcript,{
      inputMode:'voice',
      audioAnswerId,
      transcriptionStatus:transcription.status,
      transcriptionReason:audioAnswer.transcriptionReason,
      countSoundStats:true
    });
    appendMonitor(session,'server','judge_completed','后台已完成语音判题',{soundId:sound.id,recorded:recorded.ok,correct:Boolean(recorded.result?.correct)});
  } else {
    audioAnswer.status=transcription.status==='ok'?'empty':'failed';
    appendMonitor(session,'server',audioAnswer.status==='empty'?'speech_empty':'transcribe_failed',audioAnswer.status==='empty'?'后台转文字结果为空':'后台转文字失败',{soundId:sound.id,provider:transcription.provider||'',model:transcription.model||'',durationMs:transcription.durationMs||0,reason:audioAnswer.transcriptionReason});
    const recorded=recordUnrecognizedAudioAnswer(data,session,sound,audioAnswer,transcription);
    appendMonitor(session,'server','judge_completed','后台已把未识别语音记为本题未猜中',{soundId:sound.id,recorded:recorded.ok});
  }
  if(!testMode) writeStore(data);
  return {ok:true,status:audioAnswer.status,transcript:audioAnswer.transcript};
}
function queueAudioAnswerTranscription(sessionId, audioAnswerId, uploadedFile=null) {
  const key=audioAnswerJobKey(sessionId,audioAnswerId);
  if(AUDIO_ANSWER_JOBS.has(key)) return AUDIO_ANSWER_JOBS.get(key);
  const job=processAudioAnswerJob(sessionId,audioAnswerId,uploadedFile)
    .catch(e=>({ok:false,error:errorSummary(e)}))
    .finally(()=>AUDIO_ANSWER_JOBS.delete(key));
  AUDIO_ANSWER_JOBS.set(key,job);
  return job;
}
async function resolveSessionAudioAnswers(sessionId, maxWaitMs=8500) {
  const deadline=Date.now()+maxWaitMs;
  let data=readStore();
  await hydrateCloudSessionSidecars(data,sessionId);
  let session=getSessionById(data,sessionId);
  if(!session) return {data,session:null,pendingCount:0};
  let pending=pendingAudioAnswers(session);
  for(const answer of pending) queueAudioAnswerTranscription(session.id,answer.id);
  while(pending.length&&Date.now()<deadline) {
    const jobs=pending.map(a=>AUDIO_ANSWER_JOBS.get(audioAnswerJobKey(session.id,a.id))).filter(Boolean);
    const waitMs=Math.max(80,Math.min(500,deadline-Date.now()));
    if(jobs.length) await Promise.race([Promise.allSettled(jobs),sleep(waitMs)]);
    else await sleep(waitMs);
    data=readStore();
    await hydrateCloudSessionSidecars(data,sessionId);
    session=getSessionById(data,sessionId);
    if(!session) return {data,session:null,pendingCount:0};
    pending=pendingAudioAnswers(session);
    for(const answer of pending) queueAudioAnswerTranscription(session.id,answer.id);
  }
  return {data,session,pendingCount:pending.length};
}

async function handleRequest(req,res) { try {
  const url=new URL(req.url, `http://${req.headers.host}`), p=url.pathname;
  const secretAdminFile=adminSecretFile(p);
  if(secretAdminFile) return serveAdminFile(req,res,secretAdminFile,true);
  if(isAdminPath(p)&&!isAdminAuthorized(req)) return send(res,404,{error:'未找到页面'});
  if(p.startsWith('/api/demo-audio/')) return serveBuffer(req,res,wavDemo(p.split('/').pop()),`${p.split('/').pop()||'demo'}.wav`,{},'no-store');
  if(p.startsWith('/uploads/')) return serveFile(req,res,p.slice(1));
  if(p.startsWith('/images/')) return serveFile(req,res,path.join('图片文件',path.basename(decodeURIComponent(p.slice('/images/'.length)))));
  if(req.method==='GET'&&p==='/api/team-stats') return send(res,200,teamStats());
  if(req.method==='GET'&&p==='/api/team-models') return send(res,200,teamModels());
  if(req.method==='POST'&&p==='/api/game/audio-check'&&!takeRateLimit(`audio-check-pre:${clientIp(req)}`,{windowMs:30000,max:12,minIntervalMs:500})) {
    return sendRateLimited(res,'录音上传太频繁，请稍后再试',1200);
  }
  const data=readStore();
  if(isCloudRuntime()&&req.method==='GET'&&p.startsWith('/api/admin/')) {
    await hydrateCloudSidecars(activeCloudContext().store,data);
  }
  if(req.method==='GET'&&p==='/api/sounds') return send(res,200,data.sounds.map(publicSound));
  if(req.method==='GET'&&p==='/api/admin/sounds') return send(res,200,data.sounds.map(s=>adminSound(s,data.users)));
  if(req.method==='GET'&&p==='/api/admin/users') return send(res,200,data.users.filter(u=>!isTestUser(u)).map(u=>userPublic(u,data.sounds,data.sessions)).sort((a,b)=>new Date(b.lastSeen)-new Date(a.lastSeen)));
  const adminUserAnswersMatch=p.match(/^\/api\/admin\/users\/([^/]+)\/answers$/);
  if(req.method==='GET'&&adminUserAnswersMatch) {
    const userId=decodeURIComponent(adminUserAnswersMatch[1]);
    const u=data.users.find(user=>!isTestUser(user)&&user.id===userId);
    if(!u) return send(res,404,{error:'用户不存在'});
    if(isCloudRuntime()) await hydrateCloudUserSidecars(data,u.id);
    return send(res,200,adminUserAnswerHistory(data,u));
  }
  if(req.method==='GET'&&p==='/api/admin/analytics') return send(res,200,analyticsSummary(data));
  if(req.method==='POST'&&p==='/api/analytics/event') {
    const raw=(await body(req)).toString();
    const x=raw ? JSON.parse(raw) : {};
    if(isTestRequest(req,url,x)) return send(res,200,{ok:true,skipped:true,testMode:true});
    if(analyticsRateLimited(req,url,x)) return send(res,200,{ok:true,skipped:true,reason:'rate_limited'});
    const event=appendAnalyticsEvent(data,x,req);
    writeStore(data);
    return send(res,200,{ok:true,id:event.id});
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
    const startRequestTest=isTestRequest(req,url,x);
    let u=getUserById(data,x.userId);
    if(!u&&x.deviceId) u=startRequestTest ? upsertTestUser(x) : upsertRealUser(data,x);
    if(!u)return send(res,404,{error:'用户不存在'});
    const startGuardKey=requestKey(req,url,x,'game-start');
    if(!enterRequestGuard(startGuardKey,2200,20000)) return sendRateLimited(res,'正在进入下一轮，请稍候',1600);
    try {
    const testMode=isTestUser(u)||startRequestTest;
    if(!testMode) await hydrateCloudUserSidecars(data,u.id,{fallbackAll:false});
    const sessionList=sessionsFor(data,u);
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
    const session={id:`${testMode?'test-session-':''}${crypto.randomUUID()}`,userId:u.id,soundIds:q.map(s=>s.id),answers:[],monitor:[],startedAt:new Date().toISOString(),playthrough,libraryCompleteBefore:progress.libraryComplete,libraryAnsweredBefore:progress.libraryAnswered,libraryTotal:progress.libraryTotal,recommendation:picked.meta,isTest:testMode};
    appendMonitor(session,'server','session_started','后端已创建本轮答题',{questionCount:q.length,soundIds:q.map(s=>s.id),playthrough,libraryCompleteBefore:progress.libraryComplete,libraryAnsweredBefore:progress.libraryAnswered,libraryTotal:progress.libraryTotal,recommendation:picked.meta});
    if(testMode) {
      TEST_SESSIONS.set(session.id,session);
      return send(res,200,{sessionId:session.id,questions:q.map(publicSound),playthrough,testMode:true});
    }
    queueCloudSessionSidecar(session);
    data.sessions.push(session);
    writeStore(data);
    return send(res,200,{sessionId:session.id,questions:q.map(publicSound),playthrough});
    } finally {
      leaveRequestGuard(startGuardKey,2200,20000);
    }
  }
  if(req.method==='GET'&&p.startsWith('/api/game/monitor/')) { const sessionId=p.split('/').pop(); await hydrateCloudSessionSidecars(data,sessionId); if(!takeRateLimit(requestKey(req,url,{sessionId},'monitor-poll'),{windowMs:3000,max:6,minIntervalMs:350})) return sendRateLimited(res,'监控刷新太频繁，请稍后再试',800); const s=getSessionById(data,sessionId);if(!s)return send(res,404,{error:'监控记录不存在'});return send(res,200,{sessionId:s.id,startedAt:s.startedAt,answeredCount:(s.answers||[]).length,total:s.soundIds.length,events:s.monitor||[]}); }
  if(req.method==='POST'&&p==='/api/game/monitor-event') { const x=JSON.parse((await body(req)).toString()); await hydrateCloudSessionSidecars(data,x.sessionId); const session=getSessionById(data,x.sessionId); if(!session)return send(res,404,{error:'监控记录不存在'}); if(!takeRateLimit(requestKey(req,url,x,`monitor-event:${String(x.type||'').slice(0,60)}`),{windowMs:3000,max:8,minIntervalMs:180})) return send(res,200,{ok:true,skipped:true,reason:'rate_limited',testMode:isTestSession(session)}); const event=appendMonitor(session,'client',String(x.type||'client_event').slice(0,60),String(x.message||'客户端事件').slice(0,120),x.details||{}); if(!isTestSession(session)) writeStore(data); return send(res,200,{ok:true,event,testMode:isTestSession(session)}); }
  if(req.method==='POST'&&p==='/api/game/audio-check') {
    const b=await body(req), {fields,files}=parseMultipart(b,req.headers['content-type']||'');
    await hydrateCloudSessionSidecars(data,fields.sessionId);
    const session=getSessionById(data,fields.sessionId);
    if(!session)return send(res,404,{error:'监控记录不存在'});
    const testMode=isTestSession(session)||isTestRequest(req,url,fields);
    const f=files[0];
    if(!f)return send(res,400,{error:'没有收到音频数据'});
    const audioGuardKey=requestKey(req,url,fields,'audio-check');
    if(!enterRequestGuard(audioGuardKey,1800,60000)) return sendRateLimited(res,'录音正在处理，请稍候',1600);
    try {
    const sound=data.sounds.find(s=>s.id===fields.soundId);
    if(!sound||!(session.soundIds||[]).includes(sound.id)) return send(res,404,{error:'题目不存在'});
    if((session.answers||[]).some(a=>a.soundId===sound.id)) {
      appendMonitor(session,'server','audio_answer_rejected','后端拒绝重复语音答案',{soundId:sound.id});
      if(!testMode) writeStore(data);
      return send(res,409,{error:'本题已作答'});
    }
    const clientDurationMs=Number(fields.durationMs||0);
    const audioHealth=inspectUploadedAudio(f,clientDurationMs);
    const saved=(!testMode&&!isCloudRuntime())?saveAsrRecording(f,fields,session,sound):null;
    const event=appendMonitor(session,'server','audio_received','后端已收到诊断音频',{soundId:fields.soundId||'',bytes:f.data.length,mimeType:f.type,durationMs:clientDurationMs,filename:audioFilename(f),asrAudioFile:saved?.audioFile||'',testMode,audioStatus:audioHealth.status,actualDurationMs:audioHealth.actualDurationMs||0,durationLossMs:audioHealth.durationLossMs||0,activeMs:audioHealth.activeMs||0});
    if(audioHealth.status==='no_speech') appendMonitor(session,'server','speech_missing','后端没有检测到可用人声',{soundId:fields.soundId||'',...audioHealth});
    else if(audioHealth.status==='incomplete') appendMonitor(session,'server','audio_incomplete','录音文件疑似不完整',{soundId:fields.soundId||'',...audioHealth});
    else if(audioHealth.status==='unknown') appendMonitor(session,'server','audio_health_unknown','录音质量检测未完成',{soundId:fields.soundId||'',reason:audioHealth.reason});
    else appendMonitor(session,'server','audio_health_ok','录音质量检测通过',{soundId:fields.soundId||'',...audioHealth});
    if(!audioHealth.usable) {
      if(!testMode) {
        updateAsrRecording(saved,{transcriptionStatus:audioHealth.status,transcriptionReason:audioHealth.reason||'',audioStatus:audioHealth.status,audioUsable:false,actualDurationMs:audioHealth.actualDurationMs||0,durationLossMs:audioHealth.durationLossMs||0,activeMs:audioHealth.activeMs||0,leadingSilenceMs:audioHealth.leadingSilenceMs||0,trailingSilenceMs:audioHealth.trailingSilenceMs||0,peakDb:audioHealth.peakDb,rmsDb:audioHealth.rmsDb});
        writeStore(data);
      }
      return send(res,200,{ok:true,received:true,accepted:false,pending:false,bytes:f.data.length,mimeType:f.type,event,soundId:fields.soundId||'',transcript:'',transcriptionStatus:audioHealth.status,transcriptionReason:audioHealth.reason||'',transcriptionProvider:'',transcriptionModel:'',asrDurationMs:0,asrAudioFile:saved?.audioFile||'',audioStatus:audioHealth.status,audioUsable:false,actualDurationMs:audioHealth.actualDurationMs||0,durationLossMs:audioHealth.durationLossMs||0,activeMs:audioHealth.activeMs||0,leadingSilenceMs:audioHealth.leadingSilenceMs||0,trailingSilenceMs:audioHealth.trailingSilenceMs||0,peakDb:audioHealth.peakDb,rmsDb:audioHealth.rmsDb,testMode});
    }
    session.audioAnswers=Array.isArray(session.audioAnswers)?session.audioAnswers:[];
    let audioAnswer=session.audioAnswers.find(a=>a.soundId===sound.id&&['queued','processing'].includes(a.status));
    if(!audioAnswer) {
      audioAnswer=createAudioAnswerRecord(fields,f,saved,audioHealth);
      session.audioAnswers.push(audioAnswer);
      appendMonitor(session,'server','audio_asr_queued','录音已通过质量检查，后台排队识别',{soundId:sound.id,audioAnswerId:audioAnswer.id,asrAudioFile:saved?.audioFile||''});
    }
    if(!testMode) {
      updateAsrRecording(saved,{transcriptionStatus:'queued',transcriptionReason:'后台排队识别中',audioStatus:audioHealth.status,audioUsable:true,actualDurationMs:audioHealth.actualDurationMs||0,durationLossMs:audioHealth.durationLossMs||0,activeMs:audioHealth.activeMs||0,leadingSilenceMs:audioHealth.leadingSilenceMs||0,trailingSilenceMs:audioHealth.trailingSilenceMs||0,peakDb:audioHealth.peakDb,rmsDb:audioHealth.rmsDb});
      writeStore(data);
    }
    if(isCloudRuntime()) {
      await queueAudioAnswerTranscription(session.id,audioAnswer.id,f);
      const latest=readStore();
      const latestSession=getSessionById(latest,session.id);
      const latestAnswer=(latestSession?.audioAnswers||[]).find(a=>a.id===audioAnswer.id)||audioAnswer;
      return send(res,200,{ok:true,received:true,accepted:true,pending:false,bytes:f.data.length,mimeType:f.type,event,soundId:sound.id,audioAnswerId:latestAnswer.id,transcript:latestAnswer.transcript||'',transcriptionStatus:latestAnswer.transcriptionStatus||latestAnswer.status||'',transcriptionReason:latestAnswer.transcriptionReason||'',transcriptionProvider:latestAnswer.transcriptionProvider||'',transcriptionModel:latestAnswer.transcriptionModel||'',asrDurationMs:latestAnswer.asrDurationMs||0,asrAudioFile:'',audioStatus:latestAnswer.audioStatus||audioHealth.status,audioUsable:latestAnswer.audioUsable!==false,actualDurationMs:latestAnswer.actualDurationMs||audioHealth.actualDurationMs||0,durationLossMs:latestAnswer.durationLossMs||audioHealth.durationLossMs||0,activeMs:latestAnswer.activeMs||audioHealth.activeMs||0,leadingSilenceMs:latestAnswer.leadingSilenceMs||audioHealth.leadingSilenceMs||0,trailingSilenceMs:latestAnswer.trailingSilenceMs||audioHealth.trailingSilenceMs||0,peakDb:latestAnswer.peakDb, rmsDb:latestAnswer.rmsDb,testMode});
    }
    queueAudioAnswerTranscription(session.id,audioAnswer.id);
    return send(res,200,{ok:true,received:true,accepted:true,pending:true,bytes:f.data.length,mimeType:f.type,event,soundId:sound.id,audioAnswerId:audioAnswer.id,transcript:'',transcriptionStatus:'queued',transcriptionReason:'后台排队识别中',transcriptionProvider:'',transcriptionModel:'',asrDurationMs:0,asrAudioFile:saved?.audioFile||audioAnswer.audioFile||'',audioStatus:audioHealth.status,audioUsable:true,actualDurationMs:audioHealth.actualDurationMs||0,durationLossMs:audioHealth.durationLossMs||0,activeMs:audioHealth.activeMs||0,leadingSilenceMs:audioHealth.leadingSilenceMs||0,trailingSilenceMs:audioHealth.trailingSilenceMs||0,peakDb:audioHealth.peakDb,rmsDb:audioHealth.rmsDb,testMode});
    } finally {
      leaveRequestGuard(audioGuardKey,1800,60000);
    }
  }
  if(req.method==='POST'&&p==='/api/game/answer') {
    const x=JSON.parse((await body(req)).toString());
    await hydrateCloudSessionSidecars(data,x.sessionId);
    const session=getSessionById(data,x.sessionId), u=session&&getUserById(data,session.userId), sound=session&&data.sounds.find(s=>s.id===x.soundId);
    if(!session||!u||!sound)return send(res,404,{error:'题目不存在'});
    const answerGuardKey=requestKey(req,url,x,'answer-submit');
    if(!enterRequestGuard(answerGuardKey,3000,20000)) return sendRateLimited(res,'本题判断正在提交，请稍候',1600);
    try {
    const testMode=isTestSession(session)||isTestUser(u)||isTestRequest(req,url,x);
    if(session.answers.some(a=>a.soundId===sound.id)){appendMonitor(session,'server','answer_rejected','后端拒绝重复答题',{soundId:x.soundId});if(!testMode)writeStore(data);return send(res,409,{error:'本题已作答'});}
    appendMonitor(session,'server','answer_received','后端已收到文字答案',{soundId:sound.id,answer:String(x.answer||'').slice(0,80),answerLength:String(x.answer||'').length});
    const recorded=recordJudgedAnswer(data,session,sound,x.answer,{inputMode:'text',testMode});
    if(!recorded.ok&&recorded.duplicate)return send(res,409,{error:'本题已作答'});
    if(!recorded.ok)return send(res,404,{error:recorded.error||'题目不存在'});
    appendMonitor(session,'server','judge_completed','后端已完成判题',{soundId:sound.id,recorded:true});
    if(!testMode) writeStore(data);
    return send(res,200,{ok:true,answer:x.answer,testMode});
    } finally {
      leaveRequestGuard(answerGuardKey,3000,20000);
    }
  }
  if(req.method==='GET'&&p.startsWith('/api/game/result/')) {
    const sessionId=p.split('/').pop();
    const resolved=await resolveSessionAudioAnswers(sessionId,8500);
    const resultData=resolved.data||data;
    const s=resolved.session||getSessionById(resultData,sessionId);
    if(!s)return send(res,404,{error:'记录不存在'});
    const u=getUserById(resultData,s.userId);
    if(!u)return send(res,404,{error:'用户不存在'});
    const testMode=isTestSession(s)||isTestUser(u);
    const sessionList=sessionsFor(resultData,s);
    const correct=s.answers.filter(a=>a.correct).length, total=s.soundIds.length, accuracy=total?Math.round(correct/total*100):0;
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
        statusText:a ? (recognized ? '' : '未识别到文字') : audioState ? (audioState.status==='processing'||audioState.status==='queued'?'识别中':'未识别到文字') : ''
      };
    });
    const ranking=resultData.users.filter(u=>!isTestUser(u)).map(u=>({...userPublic(u,resultData.sounds,resultData.sessions),completedRounds:completedRoundsForUser(u.id,resultData.sessions)})).filter(u=>u.completedRounds>=1).sort((a,b)=>b.accuracy-a.accuracy||b.total-a.total||b.completedRounds-a.completedRounds);
    appendMonitor(s,'server','result_requested','后端已返回结算结果',{correct,total,accuracy,playthrough:sessionPlaythrough(s),libraryAnswered:progress.libraryAnswered,libraryTotal:progress.libraryTotal,libraryCompletedThisRound,libraryCompletionPending:Boolean(pending),pendingRecognitions:resolved.pendingCount||0});
    if(!testMode) writeStore(resultData);
    return send(res,200,{correct,total,accuracy,answerReview,ranking:ranking.slice(0,10),completeRanking:completeRankingForUsers(resultData,u),user:userPublic(u,resultData.sounds,sessionList),finishedRank:ranking.findIndex(x=>x.id===u.id)+1,...progress,libraryCompletedThisRound,libraryCompletionPending:Boolean(pending),completionSessionId:pending?.sessionId||'',pendingRecognitions:resolved.pendingCount||0,testMode});
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
  if(req.method==='POST'&&p==='/api/admin/sounds') {
    const adminGuardKey=requestKey(req,url,{},'admin-upload');
    if(!enterRequestGuard(adminGuardKey,3000,60000)) return sendRateLimited(res,'声音正在上传，请稍候',2000);
    try {
      const b=await body(req), {fields,files}=parseMultipart(b,req.headers['content-type']||'');
      const f=files[0];
      if(!f)return send(res,400,{error:'请选择音频文件'});
      const ext=path.extname(f.filename)||'.audio', file=`${crypto.randomUUID()}${ext}`;
      await writeUploadFile(file,f.data);
      data.sounds.push({id:crypto.randomUUID(),originalName:f.filename,name:(fields.name||path.parse(f.filename).name).slice(0,60),tags:(fields.tags||'').split(/[,，]/).map(s=>s.trim()).filter(Boolean),createdAt:new Date().toISOString(),enabled:true,plays:0,correct:0,file,answerHistory:[],answerTextStats:[]});
      writeStore(data);
      return send(res,201,{ok:true});
    } finally {
      leaveRequestGuard(adminGuardKey,3000,60000);
    }
  }
  if(req.method==='PATCH'&&p.startsWith('/api/admin/sounds/')) { const id=p.split('/').pop(); const adminGuardKey=requestKey(req,url,{soundId:id},'admin-patch'); if(!enterRequestGuard(adminGuardKey,900,15000)) return sendRateLimited(res,'声音正在保存，请稍候',900); try { const s=data.sounds.find(s=>s.id===id);if(!s)return send(res,404,{error:'声音不存在'});const x=JSON.parse((await body(req)).toString());if(typeof x.name==='string')s.name=x.name.slice(0,60);if(typeof x.enabled==='boolean')s.enabled=x.enabled;if(Array.isArray(x.tags))s.tags=x.tags.map(String).slice(0,12);writeStore(data);return send(res,200,publicSound(s)); } finally { leaveRequestGuard(adminGuardKey,900,15000); } }
  if(req.method==='DELETE'&&p.startsWith('/api/admin/sounds/')) {
    const id=p.split('/').pop();
    const adminGuardKey=requestKey(req,url,{soundId:id},'admin-delete');
    if(!enterRequestGuard(adminGuardKey,2500,30000)) return sendRateLimited(res,'声音正在删除，请稍候',1600);
    try {
      const s=data.sounds.find(s=>s.id===id);
      if(!s)return send(res,404,{error:'声音不存在'});
      if(s.file) await deleteUploadFile(s.file);
      data.sounds=data.sounds.filter(s=>s.id!==id);
      writeStore(data,{replace:true});
      return send(res,200,{ok:true});
    } finally {
      leaveRequestGuard(adminGuardKey,2500,30000);
    }
  }
  if(p==='/'||p==='/index.html')return serveFile(req,res,'public/index.html'); if(p==='/team.html')return serveFile(req,res,'public/team.html'); if(p==='/admin.html')return serveAdminFile(req,res,'public/admin.html'); if(p==='/admin-users.html')return serveAdminFile(req,res,'public/admin-users.html'); if(p==='/admin-analytics.html')return serveAdminFile(req,res,'public/admin-analytics.html'); if(p==='/admin-tags.html')return serveAdminFile(req,res,'public/admin-tags.html'); if(p.startsWith('/public/'))return serveFile(req,res,p.slice(1));return send(res,404,{error:'未找到页面'});
} catch(e) { console.error(e); send(res,400,{error:e.message||'请求处理失败'}); }}

if(require.main===module) {
  http.createServer(handleRequest).listen(PORT,'0.0.0.0',()=>console.log(`声音侦探已启动：http://localhost:${PORT}${PUBLIC_MODE?'（公网模式）':''}`));
}

module.exports={
  handleRequest,
  withCloudRequest,
  flushCloudStore,
  envValue,
  isNetlifyRuntime
};
