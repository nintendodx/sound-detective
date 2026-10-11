const DEFAULT_CACHE_MS = 90_000;

function cleanMessage(value, fallback) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, 180);
}

export function normalizeRequestedProviders(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(items.map(item => String(item || "").trim()).filter(Boolean))];
}

export function healthyProviderIds(health, requested = null) {
  const healthy = (health?.providers || []).filter(item => item.available).map(item => item.provider);
  if (requested === null || requested === undefined) return healthy;
  const allowed = new Set(normalizeRequestedProviders(requested));
  return healthy.filter(provider => allowed.has(provider));
}

export function createWorkerAsrHealthService(options = {}) {
  let cached = null;
  let expiresAt = 0;
  let pending = null;
  const labels = options.labels || {};
  const providerIds = Object.keys(labels);
  const cacheMs = Number(options.cacheMs || DEFAULT_CACHE_MS);

  async function probe(provider, config, env, hotwords) {
    const startedAt = Date.now();
    const base = {
      provider,
      label:labels[provider] || provider,
      configured:Boolean(config?.configured || config?.enabled),
      available:false,
      checkedAt:new Date().toISOString(),
      latencyMs:0,
      transport:config?.transport || "browser-direct",
      healthScope:"signer",
      reason:""
    };
    if (!config?.enabled) {
      return { ...base, reason:config?.disabledReason || (base.configured ? "服务已停用" : "服务未配置") };
    }
    try {
      await options.signerProbe?.(provider, config, env, hotwords);
      return { ...base, available:true, latencyMs:Date.now() - startedAt };
    } catch (error) {
      return {
        ...base,
        latencyMs:Date.now() - startedAt,
        reason:cleanMessage(error?.message, "直连签名服务不可用"),
        errorCode:"SIGNER_ERROR"
      };
    }
  }

  async function check(env, hotwords = [], force = false) {
    const now = Date.now();
    if (!force && cached && now < expiresAt) return { ...cached, cached:true };
    if (pending) return pending;
    pending = (async () => {
      const configs = options.configs(env);
      const providers = await Promise.all(providerIds.map(provider => probe(provider, configs[provider], env, hotwords)));
      const available = providers.filter(item => item.available).map(item => item.provider);
      cached = {
        status:available.length === providerIds.length ? "ready" : available.length ? "degraded" : "unavailable",
        checkedAt:new Date().toISOString(),
        cacheTtlMs:cacheMs,
        cached:false,
        availableProviders:available,
        providers
      };
      expiresAt = Date.now() + cacheMs;
      return cached;
    })().finally(() => { pending = null; });
    return pending;
  }

  return { check };
}
