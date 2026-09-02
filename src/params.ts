/**
 * Shared parameter validation for the recognizers.
 *
 * The service validates every parameter as well, but rejecting an obviously
 * invalid value locally turns a remote 4001 ("参数不合法") into an immediate,
 * descriptive error and avoids burning a connection or a task quota.
 */

import { ASRError, ErrorCode } from "./errors";
import {
  SPEAKER_DIARIZATION_OFF,
  SPEAKER_DIARIZATION_VOICEPRINT,
  SpeakerRole,
} from "./signature";

// Server-side accepted ranges, kept in one place so streaming and file
// recognition validate identically.
const MIN_NOISE_THRESHOLD = 0.0;
const MAX_NOISE_THRESHOLD = 4.0;

/**
 * Check the diarization mode and its enrollment input.
 *
 * roles/voiceprintIds are only meaningful with mode 3, but supplying them
 * for another mode is a caller mistake worth surfacing.
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

  if (
    mode !== SPEAKER_DIARIZATION_VOICEPRINT &&
    (roles.length > 0 || voiceprintIds.length > 0)
  ) {
    throw new ASRError(
      ErrorCode.INVALID_PARAM,
      "SpeakerRoles/VoiceprintIds require SpeakerDiarization=3",
    );
  }

  roles.forEach((role, i) => {
    if (!role.roleName) {
      throw new ASRError(
        ErrorCode.INVALID_PARAM,
        `SpeakerRoles[${i}].RoleName is empty`,
      );
    }
    validateEnrollmentUrl(i, role.audioUrl);
  });

  voiceprintIds.forEach((id, i) => {
    if (!id) {
      throw new ASRError(
        ErrorCode.INVALID_PARAM,
        `VoiceprintIds[${i}] is empty`,
      );
    }
  });
}

/**
 * Require an absolute http(s) URL for enrollment audio.
 *
 * The URL is fetched by the ASR service, not by the SDK: this is a
 * customer-facing client library, so it only rejects inputs that can never
 * work (bad syntax, non-http scheme, missing host). Reachability and network
 * policies belong to the service-side allow list.
 */
export function validateEnrollmentUrl(index: number, rawUrl: string): void {
  if (!rawUrl.trim()) {
    throw new ASRError(
      ErrorCode.INVALID_PARAM,
      `SpeakerRoles[${index}].AudioUrl is empty`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    throw new ASRError(
      ErrorCode.INVALID_PARAM,
      `SpeakerRoles[${index}].AudioUrl is not a valid URL: ${err}`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ASRError(
      ErrorCode.INVALID_PARAM,
      `SpeakerRoles[${index}].AudioUrl must use http or https, got '${parsed.protocol.replace(":", "")}'`,
    );
  }
  if (!parsed.hostname) {
    throw new ASRError(
      ErrorCode.INVALID_PARAM,
      `SpeakerRoles[${index}].AudioUrl has no host`,
    );
  }
  // WHATWG URL normalizes "https:///a.wav" to "https://a.wav/", silently
  // inventing a host from the path. Detect the empty authority on the raw
  // string (between "scheme://" and the first "/", "?" or "#") so an
  // obviously invalid URL is rejected locally, mirroring Go's url.Parse.
  const rest = rawUrl.slice(parsed.protocol.length + 2);
  const authority = rest.split(/[/?#]/)[0];
  if (!authority) {
    throw new ASRError(
      ErrorCode.INVALID_PARAM,
      `SpeakerRoles[${index}].AudioUrl has no host`,
    );
  }
}

/**
 * Check the VAD profile and noise threshold.
 */
export function validateVadTuning(
  vadLevel: number | null,
  noiseThreshold: number | null,
): void {
  if (vadLevel !== null && vadLevel !== 0 && vadLevel !== 1) {
    throw new ASRError(
      ErrorCode.INVALID_PARAM,
      `VadLevel must be 0 (high recall) or 1 (far-field filtering), got ${vadLevel}`,
    );
  }
  if (noiseThreshold !== null) {
    // NaN fails every comparison, so test the valid range positively.
    if (!(noiseThreshold >= MIN_NOISE_THRESHOLD && noiseThreshold <= MAX_NOISE_THRESHOLD)) {
      throw new ASRError(
        ErrorCode.INVALID_PARAM,
        `NoiseThreshold must be between ${MIN_NOISE_THRESHOLD.toFixed(1)} and ${MAX_NOISE_THRESHOLD.toFixed(1)}, got ${noiseThreshold}`,
      );
    }
  }
}

/**
 * Check a small enumerated option such as input_sample_rate.
 */
export function validateEnumOption(
  name: string,
  value: number,
  allowed: readonly number[],
): void {
  if (!allowed.includes(value)) {
    throw new ASRError(
      ErrorCode.INVALID_PARAM,
      `${name} must be one of [${allowed.join(", ")}], got ${value}`,
    );
  }
}
