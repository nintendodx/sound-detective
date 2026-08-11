# DX100 声音游戏

一个无需数据库和第三方依赖的本机服务原型。数据保存在 `data/store.json`，上传音频保存在 `uploads/`。

## 启动

```bash
npm start
```

- 游戏：`http://localhost:3000`
- 管理后台：`http://localhost:3000/admin.html`

首次启动会创建 5 道可直接演示的合成音效题；可在后台上传真实音频、编辑标签、启用或失效。

## 服务端语音转文字配置

iOS Safari 不支持浏览器自带的 Web Speech API，本项目会把手机录到的声音传回本机服务端，再由服务端调用语音转文字服务。API Key 只放在服务端，不会发到浏览器。

1. 复制 `.env.example` 为 `.env`。
2. 将 `.env` 里的语音转文字 API Key 改成你自己的 key。
3. 重启 `npm start` 服务。

```bash
cp .env.example .env
```

推荐给本地 demo 使用本地 whisper.cpp，不走任何公网 API。项目会优先检测本地模型；模型存在时，即使 `.env` 里还留着旧 API Key，也默认走本地识别。

```bash
STT_PROVIDER=local
LOCAL_WHISPER_BIN=tools/whisper-local/ggml-org-whisper.cpp-0b9af32/main
LOCAL_WHISPER_MODEL=tools/whisper-local/models/ggml-base-q5_1.bin
LOCAL_WHISPER_LANGUAGE=zh
LOCAL_WHISPER_THREADS=4
```

备用方案：Groq Whisper，不走 OpenAI API，但需要 Groq Key：

```bash
STT_PROVIDER=groq
GROQ_API_KEY=gsk-你的GroqKey
GROQ_TRANSCRIBE_MODEL=whisper-large-v3-turbo
STT_LANGUAGE=zh
```

也可以继续使用 OpenAI：

```bash
STT_PROVIDER=openai
OPENAI_API_KEY=sk-你的OpenAIKey
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
STT_LANGUAGE=zh
```

## 互联网访问

路由器已做端口映射时，可将 3000 端口映射到这台电脑。更推荐使用 Cloudflare Tunnel：安装 `cloudflared` 后运行 `cloudflared tunnel --url http://localhost:3000`，它会输出一个可分享的 HTTPS 链接。生产使用前请配置固定域名、备份 `data/` 与 `uploads/`，并在反向代理处开启 HTTPS。

## 云端发布

项目支持本地开发、云端发布的双运行方式。云端使用 Netlify 免费域名、Netlify Functions、Netlify Blobs 和百度 ASR；本地仍然保留 `npm start` 的文件读写模式。发布和数据同步流程见 [`docs/CLOUD_RELEASE.md`](docs/CLOUD_RELEASE.md)。

## 语音识别与判题

支持浏览器 Web Speech API 时，答题页会录音并自动转写；不支持时用户可切换到文字输入。服务端的默认判题使用标签、同义词和文本相似度，便于零配置演示。`judgeAnswer` 是后续接入语音转写与大模型判题的唯一替换点；接入时应只传入题目标签和用户转写文本，不要把正确答案直接展示给模型。

判题阶段使用本地轻量语义匹配，不再调用远程大模型：会过滤“这是/好像/声音”等描述词，折叠重复短语，匹配声音名称、标签和内置意图词库，通常在毫秒级完成。
