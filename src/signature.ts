/**
 * URL query parameter building for the ASR WebSocket request.
 */

import { sdkReportParams } from "./sdkinfo";

/** Speaker diarization modes for the speaker_diarization parameter. */
export const SPEAKER_DIARIZATION_OFF = 0;
export const SPEAKER_DIARIZATION_CLUSTER = 1;
export const SPEAKER_DIARIZATION_VOICEPRINT = 3;

/**
 * Temporary voiceprint enrollment entry used with speaker_diarization=3.
 *
 * The serialized field names intentionally match the server-side contract
 * (CamelCase) for both the streaming speaker_roles query parameter and the
 * CreateRecTask SpeakerRoles body field. roleName is echoed back by the
 * server as speaker_name on the matched words / speaker segments.
 */
export interface SpeakerRole {
  roleName: string;
  audioUrl: string;
}

export interface SignatureParamsOptions {
  appId: number;
  engineModelType: string;
  voiceId: string;
  voiceFormat?: number;
  needVad?: number;
  convertNumMode?: number;

  /** TRTC application ID, sent as the "sdkappid" query parameter. */
  sdkAppId?: number;

  hotwordId?: string;
  /** Temporary inline hotwords: "word|weight,word|weight". */
  hotwordList?: string;
  customizationId?: string;
  /** Replacement word table ID. */
  replaceTextId?: string;
  filterDirty?: number;
  filterModal?: number;
  filterPunc?: number;

  /**
   * Empty-result callbacks: 0=deliver, 1=skip (server default).
   * undefined leaves the parameter out (tri-state).
   */
  filterEmptyResult?: number;

  wordInfo?: number;
  vadSilenceTime?: number;

  /**
   * VAD profile: 0=high recall, 1=far-field filtering (server default).
   * undefined leaves the parameter out, so an explicit 0 is
   * distinguishable from "not configured" (tri-state).
   */
  vadLevel?: number;

  /**
   * VAD noise fine-tuning, range [0, 4]. When set it overrides the profile
   * selected by vadLevel. undefined leaves the parameter out (tri-state).
   */
  noiseThreshold?: number;

  maxSpeakTime?: number;
  /** 8000: feed 8kHz PCM to a 16k engine (upsampled server-side). */
  inputSampleRate?: number;
  /** bigmodel engine language hint (e.g. "ms", "zh", "auto"). */
  language?: string;

  /** 0=off (default), 1=anonymous clustering, 3=voiceprint roles. */
  speakerDiarization?: number;
  /** Expected speaker count hint; 0=auto detection (default). */
  speakerNumber?: number;
  /** Temporary voiceprint enrollment audio; only mode 3. */
  speakerRoles?: SpeakerRole[];
  /** Pre-registered voiceprint IDs; only mode 3. */
  voiceprintIds?: string[];
}

/**
 * Holds URL query parameters for the ASR WebSocket request.
 *
 * The "secretid" URL parameter is required by the protocol but internally
 * populated with AppID — users do not need to provide a separate SecretID.
 *
 * Authentication identity travels in the URL instead of HTTP headers: the
 * gateway accepts the "sdkappid" / "usersig" query parameters, and browsers
 * cannot attach custom headers to a native WebSocket handshake.
 */
export class SignatureParams {
  readonly appId: number;
  readonly engineModelType: string;
  readonly voiceId: string;
  readonly timestamp: number;
  readonly expired: number;
  readonly nonce: number;
  voiceFormat: number;
  needVad: number;
  convertNumMode: number;

  /** TRTC application ID; 0 means not configured. */
  sdkAppId: number;

  hotwordId: string;
  hotwordList: string;
  customizationId: string;
  replaceTextId: string;
  filterDirty: number;
  filterModal: number;
  filterPunc: number;
  /** null = not configured (tri-state). */
  filterEmptyResult: number | null;
  wordInfo: number;
  vadSilenceTime: number;
  /** null = not configured (tri-state; an explicit 0 is meaningful). */
  vadLevel: number | null;
  /** null = not configured (tri-state; 0 is a valid threshold). */
  noiseThreshold: number | null;
  maxSpeakTime: number;
  inputSampleRate: number;
  language: string;
  speakerDiarization: number;
  speakerNumber: number;
  speakerRoles: SpeakerRole[];
  voiceprintIds: string[];

  constructor(opts: SignatureParamsOptions) {
    this.appId = opts.appId;
    this.engineModelType = opts.engineModelType;
    this.voiceId = opts.voiceId;

    const now = Math.floor(Date.now() / 1000);
    this.timestamp = now;
    this.expired = now + 86400;
    this.nonce = Math.floor(Math.random() * 9999999) + 1;

    this.voiceFormat = opts.voiceFormat ?? 1;
    this.needVad = opts.needVad ?? 1;
    this.convertNumMode = opts.convertNumMode ?? 1;
    this.sdkAppId = opts.sdkAppId ?? 0;
    this.hotwordId = opts.hotwordId ?? "";
    this.hotwordList = opts.hotwordList ?? "";
    this.customizationId = opts.customizationId ?? "";
    this.replaceTextId = opts.replaceTextId ?? "";
    this.filterDirty = opts.filterDirty ?? 0;
    this.filterModal = opts.filterModal ?? 0;
    this.filterPunc = opts.filterPunc ?? 0;
    this.filterEmptyResult =
      opts.filterEmptyResult !== undefined ? opts.filterEmptyResult : null;
    this.wordInfo = opts.wordInfo ?? 0;
    this.vadSilenceTime = opts.vadSilenceTime ?? 0;
    this.vadLevel = opts.vadLevel !== undefined ? opts.vadLevel : null;
    this.noiseThreshold =
      opts.noiseThreshold !== undefined ? opts.noiseThreshold : null;
    this.maxSpeakTime = opts.maxSpeakTime ?? 0;
    this.inputSampleRate = opts.inputSampleRate ?? 0;
    this.language = opts.language ?? "";
    this.speakerDiarization = opts.speakerDiarization ?? 0;
    this.speakerNumber = opts.speakerNumber ?? 0;
    this.speakerRoles = opts.speakerRoles ? [...opts.speakerRoles] : [];
    this.voiceprintIds = opts.voiceprintIds ? [...opts.voiceprintIds] : [];
  }

  /** Build URL query string without signature. */
  buildQueryString(): string {
    return encodeParams(this.toMap());
  }

  /**
   * Build URL query string with signature set to the given UserSig.
   *
   * Per protocol: the "signature" value equals the UserSig. The same value
   * is also sent as the "usersig" query parameter, which the gateway reads
   * (e.g. browser WebSocket clients that cannot attach custom headers).
   */
  buildQueryStringWithSignature(userSig: string): string {
    const params = this.toMap();
    params["signature"] = userSig;
    params["usersig"] = userSig;
    return encodeParams(params);
  }

  private toMap(): Record<string, string> {
    const m: Record<string, string> = {
      secretid: String(this.appId),
      timestamp: String(this.timestamp),
      expired: String(this.expired),
      nonce: String(this.nonce),
      engine_model_type: this.engineModelType,
      voice_id: this.voiceId,
      voice_format: String(this.voiceFormat),
      needvad: String(this.needVad),
    };
    // SDK self-identification for server-side diagnostics. Not part of the
    // signature (the signature is the UserSig), so it is safe to append.
    Object.assign(m, sdkReportParams());
    if (this.sdkAppId > 0) {
      m["sdkappid"] = String(this.sdkAppId);
    }

    if (this.hotwordId) m["hotword_id"] = this.hotwordId;
    if (this.hotwordList) m["hotword_list"] = this.hotwordList;
    if (this.customizationId) m["customization_id"] = this.customizationId;
    if (this.replaceTextId) m["replace_text_id"] = this.replaceTextId;
    if (this.filterDirty) m["filter_dirty"] = String(this.filterDirty);
    if (this.filterModal) m["filter_modal"] = String(this.filterModal);
    if (this.filterPunc) m["filter_punc"] = String(this.filterPunc);
    if (this.filterEmptyResult !== null) {
      m["filter_empty_result"] = String(this.filterEmptyResult);
    }
    if (this.convertNumMode) {
      m["convert_num_mode"] = String(this.convertNumMode);
    }
    if (this.wordInfo) m["word_info"] = String(this.wordInfo);
    if (this.vadSilenceTime) {
      m["vad_silence_time"] = String(this.vadSilenceTime);
    }
    if (this.maxSpeakTime) m["max_speak_time"] = String(this.maxSpeakTime);
    if (this.inputSampleRate) {
      m["input_sample_rate"] = String(this.inputSampleRate);
    }
    // vadLevel and noiseThreshold are tri-state: an explicit 0 differs from
    // "not configured" (the server defaults vad_level to 1), so they are
    // only emitted when the caller set them.
    if (this.vadLevel !== null) m["vad_level"] = String(this.vadLevel);
    if (this.noiseThreshold !== null) {
      m["noise_threshold"] = this.noiseThreshold.toFixed(3);
    }
    if (this.speakerDiarization !== 0) {
      m["speaker_diarization"] = String(this.speakerDiarization);
      if (this.speakerNumber !== 0) {
        m["speaker_number"] = String(this.speakerNumber);
      }
    }
    // speaker_roles / voiceprintids only apply to the voiceprint role
    // authentication mode.
    if (this.speakerDiarization === SPEAKER_DIARIZATION_VOICEPRINT) {
      if (this.speakerRoles.length > 0) {
        m["speaker_roles"] = JSON.stringify(
          this.speakerRoles.map((r) => ({
            RoleName: r.roleName,
            AudioUrl: r.audioUrl,
          })),
        );
      }
      if (this.voiceprintIds.length > 0) {
        m["voiceprintids"] = JSON.stringify(this.voiceprintIds);
      }
    }
    if (this.language) m["language"] = this.language;

    return m;
  }
}

function encodeParams(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");
}
