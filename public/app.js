const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const APP_VERSION = '0.1066-20260811';
const TEST_MODE = (() => {
  try {
    const params = new URLSearchParams(window.location.search);
    return ['1', 'true', 'yes'].includes(String(params.get('test') || params.get('codexTest') || '').toLowerCase());
  } catch (e) {
    return false;
  }
})();
const PUBLIC_SHARE_URL = 'https://dx100-sound-detective.netlify.app/';
const DEVICE_COOKIE_NAME = 'voiceDetectiveDeviceId';
const USER_COOKIE_NAME = 'voiceDetectiveUserId';
const NAME_COOKIE_NAME = 'voiceDetectiveName';
const CHANGELOG = [
  {
    version: '0.1066-20260811',
    items: [
      '增强云端答题记录写入确认，避免并发请求覆盖已提交答案。',
      '语音和文字答题监控补充题目上下文，支持异常后恢复记录。'
    ]
  },
  {
    version: '0.1065-20260811',
    items: [
      '修复云端音频在部分浏览器无法真正播放的问题。',
      '线上禁用易丢失的内存测试会话，避免答题后本轮失效。'
    ]
  },
  {
    version: '0.1064-20260810',
    items: [
      '累计识别语音统计补充历史 ASR 结果事件。',
      'staff 中“设计”改为“产品设计”。'
    ]
  },
  {
    version: '0.1063-20260810',
    items: [
      'Credits 页去掉顶部品牌字，制作团队标题改为 staff。',
      'Token 消耗移入模型与算法，并新增累计识别语音统计。',
      '过往成绩弹窗标题改为“你的游玩记录”。'
    ]
  },
  {
    version: '0.1062-20260810',
    items: [
      '结算页“侦查成果”文案统一更新。',
      '排行榜高亮当前侦探，当前侦探不在前 5 时展示在第 6 行。',
      '完成挑战页改为按完成时间展示“完成全部挑战的侦探”。'
    ]
  },
  {
    version: '0.1061-20260810',
    items: [
      '答题页中间播放区域扩大，占满更多可用空间。',
      '去掉声音卡片里的“正在播放第 X 题”等状态文案。',
      '播放状态继续保留在下方独立提示区。'
    ]
  },
  {
    version: '0.1060-20260810',
    items: [
      '答题录音按钮默认文案改为“说出你的判断”。',
      '录音中按钮文案改为“我说完了”。',
      '去掉语音上传成功后的弹出提示，仅保留错误提示。'
    ]
  },
  {
    version: '0.1059-20260810',
    items: [
      '答题页声音区域改为在可用空间内居中显示。',
      '新增独立的大字号播放状态提示区，方便看清当前提示。',
      '“再听一次”移动到底部操作区，并和录音按钮做分隔。'
    ]
  },
  {
    version: '0.1058-20260810',
    items: [
      '修复题库完成度按已分配题目计算的问题，改为只统计实际回答过的声音。',
      '首页开始挑战时不再直接展示旧的完成挑战页，而是进入当前周目的答题。',
      '选题策略优先补未回答过的声音，避免中途退出误判为完成全部题库。'
    ]
  },
  {
    version: '0.1057-20260810',
    items: [
      '重画首页划火柴说明图，让火柴和摩擦火星更清晰。',
      '统一“你可以这样答”里的两个答案为说话气泡样式。',
      '去掉玩法图里的“简单几个字就可以”和结算页“本轮结算”小标题。'
    ]
  },
  {
    version: '0.1056-20260810',
    items: [
      '更新首页顶部入口样式，制作团队入口改为 Credits。',
      '新增过往成绩入口，同设备可查看题库探索进度和历史轮次正确率。',
      '语音回答改为先快速验音并后台识别，减少每题结束后的等待。'
    ]
  },
  {
    version: '0.1055-20260810',
    items: [
      '版本号入口移动到首页左上角。',
      '制作团队入口移动到首页右上角。',
      '移除用户端实时监控窗口，诊断数据继续写入后端用于统计分析。'
    ]
  },
  {
    version: '0.1054-20260807',
    items: [
      '保持完整 PCM/WAV 录音方案，同时将上传音频降采样到 16k，减少上传体积。',
      '后端对标准 16k WAV 跳过二次转码，缩短语音识别链路耗时。',
      'PCM 主录音已就绪时不再等待备用录音 blob。'
    ]
  },
  {
    version: '0.1053-20260807',
    items: [
      '录音上传改为 PCM 采集后一次性封装 WAV，避免 MediaRecorder 分片导致录音不完整。',
      'MediaRecorder 仅作为单个最终录音备份，不再按 1 秒分片。',
      '录音按钮会在采集链路启动后再进入录音中状态。'
    ]
  },
  {
    version: '0.1052-20260807',
    items: [
      '修复部分 iOS/Safari 内核浏览器录音结束后音频分片未及时上传就被判空的问题。',
      '同名且非匿名的玩家会合并为同一个用户，并迁移历史会话和统计记录。'
    ]
  },
  {
    version: '0.1051-20260807',
    items: [
      '恢复公网 HTTPS 访问地址。',
      '更新分享链接为当前可用的 Cloudflare Tunnel 地址。'
    ]
  },
  {
    version: '0.1050-20260807',
    items: [
      '用户管理页正确率改为按该用户全部答题记录实时聚合。',
      '修复旧页面继续请求已失效用户或会话时反复报错的问题。',
      '统计页中的用户不存在、题目不存在和监控记录不存在错误会被前端主动收敛。'
    ]
  },
  {
    version: '0.1049-20260807',
    items: [
      '增加前端按钮防连点，重复播放、提交、录音上传和再来一轮不会堆积请求。',
      '服务端增加关键接口限流兜底，避免短时间重复操作拖慢服务。',
      '后台声音管理增加上传、删除、开关和试听的重复操作保护。'
    ]
  },
  {
    version: '0.1048-20260807',
    items: [
      '修复服务端并发写入导致本轮记录丢失的问题。',
      '增强每题声音播放确认，自动播放未确认时提示点击再听一次。',
      '未确认听到题目声音前，点击录音会先播放声音，不会直接提交答案。'
    ]
  },
  {
    version: '0.1047-20260807',
    items: [
      '精简首页重复说明文案。',
      '调整分享按钮位置和样式，让分享操作贴近主要按钮。'
    ]
  },
  {
    version: '0.1046-20260807',
    items: [
      '优化 iOS/微信 H5 录音保存方式，停止录音时一次性上传完整音频。',
      '后端新增录音质量检测，识别静音和疑似截断的音频。',
      '没有录到声音、录音不完整或没有识别文字时，不再自动进入下一题。'
    ]
  },
  {
    version: '0.1045-20260807',
    items: [
      '优化微信内置浏览器和短屏手机的首页自适应。',
      '说明图改为等比展示，避免浏览器高度变化时裁剪或遮挡内容。',
      '答题页底部录音条加入安全区和短屏适配。'
    ]
  },
  {
    version: '0.1044-20260807',
    items: [
      '新增测试模式隔离，自动化测试不进入真实用户管理数据。',
      '测试用户、测试答题、测试录音和测试埋点默认不写入真实统计。'
    ]
  },
  {
    version: '0.1043-20260807',
    items: [
      '用户管理页显示每个用户的历史整体正确率。',
      '正确率同时展示累计答对题数和累计答题数。'
    ]
  },
  {
    version: '0.1042-20260807',
    items: [
      '接入百度智能云短语音识别作为可选 ASR 服务。',
      '新增百度 ASR 留存音频对比工具。',
      '制作团队页补充百度 ASR 配置信息。'
    ]
  },
  {
    version: '0.1041-20260807',
    items: [
      '录音交互改为点击开始、再次点击结束。',
      '前端去掉音量检测/VAD状态切换，最长录音 5 秒自动结束。',
      '新增 MiniMax ASR 对比验证工具，可接入自有 MiniMax key 和端点。'
    ]
  },
  {
    version: '0.1040-20260807',
    items: [
      '制作团队页新增模型与算法清单。',
      '后台新增统计分析页面，记录访问、停留、录音、接口和完成耗时。',
      '补充 ASR 留存音频诊断，用于区分 VAD、录音质量和识别模型问题。'
    ]
  },
  {
    version: '0.1039-20260806',
    items: [
      '每个周目听完全部声音后，都会先显示本轮结算，再展示一次完成挑战页。',
      '清理开放测试前的旧用户、旧游玩记录和自测数据。',
      '保留声音题库和素材，测试用户从干净排行榜开始。'
    ]
  },
  {
    version: '0.1038-20260806',
    items: [
      '听完全部声音后先显示本轮结算。',
      '点击“再来 5 题”才展示一次全部完成页。',
      '看过全部完成页后进入下一周目，重新开启个人推荐周期。'
    ]
  },
  {
    version: '0.1037-20260806',
    items: [
      '首页说明去掉“不用完整句”的提示行。',
      '导入新增声音“切洋葱声”。',
      '选题改为优先推荐未听过声音，并控制低正确率题分布。'
    ]
  },
  {
    version: '0.1036-20260806',
    items: [
      '说明图文案缩短为“听到‘嚓’的摩擦声”。',
      '避免加粗文字超出说明卡片。'
    ]
  },
  {
    version: '0.1035-20260806',
    items: [
      '首页品牌区改为无方框、无放大镜的新字标。',
      '说明图删除“例子”标题。',
      '新增声音文件夹里的 20 个声音到后台。'
    ]
  },
  {
    version: '0.1034-20260806',
    items: [
      '重新设计首页品牌字标，四个字统一颜色。',
      '首页说明改为划火柴示例。',
      '强调回答只需要说几个关键词。'
    ]
  },
  {
    version: '0.1033-20260806',
    items: [
      '使用 visualize 方向重绘首页品牌字标。',
      '图形元素和文字分区，避免装饰遮挡名称。',
      '压缩字标高度，让首页首屏内容更稳定。'
    ]
  },
  {
    version: '0.1032-20260806',
    items: [
      '首页标题改为独立品牌字标。',
      '去掉遮挡文字的放大镜和斜线装饰。',
      '固定标题占位，避免压住玩法内容。'
    ]
  },
  {
    version: '0.1031-20260806',
    items: [
      '去掉首页和管理后台的冗余小标题。',
      '管理后台产品名统一为“声音侦探”。',
      '首页新增更醒目的“声音侦探”品牌字形。'
    ]
  },
  {
    version: '0.1030-20260806',
    items: [
      '后台历史回答改为按钮入口。',
      '点击后在弹窗中展示高频说法和全部用户历史回答。',
      '历史回答记录补充显示用户和时间。'
    ]
  },
  {
    version: '0.1029-20260806',
    items: [
      '制作团队页的 Token 消耗改为 Codex 项目协作累计。',
      '统计来源改为本机 Codex 会话 token 日志。',
      '不再用源码字符数估算 token。'
    ]
  },
  {
    version: '0.1028-20260806',
    items: [
      '首页文案改为声音侦探的产品定位。',
      '玩法图改为听线索、作判断、看成绩三步。',
      '判断区改用物品或场景判断的表达。'
    ]
  },
  {
    version: '0.1027-20260806',
    items: [
      '历史回答按文本聚合，记录重复次数并按次数排序。',
      '声音播放时新增波纹反馈，未播放时保持静态。',
      '暂停播放进入回答时会立刻停止播放动效。'
    ]
  },
  {
    version: '0.1026-20260806',
    items: [
      '声音管理后台新增历史回答列。',
      '每个声音长期保存用户文字回答，用于后续判题模型评估。',
      '历史 session 回答自动回填到声音文件记录。'
    ]
  },
  {
    version: '0.1025-20260806',
    items: [
      '首页玩法图片改为横向铺满。',
      '新增最近 7 天 ASR 评估音频留存。',
      '制作团队页改为中文。',
      '答题页中央提示改为新题播放卡片和波形状态。'
    ]
  },
  {
    version: '0.1024-20260806',
    items: [
      '精简首页文案并压缩移动端首屏。',
      '分享链接固定为当前公网 HTTPS 地址。',
      '新增题目声音预加载，下一题播放更快。',
      '本地 ASR 从 Whisper 切换到 SenseVoiceSmall GGUF。'
    ]
  },
  {
    version: '0.1023-20260806',
    items: [
      '新增公网访问模式。',
      '公网模式下关闭后台管理页面和管理接口。',
      '支持通过 HTTPS 临时隧道在手机浏览器访问。'
    ]
  },
  {
    version: '0.1022-20260806',
    items: [
      '首页新增玩法说明图片。',
      '完成全部题库后新增制作团队入口。',
      '制作团队页新增动态 token 统计展示。'
    ]
  },
  {
    version: '0.1021-20260806',
    items: [
      '游戏名称更新为“声音侦探”。',
      '侦探排行榜只展示已玩题数和正确率。',
      '进入下一题时新增醒目的题号提示。'
    ]
  },
  {
    version: '0.1020-20260806',
    items: [
      '答题后不再逐题揭晓结果，直接进入下一题。',
      '结算页新增本轮判断回顾，只显示用户判断和正误。',
      '排行榜改为至少完成 1 轮的正确率排行。'
    ]
  },
  {
    version: '0.1019-20260806',
    items: [
      '修正全部完成页触发逻辑。',
      '只有累计完成题库所有声音时才显示贝多芬页。',
      '普通结算页继续按本轮正确率展示人物和评语。'
    ]
  },
  {
    version: '0.1018-20260806',
    items: [
      '结算页按正确率展示人物图片和专属评语。',
      '统一主图尺寸，并加入原图背景虚化效果。',
      '完成全部声音挑战时展示贝多芬完成页。'
    ]
  },
  {
    version: '0.1017-20260806',
    items: [
      '新增本地语义判题器，300ms 内完成文字判断比对。',
      '兼容重复回答、长描述和等价表述。',
      '监控中显示判题命中项、分数和匹配类型。'
    ]
  },
  {
    version: '0.1016-20260805',
    items: [
      '新增本地 whisper.cpp 语音转文字。',
      '下载本地量化模型，默认优先走本地识别。',
      '不再需要 OpenAI 或 Groq API Key。'
    ]
  },
  {
    version: '0.1015-20260805',
    items: [
      '新增可切换语音转文字服务。',
      '支持用 Groq Whisper 替代 OpenAI 转写。',
      '监控中显示转写服务和模型。'
    ]
  },
  {
    version: '0.1014-20260805',
    items: [
      '转文字失败时显示具体网络错误类型。',
      '便于区分 API Key 问题和 OpenAI 网络连接问题。'
    ]
  },
  {
    version: '0.1013-20260805',
    items: [
      'iOS 录音改为服务端转文字。',
      '配置 OpenAI API Key 后，收到声音会自动提交识别结果。',
      '监控中显示转文字是否跳过、失败或成功。'
    ]
  },
  {
    version: '0.1012-20260805',
    items: [
      '修复收到音频后自动展开文字输入。',
      '监控中区分“收到音频”和“识别文字”。',
      '明确 iOS 当前只完成收音，服务端暂未转文字。'
    ]
  },
  {
    version: '0.1011-20260805',
    items: [
      '回答按钮改为点击一次自动收音。',
      '语音失败后不再自动唤起输入法。',
      '禁用回答按钮长按复制菜单。'
    ]
  },
  {
    version: '0.1010-20260805',
    items: [
      '新增首页版本号和更新日志入口。',
      '增强 iOS Safari 录音分片和短按兼容。'
    ]
  },
  {
    version: '0.1009-20260805',
    items: [
      '开通本地 HTTPS 访问，手机浏览器可申请麦克风。',
      '麦克风提示改为显示可用的 HTTPS 地址。'
    ]
  },
  {
    version: '0.1008-20260805',
    items: [
      '修复移动端“开始挑战”点击无响应。',
      '提升 Safari 和安卓浏览器的触摸事件兼容。'
    ]
  },
  {
    version: '0.1007-20260805',
    items: [
      '答题页新增可关闭实时监控窗口。',
      '监控中显示播音设备、收音设备、识别文字和后端响应。'
    ]
  },
  {
    version: '0.1006-20260805',
    items: [
      '替换为“声音文件”目录中的音频。',
      '声音管理支持编辑中文声音名称。'
    ]
  }
];

const RESULT_PROFILES = {
  zero: {
    title: '马什么梅那位老人',
    file: '马什么梅老人.jpeg',
    quote: '耳背不是病，是你筛世界的方式'
  },
  low: {
    title: '梵高',
    file: '梵高.jpeg',
    quote: '关上耳朵，才看得见整个星空'
  },
  good: {
    title: '蜘蛛侠',
    file: '蜘蛛侠.jpeg',
    quote: '一激灵，就感应到老板来了'
  },
  perfect: {
    title: '葫芦娃里的二娃',
    file: '葫芦娃二娃.jpeg',
    quote: '妖怪的八卦，你都听到了心里'
  },
  complete: {
    title: '贝多芬',
    file: '贝多芬.png',
    quote: '夺走你的听力，你也能卷死所有人'
  }
};

let user;
let game;
let pendingCompleteResult;
let index = 0;
let audio;
let audioPlayToken = 0;
let audioPlayPendingSoundId = '';
let audioPlayPendingAt = 0;
let audioPlayConfirmTimer;
let audioPlaybackConfirmCleanup;
let confirmedPlaybackKey = '';
let recording = false;
let startingRecord = false;
let finishingRecord = false;
let audioOnlyMode = false;
let audioOnlyStream;
let gameAudioVolume = 1;
let audioProbeRecorder;
let audioProbeChunks = [];
let audioProbeUploadTimer;
let audioProbeStopping = false;
let audioProbeStartedAt = 0;
let audioProbeStopAt = 0;
let audioProbeUploadAttempts = 0;
let audioProbeSoundId = '';
let audioProbeFinishHandler;
let audioOnlyStreamReleaseTimer;
let audioProbeAudioContext;
let audioProbeSourceNode;
let audioProbeProcessorNode;
let audioProbePcmChunks = [];
let audioProbePcmLength = 0;
let audioProbeSampleRate = 0;
let questionPlayTimer;
let recordStartedAt = 0;
let recordAutoStopTimer;
let feedbackAudioContext;
let startInFlight = false;
let actionCooldowns = new Map();
let actionLocks = new Map();
let analyticsCooldowns = new Map();
let deviceId = '';
let soundCache = new Map();
let pageViewId = makeId();
let pageEnteredAt = Date.now();
let sectionEnteredAt = Date.now();
let currentPageId = 'welcome';
let lastPageExitAt = 0;
let roundStartedAt = 0;
let libraryStartedAt = Number(storageGet('libraryStartedAt') || 0) || 0;

function makeId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    try {
      return window.crypto.randomUUID();
    } catch (e) {}
  }
  const bytes = new Uint8Array(16);
  let hasRandomBytes = false;
  if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
    try {
      window.crypto.getRandomValues(bytes);
      hasRandomBytes = true;
    } catch (e) {}
  }
  if (!hasRandomBytes) {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    const value = bytes[i].toString(16);
    hex += value.length === 1 ? '0' + value : value;
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function storageGet(key) {
  try {
    return window.localStorage ? window.localStorage.getItem(key) : '';
  } catch (e) {
    return '';
  }
}

function storageSet(key, value) {
  try {
    if (window.localStorage) window.localStorage.setItem(key, value);
  } catch (e) {}
  return value;
}

function cookieGet(name) {
  try {
    const target = `${name}=`;
    const item = document.cookie.split(';').map(x => x.trim()).find(x => x.startsWith(target));
    return item ? decodeURIComponent(item.slice(target.length)) : '';
  } catch (e) {
    return '';
  }
}

function cookieSet(name, value, maxAgeSeconds = 31536000) {
  try {
    document.cookie = `${name}=${encodeURIComponent(String(value || ''))}; Max-Age=${maxAgeSeconds}; Path=/; SameSite=Lax`;
  } catch (e) {}
  return value;
}

function cleanName(name) {
  return String(name || '').trim().slice(0, 20);
}

function rememberUserIdentity(nextUser = user) {
  const name = cleanName(nextUser?.name || $('#name')?.value || '');
  if (deviceId) {
    storageSet('deviceId', deviceId);
    cookieSet(DEVICE_COOKIE_NAME, deviceId);
  }
  if (nextUser?.id) {
    storageSet('userId', nextUser.id);
    cookieSet(USER_COOKIE_NAME, nextUser.id);
  }
  if (name) {
    storageSet('playerName', name);
    cookieSet(NAME_COOKIE_NAME, name);
  }
}

function rememberedUserId() {
  return cookieGet(USER_COOKIE_NAME) || storageGet('userId') || '';
}

function rememberedName() {
  return cookieGet(NAME_COOKIE_NAME) || storageGet('playerName') || '';
}

function pruneTimedMap(map, maxAgeMs = 60000, maxSize = 160) {
  if (!map || map.size <= maxSize) return;
  const now = Date.now();
  for (const [key, value] of map.entries()) {
    const time = typeof value === 'number' ? value : Number(value && (value.at || value.startedAt) || 0);
    if (!time || now - time > maxAgeMs) map.delete(key);
  }
}

function setButtonBusy(button, busy, busyText = '') {
  if (!button) return;
  if (busy) {
    if (!button.dataset.idleText) button.dataset.idleText = button.textContent;
    button.disabled = true;
    if (busyText) button.textContent = busyText;
    button.dataset.busy = '1';
    return;
  }
  button.disabled = false;
  if (button.dataset.idleText) button.textContent = button.dataset.idleText;
  delete button.dataset.busy;
  delete button.dataset.idleText;
}

function noteAction(key, cooldownMs = 0, message = '') {
  if (!key || !cooldownMs) return true;
  const now = Date.now();
  const last = actionCooldowns.get(key) || 0;
  if (now - last < cooldownMs) {
    if (message) toast(message);
    return false;
  }
  actionCooldowns.set(key, now);
  pruneTimedMap(actionCooldowns);
  return true;
}

function beginAction(key, cooldownMs = 0, message = '') {
  if (!key) return true;
  if (actionLocks.has(key)) {
    if (message) toast(message);
    return false;
  }
  if (!noteAction(key, cooldownMs, message)) return false;
  actionLocks.set(key, Date.now());
  pruneTimedMap(actionLocks, 30000);
  return true;
}

function endAction(key) {
  if (key) actionLocks.delete(key);
}

async function runAction(key, fn, options = {}) {
  const { cooldownMs = 0, message = '', button = null, busyText = '' } = options;
  if (!beginAction(key, cooldownMs, message)) return null;
  setButtonBusy(button, true, busyText);
  try {
    return await fn();
  } finally {
    setButtonBusy(button, false);
    endAction(key);
  }
}

function getDeviceId() {
  const existing = cookieGet(DEVICE_COOKIE_NAME) || storageGet('deviceId') || makeId();
  storageSet('deviceId', existing);
  cookieSet(DEVICE_COOKIE_NAME, existing);
  return existing;
}

function currentQuestionContext() {
  const q = game && Array.isArray(game.questions) ? game.questions[index] : null;
  return {
    questionIndex: q ? index + 1 : 0,
    soundId: q ? q.id : ''
  };
}

function analyticsPayload(type, details = {}) {
  return {
    type,
    at: new Date().toISOString(),
    appVersion: APP_VERSION,
    testMode: TEST_MODE,
    deviceId,
    userId: user && user.id ? user.id : '',
    sessionId: game && game.sessionId ? game.sessionId : '',
    pageViewId,
    page: currentPageId,
    path: window.location.pathname || '/',
    userAgent: navigator.userAgent || '',
    viewport: { width: window.innerWidth || 0, height: window.innerHeight || 0 },
    durationMs: Number(details.durationMs || 0) || 0,
    details: {
      ...currentQuestionContext(),
      testMode: TEST_MODE,
      ...details
    }
  };
}

function analyticsCooldownMs(type) {
  return {
    audio_play_request: 700,
    audio_playing: 500,
    audio_play_failed: 900,
    audio_play_unconfirmed: 1200,
    record_blocked_audio_unconfirmed: 1200,
    audio_probe_chunk: 400
  }[type] || 0;
}

function shouldSkipAnalytics(type, details = {}) {
  const cooldownMs = analyticsCooldownMs(type);
  if (!cooldownMs) return false;
  const context = currentQuestionContext();
  const key = [
    type,
    game && game.sessionId ? game.sessionId : '',
    details.soundId || context.soundId || '',
    details.url || '',
    details.message || ''
  ].join('|');
  const now = Date.now();
  const last = analyticsCooldowns.get(key) || 0;
  if (now - last < cooldownMs) return true;
  analyticsCooldowns.set(key, now);
  pruneTimedMap(analyticsCooldowns);
  return false;
}

function trackAnalytics(type, details = {}, options = {}) {
  if (shouldSkipAnalytics(type, details)) return;
  const payload = analyticsPayload(type, details);
  const body = JSON.stringify(payload);
  try {
    if (options.beacon && navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon('/api/analytics/event', blob);
      return;
    }
    fetch('/api/analytics/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: Boolean(options.keepalive)
    }).catch(() => {});
  } catch (e) {}
}

function trackSection(nextId) {
  const cleanId = String(nextId || '').replace(/^#/, '') || 'unknown';
  const now = Date.now();
  if (currentPageId && currentPageId !== cleanId) {
    trackAnalytics('section_leave', { section: currentPageId, durationMs: now - sectionEnteredAt });
  }
  currentPageId = cleanId;
  sectionEnteredAt = now;
  trackAnalytics('section_enter', { section: currentPageId });
}

function show(id) {
  trackSection(id);
  $$('main section').forEach(x => x.classList.add('hidden'));
  $(id).classList.remove('hidden');
  window.scrollTo(0, 0);
}

async function api(url, opts = {}) {
  const started = Date.now();
  const method = opts.method || 'GET';
  try {
    const r = await fetch(url, opts);
    const x = await r.json();
    trackAnalytics('api_response', { url, method, status: r.status, ok: r.ok, durationMs: Date.now() - started });
    if (!r.ok) throw Error(x.error || '请求失败');
    return x;
  } catch (e) {
    trackAnalytics('api_error', { url, method, error: e.message || String(e), durationMs: Date.now() - started });
    throw e;
  }
}

function toast(t) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = t;
  el.classList.remove('hidden');
  setTimeout(() => {
    const current = $('#toast');
    if (current) current.classList.add('hidden');
  }, 2200);
}

function showStartupError(e) {
  const message = e && e.message ? e.message : String(e || '未知错误');
  console.error(e);
  const el = $('#toast');
  if (el) {
    el.textContent = '页面脚本异常：' + message;
    el.classList.remove('hidden');
  }
  const start = $('#start');
  if (start) {
    start.disabled = false;
    start.textContent = '重新开始挑战';
  }
}

window.addEventListener('error', e => {
  showStartupError(e.error || e.message);
});

window.addEventListener('unhandledrejection', e => {
  showStartupError(e.reason || '异步操作失败');
});

function trackPageExit() {
  const now = Date.now();
  if (now - lastPageExitAt < 800) return;
  lastPageExitAt = now;
  trackAnalytics('section_leave', { section: currentPageId, durationMs: now - sectionEnteredAt }, { beacon: true });
  trackAnalytics('page_leave', { durationMs: now - pageEnteredAt, section: currentPageId }, { beacon: true });
}

window.addEventListener('pagehide', trackPageExit);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') trackPageExit();
});

async function share(button = null) {
  if (!beginAction('share-link', 2000, '分享处理中，请稍候')) return;
  setButtonBusy(button, true, '正在分享...');
  const url = PUBLIC_SHARE_URL;
  try {
    if (navigator.share) {
      await navigator.share({ title: '声音侦探', text: '来玩声音侦探，听声音判断物品或场景！', url });
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
      toast('链接已复制，快去分享吧！');
    } else {
      const input = document.createElement('input');
      input.value = url;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      toast('链接已复制，快去分享吧！');
    }
  } catch (e) {
  } finally {
    setButtonBusy(button, false);
    endAction('share-link');
  }
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function resultImageUrl(file) {
  return `/images/${encodeURIComponent(file)}`;
}

function resultProfileForAccuracy(accuracy) {
  const value = Number(accuracy) || 0;
  if (value >= 100) return RESULT_PROFILES.perfect;
  if (value >= 60) return RESULT_PROFILES.good;
  if (value >= 20) return RESULT_PROFILES.low;
  return RESULT_PROFILES.zero;
}

function renderResultProfile(prefix, profile) {
  const bg = $(`#${prefix}ImageBg`);
  const image = $(`#${prefix}Image`);
  const quote = $(`#${prefix}Quote`);
  const url = resultImageUrl(profile.file);
  if (bg) bg.src = url;
  if (image) {
    image.src = url;
    image.alt = profile.title;
  }
  if (quote) quote.textContent = profile.quote;
}

function renderAnswerReview(selector, review = []) {
  const el = $(selector);
  if (!el) return;
  el.innerHTML = review.map(item => {
    const answer = item.answer ? escapeHtml(item.answer) : escapeHtml(item.statusText || '未作答');
    const state = item.answered ? (item.recognized === false ? '未识别' : (item.correct ? '答对' : '答错')) : (item.statusText || '未答');
    const status = item.answered && item.correct ? 'correct' : 'wrong';
    return `<div class="review-row ${status}"><b>第 ${item.index} 题</b><span>${answer}</span><i>${state}</i></div>`;
  }).join('') || '<p class="empty-note">还没有本轮判断</p>';
}

function renderRanking(selector, ranking = [], options = {}) {
  const el = $(selector);
  if (!el) return;
  const currentUser = options.currentUser || user || {};
  const currentId = currentUser.id || '';
  const limit = Number(options.limit || 5) || 5;
  const source = Array.isArray(ranking) ? ranking : [];
  const rows = source.slice(0, limit).map((x, i) => ({ ...x, displayRank: i + 1 }));
  if (currentId && !rows.some(x => x.id === currentId)) {
    const currentRank = source.find(x => x.id === currentId) || currentUser;
    if (currentRank && (currentRank.id || currentRank.name)) rows.push({ ...currentRank, displayRank: limit + 1 });
  }
  el.innerHTML = rows.map((x, i) => {
    const isCurrent = currentId && x.id === currentId;
    const rank = x.displayRank || i + 1;
    const badge = isCurrent ? '<small class="current-badge">你</small>' : '';
    return `<div class="rank-row ${isCurrent ? 'current' : ''}"><b>${rank}</b><div><b>${escapeHtml(x.name || '匿名玩家')}${badge}</b><br><span>已玩 ${Number(x.total || 0)} 题</span></div><b>${Number(x.accuracy || 0)}%</b></div>`;
  }).join('') || '<p class="empty-note">还没有完成 1 轮的玩家</p>';
}

function renderCompleteRanking(selector, ranking = [], currentUser = user || {}) {
  const el = $(selector);
  if (!el) return;
  const currentId = currentUser?.id || '';
  const rows = Array.isArray(ranking) ? ranking.slice() : [];
  const currentIndex = currentId ? rows.findIndex(x => x.id === currentId) : -1;
  if (currentIndex > 0) rows.unshift(rows.splice(currentIndex, 1)[0]);
  if (currentId && currentIndex < 0 && currentUser?.name) {
    rows.unshift({ ...currentUser, completedAt: new Date().toISOString(), current: true });
  }
  el.innerHTML = rows.slice(0, 10).map((x, i) => {
    const isCurrent = Boolean(x.current) || (currentId && x.id === currentId);
    const badge = isCurrent ? '<small class="current-badge">你</small>' : '';
    const completedAt = x.shownAt || x.completedAt || '';
    const timeText = completedAt ? `${escapeHtml(historyTime(completedAt))} 完成` : '已完成全部挑战';
    return `<div class="rank-row ${isCurrent ? 'current' : ''}"><b>${i + 1}</b><div><b>${escapeHtml(x.name || '匿名玩家')}${badge}</b><br><span>${timeText}</span></div><b>${Number(x.accuracy || 0)}%</b></div>`;
  }).join('') || '<p class="empty-note">还没有完成全部挑战的侦探</p>';
}

function renderChangelog() {
  const version = $('#appVersion');
  const title = $('#changelogTitle');
  const list = $('#changelogList');
  if (version) version.textContent = APP_VERSION;
  if (title) title.textContent = APP_VERSION;
  if (!list) return;
  list.innerHTML = CHANGELOG.map(item => (
    `<div class="changelog-item"><b>${escapeHtml(item.version)}</b><p>${escapeHtml(item.items.join('；'))}</p></div>`
  )).join('');
}

function setChangelogOpen(open) {
  const modal = $('#changelogModal');
  if (!modal) return;
  modal.classList.toggle('hidden', !open);
}

function setHistoryOpen(open) {
  const modal = $('#historyModal');
  if (!modal) return;
  modal.classList.toggle('hidden', !open);
}

function applyRememberedIdentity() {
  const input = $('#name');
  const name = cleanName(rememberedName());
  if (input && name && !cleanName(input.value)) input.value = name;
  if (input) {
    input.addEventListener('input', () => {
      const next = cleanName(input.value);
      if (next) {
        storageSet('playerName', next);
        cookieSet(NAME_COOKIE_NAME, next);
      }
    });
  }
}

async function loadRememberedUser() {
  deviceId = deviceId || getDeviceId();
  const params = new URLSearchParams({ deviceId });
  const userId = rememberedUserId();
  if (userId) params.set('userId', userId);
  try {
    const r = await fetch('/api/users/me?' + params.toString());
    if (r.status === 404) return null;
    const x = await r.json();
    if (!r.ok) return null;
    user = x;
    rememberUserIdentity(user);
    const input = $('#name');
    if (input && user.name && !cleanName(input.value)) input.value = user.name;
    return user;
  } catch (e) {
    return null;
  }
}

function historyTime(iso = '') {
  const date = new Date(iso || Date.now());
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderHistory(data = {}) {
  const content = $('#historyContent');
  if (!content) return;
  const progress = data.progress || {};
  const answered = Number(progress.libraryAnswered || 0);
  const total = Number(progress.libraryTotal || 0);
  const percent = Number(progress.libraryCompletion || 0);
  const rounds = Array.isArray(data.rounds) ? data.rounds : [];
  const progressText = total ? `已探索 ${answered} / ${total} 个声音线索` : '题库还没有可用声音';
  const roundHtml = rounds.map(round => {
    const profile = resultProfileForAccuracy(round.accuracy);
    const iconUrl = resultImageUrl(round.profileFile || profile.file);
    return `<div class="history-round">
      <div class="history-icon"><img src="${iconUrl}" alt=""></div>
      <div><time>${escapeHtml(historyTime(round.completedAt || round.startedAt))}</time><b>正确率</b></div>
      <div class="history-accuracy">${Number(round.accuracy || 0)}%</div>
    </div>`;
  }).join('');
  content.innerHTML = `
    <div class="history-progress">
      <strong>${percent}%</strong>
      <span>${escapeHtml(progressText)}</span>
      <div class="history-meter"><i style="width:${Math.max(0, Math.min(100, percent))}%"></i></div>
    </div>
    <b class="history-section-title">每轮成绩</b>
    ${roundHtml || '<p class="empty-note">还没有完成过一轮，先去听几段声音吧。</p>'}
  `;
}

async function openHistory(button = null) {
  if (!beginAction('history-open', 1200, '正在读取过往成绩，请稍候')) return;
  setButtonBusy(button, true, '读取中...');
  const content = $('#historyContent');
  if (content) content.innerHTML = '<p class="empty-note">正在读取过往成绩...</p>';
  setHistoryOpen(true);
  try {
    deviceId = deviceId || getDeviceId();
    const params = new URLSearchParams({ deviceId });
    const userId = user?.id || rememberedUserId();
    if (userId) params.set('userId', userId);
    if (TEST_MODE) params.set('testMode', '1');
    const r = await fetch('/api/users/history?' + params.toString());
    const x = await r.json();
    if (r.status === 404) {
      renderHistory({ progress: x.progress || { libraryAnswered: 0, libraryTotal: x.libraryTotal || 0, libraryCompletion: 0 }, rounds: [] });
      return;
    }
    if (!r.ok) throw Error(x.error || '读取过往成绩失败');
    if (x.user) {
      user = x.user;
      rememberUserIdentity(user);
      const input = $('#name');
      if (input && user.name && !cleanName(input.value)) input.value = user.name;
    }
    renderHistory(x);
    trackAnalytics('history_opened', { rounds: Array.isArray(x.rounds) ? x.rounds.length : 0 });
  } catch (e) {
    if (content) content.innerHTML = `<p class="empty-note">${escapeHtml(e.message || '读取失败，请稍后再试')}</p>`;
  } finally {
    setButtonBusy(button, false);
    endAction('history-open');
  }
}

function audioFileExtension(mime = '') {
  const type = mime.split(';')[0].trim().toLowerCase();
  return {
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/aac': '.aac',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/webm': '.webm',
    'audio/ogg': '.ogg'
  }[type] || '.webm';
}

function addClientEvent(type, message, details = {}, postToServer = false) {
  if ([
    'mic_opened',
    'record_started',
    'record_stop_click',
    'record_auto_stopped',
    'audio_probe_started',
    'audio_probe_uploaded',
    'audio_probe_upload_failed',
    'audio_probe_error',
    'audio_probe_empty',
    'audio_only_transcribed',
    'audio_only_queued',
    'audio_only_received',
    'audio_only_missing',
    'speech_started',
    'speech_recognized',
    'speech_error',
    'speech_ended_empty',
    'speech_start_failed'
  ].includes(type)) {
    trackAnalytics(type, { message, ...details });
  }
  if (postToServer) postMonitorEvent(type, message, details);
}

async function postMonitorEvent(type, message, details = {}) {
  if (!game || !game.sessionId) return;
  const nextDetails = { ...currentQuestionContext(), ...details };
  const key = `monitor-post:${game.sessionId}:${type}:${nextDetails && nextDetails.soundId ? nextDetails.soundId : ''}`;
  if (!noteAction(key, 260)) return;
  try {
    await fetch('/api/game/monitor-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: game.sessionId, type, message, details: nextDetails })
    });
  } catch (e) {
    addClientEvent('monitor_post_failed', '监控事件未能写入后端', { type });
  }
}

function setStartLoading(loading) {
  const button = $('#start');
  if (!button) return;
  button.disabled = loading;
  button.textContent = loading ? '正在进入...' : '开始挑战';
}

function playerName() {
  return cleanName($('#name')?.value || user?.name || '匿名玩家') || '匿名玩家';
}

async function createOrRefreshUser() {
  deviceId = deviceId || getDeviceId();
  user = await api('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: playerName(), deviceId, testMode: TEST_MODE })
  });
  rememberUserIdentity(user);
  addClientEvent('user_ready', '用户已创建或更新', { userId: user.id });
  return user;
}

function isMissingStateError(e) {
  const message = e && e.message ? e.message : String(e || '');
  return /用户不存在|题目不存在|记录不存在|监控记录不存在/.test(message);
}

function recoverStaleGameState(message = '本轮状态已失效，请重新开始') {
  clearSoundCache();
  clearRecordStopTimer();
  clearTimeout(audioProbeUploadTimer);
  audioProbeUploadTimer = null;
  audioProbeFinishHandler = null;
  audioProbeChunks = [];
  stopAudioProbe();
  if (audioOnlyStream) audioOnlyStream.getTracks().forEach(track => track.stop());
  audioOnlyStream = null;
  audioOnlyMode = false;
  recording = false;
  startingRecord = false;
  finishingRecord = false;
  game = null;
  pendingCompleteResult = null;
  index = 0;
  resetRecordButton();
  toast(message);
  show('#welcome');
}

async function handleStart(e) {
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
  if (startInFlight || !beginAction('start-click', 1200, '正在进入挑战，请稍候')) return;
  startInFlight = true;
  setStartLoading(true);
  trackAnalytics('start_click', { name: $('#name').value.trim() || '匿名玩家' });
  try {
    if (!libraryStartedAt) {
      libraryStartedAt = Date.now();
      storageSet('libraryStartedAt', String(libraryStartedAt));
    }
    await createOrRefreshUser();
    await startGame();
    trackAnalytics('start_success', { userId: user.id });
  } catch (e) {
    toast(e.message || '启动失败，请再试一次');
    addClientEvent('user_error', '创建用户或开始游戏失败', { error: e.message || String(e) });
    trackAnalytics('start_error', { error: e.message || String(e) });
  } finally {
    startInFlight = false;
    setStartLoading(false);
    endAction('start-click');
  }
}

function bindStartEvents() {
  const button = $('#start');
  if (!button) return;
  let lastTouchAt = 0;
  button.addEventListener('touchend', e => {
    lastTouchAt = Date.now();
    handleStart(e);
  }, { passive: false });
  button.addEventListener('click', e => {
    if (Date.now() - lastTouchAt < 500) return;
    handleStart(e);
  });
}

async function startGame() {
  if (!user || !user.id) await createOrRefreshUser();
  const actionKey = `game-start:${user?.id || deviceId || 'anonymous'}`;
  if (!beginAction(actionKey, 1800, '正在进入下一轮，请稍候')) return null;
  try {
    const startPayload = () => JSON.stringify({ userId: user.id, deviceId, name: playerName(), testMode: TEST_MODE });
    let nextGame;
    try {
      nextGame = await api('/api/game/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: startPayload()
      });
    } catch (e) {
      if (!/用户不存在/.test(e.message || String(e))) throw e;
      await createOrRefreshUser();
      nextGame = await api('/api/game/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: startPayload()
      });
    }
    if (nextGame.completionPending) {
      game = { sessionId: nextGame.completionSessionId, questions: [] };
      const r = await api('/api/game/result/' + nextGame.completionSessionId);
      pendingCompleteResult = r;
      await showPendingCompleteResult();
      return nextGame;
    }
    pendingCompleteResult = null;
    game = nextGame;
    index = 0;
    roundStartedAt = Date.now();
    clearSoundCache();
    addClientEvent('game_started', '前端已收到后端题目', { sessionId: game.sessionId, questionCount: game.questions.length }, true);
    trackAnalytics('game_started', { sessionId: game.sessionId, questionCount: game.questions.length, playthrough: game.playthrough || 1 });
    show('#quiz');
    renderQuestion();
    return nextGame;
  } finally {
    endAction(actionKey);
  }
}

function clearSoundCache() {
  clearTimeout(audioPlayConfirmTimer);
  clearPlaybackConfirmation();
  audioPlayPendingSoundId = '';
  audioPlayPendingAt = 0;
  confirmedPlaybackKey = '';
  if (audio) audio.pause();
  audio = null;
  soundCache.forEach(item => {
    try { item.audio.pause(); } catch (e) {}
  });
  soundCache = new Map();
}

function renderQuestion() {
  const q = game.questions[index];
  const current = index + 1;
  const total = game.questions.length;
  audioPlayToken += 1;
  clearTimeout(audioPlayConfirmTimer);
  clearPlaybackConfirmation();
  audioPlayPendingSoundId = '';
  audioPlayPendingAt = 0;
  confirmedPlaybackKey = '';
  $('#qcount').textContent = `第 ${current} 题 / 共 ${total} 题`;
  $('#steps').innerHTML = game.questions.map((_, i) => `<i class="step ${i <= index ? 'on' : ''}"></i>`).join('');
  $('#answerText').value = '';
  $('#textAnswer').classList.add('hidden');
  $('#switch').classList.remove('hidden');
  resetRecordButton();
  showQuestionCue(current, total);
  addClientEvent('question_rendered', '前端进入新题', { index: current, soundId: q.id }, true);
  trackAnalytics('question_rendered', { index: current, total, soundId: q.id });
  preloadUpcomingSounds(index);
  clearTimeout(questionPlayTimer);
  questionPlayTimer = setTimeout(() => play(q, { auto: true }), current === 1 ? 60 : 120);
}

function soundUrl(q) {
  return q.demo ? `/api/demo-audio/${q.demo}` : `/uploads/${q.file}`;
}

function preloadSound(q) {
  if (!q) return null;
  let item = soundCache.get(q.id);
  if (item) return item.audio;
  const preloaded = new Audio();
  preloaded.preload = 'auto';
  preloaded.src = soundUrl(q);
  preloaded.load();
  item = { audio: preloaded };
  soundCache.set(q.id, item);
  return preloaded;
}

function preloadUpcomingSounds(fromIndex = index) {
  if (!game || !Array.isArray(game.questions)) return;
  for (let i = fromIndex; i < Math.min(game.questions.length, fromIndex + 3); i++) {
    preloadSound(game.questions[i]);
  }
}

function setPlaybackNotice(text, tone = 'normal') {
  const message = text || '准备播放声音';
  const notice = $('#playbackNotice');
  if (notice) {
    notice.textContent = message;
    notice.className = `playback-notice notice-${tone}`;
  }
  const stageText = $('#soundStageText');
  if (stageText) stageText.textContent = message;
}

function showQuestionCue(current, total) {
  const cue = $('#questionCue');
  const cueText = $('#questionCueText');
  const stage = $('#audioOrb');
  const stageBadge = $('#soundStageBadge');
  if (cueText) cueText.textContent = `第 ${current} 题`;
  if (cue) {
    cue.setAttribute('aria-label', `第 ${current} 题，共 ${total} 题`);
    cue.classList.remove('cue-pop');
    void cue.offsetWidth;
    cue.classList.add('cue-pop');
  }
  if (stageBadge) stageBadge.textContent = `第 ${current} 题`;
  setPlaybackNotice(current === 1 ? '声音线索将自动播放' : '新的声音线索正在加载', 'loading');
  if (stage) {
    stage.classList.remove('stage-shift', 'audio-playing', 'audio-loading', 'audio-needs-action');
    void stage.offsetWidth;
    stage.classList.add('stage-shift');
  }
  const replay = $('#replay');
  if (replay) replay.classList.remove('attention');
  if (current > 1 && navigator.vibrate) {
    try { navigator.vibrate(28); } catch (e) {}
  }
}

function playbackKey(q = game.questions[index], i = index) {
  return `${game?.sessionId || ''}:${i}:${q?.id || ''}`;
}

function markPlaybackNeedsAction(q, token, auto) {
  if (token !== audioPlayToken || !q || audioPlayPendingSoundId !== q.id) return;
  const stage = $('#audioOrb');
  const replay = $('#replay');
  if (stage) stage.classList.remove('audio-loading', 'audio-playing');
  if (stage) stage.classList.add('audio-needs-action');
  setPlaybackNotice('没有确认声音已播放，请点再听一次', 'warning');
  if (replay) replay.classList.add('attention');
  addClientEvent('audio_play_unconfirmed', '浏览器没有确认题目声音开始播放', { soundId: q.id, auto: Boolean(auto), waitMs: Date.now() - audioPlayPendingAt }, true);
  trackAnalytics('audio_play_unconfirmed', { soundId: q.id, auto: Boolean(auto), waitMs: Date.now() - audioPlayPendingAt });
}

function clearPlaybackConfirmation() {
  if (audioPlaybackConfirmCleanup) {
    audioPlaybackConfirmCleanup();
    audioPlaybackConfirmCleanup = null;
  }
}

function playbackHasStarted(currentAudio) {
  if (!currentAudio || currentAudio.paused || currentAudio.ended) return false;
  const played = currentAudio.played;
  return currentAudio.currentTime > 0.04 || Boolean(played && played.length);
}

function bindPlaybackConfirmation(currentAudio, q, token) {
  clearPlaybackConfirmation();
  let finished = false;
  const cleanup = () => {
    currentAudio.removeEventListener('playing', confirm);
    currentAudio.removeEventListener('timeupdate', confirmIfProgressed);
  };
  const complete = () => {
    if (finished) return;
    finished = true;
    cleanup();
    if (audioPlaybackConfirmCleanup === stop) audioPlaybackConfirmCleanup = null;
  };
  const confirm = () => {
    if (token !== audioPlayToken || currentAudio !== audio) {
      complete();
      return;
    }
    if (markPlaybackConfirmed(q, token, currentAudio)) complete();
  };
  const confirmIfProgressed = () => {
    if (playbackHasStarted(currentAudio)) confirm();
  };
  const stop = () => {
    if (finished) return;
    finished = true;
    cleanup();
  };
  currentAudio.addEventListener('playing', confirm);
  currentAudio.addEventListener('timeupdate', confirmIfProgressed);
  audioPlaybackConfirmCleanup = stop;
}

function markPlaybackConfirmed(q, token, currentAudio) {
  if (token !== audioPlayToken || !q || game.questions[index]?.id !== q.id) return false;
  clearTimeout(audioPlayConfirmTimer);
  clearPlaybackConfirmation();
  audioPlayPendingSoundId = '';
  audioPlayPendingAt = 0;
  confirmedPlaybackKey = playbackKey(q);
  const stage = $('#audioOrb');
  const replay = $('#replay');
  if (stage) stage.classList.remove('audio-loading', 'audio-needs-action');
  if (stage) stage.classList.add('audio-playing');
  if (replay) replay.classList.remove('attention');
  setPlaybackNotice('请仔细听，判断它来自什么物品或场景', 'playing');
  addClientEvent('audio_playing', '题目声音已开始播放', { soundId: q.id, sinkId: currentAudio.sinkId || 'system-default' }, true);
  trackAnalytics('audio_playing', { soundId: q.id, sinkId: currentAudio.sinkId || 'system-default' });
  return true;
}

function play(q = game.questions[index], options = {}) {
  if (!q) return;
  if (recording || startingRecord) return toast('判断时先不要播放声音');
  const now = Date.now();
  const actionKey = `audio-play:${playbackKey(q)}`;
  const cooldownMs = options.manual ? 1300 : 550;
  if (!noteAction(actionKey, cooldownMs, options.manual ? '声音正在准备，请稍候' : '')) return;
  if (!options.force && audioPlayPendingSoundId === q.id && now - audioPlayPendingAt < 2500) {
    return;
  }
  const token = ++audioPlayToken;
  audioPlayPendingSoundId = q.id;
  audioPlayPendingAt = now;
  clearTimeout(audioPlayConfirmTimer);
  trackAnalytics('audio_play_request', { soundId: q.id, auto: Boolean(options.auto), manual: Boolean(options.manual) });
  const stage = $('#audioOrb');
  const replay = $('#replay');
  if (stage) stage.classList.remove('audio-playing', 'audio-needs-action');
  if (stage) stage.classList.add('audio-loading');
  if (replay) replay.classList.remove('attention');
  setPlaybackNotice('正在加载声音线索', 'loading');
  if (audio) {
    gameAudioVolume = audio.volume;
    audio.pause();
  }
  audio = preloadSound(q) || new Audio(soundUrl(q));
  try { audio.currentTime = 0; } catch (e) {}
  audio.volume = gameAudioVolume;
  const currentAudio = audio;
  if (!currentAudio.dataset || !currentAudio.dataset.volumeBound) {
    currentAudio.addEventListener('volumechange', () => {
      gameAudioVolume = currentAudio.volume;
    });
    if (currentAudio.dataset) currentAudio.dataset.volumeBound = '1';
  }
  const sinkPromise = currentAudio.setSinkId ? currentAudio.setSinkId('default').catch(e => addClientEvent('output_sink_failed', '设置默认播音设备失败', { error: e.message })) : Promise.resolve();
  const playNow = () => {
    if (token !== audioPlayToken) return;
    audioPlayConfirmTimer = setTimeout(() => markPlaybackNeedsAction(q, token, options.auto), 2200);
    bindPlaybackConfirmation(currentAudio, q, token);
    currentAudio.play()
      .then(() => {
        setTimeout(() => {
          if (token === audioPlayToken && playbackHasStarted(currentAudio)) {
            markPlaybackConfirmed(q, token, currentAudio);
          }
        }, 160);
      })
      .catch(e => {
        if (token !== audioPlayToken) return;
        clearTimeout(audioPlayConfirmTimer);
        clearPlaybackConfirmation();
        audioPlayPendingSoundId = '';
        audioPlayPendingAt = 0;
        if (stage) stage.classList.remove('audio-loading', 'audio-playing');
        if (stage) stage.classList.add('audio-needs-action');
        if (replay) replay.classList.add('attention');
        setPlaybackNotice('自动播放被浏览器拦截，请点再听一次', 'warning');
        addClientEvent('audio_play_failed', '题目声音播放失败', { soundId: q.id, error: e.message || String(e), auto: Boolean(options.auto) }, true);
        trackAnalytics('audio_play_failed', { soundId: q.id, auto: Boolean(options.auto), error: e.message || String(e) });
        toast('请点击“再听一次”播放声音');
      });
  };
  currentAudio.onended = () => {
    if (token !== audioPlayToken || game.questions[index]?.id !== q.id) return;
    if (stage) stage.classList.remove('audio-playing');
    setPlaybackNotice('听完了，请说出你的判断', 'ready');
  };
  sinkPromise.then(playNow, playNow);
}

function showTextAnswer(message, focusInput = false) {
  $('#textAnswer').classList.remove('hidden');
  $('#switch').classList.add('hidden');
  if (focusInput) $('#answerText').focus();
  if (message) toast(message);
}

function suggestTextAnswer(message) {
  if (message) toast(message);
  $('#switch').classList.remove('hidden');
  $('#textAnswer').classList.add('hidden');
}

async function submit(answer, inputMode = 'text', soundIdOverride = '') {
  answer = answer.trim();
  if (!answer) return toast('先说出或输入你的判断');
  const soundId = soundIdOverride || game.questions[index]?.id || '';
  const currentSoundId = game.questions[index]?.id || '';
  if (!soundId || soundId !== currentSoundId) {
    addClientEvent('answer_stale_ignored', '忽略过期的语音识别结果', { soundId, currentSoundId, answer }, true);
    return;
  }
  const actionKey = `answer-submit:${game.sessionId}:${soundId}`;
  if (!beginAction(actionKey, 3000, '正在提交判断，请稍候')) return;
  const button = inputMode === 'text' ? $('#submitText') : $('#record');
  setButtonBusy(button, true, inputMode === 'text' ? '提交中...' : '判断中...');
  try {
    preloadSound(game.questions[index + 1]);
    addClientEvent('answer_submit', '前端准备提交文字判断', { soundId, answer }, true);
    trackAnalytics('answer_submit', { soundId, answerLength: answer.length, inputMode });
    const r = await api('/api/game/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: game.sessionId, soundId, answer, testMode: TEST_MODE })
    });
    addClientEvent('answer_response', '前端已收到后端判断响应', { soundId, recorded: true, answer: r.answer, inputMode }, true);
    trackAnalytics('answer_response', { soundId: game.questions[index].id, recorded: true, durationMs: Date.now() - roundStartedAt });
    await goNext();
  } catch (e) {
    if (isMissingStateError(e)) {
      addClientEvent('stale_game_state', '本轮答题状态已失效，等待用户重新开始', { error: e.message }, false);
      recoverStaleGameState('本轮已失效，请重新开始挑战');
      return;
    }
    toast(e.message);
    addClientEvent('answer_error', '提交判断失败', { error: e.message }, true);
    trackAnalytics('answer_error', { error: e.message });
  } finally {
    setButtonBusy(button, false);
    endAction(actionKey);
  }
}

function autoRecordMs() {
  return 5000;
}

function clearRecordStopTimer() {
  clearTimeout(recordAutoStopTimer);
  recordAutoStopTimer = null;
}

function markRecordStarted() {
  recordStartedAt = Date.now();
  clearRecordStopTimer();
}

function playFeedbackTone(kind = 'start') {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    feedbackAudioContext = feedbackAudioContext || new AudioCtx();
    if (feedbackAudioContext.state === 'suspended') feedbackAudioContext.resume();
    const now = feedbackAudioContext.currentTime;
    const oscillator = feedbackAudioContext.createOscillator();
    const gain = feedbackAudioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(kind === 'end' ? 740 : kind === 'fail' ? 220 : 520, now);
    if (kind === 'end') oscillator.frequency.exponentialRampToValueAtTime(980, now + 0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    oscillator.connect(gain);
    gain.connect(feedbackAudioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.2);
    if (navigator.vibrate) navigator.vibrate(kind === 'start' ? 20 : 35);
  } catch (e) {}
}

function startRecordInteraction(e) {
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
  if (!noteAction('record-button', 280)) return;
  if (startingRecord || finishingRecord) return;
  if (recording) {
    trackAnalytics('record_stop_click', currentQuestionContext());
    addClientEvent('record_stop_click', '用户点击结束录音', currentQuestionContext(), true);
    stopAudioOnlyRecording({ waitForUpload: true, reason: 'manual' });
    return;
  }
  const q = game?.questions?.[index];
  if (!q) return recoverStaleGameState('本轮已失效，请重新开始挑战');
  if (q && confirmedPlaybackKey !== playbackKey(q)) {
    addClientEvent('record_blocked_audio_unconfirmed', '未确认听到题目声音，先播放声音', { soundId: q.id }, true);
    trackAnalytics('record_blocked_audio_unconfirmed', { soundId: q.id });
    play(q, { manual: true, force: true });
    toast('先听这题声音，听完再录音');
    return;
  }
  trackAnalytics('record_click', { ...currentQuestionContext(), mode: 'media_recorder' });
  playFeedbackTone('start');
  startAudioOnlyRecording();
}

function resetRecordButton() {
  clearRecordStopTimer();
  stopAudioProbe();
  recording = false;
  startingRecord = false;
  finishingRecord = false;
  recordStartedAt = 0;
  $('#record').textContent = '说出你的判断';
  $('#record').classList.remove('recording');
}

function setRecordButton(text) {
  $('#record').textContent = text;
  $('#record').classList.add('recording');
}

function pauseQuestionAudioForRecording() {
  if (!audio) return;
  gameAudioVolume = audio.volume;
  if (!audio.paused && !audio.ended) {
    audio.pause();
    const stage = $('#audioOrb');
    if (stage) stage.classList.remove('audio-playing');
  }
}

function micConstraints() {
  return {
    audio: {
      deviceId: { ideal: 'default' },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  };
}

function fallbackMicConstraints() {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  };
}

async function getSystemDefaultMicStream() {
  try {
    return await navigator.mediaDevices.getUserMedia(micConstraints());
  } catch (e) {
    if (e.name !== 'OverconstrainedError' && e.name !== 'ConstraintNotSatisfiedError') throw e;
    return navigator.mediaDevices.getUserMedia(fallbackMicConstraints());
  }
}

function micDetails(stream) {
  const tracks = stream && typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks() : [];
  const track = tracks[0];
  const settings = track && typeof track.getSettings === 'function' ? track.getSettings() : {};
  return {
    label: track && track.label ? track.label : '系统默认收音设备',
    deviceId: settings.deviceId || 'default',
    sampleRate: settings.sampleRate,
    channelCount: settings.channelCount
  };
}

function secureMicHelpMessage() {
  const host = window.location.hostname;
  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    return `麦克风需要 HTTPS，请改用 https://${host}:3443`;
  }
  return '麦克风需要 HTTPS 或 localhost 访问，请先用文字输入';
}

function releaseAudioOnlyStream(delayMs = 0) {
  clearTimeout(audioOnlyStreamReleaseTimer);
  const release = () => {
    audioOnlyStreamReleaseTimer = null;
    if (audioOnlyStream) audioOnlyStream.getTracks().forEach(track => track.stop());
    audioOnlyStream = null;
    audioOnlyMode = false;
  };
  if (delayMs > 0) {
    audioOnlyStreamReleaseTimer = setTimeout(release, delayMs);
    return;
  }
  release();
}

function handleMicError(e) {
  stopAudioProbe();
  releaseAudioOnlyStream(0);
  resetRecordButton();
  addClientEvent('mic_error', '麦克风打开失败', { name: e.name, message: e.message }, true);
  if (!window.isSecureContext) {
    suggestTextAnswer(secureMicHelpMessage());
  } else if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
    suggestTextAnswer('请在浏览器里允许麦克风权限');
  } else if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
    suggestTextAnswer('没有检测到可用麦克风');
  } else {
    suggestTextAnswer('无法打开麦克风，可点文字输入');
  }
}

function audioProbeOptions() {
  if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') return {};
  const types = [
    'audio/mp4; codecs=mp4a.40.2',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/webm;codecs=opus',
    'audio/webm'
  ];
  for (let i = 0; i < types.length; i++) {
    if (MediaRecorder.isTypeSupported(types[i])) return { mimeType: types[i] };
  }
  return {};
}

function scheduleAudioProbeUpload(delayMs = 300) {
  clearTimeout(audioProbeUploadTimer);
  audioProbeUploadTimer = setTimeout(() => {
    audioProbeUploadTimer = null;
    uploadAudioProbe();
  }, delayMs);
}

function finishAudioProbe(result) {
  if (!audioProbeFinishHandler) return;
  const handler = audioProbeFinishHandler;
  audioProbeFinishHandler = null;
  releaseAudioOnlyStream(0);
  handler(result);
}

function resetAudioProbeCaptureBuffers() {
  audioProbeChunks = [];
  audioProbePcmChunks = [];
  audioProbePcmLength = 0;
  audioProbeSampleRate = 0;
}

function stopPcmAudioProbe() {
  if (audioProbeProcessorNode) {
    audioProbeProcessorNode.onaudioprocess = null;
    try { audioProbeProcessorNode.disconnect(); } catch (e) {}
    audioProbeProcessorNode = null;
  }
  if (audioProbeSourceNode) {
    try { audioProbeSourceNode.disconnect(); } catch (e) {}
    audioProbeSourceNode = null;
  }
  if (audioProbeAudioContext) {
    const ctx = audioProbeAudioContext;
    audioProbeAudioContext = null;
    if (ctx.state !== 'closed') {
      try { ctx.close().catch(() => {}); } catch (e) {}
    }
  }
}

function startPcmAudioProbe(stream, soundId) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx || !stream) return false;
  try {
    const ctx = new AudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    const bufferSize = 4096;
    const processor = ctx.createScriptProcessor(bufferSize, 1, 1);
    audioProbeAudioContext = ctx;
    audioProbeSourceNode = source;
    audioProbeProcessorNode = processor;
    audioProbeSampleRate = Math.round(ctx.sampleRate || 48000);
    processor.onaudioprocess = e => {
      if (!audioProbeStartedAt) return;
      const input = e.inputBuffer.getChannelData(0);
      const output = e.outputBuffer.getChannelData(0);
      if (output) output.fill(0);
      const maxSamples = Math.max(audioProbeSampleRate || 48000, (audioProbeSampleRate || 48000) * 8);
      if (audioProbePcmLength >= maxSamples) return;
      const size = Math.min(input.length, maxSamples - audioProbePcmLength);
      const copy = new Float32Array(size);
      copy.set(input.subarray(0, size));
      audioProbePcmChunks.push(copy);
      audioProbePcmLength += size;
    };
    source.connect(processor);
    processor.connect(ctx.destination);
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      ctx.resume().catch(e => addClientEvent('audio_probe_pcm_resume_failed', 'PCM 采集音频上下文恢复失败', { error: e.message }));
    }
    addClientEvent('audio_probe_pcm_started', 'PCM 录音采集已启动', { soundId, sampleRate: audioProbeSampleRate, bufferSize }, true);
    return true;
  } catch (e) {
    stopPcmAudioProbe();
    addClientEvent('audio_probe_pcm_error', 'PCM 录音采集启动失败', { error: e.message }, true);
    return false;
  }
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function mergedPcmSamples() {
  if (!audioProbePcmLength) return null;
  const samples = new Float32Array(audioProbePcmLength);
  let offset = 0;
  for (const chunk of audioProbePcmChunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return samples;
}

function resamplePcmSamples(samples, sourceRate, targetRate = 16000) {
  if (!samples || !sourceRate || sourceRate === targetRate) return samples;
  const ratio = sourceRate / targetRate;
  const length = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(samples.length - 1, left + 1);
    const weight = pos - left;
    out[i] = samples[left] * (1 - weight) + samples[right] * weight;
  }
  return out;
}

function wavBlobFromPcm() {
  const sourceSamples = mergedPcmSamples();
  const sourceRate = audioProbeSampleRate || 48000;
  if (!sourceSamples || !sourceRate) return null;
  const targetRate = Math.min(16000, sourceRate);
  const samples = resamplePcmSamples(sourceSamples, sourceRate, targetRate);
  const sampleRate = targetRate;
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function hasAudioProbePayload() {
  return audioProbePcmLength > 0 || audioProbeChunks.length > 0;
}

function hasAudioProbeCapture() {
  return Boolean(audioProbeRecorder || audioProbeProcessorNode || audioProbeAudioContext);
}

function startAudioProbe(stream, soundId) {
  stopAudioProbe();
  clearTimeout(audioProbeUploadTimer);
  audioProbeUploadTimer = null;
  if (!stream) {
    addClientEvent('audio_probe_unavailable', '浏览器没有返回麦克风音频流', {}, true);
    finishAudioProbe({ ok: false, error: 'Audio stream unavailable' });
    return;
  }
  resetAudioProbeCaptureBuffers();
  audioProbeStopping = false;
  audioProbeStartedAt = Date.now();
  audioProbeStopAt = 0;
  audioProbeUploadAttempts = 0;
  audioProbeSoundId = soundId;
  const pcmStarted = startPcmAudioProbe(stream, soundId);
  let recorderStarted = false;
  if (window.MediaRecorder) {
    try {
      audioProbeRecorder = new MediaRecorder(stream, audioProbeOptions());
      audioProbeRecorder.ondataavailable = e => {
        if (e.data && e.data.size) {
          audioProbeChunks.push(e.data);
          addClientEvent('audio_probe_final_blob', '浏览器已生成备用完整录音', { bytes: e.data.size, mimeType: e.data.type || 'unknown' });
        }
        if (audioProbeStopping) scheduleAudioProbeUpload(300);
      };
      audioProbeRecorder.onstop = () => {
        audioProbeStopping = true;
        audioProbeStopAt = audioProbeStopAt || Date.now();
        scheduleAudioProbeUpload(600);
      };
      audioProbeRecorder.start();
      recorderStarted = true;
    } catch (e) {
      audioProbeRecorder = null;
      addClientEvent('audio_probe_backup_error', '备用录音采集启动失败', { error: e.message }, true);
    }
  }
  if (!pcmStarted && !recorderStarted) {
    addClientEvent('audio_probe_unavailable', '浏览器不支持可用的录音上报方式', {}, true);
    finishAudioProbe({ ok: false, error: 'Audio recorder unavailable' });
    return;
  }
  try {
    addClientEvent('audio_probe_started', '诊断音频采集中', {
      soundId,
      captureMode: pcmStarted ? 'pcm_wav_final' : 'media_recorder_final_blob',
      backupMode: recorderStarted ? 'media_recorder_final_blob' : '',
      mimeType: audioProbeRecorder?.mimeType || 'audio/wav',
      chunkMode: 'no_timeslice_final_upload',
      sampleRate: audioProbeSampleRate || 0,
      uploadSampleRate: 16000
    }, true);
  } catch (e) {
    addClientEvent('audio_probe_error', '诊断音频采集启动失败', { error: e.message }, true);
    finishAudioProbe({ ok: false, error: e.message });
  }
}

function stopAudioProbe() {
  if (!audioProbeRecorder && !audioProbeProcessorNode && !audioProbeAudioContext) return;
  const recorder = audioProbeRecorder;
  audioProbeRecorder = null;
  audioProbeStopping = true;
  audioProbeStopAt = Date.now();
  stopPcmAudioProbe();
  try {
    const hasPcmPayload = audioProbePcmLength > 0;
    if (recorder && hasPcmPayload) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
      scheduleAudioProbeUpload(80);
    } else if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    } else if (hasAudioProbePayload()) {
      scheduleAudioProbeUpload(120);
    } else {
      scheduleAudioProbeUpload(0);
    }
  } catch (e) {
    addClientEvent('audio_probe_stop_error', '诊断音频停止失败', { error: e.message }, true);
    scheduleAudioProbeUpload(0);
  }
}

function shouldWaitForAudioProbeChunk() {
  if (!audioProbeStopping || hasAudioProbePayload()) return false;
  const elapsedMs = Date.now() - audioProbeStartedAt;
  const sinceStopMs = audioProbeStopAt ? Date.now() - audioProbeStopAt : 0;
  return audioProbeUploadAttempts < 8 && elapsedMs < 15000 && (!audioProbeStopAt || sinceStopMs < 5000);
}

async function uploadAudioProbe() {
  const uploadKey = `audio-upload:${game?.sessionId || 'no-session'}:${audioProbeSoundId}:${audioProbeStartedAt}`;
  if (!beginAction(uploadKey)) return;
  try {
    let blob = wavBlobFromPcm();
    const chunks = blob ? [] : audioProbeChunks.slice();
    if (!blob && !chunks.length && shouldWaitForAudioProbeChunk()) {
      audioProbeUploadAttempts += 1;
      addClientEvent('audio_probe_waiting_for_chunk', '等待浏览器生成最终录音分片', {
        soundId: audioProbeSoundId,
        attempt: audioProbeUploadAttempts,
        durationMs: Date.now() - audioProbeStartedAt,
        sinceStopMs: audioProbeStopAt ? Date.now() - audioProbeStopAt : 0
      });
      scheduleAudioProbeUpload(450);
      return;
    }
    audioProbeChunks = [];
    audioProbePcmChunks = [];
    const pcmLength = audioProbePcmLength;
    const pcmSampleRate = audioProbeSampleRate;
    audioProbePcmLength = 0;
    audioProbeSampleRate = 0;
    audioProbeStopping = false;
    if ((!blob && !chunks.length) || !game || !game.sessionId) {
      const details = { soundId: audioProbeSoundId, durationMs: Date.now() - audioProbeStartedAt };
      addClientEvent('audio_probe_empty', '没有拿到可上报的音频块', details, true);
      releaseAudioOnlyStream(0);
      finishAudioProbe({ ok: false, empty: true, details });
      return;
    }
    if (!blob) blob = new Blob(chunks, { type: chunks[0].type || 'audio/webm' });
    const durationMs = pcmLength && pcmSampleRate ? Math.round(pcmLength / pcmSampleRate * 1000) : Date.now() - audioProbeStartedAt;
    releaseAudioOnlyStream(0);
    const fd = new FormData();
    fd.append('sessionId', game.sessionId);
    fd.append('soundId', audioProbeSoundId);
    fd.append('durationMs', String(durationMs));
    fd.append('sampleRate', blob.type === 'audio/wav' ? '16000' : String(pcmSampleRate || 0));
    fd.append('testMode', TEST_MODE ? '1' : '');
    fd.append('file', blob, `monitor-${Date.now()}${audioFileExtension(blob.type)}`);
    try {
      const r = await fetch('/api/game/audio-check', { method: 'POST', body: fd });
      const x = await r.json();
      if (!r.ok) throw Error(x.error || '音频诊断上报失败');
      addClientEvent('audio_probe_uploaded', x.pending ? '后端返回：已排队后台识别' : (x.transcript ? '后端返回：已识别出文字' : '后端返回：已收到诊断音频'), {
        status: r.status,
        bytes: x.bytes,
        mimeType: x.mimeType,
        captureMode: blob.type === 'audio/wav' ? 'pcm_wav_final' : 'media_recorder_final_blob',
        uploadSampleRate: blob.type === 'audio/wav' ? 16000 : 0,
        audioStatus: x.audioStatus || '',
        audioUsable: x.audioUsable !== false,
        accepted: x.accepted !== false,
        pending: Boolean(x.pending),
        audioAnswerId: x.audioAnswerId || '',
        actualDurationMs: x.actualDurationMs || 0,
        durationLossMs: x.durationLossMs || 0,
        activeMs: x.activeMs || 0,
        transcript: x.transcript || '',
        transcriptionStatus: x.transcriptionStatus || '',
        transcriptionReason: x.transcriptionReason || '',
        transcriptionProvider: x.transcriptionProvider || '',
        transcriptionModel: x.transcriptionModel || '',
        asrDurationMs: x.asrDurationMs || 0
      });
      finishAudioProbe({
        ok: true,
        bytes: x.bytes,
        mimeType: x.mimeType,
        durationMs,
        soundId: x.soundId || audioProbeSoundId,
        accepted: x.accepted !== false,
        pending: Boolean(x.pending),
        audioAnswerId: x.audioAnswerId || '',
        transcript: x.transcript || '',
        transcriptionStatus: x.transcriptionStatus || '',
        transcriptionReason: x.transcriptionReason || '',
        transcriptionProvider: x.transcriptionProvider || '',
        transcriptionModel: x.transcriptionModel || '',
        audioStatus: x.audioStatus || '',
        audioUsable: x.audioUsable !== false,
        actualDurationMs: x.actualDurationMs || 0,
        durationLossMs: x.durationLossMs || 0,
        activeMs: x.activeMs || 0
      });
    } catch (e) {
      if (isMissingStateError(e)) {
        addClientEvent('stale_game_state', '录音上传时发现本轮状态已失效', { error: e.message }, false);
        finishAudioProbe({ ok: false, stale: true, error: e.message });
        return;
      }
      addClientEvent('audio_probe_upload_failed', '诊断音频未能上报后端', { error: e.message }, true);
      finishAudioProbe({ ok: false, error: e.message });
    }
  } finally {
    endAction(uploadKey);
  }
}

async function startAudioOnlyRecording() {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    suggestTextAnswer(window.isSecureContext ? '当前浏览器不支持麦克风语音输入' : secureMicHelpMessage());
    playFeedbackTone('fail');
    return;
  }
  pauseQuestionAudioForRecording();
  clearTimeout(audioOnlyStreamReleaseTimer);
  audioOnlyStreamReleaseTimer = null;
  startingRecord = true;
  finishingRecord = false;
  setRecordButton('正在打开麦克风…');
  try {
    audioOnlyStream = await getSystemDefaultMicStream();
    audioOnlyMode = true;
    addClientEvent('mic_opened', '浏览器已打开系统默认麦克风', micDetails(audioOnlyStream), true);
    audioProbeFinishHandler = finishAudioOnlyCapture;
    startAudioProbe(audioOnlyStream, game.questions[index].id);
    if (!hasAudioProbeCapture()) return;
    recording = true;
    markRecordStarted();
    startingRecord = false;
    setRecordButton('我说完了');
    addClientEvent('record_started', '用户录音已开始', { ...currentQuestionContext(), maxDurationMs: autoRecordMs() }, true);
    clearTimeout(recordAutoStopTimer);
    recordAutoStopTimer = setTimeout(() => {
      addClientEvent('record_auto_stopped', '录音超过 5 秒，自动结束', currentQuestionContext(), true);
      stopAudioOnlyRecording({ waitForUpload: true, reason: 'timeout' });
    }, autoRecordMs());
  } catch (e) {
    handleMicError(e);
  }
}

function finishAudioOnlyCapture(result) {
  resetRecordButton();
  if (result && result.stale) {
    playFeedbackTone('fail');
    recoverStaleGameState('本轮已失效，请重新开始挑战');
    return;
  }
  const currentSoundId = game?.questions?.[index]?.id || '';
  if (result?.soundId && currentSoundId && result.soundId !== currentSoundId) {
    addClientEvent('audio_only_stale_ignored', '忽略过期的录音识别结果', { resultSoundId: result.soundId, currentSoundId }, true);
    return;
  }
  if (result && result.ok && result.audioUsable === false) {
    playFeedbackTone('fail');
    const message = result.audioStatus === 'no_speech'
      ? '没有录到清楚的声音，请再试一次'
      : result.audioStatus === 'incomplete'
        ? '录音可能不完整，请再试一次'
        : '录音质量不稳定，请再试一次';
    suggestTextAnswer(message);
    addClientEvent('audio_only_retry_required', '录音不可用于自动判题，等待用户重试', {
      soundId: result.soundId || currentSoundId,
      audioStatus: result.audioStatus || '',
      actualDurationMs: result.actualDurationMs || 0,
      durationMs: result.durationMs || 0,
      durationLossMs: result.durationLossMs || 0,
      activeMs: result.activeMs || 0,
      transcript: result.transcript || '',
      transcriptionStatus: result.transcriptionStatus || '',
      transcriptionReason: result.transcriptionReason || ''
    }, true);
  } else if (result && result.ok && result.accepted !== false && result.pending) {
    playFeedbackTone('end');
    addClientEvent('audio_only_queued', '录音已通过检查，后台识别中', {
      soundId: result.soundId || currentSoundId,
      audioAnswerId: result.audioAnswerId || '',
      durationMs: result.durationMs,
      audioStatus: result.audioStatus || '',
      actualDurationMs: result.actualDurationMs || 0,
      activeMs: result.activeMs || 0
    }, true);
    goNext().catch(e => {
      toast(e.message || '进入下一题失败，请再试一次');
    });
  } else if (result && result.ok && result.transcript) {
    playFeedbackTone('end');
    addClientEvent('audio_only_transcribed', '录音已转成文字，准备提交判断', { transcript: result.transcript, durationMs: result.durationMs }, true);
    submit(result.transcript, 'media_recorder', result.soundId || currentSoundId);
  } else if (result && result.ok) {
    playFeedbackTone('fail');
    suggestTextAnswer(result.transcriptionReason || '没识别到文字，请再试一次');
    addClientEvent('audio_only_received', '录音已收到，但没有得到文字结果', {
      bytes: result.bytes,
      durationMs: result.durationMs,
      audioStatus: result.audioStatus || '',
      transcriptionStatus: result.transcriptionStatus || '',
      transcriptionReason: result.transcriptionReason || ''
    }, true);
  } else {
    playFeedbackTone('fail');
    suggestTextAnswer('没有收到声音，请再试一次');
    addClientEvent('audio_only_missing', '录音结束但未收到可用音频', result || {}, true);
  }
}

function stopAudioOnlyRecording(options = {}) {
  if (!audioOnlyMode && !audioOnlyStream) return false;
  clearRecordStopTimer();
  stopAudioProbe();
  recording = false;
  startingRecord = false;
  finishingRecord = Boolean(options.waitForUpload);
  recordStartedAt = 0;
  if (options.waitForUpload) {
    releaseAudioOnlyStream(2500);
    setRecordButton(options.reason === 'timeout' ? '已到 5 秒，正在上传…' : '正在上传…');
    return true;
  }
  releaseAudioOnlyStream(0);
  resetRecordButton();
  suggestTextAnswer('录音已结束，当前浏览器不支持语音转文字');
  addClientEvent('audio_only_done', '录音结束，但浏览器不支持语音转文字', {}, true);
  return true;
}

function bindRecordEvents() {
  const button = $('#record');
  if (!button) return;
  ['contextmenu', 'selectstart', 'dragstart'].forEach(type => {
    button.addEventListener(type, e => e.preventDefault());
  });
  button.addEventListener('click', e => {
    e.preventDefault();
    startRecordInteraction(e);
  });
}

async function goNext() {
  const actionKey = `go-next:${game?.sessionId || 'no-session'}`;
  if (!beginAction(actionKey, 850)) return;
  try {
    if (++index < game.questions.length) {
      show('#quiz');
      renderQuestion();
    } else {
      await result();
    }
  } finally {
    endAction(actionKey);
  }
}

async function result() {
  const actionKey = `round-result:${game?.sessionId || 'no-session'}`;
  if (!beginAction(actionKey, 1200)) return null;
  try {
    toast('正在整理本轮成绩...');
    const r = await api('/api/game/result/' + game.sessionId);
    addClientEvent('result_response', '前端已收到结算结果', { accuracy: r.accuracy, correct: r.correct }, true);
    trackAnalytics('round_complete', {
      durationMs: roundStartedAt ? Date.now() - roundStartedAt : 0,
      correct: r.correct,
      total: r.total,
      accuracy: r.accuracy,
      playthrough: r.playthrough,
      libraryAnswered: r.libraryAnswered,
      libraryTotal: r.libraryTotal,
      libraryCompletionPending: Boolean(r.libraryCompletionPending)
    });
    pendingCompleteResult = r.libraryCompletionPending ? r : null;
    renderResultProfile('summary', resultProfileForAccuracy(r.accuracy));
    $('#score').innerHTML = `${r.accuracy}<small>%</small>`;
    $('#correctNum').textContent = `${r.correct} / ${r.total}`;
    renderAnswerReview('#answerReview', r.answerReview);
    renderRanking('#ranking', r.ranking, { currentUser: r.user, limit: 5 });
    show('#summary');
    return r;
  } finally {
    endAction(actionKey);
  }
}

function renderCompleteResult(r) {
  renderResultProfile('complete', RESULT_PROFILES.complete);
  $('#finishRank').textContent = '你已加入完成全部挑战的侦探名单';
  $('#finishText').textContent = `题库完成 ${r.libraryAnswered} / ${r.libraryTotal}，本轮猜中 ${r.correct} / ${r.total} 题`;
  renderAnswerReview('#completeAnswerReview', r.answerReview);
  renderCompleteRanking('#completeRanking', r.completeRanking, r.user || user);
}

async function showPendingCompleteResult() {
  const r = pendingCompleteResult;
  if (!r) {
    await startGame();
    return;
  }
  const actionKey = `complete-shown:${user?.id || 'anonymous'}:${r.completionSessionId || game.sessionId}`;
  if (!beginAction(actionKey, 1800, '正在打开完成页，请稍候')) return;
  try {
    let saved;
    try {
      saved = await api('/api/game/complete-shown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id,
          sessionId: r.completionSessionId || game.sessionId,
          playthrough: r.playthrough,
          testMode: TEST_MODE
        })
      });
    } catch (e) {
      if (isMissingStateError(e)) {
        recoverStaleGameState('挑战记录已更新，请重新开始');
        return;
      }
      throw e;
    }
    if (saved.user) user = saved.user;
    const completeResult = {
      ...r,
      user: saved.user || r.user || user,
      completeRanking: saved.completeRanking || r.completeRanking || []
    };
    pendingCompleteResult = null;
    renderCompleteResult(completeResult);
    trackAnalytics('library_complete', {
      durationMs: libraryStartedAt ? Date.now() - libraryStartedAt : 0,
      playthrough: r.playthrough,
      libraryAnswered: r.libraryAnswered,
      libraryTotal: r.libraryTotal,
      correct: r.correct,
      total: r.total
    });
    libraryStartedAt = Date.now();
    storageSet('libraryStartedAt', String(libraryStartedAt));
    show('#complete');
  } finally {
    endAction(actionKey);
  }
}

async function handleAgain(button = null) {
  if (!beginAction('again-button', 1800, '正在进入下一轮，请稍候')) return;
  setButtonBusy(button, true, '正在进入...');
  try {
    if (pendingCompleteResult) {
      await showPendingCompleteResult();
      return;
    }
    await startGame();
  } catch (e) {
    toast(e.message || '进入下一轮失败，请再试一次');
  } finally {
    setButtonBusy(button, false);
    endAction('again-button');
  }
}

function bindUiEvents() {
  const changelogOpen = $('#changelogOpen');
  const changelogClose = $('#changelogClose');
  const changelogBackdrop = $('#changelogBackdrop');
  const historyOpen = $('#historyOpen');
  const historyClose = $('#historyClose');
  const historyBackdrop = $('#historyBackdrop');
  const replay = $('#replay');
  const modeSwitch = $('#switch');
  const submitText = $('#submitText');
  const answerText = $('#answerText');
  const next = $('#next');
  const again = $('#again');
  const completeAgain = $('#completeAgain');

  if (changelogOpen) changelogOpen.onclick = () => {
    if (noteAction('changelog-toggle', 250)) setChangelogOpen(true);
  };
  if (changelogClose) changelogClose.onclick = () => setChangelogOpen(false);
  if (changelogBackdrop) changelogBackdrop.onclick = () => setChangelogOpen(false);
  if (historyOpen) historyOpen.onclick = e => {
    e.preventDefault();
    openHistory(e.currentTarget);
  };
  if (historyClose) historyClose.onclick = () => setHistoryOpen(false);
  if (historyBackdrop) historyBackdrop.onclick = () => setHistoryOpen(false);
  $$('[data-share]').forEach(x => x.onclick = e => {
    e.preventDefault();
    share(e.currentTarget);
  });
  bindStartEvents();
  bindRecordEvents();
  if (replay) replay.onclick = e => {
    e.preventDefault();
    play(game?.questions?.[index], { manual: true, force: true });
  };
  if (modeSwitch) modeSwitch.onclick = () => {
    if (noteAction('text-mode', 500)) showTextAnswer('', true);
  };
  if (submitText) submitText.onclick = e => {
    e.preventDefault();
    submit($('#answerText').value);
  };
  if (answerText) {
    answerText.onkeydown = e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit(e.target.value);
      }
    };
  }
  if (next) next.onclick = e => {
    e.preventDefault();
    goNext();
  };
  if (again) again.onclick = e => {
    e.preventDefault();
    handleAgain(e.currentTarget);
  };
  if (completeAgain) completeAgain.onclick = e => {
    e.preventDefault();
    runAction(`complete-again:${user?.id || deviceId || 'anonymous'}`, () => startGame(), {
      cooldownMs: 1800,
      button: e.currentTarget,
      busyText: '正在进入...',
      message: '正在进入下一轮，请稍候'
    });
  };
}

function init() {
  try {
    deviceId = getDeviceId();
    applyRememberedIdentity();
    trackAnalytics('page_load', { referrer: document.referrer || '', title: document.title || '' });
    renderChangelog();
    bindUiEvents();
    loadRememberedUser();
  } catch (e) {
    showStartupError(e);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
