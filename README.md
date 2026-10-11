# 声音侦探

声音侦探是一个使用语音回答日常声音题目的 H5 游戏。当前候选版本为 `0.3.8-20261009`。

## 本地运行

```bash
npm start
```

本地服务默认监听 `3000` 端口。题库、用户和历史成绩保存在 `data/store.json`；声音素材由统一游戏管理后台维护。

## 语音架构

- 生产环境只使用腾讯实时语音识别 2.0
- 浏览器采集 16kHz、16-bit、单声道 PCM，并按 200ms 节奏直接发送给腾讯 WebSocket
- 后端只生成短时签名地址，不接收或中转答题音频
- 麦克风生命周期、重采样、VAD、实时字幕、重试和诊断事件来自三款游戏共用的共享模块
- 判题统一使用共享答案契约，支持题目标签、别名、语义意图和保守近似匹配
- 题目、判题结果和语音时序可以通过共享 Agent 契约复用

共享源码位于游戏公共服务工程的 `shared/` 目录，通过 `npm run sync:asr` 同步到本项目。不要在本项目单独修改同步生成的共享文件。

## 检查与构建

```bash
npm run check
npm run build:pages
npm run release:validate
```

`release:validate` 只执行共享文件同步、检查和 Pages 构建，不部署、不上传数据，也不修改 Cloudflare 密钥。

## 从 GitHub 恢复

GitHub 仓库只保存源码、锁文件、配置模板、共享语音模块快照和发布记录，不保存用户数据、答题事件、凭据或本机绝对路径链接。

```bash
git clone https://github.com/nintendodx/sound-detective.git
cd sound-detective
npm ci
npm run check
npm run build:pages
```

以上步骤可以在不连接生产服务的情况下恢复并验证必要构建输入。本地题库和用户数据位于 `data/store.json`，声音与结果图片位于 Cloudflare R2；需要恢复运行数据或素材时，按 [`docs/CLOUD_RELEASE.md`](docs/CLOUD_RELEASE.md) 的灾难恢复步骤显式拉取。不要把这些活数据重新提交到公开仓库。

## Cloudflare 发布

正式环境使用 Cloudflare Pages Direct Upload，静态页面、游戏 API、短时签名接口、KV 和 R2 由同一个 Pages 项目承载，不依赖 GitHub 在线构建或单独的游戏 Worker。统一管理后台由 `https://admin.stardream.studio/` 提供。

发布、备份与恢复流程见 [`docs/CLOUD_RELEASE.md`](docs/CLOUD_RELEASE.md)。生产发布必须在本地验收通过并获得明确授权后执行。
