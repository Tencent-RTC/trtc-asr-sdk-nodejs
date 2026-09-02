/**
 * One-shot sentence recognition client for TRTC-ASR.
 *
 * Usage:
 *   const credential = new Credential(appId, sdkAppId, secretKey);
 *   const recognizer = new SentenceRecognizer(credential);
 *   const result = await recognizer.recognizeData(data, "pcm", "16k_zh_en");
 */

import { v4 as uuidv4 } from "uuid";
import { Credential, resolveHTTPEndpoint } from "./credential";
import { ASRError, ErrorCode } from "./errors";
import { sdkReportQuery } from "./sdkinfo";
import { genUserSig } from "./usersig";

export const SENTENCE_ENDPOINT = "https://asr.cloud-rtc.com";

/** Audio source type. */
export const SourceType = {
  URL: 0,
  DATA: 1,
} as const;

/** JSON request body for sentence recognition. */
export interface SentenceRecognitionRequest {
  engServiceType: string;
  sourceType: number;
  voiceFormat: string;

  /** Audio URL (required when sourceType=0). */
  url?: string;
  /** Base64-encoded audio data (required when sourceType=1). */
  data?: string;
  /** Audio data length in bytes (required when sourceType=1). */
  dataLen?: number;

  /** Word-level timing: 0=hide, 1=show, 2=show with punctuation. */
  wordInfo?: number;
  /** Profanity filter: 0=off, 1=filter, 2=replace. */
  filterDirty?: number;
  /** Modal particle filter: 0=off, 1=partial, 2=strict. */
  filterModal?: number;
  /** Punctuation filter: 0=off, 2=filter all. */
  filterPunc?: number;
  /** Number conversion: 0=off, 1=smart (default). */
  convertNumMode?: number;
  /** Hotword vocabulary ID. */
  hotwordId?: string;
  /** Temporary inline hotword list. */
  hotwordList?: string;
  /** Custom language model ID. */
  customizationId?: string;
  /** PCM input sample rate override (e.g., 8000). */
  inputSampleRate?: number;
  /** Force the audio language on engines that support it (e.g. bigmodel). */
  language?: string;
}

/** Word-level timing information. */
export interface SentenceWord {
  word: string;
  startTime: number;
  endTime: number;
}

/** Recognition result from the API. */
export interface SentenceRecognitionResult {
  result: string;
  audioDuration: number;
  wordSize: number;
  wordList: SentenceWord[];
  requestId: string;
}

/** One-shot sentence recognition client using HTTP POST. */
export class SentenceRecognizer {
  private credential: Credential;
  private endpoint: string;
  private timeout: number; // ms

  constructor(credential: Credential) {
    this.credential = credential;
    this.endpoint = "";
    this.timeout = 30000;
  }

  /** Override the default API endpoint (for testing). */
  setEndpoint(endpoint: string): void {
    this.endpoint = endpoint;
  }

  /** Set HTTP request timeout in milliseconds. */
  setTimeout(timeout: number): void {
    this.timeout = timeout;
  }

  /** Send a sentence recognition request and return the result. */
  async recognize(
    req: SentenceRecognitionRequest,
  ): Promise<SentenceRecognitionResult> {
    this.validateRequest(req);

    const requestId = uuidv4();

    // Generate UserSig using requestId as user ID
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

    // Build URL with query parameters
    const timestamp = Math.floor(Date.now() / 1000);
    const base = resolveHTTPEndpoint(this.endpoint, this.credential.site);
    const reqUrl =
      `${base}/v1/SentenceRecognition` +
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

    const body = JSON.stringify(this.buildBody(req));

    // Use built-in fetch (Node.js 18+) or fallback to http
    let respBody: string;
    let statusCode: number;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);

      const resp = await fetch(reqUrl, {
        method: "POST",
        headers,
        body,
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

    // Parse response
    let respData: any;
    try {
      respData = JSON.parse(respBody);
    } catch (err) {
      throw new ASRError(
        ErrorCode.READ_FAILED,
        `unmarshal response failed: ${err}`,
      );
    }

    const response = respData?.Response;
    if (!response) {
      throw new ASRError(ErrorCode.SERVER_ERROR, "empty response from server");
    }

    // Check for API-level errors
    if (response.Error) {
      throw new ASRError(
        ErrorCode.SERVER_ERROR,
        `server error [${response.Error.Code || ""}]: ` +
          `${response.Error.Message || ""} ` +
          `(RequestId: ${response.RequestId || ""})`,
      );
    }

    return this.parseResult(response);
  }

  /** Convenience: recognize local audio data (auto base64 encoding). */
  async recognizeData(
    data: Buffer,
    voiceFormat: string,
    engineModelType: string,
  ): Promise<SentenceRecognitionResult> {
    if (!data || data.length === 0) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "audio data is empty");
    }
    if (data.length > 3 * 1024 * 1024) {
      throw new ASRError(
        ErrorCode.INVALID_PARAM,
        "audio data exceeds 3MB limit",
      );
    }

    return this.recognize({
      engServiceType: engineModelType,
      sourceType: SourceType.DATA,
      voiceFormat,
      data: data.toString("base64"),
      dataLen: data.length,
    });
  }

  /** Recognize local audio data with a pre-configured request. */
  async recognizeDataWithOptions(
    data: Buffer,
    req: SentenceRecognitionRequest,
  ): Promise<SentenceRecognitionResult> {
    if (!data || data.length === 0) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "audio data is empty");
    }
    if (data.length > 3 * 1024 * 1024) {
      throw new ASRError(
        ErrorCode.INVALID_PARAM,
        "audio data exceeds 3MB limit",
      );
    }

    req.sourceType = SourceType.DATA;
    req.data = data.toString("base64");
    req.dataLen = data.length;
    return this.recognize(req);
  }

  /** Convenience: recognize audio from a URL. */
  async recognizeURL(
    audioURL: string,
    voiceFormat: string,
    engineModelType: string,
  ): Promise<SentenceRecognitionResult> {
    if (!audioURL) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "audio URL is empty");
    }

    return this.recognize({
      engServiceType: engineModelType,
      sourceType: SourceType.URL,
      voiceFormat,
      url: audioURL,
    });
  }

  private buildBody(req: SentenceRecognitionRequest): Record<string, any> {
    const body: Record<string, any> = {
      EngSerViceType: req.engServiceType,
      SourceType: req.sourceType,
      VoiceFormat: req.voiceFormat,
    };

    if (req.sourceType === SourceType.URL) {
      body.Url = req.url;
    } else {
      body.Data = req.data;
      body.DataLen = req.dataLen;
    }

    if (req.wordInfo) body.WordInfo = req.wordInfo;
    if (req.filterDirty) body.FilterDirty = req.filterDirty;
    if (req.filterModal) body.FilterModal = req.filterModal;
    if (req.filterPunc) body.FilterPunc = req.filterPunc;
    if (req.convertNumMode !== undefined && req.convertNumMode !== 1) {
      body.ConvertNumMode = req.convertNumMode;
    }
    if (req.hotwordId) body.HotwordId = req.hotwordId;
    if (req.hotwordList) body.HotwordList = req.hotwordList;
    if (req.customizationId) body.CustomizationId = req.customizationId;
    if (req.inputSampleRate) body.InputSampleRate = req.inputSampleRate;
    if (req.language) body.Language = req.language;

    return body;
  }

  private parseResult(data: any): SentenceRecognitionResult {
    const wordList: SentenceWord[] = (data.WordList || []).map((w: any) => ({
      word: w.Word || "",
      startTime: w.StartTime || 0,
      endTime: w.EndTime || 0,
    }));

    return {
      result: data.Result || "",
      audioDuration: data.AudioDuration || 0,
      wordSize: data.WordSize || 0,
      wordList,
      requestId: data.RequestId || "",
    };
  }

  private validateRequest(req: SentenceRecognitionRequest): void {
    if (!req) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "request is null");
    }
    if (!req.engServiceType) {
      throw new ASRError(
        ErrorCode.INVALID_PARAM,
        "engServiceType is required",
      );
    }
    if (!req.voiceFormat) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "voiceFormat is required");
    }
    if (req.sourceType === SourceType.URL && !req.url) {
      throw new ASRError(
        ErrorCode.INVALID_PARAM,
        "url is required when sourceType=0",
      );
    }
    if (req.sourceType === SourceType.DATA && !req.data) {
      throw new ASRError(
        ErrorCode.INVALID_PARAM,
        "data is required when sourceType=1",
      );
    }
  }
}
