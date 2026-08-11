# MiniMax ASR 对比工具

这个工具只用于诊断，不会改游戏的默认 ASR 链路。它读取 `data/asr-recordings` 里保留的一周用户音频，调用你配置的 MiniMax ASR 接口，把 MiniMax 转写和当前 SenseVoice 转写放在同一份 JSON 报告里。

## 配置

在 `.env` 里补充：

```bash
MINIMAX_API_KEY=你的 MiniMax key
MINIMAX_ASR_ENDPOINT=你拿到的 MiniMax ASR endpoint
MINIMAX_ASR_MODEL=你的 MiniMax ASR 模型名
MINIMAX_ASR_MODE=multipart
MINIMAX_ASR_LANGUAGE=zh
```

如果你的 MiniMax ASR 接口不是 multipart 上传，而是 JSON/base64 音频，把 `MINIMAX_ASR_MODE` 改成：

```bash
MINIMAX_ASR_MODE=json-base64
```

## 使用

先验证 key 是否能访问 MiniMax OpenAI-compatible 模型列表：

```bash
node tools/asr-compare-minimax.js --list-models
```

跑最近保留的全部音频：

```bash
node tools/asr-compare-minimax.js
```

只跑最近 5 条：

```bash
node tools/asr-compare-minimax.js --limit 5
```

报告会写到 `data/asr-comparisons/minimax-*.json`。这个目录已加入 `.gitignore`，避免把用户音频诊断结果提交出去。
