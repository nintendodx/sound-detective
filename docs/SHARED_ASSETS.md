# H5 和 Agent 共享素材

唯一素材目录：`/Users/daixin/Documents/Development/assets/shared/sound-detective`。

这个目录是当前开发机的共享工作区，不提交到 GitHub。仓库中的 `uploads`、`图片文件`、`声音文件` 可能是指向它的本机链接，这些绝对路径链接也不会进入 Git。新检出环境需要素材时，通过 `npm run cloudflare:pull` 从已授权的 Cloudflare 存储恢复，或在同一 Development 目录结构下重新建立共享素材目录；公开仓库本身不包含用户数据和运行素材。

- `audio/`：正式声音素材。
- `images/`：H5 原有图片素材。
- `legacy-generated/`：旧 Agent 的四份程序生成 WAV，仅保留作历史测试素材。
- H5 原 `uploads`、`声音文件` 都是 `audio/` 的链接；原 `图片文件` 是 `images/` 的链接。
- Agent 原 `assets/sounds` 也是同一 `audio/` 的链接，没有额外维护的一份音频。

## 平时如何增删

通过现有 H5 管理后台上传、命名、启用或删除题目。H5 的题库记录仍是唯一来源：
本地候选源码使用 `/Users/daixin/Documents/Development/projects/games/sound-detective/app/data/store.json`；线上权威数据位于统一游戏管理后台的 Cloudflare KV。

Agent 每次新开游戏或从聊天进入游戏时重新读取该题库，只采用启用且音频文件仍存在的题目，并从共享题库随机抽取最多四题，保留原来的四轮玩法。旧会话保留自己的题目顺序，避免一次修改使进行中的判题错位。正在被旧会话播放的音频不宜立即物理删除。

只把一个新文件拖入音频目录还不等于新增题目：仍要在 H5 管理后台填写题名。此处共用素材和题库，不把图片、录音、用户数据混成一道题。

Agent 可以用 `ASSETS_DIR` 覆盖素材路径、`SOUND_CATALOG_FILE` 覆盖题库来源；默认值适用于现有原目录。

## 发布

本地两个进程实时使用同一套文件。线上部署是独立环境，不会自动跟随 Mac 文件变化。

- H5 沿用现有发布流程，读取原路径的兼容链接。已发布的云端题库修改需要按现有流程同步到本地后，才会反映到本地 Agent。
- Agent 执行 `make assets` / `make build`，自动从共享库准备 `dist/assets`。只导出题目必要字段和音频，不复制 H5 用户、录音、统计或凭证。
- Linux 容器使用 `make build-linux`，Dockerfile 从 `dist/assets` 读取完整素材包。打包产物允许各自包含素材，但不要手工编辑。
- `cmd/assetgen` 现在只写入 `testdata/generated-sounds`，不会覆盖正式素材库；`make run` 不再生成测试声音。

H5 的生产语音链路只使用腾讯实时语音识别浏览器直连，后端仅签发短时地址。Agent 可以继续使用自身适合的 ASR/TTS 提供方，但题目结构、答案规则和判题结果应复用 H5 的共享 Agent 契约；真实凭证沿用各自安全配置，不写入本说明。

H5 发布前只需确认发布配置列出的三项腾讯 ASR 密钥可用。Agent 的火山语音配置与 H5 发布相互独立；本说明不会创建、改写或同步任何远端 Secret。
