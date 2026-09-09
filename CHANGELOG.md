# 更新日志

本文件记录 TRTC-ASR Node.js SDK 的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增

- 新增 v3 协议客户端，位于独立命名空间 `v3`（`import { v3 } from "trtc-asr"`），与 v2/v1 客户端（包顶层导出）完全解耦，两者可独立选用、互不影响：
  - `v3.SpeechRecognizer`：WebSocket `/asr/v3`，URL 仅携带 `voice_id`，鉴权与识别参数通过首帧 JSON（`{"type":"start","auth":{...},"params":{...}}`）下发；`start()` 同步等待服务端 ack，鉴权失败（4002）/参数非法（4001）等错误同步抛出
  - `v3.SentenceRecognizer`：`POST /v3/transcribe`，body 为 `{auth, params}` 分块，请求/响应均为 snake_case 扁平结构（无 `Response` 外壳）
  - `v3.FileRecognizer`：`POST /v3/create_transcription` + `/v3/describe_transcription`，任务 ID 为 `transcription_id`（与 v1 `RecTaskId` 不通用）
  - `v3.newCredential(sdkAppId, secretKey)`：v3 不再需要腾讯云 AppID
  - 服务端数字错误码（4xxx/5xxx）直接作为 `ASRError.code` 抛出，与 SDK 本地错误码（10xx）区间不冲突；离线错误一律以响应 body 的 `code` 为准（鉴权失败也是 HTTP 200）
  - `needvad`/`convertNumMode` 显式传 0 会真正下发（v2 query 传参会吞掉 0 值）；说话人分离的 `speaker_roles` 元素序列化为 snake_case（`role_name`/`audio_url`），声纹 ID 列表为 `voiceprint_ids`
  - v3 新增能力：`word_with_space`、`context`（识别上下文 text/terms/general）；录音文件支持 `audio_urls` 分布式录音
  - 使用前提：服务端已为对应 SDKAppID 开启 `EnableV3Route` 灰度
  - 注：协议中服务端内部的 `business` 灰度字段不属于公开 API，SDK 不暴露、不发送
- 新增 `examples/v3-realtime-asr.ts` / `v3-sentence-asr.ts` / `v3-file-asr.ts` 示例
- README 改为只承载 v3 协议文档；v2 / v1 协议与客户端说明移至 `docs/v2_protocol.md`

### 变更

- 仓库迁移至 `github.com/Tencent-RTC/trtc-asr-sdk-nodejs`，功能与 API 无任何变化。
  旧仓库保留 `v1.0.0` 并归档，不再更新。

## [1.0.0] - 2026-09-02

首个正式版本。

### 新增

- Credential 可通过 `setSite` 选择国内站（默认，`asr.cloud-rtc.com`）或国际站（`asr-intl.cloud-rtc.com`），三个识别器共用
- 实时语音识别（WebSocket），支持流式写入与优雅停止
- 一句话识别（HTTP）
- 录音文件识别（异步 HTTP，CreateRecTask + DescribeTaskStatus）
- 说话人分离：匿名聚类与声纹角色认证两种模式
- VAD 调优、热词、自定义语言模型、脏词/语气词/标点过滤等识别参数
- 所有请求上报 SDK 自身标识（`platform` / `sdk_lang` / `sdk_type` / `version`），
  便于服务端按语言、版本、平台定位客户问题
- MIT LICENSE
- GitHub Actions CI：Node 18/20/22 测试矩阵，外加 `npm pack` 产物内容校验
  （确保 `dist/index.js` 与 `dist/index.d.ts` 确实进入发布包）
