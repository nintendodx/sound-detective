import { createWorkerAsrHealthService } from "./asr-health-worker.mjs";
import "./voice-game-contract.js";

const voiceContract = globalThis.VoiceGameContract;
if (!voiceContract) throw Error("共享语音游戏契约未加载");

export const PRIMARY_ASR_PROVIDER = voiceContract.PRIMARY_ASR_PROVIDER;
export const ASR_PROVIDER_LABELS = Object.freeze({
  [PRIMARY_ASR_PROVIDER]:"腾讯实时语音识别 2.0"
});

export function envValue(env, key, fallback = "") {
  const value = env?.[key];
  return value === undefined || value === null || String(value) === "" ? fallback : value;
}

export function realtimeProviderConfigs(env, options = {}) {
  const cuid = options.cuid || "shared-voice-game";
  const profile = voiceContract.getVoiceProfile(options.gameId || cuid);
  const configured = Boolean(
    (envValue(env, "TENCENT_ASR_APP_ID") || envValue(env, "TENCENT_APP_ID")) &&
    (envValue(env, "TENCENT_ASR_SECRET_ID") || envValue(env, "TENCENT_SECRET_ID")) &&
    (envValue(env, "TENCENT_ASR_SECRET_KEY") || envValue(env, "TENCENT_SECRET_KEY"))
  );
  const enabledByOperator = !/^(0|false|no|off)$/i.test(String(envValue(env, "TENCENT_ASR_ENABLED", "true")).trim());
  const noiseValue = String(envValue(env, "TENCENT_ASR_NOISE_THRESHOLD")).trim();
  return {
    [PRIMARY_ASR_PROVIDER]:{
      configured,
      enabled:configured && enabledByOperator,
      transport:"browser-direct",
      disabledReason:configured ? "腾讯实时识别已由配置停用" : "缺少腾讯实时识别密钥",
      appId:envValue(env, "TENCENT_ASR_APP_ID") || envValue(env, "TENCENT_APP_ID"),
      secretId:envValue(env, "TENCENT_ASR_SECRET_ID") || envValue(env, "TENCENT_SECRET_ID"),
      secretKey:envValue(env, "TENCENT_ASR_SECRET_KEY") || envValue(env, "TENCENT_SECRET_KEY"),
      endpoint:envValue(env, "TENCENT_ASR_ENDPOINT", "wss://asr.cloud.tencent.com/asr/v2"),
      engineModelType:envValue(env, "TENCENT_ASR_ENGINE_MODEL_TYPE", options.engineModelType || "16k_zh_en"),
      vadSilenceTime:Number(envValue(env, "TENCENT_ASR_VAD_SILENCE_TIME", String(options.vadSilenceTime || profile.tencentVadSilenceTime))),
      noiseThreshold:noiseValue === "" ? null : Number(noiseValue),
      hotwordId:envValue(env, "TENCENT_ASR_HOTWORD_ID"),
      hotwordLimit:Math.min(128, Math.max(1, Number(envValue(env, "TENCENT_ASR_HOTWORD_LIMIT", String(options.hotwordLimit || profile.hotwordLimit))))),
      hotwordWeight:Math.min(11, Math.max(1, Number(envValue(env, "TENCENT_ASR_HOTWORD_WEIGHT", String(options.hotwordWeight || profile.hotwordWeight))))),
      gameId:profile.gameId,
      sampleRate:16000,
      format:"pcm"
    }
  };
}

export function availableAsrProviders(env, options = {}) {
  const configs = realtimeProviderConfigs(env, options);
  return Object.keys(ASR_PROVIDER_LABELS).filter(provider => configs[provider]?.enabled);
}

export function providerStatus(env, hotwords = [], options = {}) {
  const labels = options.labels || ASR_PROVIDER_LABELS;
  const configs = realtimeProviderConfigs(env, options);
  const profile = voiceContract.getVoiceProfile(options.gameId || options.cuid);
  const providers = Object.keys(labels).map(provider => ({
    provider,
    label:labels[provider],
    enabled:Boolean(configs[provider]?.enabled),
    configured:Boolean(configs[provider]?.configured),
    sampleRate:16000,
    frameBytes:6400,
    serverVad:true,
    transport:"browser-direct",
    sessionUrl:"/api/asr/tencent-session",
    reason:configs[provider]?.enabled ? "" : configs[provider]?.disabledReason || "Cloudflare 生产环境缺少腾讯实时 ASR 密钥"
  }));
  const enabled = providers.filter(provider => provider.enabled);
  return {
    realtime:{
      enabled:Boolean(enabled.length),
      providers,
      sampleRate:16000,
      frameBytes:6400,
      primaryProvider:PRIMARY_ASR_PROVIDER,
      unavailableReason:enabled.length ? "" : "Cloudflare 生产环境缺少腾讯实时 ASR 密钥"
    },
    profile,
    hotwords,
    hotwordCount:hotwords.length,
    status:enabled.length ? "ready" : "missing",
    missing:providers.filter(provider => !provider.enabled).map(provider => provider.provider)
  };
}

function base64FromBytes(bytes) {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}

async function hmacSha1Base64(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name:"HMAC", hash:"SHA-1" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return base64FromBytes(new Uint8Array(signature));
}

export async function tencentRealtimeUrl(config, hotwords = [], makeId = () => crypto.randomUUID()) {
  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    secretid:config.secretId,
    engine_model_type:config.engineModelType,
    timestamp,
    expired:timestamp + 120,
    nonce:Math.floor(100000 + Math.random() * 900000),
    voice_id:makeId(),
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
  const query = Object.keys(params).sort().map(key => `${key}=${String(params[key])}`).join("&");
  const endpoint = new URL(config.endpoint);
  const signTarget = `${endpoint.host}/asr/v2/${config.appId}?${query}`;
  const signature = await hmacSha1Base64(config.secretKey, signTarget);
  return `${endpoint.protocol}//${endpoint.host}/asr/v2/${config.appId}?${query}&signature=${encodeURIComponent(signature)}`;
}

export function createSharedAsrHealthService(options = {}) {
  const labels = options.labels || ASR_PROVIDER_LABELS;
  const configOptions = { ...options, cuid:options.cuid || "shared-voice-game", labels };
  const makeId = options.makeId || (() => crypto.randomUUID());
  return createWorkerAsrHealthService({
    labels,
    configs:env => realtimeProviderConfigs(env, configOptions),
    signerProbe:(provider, config, env, hotwords) => {
      if (provider !== PRIMARY_ASR_PROVIDER) throw Error("当前只启用腾讯实时语音识别");
      return tencentRealtimeUrl(config, hotwords, makeId);
    }
  });
}
