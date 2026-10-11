(function (global) {
  const MIC_CALIBRATION_KEY = 'voice-asr-mic-calibration-v1';
  const MIC_CALIBRATION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
  const DEFAULT_SELECTORS = {
    caption: '#speechCaption',
    output: '#recognitionText',
    dock: '#answerDock',
    status: '#listeningStatus',
    detail: '#voiceSupport',
    stopButton: '#stopAnswerButton',
    retryButton: '#retryAnswerButton',
    levelBars: '.listening-indicator i'
  };

  function $(selector) {
    return selector ? document.querySelector(selector) : null;
  }

  function $$(selector) {
    return selector ? [...document.querySelectorAll(selector)] : [];
  }

  function makeId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      try {
        return global.crypto.randomUUID();
      } catch {}
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || 0));
  }

  function micConstraints() {
    const supported = navigator.mediaDevices?.getSupportedConstraints?.() || {};
    const audio = {
      deviceId: { ideal: 'default' },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
      channelCount: { ideal: 1 }
    };
    if (supported.voiceIsolation) audio.voiceIsolation = true;
    return { audio };
  }

  function fallbackMicConstraints() {
    return {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        channelCount: { ideal: 1 }
      }
    };
  }

  function recorderOptions() {
    if (!global.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') return {};
    const types = ['audio/mp4; codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
    const type = types.find(item => MediaRecorder.isTypeSupported(item));
    return type ? { mimeType: type } : {};
  }

  function audioFileExtension(type = '') {
    const clean = type.split(';')[0].trim().toLowerCase();
    return {
      'audio/mp4': '.m4a',
      'audio/x-m4a': '.m4a',
      'audio/aac': '.aac',
      'audio/mpeg': '.mp3',
      'audio/wav': '.wav',
      'audio/x-wav': '.wav',
      'audio/webm': '.webm',
      'audio/ogg': '.ogg'
    }[clean] || '.webm';
  }

  function validateWebSocketUrl(value) {
    let parsed;
    try {
      parsed = new URL(String(value || ''), global.location?.href || undefined);
    } catch {
      throw Error('语音连接地址无效');
    }
    if (!['ws:', 'wss:'].includes(parsed.protocol)) throw Error('语音连接地址协议无效');
    return parsed.toString();
  }

  function normalizeVoiceErrorMessage(message = '', fallback = '语音识别暂时不可用') {
    const text = String(message || '').trim();
    if (/notallowed|permission|权限|麦克风.*(拒绝|未开启|没有开启)/i.test(text)) return '麦克风权限未开启';
    if (/没有识别到|没有听清|没有返回有效文字|没有录到声音|空音频|no speech|empty|silent|silence/i.test(text)) return '没有听到有效答案';
    if (/timeout|timed out|超时/i.test(text)) return '语音连接超时';
    if (/api\s*key|apikey|secret|signature|签名|鉴权|认证|授权|未配置|quota|limit|429|401|403|openai|groq|stt|asr|语音转文字|转写接口|tencent|腾讯|baidu|百度|doubao|豆包|websocket|network|fetch|json|unexpected|跨境|endpoint|当前不可用|服务暂时不可用|连接失败|识别失败/i.test(text)) {
      return fallback;
    }
    return text || fallback;
  }

  function resamplePcm(samples, sourceRate, targetRate = 16000) {
    if (!samples || !sourceRate || sourceRate === targetRate) return samples;
    const ratio = sourceRate / targetRate;
    const output = new Float32Array(Math.max(1, Math.round(samples.length / ratio)));
    for (let index = 0; index < output.length; index += 1) {
      const position = index * ratio;
      const left = Math.floor(position);
      const right = Math.min(samples.length - 1, left + 1);
      const weight = position - left;
      output[index] = samples[left] * (1 - weight) + samples[right] * weight;
    }
    return output;
  }

  class StreamingPcmResampler {
    constructor(sourceRate, targetRate = 16000) {
      this.sourceRate = Math.max(1, Number(sourceRate || targetRate));
      this.targetRate = Math.max(1, Number(targetRate || 16000));
      this.ratio = this.sourceRate / this.targetRate;
      this.pending = new Float32Array(0);
      this.position = 0;
    }

    push(input) {
      const samples = input instanceof Float32Array ? input : new Float32Array(input || 0);
      if (!samples.length) return new Float32Array(0);
      if (this.sourceRate === this.targetRate) return samples.slice();
      const combined = new Float32Array(this.pending.length + samples.length);
      combined.set(this.pending);
      combined.set(samples, this.pending.length);
      const output = [];
      while (this.position + 1 < combined.length) {
        const left = Math.floor(this.position);
        const weight = this.position - left;
        output.push(combined[left] * (1 - weight) + combined[left + 1] * weight);
        this.position += this.ratio;
      }
      const consumed = Math.min(Math.floor(this.position), Math.max(0, combined.length - 1));
      this.pending = combined.slice(consumed);
      this.position -= consumed;
      return Float32Array.from(output);
    }

    reset() {
      this.pending = new Float32Array(0);
      this.position = 0;
    }
  }

  function pcm16Buffer(samples) {
    const buffer = new ArrayBuffer(samples.length * 2);
    const view = new DataView(buffer);
    samples.forEach((value, index) => {
      const clipped = Math.max(-1, Math.min(1, value));
      view.setInt16(index * 2, clipped * (clipped < 0 ? 0x8000 : 0x7fff), true);
    });
    return buffer;
  }

  function writeAscii(view, offset, text) {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  }

  function wavBlobFromPcm(chunks, length, sampleRate) {
    if (!length || !sampleRate) return null;
    const source = new Float32Array(length);
    let offset = 0;
    chunks.forEach(chunk => {
      source.set(chunk, offset);
      offset += chunk.length;
    });
    const samples = resamplePcm(source, sampleRate, 16000);
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);
    samples.forEach((value, index) => {
      const clipped = Math.max(-1, Math.min(1, value));
      view.setInt16(44 + index * 2, clipped * (clipped < 0 ? 0x8000 : 0x7fff), true);
    });
    return new Blob([buffer], { type: 'audio/wav' });
  }

  function renderAnimatedCaption(selectors, text = '', mode = 'waiting', placeholder = '等待你开口') {
    const caption = $(selectors.caption);
    const output = $(selectors.output);
    if (!caption || !output) return;
    const value = String(text || '').trim().slice(0, 120);
    const previous = output.dataset.text || '';
    let stableLength = 0;
    while (stableLength < value.length && stableLength < previous.length && value[stableLength] === previous[stableLength]) stableLength += 1;
    caption.className = `speech-caption ${mode}`;
    output.className = `recognition-text${value ? '' : ' placeholder'}`;
    output.replaceChildren();
    output.dataset.text = value;
    if (!value) {
      output.textContent = placeholder;
      return;
    }
    [...value].forEach((char, index) => {
      const element = document.createElement('span');
      element.textContent = char;
      element.className = index >= stableLength ? 'caption-char incoming' : 'caption-char';
      if (index >= stableLength) element.style.animationDelay = `${Math.min((index - stableLength) * 34, 170)}ms`;
      output.appendChild(element);
    });
  }

  class VoiceAsrClient {
    constructor(options = {}) {
      this.options = {
        selectors: { ...DEFAULT_SELECTORS, ...(options.selectors || {}) },
        asrConfigUrl: '/api/asr/config',
        asrHealthUrl: '/api/asr/health',
        workletUrl: '/pcm-worklet.js',
        resolveUrl: value => value,
        connectTimeoutMs: 3500,
        connectTimeoutByProvider: {
          'tencent-realtime-v2': 4500,
          ...(options.connectTimeoutByProvider || {})
        },
        finishTimeoutMs: 4200,
        maxRealtimeDrainMs: 3200,
        maxQueuedFrames: 80,
        maxRecordMs: 10000,
        maxStoredSeconds: 16,
        realtimeFrameSamples: 3200,
        realtimeSampleRate: 16000,
        startDelayMs: 220,
        finalSubmitDelayMs: 120,
        vadOnsetGuardMs: 320,
        minRecordBeforeVadStopMs: 2800,
        localVadSilenceMs: 1600,
        preSpeechMs: 650,
        vadMinSpeechMs: 210,
        vadOnsetThreshold: 0.014,
        vadNoiseFloorMultiplier: 2.25,
        retryDetail: '没有听清，可以重新回答',
        fallbackAllowed: () => false,
        ...options
      };
      this.ensurePreSpeechWindow();
      this.asrConfig = null;
      this.asrConfigPromise = null;
      this.asrHealth = null;
      this.asrHealthPromise = null;
      this.micCalibration = this.readMicCalibration();
      this.state = this.createState();
      this.state.noiseFloor = this.micCalibration.noiseFloor;
    }

    ensurePreSpeechWindow() {
      const onsetDecisionMs = Math.max(0, Number(this.options.vadOnsetGuardMs) || 0)
        + Math.max(0, Number(this.options.vadMinSpeechMs) || 0)
        + 120;
      this.options.preSpeechMs = Math.max(Number(this.options.preSpeechMs) || 0, onsetDecisionMs);
    }

    readMicCalibration() {
      const defaults = { version:1, noiseFloor:0.006, sensitivityOffset:0, missedOnsetStreak:0, acceptedCount:0, acceptedSpeechRms:0, updatedAt:Date.now() };
      try {
        const raw = global.localStorage?.getItem(MIC_CALIBRATION_KEY);
        if (!raw) return defaults;
        const stored = JSON.parse(raw);
        if (stored.version !== 1 || Date.now() - Number(stored.updatedAt || 0) > MIC_CALIBRATION_MAX_AGE_MS) return defaults;
        return {
          ...defaults,
          noiseFloor:clamp(stored.noiseFloor, 0.003, 0.018),
          sensitivityOffset:clamp(stored.sensitivityOffset, -0.004, 0.006),
          missedOnsetStreak:Math.round(clamp(stored.missedOnsetStreak, 0, 1)),
          acceptedCount:Math.round(clamp(stored.acceptedCount, 0, 10000)),
          acceptedSpeechRms:clamp(stored.acceptedSpeechRms, 0, 0.25),
          updatedAt:Number(stored.updatedAt) || Date.now()
        };
      } catch {
        return defaults;
      }
    }

    saveMicCalibration() {
      this.micCalibration.updatedAt = Date.now();
      try {
        global.localStorage?.setItem(MIC_CALIBRATION_KEY, JSON.stringify(this.micCalibration));
      } catch {}
    }

    effectiveVadOnsetThreshold() {
      const baseline = Math.max(this.options.vadOnsetThreshold, this.state.noiseFloor * this.options.vadNoiseFloorMultiplier);
      return clamp(baseline + this.micCalibration.sensitivityOffset, 0.009, 0.03);
    }

    recordMicCalibrationOutcome(outcome = {}) {
      const observedFloor = clamp(outcome.noiseFloor, 0.003, 0.018);
      this.micCalibration.noiseFloor = clamp(this.micCalibration.noiseFloor * 0.8 + observedFloor * 0.2, 0.003, 0.018);
      if (outcome.kind === 'missed-onset') {
        this.micCalibration.missedOnsetStreak = Math.min(2, this.micCalibration.missedOnsetStreak + 1);
        if (this.micCalibration.missedOnsetStreak >= 2) {
          this.micCalibration.sensitivityOffset = clamp(this.micCalibration.sensitivityOffset - 0.001, -0.004, 0.006);
          this.micCalibration.missedOnsetStreak = 0;
        }
      } else if (outcome.kind === 'captured') {
        this.micCalibration.missedOnsetStreak = 0;
        if (outcome.correct && Number(outcome.speechRms) > 0) {
          const speechRms = clamp(outcome.speechRms, 0, 0.25);
          this.micCalibration.acceptedCount = Math.min(10000, this.micCalibration.acceptedCount + 1);
          this.micCalibration.acceptedSpeechRms = this.micCalibration.acceptedCount === 1
            ? speechRms
            : this.micCalibration.acceptedSpeechRms * 0.8 + speechRms * 0.2;
          if (this.micCalibration.acceptedCount >= 3) {
            const baseline = Math.max(this.options.vadOnsetThreshold, this.micCalibration.noiseFloor * this.options.vadNoiseFloorMultiplier);
            const target = clamp(this.micCalibration.acceptedSpeechRms * 0.55 - baseline, 0, 0.006);
            const step = clamp(target - this.micCalibration.sensitivityOffset, -0.0005, 0.0005);
            this.micCalibration.sensitivityOffset = clamp(this.micCalibration.sensitivityOffset + step, -0.004, 0.006);
          }
        }
      }
      this.saveMicCalibration();
    }

    createState() {
      return {
        autoStartTimer: null,
        autoSubmitTimer: null,
        maxRecordTimer: null,
        stream: null,
        micPreparePromise: null,
        questionPreparePromise: null,
        answerStartPromise: null,
        answerStartKey: '',
        context: null,
        source: null,
        processor: null,
        workletReady: false,
        captureToken: 0,
        recording: false,
        uploading: false,
        starting: false,
        recordingStartedAt: 0,
        micReadyAt: 0,
        speechStarted: false,
        speechMs: 0,
        speechOnsetRms: 0,
        silenceMs: 0,
        noiseFloor: 0.006,
        pcm: [],
        pcmLength: 0,
        sampleRate: 0,
        recorder: null,
        chunks: [],
        realtimeSocket: null,
        realtimeRequested: false,
        realtimeReady: false,
        realtimeFailed: false,
        realtimeQueue: [],
        realtimePending: new Float32Array(0),
        preSpeechFrames: [],
        preSpeechSampleCount: 0,
        realtimeAudioGateOpen: false,
        lastMicAttempt: null,
        realtimeResampler: null,
        realtimeSendTimer: null,
        realtimeDrainWaiters: [],
        realtimeLastFrameSentAt: 0,
        realtimeFinals: [],
        realtimePartial: '',
        realtimeConnectPromise: null,
        realtimeCompletion: null,
        realtimeComplete: null,
        realtimeTransport: '',
        realtimeDiagnostics: {},
        finalSubmitQueued: false,
        asrAttemptId: '',
        asrAttemptStartedAt: 0,
        asrConnectMs: 0,
        asrFirstTextMs: 0,
        asrFinalMs: 0,
        asrFirstPartialTracked: false,
        asrFinalTracked: false,
        asrErrorTracked: false,
        question: null,
        questionKey: ''
      };
    }

    getAttemptId() {
      return this.state.asrAttemptId || '';
    }

    snapshot() {
      return {
        recording: this.state.recording,
        uploading: this.state.uploading,
        starting: this.state.starting,
        speechStarted: this.state.speechStarted,
        asrAttemptId: this.state.asrAttemptId,
        question: this.state.question
      };
    }

    notifyState() {
      this.options.onStateChange?.(this.snapshot(), this.state);
    }

    isRecording() {
      return this.state.recording;
    }

    isBusy() {
      return this.state.recording || this.state.uploading || this.state.starting;
    }

    setAsrConfig(config) {
      this.asrConfig = config || null;
      const profile = config?.profile;
      if (profile) {
        for (const key of ['maxRecordMs', 'vadOnsetGuardMs', 'minRecordBeforeVadStopMs', 'localVadSilenceMs']) {
          const value = Number(profile[key]);
          if (Number.isFinite(value) && value > 0) this.options[key] = value;
        }
        this.ensurePreSpeechWindow();
      }
      return this.asrConfig;
    }

    applyAsrHealth(health) {
      this.asrHealth = health || null;
      const providers = this.asrConfig?.realtime?.providers;
      if (!Array.isArray(providers)) return this.asrConfig;
      const status = new Map((health?.providers || []).map(item => [item.provider, item]));
      for (const provider of providers) {
        const configuredEnabled = provider.configuredEnabled ?? Boolean(provider.enabled);
        const probe = status.get(provider.provider);
        provider.configuredEnabled = configuredEnabled;
        provider.available = Boolean(configuredEnabled && probe?.available);
        provider.enabled = provider.available;
        provider.healthCheckedAt = probe?.checkedAt || health?.checkedAt || '';
        if (!provider.available) provider.reason = probe?.reason || provider.reason || '服务探测失败';
      }
      const enabled = providers.filter(item => item.enabled);
      this.asrConfig.realtime.enabled = Boolean(enabled.length);
      this.asrConfig.status = enabled.length ? (enabled.length === providers.length ? 'ready' : 'degraded') : 'unavailable';
      this.asrConfig.missing = providers.filter(item => !item.enabled).map(item => item.provider);
      return this.asrConfig;
    }

    healthyProviderIds() {
      return (this.asrHealth?.providers || []).filter(item => item.available).map(item => item.provider);
    }

    probeBrowserDirectProvider(providerConfig) {
      if (!global.WebSocket || !providerConfig?.sessionUrl) return Promise.resolve({ available:false, reason:'当前浏览器不支持实时语音连接' });
      return fetch(this.resolveUrl(providerConfig.sessionUrl), {
        method:'POST',
        cache:'no-store',
        headers:{ 'Content-Type':'application/json', Accept:'application/json' },
        body:JSON.stringify({ probe:true })
      }).then(async response => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.url) throw Error(payload.error || '直连签名获取失败');
        return new Promise(resolve => {
          let socket;
          try {
            socket = new WebSocket(validateWebSocketUrl(payload.url));
          } catch (error) {
            resolve({ available:false, reason:error.message || '语音连接地址无效', errorCode:'INVALID_WEBSOCKET_URL' });
            return;
          }
          let settled = false;
          const finish = result => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { socket.close(1000, 'health check complete'); } catch {}
            resolve({
              ...result,
              transport:'browser-direct',
              healthScope:'browser-end-to-end',
              checkedAt:new Date().toISOString(),
              edgeColo:payload.edgeColo || '',
              edgeCountry:payload.edgeCountry || ''
            });
          };
          const timer = setTimeout(() => finish({ available:false, reason:'国内直连探测超时', errorCode:'BROWSER_DIRECT_TIMEOUT' }), 6500);
          socket.onopen = () => {
            // A signed WebSocket handshake verifies the browser's real-time route.
            // Sending silent PCM here can trigger Tencent's no-speech error and
            // incorrectly mark an otherwise reachable provider as unavailable.
            finish({ available:true, reason:'', latencyMs:Math.max(0, Date.now() - startedAt) });
          };
          socket.onmessage = event => {
            let message;
            try { message = JSON.parse(event.data); } catch { return; }
            if (Number(message.code || 0) !== 0) {
              finish({ available:false, reason:message.message || `腾讯识别错误 ${message.code}`, errorCode:String(message.code) });
              return;
            }
            finish({ available:true, reason:'', latencyMs:Math.max(0, Date.now() - startedAt) });
          };
          socket.onerror = () => finish({ available:false, reason:'浏览器无法连接腾讯语音服务', errorCode:'BROWSER_DIRECT_CONNECTION_ERROR' });
          socket.onclose = () => finish({ available:false, reason:'腾讯语音服务在确认可用前关闭连接', errorCode:'BROWSER_DIRECT_EARLY_CLOSE' });
          const startedAt = Date.now();
        });
      }).catch(error => ({
        available:false,
        reason:error.message || String(error),
        errorCode:'BROWSER_DIRECT_SIGNATURE_ERROR',
        transport:'browser-direct',
        healthScope:'browser-end-to-end',
        checkedAt:new Date().toISOString()
      }));
    }

    async checkProviderHealth(force = false) {
      if (this.asrHealthPromise && !force) return this.asrHealthPromise;
      const healthUrl = this.resolveUrl(force ? `${this.options.asrHealthUrl}?force=1` : this.options.asrHealthUrl);
      this.asrHealthPromise = fetch(healthUrl, {
        cache: force ? 'no-store' : 'default',
        headers: { Accept: 'application/json' }
      }).then(async response => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw Error(data?.error || '语音识别服务探测失败');
        const directProviders = (this.asrConfig?.realtime?.providers || []).filter(item => item.configuredEnabled !== false && item.transport === 'browser-direct');
        await Promise.all(directProviders.map(async providerConfig => {
          const result = await this.probeBrowserDirectProvider(providerConfig);
          const serverResult = (data.providers || []).find(item => item.provider === providerConfig.provider);
          if (serverResult) Object.assign(serverResult, result);
        }));
        data.availableProviders = (data.providers || []).filter(item => item.available).map(item => item.provider);
        data.status = data.availableProviders.length === (data.providers || []).length ? 'ready' : data.availableProviders.length ? 'degraded' : 'unavailable';
        this.applyAsrHealth(data);
        this.emit('asr_health_checked', { availableProviders:this.healthyProviderIds(), status:data?.status || '' }, '语音识别服务探测完成');
        return data;
      }).catch(error => {
        this.applyAsrHealth({ status:'unavailable', checkedAt:new Date().toISOString(), providers:[] });
        this.emit('asr_health_error', { message:error.message || String(error) }, '语音识别服务探测失败');
        return null;
      }).finally(() => {
        this.asrHealthPromise = null;
      });
      return this.asrHealthPromise;
    }

    provider() {
      const assigned = String(this.options.provider?.() || '').trim();
      if (assigned) return assigned;
      return String(this.asrConfig?.realtime?.providers?.find(item => item?.enabled)?.provider || '').trim();
    }

    resolveUrl(value) {
      return this.options.resolveUrl?.(value) || value;
    }

    providerLabel() {
      return String(this.options.providerLabel?.() || this.assignedAsrConfig()?.label || '实时语音识别');
    }

    providerConnectTimeoutMs() {
      return Number(this.options.connectTimeoutByProvider?.[this.provider()] || this.options.connectTimeoutMs || 3500);
    }

    retryDetail(fallback = '可以重新回答') {
      return this.options.retryDetail || fallback;
    }

    voiceErrorMessage(message = '', fallback = '语音识别暂时不可用') {
      const preferred = this.options.voiceErrorMessage?.(message);
      return normalizeVoiceErrorMessage(message, preferred || fallback);
    }

    assignedAsrConfig() {
      const provider = this.provider();
      return this.asrConfig?.realtime?.providers?.find(item => item.provider === provider) || null;
    }

    async loadAsrConfig() {
      if (this.asrConfigPromise) return this.asrConfigPromise;
      if (this.options.loadAsrConfig) {
        this.asrConfigPromise = Promise.resolve(this.options.loadAsrConfig()).then(config => this.setAsrConfig(config)).finally(() => {
          this.asrConfigPromise = null;
        });
        return this.asrConfigPromise;
      }
      this.asrConfigPromise = fetch(this.resolveUrl(`${this.options.asrConfigUrl}?t=${Date.now()}`), { cache: 'no-store', headers: { Accept: 'application/json' } })
        .then(async response => {
          const data = await response.json().catch(() => null);
          if (!response.ok) throw Error(data?.error || '语音识别配置读取失败');
          this.setAsrConfig(data);
          await this.checkProviderHealth();
          return this.asrConfig;
        })
        .catch(error => {
          this.setAsrConfig(null);
          this.emit('asr_config_error', { message: error.message || String(error) }, '实时语音识别配置读取失败');
          return null;
        })
        .finally(() => {
          this.asrConfigPromise = null;
        });
      return this.asrConfigPromise;
    }

    questionDetails(question = this.state.question) {
      return this.options.eventDetails?.(question) || { questionId: question?.id || '' };
    }

    emit(type, details = {}, message = '') {
      const enriched = {
        ...details,
        asrProvider: details.asrProvider || details.provider || this.provider(),
        asrAttemptId: details.asrAttemptId || this.state.asrAttemptId || ''
      };
      this.options.onEvent?.(type, enriched, message);
    }

    setVoiceState(mode, status, detail = '') {
      if (this.options.onVoiceState) {
        this.options.onVoiceState(mode, status, detail);
        return;
      }
      const selectors = this.options.selectors;
      const dock = $(selectors.dock);
      if (dock) dock.className = `answer-dock ${mode}`;
      const statusEl = $(selectors.status);
      if (statusEl) statusEl.textContent = status || '';
      const detailEl = $(selectors.detail);
      if (detailEl) detailEl.textContent = detail || '';
      const stopButton = $(selectors.stopButton);
      if (stopButton) stopButton.classList.toggle('hidden', mode !== 'listening');
      const retryButton = $(selectors.retryButton);
      if (retryButton) retryButton.classList.toggle('hidden', mode !== 'error');
      if (mode !== 'listening') $$(selectors.levelBars).forEach(bar => {
        bar.style.transform = '';
      });
    }

    renderCaption(text = '', mode = 'waiting', placeholder = '等待你开口') {
      if (this.options.onCaption) {
        this.options.onCaption(text, mode, placeholder);
        return;
      }
      renderAnimatedCaption(this.options.selectors, text, mode, placeholder);
    }

    resetUi(statusDetail = '正在连接语音识别', placeholder = '正在准备语音识别') {
      clearTimeout(this.state.autoStartTimer);
      clearTimeout(this.state.autoSubmitTimer);
      clearTimeout(this.state.maxRecordTimer);
      this.state.uploading = false;
      this.state.finalSubmitQueued = false;
      this.state.speechStarted = false;
      this.state.speechMs = 0;
      this.state.speechOnsetRms = 0;
      this.state.silenceMs = 0;
      this.state.noiseFloor = this.micCalibration.noiseFloor;
      this.state.pcm = [];
      this.state.pcmLength = 0;
      this.state.chunks = [];
      this.state.realtimeQueue = [];
      this.state.realtimePending = new Float32Array(0);
      this.state.preSpeechFrames = [];
      this.state.preSpeechSampleCount = 0;
      this.state.realtimeAudioGateOpen = false;
      this.state.lastMicAttempt = null;
      this.state.realtimeFinals = [];
      this.state.realtimePartial = '';
      this.setVoiceState('preparing', '准备中', statusDetail);
      this.renderCaption('', 'waiting', placeholder);
      this.notifyState();
    }

    async getMicStream() {
      if (this.options.getMicStream) return this.options.getMicStream();
      try {
        return await navigator.mediaDevices.getUserMedia(micConstraints());
      } catch (error) {
        if (error.name !== 'OverconstrainedError' && error.name !== 'ConstraintNotSatisfiedError') throw error;
        return navigator.mediaDevices.getUserMedia(fallbackMicConstraints());
      }
    }

    micStateDetails() {
      const tracks = this.state.stream?.getAudioTracks?.() || [];
      const settings = tracks.find(track => track.readyState === 'live')?.getSettings?.() || {};
      return {
        streamActive: Boolean(this.state.stream?.active),
        audioTrackCount: tracks.length,
        liveAudioTrackCount: tracks.filter(track => track.readyState === 'live').length,
        trackEnabled: tracks.some(track => track.enabled),
        trackMuted: tracks.length ? tracks.every(track => track.muted) : false,
        trackReadyState: tracks.map(track => track.readyState).join(','),
        echoCancellation: typeof settings.echoCancellation === 'boolean' ? settings.echoCancellation : null,
        noiseSuppression: typeof settings.noiseSuppression === 'boolean' ? settings.noiseSuppression : null,
        autoGainControl: typeof settings.autoGainControl === 'boolean' ? settings.autoGainControl : null,
        channelCount: Number(settings.channelCount) || null,
        inputSampleRate: Number(settings.sampleRate) || null
      };
    }

    hasLiveMicStream() {
      const tracks = this.state.stream?.getAudioTracks?.() || [];
      return Boolean(this.state.stream?.active && tracks.some(track => track.readyState === 'live'));
    }

    async prepareMic() {
      if (this.state.micPreparePromise) return this.state.micPreparePromise;
      this.state.micPreparePromise = this.prepareMicNow().finally(() => {
        this.state.micPreparePromise = null;
      });
      return this.state.micPreparePromise;
    }

    async prepareMicNow() {
      if (!global.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw Error('麦克风需要 HTTPS 或 localhost 访问');
      if (!this.hasLiveMicStream()) {
        this.state.stream?.getTracks?.().forEach(track => track.stop());
        this.state.stream = await this.getMicStream();
      }
      this.state.stream.getAudioTracks().forEach(track => {
        track.enabled = true;
      });
      const AudioContextClass = global.AudioContext || global.webkitAudioContext;
      if (!AudioContextClass) throw Error('当前浏览器不支持实时语音');
      if (!this.state.context || this.state.context.state === 'closed') {
        this.state.context = new AudioContextClass();
        this.state.workletReady = false;
      }
      if (this.state.context.state === 'suspended') await this.state.context.resume();
      if (this.state.context.state !== 'running') throw Error('麦克风音频上下文未启动');
      this.state.sampleRate = Math.round(this.state.context.sampleRate || 48000);
    }

    async prewarmMicForQuestion(question = null, options = {}) {
      const target = question || this.options.currentQuestion?.() || null;
      const reason = options.reason || 'question-enter';
      const questionKey = target ? (this.options.questionKey?.(target) || target.id || '') : '';
      const details = {
        ...this.questionDetails(target),
        reason
      };
      if (target) {
        this.state.question = target;
        this.state.questionKey = questionKey;
      }
      if (options.updateUi !== false) {
        this.setVoiceState('preparing', '准备中', options.detail || '正在准备麦克风');
        this.renderCaption('', 'waiting', options.placeholder || '正在准备语音识别');
      }
      this.state.micReadyAt = 0;
      this.emit('mic_prepare_started', details, '进入题目页开始预热麦克风');
      this.notifyState();
      try {
        await this.prepareMic();
        if (target && this.options.isStale?.(target, questionKey)) return false;
        this.state.micReadyAt = Date.now();
        this.emit('mic_ready', {
          ...details,
          ...this.micStateDetails(),
          sampleRate: this.state.sampleRate,
          contextState: this.state.context?.state || ''
        }, '进入题目页已预热麦克风');
        this.notifyState();
        return true;
      } catch (error) {
        this.emit(error?.name === 'NotAllowedError' ? 'mic_permission_denied' : 'mic_prepare_error', {
          ...details,
          name: error?.name || '',
          message: error?.message || String(error)
        }, '进入题目页预热麦克风失败');
        throw error;
      }
    }

    async enterQuestion(question, options = {}) {
      this.stopCapture(true);
      if (question) {
        this.state.question = question;
        this.state.questionKey = this.options.questionKey?.(question) || question.id || '';
      }
      this.state.answerStartPromise = null;
      this.state.answerStartKey = '';
      this.state.questionPreparePromise = this.prewarmMicForQuestion(question, {
        reason: options.reason || 'question-enter',
        updateUi: options.updateUi ?? false,
        detail: options.detail,
        placeholder: options.placeholder
      });
      return this.state.questionPreparePromise;
    }

    async startPrepared(question, options = {}) {
      if (!question || this.options.isBlocked?.()) return false;
      const questionKey = this.options.questionKey?.(question) || question.id || '';
      if (this.state.answerStartPromise && this.state.answerStartKey === questionKey) {
        return this.state.answerStartPromise;
      }
      const run = (async () => {
        if (this.state.questionKey === questionKey && this.state.questionPreparePromise) {
          const prepared = await this.state.questionPreparePromise;
          if (prepared === false) return false;
        } else {
          const prepared = await this.enterQuestion(question, {
            reason: options.prepareReason || 'answer-start',
            updateUi: false
          });
          if (prepared === false) return false;
        }
        const delayMs = options.delayMs ?? this.options.startDelayMs;
        if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
        if (this.options.isStale?.(question, questionKey) || this.state.questionKey !== questionKey) return false;
        return this.start(question, { reason: options.reason || 'auto-after-playback' });
      })();
      const wrapped = run.finally(() => {
        if (this.state.answerStartPromise === wrapped) {
          this.state.answerStartPromise = null;
          this.state.answerStartKey = '';
        }
      });
      this.state.answerStartPromise = wrapped;
      this.state.answerStartKey = questionKey;
      return wrapped;
    }

    stopCaptureNodes() {
      if (this.state.processor) {
        this.state.processor.onaudioprocess = null;
        if (this.state.processor.port) this.state.processor.port.onmessage = null;
        try {
          this.state.processor.disconnect();
        } catch {}
        this.state.processor = null;
      }
      if (this.state.source) {
        try {
          this.state.source.disconnect();
        } catch {}
        this.state.source = null;
      }
    }

    release() {
      clearTimeout(this.state.autoStartTimer);
      clearTimeout(this.state.autoSubmitTimer);
      clearTimeout(this.state.maxRecordTimer);
      this.state.captureToken += 1;
      this.state.micPreparePromise = null;
      this.state.questionPreparePromise = null;
      this.state.answerStartPromise = null;
      this.state.answerStartKey = '';
      this.cancelRealtime();
      this.stopCaptureNodes();
      if (this.state.recorder?.state !== 'inactive') {
        try {
          this.state.recorder.stop();
        } catch {}
      }
      this.state.recorder = null;
      this.state.stream?.getTracks().forEach(track => track.stop());
      this.state.stream = null;
      if (this.state.context) this.state.context.close().catch(() => {});
      this.state.context = null;
      this.state.workletReady = false;
      this.state.recording = false;
      this.state.uploading = false;
      this.state.starting = false;
      this.state.finalSubmitQueued = false;
      this.notifyState();
    }

    markSpeechDetected(rms = 0) {
      if (this.state.speechStarted || !this.state.recording || this.state.uploading) return;
      this.state.speechStarted = true;
      this.state.speechOnsetRms = Number(rms) || 0;
      this.state.silenceMs = 0;
      this.setVoiceState('listening', '正在听你说', '识别字幕会显示在上方');
      this.options.onSpeechDetected?.(this.state.question);
      this.notifyState();
    }

    updateVoiceLevel(samples) {
      let energy = 0;
      for (let index = 0; index < samples.length; index += 8) energy += samples[index] * samples[index];
      const rms = Math.sqrt(energy / Math.max(1, Math.ceil(samples.length / 8)));
      const frameMs = Math.max(2, samples.length / Math.max(1, this.state.sampleRate || 48000) * 1000);
      const onsetThreshold = this.effectiveVadOnsetThreshold();
      const noiseFloorCeiling = Math.min(0.014, this.state.noiseFloor * 1.8, onsetThreshold * 0.72);
      if (!this.state.speechStarted && rms < noiseFloorCeiling && rms < 0.04) {
        this.state.noiseFloor = Math.min(0.018, Math.max(0.003, this.state.noiseFloor * 0.96 + rms * 0.04));
      }
      const level = Math.min(1, Math.max(0, rms - this.state.noiseFloor) * 18);
      $$(this.options.selectors.levelBars).forEach((bar, index) => {
        const factor = index === 2 ? 1 : index === 1 || index === 3 ? 0.72 : 0.46;
        bar.style.transform = `scaleY(${Math.max(0.06, level * factor)})`;
      });
      if (!this.state.speechStarted) {
        if (Date.now() - this.state.recordingStartedAt < this.options.vadOnsetGuardMs) {
          this.state.speechMs = 0;
          return;
        }
        this.state.speechMs = rms > onsetThreshold ? this.state.speechMs + frameMs : Math.max(0, this.state.speechMs - frameMs * 1.5);
        if (this.state.speechMs >= this.options.vadMinSpeechMs) this.markSpeechDetected(rms);
        return;
      }
      const releaseThreshold = Math.max(0.009, this.state.noiseFloor * 1.5);
      this.state.silenceMs = rms > releaseThreshold ? 0 : this.state.silenceMs + frameMs;
      const localSilenceFallback = this.assignedAsrConfig()?.serverVad ? 1800 : this.options.localVadSilenceMs;
      const recordingMs = Date.now() - this.state.recordingStartedAt;
      if (recordingMs >= this.options.minRecordBeforeVadStopMs && this.state.silenceMs >= localSilenceFallback && this.state.recording && !this.state.uploading) {
        this.state.silenceMs = 0;
        this.stop('vad-silence');
      }
    }

    receivePcmSamples(input) {
      const copy = input instanceof Float32Array ? input : new Float32Array(input);
      if (this.state.realtimeRequested) {
        this.state.realtimeDiagnostics.audioFrameCount = (this.state.realtimeDiagnostics.audioFrameCount || 0) + 1;
        this.state.realtimeDiagnostics.audioSampleCount = (this.state.realtimeDiagnostics.audioSampleCount || 0) + copy.length;
        this.state.realtimeDiagnostics.lastAudioAt = Date.now();
      }
      const maxSamples = Math.max(this.state.sampleRate || 48000, (this.state.sampleRate || 48000) * this.options.maxStoredSeconds);
      if (this.state.pcmLength < maxSamples) {
        const size = Math.min(copy.length, maxSamples - this.state.pcmLength);
        const stored = copy.slice(0, size);
        this.state.pcm.push(stored);
        this.state.pcmLength += stored.length;
      }
      if (this.state.realtimeRequested && !this.state.realtimeAudioGateOpen) this.bufferPreSpeechSamples(copy);
      this.updateVoiceLevel(copy);
      if (this.state.realtimeRequested && this.state.speechStarted) {
        if (!this.state.realtimeAudioGateOpen) {
          this.state.realtimeAudioGateOpen = true;
          this.state.preSpeechFrames.forEach(frame => this.queueRealtimeAudio(frame));
          this.state.preSpeechFrames = [];
          this.state.preSpeechSampleCount = 0;
        } else {
          this.queueRealtimeAudio(copy);
        }
      }
    }

    bufferPreSpeechSamples(samples) {
      const copy = samples.slice();
      this.state.preSpeechFrames.push(copy);
      this.state.preSpeechSampleCount += copy.length;
      const sampleRate = this.state.sampleRate || 48000;
      const maxSamples = Math.max(1, Math.round(sampleRate * this.options.preSpeechMs / 1000));
      while (this.state.preSpeechSampleCount > maxSamples && this.state.preSpeechFrames.length) {
        const overflow = this.state.preSpeechSampleCount - maxSamples;
        const first = this.state.preSpeechFrames[0];
        if (overflow >= first.length) {
          this.state.preSpeechFrames.shift();
          this.state.preSpeechSampleCount -= first.length;
        } else {
          this.state.preSpeechFrames[0] = first.slice(overflow);
          this.state.preSpeechSampleCount -= overflow;
        }
      }
    }

    async startPcmCapture(stream, captureToken) {
      const context = this.state.context;
      if (!context || context.state === 'closed') return false;
      let source = null;
      let processor = null;
      try {
        if (context.audioWorklet && global.AudioWorkletNode) {
          if (!this.state.workletReady) {
            await context.audioWorklet.addModule(`${this.options.workletUrl}?v=${encodeURIComponent(this.options.version?.() || '')}`);
            if (this.state.context === context) this.state.workletReady = true;
          }
          if (!this.state.recording || this.state.captureToken !== captureToken || this.state.context !== context || context.state === 'closed') return false;
          processor = new AudioWorkletNode(context, 'pcm-capture');
          processor.port.onmessage = event => this.receivePcmSamples(event.data);
        } else {
          if (!this.state.recording || this.state.captureToken !== captureToken || this.state.context !== context) return false;
          processor = context.createScriptProcessor(4096, 1, 1);
          processor.onaudioprocess = event => this.receivePcmSamples(event.inputBuffer.getChannelData(0));
        }
        source = context.createMediaStreamSource(stream);
        source.connect(processor);
        processor.connect(context.destination);
        if (!this.state.recording || this.state.captureToken !== captureToken) {
          try {
            processor.disconnect();
          } catch {}
          try {
            source.disconnect();
          } catch {}
          return false;
        }
        this.state.source = source;
        this.state.processor = processor;
        return true;
      } catch (error) {
        if (processor) {
          try {
            processor.disconnect();
          } catch {}
        }
        if (source) {
          try {
            source.disconnect();
          } catch {}
        }
        this.emit('pcm_capture_error', { message: error.message || String(error) }, 'PCM 实时采集启动失败');
        return false;
      }
    }

    startBackupCapture(stream) {
      if (!global.MediaRecorder) return false;
      try {
        this.state.recorder = new MediaRecorder(stream, this.options.recorderOptions?.() || recorderOptions());
        this.state.recorder.ondataavailable = event => {
          if (event.data?.size) this.state.chunks.push(event.data);
        };
        this.state.recorder.start();
        return true;
      } catch (error) {
        this.state.recorder = null;
        this.emit('backup_capture_error', { message: error.message || String(error) }, '备用录音采集启动失败');
        return false;
      }
    }

    stopBackupCapture() {
      return new Promise(resolve => {
        const recorder = this.state.recorder;
        if (!recorder || recorder.state === 'inactive') {
          resolve();
          return;
        }
        recorder.addEventListener('stop', () => resolve(), { once: true });
        try {
          recorder.stop();
        } catch {
          resolve();
        }
      });
    }

    resolveRealtimeDrainWaiters(value = true) {
      const waiters = this.state.realtimeDrainWaiters.splice(0);
      waiters.forEach(resolve => resolve(value));
    }

    scheduleRealtimeSend() {
      const socket = this.state.realtimeSocket;
      if (this.state.realtimeSendTimer || !this.state.realtimeReady || socket?.readyState !== WebSocket.OPEN) return;
      if (!this.state.realtimeQueue.length) {
        this.resolveRealtimeDrainWaiters(true);
        return;
      }
      const frameMs = Math.round(this.options.realtimeFrameSamples / this.options.realtimeSampleRate * 1000);
      const delay = Math.max(0, this.state.realtimeLastFrameSentAt + frameMs - Date.now());
      this.state.realtimeSendTimer = setTimeout(() => {
        this.state.realtimeSendTimer = null;
        if (!this.state.realtimeReady || this.state.realtimeSocket !== socket || socket.readyState !== WebSocket.OPEN) return;
        const frame = this.state.realtimeQueue.shift();
        if (frame) {
          socket.send(frame);
          this.state.realtimeLastFrameSentAt = Date.now();
          this.state.realtimeDiagnostics.audioBytesSent = (this.state.realtimeDiagnostics.audioBytesSent || 0) + frame.byteLength;
          this.state.realtimeDiagnostics.audioFramesSent = (this.state.realtimeDiagnostics.audioFramesSent || 0) + 1;
        }
        if (this.state.realtimeQueue.length) this.scheduleRealtimeSend();
        else this.resolveRealtimeDrainWaiters(true);
      }, delay);
    }

    sendRealtimeFrame(buffer) {
      if (this.state.realtimeQueue.length >= this.options.maxQueuedFrames) {
        this.state.realtimeQueue.shift();
        this.state.realtimeDiagnostics.audioFramesDropped = (this.state.realtimeDiagnostics.audioFramesDropped || 0) + 1;
      }
      this.state.realtimeQueue.push(buffer);
      this.scheduleRealtimeSend();
    }

    queueRealtimeAudio(input) {
      if (!this.state.realtimeResampler) {
        this.state.realtimeResampler = new StreamingPcmResampler(this.state.sampleRate || 48000, this.options.realtimeSampleRate);
      }
      const samples = this.state.realtimeResampler.push(input);
      const combined = new Float32Array(this.state.realtimePending.length + samples.length);
      combined.set(this.state.realtimePending);
      combined.set(samples, this.state.realtimePending.length);
      let offset = 0;
      while (combined.length - offset >= this.options.realtimeFrameSamples) {
        this.sendRealtimeFrame(pcm16Buffer(combined.subarray(offset, offset + this.options.realtimeFrameSamples)));
        offset += this.options.realtimeFrameSamples;
      }
      this.state.realtimePending = combined.slice(offset);
    }

    flushRealtimeAudio() {
      if (this.state.realtimePending.length) this.sendRealtimeFrame(pcm16Buffer(this.state.realtimePending));
      this.state.realtimePending = new Float32Array(0);
      this.scheduleRealtimeSend();
    }

    waitForRealtimeDrain() {
      if (!this.state.realtimeQueue.length && !this.state.realtimeSendTimer) return Promise.resolve(true);
      return new Promise(resolve => this.state.realtimeDrainWaiters.push(resolve));
    }

    realtimeText() {
      return String(this.state.realtimePartial || this.state.realtimeFinals.at(-1) || '').trim();
    }

    completeRealtime(value = '') {
      if (!this.state.realtimeComplete) return;
      const resolve = this.state.realtimeComplete;
      this.state.realtimeComplete = null;
      resolve(value || this.realtimeText());
    }

    cancelRealtime() {
      clearTimeout(this.state.realtimeSendTimer);
      this.state.realtimeSendTimer = null;
      this.resolveRealtimeDrainWaiters(false);
      const socket = this.state.realtimeSocket;
      if (socket?.readyState === WebSocket.OPEN) {
        try {
          if (this.state.realtimeTransport !== 'browser-direct') socket.send(JSON.stringify({ type: 'CANCEL' }));
        } catch {}
        socket.close();
      } else if (socket?.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      this.completeRealtime('');
      this.state.realtimeSocket = null;
      this.state.realtimeReady = false;
      this.state.realtimeRequested = false;
      this.state.realtimeTransport = '';
      this.state.realtimeDiagnostics = {};
      this.state.realtimeQueue = [];
      this.state.realtimePending = new Float32Array(0);
      this.state.preSpeechFrames = [];
      this.state.preSpeechSampleCount = 0;
      this.state.realtimeAudioGateOpen = false;
      this.state.realtimeResampler?.reset();
      this.state.realtimeResampler = null;
      this.state.realtimeLastFrameSentAt = 0;
    }

    maybeAutoSubmit(transcript, delay = this.options.finalSubmitDelayMs) {
      const text = String(transcript || '').trim();
      if (!text) return;
      if (this.state.uploading) {
        this.completeRealtime(text);
        return;
      }
      if (!this.state.recording) return;
      this.state.speechStarted = true;
      if (this.options.shouldAutoSubmit && !this.options.shouldAutoSubmit(text, this.state.question)) return;
      if (this.state.finalSubmitQueued) return;
      this.state.finalSubmitQueued = true;
      clearTimeout(this.state.autoSubmitTimer);
      const submit = () => {
        this.state.finalSubmitQueued = false;
        if (this.state.uploading) {
          this.completeRealtime(text);
          return;
        }
        if (this.state.recording) this.stop('asr-final');
      };
      if (delay <= 0) Promise.resolve().then(submit);
      else this.state.autoSubmitTimer = setTimeout(submit, delay);
    }

    async prepareRealtime(question) {
      const providerConfig = this.assignedAsrConfig();
      if (!providerConfig?.enabled || !global.WebSocket) return Promise.resolve(false);
      if (this.provider() !== 'tencent-realtime-v2' || providerConfig.transport !== 'browser-direct') {
        this.emit('asr_error', { ...this.questionDetails(question), errorCode:'UNSUPPORTED_ASR_TRANSPORT' }, '当前语音服务配置不受支持');
        this.setVoiceState('error', '连接失败', this.retryDetail('请重新回答'));
        this.renderCaption('', 'error', '语音服务配置需要更新');
        return false;
      }
      this.cancelRealtime();
      this.state.realtimeRequested = true;
      this.state.realtimeFailed = false;
      this.state.realtimeQueue = [];
      this.state.realtimePending = new Float32Array(0);
      this.state.realtimeResampler = new StreamingPcmResampler(this.state.sampleRate || 48000, this.options.realtimeSampleRate);
      this.state.realtimeLastFrameSentAt = 0;
      this.state.realtimeFinals = [];
      this.state.realtimePartial = '';
      this.state.asrAttemptId = makeId();
      this.state.asrAttemptStartedAt = Date.now();
      this.state.asrConnectMs = 0;
      this.state.asrFirstTextMs = 0;
      this.state.asrFinalMs = 0;
      this.state.asrFirstPartialTracked = false;
      this.state.asrFinalTracked = false;
      this.state.asrErrorTracked = false;
      this.state.realtimeTransport = 'browser-direct';
      this.state.realtimeDiagnostics = {};
      this.notifyState();
      const baseDetails = this.questionDetails(question);
      this.emit('asr_connect_started', { ...baseDetails, transport: this.state.realtimeTransport }, '实时语音识别开始连接');
      this.state.realtimeCompletion = new Promise(resolve => {
        this.state.realtimeComplete = resolve;
      });
      let socketUrl = '';
      try {
        const response = await fetch(this.resolveUrl(providerConfig.sessionUrl || '/api/asr/tencent-session'), {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(this.options.startPayload?.(question) || { type: 'START', questionId: question?.id || '' })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.url) throw Error(payload.error || '腾讯直连签名获取失败');
        socketUrl = payload.url;
        this.state.realtimeDiagnostics = {
          transport:'browser-direct',
          serviceRuntime:payload.serviceRuntime || 'cloudflare-pages-signer',
          signatureEdgeColo:payload.edgeColo || '',
          signatureEdgeCountry:payload.edgeCountry || '',
          requestHost:payload.requestHost || location.host
        };
        this.emit('asr_transport_selected', { ...baseDetails, ...this.state.realtimeDiagnostics });
      } catch (error) {
        this.state.realtimeFailed = true;
        this.state.asrErrorTracked = true;
        this.emit('asr_error', { ...baseDetails, transport:'browser-direct', errorCode:'TENCENT_SIGNATURE_FAILED', message:error.message || String(error) });
        this.completeRealtime('');
        this.setVoiceState('error', '连接失败', this.retryDetail('请重新回答'));
        this.renderCaption('', 'error', this.voiceErrorMessage(error.message, '语音识别暂时不可用'));
        return false;
      }
      let socket;
      try {
        socketUrl = validateWebSocketUrl(socketUrl);
        socket = new WebSocket(socketUrl);
      } catch (error) {
        this.state.realtimeFailed = true;
        this.state.asrErrorTracked = true;
        this.emit('asr_error', { ...baseDetails, ...this.state.realtimeDiagnostics, transport: this.state.realtimeTransport, errorCode: 'INVALID_WEBSOCKET_URL', message: error.message || '语音连接地址无效' });
        this.completeRealtime('');
        this.setVoiceState('error', '连接失败', this.retryDetail('请重新回答'));
        this.renderCaption('', 'error', '语音连接地址无效，请刷新后重试');
        return false;
      }
      this.state.realtimeSocket = socket;
      this.state.realtimeConnectPromise = new Promise(resolve => {
        let settled = false;
        const settle = value => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
        const connectTimer = setTimeout(() => {
          if (this.state.realtimeSocket !== socket) return settle(false);
          this.state.realtimeFailed = true;
          if (!this.state.asrErrorTracked) {
            this.state.asrErrorTracked = true;
            this.emit('asr_error', { ...baseDetails, ...this.state.realtimeDiagnostics, transport: this.state.realtimeTransport, message: '实时识别连接超时' });
          }
          settle(false);
          this.stopCapture(true);
          this.state.uploading = false;
          this.setVoiceState('error', '连接超时', this.retryDetail('请重新回答'));
          this.renderCaption('', 'error', '语音连接超时');
        }, this.providerConnectTimeoutMs());
        socket.onopen = () => {
          if (this.state.realtimeSocket !== socket) return;
        };
        const handleMessage = message => {
          if (this.state.realtimeSocket !== socket) return;
          if (message.type === 'ASR_READY') {
            clearTimeout(connectTimer);
            this.state.realtimeReady = true;
            this.state.asrConnectMs = Date.now() - this.state.asrAttemptStartedAt;
            this.flushRealtimeAudio();
            settle(true);
            this.emit('asr_ready', { ...baseDetails, ...this.state.realtimeDiagnostics, connectMs: this.state.asrConnectMs, provider: message.provider || this.provider(), transport: message.transport || this.state.realtimeTransport }, '实时语音识别已就绪');
            if (this.state.recording && !this.state.uploading) {
              this.setVoiceState('listening', '请回答', '正在听你说');
              this.renderCaption('', 'listening', '等待你开口');
            }
            return;
          }
          if (message.type === 'ASR_PARTIAL') {
            this.state.realtimePartial = String(message.text || '').trim();
            const text = this.realtimeText();
            if (text) this.markSpeechDetected();
            if (text && !this.state.asrFirstPartialTracked) {
              this.state.asrFirstPartialTracked = true;
              this.state.asrFirstTextMs = Date.now() - this.state.asrAttemptStartedAt;
              this.emit('asr_first_partial', { ...baseDetails, ...this.state.realtimeDiagnostics, transport: this.state.realtimeTransport, firstTextMs: this.state.asrFirstTextMs });
            }
            this.renderCaption(text, text ? 'live' : 'listening', '正在听你说');
            return;
          }
          if (message.type === 'ASR_FINAL') {
            const text = String(message.text || '').trim();
            if (!text) return;
            this.markSpeechDetected();
            this.state.realtimeFinals = [text];
            this.state.realtimePartial = '';
            if (!this.state.asrFinalTracked) {
              this.state.asrFinalTracked = true;
              this.state.asrFinalMs = Date.now() - this.state.asrAttemptStartedAt;
              this.emit('asr_final', { ...baseDetails, ...this.state.realtimeDiagnostics, transport: this.state.realtimeTransport, finalMs: this.state.asrFinalMs, transcriptLength: text.length });
            }
            this.renderCaption(text, 'done');
            this.completeRealtime(text);
            this.maybeAutoSubmit(text, this.options.finalSubmitDelayMs);
            return;
          }
          if (message.type === 'ASR_ERROR') {
            const recognizedText = this.realtimeText();
            // Some upstreams send a terminal error after their final transcript.
            // A non-empty transcript is already usable and must win over that late error.
            if (recognizedText && this.state.asrFinalTracked) {
              clearTimeout(connectTimer);
              settle(true);
              this.state.realtimeFailed = false;
              this.completeRealtime(recognizedText);
              this.renderCaption(recognizedText, 'done');
              if (this.state.recording && !this.state.uploading) this.maybeAutoSubmit(recognizedText, 0);
              return;
            }
            this.state.realtimeFailed = true;
            clearTimeout(connectTimer);
            settle(false);
            const noSpeech = /not find effective speech|没有检测到有效语音|未检测到有效语音|no speech/i.test(String(message.message || ''));
            if (!this.state.asrErrorTracked) {
              this.state.asrErrorTracked = true;
              this.emit(noSpeech ? 'asr_no_speech' : 'asr_error', { ...baseDetails, ...this.state.realtimeDiagnostics, message: message.message || '实时识别失败', provider: message.provider || this.provider(), transport: message.transport || this.state.realtimeTransport, errorCode: message.errorCode ?? message.code ?? '', requestId: message.requestId || '' }, noSpeech ? '没有听清用户回答' : '实时语音识别失败');
            }
            this.stopCapture(true);
            this.state.uploading = false;
            this.setVoiceState('error', noSpeech ? '没有听清' : '识别失败', this.retryDetail('请重新回答'));
            this.renderCaption(text, 'error', noSpeech ? '没有听清，请重新回答' : this.voiceErrorMessage(message.message, '语音识别暂时不可用'));
            return;
          }
          if (message.type === 'ASR_ENDED') this.completeRealtime();
        };
        socket.onmessage = event => {
          let message;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          const diagnostics = { ...this.state.realtimeDiagnostics, provider: 'tencent-realtime-v2', transport: 'browser-direct', requestId: message.request_id || message.voice_id || '' };
          if (Number(message.code) !== 0) return handleMessage({ type: 'ASR_ERROR', ...diagnostics, errorCode: message.code, message: message.message || `腾讯识别错误 ${message.code}` });
          if (!this.state.realtimeReady) handleMessage({ type: 'ASR_READY', ...diagnostics });
          const sentences = message.sentences?.sentence_list || [];
          const text = sentences.map(item => item.sentence || '').join('').trim();
          if (text) handleMessage({ type: sentences.some(item => Number(item.sentence_type) === 1) ? 'ASR_FINAL' : 'ASR_PARTIAL', ...diagnostics, text });
          if (Number(message.final) === 1) {
            if (text) handleMessage({ type: 'ASR_FINAL', ...diagnostics, text });
            handleMessage({ type: 'ASR_ENDED', ...diagnostics });
          }
        };
        socket.onerror = () => {
          clearTimeout(connectTimer);
          settle(false);
          if (this.state.realtimeSocket !== socket) return;
          this.state.realtimeFailed = true;
          if (!this.state.asrErrorTracked) {
            this.state.asrErrorTracked = true;
            this.emit('asr_error', { ...baseDetails, ...this.state.realtimeDiagnostics, transport: this.state.realtimeTransport, message: 'WebSocket 连接失败' });
          }
          this.stopCapture(true);
          this.state.uploading = false;
          this.setVoiceState('error', '连接失败', this.retryDetail('请重新回答'));
          this.renderCaption('', 'error', '语音识别暂时不可用');
        };
        socket.onclose = () => {
          clearTimeout(connectTimer);
          settle(false);
          if (this.state.realtimeSocket !== socket) return;
          this.state.realtimeReady = false;
          this.completeRealtime();
        };
      });
      return this.state.realtimeConnectPromise;
    }

    async finishRealtime() {
      if (!this.state.realtimeRequested) return '';
      if (!this.state.realtimeReady && this.state.realtimeConnectPromise) {
        const connectWaitMs = Math.max(1200, this.providerConnectTimeoutMs() + 400);
        await Promise.race([this.state.realtimeConnectPromise, new Promise(resolve => setTimeout(() => resolve(false), connectWaitMs))]);
      }
      if (!this.state.realtimeReady || this.state.realtimeFailed || this.state.realtimeSocket?.readyState !== WebSocket.OPEN) {
        this.cancelRealtime();
        return '';
      }
      this.flushRealtimeAudio();
      const drained = await Promise.race([
        this.waitForRealtimeDrain(),
        new Promise(resolve => setTimeout(() => resolve(false), this.options.maxRealtimeDrainMs))
      ]);
      if (!drained && this.state.realtimeQueue.length) {
        this.emit('asr_audio_drain_timeout', {
          ...this.questionDetails(),
          queuedFrames:this.state.realtimeQueue.length,
          droppedFrames:this.state.realtimeDiagnostics.audioFramesDropped || 0
        }, '音频发送等待超时');
        clearTimeout(this.state.realtimeSendTimer);
        this.state.realtimeSendTimer = null;
        this.state.realtimeQueue = [];
        this.resolveRealtimeDrainWaiters(false);
      }
      this.state.realtimeSocket.send(JSON.stringify({ type:'end' }));
      const transcript = await Promise.race([
        this.state.realtimeCompletion,
        new Promise(resolve => setTimeout(() => resolve(this.realtimeText()), this.options.finishTimeoutMs))
      ]);
      if (this.state.realtimeSocket?.readyState === WebSocket.OPEN) this.state.realtimeSocket.close();
      this.state.realtimeSocket = null;
      this.state.realtimeReady = false;
      this.state.realtimeRequested = false;
      return String(transcript || '').trim();
    }

    scheduleStart(question, reason = 'auto', delay = this.options.startDelayMs) {
      clearTimeout(this.state.autoStartTimer);
      this.resetUi('正在连接语音识别', '正在准备语音识别');
      this.state.autoStartTimer = setTimeout(() => {
        this.start(question, { reason }).catch(error => this.handleError(error));
      }, delay);
    }

    async start(question, startOptions = {}) {
      if (this.state.recording || this.state.uploading || this.state.starting || this.options.isBlocked?.()) return false;
      if (!question) return false;
      if (!this.asrConfig) await this.loadAsrConfig();
      const providerConfig = this.assignedAsrConfig();
      const useRealtime = Boolean(providerConfig?.enabled && global.WebSocket);
      if (!useRealtime) throw Error(`${this.providerLabel()}当前不可用`);
      const captureToken = ++this.state.captureToken;
      this.state.starting = true;
      this.notifyState();
      try {
        this.state.question = question;
        this.state.questionKey = this.options.questionKey?.(question) || question.id || '';
        await this.options.beforeStart?.(question, startOptions);
        await this.prepareMic();
        if (!this.state.micReadyAt) {
          this.state.micReadyAt = Date.now();
          this.emit('mic_ready', {
            ...this.questionDetails(question),
            ...this.micStateDetails(),
            reason:startOptions.reason || 'answer-start',
            sampleRate:this.state.sampleRate,
            contextState:this.state.context?.state || ''
          }, '答题收音已准备');
        }
        if (this.options.isStale?.(question, this.state.questionKey) || this.state.captureToken !== captureToken) return false;
        this.state.pcm = [];
        this.state.pcmLength = 0;
        this.state.chunks = [];
        this.state.speechStarted = false;
        this.state.speechMs = 0;
        this.state.speechOnsetRms = 0;
        this.state.silenceMs = 0;
        this.state.noiseFloor = this.micCalibration.noiseFloor;
        this.state.preSpeechFrames = [];
        this.state.preSpeechSampleCount = 0;
        this.state.realtimeAudioGateOpen = false;
        this.state.lastMicAttempt = null;
        this.state.recordingStartedAt = Date.now();
        this.state.recording = true;
        this.state.uploading = false;
        this.state.finalSubmitQueued = false;
        this.notifyState();
        this.setVoiceState('preparing', '准备中', '正在连接语音识别');
        this.renderCaption('', 'waiting', '正在准备语音识别');
        this.prepareRealtime(question);
        const backupReady = typeof this.options.submitAudioFallback === 'function'
          ? this.startBackupCapture(this.state.stream)
          : false;
        const pcmReady = await this.startPcmCapture(this.state.stream, captureToken);
        if (this.state.captureToken !== captureToken || !this.state.recording || this.options.isStale?.(question, this.state.questionKey)) return false;
        if (!pcmReady && useRealtime) this.cancelRealtime();
        if (!pcmReady && !backupReady) {
          this.state.recording = false;
          throw Error('当前浏览器不支持录音');
        }
        this.setVoiceState('listening', '请回答', '正在听你说，识别连接中');
        this.renderCaption('', 'listening', '等待你开口');
        if (this.options.maxRecordMs) {
          clearTimeout(this.state.maxRecordTimer);
          this.state.maxRecordTimer = setTimeout(() => this.stop('max-duration'), this.options.maxRecordMs);
        }
        this.emit('record_started', {
          ...this.questionDetails(question),
          ...this.micStateDetails(),
          contextState: this.state.context?.state || '',
          automatic: true,
          reason: startOptions.reason || 'auto',
          captureMode: pcmReady ? `${this.provider()}_pcm` : 'media_recorder_final_blob'
        });
        return true;
      } finally {
        this.state.starting = false;
        this.notifyState();
      }
    }

    stopCapture(cancelSocket = false) {
      clearTimeout(this.state.autoStartTimer);
      clearTimeout(this.state.autoSubmitTimer);
      clearTimeout(this.state.maxRecordTimer);
      this.state.captureToken += 1;
      this.state.recording = false;
      this.state.starting = false;
      if (this.state.recorder?.state !== 'inactive') {
        try {
          this.state.recorder.stop();
        } catch {}
      }
      this.stopCaptureNodes();
      if (cancelSocket) this.cancelRealtime();
      this.notifyState();
    }

    handleError(error) {
      this.stopCapture(true);
      this.state.uploading = false;
      this.notifyState();
      this.setVoiceState('error', '无法收音', this.retryDetail('请重新回答'));
      this.renderCaption('', 'error', error?.name === 'NotAllowedError' ? '麦克风权限未开启' : this.voiceErrorMessage(error?.message, '语音识别暂时不可用'));
      const eventType = error?.name === 'NotAllowedError' ? 'mic_permission_denied' : 'mic_error';
      this.emit(eventType, { name: error?.name || '', message: error?.message || String(error) });
      this.options.onError?.(error, { phase: 'start', question: this.state.question });
    }

    async retry(question = this.options.currentQuestion?.()) {
      if (this.state.recording || this.state.uploading || this.state.starting || this.options.isBlocked?.()) return;
      if (this.state.lastMicAttempt?.missedBeforeGate) {
        this.recordMicCalibrationOutcome({ kind:'missed-onset', noiseFloor:this.state.noiseFloor });
      }
      this.state.lastMicAttempt = null;
      this.emit('asr_retry', this.questionDetails(question), '用户重新回答本题');
      this.renderCaption('', 'waiting', '正在重新连接');
      this.setVoiceState('preparing', '准备中', '正在连接语音识别');
      try {
        await this.start(question, { reason: 'retry' });
      } catch (error) {
        this.handleError(error);
      }
    }

    async stop(reason = 'manual-stop') {
      if (!this.state.recording || this.state.uploading) return;
      this.state.finalSubmitQueued = false;
      this.state.captureToken += 1;
      this.state.recording = false;
      this.state.uploading = true;
      this.notifyState();
      clearTimeout(this.state.autoSubmitTimer);
      clearTimeout(this.state.maxRecordTimer);
      const question = this.options.currentQuestion?.() || this.state.question;
      this.setVoiceState('processing', '识别中', '正在确认识别结果');
      const heardText = this.realtimeText();
      this.renderCaption(heardText, 'processing', '正在确认识别结果');
      const durationMs = this.options.durationMs?.(this.state) || Date.now() - this.state.recordingStartedAt;
      this.emit('record_stopped', {
        ...this.questionDetails(question),
        reason,
        durationMs,
        speechDetected:Boolean(this.state.speechStarted)
      });
      this.stopCaptureNodes();
      await this.stopBackupCapture();
      const realtimeTranscript = await this.finishRealtime();
      if (realtimeTranscript) this.renderCaption(realtimeTranscript, 'processing');
      await new Promise(resolve => setTimeout(resolve, 140));
      const blob = wavBlobFromPcm(this.state.pcm, this.state.pcmLength, this.state.sampleRate)
        || (this.state.chunks.length ? new Blob(this.state.chunks, { type: this.state.chunks[0].type || 'audio/webm' }) : null);
      try {
        let response;
        if (realtimeTranscript) {
          response = await this.options.submitTranscript({
            question,
            transcript: realtimeTranscript,
            durationMs,
            reason,
            heardText,
            provider: this.provider()
          });
        } else {
          const fallbackAllowed = this.options.fallbackAllowed(this.provider(), question);
          if (!fallbackAllowed) throw Error(`${this.providerLabel()}没有返回有效文字，请重新回答`);
          if (!blob) throw Error('没有录到声音，请再试一次');
          response = await this.options.submitAudioFallback({
            question,
            blob,
            durationMs,
            reason,
            heardText,
            provider: this.provider(),
            audioFileExtension
          });
        }
        this.renderCaption(response?.transcript || response?.answer || realtimeTranscript || heardText, 'done', '已记录本题');
        this.setVoiceState('done', '已听清', response?.correct || response?.result?.correct ? '本题已答对' : '本题已记录');
        this.state.uploading = false;
        this.notifyState();
        this.recordMicCalibrationOutcome({
          kind:'captured',
          correct:Boolean(response?.correct || response?.result?.correct),
          speechRms:this.state.speechOnsetRms,
          noiseFloor:this.state.noiseFloor
        });
        this.state.lastMicAttempt = null;
        this.emit('answer_response', {
          ...this.questionDetails(question),
          correct: Boolean(response?.correct || response?.result?.correct),
          provider: response?.provider || this.provider(),
          asrDurationMs: durationMs,
          transport: this.state.realtimeTransport || 'browser-direct',
          connectMs: this.state.asrConnectMs || 0,
          firstTextMs: this.state.asrFirstTextMs || 0,
          finalMs: this.state.asrFinalMs || 0,
          micReady:Boolean(this.state.micReadyAt),
          sampleRate:this.state.sampleRate || 0,
          contextState:this.state.context?.state || '',
          reason
        });
        await this.options.onSuccess?.(response, {
          question,
          transcript: response?.transcript || response?.answer || realtimeTranscript || heardText,
          durationMs,
          reason,
          provider: response?.provider || this.provider()
        });
      } catch (error) {
        this.state.uploading = false;
        this.notifyState();
        const failureText = String(error?.message || error || '');
        this.state.lastMicAttempt = {
          missedBeforeGate:!this.state.speechStarted && !realtimeTranscript && !heardText && /没有返回有效文字|没有听到有效答案|no speech|empty/i.test(failureText)
        };
        this.emit('answer_error', { ...this.questionDetails(question), error: error.message || String(error), reason });
        this.setVoiceState('error', '没听清', this.retryDetail('可以重新回答'));
        this.renderCaption(realtimeTranscript || heardText, 'error', this.voiceErrorMessage(error.message, '没有听到有效答案'));
        await this.options.onError?.(error, {
          phase: 'submit',
          question,
          realtimeTranscript,
          heardText,
          durationMs,
          reason
        });
      }
    }
  }

  global.VoiceAsrClient = VoiceAsrClient;
  global.VoiceAsrUtils = {
    audioFileExtension,
    fallbackMicConstraints,
    micConstraints,
    recorderOptions,
    renderAnimatedCaption,
    normalizeVoiceErrorMessage,
    resamplePcm,
    StreamingPcmResampler,
    wavBlobFromPcm
  };
})(window);
