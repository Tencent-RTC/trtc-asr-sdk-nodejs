/**
 * Shared parameter validation tests (aligned with Go asr/params_test.go).
 */

import { ASRError, ErrorCode } from "../src/errors";
import {
  validateEnumOption,
  validateSpeakerDiarization,
  validateVadTuning,
} from "../src/params";
import {
  SPEAKER_DIARIZATION_CLUSTER,
  SPEAKER_DIARIZATION_OFF,
  SPEAKER_DIARIZATION_VOICEPRINT,
  SpeakerRole,
} from "../src/signature";

const VALID_ROLE: SpeakerRole = {
  roleName: "teacher",
  audioUrl: "https://example.com/a.wav",
};

describe("validateSpeakerDiarization", () => {
  test("accepts off", () => {
    validateSpeakerDiarization(SPEAKER_DIARIZATION_OFF, 0, [], []);
  });

  test("accepts cluster", () => {
    validateSpeakerDiarization(SPEAKER_DIARIZATION_CLUSTER, 0, [], []);
  });

  test("accepts cluster with number hint", () => {
    validateSpeakerDiarization(SPEAKER_DIARIZATION_CLUSTER, 2, [], []);
  });

  test("accepts voiceprint with enrollment", () => {
    validateSpeakerDiarization(SPEAKER_DIARIZATION_VOICEPRINT, 2, [VALID_ROLE], ["vp-1"]);
  });

  test("rejects unsupported mode", () => {
    expect(() => validateSpeakerDiarization(2, 0, [], [])).toThrow(ASRError);
    try {
      validateSpeakerDiarization(2, 0, [], []);
    } catch (err) {
      expect((err as ASRError).message).toContain("SpeakerDiarization must be 0");
      expect((err as ASRError).code).toBe(ErrorCode.INVALID_PARAM);
    }
  });

  test("rejects negative speaker number", () => {
    expect(() =>
      validateSpeakerDiarization(SPEAKER_DIARIZATION_CLUSTER, -1, [], []),
    ).toThrow(/SpeakerNumber must be >= 0/);
  });

  test("rejects roles without voiceprint mode", () => {
    expect(() =>
      validateSpeakerDiarization(SPEAKER_DIARIZATION_CLUSTER, 0, [VALID_ROLE], []),
    ).toThrow(/require SpeakerDiarization=3/);
  });

  test("rejects voiceprint ids without voiceprint mode", () => {
    expect(() =>
      validateSpeakerDiarization(SPEAKER_DIARIZATION_OFF, 0, [], ["vp-1"]),
    ).toThrow(/require SpeakerDiarization=3/);
  });

  test("rejects empty role name", () => {
    expect(() =>
      validateSpeakerDiarization(SPEAKER_DIARIZATION_VOICEPRINT, 0, [
        { roleName: "", audioUrl: "https://example.com/a.wav" },
      ], []),
    ).toThrow(/RoleName is empty/);
  });

  test("rejects empty audio url", () => {
    expect(() =>
      validateSpeakerDiarization(SPEAKER_DIARIZATION_VOICEPRINT, 0, [
        { roleName: "teacher", audioUrl: "" },
      ], []),
    ).toThrow(/AudioUrl is empty/);
  });

  test("rejects non http scheme", () => {
    expect(() =>
      validateSpeakerDiarization(SPEAKER_DIARIZATION_VOICEPRINT, 0, [
        { roleName: "teacher", audioUrl: "file:///etc/passwd" },
      ], []),
    ).toThrow(/must use http or https/);
  });

  test("rejects url without host", () => {
    expect(() =>
      validateSpeakerDiarization(SPEAKER_DIARIZATION_VOICEPRINT, 0, [
        { roleName: "teacher", audioUrl: "https:///a.wav" },
      ], []),
    ).toThrow(/has no host/);
  });

  test("allows internal host", () => {
    // This SDK is customer-facing: internal hosts belong to the caller's
    // own network and stay fetchable for the service, so no SSRF-style
    // blocking (mirrors the Go decision).
    validateSpeakerDiarization(SPEAKER_DIARIZATION_VOICEPRINT, 0, [
      { roleName: "teacher", audioUrl: "http://192.168.1.10/a.wav" },
    ], []);
  });

  test("rejects empty voiceprint id", () => {
    expect(() =>
      validateSpeakerDiarization(SPEAKER_DIARIZATION_VOICEPRINT, 0, [], [""]),
    ).toThrow(/VoiceprintIds\[0\] is empty/);
  });
});

describe("validateVadTuning", () => {
  test("accepts unset", () => {
    validateVadTuning(null, null);
  });

  test("accepts valid levels", () => {
    validateVadTuning(0, null);
    validateVadTuning(1, null);
  });

  test("rejects invalid level", () => {
    expect(() => validateVadTuning(2, null)).toThrow(
      /VadLevel must be 0 \(high recall\) or 1 \(far-field filtering\)/,
    );
  });

  test("accepts threshold bounds", () => {
    validateVadTuning(null, 0.0);
    validateVadTuning(null, 4.0);
    validateVadTuning(null, 1.5);
  });

  test("rejects threshold below range", () => {
    expect(() => validateVadTuning(null, -0.1)).toThrow(
      /NoiseThreshold must be between 0.0 and 4.0/,
    );
  });

  test("rejects threshold above range", () => {
    expect(() => validateVadTuning(null, 4.1)).toThrow(
      /NoiseThreshold must be between 0.0 and 4.0/,
    );
  });

  test("rejects NaN threshold", () => {
    // NaN fails every comparison, so the valid range must be tested
    // positively (mirrors the Go implementation).
    expect(() => validateVadTuning(null, NaN)).toThrow(ASRError);
  });
});

describe("validateEnumOption", () => {
  test("accepts valid values", () => {
    validateEnumOption("InputSampleRate", 0, [0, 8000]);
    validateEnumOption("InputSampleRate", 8000, [0, 8000]);
  });

  test("rejects invalid value", () => {
    expect(() => validateEnumOption("InputSampleRate", 16000, [0, 8000])).toThrow(
      /InputSampleRate must be one of \[0, 8000\], got 16000/,
    );
  });
});
