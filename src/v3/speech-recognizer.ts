/**
 * Real-time speech recognition client for the TRTC-ASR v3 protocol
 * (WebSocket /asr/v3).
 *
 * Protocol recap:
 *  1. Dial wss://{host}/asr/v3?voice_id=<id> — the URL carries only voice_id.
 *  2. Within 3s of the handshake, send one TEXT frame:
 *     {"type":"start","auth":{...},"params":{...}} (≤64KB).
 *  3. The server acks {"code":0,...} or fails with a structured error frame
 *     followed by a normal close.
 *  4. Stream audio as binary frames (≤256KB each), then send {"type":"end"}.
 *  5. Downlink result frames are identical to v2.
 *
 * start() waits synchronously for the acknowledgement, so authentication
 * (4002) and parameter errors (4001) surface from start() directly.
 */

import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";
import { Credential, resolveWSEndpoint } from "../credential";
import { ASRError, ErrorCode } from "../errors";
import {
  validateEnumOption,
  validateVadTuning,
} from "../params";
import { sdkReportParams } from "../sdkinfo";
import { genUserSig } from "../usersig";
import {
  Context,
  SPEAKER_CONTEXT_ACK_TIMEOUT_MS,
  SPEAKER_CONTEXT_SYNC,
  SPEAKER_DIARIZATION_VOICEPRINT,
  SpeakerContinue,
  SpeakerRole,
  START_FRAME_MAX_BYTES,
  STREAM_FRAME_MAX_BYTES,
  ACK_TIMEOUT_MS,
  validateSpeakerContext,
  validateSpeakerDiarization,
} from "./wire";

export const ENDPOINT = "wss://asr.cloud-rtc.com";

export const DEFAULT_WRITE_TIMEOUT = 5000;
const MIN_WRITE_TIMEOUT = 50;
const MAX_WRITE_TIMEOUT = 30000;

export const DEFAULT_STOP_TIMEOUT = 10000;
const MIN_STOP_TIMEOUT = 1000;
const MAX_STOP_TIMEOUT = 60000;

// Server-side accepted ranges (asr-proxy validator_v3.go).
const MAX_VOICE_ID_LEN = 128;
const MIN_MAX_SPEAK_TIME = 5000;
const MAX_MAX_SPEAK_TIME = 90000;
const MIN_VAD_SILENCE_TIME_MS = 240;
const MAX_VAD_SILENCE_TIME_MS = 2000;
const VALID_VOICE_FORMATS = [1, 4, 6, 8, 10, 11, 12, 14, 16];

enum State {
  IDLE = 0,
  STARTING = 1,
  RUNNING = 2,
  STOPPING = 3,
  STOPPED = 4,
}

/** Word-level recognition details (shape identical to v2). */
export interface WordInfo {
  word: string;
  start_time: number;
  end_time: number;
  stable_flag: number;
  speaker_id?: number;
  speaker_name?: string;
}

/** A contiguous section of one result attributed to a single speaker. */
export interface SpeakerSegment {
  speaker_id: number;
  speaker_name?: string;
  start_time: number;
  end_time: number;
  text?: string;
  word_start?: number;
  word_end?: number;
  stable_flag: number;
}

/** Speech recognition result details (shape identical to v2). */
export interface RecognitionResult {
  slice_type: number;
  index: number;
  start_time: number;
  end_time: number;
  voice_text_str: string;
  word_size: number;
  word_list: WordInfo[];
  language?: string;
  speaker_segments?: SpeakerSegment[];
  speaker_id?: number;
  finish_silence_ms?: number;
  last_token_runtime_ms?: number;
}

/** Response message from the ASR service (shape identical to v2). */
export interface SpeechRecognitionResponse {
  code: number;
  message: string;
  voice_id: string;
  message_id: string;
  final: number;
  result?: RecognitionResult;
  /** Speaker-context result of the first response, present only when the
   * session enabled the speaker context (see setEnableSpeakerContext); it
   * also reaches onRecognitionStart. */
  speaker_continue?: SpeakerContinue;
}

/** Callback interface for speech recognition events. */
export interface SpeechRecognitionListener {
  onRecognitionStart?(response: SpeechRecognitionResponse): void;
  onSentenceBegin?(response: SpeechRecognitionResponse): void;
  onRecognitionResultChange?(response: SpeechRecognitionResponse): void;
  onSentenceEnd?(response: SpeechRecognitionResponse): void;
  onRecognitionComplete?(response: SpeechRecognitionResponse): void;
  onFail?(response: SpeechRecognitionResponse | null, error: Error): void;
}

/**
 * Real-time speech recognition client for the v3 protocol.
 *
 * Lifecycle mirrors the v2 client: single-use instances, options configured
 * before start(), exception-shielded callbacks, re-entrant stop(). The v3
 * difference: start() waits synchronously for the server ack, so auth and
 * parameter errors are raised directly from start().
 */
export class SpeechRecognizer {
  private credential: Credential;
  private listener: SpeechRecognitionListener;
  private ws: WebSocket | null = null;

  private endpoint = "";
  private engineModelType: string;
  private voiceFormat = 1;
  private needVad = 1;
  private convertNumMode = 1;
  private hotwordId = "";
  private hotwordList = "";
  private filterDirty = 0;
  private filterModal = 0;
  private filterPunc = 0;
  private filterEmptyResult: number | null = null;
  private wordInfo = 0;
  private wordWithSpace = 0;
  private vadSilenceTime = 0;
  private vadLevel: number | null = null;
  private noiseThreshold: number | null = null;
  private maxSpeakTime = 0;
  private inputSampleRate = 0;
  private speakerDiarization = 0;
  private speakerNumber = 0;
  private speakerRoles: SpeakerRole[] = [];
  private voiceprintIds: string[] = [];
  private voiceId = "";
  private language = "";
  private context: Context | null = null;
  /** Speaker context ("断点续传"): requested mode (0/1/2) and the id issued by
   * an earlier session. */
  private enableSpeakerContext = 0;
  private speakerContextId = "";
  /** Handshake result of the first response, exposed via getSpeakerContinue(). */
  private speakerContinue: SpeakerContinue | null = null;

  private writeTimeout = DEFAULT_WRITE_TIMEOUT;
  private stopTimeout = DEFAULT_STOP_TIMEOUT;

  private state: State = State.IDLE;
  private doneResolve: (() => void) | null = null;
  private donePromise: Promise<void> | null = null;
  private finishDone = false;
  private callbackFailed = false;
  /** Set once the start-frame ack has been consumed; later messages go to
   * the dispatch pump. */
  private acked = false;

  constructor(
    credential: Credential,
    engineModelType: string,
    listener: SpeechRecognitionListener = {},
  ) {
    this.credential = credential;
    this.listener = listener;
    this.engineModelType = engineModelType;
  }

  // ---- Configuration setters ----

  setEndpoint(endpoint: string): void {
    this.endpoint = endpoint || "";
  }
  setVoiceFormat(format: number): void {
    this.voiceFormat = format;
  }
  /** Unlike the v2 transport, v3 honors an explicit 0 (sent on the wire). */
  setNeedVad(needVad: number): void {
    this.needVad = needVad;
  }
  /** Unlike the v2 transport, v3 honors an explicit 0. */
  setConvertNumMode(mode: number): void {
    this.convertNumMode = mode;
  }
  setHotwordId(id: string): void {
    this.hotwordId = id;
  }
  setHotwordList(list: string): void {
    this.hotwordList = list;
  }
  setFilterDirty(mode: number): void {
    this.filterDirty = mode;
  }
  setFilterModal(mode: number): void {
    this.filterModal = mode;
  }
  setFilterPunc(mode: number): void {
    this.filterPunc = mode;
  }
  setFilterEmptyResult(mode: number): void {
    this.filterEmptyResult = mode;
  }
  /** 0=off (default), 1=on, 2=with punctuation, 100=caption. */
  setWordInfo(mode: number): void {
    this.wordInfo = mode;
  }
  /** Whether English words are joined with spaces: 0=no (default), 1=yes. */
  setWordWithSpace(mode: number): void {
    this.wordWithSpace = mode;
  }
  setVadSilenceTime(ms: number): void {
    this.vadSilenceTime = ms;
  }
  setVadLevel(level: number): void {
    this.vadLevel = level;
  }
  setNoiseThreshold(threshold: number): void {
    this.noiseThreshold = threshold;
  }
  setMaxSpeakTime(ms: number): void {
    this.maxSpeakTime = ms;
  }
  setInputSampleRate(rate: number): void {
    this.inputSampleRate = rate;
  }
  setSpeakerDiarization(mode: number): void {
    this.speakerDiarization = mode;
  }
  setSpeakerNumber(n: number): void {
    this.speakerNumber = n;
  }
  /** Temporary voiceprints (v3 SpeakerRole, snake_case on the wire). */
  setSpeakerRoles(roles: SpeakerRole[]): void {
    this.speakerRoles = [...(roles || [])];
  }
  setVoiceprintIds(ids: string[]): void {
    this.voiceprintIds = [...(ids || [])];
  }
  /**
   * Make the speaker-diarization session resumable ("说话人分离断点续传") and
   * select how the server reports the handshake:
   *
   * - SPEAKER_CONTEXT_OFF (0, default) nothing is saved or returned;
   *   setSpeakerContextId is ignored.
   * - SPEAKER_CONTEXT_SYNC (1) the first response waits for the stored
   *   snapshot and reports the outcome through
   *   SpeakerContinue.continue_status.
   * - SPEAKER_CONTEXT_ASYNC (2) the first response answers immediately with
   *   the speaker_context_id only (no status) — keeps reconnects fast.
   *
   * Requires setSpeakerDiarization(1) or (3). See SpeakerContinue for the
   * reconnect workflow.
   */
  setEnableSpeakerContext(mode: number): void {
    this.enableSpeakerContext = mode;
  }

  /**
   * Pass back the speaker_context_id returned by a previous session
   * (SpeakerContinue.speaker_context_id) so this session resumes the same
   * speaker identities instead of numbering speakers from scratch.
   *
   * Only effective together with setEnableSpeakerContext(1) or (2). The
   * server ignores an expired or unknown id and starts a new session, so a
   * stale value does not fail the connection; always overwrite the stored id
   * with the one returned by the latest first response.
   */
  setSpeakerContextId(id: string): void {
    this.speakerContextId = (id || "").trim();
  }

  /**
   * Speaker-context result carried by the first response, or null when the
   * session did not enable the speaker context. Available once start()
   * resolves; also delivered to onRecognitionStart.
   */
  getSpeakerContinue(): SpeakerContinue | null {
    return this.speakerContinue;
  }

  setVoiceId(id: string): void {
    this.voiceId = id;
  }
  setLanguage(lang: string): void {
    this.language = lang;
  }
  setContext(context: Context | null): void {
    this.context = context;
  }
  setWriteTimeout(ms: number): void {
    if (ms <= 0) {
      ms = DEFAULT_WRITE_TIMEOUT;
    }
    this.writeTimeout = Math.min(Math.max(ms, MIN_WRITE_TIMEOUT), MAX_WRITE_TIMEOUT);
  }
  setStopTimeout(ms: number): void {
    if (ms <= 0) {
      ms = DEFAULT_STOP_TIMEOUT;
    }
    this.stopTimeout = Math.min(Math.max(ms, MIN_STOP_TIMEOUT), MAX_STOP_TIMEOUT);
  }

  // ---- Core operations ----

  /**
   * Connect, send the start frame and wait for the server ack. Auth (4002)
   * and parameter errors (4001) are raised here synchronously.
   */
  start(): Promise<void> {
    if (this.state !== State.IDLE) {
      return Promise.reject(
        new ASRError(ErrorCode.ALREADY_STARTED, "recognizer already started"),
      );
    }
    try {
      this.validateOptions();
    } catch (err) {
      return Promise.reject(err);
    }

    this.state = State.STARTING;
    this.acked = false;

    return new Promise<void>((resolve, reject) => {
      try {
        this.connect(resolve, reject);
      } catch (err) {
        this.state = State.IDLE;
        reject(
          err instanceof ASRError
            ? err
            : new ASRError(
                ErrorCode.CONNECT_FAILED,
                `websocket connect failed: ${err}`,
              ),
        );
      }
    });
  }

  /** Send one audio frame (binary, ≤256KB). */
  write(data: Buffer): Promise<void> {
    if (this.state === State.STOPPED || this.state === State.STOPPING) {
      return Promise.resolve();
    }
    if (this.state !== State.RUNNING) {
      return Promise.reject(
        new ASRError(ErrorCode.NOT_STARTED, "recognizer not running"),
      );
    }
    if (!this.ws) {
      return Promise.reject(
        new ASRError(ErrorCode.NOT_STARTED, "connection not established"),
      );
    }
    if (data.length > STREAM_FRAME_MAX_BYTES) {
      return Promise.reject(
        new ASRError(
          ErrorCode.INVALID_PARAM,
          `audio frame exceeds ${STREAM_FRAME_MAX_BYTES} bytes`,
        ),
      );
    }

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new ASRError(ErrorCode.WRITE_FAILED, "write timeout"));
      }, this.writeTimeout);
      this.ws!.send(data, (err) => {
        clearTimeout(timeout);
        if (err) {
          reject(
            new ASRError(
              ErrorCode.WRITE_FAILED,
              `write audio data failed: ${err.message}`,
            ),
          );
        } else {
          resolve();
        }
      });
    });
  }

  /** Gracefully stop: send {"type":"end"} and wait for the final response. */
  async stop(): Promise<void> {
    if (this.state === State.STOPPED) {
      return;
    }
    if (this.state === State.STOPPING) {
      if (this.donePromise) {
        await Promise.race([
          this.donePromise,
          new Promise<void>((resolve) => setTimeout(resolve, this.stopTimeout)),
        ]);
      }
      this.close();
      this.state = State.STOPPED;
      return;
    }
    if (this.state !== State.RUNNING) {
      throw new ASRError(ErrorCode.NOT_STARTED, "recognizer not running");
    }

    this.state = State.STOPPING;

    if (!this.ws) {
      this.state = State.STOPPED;
      throw new ASRError(ErrorCode.NOT_STARTED, "connection not established");
    }

    const ws = this.ws;
    try {
      await new Promise<void>((resolve, reject) => {
        const endMsg = JSON.stringify({ type: "end" });
        const timeout = setTimeout(() => {
          reject(new ASRError(ErrorCode.WRITE_FAILED, "send end signal timeout"));
        }, this.writeTimeout);
        ws.send(endMsg, (err) => {
          clearTimeout(timeout);
          if (err) {
            reject(
              new ASRError(
                ErrorCode.WRITE_FAILED,
                `send end signal failed: ${err.message}`,
              ),
            );
          } else {
            resolve();
          }
        });
      });
    } catch (err) {
      if (this.isStopped()) {
        return;
      }
      this.close();
      this.state = State.STOPPED;
      throw err;
    }

    if (this.donePromise) {
      await Promise.race([
        this.donePromise,
        new Promise<void>((resolve) => setTimeout(resolve, this.stopTimeout)),
      ]);
    }

    this.close();
    this.state = State.STOPPED;
  }

  // ---- Internal methods ----

  /**
   * Check the options that have a documented server-side range, mirroring
   * the proxy's v3 online validator so an invalid value fails locally
   * instead of coming back as a remote 4001.
   */
  private validateOptions(): void {
    if (this.voiceId.length > MAX_VOICE_ID_LEN) {
      throw new ASRError(
        ErrorCode.INVALID_PARAM,
        `VoiceID length must not exceed ${MAX_VOICE_ID_LEN}`,
      );
    }
    validateSpeakerDiarization(
      this.speakerDiarization,
      this.speakerNumber,
      this.speakerRoles as any,
      this.voiceprintIds,
    );
    validateSpeakerContext(this.enableSpeakerContext, this.speakerDiarization);
    validateVadTuning(this.vadLevel, this.noiseThreshold);
    if (this.maxSpeakTime !== 0) {
      validateEnumOption("MaxSpeakTime", this.maxSpeakTime, [
        ...Array(MAX_MAX_SPEAK_TIME - MIN_MAX_SPEAK_TIME + 1).keys(),
      ].map((i) => i + MIN_MAX_SPEAK_TIME));
    }
    // vadSilenceTime==0 means "not set"; the range check only applies to an
    // explicitly set value with VAD enabled, matching the server rule.
    if (this.vadSilenceTime !== 0 && this.needVad === 1) {
      if (
        this.vadSilenceTime < MIN_VAD_SILENCE_TIME_MS ||
        this.vadSilenceTime > MAX_VAD_SILENCE_TIME_MS
      ) {
        throw new ASRError(
          ErrorCode.INVALID_PARAM,
          `VadSilenceTime must be between ${MIN_VAD_SILENCE_TIME_MS} and ${MAX_VAD_SILENCE_TIME_MS} ms (needvad=1), got ${this.vadSilenceTime}`,
        );
      }
    }
    const checks: Array<[string, number, readonly number[]]> = [
      ["NeedVad", this.needVad, [0, 1]],
      ["ConvertNumMode", this.convertNumMode, [0, 1, 3]],
      ["FilterDirty", this.filterDirty, [0, 1, 2]],
      ["FilterModal", this.filterModal, [0, 1, 2]],
      ["FilterPunc", this.filterPunc, [0, 1]],
      ["WordInfo", this.wordInfo, [0, 1, 2, 100]],
      ["WordWithSpace", this.wordWithSpace, [0, 1]],
      ["VoiceFormat", this.voiceFormat, VALID_VOICE_FORMATS],
      ["InputSampleRate", this.inputSampleRate, [0, 8000]],
    ];
    for (const [name, value, allowed] of checks) {
      validateEnumOption(name, value, allowed);
    }
    if (this.filterEmptyResult !== null) {
      validateEnumOption("FilterEmptyResult", this.filterEmptyResult, [0, 1]);
    }
  }

  /** Assemble the snake_case params block. Unset options are omitted so the
   * server default applies; SDK-managed defaults (needvad/convert_num_mode/
   * voice_format) are always sent — including an explicit 0, which v3
   * honors. */
  private buildParams(): Record<string, unknown> {
    const params: Record<string, unknown> = {
      voice_id: this.voiceId,
      engine_model_type: this.engineModelType,
      voice_format: this.voiceFormat,
      needvad: this.needVad,
      convert_num_mode: this.convertNumMode,
      // SDK telemetry: the gateway replays the start frame byte-for-byte to
      // the worker, which ignores unknown keys, so it survives in server
      // dumps without disturbing the protocol.
      sdk_info: sdkReportParams(),
    };
    if (this.language) params.language = this.language;
    if (this.hotwordId) params.hotword_id = this.hotwordId;
    if (this.hotwordList) params.hotword_list = this.hotwordList;
    if (this.filterDirty) params.filter_dirty = this.filterDirty;
    if (this.filterModal) params.filter_modal = this.filterModal;
    if (this.filterPunc) params.filter_punc = this.filterPunc;
    if (this.filterEmptyResult !== null) params.filter_empty_result = this.filterEmptyResult;
    if (this.wordInfo) params.word_info = this.wordInfo;
    if (this.wordWithSpace) params.word_with_space = this.wordWithSpace;
    if (this.vadSilenceTime) params.vad_silence_time = this.vadSilenceTime;
    if (this.vadLevel !== null) params.vad_level = this.vadLevel;
    if (this.noiseThreshold !== null) params.noise_threshold = this.noiseThreshold;
    if (this.maxSpeakTime) params.max_speak_time = this.maxSpeakTime;
    if (this.inputSampleRate) params.input_sample_rate = this.inputSampleRate;
    if (this.speakerDiarization) {
      params.speaker_diarization = this.speakerDiarization;
      if (this.speakerNumber) params.speaker_number = this.speakerNumber;
    }
    if (this.speakerDiarization === SPEAKER_DIARIZATION_VOICEPRINT) {
      if (this.speakerRoles.length) params.speaker_roles = this.speakerRoles;
      if (this.voiceprintIds.length) params.voiceprint_ids = this.voiceprintIds;
    }
    // Speaker context ("断点续传") is only sent when the caller opted in; the
    // mode/diarization combination is validated locally.
    if (this.enableSpeakerContext) {
      params.enable_speaker_context = this.enableSpeakerContext;
      if (this.speakerContextId) params.speaker_context_id = this.speakerContextId;
    }
    if (this.context) {
      const wire: Record<string, unknown> = {};
      if (this.context.text) wire.text = this.context.text;
      if (this.context.terms?.length) wire.terms = this.context.terms;
      if (this.context.general?.length) wire.general = this.context.general;
      if (Object.keys(wire).length) params.context = wire;
    }
    return params;
  }

  private buildStartFrame(userSig: string): string {
    const frame = {
      type: "start",
      auth: {
        sdkappid: String(this.credential.sdkAppId),
        usersig: userSig,
      },
      params: this.buildParams(),
    };
    // Must be sent as a TEXT frame (a binary first frame is rejected by the
    // server with 4010) — hence a JSON string, not bytes.
    const data = JSON.stringify(frame);
    if (Buffer.byteLength(data, "utf-8") > START_FRAME_MAX_BYTES) {
      throw new ASRError(
        ErrorCode.INVALID_PARAM,
        `start frame exceeds ${START_FRAME_MAX_BYTES} bytes`,
      );
    }
    return data;
  }

  /** How long connect waits for the first response. Resuming a speaker
   * context in sync mode makes the server apply the stored snapshot before
   * answering; every other case answers immediately. */
  private ackTimeoutMs(): number {
    if (this.enableSpeakerContext === SPEAKER_CONTEXT_SYNC && this.speakerContextId) {
      return SPEAKER_CONTEXT_ACK_TIMEOUT_MS;
    }
    return ACK_TIMEOUT_MS;
  }

  private connect(resolve: () => void, reject: (err: Error) => void): void {
    if (!this.voiceId) {
      this.voiceId = uuidv4();
    }

    // Resolve UserSig locally without mutating the shared credential. The
    // v3 signature identifier is the voice_id.
    let userSig = this.credential.userSig;
    if (!userSig) {
      try {
        userSig = genUserSig(
          this.credential.sdkAppId,
          this.credential.secretKey,
          this.voiceId,
          86400,
        );
      } catch (err) {
        this.state = State.IDLE;
        reject(new ASRError(ErrorCode.AUTH_FAILED, `generate user sig failed: ${err}`));
        return;
      }
    }

    let frame: string;
    try {
      frame = this.buildStartFrame(userSig);
    } catch (err) {
      this.state = State.IDLE;
      reject(err as Error);
      return;
    }

    const base = resolveWSEndpoint(this.endpoint, this.credential.site);
    // The URL carries only voice_id; auth and params travel in the start
    // frame, so the handshake stays header-free and browser-friendly.
    const wsUrl = `${base}/asr/v3?voice_id=${encodeURIComponent(this.voiceId)}`;

    this.donePromise = new Promise<void>((res) => {
      this.doneResolve = res;
    });
    this.finishDone = false;

    const ws = new WebSocket(wsUrl, { handshakeTimeout: 10000 });
    this.ws = ws;

    let settled = false;
    const ackTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      this.state = State.IDLE;
      reject(
        new ASRError(ErrorCode.READ_FAILED, "read start ack failed: ack timeout"),
      );
    }, this.ackTimeoutMs());

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(ackTimer);
      fn();
    };

    ws.on("open", () => {
      // The start frame must go out within the server's 3s deadline; send
      // it as a TEXT frame.
      ws.send(frame, (err) => {
        if (err && !settled) {
          settle(() => {
            ws.close();
            this.state = State.IDLE;
            reject(
              new ASRError(
                ErrorCode.WRITE_FAILED,
                `send start frame failed: ${err.message}`,
              ),
            );
          });
        }
      });
    });

    ws.on("message", (data: WebSocket.Data) => {
      if (!this.acked) {
        this.handleAck(data, settle, resolve, reject);
        return;
      }
      this.handleMessage(data);
    });

    ws.on("error", (err) => {
      if (!settled) {
        settle(() => {
          this.state = State.IDLE;
          reject(
            new ASRError(
              ErrorCode.CONNECT_FAILED,
              `websocket connect failed: ${err.message}`,
            ),
          );
        });
        return;
      }
      if (this.state < State.STOPPING) {
        this.finish();
        this.safeCallback(
          () =>
            this.listener.onFail?.(
              null,
              new ASRError(ErrorCode.READ_FAILED, `read message failed: ${err.message}`),
            ),
          true,
        );
      }
      this.resolveDone();
    });

    ws.on("close", () => {
      if (!settled) {
        settle(() => {
          this.state = State.IDLE;
          reject(
            new ASRError(
              ErrorCode.READ_FAILED,
              "read start ack failed: connection closed",
            ),
          );
        });
        return;
      }
      if (this.state < State.STOPPING) {
        this.finish();
        this.safeCallback(
          () =>
            this.listener.onFail?.(
              null,
              new ASRError(
                ErrorCode.READ_FAILED,
                "websocket connection closed unexpectedly",
              ),
            ),
          true,
        );
      }
      this.resolveDone();
    });
  }

  /** Consume the start-frame ack: code!=0 → structured error; code==0 →
   * session starts (errors surfaced from start()). */
  private handleAck(
    data: WebSocket.Data,
    settle: (fn: () => void) => void,
    resolve: () => void,
    reject: (err: Error) => void,
  ): void {
    const text =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf-8")
          : "";
    let ack: any;
    try {
      ack = JSON.parse(text);
    } catch (err) {
      settle(() => {
        this.ws?.close();
        this.state = State.IDLE;
        reject(new ASRError(ErrorCode.SERVER_ERROR, `invalid start ack: ${err}`));
      });
      return;
    }

    const code = ack?.code ?? 0;
    if (code !== 0) {
      settle(() => {
        this.ws?.close();
        this.state = State.IDLE;
        reject(new ASRError(code, ack?.message || ""));
      });
      return;
    }

    // speaker_continue is present only when the session enabled the speaker
    // context; it carries the id to persist for a later resume.
    const speakerContinueData = ack?.speaker_continue;
    this.speakerContinue =
      speakerContinueData && typeof speakerContinueData === "object"
        ? {
            continue_status: speakerContinueData.continue_status ?? "",
            speaker_context_id: speakerContinueData.speaker_context_id ?? "",
          }
        : null;

    settle(() => {
      this.acked = true;
      this.state = State.RUNNING;
      this.safeCallback(() =>
        this.listener.onRecognitionStart?.({
          code: 0,
          message: "success",
          voice_id: this.voiceId,
          message_id: "",
          final: 0,
          // The ack itself is consumed here; re-attach the speaker context it
          // carried for callback-style callers.
          speaker_continue: this.speakerContinue ?? undefined,
        }),
      );
      // A frame that already carries a result (defensive) is dispatched now.
      if (ack?.result != null) {
        this.handleMessage(data);
      }
      resolve();
    });
  }

  private handleMessage(data: WebSocket.Data): void {
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (Buffer.isBuffer(data)) {
      text = data.toString("utf-8");
    } else {
      return;
    }

    let resp: SpeechRecognitionResponse;
    try {
      resp = JSON.parse(text);
    } catch (err) {
      this.safeCallback(
        () =>
          this.listener.onFail?.(
            null,
            new ASRError(ErrorCode.READ_FAILED, `unmarshal response failed: ${err}`),
          ),
        true,
      );
      return;
    }

    if (resp.code !== 0) {
      this.finish();
      this.safeCallback(
        () => this.listener.onFail?.(resp, new ASRError(resp.code, resp.message)),
        true,
      );
      this.resolveDone();
      return;
    }

    if (resp.final === 1) {
      this.finish();
      this.dispatchEvent(resp);
      if (!this.callbackFailed) {
        this.safeCallback(() => this.listener.onRecognitionComplete?.(resp), true);
      }
      this.resolveDone();
      return;
    }

    // Skip frames without a "result" object (defensive).
    if (!("result" in resp) || resp.result === null) {
      return;
    }

    this.dispatchEvent(resp);
  }

  private dispatchEvent(resp: SpeechRecognitionResponse): void {
    if (resp.final === 1 && resp.result?.slice_type !== 2) {
      return;
    }
    switch (resp.result?.slice_type) {
      case 0:
        this.safeCallback(() => this.listener.onSentenceBegin?.(resp));
        break;
      case 1:
        this.safeCallback(() => this.listener.onRecognitionResultChange?.(resp));
        break;
      case 2:
        this.safeCallback(() => this.listener.onSentenceEnd?.(resp));
        break;
    }
  }

  private finish(): void {
    if (this.isStopped()) {
      return;
    }
    this.state = State.STOPPED;
    this.close();
  }

  private isStopped(): boolean {
    return this.state === State.STOPPED;
  }

  private resolveDone(): void {
    if (this.finishDone) {
      return;
    }
    this.finishDone = true;
    if (this.doneResolve) {
      this.doneResolve();
      this.doneResolve = null;
    }
  }

  private safeCallback(fn: () => void, shield = false): boolean {
    try {
      const ret = fn() as unknown;
      if (ret && typeof (ret as { then?: unknown }).then === "function") {
        (ret as Promise<unknown>).catch((err) => {
          this.onListenerException(err, shield);
        });
      }
      return !this.callbackFailed;
    } catch (err) {
      this.onListenerException(err, shield);
      return false;
    }
  }

  private onListenerException(err: unknown, shield: boolean): void {
    if (shield || this.callbackFailed) {
      // eslint-disable-next-line no-console
      console.error("trtc-asr: listener callback raised, ignored:", err);
      return;
    }
    this.callbackFailed = true;
    this.finish();
    const stack = err instanceof Error && err.stack ? err.stack : String(err);
    this.safeCallback(
      () =>
        this.listener.onFail?.(
          null,
          new ASRError(
            ErrorCode.READ_FAILED,
            `recovered from panic in listener callback: ${err}\n${stack}`,
          ),
        ),
      true,
    );
    this.resolveDone();
  }

  private close(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}
