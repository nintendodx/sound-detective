# 声音侦探运维与恢复

## 架构

正式站点为 `https://sound-detective.pages.dev`，使用 Cloudflare Pages Direct Upload：

- 静态页面由 Pages Assets 提供。
- 游戏 API、实时 ASR WebSocket 和媒体路由由 Pages `_worker.js` 直接处理。
- 游戏数据写入 `SOUND_DETECTIVE_DATA` KV，共用后台数据绑定 `ADMIN_HUB_DATA`。
- 声音和图片优先读取 `ADMIN_HUB_ASSETS` R2，并保留 KV 资源回退。
- Admin 后台独立部署；游戏不依赖任何单独的 Worker Service Binding。

GitHub 只作为可选的私有源码备份。Cloudflare Pages 项目使用 Wrangler Direct Upload，不连接 Git Provider，因此玩家访问和日常发布都不依赖 GitHub。

## 本地开发

```bash
npm install
npm start
```

本地地址：`http://127.0.0.1:3000`。

## 正式发布

`.env.cloud` 需要配置百度、腾讯和豆包的七项 ASR 凭证。凭证只同步到 Cloudflare Pages Secrets，不进入源码或 Git。

```bash
npm run release
```

发布脚本依次执行语法检查、Pages 构建、Secrets 同步、Direct Upload，以及可选的数据与素材同步，并在 `data/releases/` 写入发布记录。

只更新代码，保留线上数据、素材和 Secrets：

```bash
npm run release -- --no-data --no-assets --no-secrets
```

单独同步 Secrets：

```bash
npm run cloudflare:secrets
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

拉取 `store.json` 前，脚本会为现有本地文件创建带时间戳的备份。建议定期执行，并将代码提交到本地 Git；GitHub 私有远程只承担异地源码备份。

## 灾难恢复

1. 从本地 Git 或 GitHub 私有备份恢复代码。
2. 恢复 `.env.cloud`，执行 `npm install`。
3. 使用 `npm run cloudflare:push` 恢复数据与素材。
4. 使用 `npm run release` 重建并发布 Pages。
5. 请求 `/api/asr/health?force=1`，确认可用 ASR 服务进入随机分配。

Cloudflare Pages 保留历史部署，可在新版本异常时立即回滚上一版本。GitHub 不参与玩家请求链路，因此大陆地区的 GitHub 网络波动不会影响已发布游戏。
