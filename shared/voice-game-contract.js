(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.VoiceGameContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CONTRACT_VERSION = '1.0';
  const PRIMARY_ASR_PROVIDER = 'tencent-realtime-v2';
  const VOICE_EVENT_TYPES = Object.freeze({
    lifecycle:Object.freeze(['mic_prepare_started', 'mic_ready', 'mic_prepare_error', 'record_started', 'record_stopped']),
    transport:Object.freeze(['asr_connect_started', 'asr_transport_selected', 'asr_ready', 'asr_first_partial', 'asr_final', 'asr_error']),
    answer:Object.freeze(['answer_response', 'answer_error', 'asr_retry']),
    permission:Object.freeze(['mic_error', 'mic_permission_denied'])
  });

  const VOICE_PROFILES = Object.freeze({
    color: Object.freeze({
      gameId: 'color',
      maxRecordMs: 8000,
      vadOnsetGuardMs: 240,
      minRecordBeforeVadStopMs: 1200,
      localVadSilenceMs: 1200,
      tencentVadSilenceTime: 700,
      hotwordWeight: 9,
      hotwordLimit: 32
    }),
    sound: Object.freeze({
      gameId: 'sound',
      maxRecordMs: 10000,
      vadOnsetGuardMs: 320,
      minRecordBeforeVadStopMs: 1800,
      localVadSilenceMs: 1400,
      tencentVadSilenceTime: 900,
      hotwordWeight: 8,
      hotwordLimit: 96
    }),
    songs: Object.freeze({
      gameId: 'songs',
      maxRecordMs: 12000,
      vadOnsetGuardMs: 320,
      minRecordBeforeVadStopMs: 2200,
      localVadSilenceMs: 1700,
      tencentVadSilenceTime: 1100,
      hotwordWeight: 8,
      hotwordLimit: 128
    })
  });

  const SOUND_FILLERS = Object.freeze([
    '这是', '这个是', '应该是', '可能是', '好像是', '听起来像', '我觉得', '感觉是', '就是',
    '有点像', '像是', '大概是', '应该就是', '一个', '一种', '有人在', '有人', '正在',
    '发出来的', '发出的', '传来的', '的声音', '这个声音', '声音', '音效', '里面', '外面'
  ]);

  function rows(value) {
    return Array.isArray(value) ? value : [];
  }

  function unique(values, key = value => value) {
    const seen = new Set();
    return values.filter(value => {
      const id = key(value);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  function getVoiceProfile(gameId) {
    const profile = VOICE_PROFILES[String(gameId || '').toLowerCase()] || VOICE_PROFILES.sound;
    return { ...profile };
  }

  function selectAsrProvider(values) {
    return rows(values).map(String).includes(PRIMARY_ASR_PROVIDER) ? PRIMARY_ASR_PROVIDER : '';
  }

  function cleanHotword(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}\s·.'-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 30);
  }

  function buildTencentHotwords(values, options = {}) {
    const profile = getVoiceProfile(options.gameId);
    const limit = Math.min(128, Math.max(1, Number(options.limit || profile.hotwordLimit)));
    const defaultWeight = Math.min(11, Math.max(1, Number(options.defaultWeight || profile.hotwordWeight)));
    const normalized = rows(values).map(item => {
      const source = typeof item === 'string' ? { text:item } : (item || {});
      const text = cleanHotword(source.text || source.word || source.value);
      const weight = Math.min(11, Math.max(1, Number(source.weight || defaultWeight)));
      return { text, weight };
    });
    return unique(normalized, item => item.text.toLowerCase()).slice(0, limit);
  }

  function buildColorRoundHotwords(questions, fallback = []) {
    const values = rows(questions).flatMap(question => {
      const names = rows(question?.words).map(word => String(word?.display?.name || '')).filter(Boolean);
      return [...names.flatMap(name => [name, `${name}色`]), names.join(''), names.map(name => `${name}色`).join('')];
    }).filter(Boolean);
    return values.length ? unique(values) : rows(fallback);
  }

  function formatTencentHotwordList(values, options = {}) {
    return buildTencentHotwords(values, options).map(item => `${item.text}|${item.weight}`).join(',');
  }

  function baseNormalize(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[門]/g, '门').replace(/[鈴]/g, '铃').replace(/[進]/g, '进').replace(/[鐵]/g, '铁')
      .replace(/[寫]/g, '写').replace(/[筆]/g, '笔').replace(/[廁厠]/g, '厕').replace(/[馬]/g, '马')
      .replace(/[滿]/g, '满').replace(/[沖]/g, '冲').replace(/[劃]/g, '划').replace(/[廳]/g, '厅')
      .replace(/[\s，。！？、,.!?；;：:“”"'‘’（）()【】\[\]《》_-]/g, '');
  }

  function normalizeColorAnswer(value) {
    const aliases = { 红:'红', 蓝:'蓝', 黄:'黄', 绿:'绿', 青:'青', 清:'青', 紫:'紫', 橙:'橙', 黑:'黑', 白:'白' };
    const clean = String(value || '').replace(/[\s，。、；;：:色的我说答是]/g, '');
    return [...clean].map(char => aliases[char]).filter(Boolean);
  }

  function collapseRepeatedText(value) {
    let output = value;
    for (let size = 2; size <= 8; size += 1) output = output.replace(new RegExp(`(.{${size}})\\1+`, 'g'), '$1');
    return output;
  }

  function normalizeSoundAnswer(value) {
    let output = baseNormalize(value)
      .replace(/沫桶|满桶/g, '马桶').replace(/充水/g, '冲水').replace(/塑料代/g, '塑料袋')
      .replace(/钢比|刚笔/g, '钢笔').replace(/建刀/g, '剪刀').replace(/划柴|画火柴/g, '划火柴');
    for (const filler of SOUND_FILLERS.map(baseNormalize).filter(Boolean)) output = output.replaceAll(filler, '');
    return collapseRepeatedText(output).replace(/(?:声响|响声|声)$/u, '');
  }

  function affirmativeText(value) {
    return value
      .replace(/不是(.+?)是/g, '')
      .replace(/不像(.+?)是/g, '')
      .replace(/不太像(.+?)是/g, '')
      .replace(/没有(.+?)是/g, '')
      .replace(/不是.+$/, '')
      .replace(/不像.+$/, '')
      .replace(/不太像.+$/, '')
      .replace(/没有.+$/, '');
  }

  function isNegatedAt(text, index) {
    return /不是|不像|没有|沒|不对|不太像|别是/.test(text.slice(Math.max(0, index - 5), index));
  }

  function levenshtein(left, right) {
    const a = [...left];
    const b = [...right];
    const row = b.map((_, index) => index + 1);
    for (let i = 0; i < a.length; i += 1) {
      let diagonal = i;
      row[0] = i + 1;
      for (let j = 0; j < b.length; j += 1) {
        const previous = row[j + 1];
        row[j + 1] = Math.min(row[j + 1] + 1, row[j] + 1, diagonal + (a[i] === b[j] ? 0 : 1));
        diagonal = previous;
      }
    }
    return a.length ? row[b.length] : b.length;
  }

  function similarity(left, right) {
    const max = Math.max([...left].length, [...right].length);
    return max ? 1 - levenshtein(left, right) / max : 1;
  }

  function normalizeSongAnswer(value) {
    const temperatureNormalized = String(value || '')
      .replace(/摄氏度/gi, '度')
      .replace(/°\s*[cC]?/g, '度');
    return baseNormalize(temperatureNormalized).replace(/&/g, '和').replace(/[、/]/g, '和').replace(/[喔噢哟呦唷]/g, '哦');
  }

  function stripSongMeta(value) {
    return String(value || '')
      .replace(/[（(]\s*(?:live|伴奏|翻唱|cover|纯享版|完整版|现场版|remix|demo)\s*[）)]/gi, '')
      .replace(/\s*(?:live|伴奏|翻唱|cover|纯享版|完整版|现场版|remix|demo)\s*$/gi, '')
      .trim();
  }

  function splitSongParts(value, artist = false) {
    let text = String(value || '').replace(/[｜|]/g, '|').replace(/\s*(?:、|\/|&|，|,|＋|\+|_|;|；|\|)\s*/g, '、');
    if (artist) {
      text = text
        .replace(/\s*(?:和|与|及)\s*/g, '、')
        .replace(/\s*\b(?:and|vs\.?|feat\.?|featuring|ft\.?)\b\s*/gi, '、')
        .replace(/([\u4e00-\u9fffA-Za-z])\s*[xX]\s*(?=[\u4e00-\u9fffA-Za-z])/g, '$1、');
    }
    return text.split('、').map(part => part.trim()).filter(Boolean);
  }

  function songTerms(question, field) {
    const artist = field === 'artist';
    const values = artist
      ? [question.artist, ...rows(question.acceptedArtists), ...rows(question.artistAliases), ...rows(question.artistPhoneticAliases)]
      : [question.title, ...rows(question.acceptedTitles), ...rows(question.titleAliases), ...rows(question.titlePhoneticAliases)];
    const terms = [];
    for (const raw of values) {
      const clean = stripSongMeta(raw);
      if (clean) terms.push(clean);
      if (artist) {
        const withoutSuffix = clean.replace(/(?:乐队|组合|乐团|合唱团|演唱组)$/u, '').trim();
        if ([...normalizeSongAnswer(withoutSuffix)].length >= 2) terms.push(withoutSuffix);
      }
      for (const part of splitSongParts(clean, artist)) {
        if ([...normalizeSongAnswer(part)].length >= (artist ? 2 : 1)) terms.push(part);
      }
    }
    return unique(terms, normalizeSongAnswer);
  }

  function matchTerm(transcript, term, normalizer) {
    const answer = normalizer(transcript);
    const expected = normalizer(term);
    if (!answer || !expected) return null;
    const expectedLength = [...expected].length;
    if (answer === expected) return { matched:term, type:'exact', confidence:1 };
    if (expectedLength <= 2) return null;
    let at = answer.indexOf(expected);
    while (at >= 0) {
      if (!isNegatedAt(answer, at)) return { matched:term, type:'contains', confidence:0.98 };
      at = answer.indexOf(expected, at + expected.length);
    }
    if ([...answer].length >= 4) {
      const score = similarity(answer, expected);
      if (score >= 0.84) return { matched:term, type:'fuzzy', confidence:Number(score.toFixed(2)) };
    }
    return null;
  }

  function stripSongAnswerFillers(value) {
    let output = value;
    const prefixes = ['这首歌应该是', '这首歌可能是', '这首歌好像是', '这首歌是', '歌曲应该是', '歌曲可能是', '歌曲是', '歌名应该是', '歌名可能是', '歌名是', '歌手应该是', '歌手可能是', '歌手是', '演唱者是', '我觉得是', '我猜是', '应该是', '可能是', '好像是', '这是', '这个是'];
    let changed = true;
    while (changed) {
      changed = false;
      for (const prefix of prefixes.map(normalizeSongAnswer)) {
        if (prefix && output.startsWith(prefix)) {
          output = output.slice(prefix.length);
          changed = true;
          break;
        }
      }
    }
    return output;
  }

  function matchSongTerm(answer, term, oppositeTerms) {
    const direct = matchTerm(answer, term, normalizeSongAnswer);
    if (direct) return direct;
    const expected = normalizeSongAnswer(term);
    if ([...expected].length > 2) return null;
    for (const opposite of oppositeTerms.map(normalizeSongAnswer).filter(Boolean)) {
      const combinations = [
        `${opposite}${expected}`,
        `${opposite}的${expected}`,
        `${opposite}唱的${expected}`,
        `${expected}${opposite}`,
        `${expected}的${opposite}`
      ];
      if (combinations.includes(answer)) return { matched:term, type:'combined_exact', confidence:0.99 };
    }
    const prefix = answer.endsWith(expected) ? answer.slice(0, answer.length - expected.length) : '';
    const prefixLength = [...prefix].length;
    if (prefixLength >= 2 && prefixLength <= 8 && !isNegatedAt(answer, answer.length - expected.length)) {
      return { matched:term, type:'short_suffix', confidence:0.96 };
    }
    return null;
  }

  function answerEnvelope(gameId, transcript, result) {
    return {
      contractVersion: CONTRACT_VERSION,
      gameId,
      transcript: String(transcript || '').trim(),
      normalizedTranscript: result.normalizedTranscript || '',
      correct: Boolean(result.correct),
      score: Number(result.score || 0),
      maxScore: Number(result.maxScore || 1),
      expected: rows(result.expected),
      matches: rows(result.matches),
      reason: result.reason || (result.correct ? 'matched' : 'no_match')
    };
  }

  function judgeColor(transcript, question = {}) {
    const actual = normalizeColorAnswer(transcript);
    const expected = rows(question.expected).length
      ? rows(question.expected).map(String)
      : rows(question.words).map(word => String(word?.display?.name || word?.color || '')).filter(Boolean);
    const correct = actual.length === expected.length && actual.every((value, index) => value === expected[index]);
    return answerEnvelope('color', transcript, {
      correct,
      score:correct ? 1 : 0,
      expected,
      normalizedTranscript:actual.join(''),
      matches:correct ? expected.map((value, index) => ({ field:'color', matched:value, index, confidence:1 })) : [],
      reason:actual.length ? (correct ? 'exact_sequence' : 'sequence_mismatch') : 'empty'
    });
  }

  function judgeSound(transcript, question = {}) {
    const normalized = normalizeSoundAnswer(transcript);
    const terms = unique([
      question.name,
      ...rows(question.tags),
      ...rows(question.aliases),
      ...rows(question.semanticIntents)
    ].map(value => String(value || '').trim()).filter(Boolean), normalizeSoundAnswer);
    const phoneticTerms = unique(rows(question.phoneticAliases).map(value => String(value || '').trim()).filter(Boolean), normalizeSoundAnswer);
    let match = null;
    const normalizedTerms = terms.map(term => ({ term, value:normalizeSoundAnswer(term) })).filter(item => item.value);
    for (const item of normalizedTerms.filter(item => item.value.length === 1)) {
      if (normalized === item.value && !isNegatedAt(normalized, 0)) {
        match = { field:'sound', matched:item.term, type:'single_term_exact', confidence:1 };
        break;
      }
    }
    for (const item of normalizedTerms.filter(item => item.value.length >= 2).sort((a, b) => b.value.length - a.value.length)) {
      if (match) break;
      const term = item.term;
      const expected = normalizeSoundAnswer(term);
      const at = normalized.indexOf(expected);
      if (at >= 0 && !isNegatedAt(normalized, at)) {
        match = { field:'sound', matched:term, type:'contains', confidence:1 };
        break;
      }
      if (normalized.length >= 2 && expected.includes(normalized) && !isNegatedAt(normalized, 0)) {
        match = { field:'sound', matched:term, type:'answer_contains', confidence:0.92 };
        break;
      }
    }
    if (!match && normalized.length >= 3) {
      let best = { confidence:0, term:'' };
      for (const item of normalizedTerms.filter(item => item.value.length >= 3)) {
        if (Math.abs([...item.value].length - [...normalized].length) > 1) continue;
        const confidence = similarity(normalized, item.value);
        if (confidence > best.confidence) best = { confidence, term:item.term };
      }
      if (best.confidence >= 0.82) match = { field:'sound', matched:best.term, type:'fuzzy', confidence:Number(best.confidence.toFixed(2)) };
    }
    if (!match) {
      const phonetic = phoneticTerms.find(term => normalizeSoundAnswer(term) === normalized);
      if (phonetic) match = { field:'sound', matched:phonetic, type:'phonetic_alias', confidence:0.9 };
    }
    return answerEnvelope('sound', transcript, {
      correct:Boolean(match),
      score:match ? 1 : 0,
      expected:[question.name, ...rows(question.tags)].filter(Boolean),
      normalizedTranscript:normalized,
      matches:match ? [match] : [],
      reason:normalized ? (match ? match.type : 'no_match') : 'empty'
    });
  }

  function judgeSong(transcript, question = {}) {
    const normalized = stripSongAnswerFillers(normalizeSongAnswer(stripSongMeta(transcript)));
    const titleTerms = songTerms(question, 'title');
    const artistTerms = songTerms(question, 'artist');
    const titlePhonetic = new Set(rows(question.titlePhoneticAliases).map(normalizeSongAnswer).filter(Boolean));
    const artistPhonetic = new Set(rows(question.artistPhoneticAliases).map(normalizeSongAnswer).filter(Boolean));
    const markPhonetic = (match, aliases) => match && aliases.has(normalizeSongAnswer(match.matched))
      ? { ...match, type:'phonetic_alias', confidence:Math.min(0.9, Number(match.confidence || 0.9)) }
      : match;
    const titleMatch = markPhonetic(titleTerms.map(term => matchSongTerm(normalized, term, artistTerms)).find(Boolean) || null, titlePhonetic);
    const artistMatch = markPhonetic(artistTerms.map(term => matchSongTerm(normalized, term, titleTerms)).find(Boolean) || null, artistPhonetic);
    const score = titleMatch && artistMatch ? 3 : titleMatch ? 2 : artistMatch ? 1 : 0;
    return answerEnvelope('songs', transcript, {
      correct:score > 0,
      score,
      maxScore:3,
      expected:[question.title, question.artist].filter(Boolean),
      normalizedTranscript:normalized,
      matches:[
        titleMatch && { field:'title', ...titleMatch },
        artistMatch && { field:'artist', ...artistMatch }
      ].filter(Boolean),
      reason:score === 3 ? 'title_and_artist' : score === 2 ? 'title' : score === 1 ? 'artist' : normalized ? 'no_match' : 'empty'
    });
  }

  function judgeAnswer(input = {}) {
    const gameId = String(input.gameId || input.kind || '').toLowerCase();
    if (gameId === 'color') return judgeColor(input.transcript, input.question);
    if (gameId === 'sound') return judgeSound(input.transcript, input.question);
    if (gameId === 'songs' || gameId === 'song') return judgeSong(input.transcript, input.question);
    throw Error(`未知语音游戏：${gameId || 'empty'}`);
  }

  function agentQuestion(gameId, question = {}) {
    const id = String(question.id || question.questionId || '');
    if (gameId === 'color') {
      return { contractVersion:CONTRACT_VERSION, gameId, id, kind:'ordered-colors', answerSpec:{ expected:rows(question.expected).length ? rows(question.expected) : rows(question.words).map(word => word?.display?.name).filter(Boolean) } };
    }
    if (gameId === 'sound') {
      return { contractVersion:CONTRACT_VERSION, gameId, id, kind:'sound-label', answerSpec:{ name:question.name || '', tags:rows(question.tags), aliases:rows(question.aliases), phoneticAliases:rows(question.phoneticAliases), semanticIntents:rows(question.semanticIntents) } };
    }
    if (gameId === 'songs' || gameId === 'song') {
      return { contractVersion:CONTRACT_VERSION, gameId:'songs', id, kind:'song-title-artist', answerSpec:{ title:question.title || '', artist:question.artist || '', acceptedTitles:rows(question.acceptedTitles), acceptedArtists:rows(question.acceptedArtists), titleAliases:rows(question.titleAliases), artistAliases:rows(question.artistAliases), titlePhoneticAliases:rows(question.titlePhoneticAliases), artistPhoneticAliases:rows(question.artistPhoneticAliases) } };
    }
    throw Error(`未知语音游戏：${gameId || 'empty'}`);
  }

  function agentTurn(input = {}) {
    const question = agentQuestion(String(input.gameId || ''), input.question || {});
    const judgment = input.judgment || judgeAnswer({ gameId:question.gameId, transcript:input.transcript, question:question.answerSpec });
    return {
      contractVersion:CONTRACT_VERSION,
      gameId:question.gameId,
      sessionId:String(input.sessionId || ''),
      questionId:question.id,
      provider:String(input.provider || ''),
      transcript:String(input.transcript || '').trim(),
      judgment,
      timing:{ asrDurationMs:Math.max(0, Number(input.asrDurationMs || 0)), answeredAt:input.answeredAt || '' }
    };
  }

  function describeContract() {
    return {
      contractVersion:CONTRACT_VERSION,
      primaryAsrProvider:PRIMARY_ASR_PROVIDER,
      games:Object.keys(VOICE_PROFILES),
      voiceProfiles:Object.fromEntries(Object.entries(VOICE_PROFILES).map(([key, value]) => [key, { ...value }])),
      eventTypes:Object.fromEntries(Object.entries(VOICE_EVENT_TYPES).map(([key, value]) => [key, [...value]])),
      answerEnvelope:['contractVersion', 'gameId', 'transcript', 'normalizedTranscript', 'correct', 'score', 'maxScore', 'expected', 'matches', 'reason'],
      agentTurnEnvelope:['contractVersion', 'gameId', 'sessionId', 'questionId', 'provider', 'transcript', 'judgment', 'timing']
    };
  }

  return Object.freeze({
    CONTRACT_VERSION,
    PRIMARY_ASR_PROVIDER,
    VOICE_EVENT_TYPES,
    VOICE_PROFILES,
    buildColorRoundHotwords,
    buildTencentHotwords,
    agentQuestion,
    agentTurn,
    describeContract,
    formatTencentHotwordList,
    getVoiceProfile,
    judgeAnswer,
    judgeColor,
    judgeSong,
    judgeSound,
    normalizeColorAnswer,
    normalizeSongAnswer,
    normalizeSoundAnswer,
    selectAsrProvider,
    songTerms
  });
});
