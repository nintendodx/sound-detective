'use strict';

const voiceContract = globalThis.VoiceGameContract || require('./voice-game-contract.js');

const DEFAULT_LABELS = Object.freeze({
  [voiceContract.PRIMARY_ASR_PROVIDER]:'腾讯实时语音识别 2.0'
});

function createNodeAsrToolkit(options = {}) {
  const crypto = options.crypto || require('node:crypto');
  const WebSocket = options.WebSocket;
  const labels = Object.freeze({ ...DEFAULT_LABELS, ...(options.labels || {}) });
  const env = options.env || process.env;
  const envValue = options.envValue || ((key, fallback = '') => env[key] || fallback);
  const defaultCuid = options.defaultCuid || 'shared-voice-game';
  const profile = voiceContract.getVoiceProfile(options.gameId || defaultCuid);

  function tencentRealtimeConfig() {
    const noiseValue = String(envValue('TENCENT_ASR_NOISE_THRESHOLD')).trim();
    const configured = Boolean(
      (envValue('TENCENT_ASR_APP_ID') || envValue('TENCENT_APP_ID')) &&
      (envValue('TENCENT_ASR_SECRET_ID') || envValue('TENCENT_SECRET_ID')) &&
      (envValue('TENCENT_ASR_SECRET_KEY') || envValue('TENCENT_SECRET_KEY'))
    );
    const enabledByOperator = !/^(0|false|no|off)$/i.test(String(envValue('TENCENT_ASR_ENABLED', 'true')).trim());
    return {
      configured,
      enabled:configured && enabledByOperator,
      transport:'browser-direct',
      disabledReason:configured ? '腾讯实时识别已由配置停用' : '缺少腾讯实时识别密钥',
      appId:envValue('TENCENT_ASR_APP_ID') || envValue('TENCENT_APP_ID'),
      secretId:envValue('TENCENT_ASR_SECRET_ID') || envValue('TENCENT_SECRET_ID'),
      secretKey:envValue('TENCENT_ASR_SECRET_KEY') || envValue('TENCENT_SECRET_KEY'),
      endpoint:envValue('TENCENT_ASR_ENDPOINT', 'wss://asr.cloud.tencent.com/asr/v2'),
      engineModelType:envValue('TENCENT_ASR_ENGINE_MODEL_TYPE', options.engineModelType || '16k_zh_en'),
      vadSilenceTime:Number(envValue('TENCENT_ASR_VAD_SILENCE_TIME', String(options.vadSilenceTime || profile.tencentVadSilenceTime))),
      noiseThreshold:noiseValue === '' ? null : Number(noiseValue),
      hotwordId:envValue('TENCENT_ASR_HOTWORD_ID'),
      hotwordLimit:Math.min(128, Math.max(1, Number(envValue('TENCENT_ASR_HOTWORD_LIMIT', String(options.hotwordLimit || profile.hotwordLimit))))),
      hotwordWeight:Math.min(11, Math.max(1, Number(envValue('TENCENT_ASR_HOTWORD_WEIGHT', String(options.hotwordWeight || profile.hotwordWeight))))),
      gameId:profile.gameId,
      sampleRate:16000,
      format:'pcm'
    };
  }

  function realtimeProviderConfigs() {
    return { [voiceContract.PRIMARY_ASR_PROVIDER]:tencentRealtimeConfig() };
  }

  function availableAsrProviders() {
    const configs = realtimeProviderConfigs();
    return Object.keys(labels).filter(provider => configs[provider]?.enabled);
  }

  function configPayload(hotwords = []) {
    const configs = realtimeProviderConfigs();
    const providers = Object.keys(labels).map(provider => ({
      provider,
      label:labels[provider],
      enabled:Boolean(configs[provider]?.enabled),
      configured:Boolean(configs[provider]?.configured),
      sampleRate:16000,
      frameBytes:6400,
      serverVad:true,
      reason:configs[provider]?.enabled ? '' : configs[provider]?.disabledReason || '',
      transport:'browser-direct',
      sessionUrl:'/api/asr/tencent-session'
    }));
    const enabled = providers.filter(item => item.enabled);
    return {
      realtime:{ enabled:Boolean(enabled.length), providers, sampleRate:16000, frameBytes:6400, primaryProvider:voiceContract.PRIMARY_ASR_PROVIDER },
      profile,
      hotwords,
      hotwordCount:hotwords.length,
      status:enabled.length ? 'ready' : 'missing',
      missing:providers.filter(item => !item.enabled).map(item => item.provider)
    };
  }

  function tencentRealtimeUrl(config, hotwords = []) {
    const timestamp = Math.floor(Date.now() / 1000);
    const params = {
      secretid:config.secretId,
      engine_model_type:config.engineModelType,
      timestamp,
      expired:timestamp + 120,
      nonce:crypto.randomInt(100000, 999999),
      voice_id:crypto.randomUUID(),
      voice_format:1,
      needvad:1,
      vad_silence_time:config.vadSilenceTime
    };
    const hotwordList = voiceContract.formatTencentHotwordList(hotwords, {
      gameId:config.gameId,
      limit:config.hotwordLimit,
      defaultWeight:config.hotwordWeight
    });
    if (hotwordList) params.hotword_list = hotwordList;
    if (Number.isFinite(config.noiseThreshold)) params.noise_threshold = config.noiseThreshold;
    if (config.hotwordId) {
      params.hotword_id = config.hotwordId;
      delete params.hotword_list;
    }
    const query = Object.keys(params).sort().map(key => `${key}=${String(params[key])}`).join('&');
    const endpoint = new URL(config.endpoint);
    const signTarget = `${endpoint.host}/asr/v2/${config.appId}?${query}`;
    const signature = crypto.createHmac('sha1', config.secretKey).update(signTarget).digest('base64');
    return `${endpoint.protocol}//${endpoint.host}/asr/v2/${config.appId}?${query}&signature=${encodeURIComponent(signature)}`;
  }

  let healthCache = null;
  let healthCacheExpiresAt = 0;
  let healthPromise = null;

  function providerHealth(provider, config, hotwords, timeoutMs) {
    const startedAt = Date.now();
    const base = {
      provider,
      label:labels[provider] || provider,
      configured:Boolean(config?.configured),
      available:false,
      checkedAt:new Date().toISOString(),
      latencyMs:0,
      transport:'browser-direct',
      healthScope:'upstream',
      reason:''
    };
    if (!config?.enabled) return Promise.resolve({ ...base, reason:config?.disabledReason || '服务未配置' });
    if (!WebSocket) return Promise.resolve({ ...base, reason:'本地环境缺少 WebSocket 客户端', errorCode:'WEBSOCKET_UNAVAILABLE' });
    return new Promise(resolve => {
      let socket;
      let settled = false;
      let endTimer;
      const complete = (available, reason = '', errorCode = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(endTimer);
        try { if (socket && socket.readyState < 2) socket.close(1000, 'health check complete'); } catch {}
        resolve({
          ...base,
          available,
          latencyMs:Date.now() - startedAt,
          reason:available ? '' : String(reason || '上游服务不可用').replace(/\s+/g, ' ').trim().slice(0, 180),
          ...(errorCode === '' ? {} : { errorCode:String(errorCode).slice(0, 80) })
        });
      };
      const timeout = setTimeout(() => complete(false, `上游在 ${timeoutMs}ms 内没有返回有效响应`, 'TIMEOUT'), timeoutMs);
      try {
        socket = new WebSocket(tencentRealtimeUrl(config, hotwords));
        const on = typeof socket.on === 'function' ? (name, handler) => socket.on(name, handler) : (name, handler) => socket.addEventListener(name, handler);
        on('open', () => {
          socket.send(Buffer.alloc(3200));
          endTimer = setTimeout(() => socket.readyState === 1 && socket.send(JSON.stringify({ type:'end' })), 250);
        });
        on('message', raw => {
          const data = raw?.data ?? raw;
          let result;
          try { result = JSON.parse(Buffer.from(data).toString('utf8')); }
          catch { return complete(false, '腾讯返回了无法解析的响应', 'INVALID_RESPONSE'); }
          const code = Number(result.code || 0);
          if (code) complete(false, result.message || `腾讯识别错误 ${code}`, code);
          else complete(true);
        });
        on('error', error => complete(false, error?.message || '上游 WebSocket 连接失败', 'CONNECTION_ERROR'));
        on('close', () => { if (!settled) complete(false, '上游在确认可用前关闭连接', 'EARLY_CLOSE'); });
      } catch (error) {
        complete(false, error?.message || '上游连接失败', 'CONNECTION_ERROR');
      }
    });
  }

  async function providerHealthPayload(hotwords = [], healthOptions = {}) {
    const cacheMs = Number(healthOptions.cacheMs || 90000);
    const now = Date.now();
    if (!healthOptions.force && healthCache && now < healthCacheExpiresAt) return { ...healthCache, cached:true };
    if (healthPromise) return healthPromise;
    healthPromise = (async () => {
      const configs = realtimeProviderConfigs();
      const providers = await Promise.all(Object.keys(labels).map(provider => providerHealth(provider, configs[provider], hotwords, Number(healthOptions.timeoutMs || 8000))));
      const availableProviders = providers.filter(item => item.available).map(item => item.provider);
      healthCache = {
        status:availableProviders.length === providers.length ? 'ready' : availableProviders.length ? 'degraded' : 'unavailable',
        checkedAt:new Date().toISOString(),
        cacheTtlMs:cacheMs,
        cached:false,
        availableProviders,
        providers
      };
      healthCacheExpiresAt = Date.now() + cacheMs;
      return healthCache;
    })().finally(() => { healthPromise = null; });
    return healthPromise;
  }

  return {
    labels,
    tencentRealtimeConfig,
    realtimeProviderConfigs,
    availableAsrProviders,
    configPayload,
    tencentRealtimeUrl,
    providerHealthPayload
  };
}

module.exports = { ASR_PROVIDER_LABELS:DEFAULT_LABELS, createNodeAsrToolkit };
