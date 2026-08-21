const DEFAULT_CACHE_MS = 90_000;
const DEFAULT_TIMEOUT_MS = 8_000;

function baiduHealthFrame(frameIndex) {
  const frame = new Uint8Array(5120);
  const view = new DataView(frame.buffer);
  const sampleOffset = frameIndex * 2560;
  for (let index = 0; index < 2560; index += 1) {
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * (sampleOffset + index) / 16000) * 600);
    view.setInt16(index * 2, sample, true);
  }
  return frame;
}

function closeSocket(socket) {
  try {
    if (socket && socket.readyState < 2) socket.close(1000, "health check complete");
  } catch {}
}

function cleanMessage(value, fallback) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, 180);
}

export function normalizeRequestedProviders(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

export function healthyProviderIds(health, requested = null) {
  const healthy = (health?.providers || []).filter((item) => item.available).map((item) => item.provider);
  if (requested === null || requested === undefined) return healthy;
  const allowed = new Set(normalizeRequestedProviders(requested));
  return healthy.filter((provider) => allowed.has(provider));
}

export function createWorkerAsrHealthService(options) {
  let cached = null;
  let expiresAt = 0;
  let pending = null;
  const labels = options.labels || {};
  const providerIds = Object.keys(labels);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const cacheMs = Number(options.cacheMs || DEFAULT_CACHE_MS);

  async function probe(provider, config, env, hotwords) {
    const startedAt = Date.now();
    const base = {
      provider,
      label: labels[provider] || provider,
      configured: Boolean(config?.configured || config?.enabled),
      available: false,
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
      reason: ""
    };
    if (!config?.enabled) {
      return { ...base, reason: config?.disabledReason || (base.configured ? "服务已停用" : "服务未配置") };
    }

    return new Promise((resolve) => {
      let socket = null;
      let settled = false;
      let finishTimer = 0;
      const complete = (available, reason = "", errorCode = "") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(finishTimer);
        clearInterval(finishTimer);
        closeSocket(socket);
        resolve({
          ...base,
          available,
          latencyMs: Date.now() - startedAt,
          reason: available ? "" : cleanMessage(reason, "上游服务不可用"),
          ...(errorCode === "" || errorCode === null || errorCode === undefined ? {} : { errorCode:String(errorCode).slice(0, 80) })
        });
      };
      const timer = setTimeout(() => complete(false, `上游在 ${timeoutMs}ms 内没有返回有效响应`, "TIMEOUT"), timeoutMs);

      const bindCommon = () => {
        socket.addEventListener("error", () => complete(false, "上游 WebSocket 连接失败", "CONNECTION_ERROR"));
        socket.addEventListener("close", () => {
          if (!settled) complete(false, "上游在确认可用前关闭连接", "EARLY_CLOSE");
        });
      };

      Promise.resolve(options.connect(provider, config, env, hotwords)).then((connected) => {
        socket = connected;
        bindCommon();
        if (provider === "doubao-streaming-v2") {
          socket.addEventListener("message", (event) => {
            Promise.resolve(options.parseDoubao(event.data)).then((result) => {
              if (Number(result?.code || 0)) complete(false, result?.body?.message || `豆包识别错误 ${result.code}`, result.code);
              else complete(true);
            }).catch((error) => complete(false, `豆包响应解析失败：${error?.message || error}`, "INVALID_RESPONSE"));
          });
          socket.send(options.doubaoStart(config, hotwords));
          finishTimer = setTimeout(() => {
            if (socket?.readyState === 1) socket.send(options.doubaoFinish());
          }, 250);
          return;
        }

        socket.addEventListener("message", (event) => {
          let result;
          try { result = JSON.parse(options.textFromData(event.data)); }
          catch { return complete(false, "上游返回了无法解析的响应", "INVALID_RESPONSE"); }
          if (provider === "baidu-realtime") {
            const errorCode = Number(result.err_no || 0);
            if (errorCode === -3005) return complete(true);
            if (errorCode) return complete(false, result.err_msg || `百度识别错误 ${result.err_no}`, result.err_no);
            if (["HEARTBEAT", "START", "MID_TEXT", "FIN_TEXT"].includes(String(result.type || ""))) return complete(true);
            if (/ERROR|FAIL/i.test(String(result.type || ""))) return complete(false, result.err_msg || result.desc || "百度拒绝了识别请求", result.err_no || result.error_code || result.type);
            return;
          }
          if (Number(result.code || 0)) {
            if (options.acceptError?.(provider, Number(result.code), result)) complete(true);
            else complete(false, result.message || `腾讯识别错误 ${result.code}`, result.code);
          }
          else complete(true);
        });
        socket.addEventListener("open", () => {
          if (provider === "baidu-realtime") {
            socket.send(options.baiduStart(config));
            let frameIndex = 0;
            const sendFrame = () => {
              if (socket?.readyState !== 1) return;
              if (frameIndex < 10) {
                socket.send(baiduHealthFrame(frameIndex));
                frameIndex += 1;
                return;
              }
              clearInterval(finishTimer);
              finishTimer = 0;
              socket.send(JSON.stringify({ type:"FINISH" }));
            };
            sendFrame();
            finishTimer = setInterval(sendFrame, 160);
            return;
          }
          socket.send(new Uint8Array(3200));
          finishTimer = setTimeout(() => {
            if (socket?.readyState !== 1) return;
            socket.send(JSON.stringify({ type:"end" }));
          }, 250);
        });
      }).catch((error) => complete(false, error?.message || "上游连接失败", "CONNECTION_ERROR"));
    });
  }

  async function check(env, hotwords = [], force = false) {
    const now = Date.now();
    if (!force && cached && now < expiresAt) return { ...cached, cached:true };
    if (pending) return pending;
    pending = (async () => {
      const configs = options.configs(env);
      const providers = await Promise.all(providerIds.map((provider) => probe(provider, configs[provider], env, hotwords)));
      const available = providers.filter((item) => item.available).map((item) => item.provider);
      cached = {
        status: available.length === providerIds.length ? "ready" : available.length ? "degraded" : "unavailable",
        checkedAt: new Date().toISOString(),
        cacheTtlMs: cacheMs,
        cached:false,
        availableProviders: available,
        providers
      };
      expiresAt = Date.now() + cacheMs;
      return cached;
    })().finally(() => { pending = null; });
    return pending;
  }

  return { check };
}
