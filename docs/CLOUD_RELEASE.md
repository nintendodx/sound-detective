# 声音侦探云端发布流程

这个项目现在保留两种运行方式：

- 本地开发：`npm start`，继续读写 `data/store.json` 和 `uploads/`。
- 云端生产：Netlify 静态站点 + Netlify Functions + Netlify Blobs + 百度 ASR。

## 一次性准备

1. 创建私有 GitHub 仓库，建议仓库名使用 `sound-detective`。
2. 创建 Netlify 项目，免费域名建议使用 `sound-detective.netlify.app`；如果名称被占用，换成 `dx100-sound-detective`。
3. 在 Netlify 项目环境变量里设置：

```bash
DX100_STORAGE=netlify-blobs
DX100_BLOBS_STORE=dx100-sound-game
STT_PROVIDER=baidu
BAIDU_API_KEY=你的百度 API Key
BAIDU_SECRET_KEY=你的百度 Secret Key
BAIDU_ASR_ENDPOINT=https://vop.baidu.com/pro_api
BAIDU_ASR_DEV_PID=80001
BAIDU_ASR_FORMAT=pcm
BAIDU_ASR_RATE=16000
BAIDU_ASR_CUID=voice-detective-cloud
ADMIN_SECRET_PATH=/一段只有你知道的后台路径
ADMIN_TOKEN=一段足够长的随机口令
```

本地执行发布脚本时，还需要在本机 `.env.cloud` 或 shell 里设置：

```bash
NETLIFY_SITE_ID=你的 Netlify site id
NETLIFY_AUTH_TOKEN=你的 Netlify personal access token
```

## 日常发版

本地照常修改并验证：

```bash
npm start
```

验证通过后发布预览版：

```bash
npm run release:preview
```

确认预览没问题后发布生产：

```bash
npm run release:cloud
```

发布脚本会执行：

1. `npm run check`
2. `npm run build:netlify`
3. 同步 `data/store.json`、`uploads/`、`图片文件/` 到 Netlify Blobs
4. 部署到 Netlify
5. 在 `data/releases/` 写入本次发布记录

## 数据同步

只把本地数据和素材推到云端：

```bash
npm run cloud:push
```

从云端拉回本地备份：

```bash
npm run cloud:pull
```

查看云端 Blobs 里已有内容：

```bash
npm run cloud:list
```

## 后台入口

公网不会开放 `/admin.html`。后台入口由 `ADMIN_SECRET_PATH` 控制，例如：

```text
https://你的站点.netlify.app/一段只有你知道的后台路径
```

第一次打开这个地址时，服务端会写入一个仅后台 API 使用的 cookie。之后后台页面内部可以正常跳转，但没有这个 cookie 的访问会返回 404。
