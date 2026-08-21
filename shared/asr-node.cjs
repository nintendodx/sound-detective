'use strict';

const DEFAULT_LABELS = Object.freeze({
  'tencent-realtime-v2': '腾讯实时语音识别 2.0',
  'doubao-streaming-v2': '豆包双向流式 2.0',
  'baidu-realtime': '百度实时语音识别'
});

function createNodeAsrToolkit(options = {}) {
  const crypto = options.crypto || require('node:crypto');
  const zlib = options.zlib || require('node:zlib');
  const WebSocket = options.WebSocket;
  const WebSocketServer = options.WebSocketServer;
  const labels = Object.freeze({ ...DEFAULT_LABELS, ...(options.labels || {}) });
  const env = options.env || process.env;
  const envValue = options.envValue || ((key, fallback = '') => env[key] || fallback);
  const defaultCuid = options.defaultCuid || 'shared-voice-game';

  function baiduRealtimeConfig() {
    const configured = Boolean(envValue('BAIDU_APP_ID') && envValue('BAIDU_API_KEY'));
    const enabledByOperator = !/^(0|false|no|off)$/i.test(String(envValue('BAIDU_REALTIME_ASR_ENABLED', envValue('BAIDU_REALTIME_ENABLED', 'true'))).trim());
    return {
      configured,
      enabled: configured && enabledByOperator,
      disabledReason: configured ? '百度实时识别已由配置停用' : '缺少百度实时识别密钥',
      appId: envValue('BAIDU_APP_ID'),
      appKey: envValue('BAIDU_API_KEY'),
      endpoint: envValue('BAIDU_REALTIME_ASR_ENDPOINT', 'wss://vop.baidu.com/realtime_asr'),
      devPid: Number(envValue('BAIDU_REALTIME_ASR_DEV_PID', '15372')),
      lmId: Number(envValue('BAIDU_REALTIME_ASR_LM_ID', '0')),
      cuid: envValue('BAIDU_ASR_CUID', defaultCuid),
      sampleRate: 16000,
      format: 'pcm'
    };
  }

  function tencentRealtimeConfig() {
    const noiseValue = String(envValue('TENCENT_ASR_NOISE_THRESHOLD')).trim();
    const credentials = Boolean(
      (envValue('TENCENT_ASR_APP_ID') || envValue('TENCENT_APP_ID')) &&
      (envValue('TENCENT_ASR_SECRET_ID') || envValue('TENCENT_SECRET_ID')) &&
      (envValue('TENCENT_ASR_SECRET_KEY') || envValue('TENCENT_SECRET_KEY'))
    );
    const tencentEnabled = !/^(0|false|no|off)$/i.test(String(envValue('TENCENT_ASR_ENABLED', 'true')).trim());
    return {
      configured: credentials,
      enabled: credentials && tencentEnabled,
      disabledReason: credentials ? '腾讯实时识别已由配置停用' : '缺少腾讯实时识别密钥',
      appId: envValue('TENCENT_ASR_APP_ID') || envValue('TENCENT_APP_ID'),
      secretId: envValue('TENCENT_ASR_SECRET_ID') || envValue('TENCENT_SECRET_ID'),
      secretKey: envValue('TENCENT_ASR_SECRET_KEY') || envValue('TENCENT_SECRET_KEY'),
      endpoint: envValue('TENCENT_ASR_ENDPOINT', 'wss://asr.cloud.tencent.com/asr/v2'),
      engineModelType: envValue('TENCENT_ASR_ENGINE_MODEL_TYPE', '16k_zh_en_speaker'),
      vadSilenceTime: Number(envValue('TENCENT_ASR_VAD_SILENCE_TIME', '800')),
      noiseThreshold: noiseValue === '' ? null : Number(noiseValue),
      hotwordId: envValue('TENCENT_ASR_HOTWORD_ID'),
      hotwordLimit: Math.min(128, Math.max(20, Number(envValue('TENCENT_ASR_HOTWORD_LIMIT', envValue('ASR_REALTIME_HOTWORD_LIMIT', '128'))))),
      sampleRate: 16000,
      format: 'pcm'
    };
  }

  function doubaoRealtimeConfig() {
    return {
      enabled: Boolean(envValue('DOUBAO_ASR_API_KEY') || envValue('VOLCENGINE_ASR_API_KEY')),
      apiKey: envValue('DOUBAO_ASR_API_KEY') || envValue('VOLCENGINE_ASR_API_KEY'),
      endpoint: envValue('DOUBAO_ASR_ENDPOINT', 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'),
      resourceId: envValue('DOUBAO_ASR_RESOURCE_ID', 'volc.bigasr.sauc.duration'),
      endWindowSize: Number(envValue('DOUBAO_ASR_END_WINDOW_SIZE', '800')),
      forceToSpeechTime: Number(envValue('DOUBAO_ASR_FORCE_TO_SPEECH_TIME', '1000')),
      sampleRate: 16000,
      format: 'pcm'
    };
  }

  function realtimeProviderConfigs() {
    return {
      'tencent-realtime-v2': tencentRealtimeConfig(),
      'doubao-streaming-v2': doubaoRealtimeConfig(),
      'baidu-realtime': baiduRealtimeConfig()
    };
  }

  function availableAsrProviders() {
    const configs = realtimeProviderConfigs();
    return Object.keys(labels).filter(provider => configs[provider]?.enabled);
  }

  function configPayload(hotwords = []) {
    const configs = realtimeProviderConfigs();
    const providers = Object.keys(labels).map(provider => ({
      provider,
      label: labels[provider],
      enabled: Boolean(configs[provider]?.enabled),
      configured: Boolean(configs[provider]?.configured || configs[provider]?.enabled),
      sampleRate: 16000,
      frameBytes: 5120,
      serverVad: provider !== 'baidu-realtime',
      reason: configs[provider]?.enabled ? '' : configs[provider]?.disabledReason || '',
      transport: 'node-server-proxy'
    }));
    const enabled = providers.filter(item => item.enabled);
    return {
      realtime: { enabled: Boolean(enabled.length), providers, sampleRate: 16000, frameBytes: 5120 },
      hotwords,
      hotwordCount: hotwords.length,
      status: enabled.length ? 'ready' : 'missing',
      missing: providers.filter(item => !item.enabled).map(item => item.provider)
    };
  }

  function socketSend(socket, payload) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }

  function tencentRealtimeUrl(config, hotwords = []) {
    const timestamp = Math.floor(Date.now() / 1000);
    const params = {
      secretid: config.secretId,
      engine_model_type: config.engineModelType,
      timestamp,
      expired: timestamp + 120,
      nonce: crypto.randomInt(100000, 999999),
      voice_id: crypto.randomUUID(),
      voice_format: 1,
      result_mod: 1,
      speaker_diarization: 0,
      needvad: 1,
      vad_silence_time: config.vadSilenceTime,
      reinforce_hotword: 1
    };
    if (Number.isFinite(config.noiseThreshold)) params.noise_threshold = config.noiseThreshold;
    const limitedHotwords = [...new Set(hotwords.map(word => String(word || '').replace(/[^\p{L}\p{N}\s·.'-]/gu, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, Math.min(128, config.hotwordLimit || hotwords.length));
    if (config.hotwordId) params.hotword_id = config.hotwordId;
    else if (limitedHotwords.length) params.hotword_list = limitedHotwords.map(word => `${word}|11`).join(',');
    const query = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&');
    const endpoint = new URL(config.endpoint);
    const signTarget = `${endpoint.host}/asr/v2/${config.appId}?${query}`;
    const signature = crypto.createHmac('sha1', config.secretKey).update(signTarget).digest('base64');
    return `${endpoint.protocol}//${endpoint.host}/asr/v2/${config.appId}?${query}&signature=${encodeURIComponent(signature)}`;
  }

  function doubaoHeader(messageType, flags, serialization = 1, compression = 1) {
    return Buffer.from([0x11, (messageType << 4) | flags, (serialization << 4) | compression, 0]);
  }

  function doubaoRequest(messageType, sequence, payload, last = false, jsonPayload = false) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(jsonPayload ? JSON.stringify(payload) : payload || '');
    const compressed = zlib.gzipSync(data);
    const header = doubaoHeader(messageType, last ? 3 : 1, 1, 1);
    const packet = Buffer.alloc(header.length + 8 + compressed.length);
    header.copy(packet, 0);
    packet.writeInt32BE(last ? -Math.abs(sequence) : sequence, 4);
    packet.writeUInt32BE(compressed.length, 8);
    compressed.copy(packet, 12);
    return packet;
  }

  function parseDoubaoResponse(input) {
    const message = Buffer.from(input);
    if (message.length < 4) throw Error('豆包响应包不完整');
    const headerBytes = (message[0] & 0x0f) * 4;
    if (headerBytes < 4 || headerBytes > message.length) throw Error('豆包响应包头无效');
    const messageType = message[1] >> 4;
    const flags = message[1] & 0x0f;
    const serialization = message[2] >> 4;
    const compression = message[2] & 0x0f;
    let offset = headerBytes;
    let sequence = 0;
    let last = Boolean(flags & 0x02);
    let code = 0;
    const requireBytes = size => {
      if (offset + size > message.length) throw Error('豆包响应字段不完整');
    };
    if (flags & 0x01) { requireBytes(4); sequence = message.readInt32BE(offset); offset += 4; }
    if (flags & 0x04) { requireBytes(4); offset += 4; }
    if (messageType === 9) { requireBytes(4); offset += 4; }
    else if (messageType === 15) { requireBytes(8); code = message.readInt32BE(offset); offset += 8; }
    let payload = message.subarray(offset);
    if (compression === 1 && payload.length) payload = zlib.gunzipSync(payload);
    let body = null;
    if (serialization === 1 && payload.length) body = JSON.parse(payload.toString('utf8'));
    return { code, sequence, last, body };
  }

  function doubaoStartPayload(config, uid, hotwords = []) {
    return {
      user: { uid: String(uid || defaultCuid).slice(0, 64) },
      audio: { format: 'pcm', codec: 'raw', rate: config.sampleRate, bits: 16, channel: 1 },
      request: {
        model_name: 'bigmodel',
        enable_nonstream: true,
        enable_itn: false,
        enable_punc: false,
        enable_ddc: false,
        show_utterances: true,
        result_type: 'full',
        end_window_size: config.endWindowSize,
        force_to_speech_time: config.forceToSpeechTime,
        corpus: { context: JSON.stringify({ hotwords: [...new Set(hotwords)].slice(0, 200).map(word => ({ word })) }) }
      }
    };
  }

  let healthCache = null;
  let healthCacheExpiresAt = 0;
  let healthPromise = null;

  function closeHealthSocket(socket) {
    try { if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'health check complete'); } catch {}
  }

  function baiduHealthFrame(frameIndex) {
    const frame = Buffer.alloc(5120);
    const sampleOffset = frameIndex * 2560;
    for (let index = 0; index < 2560; index += 1) {
      const sample = Math.round(Math.sin(2 * Math.PI * 440 * (sampleOffset + index) / 16000) * 600);
      frame.writeInt16LE(sample, index * 2);
    }
    return frame;
  }

  function probeProviderHealth(provider, config, hotwords = [], timeoutMs = 8000) {
    const startedAt = Date.now();
    const base = {
      provider,
      label:labels[provider] || provider,
      configured:Boolean(config?.configured || config?.enabled),
      available:false,
      checkedAt:new Date().toISOString(),
      latencyMs:0,
      reason:''
    };
    if (!config?.enabled) return Promise.resolve({ ...base, reason:config?.disabledReason || (base.configured ? '服务已停用' : '服务未配置') });
    return new Promise(resolve => {
      let socket = null;
      let settled = false;
      let sendTimer = null;
      const complete = (available, reason = '', errorCode = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(sendTimer);
        clearInterval(sendTimer);
        closeHealthSocket(socket);
        resolve({
          ...base,
          available,
          latencyMs:Date.now() - startedAt,
          reason:available ? '' : String(reason || '上游服务不可用').replace(/\s+/g, ' ').trim().slice(0, 180),
          ...(errorCode === '' || errorCode === null || errorCode === undefined ? {} : { errorCode:String(errorCode).slice(0, 80) })
        });
      };
      const timer = setTimeout(() => complete(false, `上游在 ${timeoutMs}ms 内没有返回有效响应`, 'TIMEOUT'), timeoutMs);
      try {
        if (provider === 'baidu-realtime') {
          const endpoint = new URL(config.endpoint);
          endpoint.searchParams.set('sn', crypto.randomUUID());
          socket = new WebSocket(endpoint);
          socket.on('open', () => {
            const data = { appid:Number(config.appId), appkey:config.appKey, dev_pid:config.devPid, cuid:config.cuid, format:config.format, sample:config.sampleRate };
            if (config.lmId) data.lm_id = config.lmId;
            socket.send(JSON.stringify({ type:'START', data }));
            let frameIndex = 0;
            const sendFrame = () => {
              if (socket.readyState !== WebSocket.OPEN) return;
              if (frameIndex < 10) {
                socket.send(baiduHealthFrame(frameIndex));
                frameIndex += 1;
                return;
              }
              clearInterval(sendTimer);
              sendTimer = null;
              socket.send(JSON.stringify({ type:'FINISH' }));
            };
            sendFrame();
            sendTimer = setInterval(sendFrame, 160);
          });
          socket.on('message', raw => {
            let result;
            try { result = JSON.parse(raw.toString('utf8')); } catch { return complete(false, '百度返回了无法解析的响应', 'INVALID_RESPONSE'); }
            const errorCode = Number(result.err_no || 0);
            if (errorCode === -3005) return complete(true);
            if (errorCode) return complete(false, result.err_msg || `百度识别错误 ${result.err_no}`, result.err_no);
            if (['HEARTBEAT', 'START', 'MID_TEXT', 'FIN_TEXT'].includes(String(result.type || ''))) return complete(true);
            if (/ERROR|FAIL/i.test(String(result.type || ''))) return complete(false, result.err_msg || result.desc || '百度拒绝了识别请求', result.err_no || result.error_code || result.type);
          });
        } else if (provider === 'tencent-realtime-v2') {
          socket = new WebSocket(tencentRealtimeUrl(config, hotwords));
          socket.on('open', () => {
            socket.send(Buffer.alloc(3200));
            sendTimer = setTimeout(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type:'end' })), 250);
          });
          socket.on('message', raw => {
            let result;
            try { result = JSON.parse(raw.toString('utf8')); } catch { return complete(false, '腾讯返回了无法解析的响应', 'INVALID_RESPONSE'); }
            if (Number(result.code || 0)) complete(false, result.message || `腾讯识别错误 ${result.code}`, result.code);
            else complete(true);
          });
        } else if (provider === 'doubao-streaming-v2') {
          const headers = { 'X-Api-Key':config.apiKey, 'X-Api-Resource-Id':config.resourceId, 'X-Api-Request-Id':crypto.randomUUID(), 'X-Api-Sequence':'-1' };
          socket = new WebSocket(config.endpoint, { headers });
          socket.on('open', () => {
            socket.send(doubaoRequest(1, 1, doubaoStartPayload(config, `${defaultCuid}-health`, hotwords), false, true));
            sendTimer = setTimeout(() => socket.readyState === WebSocket.OPEN && socket.send(doubaoRequest(2, 2, Buffer.alloc(3200), true, false)), 250);
          });
          socket.on('message', raw => {
            let result;
            try { result = parseDoubaoResponse(raw); } catch (error) { return complete(false, `豆包响应解析失败：${error.message}`, 'INVALID_RESPONSE'); }
            if (Number(result.code || 0)) complete(false, result.body?.message || `豆包识别错误 ${result.code}`, result.code);
            else complete(true);
          });
        } else {
          return complete(false, '未知语音识别服务', 'UNKNOWN_PROVIDER');
        }
        socket.on('error', error => complete(false, error?.message || '上游 WebSocket 连接失败', 'CONNECTION_ERROR'));
        socket.on('close', () => { if (!settled) complete(false, '上游在确认可用前关闭连接', 'EARLY_CLOSE'); });
      } catch (error) {
        complete(false, error?.message || '上游连接失败', 'CONNECTION_ERROR');
      }
    });
  }

  async function providerHealthPayload(hotwords = [], options = {}) {
    const cacheMs = Number(options.cacheMs || 90000);
    const now = Date.now();
    if (!options.force && healthCache && now < healthCacheExpiresAt) return { ...healthCache, cached:true };
    if (healthPromise) return healthPromise;
    healthPromise = (async () => {
      const configs = realtimeProviderConfigs();
      const providers = await Promise.all(Object.keys(labels).map(provider => probeProviderHealth(provider, configs[provider], hotwords, options.timeoutMs || 8000)));
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

  function attachWebSocketServer(server, adapter = {}) {
    if (!WebSocket || !WebSocketServer) return null;
    const asrSockets = new WebSocketServer({ noServer: true, maxPayload: 384 * 1024 });
    asrSockets.on('connection', (client, request) => {
      let upstream = null;
      let provider = '';
      let started = false;
      let finishing = false;
      let finishTimer = null;
      let endedSent = false;
      let doubaoSequence = 1;
      let doubaoPending = null;
      let lastPartial = '';
      let lastFinal = '';
      let hotwords = [];
      const connection = adapter.connectionDetails?.(request) || { transport:'node-server-proxy', serviceRuntime:'node-server' };
      let upstreamDetails = {};

      const fail = (message, details = {}) => {
        socketSend(client, { type: 'ASR_ERROR', provider, message, ...connection, ...upstreamDetails, ...details });
        if (upstream?.readyState === WebSocket.OPEN) upstream.close();
        if (client.readyState === WebSocket.OPEN) client.close(1011, 'ASR proxy error');
      };
      const ready = () => {
        if (started) return;
        started = true;
        socketSend(client, { type: 'ASR_READY', provider, providerLabel: labels[provider], sampleRate: 16000, frameBytes: 5120, ...connection, ...upstreamDetails });
      };
      const partial = text => {
        const value = String(text || '').trim();
        if (!value || value === lastPartial || value === lastFinal) return;
        lastPartial = value;
        socketSend(client, { type: 'ASR_PARTIAL', provider, text: value });
      };
      const final = text => {
        const value = String(text || '').trim();
        if (!value || value === lastFinal) return;
        lastFinal = value;
        lastPartial = '';
        socketSend(client, { type: 'ASR_FINAL', provider, text: value });
      };
      const ended = () => {
        if (endedSent) return;
        endedSent = true;
        clearTimeout(finishTimer);
        socketSend(client, { type: 'ASR_ENDED', provider });
        if (client.readyState === WebSocket.OPEN) client.close(1000, 'ASR finished');
      };
      const finishProvider = () => {
        if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
        if (provider === 'baidu-realtime') upstream.send(JSON.stringify({ type: 'FINISH' }));
        else if (provider === 'tencent-realtime-v2') upstream.send(JSON.stringify({ type: 'end' }));
        else if (provider === 'doubao-streaming-v2') {
          doubaoSequence += 1;
          upstream.send(doubaoRequest(2, doubaoSequence, doubaoPending || Buffer.alloc(0), true, false));
          doubaoPending = null;
        }
      };

      client.on('message', async (message, isBinary) => {
        if (isBinary) {
          if (!started || finishing || upstream?.readyState !== WebSocket.OPEN) return;
          if (message.length > 6400) return fail('音频分片过大');
          if (provider === 'doubao-streaming-v2') {
            if (doubaoPending) {
              doubaoSequence += 1;
              upstream.send(doubaoRequest(2, doubaoSequence, doubaoPending, false, false));
            }
            doubaoPending = Buffer.from(message);
          } else {
            upstream.send(message, { binary: true });
          }
          return;
        }

        let payload;
        try {
          payload = JSON.parse(message.toString('utf8'));
        } catch {
          return fail('实时识别控制消息格式错误');
        }
        if (payload.type === 'START') {
          if (started || upstream) return fail('实时识别已经开始');
          let context;
          try {
            context = await adapter.resolveStart(payload);
          } catch (error) {
            return fail(error.message || '题目不存在或已经作答');
          }
          provider = context.provider;
          hotwords = context.hotwords || [];
          const config = realtimeProviderConfigs()[provider];
          if (!provider || !config?.enabled) return fail(`${labels[provider] || '实时语音识别'}未配置`);
          if (provider === 'baidu-realtime') {
            const endpoint = new URL(config.endpoint);
            endpoint.searchParams.set('sn', crypto.randomUUID());
            upstream = new WebSocket(endpoint);
            upstream.on('open', () => {
              upstreamDetails = { upstreamHost:endpoint.host, upstreamAddress:upstream._socket?.remoteAddress || '' };
              const startData = { appid: Number(config.appId), appkey: config.appKey, dev_pid: config.devPid, cuid: config.cuid, format: config.format, sample: config.sampleRate };
              if (config.lmId) startData.lm_id = config.lmId;
              upstream.send(JSON.stringify({ type: 'START', data: startData }));
              ready();
            });
            upstream.on('message', data => {
              let result;
              try { result = JSON.parse(data.toString('utf8')); } catch { return; }
              if (Number(result.err_no || 0) || /ERROR|FAIL/i.test(String(result.type || ''))) {
                return fail(result.err_msg || result.desc || `百度识别错误 ${result.err_no || result.error_code || result.type}`, { errorCode:result.err_no || result.error_code || result.type, requestId:result.sn || '' });
              }
              if (result.type === 'MID_TEXT') partial(result.result);
              if (result.type === 'FIN_TEXT') {
                final(result.result);
              }
            });
          } else if (provider === 'tencent-realtime-v2') {
            upstream = new WebSocket(tencentRealtimeUrl(config, hotwords));
            upstream.on('open', () => {
              upstreamDetails = { upstreamHost:new URL(config.endpoint).host, upstreamAddress:upstream._socket?.remoteAddress || '' };
            });
            upstream.on('message', data => {
              let result;
              try { result = JSON.parse(data.toString('utf8')); } catch { return; }
              if (Number(result.code) !== 0) return fail(result.message || `腾讯识别错误 ${result.code}`, { errorCode:result.code, requestId:result.request_id || result.voice_id || '' });
              ready();
              const list = result.sentences?.sentence_list || [];
              const text = list.map(item => item.sentence || '').join('').trim();
              if (list.some(item => Number(item.sentence_type) === 1)) final(text);
              else partial(text);
              if (Number(result.final) === 1) {
                if (text) final(text);
                ended();
              }
            });
          } else if (provider === 'doubao-streaming-v2') {
            const headers = { 'X-Api-Key': config.apiKey, 'X-Api-Resource-Id': config.resourceId, 'X-Api-Request-Id': crypto.randomUUID(), 'X-Api-Sequence': '-1' };
            upstream = new WebSocket(config.endpoint, { headers });
            upstream.on('open', () => {
              upstreamDetails = { upstreamHost:new URL(config.endpoint).host, upstreamAddress:upstream._socket?.remoteAddress || '' };
              upstream.send(doubaoRequest(1, doubaoSequence, doubaoStartPayload(config, context.uid, hotwords), false, true));
            });
            upstream.on('message', data => {
              let result;
              try { result = parseDoubaoResponse(data); } catch (error) { return fail(`豆包响应解析失败：${error.message}`); }
              if (result.code) return fail(result.body?.message || `豆包识别错误 ${result.code}`, { errorCode:result.code, requestId:result.body?.request_id || '' });
              ready();
              const body = result.body?.result || {};
              const text = String(body.text || '').trim();
              const utterances = Array.isArray(body.utterances) ? body.utterances : [];
              if (result.last || utterances.some(item => item.definite === true)) final(text);
              else partial(text);
              if (result.last) ended();
            });
          }
          upstream.on('error', error => fail(`${labels[provider] || 'ASR'}连接失败：${error.message}`));
          upstream.on('close', () => { if (client.readyState === WebSocket.OPEN) ended(); });
          return;
        }
        if (payload.type === 'FINISH' && started && !finishing) {
          finishing = true;
          finishProvider();
          finishTimer = setTimeout(() => {
            if (upstream?.readyState === WebSocket.OPEN) upstream.close();
          }, provider === 'doubao-streaming-v2' ? 6500 : 4500);
          return;
        }
        if (payload.type === 'CANCEL') {
          if (provider === 'baidu-realtime' && upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: 'CANCEL' }));
          if (upstream?.readyState === WebSocket.OPEN) upstream.close();
          if (client.readyState === WebSocket.OPEN) client.close(1000, 'ASR cancelled');
        }
      });
      client.on('close', () => { clearTimeout(finishTimer); if (upstream?.readyState === WebSocket.OPEN) upstream.close(); });
      client.on('error', () => { clearTimeout(finishTimer); if (upstream?.readyState === WebSocket.OPEN) upstream.close(); });
    });
    server.on('upgrade', (req, socket, head) => {
      let pathname = '';
      try { pathname = new URL(req.url, `http://${req.headers.host}`).pathname; } catch {}
      if (pathname !== (adapter.path || '/ws/asr')) return socket.destroy();
      asrSockets.handleUpgrade(req, socket, head, client => asrSockets.emit('connection', client, req));
    });
    return asrSockets;
  }

  return {
    labels,
    baiduRealtimeConfig,
    tencentRealtimeConfig,
    doubaoRealtimeConfig,
    realtimeProviderConfigs,
    availableAsrProviders,
    configPayload,
    tencentRealtimeUrl,
    doubaoRequest,
    parseDoubaoResponse,
    doubaoStartPayload,
    providerHealthPayload,
    attachWebSocketServer
  };
}

module.exports = { ASR_PROVIDER_LABELS: DEFAULT_LABELS, createNodeAsrToolkit };
