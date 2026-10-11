const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const appSource=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
const teamSource=fs.readFileSync(path.join(__dirname,'../public/team.js'),'utf8');
const lightGameSource=fs.readFileSync(path.join(__dirname,'../cloudflare/light-game.mjs'),'utf8');
const workerSource=fs.readFileSync(path.join(__dirname,'../cloudflare/worker.mjs'),'utf8');
const wranglerSource=fs.readFileSync(path.join(__dirname,'../wrangler.jsonc'),'utf8');
const releaseConfig=JSON.parse(fs.readFileSync(path.join(__dirname,'../cloudflare.release.json'),'utf8'));
const secretSyncSource=fs.readFileSync(path.join(__dirname,'sync-cloudflare-secrets.mjs'),'utf8');
const dataSyncSource=fs.readFileSync(path.join(__dirname,'sync-cloudflare-data.mjs'),'utf8');
const releaseSource=fs.readFileSync(path.join(__dirname,'release-cloudflare-pages.cjs'),'utf8');
const voiceContract=require('../shared/voice-game-contract.js');
assert.match(appSource,/const APP_BASE_URL\s*=/);
const appUrlBlockStart=appSource.indexOf('const APP_BASE_URL =');
const appUrlBlockEnd=appSource.indexOf('\nconst TEST_MODE',appUrlBlockStart);
assert.ok(appUrlBlockStart>=0&&appUrlBlockEnd>appUrlBlockStart,'appUrl setup block is present');
const appUrlSandbox={
  URL,
  document:{currentScript:{src:'https://stardream.studio/games/sound/public/app.js?v=test'}},
  window:{location:{href:'https://stardream.studio/games/sound/'}}
};
vm.runInNewContext(`${appSource.slice(appUrlBlockStart,appUrlBlockEnd)};globalThis.__appUrl=appUrl;`,appUrlSandbox);
assert.equal(appUrlSandbox.__appUrl('/games/sound/api/asr/tencent-session'),'https://stardream.studio/games/sound/api/asr/tencent-session');
assert.equal(appUrlSandbox.__appUrl('api/asr/config'),'https://stardream.studio/games/sound/api/asr/config');
assert.doesNotMatch(appSource,/websocketUrl|appWebSocketUrl/);
assert.doesNotMatch(appSource,/submitAudioFallback/);
assert.doesNotMatch(appSource,/startAudioOnlyRecording|audioOnlyMode|api\/game\/audio-check/);
assert.match(appSource,/resolveUrl:\s*appUrl/);
assert.match(appSource,/ensureSharedVoiceAsr\(\)\.loadAsrConfig\(\)/);
assert.doesNotMatch(appSource,/(['"`])\/(?:api|uploads|images|public)\//);
assert.doesNotMatch(teamSource,/(['"`])\/api\//);
assert.doesNotMatch(appSource,/currentAudio\.play\(\)\s*\.then\(/);
assert.match(appSource,/Promise\.resolve\(\)\.then\(\(\) => currentAudio\.play\(\)\)/);
assert.match(workerSource,/\/\\\.\(\?:html\|js\|css\)\$\/i\.test\(pathname\)[\s\S]*?noStoreHeaders\(\)/);
assert.equal(releaseConfig.productionUrl,'https://stardream.studio/games/sound/');
assert.equal(releaseConfig.verifyUrl,'https://stardream.studio/games/sound/api/health');
const expectedVersion=JSON.parse(fs.readFileSync(path.join(__dirname,'../package.json'),'utf8')).version;
assert.equal(appSource.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1],expectedVersion);
assert.equal(source.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1],expectedVersion);
assert.match(lightGameSource,new RegExp(`version:["']${expectedVersion.replace(/\./g,'\\.')}["']`));
assert.deepEqual(releaseConfig.secrets,["TENCENT_ASR_APP_ID","TENCENT_ASR_SECRET_ID","TENCENT_ASR_SECRET_KEY"]);
assert.equal(releaseConfig.syncData,undefined);
assert.match(secretSyncSource,/RELEASE_CONFIG\.secrets/);
assert.doesNotMatch(secretSyncSource,/BAIDU_|DOUBAO_|\.\.\", \"text color/);
assert.match(dataSyncSource,/RELEASE_CONFIG\.envFile/);
assert.match(dataSyncSource,/--confirm-production-data-overwrite/);
assert.doesNotMatch(dataSyncSource,/\.\.\", \"text color/);
assert.match(releaseSource,/options\.data && !config\.syncData/);
assert.doesNotMatch(wranglerSource,/BAIDU_|DOUBAO_|STT_PROVIDER/);
assert.match(wranglerSource,/"TENCENT_ASR_ENGINE_MODEL_TYPE": "16k_zh_en"/);
assert.match(source,/providerHealthPayload\(soundAsrHotwords/);
assert.match(lightGameSource,/音频代理已停用/);
assert.doesNotMatch(lightGameSource,/runAsrProxySocket|DOUBAO_|BAIDU_/);
assert.doesNotMatch(lightGameSource,/providers\[Math\.floor\(Math\.random|cloudflare-worker-signer/);
assert.match(lightGameSource,/selectAsrProvider\(providers\)/);
assert.match(lightGameSource,/serviceRuntime:"cloudflare-pages-signer"/);
assert.doesNotMatch(source,/providers\[Math\.floor\(Math\.random/);
assert.match(source,/selectAsrProvider\(providers\)/);
assert.match(source,/asrSessionTicketPromise\s*=\s*import\(['"]\.\/shared\/asr-session-ticket\.mjs['"]\)/);
assert.match(source,/createAsrSessionTicket\(process\.env/);
assert.match(source,/verifyAsrSessionTicket\(process\.env,input\.asrTicket/);
assert.match(source,/asrProviderLabel:session\.asrProviderLabel,asrTicket/);
assert.doesNotMatch(source,/STT_PROVIDER|OPENAI_|GROQ_|BAIDU_|transcribeAudio|queueAudioAnswerTranscription|resolveSessionAudioAnswers/);
for(const file of ['asr-node.cjs','asr-cloudflare-core.mjs','asr-health-worker.mjs']) {
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../shared',file),'utf8'),/BAIDU_|DOUBAO_|\/ws\/asr/);
}
assert.equal(voiceContract.describeContract().contractVersion,'1.0');
assert.equal(voiceContract.judgeAnswer({gameId:'sound',transcript:'叮咚',question:{name:'门铃',aliases:['叮咚']}}).correct,true);
console.log('Tencent-only speech configuration passed.');
