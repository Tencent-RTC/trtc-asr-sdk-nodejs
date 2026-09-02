/**
 * Speaker diarization / VAD tuning signature tests (aligned with Go
 * common/signature_speaker_test.go).
 */

import {
  SignatureParams,
  SPEAKER_DIARIZATION_CLUSTER,
  SPEAKER_DIARIZATION_VOICEPRINT,
  SpeakerRole,
} from "../src/signature";

function makeParams(): SignatureParams {
  return new SignatureParams({
    appId: 1300403317,
    engineModelType: "16k_zh",
    voiceId: "voice-001",
  });
}

function queryOf(qs: string): URLSearchParams {
  return new URLSearchParams(qs);
}

describe("SignatureParams speaker / VAD options", () => {
  test("omits unset optional params", () => {
    const qs = makeParams().buildQueryString();

    for (const key of [
      "speaker_diarization",
      "speaker_number",
      "speaker_roles",
      "voiceprintids",
      "noise_threshold",
      "vad_level",
      "filter_empty_result",
      "hotword_list",
      "replace_text_id",
      "input_sample_rate",
    ]) {
      expect(qs).not.toContain(key + "=");
    }
  });

  test("speaker_diarization cluster mode", () => {
    const params = makeParams();
    params.speakerDiarization = SPEAKER_DIARIZATION_CLUSTER;
    // The speaker count hint feeds online clustering in both modes.
    params.speakerNumber = 2;
    // Enrollment input only applies to mode 3 and must not leak into mode 1.
    params.speakerRoles = [
      { roleName: "teacher", audioUrl: "https://example.com/a.wav" },
    ];
    params.voiceprintIds = ["vp-1"];

    const q = queryOf(params.buildQueryString());

    expect(q.get("speaker_diarization")).toBe("1");
    expect(q.get("speaker_number")).toBe("2");
    expect(q.has("speaker_roles")).toBe(false);
    expect(q.has("voiceprintids")).toBe(false);
  });

  test("speaker_diarization voiceprint mode", () => {
    const params = makeParams();
    params.speakerDiarization = SPEAKER_DIARIZATION_VOICEPRINT;
    params.speakerRoles = [
      { roleName: "teacher", audioUrl: "https://example.com/a.wav" },
      { roleName: "student", audioUrl: "https://example.com/b.wav" },
    ];
    params.voiceprintIds = ["vp-1", "vp-2"];

    params.speakerNumber = 0; // auto detection stays the server default

    const q = queryOf(params.buildQueryString());

    expect(q.get("speaker_diarization")).toBe("3");
    // 0 means auto detection; the server applies the same default, so the
    // parameter is omitted instead of being pinned to zero.
    expect(q.has("speaker_number")).toBe(false);

    const roles = JSON.parse(q.get("speaker_roles") || "[]");
    expect(roles).toHaveLength(2);
    expect(roles[0].RoleName).toBe("teacher");
    expect(roles[1].AudioUrl).toBe("https://example.com/b.wav");

    const ids = JSON.parse(q.get("voiceprintids") || "[]");
    expect(ids).toEqual(["vp-1", "vp-2"]);
  });

  test("tri-state VAD tuning", () => {
    const params = makeParams();
    params.vadLevel = 0;
    params.noiseThreshold = 0.0;
    params.filterEmptyResult = 0;

    let q = queryOf(params.buildQueryString());

    // An explicit 0 differs from "unset": the server defaults vad_level to 1
    // and filter_empty_result to 1, so both must reach the wire.
    expect(q.get("vad_level")).toBe("0");
    expect(q.get("filter_empty_result")).toBe("0");
    expect(q.get("noise_threshold")).toBe("0.000");

    params.noiseThreshold = 1.5;
    q = queryOf(params.buildQueryString());
    expect(q.get("noise_threshold")).toBe("1.500");
  });

  test("advanced optional params", () => {
    const params = makeParams();
    params.hotwordList = "腾讯云|5,ASR|11";
    params.replaceTextId = "replace-1";
    params.inputSampleRate = 8000;
    params.language = "zh";

    const q = queryOf(params.buildQueryString());

    expect(q.get("hotword_list")).toBe("腾讯云|5,ASR|11");
    expect(q.get("replace_text_id")).toBe("replace-1");
    expect(q.get("input_sample_rate")).toBe("8000");
    expect(q.get("language")).toBe("zh");
  });

  test("sdkappid emitted when configured", () => {
    const params = makeParams();
    params.sdkAppId = 1400000000;
    let q = queryOf(params.buildQueryString());
    expect(q.get("sdkappid")).toBe("1400000000");

    // 0 means not configured: omitted.
    params.sdkAppId = 0;
    q = queryOf(params.buildQueryString());
    expect(q.has("sdkappid")).toBe(false);
  });

  test("signature and usersig both carry the UserSig", () => {
    const params = makeParams();
    params.sdkAppId = 1400000000;
    const userSig = "eJyrVgrxCdYrLkksyczPs1KyUkqpTM4sSgUAR94HgQ--";
    const q = queryOf(params.buildQueryStringWithSignature(userSig));

    // Per protocol the signature parameter equals the UserSig, and the same
    // value is sent as usersig so the gateway authenticates without headers.
    expect(q.get("signature")).toBe(userSig);
    expect(q.get("usersig")).toBe(userSig);
  });
});
