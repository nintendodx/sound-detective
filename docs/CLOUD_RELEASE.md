# 声音侦探运维与恢复

## 架构

正式站点为 `https://stardream.studio/games/sound/`，使用 Cloudflare Pages Direct Upload：

- 静态页面由 Pages Assets 提供。
- 游戏 API、实时 ASR WebSocket 和媒体路由由 Pages `_worker.js` 直接处理。
- 游戏数据写入 `SOUND_DETECTIVE_DATA` KV，共用后台数据绑定 `ADMIN_HUB_DATA`。
- 声音和图片优先读取 `ADMIN_HUB_ASSETS` R2，并保留 KV 资源回退。
- 管理功能统一由 `https://admin.stardream.studio/` 提供；本项目不包含独立后台页面或 `/api/admin/*` 接口。
- 游戏不依赖任何单独的 Worker Service Binding。

GitHub 只作为可选的公共源码备份。Cloudflare Pages 项目使用 Wrangler Direct Upload，不连接 Git Provider，因此玩家访问和日常发布都不依赖 GitHub。

## 本地开发

```bash
npm install
npm start
```

本地地址：`http://127.0.0.1:3000`。

## 正式发布

三款语音游戏统一使用腾讯实时语音识别。发布配置从受保护的共享环境文件读取三项腾讯凭据，也可用 `VOICE_GAME_ENV_FILE` 显式覆盖；凭据只同步到 Cloudflare Pages Secrets，不进入源码或 Git。

```bash
npm run release
```

发布脚本依次执行共享模块同步、自动检查、Pages 构建、可选 Secrets 同步和 Direct Upload，并在 `data/releases/` 写入发布记录。生产游戏数据不属于发布流程，代码发布不会覆盖历史记录。

只更新代码，保留线上数据、素材和 Secrets：

```bash
npm run release
```

单独同步 Secrets：

```bash
npm run cloudflare:secrets
```

需要同步声音和图片素材时显式执行：

```bash
npm run cloudflare:push:assets
```

## 数据备份

查看云端 KV：

```bash
npm run cloudflare:list
```

拉取云端数据和素材到本地：

```bash
npm run cloudflare:pull
```

拉取 `store.json` 前，脚本会为现有本地文件创建带时间戳的备份。建议定期执行，并将代码提交到本地 Git；GitHub 公共远程只承担异地源码备份。

恢复生产数据是独立的灾难恢复操作，不会被发布脚本调用。只有已确认本地 `data/store.json` 是要恢复的权威备份时，才执行：

```bash
npm run cloudflare:restore:data
```

## 灾难恢复

1. 从本地 Git 或 GitHub 公共备份恢复代码。
2. 配置受保护的共享环境文件或 `VOICE_GAME_ENV_FILE`，执行 `npm install`。
3. 使用 `npm run cloudflare:restore:data` 恢复已核验的数据备份，再使用 `npm run cloudflare:push:assets` 恢复素材。
4. 使用 `npm run release` 重建并发布 Pages。
5. 请求 `/api/asr/health?force=1`，确认腾讯实时语音服务可用。

Cloudflare Pages 保留历史部署，可在新版本异常时立即回滚上一版本。GitHub 不参与玩家请求链路，因此大陆地区的 GitHub 网络波动不会影响已发布游戏。
