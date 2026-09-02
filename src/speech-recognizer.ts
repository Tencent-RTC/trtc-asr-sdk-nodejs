/**
 * Real-time speech recognition client for TRTC-ASR.
 */

import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";
import { Credential } from "./credential";
import { ASRError, ErrorCode } from "./errors";
import {
  validateEnumOption,
  validateSpeakerDiarization,
  validateVadTuning,
} from "./params";
import {
  SignatureParams,
  SpeakerRole,
} from "./signature";
import { genUserSig } from "./usersig";

export const ENDPOINT = "wss://asr.cloud-rtc.com";

// Write-timeout bounds (ms). A single write is bounded by writeTimeout, so
// stop()'s worst-case wait to send the end signal is bounded as well.
// Clamping keeps stop()'s exit time predictable.
export const DEFAULT_WRITE_TIMEOUT = 5000;
const MIN_WRITE_TIMEOUT = 50;
const MAX_WRITE_TIMEOUT = 30000;

// Stop-timeout bounds (ms). stopTimeout caps how long stop() waits for the
// server's final response after the end signal before forcing the connection
// closed.
export const DEFAULT_STOP_TIMEOUT = 10000;
const MIN_STOP_TIMEOUT = 1000;
const MAX_STOP_TIMEOUT = 60000;

enum State {
  IDLE = 0,
  STARTING = 1,
  RUNNING = 2,
  STOPPING = 3,
  STOPPED = 4,
}

/** Word-level recognition details. */
export interface WordInfo {
  word: string;
  start_time: number;
  end_time: number;
  stable_flag: number;

  /**
   * Speaker of this word, filled when speaker diarization is enabled
   * together with word_info != 0. Valid IDs start at 1, -1 means unknown,
   * 0 means absent.
   */
  speaker_id?: number;

  /** Enrolled role name, returned only with speaker_diarization=3. */
  speaker_name?: string;
}

/**
 * A contiguous section of one result attributed to a single speaker.
 * Returned when speaker diarization is enabled.
 */
export interface SpeakerSegment {
  /** Speaker number within the current session; -1 means unknown. */
  speaker_id: number;

  /** Enrolled role name, returned only with speaker_diarization=3. */
  speaker_name?: string;

  start_time: number;
  end_time: number;
  text?: string;

  /**
   * Inclusive indexes into RecognitionResult.word_list, i.e.
   * word_list[word_start .. word_end]. Both are absent when word_info=0
   * (no word list to index into); 0 is a valid index.
   */
  word_start?: number;
  word_end?: number;

  /** Whether this segment is stable: 1=stable, 0=not. */
  stable_flag: number;
}

/** Speech recognition result details. */
export interface RecognitionResult {
  slice_type: number;
  index: number;
  start_time: number;
  end_time: number;
  voice_text_str: string;
  word_size: number;
  word_list: WordInfo[];

  /** Detected language (bigmodel engine, e.g. "Malay"), when reported. */
  language?: string;

  /**
   * Speaker attribution of this result, split by speaker turn. It is the
   * recommended entry point for speaker diarization: one result may contain
   * several speakers, so a sentence-level speaker is ambiguous by design.
   * Empty when diarization is disabled.
   *
   * A result is single-speaker when speaker_segments?.length === 1.
   */
  speaker_segments?: SpeakerSegment[];

  /**
   * Legacy sentence-level speaker attribution. Absent on most engines;
   * prefer speaker_segments / WordInfo.speaker_id.
   */
  speaker_id?: number;

  /** Trailing silence (ms) that triggered the sentence break, when reported. */
  finish_silence_ms?: number;

  /** Server-side decoding time (ms) of the last token, when reported. */
  last_token_runtime_ms?: number;
}

/** Response message from the ASR service. */
export interface SpeechRecognitionResponse {
  code: number;
  message: string;
  voice_id: string;
  message_id: string;
  final: number;
  result?: RecognitionResult;
}

/** Callback interface for speech recognition events. */
export interface SpeechRecognitionListener {
  onRecognitionStart(response: SpeechRecognitionResponse): void;
  onSentenceBegin(response: SpeechRecognitionResponse): void;
  onRecognitionResultChange(response: SpeechRecognitionResponse): void;
  onSentenceEnd(response: SpeechRecognitionResponse): void;
  onRecognitionComplete(response: SpeechRecognitionResponse): void;
  onFail(response: SpeechRecognitionResponse | null, error: Error): void;
}

/**
 * Real-time speech recognition client using WebSocket.
 *
 * Lifecycle:
 * - A SpeechRecognizer is single-use: once it reaches the stopped state
 *   (via stop() or a terminal error) it cannot be restarted. Create a new
 *   instance to reconnect.
 * - All setXxx options must be configured before start().
 * - Recognition callbacks are delivered synchronously on the WebSocket
 *   message pump; a faulty callback never crashes the loop (exceptions are
 *   swallowed and logged, mirroring the Go SDK's panic shielding).
 */
export class SpeechRecognizer {
  private credential: Credential;
  private listener: SpeechRecognitionListener;
  private ws: WebSocket | null = null;

  private endpoint = ENDPOINT;
  private engineModelType: string;
  private voiceFormat = 1; // PCM
  private needVad = 1;
  private convertNumMode = 1;
  private hotwordId = "";
  private hotwordList = "";
  private customizationId = "";
  private replaceTextId = "";
  private filterDirty = 0;
  private filterModal = 0;
  private filterPunc = 0;
  private filterEmptyResult: number | null = null;
  private wordInfo = 0;
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

  private writeTimeout = DEFAULT_WRITE_TIMEOUT; // ms
  private stopTimeout = DEFAULT_STOP_TIMEOUT; // ms

  private state: State = State.IDLE;
  private doneResolve: (() => void) | null = null;
  private donePromise: Promise<void> | null = null;
  private finishDone = false;

  constructor(
    credential: Credential,
    engineModelType: string,
    listener: SpeechRecognitionListener,
  ) {
    this.credential = credential;
    this.listener = listener;
    this.engineModelType = engineModelType;
  }

  // ---- Configuration setters ----

  setVoiceFormat(format: number): void {
    this.voiceFormat = format;
  }
  setNeedVad(needVad: number): void {
    this.needVad = needVad;
  }
  setConvertNumMode(mode: number): void {
    this.convertNumMode = mode;
  }
  setHotwordId(id: string): void {
    this.hotwordId = id;
  }
  /**
   * Set a temporary inline hotword list, which does not require creating a
   * hotword table on the console.
   *
   * Format: "word1|weight1,word2|weight2". Each word is at most 30 bytes and
   * the weight must be 1-11 (11 = super hotword) or 100 (homophone
   * replacement).
   */
  setHotwordList(list: string): void {
    this.hotwordList = list;
  }
  setCustomizationId(id: string): void {
    this.customizationId = id;
  }
  /** Set the replacement word table ID used for forced text replacement. */
  setReplaceTextId(id: string): void {
    this.replaceTextId = id;
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
  /**
   * Set whether empty recognition results are delivered.
   * 0: deliver empty results, 1: skip them (server default).
   *
   * Calling this method makes the choice explicit on the wire, so passing 0
   * is honored instead of falling back to the server default.
   */
  setFilterEmptyResult(mode: number): void {
    this.filterEmptyResult = mode;
  }
  /**
   * Set word-level timing: 0=off (default), 1=on, 2=with punctuation.
   *
   * Word-level speaker attribution (WordInfo.speaker_id) requires a non-zero
   * value together with setSpeakerDiarization.
   */
  setWordInfo(mode: number): void {
    this.wordInfo = mode;
  }
  setVadSilenceTime(ms: number): void {
    this.vadSilenceTime = ms;
  }
  /**
   * Select the VAD profile: 0 = high recall, 1 = far-field noise filtering
   * (server default).
   *
   * Calling this method makes the choice explicit on the wire, so passing 0
   * is honored instead of falling back to the server default.
   */
  setVadLevel(level: number): void {
    this.vadLevel = level;
  }
  /**
   * Fine-tune VAD noise suppression. Valid range: [0, 4]; larger values
   * suppress more noise at the cost of recall. When set, it overrides the
   * profile selected by setVadLevel.
   *
   * The value is only sent when this method is called, because 0 is a valid,
   * meaningful threshold and cannot be distinguished from "unset" otherwise.
   */
  setNoiseThreshold(threshold: number): void {
    this.noiseThreshold = threshold;
  }
  setMaxSpeakTime(ms: number): void {
    this.maxSpeakTime = ms;
  }
  /**
   * Declare the sample rate of the incoming PCM audio. Only 8000 is
   * supported, which lets an 8kHz stream be fed to a 16k engine (the server
   * upsamples it).
   */
  setInputSampleRate(rate: number): void {
    this.inputSampleRate = rate;
  }
  /**
   * Enable real-time speaker diarization.
   *
   * - SPEAKER_DIARIZATION_OFF (0): disabled (default)
   * - SPEAKER_DIARIZATION_CLUSTER (1): anonymous clustering; speakers are
   *   numbered from 1 within the session, -1 = unknown
   * - SPEAKER_DIARIZATION_VOICEPRINT (3): voiceprint role authentication;
   *   combine with setSpeakerRoles / setVoiceprintIds to get role names back
   *   in speaker_name
   *
   * Results are reported through result.speaker_segments, and additionally
   * through WordInfo.speaker_id when word info is non-zero.
   */
  setSpeakerDiarization(mode: number): void {
    this.speakerDiarization = mode;
  }
  /**
   * Hint the expected number of speakers. 0 means auto detection (default).
   * It applies to both diarization modes: the server feeds it into the
   * online clustering.
   */
  setSpeakerNumber(n: number): void {
    this.speakerNumber = n;
  }
  /**
   * Register temporary voiceprints for this session. Each role carries a
   * name and the URL of its enrollment audio; the name is echoed back as
   * speaker_name on matched words and speaker segments.
   *
   * Only used when speaker diarization is set to voiceprint mode. The list
   * is copied, so later mutations by the caller do not affect the session.
   */
  setSpeakerRoles(roles: SpeakerRole[]): void {
    this.speakerRoles = [...(roles || [])];
  }
  /**
   * Register previously enrolled voiceprints by ID for this session.
   * Only used when speaker diarization is set to voiceprint mode.
   * The list is copied.
   */
  setVoiceprintIds(ids: string[]): void {
    this.voiceprintIds = [...(ids || [])];
  }
  setVoiceId(id: string): void {
    this.voiceId = id;
  }
  /**
   * Set the language hint for the bigmodel engine (e.g. "ms", "zh", "auto").
   * It is transparently forwarded to the server as the "language" query
   * parameter.
   */
  setLanguage(lang: string): void {
    this.language = lang;
  }
  /**
   * Set the timeout for a single audio write, in milliseconds.
   *
   * The value is clamped to [50, 30000]; a non-positive value resets it to
   * the default. Because stop() must send the end signal after any in-flight
   * write, an unbounded write timeout would let a blocked write delay stop()
   * indefinitely — clamping keeps stop()'s worst-case exit time predictable.
   */
  setWriteTimeout(ms: number): void {
    if (ms <= 0) {
      ms = DEFAULT_WRITE_TIMEOUT;
    }
    this.writeTimeout = Math.min(Math.max(ms, MIN_WRITE_TIMEOUT), MAX_WRITE_TIMEOUT);
  }
  /**
   * Set how long stop() waits for the server's final response after sending
   * the end signal before forcing the connection closed, in milliseconds.
   *
   * The value is clamped to [1000, 60000]; a non-positive value resets it to
   * the default.
   */
  setStopTimeout(ms: number): void {
    if (ms <= 0) {
      ms = DEFAULT_STOP_TIMEOUT;
    }
    this.stopTimeout = Math.min(Math.max(ms, MIN_STOP_TIMEOUT), MAX_STOP_TIMEOUT);
  }

  // ---- Core operations ----

  /** Initiate the WebSocket connection and begin the recognition session. */
  start(): Promise<void> {
    if (this.state !== State.IDLE) {
      return Promise.reject(
        new ASRError(ErrorCode.ALREADY_STARTED, "recognizer already started"),
      );
    }

    // Validate before dialing so an invalid option fails locally instead of
    // costing a connection and coming back as a server-side 4001.
    try {
      this.validateOptions();
    } catch (err) {
      return Promise.reject(err);
    }

    this.state = State.STARTING;

    return new Promise<void>((resolve, reject) => {
      try {
        this.connect(resolve, reject);
      } catch (err) {
        this.state = State.IDLE;
        reject(
          new ASRError(
            ErrorCode.CONNECT_FAILED,
            `websocket connect failed: ${err}`,
          ),
        );
      }
    });
  }

  /** Send audio data to the ASR service. */
  write(data: Buffer): Promise<void> {
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

  /**
   * Gracefully stop the recognition session.
   *
   * It sends the end signal and waits for the server's final response (up to
   * stopTimeout) before forcing the connection closed.
   *
   * For terminal callbacks (onRecognitionComplete / terminal onFail), the
   * recognizer has already advanced to stopped before callback dispatch, so
   * stop() rejects immediately with not-running.
   */
  async stop(): Promise<void> {
    if (this.state !== State.RUNNING) {
      throw new ASRError(ErrorCode.NOT_STARTED, "recognizer not running");
    }

    this.state = State.STOPPING;

    if (!this.ws) {
      this.state = State.STOPPED;
      throw new ASRError(ErrorCode.NOT_STARTED, "connection not established");
    }

    // Send end signal
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
      // The read loop may have reached a terminal response while the end
      // signal was in flight (async state change invisible to the compiler's
      // control-flow analysis); in that case stop() is already satisfied.
      if (this.isStopped()) {
        return;
      }
      this.close();
      this.state = State.STOPPED;
      throw err;
    }

    // Wait for the read loop to finish with timeout
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

  /** Check the options that have a documented server-side range. */
  private validateOptions(): void {
    validateSpeakerDiarization(
      this.speakerDiarization,
      this.speakerNumber,
      this.speakerRoles,
      this.voiceprintIds,
    );
    validateVadTuning(this.vadLevel, this.noiseThreshold);
    if (this.filterEmptyResult !== null) {
      validateEnumOption("FilterEmptyResult", this.filterEmptyResult, [0, 1]);
    }
    // 8000 is the only supported override; 0 means "use the engine rate".
    validateEnumOption("InputSampleRate", this.inputSampleRate, [0, 8000]);
  }

  private connect(resolve: () => void, reject: (err: Error) => void): void {
    if (!this.voiceId) {
      this.voiceId = uuidv4();
    }

    // Resolve UserSig locally without mutating the shared credential.
    // Writing back to credential.userSig would race when a single Credential
    // is shared by multiple recognizers started concurrently. This mirrors
    // how the sentence / file recognizers resolve the signature.
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
        reject(
          new ASRError(
            ErrorCode.AUTH_FAILED,
            `generate user sig failed: ${err}`,
          ),
        );
        return;
      }
    }

    // Build request parameters. Authentication identity (sdkappid + usersig)
    // travels in the query string instead of headers, so browser WebSocket
    // clients work without header support; the gateway reads these query
    // parameters when the corresponding headers are absent.
    const sigParams = new SignatureParams({
      appId: this.credential.appId,
      engineModelType: this.engineModelType,
      voiceId: this.voiceId,
      voiceFormat: this.voiceFormat,
      needVad: this.needVad,
      convertNumMode: this.convertNumMode,
      sdkAppId: this.credential.sdkAppId,
      hotwordId: this.hotwordId,
      hotwordList: this.hotwordList,
      customizationId: this.customizationId,
      replaceTextId: this.replaceTextId,
      filterDirty: this.filterDirty,
      filterModal: this.filterModal,
      filterPunc: this.filterPunc,
      filterEmptyResult:
        this.filterEmptyResult === null ? undefined : this.filterEmptyResult,
      wordInfo: this.wordInfo,
      vadSilenceTime: this.vadSilenceTime,
      vadLevel: this.vadLevel === null ? undefined : this.vadLevel,
      noiseThreshold:
        this.noiseThreshold === null ? undefined : this.noiseThreshold,
      maxSpeakTime: this.maxSpeakTime,
      inputSampleRate: this.inputSampleRate,
      speakerDiarization: this.speakerDiarization,
      speakerNumber: this.speakerNumber,
      speakerRoles: this.speakerRoles,
      voiceprintIds: this.voiceprintIds,
      language: this.language,
    });

    const queryString = sigParams.buildQueryStringWithSignature(userSig);
    const wsUrl = `${this.endpoint}/asr/v2/${this.credential.appId}?${queryString}`;

    this.donePromise = new Promise<void>((res) => {
      this.doneResolve = res;
    });
    this.finishDone = false;

    // No custom headers: the handshake relies on the query string only,
    // which also keeps native browser WebSocket usable.
    this.ws = new WebSocket(wsUrl, {
      handshakeTimeout: 10000,
    });

    this.ws.on("open", () => {
      this.state = State.RUNNING;
      // Signal the session start once, before any message (mirrors the Go
      // readLoop entry).
      this.safeCallback(() =>
        this.listener.onRecognitionStart({
          code: 0,
          message: "success",
          voice_id: this.voiceId,
          message_id: "",
          final: 0,
        }),
      );
      resolve();
    });

    this.ws.on("error", (err) => {
      if (this.state === State.STARTING) {
        this.state = State.IDLE;
        reject(
          new ASRError(
            ErrorCode.CONNECT_FAILED,
            `websocket connect failed: ${err.message}`,
          ),
        );
      }
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      this.handleMessage(data);
    });

    this.ws.on("close", () => {
      if (this.state < State.STOPPING) {
        // Terminal: finish the lifecycle before notifying, so a stop() /
        // write() call from inside onFail sees the stopped state.
        this.finish();
        this.safeCallback(() =>
          this.listener.onFail(
            null,
            new ASRError(
              ErrorCode.READ_FAILED,
              "websocket connection closed unexpectedly",
            ),
          ),
        );
      }
      this.resolveDone();
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
      // Non-terminal: the session continues.
      this.safeCallback(() =>
        this.listener.onFail(
          null,
          new ASRError(ErrorCode.READ_FAILED, `unmarshal response failed: ${err}`),
        ),
      );
      return;
    }

    if (resp.code !== 0) {
      // Terminal: finish the lifecycle before notifying, so a stop()/write()
      // call from inside onFail sees the stopped state.
      this.finish();
      this.safeCallback(() =>
        this.listener.onFail(resp, new ASRError(resp.code, resp.message)),
      );
      this.resolveDone();
      return;
    }

    // Check if recognition is complete before dispatching the terminal
    // response. A final=1 response can still carry slice_type=2, which
    // dispatches onSentenceEnd; finish first so stop()/write() from that
    // callback observe the stopped state.
    if (resp.final === 1) {
      this.finish();
      this.dispatchEvent(resp);
      this.safeCallback(() => this.listener.onRecognitionComplete(resp));
      this.resolveDone();
      return;
    }

    // Skip the connection acknowledgement frame. After connect, the server
    // sends an ack that carries no "result" object
    // (e.g. {"code":0,"message":"success","voice_id":"v1"}). Decoding such a
    // frame yields a result-less response whose slice_type=0 would otherwise
    // be misread as a "sentence begin", emitting a spurious onSentenceBegin.
    // The session start is already signaled via onRecognitionStart on open.
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
        this.safeCallback(() => this.listener.onSentenceBegin(resp));
        break;
      case 1:
        this.safeCallback(() => this.listener.onRecognitionResultChange(resp));
        break;
      case 2:
        this.safeCallback(() => this.listener.onSentenceEnd(resp));
        break;
    }
  }

  /**
   * Advance the recognizer to the terminal stopped state and close the
   * connection. It is invoked before terminal callbacks (so a stop()/write()
   * from inside a callback returns immediately) and is idempotent.
   */
  private finish(): void {
    if (this.isStopped()) {
      return;
    }
    this.state = State.STOPPED;
    this.close();
  }

  /**
   * Whether the recognizer reached the terminal stopped state. Reading via a
   * method (rather than comparing this.state directly) keeps the compiler
   * from narrowing the field: the message pump mutates it asynchronously.
   */
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

  /**
   * Deliver a listener callback while shielding the message pump from an
   * exception raised inside the user-supplied listener. A faulty callback
   * must never crash the host process or prevent cleanup from running.
   */
  private safeCallback(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("trtc-asr: listener callback raised, ignored:", err);
    }
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
