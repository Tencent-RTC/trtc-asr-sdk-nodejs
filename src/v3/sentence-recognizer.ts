/**
 * One-shot sentence recognition client for the TRTC-ASR v3 protocol
 * (POST /v3/transcribe): {"auth": ...,"params": ...} body, flat snake_case
 * response, numeric codes.
 */

import { v4 as uuidv4 } from "uuid";
import { Credential, resolveHTTPEndpoint } from "../credential";
import { ASRError, ErrorCode } from "../errors";
import { sdkReportParams } from "../sdkinfo";
import {
  Context,
  SOURCE_TYPE_DATA,
  SOURCE_TYPE_URL,
  Word,
  decodeFlatResponse,
  offlineEnvelope,
  serverError,
  validateSpeakerDiarization,
} from "./wire";

export const SENTENCE_ENDPOINT = "https://asr.cloud-rtc.com";

const OFFLINE_PATH = "/v3/transcribe";

/** The params block of /v3/transcribe (snake_case wire names). */
export interface TranscribeRequest {
  engine_model_type: string;
  source_type: number;
  voice_format: string;

  url?: string;
  data?: string;
  data_len?: number;

  word_info?: number;
  filter_dirty?: number;
  filter_modal?: number;
  filter_punc?: number;
  convert_num_mode?: number;
  hotword_id?: string;
  customization_id?: string;
  hotword_list?: string;
  input_sample_rate?: number;

  /** None/undefined leaves the server default; an explicit 0/1 is honored. */
  needvad?: number;
  vad_silence_time?: number;

  language?: string;

  speaker_diarization?: number;
  speaker_number?: number;

  context?: Context;
}

/** The flat /v3/transcribe response. */
export interface TranscribeResponse {
  code: number;
  message: string;
  request_id: string;
  result: string;
  audio_duration: number;
  language: string;
  language_b47: string;
  word_size: number;
  word_list: Word[];
}

/** One-shot sentence recognition client (POST /v3/transcribe). */
export class SentenceRecognizer {
  private credential: Credential;
  private endpoint: string;
  private timeout: number; // ms

  constructor(credential: Credential) {
    this.credential = credential;
    this.endpoint = "";
    this.timeout = 30000;
  }

  setEndpoint(endpoint: string): void {
    this.endpoint = endpoint;
  }

  setTimeout(timeout: number): void {
    this.timeout = timeout;
  }

  /** Send a sentence recognition request. A non-zero server code is raised
   * as an ASRError carrying that code; auth failures arrive with HTTP 200
   * (body code 4002) — handled here. */
  async recognize(req: TranscribeRequest): Promise<TranscribeResponse> {
    this.validateRequest(req);

    const requestId = uuidv4();
    const params: Record<string, unknown> = {
      ...req,
      sdk_info: sdkReportParams(),
    };
    const body = offlineEnvelope(this.credential, requestId, params);

    const reqUrl = `${resolveHTTPEndpoint(this.endpoint, this.credential.site)}${OFFLINE_PATH}`;

    let respBody: string;
    let statusCode: number;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      const resp = await fetch(reqUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      statusCode = resp.status;
      respBody = await resp.text();
    } catch (err) {
      if (err instanceof ASRError) throw err;
      throw new ASRError(ErrorCode.CONNECT_FAILED, `http request failed: ${err}`);
    }

    const respData = decodeFlatResponse(respBody, statusCode);
    const code = respData.code ?? 0;
    if (code !== 0) {
      throw serverError(code, respData.message || "", respData.request_id || "");
    }

    return {
      code: code,
      message: respData.message || "",
      request_id: respData.request_id || "",
      result: respData.result || "",
      audio_duration: respData.audio_duration || 0,
      language: respData.language || "",
      language_b47: respData.language_b47 || "",
      word_size: respData.word_size || 0,
      word_list: (respData.word_list || []).map((w: any) => ({
        word: w.word || "",
        start_time: w.start_time || 0,
        end_time: w.end_time || 0,
      })),
    };
  }

  /** Convenience: recognize local audio data (auto base64). Max 3MB / 60s. */
  async recognizeData(
    data: Buffer,
    voiceFormat: string,
    engineModelType: string,
  ): Promise<TranscribeResponse> {
    if (!data || data.length === 0) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "audio data is empty");
    }
    if (data.length > 3 * 1024 * 1024) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "audio data exceeds 3MB limit");
    }
    return this.recognize({
      engine_model_type: engineModelType,
      source_type: SOURCE_TYPE_DATA,
      voice_format: voiceFormat,
      data: data.toString("base64"),
      data_len: data.length,
    });
  }

  /** Recognize local audio data with a pre-configured request (mutated in
   * place). */
  async recognizeDataWithOptions(
    data: Buffer,
    req: TranscribeRequest,
  ): Promise<TranscribeResponse> {
    if (!req) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "request is null");
    }
    if (!data || data.length === 0) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "audio data is empty");
    }
    if (data.length > 3 * 1024 * 1024) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "audio data exceeds 3MB limit");
    }
    req.source_type = SOURCE_TYPE_DATA;
    req.data = data.toString("base64");
    req.data_len = data.length;
    return this.recognize(req);
  }

  /** Convenience: recognize audio from a URL. */
  async recognizeURL(
    audioURL: string,
    voiceFormat: string,
    engineModelType: string,
  ): Promise<TranscribeResponse> {
    if (!audioURL) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "audio URL is empty");
    }
    return this.recognize({
      engine_model_type: engineModelType,
      source_type: SOURCE_TYPE_URL,
      voice_format: voiceFormat,
      url: audioURL,
    });
  }

  private validateRequest(req: TranscribeRequest): void {
    if (!req) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "request is null");
    }
    if (!req.engine_model_type) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "engine_model_type is required");
    }
    if (!req.voice_format) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "voice_format is required");
    }
    if (req.source_type === SOURCE_TYPE_URL && !req.url) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "url is required when source_type=0");
    }
    if (req.source_type === SOURCE_TYPE_DATA && !req.data) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "data is required when source_type=1");
    }
    if (req.speaker_diarization || req.speaker_number) {
      validateSpeakerDiarization(req.speaker_diarization || 0, req.speaker_number || 0, [], []);
    }
    if (req.needvad !== undefined && req.needvad !== null) {
      if (req.needvad !== 0 && req.needvad !== 1) {
        throw new ASRError(ErrorCode.INVALID_PARAM, `needvad must be one of [0, 1], got ${req.needvad}`);
      }
    }
    // 8000 is the only supported override; 0 means "use the engine rate".
    if (req.input_sample_rate !== 0 && req.input_sample_rate !== undefined) {
      if (req.input_sample_rate !== 8000) {
        throw new ASRError(
          ErrorCode.INVALID_PARAM,
          `input_sample_rate must be one of [0, 8000], got ${req.input_sample_rate}`,
        );
      }
    }
  }
}
