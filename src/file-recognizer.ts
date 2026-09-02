/**
 * Async audio file recognition client for TRTC-ASR.
 *
 * Unlike SentenceRecognizer (one-shot, ≤60s), FileRecognizer handles longer
 * audio files via an async workflow: submit a task (CreateRecTask), then poll
 * for results (DescribeTaskStatus).
 *
 * Usage:
 *   const credential = new Credential(appId, sdkAppId, secretKey);
 *   const recognizer = new FileRecognizer(credential);
 *   const taskId = await recognizer.createTaskFromData(data, "16k_zh_en");
 *   const result = await recognizer.waitForResult(taskId);
 */

import { v4 as uuidv4 } from "uuid";
import { Credential, resolveHTTPEndpoint } from "./credential";
import { ASRError, ErrorCode } from "./errors";
import { validateSpeakerDiarization, validateVadTuning } from "./params";
import { sdkReportQuery } from "./sdkinfo";
import { SpeakerRole } from "./signature";
import { genUserSig } from "./usersig";

export const FILE_ENDPOINT = "https://asr.cloud-rtc.com";

/** Audio source type. */
export const FileSourceType = {
  URL: 0,
  DATA: 1,
} as const;

/** Task status codes. */
export const TaskStatusCode = {
  WAITING: 0,
  RUNNING: 1,
  SUCCESS: 2,
  FAILED: 3,
} as const;

/** JSON request body for creating a file recognition task. */
export interface CreateRecTaskRequest {
  engineModelType: string;
  channelNum: number;
  resTextFormat: number;
  sourceType: number;

  /** Audio URL (required when sourceType=0). */
  url?: string;
  /** Base64-encoded audio data (required when sourceType=1). */
  data?: string;
  /** Audio data length in bytes (required when sourceType=1). */
  dataLen?: number;

  /** Callback URL for receiving results when task completes. */
  callbackUrl?: string;
  /** Profanity filter: 0=off, 1=filter, 2=replace. */
  filterDirty?: number;
  /** Modal particle filter: 0=off, 1=partial, 2=strict. */
  filterModal?: number;
  /** Punctuation filter: 0=off, 1=filter trailing, 2=filter all. */
  filterPunc?: number;
  /** Number conversion: 0=off, 1=smart. */
  convertNumMode?: number;
  /** Hotword vocabulary ID. */
  hotwordId?: string;
  /** Temporary inline hotword list. */
  hotwordList?: string;
  /** Custom language model ID. */
  customizationId?: string;
  /** Replacement word table ID used for forced text replacement. */
  replaceTextId?: string;
  /** Force the audio language on engines that support it (e.g. bigmodel). */
  language?: string;

  /**
   * Speaker diarization (说话人分离): 0=off (default), 1=anonymous
   * clustering, 3=voiceprint role authentication.
   *
   * When enabled, each sentence in resultDetail carries speakerId; with
   * mode 3 and speakerRoles / voiceprintIds supplied, speakerRoleName is
   * filled too.
   *
   * For stereo recordings (channelNum=2) do NOT enable this: the server
   * auto-fills channelId (1=left, 2=right) per sentence instead.
   */
  speakerDiarization?: number;
  /** Expected speaker count hint; 0=auto detection (default). */
  speakerNumber?: number;
  /** Temporary voiceprint enrollment roles; only speakerDiarization=3. */
  speakerRoles?: SpeakerRole[];
  /** Previously enrolled voiceprint IDs; only speakerDiarization=3. */
  voiceprintIds?: string[];
  /** Silence detection threshold in milliseconds. */
  vadSilenceMs?: number;
  /**
   * VAD profile: 0=high recall (default), 1=far-field noise filtering.
   * undefined means "not configured", so an explicit 0 can be distinguished
   * from the server default.
   */
  vadLevel?: number;
  /**
   * VAD noise fine-tuning, range [0, 4]. When set it overrides the profile
   * selected by vadLevel. undefined means "not configured" (0 is a valid,
   * meaningful threshold).
   */
  noiseThreshold?: number;
}

/** Word-level timing within a sentence. */
export interface SentenceWords {
  word: string;
  offsetStartMs: number;
  offsetEndMs: number;
}

/** Sentence-level recognition result with word timing. */
export interface SentenceDetail {
  finalSentence: string;
  sliceSentence: string;
  writtenText: string;
  startMs: number;
  endMs: number;
  wordsNum: number;
  words: SentenceWords[];
  speechSpeed: number;
  silenceTime: number;

  /** Speaker number of this sentence, returned when diarization is enabled. */
  speakerId?: number;

  /**
   * Enrolled role name of this sentence, returned when
   * speakerDiarization=3 matched one of the requested speakerRoles /
   * voiceprintIds. Empty when no enrolled speaker matched.
   */
  speakerRoleName?: string;

  /**
   * Audio channel of this sentence for stereo recordings (channelNum=2):
   * 1=left, 2=right. Prefer it over speakerId in that case.
   */
  channelId?: number;

  /** Detected language of this sentence, when the engine reports one. */
  language?: string;
}

/** Task status and result. */
export interface TaskStatus {
  recTaskId: string;
  status: number;
  statusStr: string;
  /** Processing progress (0-100). */
  progress: number;
  result: string;
  errorMsg: string;
  resultDetail: SentenceDetail[];
  audioDuration: number;
}

/** Async audio file recognition client using HTTP POST. */
export class FileRecognizer {
  private credential: Credential;
  private endpoint: string;
  private timeout: number; // ms

  constructor(credential: Credential) {
    this.credential = credential;
    this.endpoint = "";
    this.timeout = 60000;
  }

  /** Override the default API endpoint (for testing). */
  setEndpoint(endpoint: string): void {
    this.endpoint = endpoint;
  }

  /** Set HTTP request timeout in milliseconds. */
  setTimeout(timeout: number): void {
    this.timeout = timeout;
  }

  /** Submit a file recognition task and return the task ID. */
  async createTask(req: CreateRecTaskRequest): Promise<string> {
    this.validateCreateRequest(req);

    const body = this.buildBody(req);
    const respData = await this.doRequest("/v1/CreateRecTask", body);

    const response = respData?.Response;
    if (!response) {
      throw new ASRError(ErrorCode.SERVER_ERROR, "empty response from server");
    }

    if (response.Error) {
      throw new ASRError(
        ErrorCode.SERVER_ERROR,
        `server error [${response.Error.Code || ""}]: ` +
          `${response.Error.Message || ""} ` +
          `(RequestId: ${response.RequestId || ""})`,
      );
    }

    const taskId = response.Data?.RecTaskId;
    if (!taskId) {
      throw new ASRError(
        ErrorCode.SERVER_ERROR,
        "empty RecTaskId in response",
      );
    }

    return taskId;
  }

  /** Submit local audio data for recognition (auto base64 encoding). Max 5MB. */
  async createTaskFromData(
    data: Buffer,
    engineModelType: string,
  ): Promise<string> {
    if (!data || data.length === 0) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "audio data is empty");
    }
    if (data.length > 5 * 1024 * 1024) {
      throw new ASRError(
        ErrorCode.INVALID_PARAM,
        "audio data exceeds 5MB limit",
      );
    }

    return this.createTask({
      engineModelType,
      channelNum: 1,
      resTextFormat: 1,
      sourceType: FileSourceType.DATA,
      data: data.toString("base64"),
      dataLen: data.length,
    });
  }

  /** Submit an audio URL for recognition. Audio ≤12h, ≤1GB. */
  async createTaskFromURL(
    audioURL: string,
    engineModelType: string,
  ): Promise<string> {
    if (!audioURL) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "audio URL is empty");
    }

    return this.createTask({
      engineModelType,
      channelNum: 1,
      resTextFormat: 1,
      sourceType: FileSourceType.URL,
      url: audioURL,
    });
  }

  /** Submit local audio data with a pre-configured request. */
  async createTaskFromDataWithOptions(
    rawData: Buffer,
    req: CreateRecTaskRequest,
  ): Promise<string> {
    if (!rawData || rawData.length === 0) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "audio data is empty");
    }
    if (rawData.length > 5 * 1024 * 1024) {
      throw new ASRError(
        ErrorCode.INVALID_PARAM,
        "audio data exceeds 5MB limit",
      );
    }

    req.sourceType = FileSourceType.DATA;
    req.data = rawData.toString("base64");
    req.dataLen = rawData.length;
    return this.createTask(req);
  }

  /** Query the status of a file recognition task. */
  async describeTaskStatus(recTaskId: string): Promise<TaskStatus> {
    if (!recTaskId) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "recTaskId is empty");
    }

    const body = { RecTaskId: recTaskId };
    const respData = await this.doRequest("/v1/DescribeTaskStatus", body);

    const response = respData?.Response;
    if (!response) {
      throw new ASRError(ErrorCode.SERVER_ERROR, "empty response from server");
    }

    if (response.Error) {
      throw new ASRError(
        ErrorCode.SERVER_ERROR,
        `server error [${response.Error.Code || ""}]: ` +
          `${response.Error.Message || ""} ` +
          `(RequestId: ${response.RequestId || ""})`,
      );
    }

    if (!response.Data) {
      throw new ASRError(ErrorCode.SERVER_ERROR, "empty response from server");
    }

    return this.parseTaskStatus(response.Data);
  }

  /** Poll for results with default interval (1s) and timeout (10min). */
  async waitForResult(recTaskId: string): Promise<TaskStatus> {
    return this.waitForResultWithInterval(recTaskId, 1000, 600000);
  }

  /** Poll for results with custom interval and timeout (in milliseconds). */
  async waitForResultWithInterval(
    recTaskId: string,
    intervalMs: number,
    timeoutMs: number,
  ): Promise<TaskStatus> {
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const status = await this.describeTaskStatus(recTaskId);

      if (status.status === TaskStatusCode.SUCCESS) {
        return status;
      }
      if (status.status === TaskStatusCode.FAILED) {
        throw new ASRError(
          ErrorCode.SERVER_ERROR,
          `task failed: ${status.errorMsg} (RecTaskId: ${status.recTaskId})`,
        );
      }

      if (Date.now() > deadline) {
        throw new ASRError(
          ErrorCode.TIMEOUT,
          `task not completed within ${timeoutMs}ms ` +
            `(RecTaskId: ${recTaskId}, Status: ${status.statusStr})`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  private async doRequest(path: string, body: any): Promise<any> {
    const requestId = uuidv4();

    let userSig = this.credential.userSig;
    if (!userSig) {
      try {
        userSig = genUserSig(
          this.credential.sdkAppId,
          this.credential.secretKey,
          requestId,
          86400,
        );
      } catch (err) {
        throw new ASRError(
          ErrorCode.AUTH_FAILED,
          `generate user sig failed: ${err}`,
        );
      }
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const base = resolveHTTPEndpoint(this.endpoint, this.credential.site);
    const reqUrl =
      `${base}${path}` +
      `?AppId=${this.credential.appId}` +
      `&Secretid=${this.credential.appId}` +
      `&RequestId=${requestId}` +
      `&Timestamp=${timestamp}` +
      `&${sdkReportQuery()}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      "X-TRTC-SdkAppId": String(this.credential.sdkAppId),
      "X-TRTC-UserSig": userSig,
    };

    const jsonBody = JSON.stringify(body);

    let respBody: string;
    let statusCode: number;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);

      const resp = await fetch(reqUrl, {
        method: "POST",
        headers,
        body: jsonBody,
        signal: controller.signal,
      });

      clearTimeout(timer);
      statusCode = resp.status;
      respBody = await resp.text();
    } catch (err) {
      if (err instanceof ASRError) throw err;
      throw new ASRError(
        ErrorCode.CONNECT_FAILED,
        `http request failed: ${err}`,
      );
    }

    if (statusCode !== 200) {
      throw new ASRError(
        ErrorCode.SERVER_ERROR,
        `http status ${statusCode}: ${respBody}`,
      );
    }

    try {
      return JSON.parse(respBody);
    } catch (err) {
      throw new ASRError(
        ErrorCode.READ_FAILED,
        `unmarshal response failed: ${err}`,
      );
    }
  }

  private buildBody(req: CreateRecTaskRequest): Record<string, any> {
    const body: Record<string, any> = {
      EngineModelType: req.engineModelType,
      ChannelNum: req.channelNum,
      ResTextFormat: req.resTextFormat,
      SourceType: req.sourceType,
    };

    if (req.sourceType === FileSourceType.URL) {
      body.Url = req.url;
    } else {
      body.Data = req.data;
      body.DataLen = req.dataLen;
    }

    if (req.callbackUrl) body.CallbackUrl = req.callbackUrl;
    if (req.filterDirty) body.FilterDirty = req.filterDirty;
    if (req.filterModal) body.FilterModal = req.filterModal;
    if (req.filterPunc) body.FilterPunc = req.filterPunc;
    if (req.convertNumMode) body.ConvertNumMode = req.convertNumMode;
    if (req.hotwordId) body.HotwordId = req.hotwordId;
    if (req.hotwordList) body.HotwordList = req.hotwordList;
    if (req.customizationId) body.CustomizationId = req.customizationId;
    if (req.replaceTextId) body.ReplaceTextId = req.replaceTextId;
    if (req.language) body.Language = req.language;
    if (req.speakerDiarization) {
      body.SpeakerDiarization = req.speakerDiarization;
      if (req.speakerNumber) body.SpeakerNumber = req.speakerNumber;
    }
    // SpeakerRoles / VoiceprintIds only apply to the voiceprint role
    // authentication mode.
    if (req.speakerDiarization === 3) {
      if (req.speakerRoles && req.speakerRoles.length > 0) {
        body.SpeakerRoles = req.speakerRoles.map((r) => ({
          RoleName: r.roleName,
          AudioUrl: r.audioUrl,
        }));
      }
      if (req.voiceprintIds && req.voiceprintIds.length > 0) {
        body.VoiceprintIds = [...req.voiceprintIds];
      }
    }
    if (req.vadSilenceMs) body.VadSilenceMs = req.vadSilenceMs;
    // Explicit zeros must survive: undefined means "not configured" while 0
    // is a valid, meaningful value for both.
    if (req.vadLevel !== undefined) body.VadLevel = req.vadLevel;
    if (req.noiseThreshold !== undefined) {
      body.NoiseThreshold = req.noiseThreshold;
    }

    return body;
  }

  private parseTaskStatus(data: any): TaskStatus {
    const resultDetail: SentenceDetail[] = (data.ResultDetail || []).map(
      (sd: any) => ({
        finalSentence: sd.FinalSentence || "",
        sliceSentence: sd.SliceSentence || "",
        writtenText: sd.WrittenText || "",
        startMs: sd.StartMs || 0,
        endMs: sd.EndMs || 0,
        wordsNum: sd.WordsNum || 0,
        words: (sd.Words || []).map((w: any) => ({
          word: w.Word || "",
          offsetStartMs: w.OffsetStartMs || 0,
          offsetEndMs: w.OffsetEndMs || 0,
        })),
        speechSpeed: sd.SpeechSpeed || 0,
        silenceTime: sd.SilenceTime || 0,
        speakerId: sd.SpeakerId,
        speakerRoleName: sd.SpeakerRoleName,
        channelId: sd.ChannelId,
        language: sd.Language,
      }),
    );

    return {
      recTaskId: data.RecTaskId || "",
      status: data.Status || 0,
      statusStr: data.StatusStr || "",
      progress: data.Progress || 0,
      result: data.Result || "",
      errorMsg: data.ErrorMsg || "",
      resultDetail,
      audioDuration: data.AudioDuration || 0,
    };
  }

  private validateCreateRequest(req: CreateRecTaskRequest): void {
    if (!req) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "request is null");
    }
    if (!req.engineModelType) {
      throw new ASRError(
        ErrorCode.INVALID_PARAM,
        "engineModelType is required",
      );
    }
    if (req.channelNum <= 0) {
      throw new ASRError(
        ErrorCode.INVALID_PARAM,
        "channelNum must be positive",
      );
    }
    if (req.sourceType === FileSourceType.URL && !req.url) {
      throw new ASRError(
        ErrorCode.INVALID_PARAM,
        "url is required when sourceType=0",
      );
    }
    if (req.sourceType === FileSourceType.DATA && !req.data) {
      throw new ASRError(
        ErrorCode.INVALID_PARAM,
        "data is required when sourceType=1",
      );
    }
    validateSpeakerDiarization(
      req.speakerDiarization ?? 0,
      req.speakerNumber ?? 0,
      req.speakerRoles ?? [],
      req.voiceprintIds ?? [],
    );
    validateVadTuning(req.vadLevel ?? null, req.noiseThreshold ?? null);
  }
}
