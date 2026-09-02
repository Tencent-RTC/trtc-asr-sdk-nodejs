# TRTC-ASR Node.js SDK

基于 TRTC 鉴权体系的语音识别（ASR）Node.js SDK，支持实时语音识别（WebSocket）、一句话识别（HTTP）和录音文件识别（异步 HTTP）三种模式。

> 其他语言 SDK：[Go](https://github.com/hydah/trtc-asr-sdk-go) | [Python](https://github.com/hydah/trtc-asr-sdk-python)

## 安装

```bash
npm install trtc-asr
```

**要求**：Node.js >= 16

## 快速开始

```typescript
import { Credential, SITE_INTL, SpeechRecognizer, SpeechRecognitionListener, SpeechRecognitionResponse } from "trtc-asr";
import * as fs from "fs";

// 只需实现关心的回调；其余事件可以省略。
const listener: SpeechRecognitionListener = {
  onSentenceEnd(resp: SpeechRecognitionResponse) {
    console.log(`Sentence end: ${resp.result?.voice_text_str}`);
  },
  onFail(resp: SpeechRecognitionResponse | null, error: Error) {
    console.error(`Failed: ${error}`);
  },
};

async function main() {
  // 1. 创建凭证
  const credential = new Credential(
    1300403317,              // 腾讯云 APPID
    1400188366,              // TRTC SDKAppID
    "your-sdk-secret-key",   // SDK密钥
  );
  // credential.setSite(SITE_INTL); // 国际站；不调用则走国内站

  // 2. 创建识别器
  const recognizer = new SpeechRecognizer(credential, "16k_zh", listener);

  // 3. 可选配置
  // recognizer.setHotwordId("hotword-id");     // 设置热词
  // recognizer.setVadSilenceTime(500);          // VAD 静音时间

  // 4. 启动识别
  await recognizer.start();

  // 5. 发送音频数据
  const fileData = fs.readFileSync("audio.pcm");
  const SLICE_SIZE = 6400; // 200ms of 16kHz 16bit mono PCM
  for (let offset = 0; offset < fileData.length; offset += SLICE_SIZE) {
    const chunk = fileData.subarray(offset, offset + SLICE_SIZE);
    await recognizer.write(Buffer.from(chunk));
    await new Promise((resolve) => setTimeout(resolve, 200)); // 模拟实时
  }

  // 6. 停止识别
  await recognizer.stop();
}

main().catch(console.error);
```

### 一句话识别

```typescript
import { Credential, SentenceRecognizer } from "trtc-asr";
import * as fs from "fs";

async function main() {
  // 1. 创建凭证
  const credential = new Credential(
    0,                       // 腾讯云 APPID
    0,                       // TRTC SDKAppID
    "your-sdk-secret-key",   // SDK密钥
  );

  // 2. 创建一句话识别器
  const recognizer = new SentenceRecognizer(credential);

  // 3. 从本地文件识别（自动 base64 编码）
  const data = fs.readFileSync("audio.pcm");
  const result = await recognizer.recognizeData(Buffer.from(data), "pcm", "16k_zh_en");

  console.log(`识别结果: ${result.result}`);
  console.log(`音频时长: ${result.audioDuration} ms`);

  // 或者从 URL 识别
  // const result = await recognizer.recognizeURL("https://example.com/audio.wav", "wav", "16k_zh_en");
}

main().catch(console.error);
```

### 录音文件识别

```typescript
import { Credential, FileRecognizer } from "trtc-asr";
import * as fs from "fs";

async function main() {
  // 1. 创建凭证
  const credential = new Credential(
    0,                       // 腾讯云 APPID
    0,                       // TRTC SDKAppID
    "your-sdk-secret-key",   // SDK密钥
  );

  // 2. 创建录音文件识别器
  const recognizer = new FileRecognizer(credential);

  // 3. 提交识别任务（本地文件）
  const data = fs.readFileSync("audio.wav");
  const taskId = await recognizer.createTaskFromData(Buffer.from(data), "16k_zh_en");
  console.log(`任务已提交: ${taskId}`);

  // 4. 轮询等待结果（默认 1 秒间隔，10 分钟超时）
  const status = await recognizer.waitForResult(taskId);

  console.log(`识别结果: ${status.result}`);
  console.log(`音频时长: ${status.audioDuration.toFixed(2)} s`);

  // 或者从 URL 提交（支持更大文件，≤1GB / ≤12h）
  // const taskId = await recognizer.createTaskFromURL("https://example.com/audio.wav", "16k_zh_en");

  // 或者自定义轮询间隔（毫秒）
  // const status = await recognizer.waitForResultWithInterval(taskId, 2000, 1800000);
}

main().catch(console.error);
```

## 前提条件

使用本 SDK 前，您需要：

1. **获取腾讯云 APPID** — 在 [CAM API 密钥管理](https://console.cloud.tencent.com/cam/capi) 页面查看
2. **创建 TRTC 应用** — 在 [实时音视频控制台](https://console.cloud.tencent.com/trtc/app) 创建应用，获取 `SDKAppID`
3. **获取 SDK 密钥** — 在应用概览页点击「SDK密钥」查看密钥，即用于计算 UserSig 的加密密钥

## 协议说明

### WebSocket 连接

- **连接地址**：
  - 国内站：`wss://asr.cloud-rtc.com/asr/v2/<appid>?{请求参数}`
  - 国际站：`wss://asr-intl.cloud-rtc.com/asr/v2/<appid>?{请求参数}`（`credential.setSite(SITE_INTL)`）

其中 `<appid>` 为腾讯云账号的 APPID，可通过 [API 密钥管理页面](https://console.cloud.tencent.com/cam/capi) 获取。

### 鉴权方式

鉴权信息携带在 URL query 参数中（浏览器原生 WebSocket 无法自定义 header，因此走 query 传递）：

| 参数 | 说明 |
|------|------|
| `sdkappid` | TRTC 应用 ID，从 [TRTC 控制台](https://console.cloud.tencent.com/trtc/app) 获取 |
| `usersig` | TRTC 签名，[计算文档](https://cloud.tencent.com/document/product/647/17275)，UserID 等于 `voice_id` |

两者均由 SDK 自动填充，用户无需关心。

### 请求参数

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `secretid` | 是 | String | SDK 内部自动用 APPID 填充 |
| `sdkappid` | 是 | Integer | TRTC 应用 ID，SDK 内部自动填充 |
| `usersig` | 是 | String | TRTC 签名，SDK 内部自动生成（值与 `signature` 一致） |
| `timestamp` | 是 | Integer | 当前 UNIX 时间戳（秒） |
| `expired` | 是 | Integer | 签名有效期截止时间戳，必须大于 timestamp |
| `nonce` | 是 | Integer | 随机正整数，最长10位 |
| `engine_model_type` | 是 | String | 引擎类型：`8k_zh`(中文电话)、`16k_zh`(中文通用)、`16k_zh_en`(中英文) |
| `voice_id` | 是 | String | 音频流全局唯一标识（推荐 UUID），最长128位 |
| `voice_format` | 否 | Integer | 语音编码：`1` PCM（默认） |
| `needvad` | 否 | Integer | `0` 关闭 VAD，`1` 开启（默认） |
| `hotword_id` | 否 | String | 热词表 ID |
| `hotword_list` | 否 | String | 临时热词列表：`词1|权重1,词2|权重2`（单词 ≤30 字节，权重 1-11 或 100） |
| `customization_id` | 否 | String | 自学习模型 ID |
| `replace_text_id` | 否 | String | 替换词表 ID |
| `filter_dirty` | 否 | Integer | 过滤脏词：`0` 不过滤，`1` 过滤，`2` 替换为 * |
| `filter_modal` | 否 | Integer | 过滤语气词：`0` 不过滤，`1` 部分，`2` 严格 |
| `filter_punc` | 否 | Integer | 过滤句末句号：`0` 不过滤，`1` 过滤 |
| `filter_empty_result` | 否 | Integer | 空结果回调：`0` 回调，`1` 不回调（服务端默认） |
| `convert_num_mode` | 否 | Integer | 数字转换：`0` 不转，`1` 智能转换（默认），`3` 数学转换 |
| `word_info` | 否 | Int | 显示词级时间：`0` 不显示，`1` 显示，`2` 含标点 |
| `vad_silence_time` | 否 | Integer | 静音断句阈值（ms），范围 240-2000，默认 800 |
| `vad_level` | 否 | Integer | VAD 场景档：`0` 高召回，`1` 远场过滤（服务端默认） |
| `noise_threshold` | 否 | Float | VAD 噪声微调，范围 `0.0-4.0`；设置后覆盖 `vad_level` 档位 |
| `max_speak_time` | 否 | Integer | 强制断句时间（ms），范围 5000-90000，默认 60000 |
| `input_sample_rate` | 否 | Integer | 输入 PCM 采样率，仅支持 `8000`（8k 音频喂 16k 引擎） |
| `speaker_diarization` | 否 | Integer | 说话人分离：`0` 关闭（默认），`1` 匿名聚类，`3` 声纹角色认证 |
| `speaker_number` | 否 | Integer | 说话人数量提示（分离开启时生效，用于在线聚类）；`0` 自动检测 |
| `speaker_roles` | 否 | String | 临时声纹角色 JSON 数组，仅 `speaker_diarization=3`，如 `[{"RoleName":"teacher","AudioUrl":"https://.../a.wav"}]` |
| `voiceprintids` | 否 | String | 已注册声纹 ID JSON 数组，仅 `speaker_diarization=3` |
| `language` | 否 | String | 指定识别语言（如 `zh`、`en`），留空为自动检测 |
| `signature` | 是 | String | 接口签名参数，值与 `usersig` 一致 |

### 实时识别响应

| 字段 | 类型 | 说明 |
|------|------|------|
| `code` / `message` | Integer / String | 错误码与提示，`0` 表示成功 |
| `voice_id` / `message_id` | String | 音频流 ID / 单条消息 ID |
| `final` | Integer | `1` 表示会话结束包 |
| `result.slice_type` | Integer | `0` 句子开始，`1` 中间结果，`2` 句末稳定结果 |
| `result.index` | Integer | 句子序号 |
| `result.start_time` / `end_time` | Integer | 当前结果起止时间（ms） |
| `result.voice_text_str` | String | 当前结果文本 |
| `result.word_size` / `word_list` | Integer / Array | 词级（字级）时间戳，需 `word_info != 0` |
| `result.speaker_segments` | Array | 说话人分段，开启说话人分离后返回 |
| `result.language` | String | 识别语言（引擎上报时） |
| `result.finish_silence_ms` | Integer | 触发断句的尾部静音时长（ms） |
| `result.last_token_runtime_ms` | Integer | 末字服务端解码耗时（ms） |

### 说话人分离（实时）

开启 `speaker_diarization` 后，说话人归属通过两个入口返回：

- `result.speaker_segments[]`：**推荐入口**。一个 `result` 可能包含多个说话人，句子级归属天然有歧义，因此协议按说话人切段返回。`len(speaker_segments) == 1` 即为单说话人句。
- `result.word_list[].speaker_id`：字级归属，需同时设置 `word_info != 0`。

`speaker_id` 语义：会话内有效，从 `1` 开始编号，`-1` 表示未知，`0` 为保留值。

`speaker_segments[]` 字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `speaker_id` | Integer | 说话人编号 |
| `speaker_name` | String | 角色名，仅 `speaker_diarization=3` 命中注册声纹时返回，等于请求侧 `RoleName` |
| `start_time` / `end_time` | Integer | 该分段起止时间（ms） |
| `text` | String | 该分段文本 |
| `word_start` / `word_end` | Integer | 对应 `word_list` 的闭区间下标，即 `word_list[word_start:word_end+1]`；`word_info=0` 时不返回 |
| `stable_flag` | Integer | 该分段是否稳定：`1` 稳定，`0` 非稳定 |

Node.js 用法示例：

```typescript
import {
  SpeechRecognizer,
  SpeechRecognitionListener,
  SPEAKER_DIARIZATION_CLUSTER,
  SpeakerRole,
} from "trtc-asr";

const recognizer = new SpeechRecognizer(credential, "16k_zh", listener);
recognizer.setWordInfo(1);                                      // 需要字级说话人时开启
recognizer.setSpeakerDiarization(SPEAKER_DIARIZATION_CLUSTER);  // 1：匿名聚类

// 声纹角色认证（返回角色名）：
// recognizer.setSpeakerDiarization(SPEAKER_DIARIZATION_VOICEPRINT); // 3
// recognizer.setSpeakerRoles([{ roleName: "teacher", audioUrl: "https://example.com/teacher.wav" }]);
// recognizer.setVoiceprintIds(["vp-1"]);  // 已注册声纹
// recognizer.setSpeakerNumber(2);         // 0 = 自动检测；两种分离模式都生效

// 回调里读取：
const listener: SpeechRecognitionListener = {
  // ...
  onSentenceEnd(resp) {
    for (const seg of resp.result.speaker_segments ?? []) {
      const name = seg.speaker_name || `spk${seg.speaker_id}`; // speaker_diarization=3 才有名字
      console.log(`[${name}] ${seg.text}`);
    }
  },
};
```

### VAD 调优（noise_threshold / vad_level）

| 方法 | 取值 | 说明 |
|------|------|------|
| `setVadLevel(level)` | `0` / `1` | `0` 高召回，`1` 远场过滤（服务端默认） |
| `setNoiseThreshold(v)` | `0.0` - `4.0` | 噪声抑制微调，值越大抑制越强、召回越低；设置后覆盖 `vadLevel` 档位 |
| `setVadSilenceTime(ms)` | 240 - 2000 | 静音断句阈值 |

两者都是三态语义：**只有显式调用 setter 才会下发**，因此显式传 `0` 与「不配置」可以区分（服务端 `vad_level` 默认是 `1`）。超出范围会在 `start()` 阶段本地报错，不会浪费一次连接。

### 一句话识别接口

- **请求地址**：
  - 国内站：`https://asr.cloud-rtc.com/v1/SentenceRecognition?{请求参数}`
  - 国际站：`https://asr-intl.cloud-rtc.com/v1/SentenceRecognition?{请求参数}`
- **请求方法**：HTTP POST，Content-Type 为 `application/json; charset=utf-8`

#### 鉴权方式

HTTP 接口的鉴权信息携带在请求 Header 中（与流式不同，不走 query）：

| Header | 说明 |
|--------|------|
| `X-TRTC-SdkAppId` | TRTC 应用 ID，从 [TRTC 控制台](https://console.cloud.tencent.com/trtc/app) 获取 |
| `X-TRTC-UserSig` | TRTC 签名，UserID 等于 URL 参数中的 `RequestId`（SDK 内部自动生成） |

#### URL 请求参数

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `AppId` | 是 | String | 腾讯云 APPID |
| `Secretid` | 是 | String | SDK 内部自动用 APPID 填充 |
| `RequestId` | 是 | String | 全局请求唯一 ID（UUID），用于生成 UserSig |
| `Timestamp` | 是 | Integer | 当前 UNIX 时间戳（秒） |

#### 请求体参数（JSON）

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `EngSerViceType` | 是 | String | 引擎类型：`16k_zh`(中文)、`16k_zh_en`(中英文) |
| `SourceType` | 是 | Integer | `0` URL 上传、`1` 本地数据（base64） |
| `VoiceFormat` | 是 | String | 音频格式：`wav`、`pcm`、`ogg-opus`、`mp3`、`m4a` |
| `Data` | 条件 | String | base64 编码的音频数据（SourceType=1 时必填） |
| `DataLen` | 条件 | Integer | 音频数据原始长度（SourceType=1 时必填） |
| `Url` | 条件 | String | 音频 URL（SourceType=0 时必填） |
| `WordInfo` | 否 | Integer | 词级时间：`0` 不显示、`1` 显示、`2` 含标点 |
| `FilterDirty` | 否 | Integer | 脏词过滤：`0` 不过滤、`1` 过滤、`2` 替换 |
| `FilterModal` | 否 | Integer | 语气词过滤：`0` 不过滤、`1` 部分、`2` 严格 |
| `FilterPunc` | 否 | Integer | 标点过滤：`0` 不过滤、`2` 过滤全部 |
| `ConvertNumMode` | 否 | Integer | 数字转换：`0` 不转、`1` 智能转换（默认） |
| `HotwordId` | 否 | String | 热词表 ID |
| `HotwordList` | 否 | String | 临时热词列表 |
| `CustomizationId` | 否 | String | 自学习模型 ID |
| `InputSampleRate` | 否 | Integer | PCM 输入采样率（仅 PCM 格式，支持 8000） |
| `Language` | 否 | String | 指定识别语言，留空为自动检测 |

**限制**：音频时长 ≤ 60s，文件大小 ≤ 3MB，单账号并发 ≤ 30次/秒

### 录音文件识别接口

录音文件识别是异步接口，适用于较长音频（≤12h）。工作流程为：提交任务 → 轮询结果。

#### 创建任务：CreateRecTask

- **请求地址**：
  - 国内站：`https://asr.cloud-rtc.com/v1/CreateRecTask?{请求参数}`
  - 国际站：`https://asr-intl.cloud-rtc.com/v1/CreateRecTask?{请求参数}`
- **请求方法**：HTTP POST，Content-Type 为 `application/json; charset=utf-8`
- **并发限制**：默认 20次/秒

鉴权方式（Header 中的 `X-TRTC-SdkAppId` / `X-TRTC-UserSig`）与 URL 请求参数（AppId、Secretid、RequestId、Timestamp）均与一句话识别相同。

##### 请求体参数（JSON）

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `EngineModelType` | 是 | String | 引擎类型：`16k_zh`(中文)、`16k_zh_en`(中英文) |
| `ChannelNum` | 是 | Integer | 声道数：`1` 单声道；`2` 双声道（8k 电话，自动区分说话人并返回 `ChannelId`：1=左/2=右） |
| `ResTextFormat` | 是 | Integer | 结果格式：`0` 基础、`1` 含词级时间、`2` 含标点时间 |
| `SourceType` | 是 | Integer | `0` URL 上传、`1` 本地数据（base64） |
| `Url` | 条件 | String | 音频 URL（SourceType=0，时长≤12h，大小≤1GB） |
| `Data` | 条件 | String | base64 编码音频数据（SourceType=1，大小≤5MB） |
| `DataLen` | 条件 | Integer | 音频数据原始长度（SourceType=1） |
| `CallbackUrl` | 否 | String | 回调 URL，任务完成后 POST 结果 |
| `FilterDirty` | 否 | Integer | 脏词过滤 |
| `FilterModal` | 否 | Integer | 语气词过滤 |
| `FilterPunc` | 否 | Integer | 标点过滤 |
| `ConvertNumMode` | 否 | Integer | 数字转换 |
| `HotwordId` | 否 | String | 热词表 ID |
| `HotwordList` | 否 | String | 临时热词列表 |
| `CustomizationId` | 否 | String | 自学习模型 ID |
| `ReplaceTextId` | 否 | String | 替换词表 ID |
| `Language` | 否 | String | 指定识别语言，留空为自动检测 |
| `SpeakerDiarization` | 否 | Integer | 说话人分离：`0` 关闭（默认），`1` 匿名聚类，`3` 声纹角色认证 |
| `SpeakerNumber` | 否 | Integer | 说话人数量提示，`0` 自动检测 |
| `SpeakerRoles` | 否 | Array | 临时声纹角色，元素含 `RoleName` 与 `AudioUrl`，仅 `SpeakerDiarization=3` |
| `VoiceprintIds` | 否 | Array | 已注册声纹 ID 列表，仅 `SpeakerDiarization=3` |
| `VadSilenceMs` | 否 | Integer | 静音断句阈值（ms） |
| `VadLevel` | 否 | Integer | VAD 场景档：`0` 高召回（默认），`1` 远场过滤 |
| `NoiseThreshold` | 否 | Float | VAD 噪声微调，范围 `0.0-4.0`；设置后覆盖 `VadLevel` 档位 |

> `VadLevel` / `NoiseThreshold` 在请求里是可选字段（`vadLevel` / `noiseThreshold`），因为 `0` 是合法取值，用 `undefined`（不设置该字段）才能区分「显式传 0」与「不配置」。

##### 响应

返回 `RecTaskId`（任务 ID），用于后续查询。任务有效期 24 小时。

#### 查询结果：DescribeTaskStatus

- **请求地址**：
  - 国内站：`https://asr.cloud-rtc.com/v1/DescribeTaskStatus?{请求参数}`
  - 国际站：`https://asr-intl.cloud-rtc.com/v1/DescribeTaskStatus?{请求参数}`
- **请求方法**：HTTP POST
- **并发限制**：默认 50次/秒

##### 请求体参数（JSON）

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `RecTaskId` | 是 | String | CreateRecTask 返回的任务 ID |

##### 响应（TaskStatus）

| 字段 | 类型 | 说明 |
|------|------|------|
| `RecTaskId` | String | 任务 ID |
| `Status` | Integer | `0` 等待、`1` 执行中、`2` 成功、`3` 失败 |
| `StatusStr` | String | waiting / executing / success / failed |
| `Progress` | Integer | 处理进度（0-100） |
| `Result` | String | 识别结果文本 |
| `ErrorMsg` | String | 失败原因 |
| `ResultDetail` | Array | 句级详细结果（含词级时间偏移） |
| `AudioDuration` | Float | 音频时长（秒） |

`ResultDetail[]` 中与说话人相关的字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `SpeakerId` | Integer | 说话人编号，开启 `SpeakerDiarization` 后返回 |
| `SpeakerRoleName` | String | 角色名，`SpeakerDiarization=3` 命中注册声纹时返回 |
| `ChannelId` | Integer | 双声道（`ChannelNum=2`）时的声道编号：1=左、2=右；此场景下优先用它区分说话人 |
| `Language` | String | 该句识别语言（引擎上报时） |

## 凭证获取

| 参数 | 来源 | 说明 |
|------|------|------|
| `appId` | [CAM 密钥管理](https://console.cloud.tencent.com/cam/capi) | 腾讯云账号 APPID，用于 URL 路径 |
| `sdkAppId` | [TRTC 控制台](https://console.cloud.tencent.com/trtc/app) > 应用管理 | TRTC 应用 ID |
| `secretKey` | [TRTC 控制台](https://console.cloud.tencent.com/trtc/app) > 应用概览 > SDK密钥 | 用于生成 UserSig，不会传输到网络 |

## 配置项

实时语音识别（`SpeechRecognizer`）：

| 方法 | 说明 | 默认值 |
|------|------|--------|
| `setVoiceFormat(f)` | 音频格式 | 1 (PCM) |
| `setNeedVad(v)` | 是否开启 VAD | 1 (开启) |
| `setConvertNumMode(m)` | 数字转换模式 | 1 (智能) |
| `setHotwordId(id)` | 热词表 ID | - |
| `setHotwordList(list)` | 临时热词列表 `词\|权重,...` | - |
| `setCustomizationId(id)` | 自学习模型 ID | - |
| `setReplaceTextId(id)` | 替换词表 ID | - |
| `setFilterDirty(m)` | 脏词过滤 | 0 (关闭) |
| `setFilterModal(m)` | 语气词过滤 | 0 (关闭) |
| `setFilterPunc(m)` | 句号过滤 | 0 (关闭) |
| `setFilterEmptyResult(m)` | 空结果是否回调 | 1 (不回调) |
| `setWordInfo(m)` | 词级/字级时间 | 0 (关闭) |
| `setVadSilenceTime(ms)` | VAD 静音阈值（240-2000） | 800ms |
| `setVadLevel(level)` | VAD 场景档：0 高召回 / 1 远场过滤 | 1 |
| `setNoiseThreshold(v)` | VAD 噪声微调（0.0-4.0），覆盖场景档 | 未设置 |
| `setMaxSpeakTime(ms)` | 强制断句时间（5000-90000） | 60000ms |
| `setInputSampleRate(r)` | 输入 PCM 采样率，仅 8000 | - |
| `setSpeakerDiarization(m)` | 说话人分离：0 关 / 1 聚类 / 3 声纹角色 | 0 (关闭) |
| `setSpeakerNumber(n)` | 说话人数量提示（分离开启时生效） | 0 (自动) |
| `setSpeakerRoles(roles)` | 临时声纹角色（仅模式 3） | - |
| `setVoiceprintIds(ids)` | 已注册声纹 ID（仅模式 3） | - |
| `setLanguage(lang)` | 指定识别语言 | 自动检测 |
| `setVoiceId(id)` | 自定义 voice_id | 自动 UUID |

## 引擎模型

| 类型 | 说明 |
|------|------|
| `8k_zh` | 中文通用，常用于电话场景 |
| `16k_zh` | 中文通用（推荐） |
| `16k_zh_en` | 中英文通用 |

## 示例

完整示例请参见：

- **实时语音识别**：[`examples/realtime-asr.ts`](./examples/realtime-asr.ts) — WebSocket 流式识别
- **一句话识别**：[`examples/sentence-asr.ts`](./examples/sentence-asr.ts) — HTTP 短音频识别（≤60s）
- **录音文件识别**：[`examples/file-asr.ts`](./examples/file-asr.ts) — 异步长音频识别

运行示例：

```bash
git clone https://github.com/hydah/trtc-asr-sdk-nodejs.git
cd trtc-asr-sdk-nodejs
npm install

# 实时语音识别
npx ts-node examples/realtime-asr.ts -f examples/test.pcm

# 一句话识别
npx ts-node examples/sentence-asr.ts -f examples/test.pcm

# 录音文件识别
npx ts-node examples/file-asr.ts -f examples/test.wav

# 说话人分离（实时：匿名聚类 + 字级说话人）
npx ts-node examples/realtime-asr.ts -f examples/test.pcm --diarization 1 --word-info 1

# 说话人分离（实时：声纹角色认证，返回角色名）
npx ts-node examples/realtime-asr.ts -f examples/test.pcm --diarization 3 \
  --roles "teacher=https://example.com/teacher.wav,student=https://example.com/student.wav"

# VAD 调优（远场过滤 + 噪声阈值）
npx ts-node examples/realtime-asr.ts -f examples/test.pcm --vad-level 1 --noise-threshold 1.5

# 说话人分离（录音文件）
npx ts-node examples/file-asr.ts -u https://example.com/call.wav --diarization 1

# 查看所有选项
npx ts-node examples/realtime-asr.ts --help
```

## 项目结构

```
trtc-asr-sdk-nodejs/
├── src/                            # TypeScript 源码
│   ├── index.ts                    # 包入口，统一导出
│   ├── credential.ts               # 凭证管理（APPID + SDKAppID + SDK密钥）
│   ├── usersig.ts                  # TRTC UserSig 生成
│   ├── signature.ts                # URL 请求参数构建
│   ├── speech-recognizer.ts        # 实时语音识别器（WebSocket）
│   ├── params.ts                   # 说话人分离 / VAD 调优参数校验
│   ├── sentence-recognizer.ts      # 一句话识别器（HTTP）
│   ├── file-recognizer.ts          # 录音文件识别器（异步 HTTP）
│   └── errors.ts                   # 错误定义
├── examples/                       # 示例代码
│   ├── test.pcm                    # 测试音频文件
│   ├── realtime-asr.ts             # 实时语音识别示例
│   ├── sentence-asr.ts             # 一句话识别示例
│   └── file-asr.ts                 # 录音文件识别示例
├── tests/                          # 测试
│   ├── signature.test.ts           # 签名参数测试
│   ├── signature-speaker.test.ts   # 说话人分离 / VAD 调优参数测试
│   ├── params.test.ts              # 参数校验测试
│   ├── diarization.test.ts         # 说话人分离端到端测试
│   ├── recognizer.lifecycle.test.ts # 生命周期健壮性测试
│   ├── sentence-recognizer.test.ts # 一句话识别测试
│   └── file-recognizer.test.ts     # 录音文件识别测试
├── dist/                           # 编译输出（npm 发布内容）
├── package.json                    # 包定义
├── tsconfig.json                   # TypeScript 配置
└── .gitignore
```

## 常见问题

### APPID 和 SDKAppID 有什么区别？

- **APPID**（如 `13xxxxxxxx`）：腾讯云账号级别的 ID，从 [CAM 密钥管理](https://console.cloud.tencent.com/cam/capi) 获取，用于 WebSocket URL 路径
- **SDKAppID**（如 `14xxxxxxxx`）：TRTC 应用级别的 ID，从 [TRTC 控制台](https://console.cloud.tencent.com/trtc/app) 获取，用于鉴权（SDK 自动填入 URL query 的 `sdkappid`）

### UserSig 是什么？

UserSig 是基于 SDKAppID 和 SDK 密钥计算的签名，用于 TRTC 服务鉴权。SDK 会自动生成，无需手动计算。详见[鉴权文档](https://cloud.tencent.com/document/product/647/17275)。

### signature 参数怎么计算？

根据协议，`signature` 与 `usersig` 的值都等于 UserSig，SDK 内部自动处理，用户无需关心。

### 支持哪些音频格式？

- **实时语音识别**：支持 PCM 格式（`voiceFormat=1`），建议 16kHz、16bit、单声道
- **一句话识别**：支持 wav、pcm、ogg-opus、mp3、m4a，音频时长 ≤ 60s，文件 ≤ 3MB
- **录音文件识别**：支持 wav、ogg-opus、mp3、m4a，本地文件 ≤ 5MB，URL ≤ 1GB / ≤ 12h

### TypeScript 和 JavaScript 都能用吗？

可以。SDK 使用 TypeScript 编写，编译后发布包含 `.js` 和 `.d.ts` 文件，TypeScript 和 JavaScript 项目均可使用。

## License

MIT License
