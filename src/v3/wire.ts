/**
 * Shared wire types and helpers for the TRTC-ASR v3 protocol.
 *
 * The v3 protocol restructures the wire format around two separated blocks:
 * an "auth" block (sdkappid / usersig / request_id) consumed by the gateway's
 * authentication layer, and a "params" block (engine, VAD, hotwords, filters,
 * ...) consumed by the recognition layer. All field names are snake_case and
 * responses are flat (no Response envelope) with numeric codes.
 *
 * v3 uses SdkAppID as the only customer dimension; the Tencent Cloud AppID is
 * not needed (see {@link newCredential}).
 */

import { Credential } from "../credential";
import { ASRError, ErrorCode } from "../errors";
import { genUserSig } from "../usersig";

/** Wire size limits, mirroring the server side (checked locally). */
export const START_FRAME_MAX_BYTES = 64 * 1024;
export const STREAM_FRAME_MAX_BYTES = 256 * 1024;

/** ackTimeout (ms) caps how long start() waits for the server's ack. */
export const ACK_TIMEOUT_MS = 5000;

/**
 * Speaker-context ack timeout (ms) replaces ACK_TIMEOUT_MS while resuming a
 * speaker context (sync mode + a stored speaker_context_id): the first
 * response is delayed until the server has loaded the stored speaker snapshot
 * and restored it in the diarization session.
 */
export const SPEAKER_CONTEXT_ACK_TIMEOUT_MS = 15000;

/** SourceType for the HTTP interfaces. */
export const SOURCE_TYPE_URL = 0;
export const SOURCE_TYPE_DATA = 1;

/** Task status values returned by describe_transcription. */
export const TASK_STATUS_WAITING = 0;
export const TASK_STATUS_RUNNING = 1;
export const TASK_STATUS_SUCCESS = 2;
export const TASK_STATUS_FAILED = 3;

/** Speaker diarization modes. */
export const SPEAKER_DIARIZATION_OFF = 0;
export const SPEAKER_DIARIZATION_CLUSTER = 1;
export const SPEAKER_DIARIZATION_VOICEPRINT = 3;

/**
 * Speaker-context ("断点续传") modes for enable_speaker_context. They turn
 * speaker diarization into a resumable session: the server stores the stable
 * speaker anchors and hands back an opaque speaker_context_id, which a later
 * connection passes back to keep the same speakers on the same ids. Both
 * modes require speaker diarization.
 */
export const SPEAKER_CONTEXT_OFF = 0;
/** Sync: with a stored id the first response waits for the snapshot. */
export const SPEAKER_CONTEXT_SYNC = 1;
/** Async: the first response answers immediately (id only, no status). */
export const SPEAKER_CONTEXT_ASYNC = 2;

/** continue_status values of SpeakerContinue.continue_status. */
export const CONTINUE_STATUS_FRESH = "fresh";
export const CONTINUE_STATUS_RESUMED = "resumed";
export const CONTINUE_STATUS_DEGRADED = "degraded";
export const CONTINUE_STATUS_DISABLED = "disabled";

/**
 * Create a credential for the v3 API: only SdkAppID + SecretKey are needed.
 */
export function newCredential(sdkAppId: number, secretKey: string): Credential {
  return new Credential(0, sdkAppId, secretKey);
}

/** A domain key-value pair of Context.general. */
export interface ContextKV {
  key: string;
  value: string;
}

/** Recognition context, aligned with Soniox / Volcengine semantics. */
export interface Context {
  text?: string;
  terms?: string[];
  general?: ContextKV[];
}

/** Temporary voiceprint enrollment entry (speaker_diarization=3). */
export interface SpeakerRole {
  role_name: string;
  audio_url: string;
}

/**
 * Speaker-context handshake result carried by the first server response
 * (`speaker_continue`). Absent unless the session set enable_speaker_context.
 *
 * Persist speaker_context_id on the client side and pass it back through
 * {@link SpeechRecognizer.setSpeakerContextId} when reconnecting within its
 * lifetime (24h by default); the response of a later session is
 * authoritative, so always overwrite the stored value. Wait for the first
 * response before sending audio: in sync mode with a stored id the server
 * answers only after the snapshot has been applied.
 */
export interface SpeakerContinue {
  /** One of CONTINUE_STATUS_*. Empty in async mode (the server answers
   * before the snapshot is loaded); unknown values mean "no information". */
  continue_status?: string;
  /** Id to pass back with setSpeakerContextId to resume the same speakers. */
  speaker_context_id?: string;
}

/** One audio piece of a distributed recording task. */
export interface AudioURLItem {
  index: number;
  url: string;
  label?: string;
}

/** A word-level timing entry (transcribe / describe responses). */
export interface Word {
  word: string;
  start_time: number;
  end_time: number;
}

/**
 * Build the v3 auth block. requestId is the UserSig identifier for the
 * offline interfaces; the server binds the signature to it.
 */
export function buildAuthBlock(credential: Credential, requestId: string): Record<string, string> {
  let userSig = credential.userSig;
  if (!userSig) {
    try {
      userSig = genUserSig(credential.sdkAppId, credential.secretKey, requestId, 86400);
    } catch (err) {
      throw new ASRError(ErrorCode.AUTH_FAILED, `generate user sig failed: ${err}`);
    }
  }
  const auth: Record<string, string> = {
    sdkappid: String(credential.sdkAppId),
    usersig: userSig,
  };
  if (requestId) {
    auth.request_id = requestId;
  }
  return auth;
}

/** Wrap params into the {"auth": ..., "params": ...} offline body. */
export function offlineEnvelope(
  credential: Credential,
  requestId: string,
  params: Record<string, unknown>,
): { auth: Record<string, string>; params: Record<string, unknown> } {
  return { auth: buildAuthBlock(credential, requestId), params };
}

/**
 * Check the diarization mode and its enrollment input (v3 shape: roles use
 * the snake_case wire fields role_name / audio_url, unlike the v2 CamelCase
 * SpeakerRole).
 */
export function validateSpeakerDiarization(
  mode: number,
  speakerNumber: number,
  roles: SpeakerRole[],
  voiceprintIds: string[],
): void {
  const validModes = [SPEAKER_DIARIZATION_OFF, 1, SPEAKER_DIARIZATION_VOICEPRINT];
  if (!validModes.includes(mode)) {
    throw new ASRError(
      ErrorCode.INVALID_PARAM,
      `SpeakerDiarization must be 0 (off), 1 (cluster) or 3 (voiceprint), got ${mode}`,
    );
  }
  if (speakerNumber < 0) {
    throw new ASRError(
      ErrorCode.INVALID_PARAM,
      `SpeakerNumber must be >= 0 (0 = auto detection), got ${speakerNumber}`,
    );
  }
  if (mode !== SPEAKER_DIARIZATION_VOICEPRINT && (roles.length > 0 || voiceprintIds.length > 0)) {
    throw new ASRError(
      ErrorCode.INVALID_PARAM,
      "SpeakerRoles/VoiceprintIds require SpeakerDiarization=3",
    );
  }
  roles.forEach((role, i) => {
    if (!role.role_name) {
      throw new ASRError(ErrorCode.INVALID_PARAM, `SpeakerRoles[${i}].RoleName is empty`);
    }
    if (!(role.audio_url || "").trim()) {
      throw new ASRError(ErrorCode.INVALID_PARAM, `SpeakerRoles[${i}].AudioURL is empty`);
    }
    let parsed: URL;
    try {
      parsed = new URL(role.audio_url);
    } catch (err) {
      throw new ASRError(
        ErrorCode.INVALID_PARAM,
        `SpeakerRoles[${i}].AudioURL is not a valid URL: ${err}`,
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ASRError(
        ErrorCode.INVALID_PARAM,
        `SpeakerRoles[${i}].AudioURL must use http or https`,
      );
    }
    if (!parsed.hostname) {
      throw new ASRError(ErrorCode.INVALID_PARAM, `SpeakerRoles[${i}].AudioURL has no host`);
    }
  });
  voiceprintIds.forEach((id, i) => {
    if (!id) {
      throw new ASRError(ErrorCode.INVALID_PARAM, `VoiceprintIds[${i}] is empty`);
    }
  });
}

/**
 * Check the speaker-context ("断点续传") options.
 *
 * enable_speaker_context accepts 0 (off), 1 (sync) or 2 (async); the server
 * silently normalizes anything else to off, but a caller that meant to enable
 * resumption is better served by an immediate error than by a session that
 * quietly never returns a speaker_context_id.
 *
 * The server ignores the speaker-context parameters entirely when speaker
 * diarization is off, so that combination is a caller mistake as well
 * (mirroring how roles/voiceprint ids require mode 3).
 *
 * speaker_context_id itself is not format-checked on purpose: the server
 * treats an unknown or expired id as "start a new session", so a stale value
 * degrades gracefully instead of failing the connection.
 */
export function validateSpeakerContext(mode: number, diarization: number): void {
  const validModes = [SPEAKER_CONTEXT_OFF, SPEAKER_CONTEXT_SYNC, SPEAKER_CONTEXT_ASYNC];
  if (!validModes.includes(mode)) {
    throw new ASRError(
      ErrorCode.INVALID_PARAM,
      `EnableSpeakerContext must be 0 (off), 1 (sync) or 2 (async), got ${mode}`,
    );
  }
  if (mode !== SPEAKER_CONTEXT_OFF && diarization === SPEAKER_DIARIZATION_OFF) {
    throw new ASRError(
      ErrorCode.INVALID_PARAM,
      "EnableSpeakerContext requires SpeakerDiarization=1 or 3",
    );
  }
}

/**
 * Convert a v3 flat error into an ASRError carrying the server code. Server
 * codes (4xxx / 5xxx) are disjoint from the SDK-local 10xx codes.
 */
export function serverError(code: number, message: string, requestId: string): ASRError {
  if (requestId) {
    return new ASRError(code, `${message} (request_id: ${requestId})`);
  }
  return new ASRError(code, message);
}

/**
 * Unmarshal a v3 flat response body. Two failure shapes are rejected here:
 *
 * - the body is not a JSON object (cannot be a v3 response);
 * - the HTTP status is not 2xx while the body carries no numeric code — a
 *   gateway/LB JSON error page would otherwise decode to code==0 and be
 *   mistaken for success.
 *
 * A legitimate v3 endpoint always sends 2xx for code==0, so the second guard
 * never misfires on a real response.
 */
export function decodeFlatResponse(respBody: string, status: number): Record<string, any> {
  let data: unknown;
  try {
    data = JSON.parse(respBody);
  } catch (err) {
    throw new ASRError(
      ErrorCode.SERVER_ERROR,
      `invalid response (http ${status}): ${err}`,
    );
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ASRError(
      ErrorCode.SERVER_ERROR,
      `invalid response (http ${status}): not a JSON object`,
    );
  }
  const record = data as Record<string, any>;
  if ((status < 200 || status > 299) && (record.code ?? 0) === 0) {
    const preview = respBody.length > 256 ? respBody.slice(0, 256) + "..." : respBody;
    throw new ASRError(
      ErrorCode.SERVER_ERROR,
      `http ${status} with non-v3 response body: ${preview}`,
    );
  }
  return record;
}

/**
 * Check the distributed-recording invariants the server enforces
 * (rectask_cluster.go validateDistributedAudioUrlsRequest): audio_urls
 * requires sourceType=0 with url/data left empty, and each item needs a
 * unique non-negative index and an absolute http(s) URL.
 */
export function validateAudioURLs(
  sourceType: number,
  url: string,
  data: string,
  audioURLs: AudioURLItem[],
): void {
  if (sourceType !== SOURCE_TYPE_URL || url || data) {
    throw new ASRError(
      ErrorCode.INVALID_PARAM,
      "AudioURLs cannot be used together with non-zero sourceType, url or data",
    );
  }
  const seen = new Set<number>();
  audioURLs.forEach((item, i) => {
    if (item.index < 0) {
      throw new ASRError(ErrorCode.INVALID_PARAM, `AudioURLs[${i}].Index must be non-negative`);
    }
    if (seen.has(item.index)) {
      throw new ASRError(ErrorCode.INVALID_PARAM, `AudioURLs index duplicated: ${item.index}`);
    }
    seen.add(item.index);
    const raw = (item.url || "").trim();
    if (!raw) {
      throw new ASRError(ErrorCode.INVALID_PARAM, `AudioURLs[${i}].URL is required`);
    }
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch (err) {
      throw new ASRError(
        ErrorCode.INVALID_PARAM,
        `AudioURLs[${i}].URL must be a valid http/https URL`,
      );
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
      throw new ASRError(
        ErrorCode.INVALID_PARAM,
        `AudioURLs[${i}].URL must be a valid http/https URL`,
      );
    }
  });
}
