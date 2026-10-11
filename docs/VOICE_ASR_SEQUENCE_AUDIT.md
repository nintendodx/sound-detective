# 语音答题统一时序与代码审计

适用范围：说颜色、声音侦探、中华小曲库。三款游戏通过同一份 `shared/voice-asr-client.js` 处理浏览器采集、字幕、VAD、重试和提交；云端由各自 Pages Worker 负责会话校验、ASR 代理和判题接口。

## 总体时序

```mermaid
sequenceDiagram
    autonumber
    actor U as 用户
    participant P as 游戏页面
    participant C as 共享 ASR 客户端
    participant M as 麦克风/AudioContext
    participant E as Cloudflare Pages Worker
    participant A as 上游 ASR 服务
    participant J as 答题判定接口

    U->>P: 打开游戏首页
    P->>E: GET /api/asr/config
    E-->>P: 供应商配置、传输方式
    P->>E: GET /api/asr/health
    E->>A: 健康探测
    A-->>E: 可用性与延时
    E-->>P: 可用供应商列表
    U->>P: 输入/确认用户名并开始一轮
    P->>E: POST /api/game/start
    E-->>P: sessionId、题目、asrProvider、asrTicket
    P->>C: enterQuestion(第 N 题)
    C->>M: getUserMedia + AudioContext 预热
    M-->>C: 麦克风权限与可用音轨
    P->>P: 播放题目音频
    alt 用户点击“我猜到了”
        U->>P: 点击跳过播放
        P->>C: startPrepared(第 N 题, delay=0)
    else 音频自然结束
        P->>C: startPrepared(第 N 题, delay=220ms)
    end
    C->>M: 建立 PCM/MediaRecorder 采集
    M-->>P: 已开始真实收音
    P-->>U: 立即显示“请回答/正在听你说”
    C->>E: WebSocket /ws/asr + START(sessionId, questionId, ticket)
    E->>A: 建立供应商连接并发送 START
    A-->>E: READY
    E-->>C: ASR_READY
    C-->>U: 更新为识别连接已就绪
    loop 用户说话
        M-->>C: PCM 音频帧
        C->>E: 音频帧
        E->>A: 音频帧
        A-->>E: PARTIAL/中间字幕
        E-->>C: ASR_PARTIAL
        C-->>U: 尽快刷新 ASR 字幕
    end
    alt 最终字幕到达
        A-->>E: FINAL/FIN_TEXT
        E-->>C: ASR_FINAL
        C-->>U: 显示最终字幕并自动结束采集
    else 用户点击结束或 VAD 静音结束
        U->>P: 点击结束回答
        P->>C: stop()
        C->>E: FINISH
        E->>A: FINISH/end
        A-->>E: FINAL 或结束结果
        E-->>C: ASR_FINAL/ASR_ENDED
    end
    C->>J: POST /api/game/answer-text(transcript)
    J-->>C: 判题结果、幂等结果
    C-->>P: answer_response
    P->>P: 反馈音、记录结果、切到下一题
```

## 状态约束

```mermaid
stateDiagram-v2
    [*] --> QuestionReady: 题目渲染 / 麦克风预热
    QuestionReady --> Playing: 音频开始播放
    Playing --> CaptureStarting: 音频结束
    Playing --> CaptureStarting: 点击“我猜到了”
    CaptureStarting --> Listening: 采集节点已建立
    Listening --> Listening: ASR_PARTIAL / 字幕刷新
    Listening --> Submitting: ASR_FINAL / 用户结束 / VAD 静音
    Submitting --> Listening: 提交失败且允许重试
    Submitting --> QuestionReady: 判题成功并进入下一题
    Listening --> Error: 麦克风、连接或 ASR 错误
    Error --> CaptureStarting: 用户重新回答
    Error --> [*]: 返回首页
```

## 时序审计

| 要求 | 当前实现 | 结论 |
| --- | --- | --- |
| 网络延时如实反映 | 收音节点建立后立即显示听取状态；ASR 仍连接时显示“识别连接中”；连接超时才进入错误 | 已对齐 |
| 后台提前请求但不过早 | 首页先读取配置/健康；进入题目页预热麦克风；跳过播放才零延迟建 ASR 连接；自然播放结束保留 220ms 启动缓冲 | 合理，未提前打开题目 ASR 长连接 |
| 重复点击 | 页面 action lock、客户端 `starting/recording/uploading` 门闩、`captureToken` 和服务端答题 request guard 共同防重 | 已对齐 |
| 快速说话 | 320ms onset guard，避免播放尾音/连接瞬态被当成答案 | 已对齐 |
| 慢速说话 | ASR 服务端 VAD 约 1800ms；百度本地 VAD 已统一为 1600ms，降低切断较长停顿的风险 | 已对齐，仍需用真实语料持续校准 |
| 字幕速度 | `ASR_PARTIAL` 到达即刷新 DOM，最终字幕覆盖中间字幕 | 已对齐 |
| 结束时的网络延迟 | 原来停止后仅等待 600ms，可能取消尚未 READY 的百度连接 | 已修复：等待窗口绑定供应商连接超时，至少 1200ms |
| 上游迟到错误 | 已有最终字幕时忽略迟到错误；百度结束/关闭时用最后中间字幕兜底 | 已对齐 |

## 代码检查结论

- 三款游戏的浏览器共享模块必须由“说颜色”的 `shared/` 作为源同步
- `enterQuestion()` 负责麦克风预热，不能在题目播放结束后才请求权限
- `start()` 的“收音状态”以 `startPcmCapture()` 成功为准，不以 ASR_READY 为准
- `ASR_READY` 只表示云端识别通道已就绪，不能延迟页面显示真实收音状态
- `captureToken` 防止旧题目的 PCM、WebSocket 回调覆盖当前题目
- 非空最终字幕必须优先于迟到的 `ASR_ERROR`
- 服务端必须保留 `sessionId + questionId` 校验和答题幂等，不能只依赖前端状态

## 本次代码变更

- `finishRealtime()` 的连接等待由固定 600ms 改为供应商连接超时加缓冲
- 采集节点建立后立即显示“正在听你说，识别连接中”
- 百度代理在空 `FIN_TEXT` 或提前关闭时使用最后中间字幕
- “我猜到了”路径以 0ms 延迟进入收音阶段
- 本地静音 VAD 从 1300ms 调整为 1600ms，服务端 VAD 保持约 1800ms
