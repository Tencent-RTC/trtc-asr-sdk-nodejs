/**
 * Async audio file recognition client for the TRTC-ASR v3 protocol:
 * submit a task (POST /v3/create_transcription), then poll for results
 * (POST /v3/describe_transcription).
 */

import { v4 as uuidv4 } from "uuid";
import { Credential, resolveHTTPEndpoint } from "../credential";
import { ASRError, ErrorCode } from "../errors";
import { sdkReportParams } from "../sdkinfo";
import {
  AudioURLItem,
  Context,
  SOURCE_TYPE_DATA,
  SOURCE_TYPE_URL,
  SpeakerRole,
  TASK_STATUS_FAILED,
  TASK_STATUS_SUCCESS,
  Word,
  decodeFlatResponse,
  offlineEnvelope,
  serverError,
  validateAudioURLs,
  validateSpeakerDiarization,
} from "./wire";

export const FILE_ENDPOINT = "https://asr.cloud-rtc.com";

const CREATE_PATH = "/v3/create_transcription";
const DESCRIBE_PATH = "/v3/describe_transcription";

/** The params block of /v3/create_transcription (snake_case wire names). */
export interface CreateTranscriptionRequest {
  engine_model_type: string;
  channel_num: number;
  res_text_format: number;
  source_type: number;

  url?: string;
  data?: string;
  data_len?: number;

  /**
   * Distributed recording pieces (distributed speaker feature extraction).
   * When non-empty, sourceType/url/data must be left at their zero values
   * (sourceType=0, url/data empty) — the server rejects any combination of
   * audio_urls with a single-audio source.
   */
  audio_urls?: AudioURLItem[];

  callback_url?: string;

  speaker_diarization?: number;
  speaker_number?: number;
  voiceprint_ids?: string[];
  speaker_roles?: SpeakerRole[];

  hotword_id?: string;
  customization_id?: string;
  hotword_list?: string;
  keyword_lib_id_list?: string[];
  replace_text_id?: string;

  convert_num_mode?: number;
  filter_dirty?: number;
  filter_punc?: number;
  filter_modal?: number;

  sentence_max_length?: number;
  extra?: string;

  vad_silence_ms?: number;
  vad_level?: number;
  noise_threshold?: number;

  language?: string;

  context?: Context;
}

/** One sentence of a describe_transcription result. */
export interface SentenceDetail {
  final_sentence: string;
  slice_sentence: string;
  written_text: string;
  start_ms: number;
  end_ms: number;
  words_num: number;
  words: Word[];
  speech_speed: number;
  speaker_id: number;
  channel_id: number;
  speaker_role_name: string;
  silence_time: number;
  language: string;
  language_b47: string;
}

/** The flat /v3/describe_transcription response. */
export interface TranscriptionStatus {
  code: number;
  message: string;
  request_id: string;
  transcription_id: string;
  status: number;
  status_str: string;
  progress: number;
  audio_duration: number;
  result: string;
  result_detail: SentenceDetail[];
  error_msg: string;
}

/**
 * Async audio file recognition client. The task ID (transcription_id) is
 * valid for 24 hours and belongs to the v3 task space: a v1 RecTaskId cannot
 * be queried through this client and vice versa.
 */
export class FileRecognizer {
  private credential: Credential;
  private endpoint: string;
  private timeout: number; // ms

  constructor(credential: Credential) {
    this.credential = credential;
    this.endpoint = "";
    this.timeout = 60000;
  }

  setEndpoint(endpoint: string): void {
    this.endpoint = endpoint;
  }

  setTimeout(timeout: number): void {
    this.timeout = timeout;
  }

  /** Submit a file recognition task and return the transcription ID. */
  async createTask(req: CreateTranscriptionRequest): Promise<string> {
    this.validateCreateRequest(req);

    const requestId = uuidv4();
    const params: Record<string, unknown> = {
      ...req,
      sdk_info: sdkReportParams(),
    };
    const body = offlineEnvelope(this.credential, requestId, params);
    const respData = await this.post(CREATE_PATH, body);

    const code = respData.code ?? 0;
    if (code !== 0) {
      throw serverError(code, respData.message || "", respData.request_id || "");
    }
    const transcriptionID = respData.transcription_id || "";
    if (!transcriptionID) {
      throw new ASRError(ErrorCode.SERVER_ERROR, "empty transcription_id in response");
    }
    return transcriptionID;
  }

  /** Submit local audio data (auto base64). Max 5MB. */
  async createTaskFromData(data: Buffer, engineModelType: string): Promise<string> {
    if (!data || data.length === 0) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "audio data is empty");
    }
    if (data.length > 5 * 1024 * 1024) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "audio data exceeds 5MB limit");
    }
    return this.createTask({
      engine_model_type: engineModelType,
      channel_num: 1,
      res_text_format: 1,
      source_type: SOURCE_TYPE_DATA,
      data: data.toString("base64"),
      data_len: data.length,
    });
  }

  /** Submit an audio URL. Audio ≤12h, ≤1GB. */
  async createTaskFromURL(audioURL: string, engineModelType: string): Promise<string> {
    if (!audioURL) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "audio URL is empty");
    }
    return this.createTask({
      engine_model_type: engineModelType,
      channel_num: 1,
      res_text_format: 1,
      source_type: SOURCE_TYPE_URL,
      url: audioURL,
    });
  }

  /** Submit local audio data with a pre-configured request (mutated in
   * place). */
  async createTaskFromDataWithOptions(
    rawData: Buffer,
    req: CreateTranscriptionRequest,
  ): Promise<string> {
    if (!req) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "request is null");
    }
    if (!rawData || rawData.length === 0) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "audio data is empty");
    }
    if (rawData.length > 5 * 1024 * 1024) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "audio data exceeds 5MB limit");
    }
    req.source_type = SOURCE_TYPE_DATA;
    req.data = rawData.toString("base64");
    req.data_len = rawData.length;
    return this.createTask(req);
  }

  /** Query the status of a file recognition task. */
  async describeTask(transcriptionID: string): Promise<TranscriptionStatus> {
    if (!transcriptionID) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "transcriptionID is empty");
    }

    const requestId = uuidv4();
    const params = {
      transcription_id: transcriptionID,
      sdk_info: sdkReportParams(),
    };
    const body = offlineEnvelope(this.credential, requestId, params);
    const respData = await this.post(DESCRIBE_PATH, body);

    const code = respData.code ?? 0;
    if (code !== 0) {
      throw serverError(code, respData.message || "", respData.request_id || "");
    }

    return {
      code: code,
      message: respData.message || "",
      request_id: respData.request_id || "",
      transcription_id: respData.transcription_id || "",
      status: respData.status || 0,
      status_str: respData.status_str || "",
      progress: respData.progress || 0,
      audio_duration: respData.audio_duration || 0,
      result: respData.result || "",
      error_msg: respData.error_msg || "",
      result_detail: (respData.result_detail || []).map((sd: any) => ({
        final_sentence: sd.final_sentence || "",
        slice_sentence: sd.slice_sentence || "",
        written_text: sd.written_text || "",
        start_ms: sd.start_ms || 0,
        end_ms: sd.end_ms || 0,
        words_num: sd.words_num || 0,
        words: (sd.words || []).map((w: any) => ({
          word: w.word || "",
          start_time: w.start_time || 0,
          end_time: w.end_time || 0,
        })),
        speech_speed: sd.speech_speed || 0,
        speaker_id: sd.speaker_id || 0,
        channel_id: sd.channel_id || 0,
        speaker_role_name: sd.speaker_role_name || "",
        silence_time: sd.silence_time || 0,
        language: sd.language || "",
        language_b47: sd.language_b47 || "",
      })),
    };
  }

  /** Poll for results with default interval (1s) and timeout (10min). */
  async waitForResult(transcriptionID: string): Promise<TranscriptionStatus> {
    return this.waitForResultWithInterval(transcriptionID, 1000, 600000);
  }

  /** Poll for results with custom interval and timeout (in milliseconds). */
  async waitForResultWithInterval(
    transcriptionID: string,
    interval: number,
    timeout: number,
  ): Promise<TranscriptionStatus> {
    const deadline = Date.now() + timeout;

    for (;;) {
      const status = await this.describeTask(transcriptionID);

      if (status.status === TASK_STATUS_SUCCESS) {
        return status;
      }
      if (status.status === TASK_STATUS_FAILED) {
        throw new ASRError(
          ErrorCode.SERVER_ERROR,
          `task failed: ${status.error_msg} (transcription_id: ${status.transcription_id})`,
        );
      }

      if (Date.now() > deadline) {
        throw new ASRError(
          ErrorCode.TIMEOUT,
          `task not completed within ${timeout}ms (transcription_id: ${transcriptionID}, Status: ${status.status_str})`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  private async post(path: string, body: unknown): Promise<Record<string, any>> {
    const reqUrl = `${resolveHTTPEndpoint(this.endpoint, this.credential.site)}${path}`;

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

    return decodeFlatResponse(respBody, statusCode);
  }

  private validateCreateRequest(req: CreateTranscriptionRequest): void {
    if (!req) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "request is null");
    }
    if (!req.engine_model_type) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "engine_model_type is required");
    }
    if (req.channel_num !== 1 && req.channel_num !== 2) {
      throw new ASRError(ErrorCode.INVALID_PARAM, "channel_num must be 1 or 2");
    }
    if (![0, 1, 2, 3].includes(req.res_text_format)) {
      throw new ASRError(
        ErrorCode.INVALID_PARAM,
        `res_text_format must be one of [0, 1, 2, 3], got ${req.res_text_format}`,
      );
    }
    if (req.channel_num === 2 && req.speaker_diarization) {
      throw new ASRError(
        ErrorCode.INVALID_PARAM,
        "speaker_diarization is not supported for stereo (channel_num=2); sentences carry channel_id instead",
      );
    }
    if (req.audio_urls && req.audio_urls.length > 0) {
      // Distributed path: the server requires sourceType=0 with url/data
      // empty (rectask_cluster.go validateDistributedAudioUrlsRequest).
      validateAudioURLs(req.source_type, req.url || "", req.data || "", req.audio_urls);
    } else {
      if (req.source_type === SOURCE_TYPE_URL && !req.url) {
        throw new ASRError(ErrorCode.INVALID_PARAM, "url is required when source_type=0");
      }
      if (req.source_type === SOURCE_TYPE_DATA && !req.data) {
        throw new ASRError(ErrorCode.INVALID_PARAM, "data is required when source_type=1");
      }
    }
    if (req.speaker_diarization || req.speaker_roles?.length || req.voiceprint_ids?.length) {
      validateSpeakerDiarization(
        req.speaker_diarization || 0,
        req.speaker_number || 0,
        req.speaker_roles || [],
        req.voiceprint_ids || [],
      );
    }
    if (req.noise_threshold !== undefined && req.noise_threshold !== null) {
      if (!(req.noise_threshold >= 0 && req.noise_threshold <= 4)) {
        throw new ASRError(
          ErrorCode.INVALID_PARAM,
          `NoiseThreshold must be between 0.0 and 4.0, got ${req.noise_threshold}`,
        );
      }
    }
    if (req.vad_level !== undefined && req.vad_level !== null && req.vad_level !== 0) {
      if (req.vad_level !== 1) {
        throw new ASRError(
          ErrorCode.INVALID_PARAM,
          `VadLevel must be 0 (high recall) or 1 (far-field filtering), got ${req.vad_level}`,
        );
      }
    }
  }
}
