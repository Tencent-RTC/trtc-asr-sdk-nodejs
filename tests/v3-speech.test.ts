/**
 * v3 streaming (/asr/v3) tests: start-frame wire format, sync ack error
 * handling, lifecycle and local validation (mirrors Go asr/v3
 * speech_recognizer_test.go).
 */

import { Credential } from "../src/credential";
import { ASRError, ErrorCode } from "../src/errors";
import {
  SpeechRecognizer,
  SpeechRecognitionResponse,
} from "../src/v3/speech-recognizer";
import { newCredential, SpeakerRole, Context } from "../src/v3/wire";

// Controllable fake WebSocket: tests drive the ack and downlink frames via
// instance.emit(), and inspect everything the recognizer sent.
jest.mock("ws", () => {
  const instances: any[] = [];
  class FakeWS {
    url: string;
    opts: any;
    sent: Array<string | Buffer> = [];
    handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    closed = false;
    constructor(url: string, opts?: any) {
      this.url = url;
      this.opts = opts;
      instances.push(this);
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      (this.handlers[event] ||= []).push(handler);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      for (const fn of this.handlers[event] || []) fn(...args);
    }
    send(data: any, cb?: (err?: Error) => void) {
      this.sent.push(data);
      if (cb) cb();
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.emit("close");
    }
  }
  const mock: any = jest
    .fn()
    .mockImplementation(function (this: any, url: string, opts?: any) {
      return new FakeWS(url, opts);
    });
  (mock as any).__instances = instances;
  mock.default = mock;
  return mock;
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const wsModule = require("ws") as any;
function instances(): any[] {
  return wsModule.__instances;
}

function makeRecognizer(listener: any = {}): SpeechRecognizer {
  const credential = newCredential(1400000000, "test-secret");
  return new SpeechRecognizer(credential, "16k_zh_en", listener);
}

function ack(voiceId = "v1", extra: Record<string, unknown> = {}) {
  return JSON.stringify({ code: 0, message: "success", voice_id: voiceId, ...extra });
}

function resultFrame(sliceType: number, final = 0, text = "x"): string {
  return JSON.stringify({
    code: 0,
    message: "success",
    voice_id: "v1",
    final,
    result: {
      slice_type: sliceType,
      index: 0,
      start_time: 0,
      end_time: 1000,
      voice_text_str: text,
    },
  });
}

describe("v3 start-frame wire format", () => {
  test("URL carries only voice_id; auth/params travel in the TEXT start frame", async () => {
    const captured: any = { fail: [] as any[] };
    const recognizer = makeRecognizer({
      onRecognitionStart: () => {
        captured.startFired = true;
      },
      onFail: (_r: SpeechRecognitionResponse | null, e: Error) => captured.fail.push(e),
    });
    recognizer.setVoiceId("voice-1");
    recognizer.setHotwordList("深度学习|10");
    recognizer.setVadLevel(0);
    recognizer.setNoiseThreshold(1.5);
    recognizer.setFilterEmptyResult(0);
    recognizer.setConvertNumMode(0); // explicit 0 must be sent on v3
    recognizer.setSpeakerDiarization(3);
    recognizer.setSpeakerRoles([
      { role_name: "teacher", audio_url: "https://example.com/t.wav" },
    ]);
    recognizer.setVoiceprintIds(["vp-1"]);
    recognizer.setContext({
      text: "bg",
      terms: ["ASR"],
      general: [{ key: "domain", value: "Meeting" }],
    });

    const pending = recognizer.start();
    const ws = instances()[instances().length - 1];
    ws.emit("open");
    ws.emit("message", ack("voice-1"));
    await pending;
    ws.emit("message", resultFrame(2, 1, "done"));
    await recognizer.stop();

    const url = new URL(ws.url.replace("wss://", "https://"));
    expect(url.pathname).toBe("/asr/v3");
    expect(url.searchParams.get("voice_id")).toBe("voice-1");
    for (const banned of ["signature", "usersig", "sdkappid", "secretid", "appid"]) {
      expect(url.searchParams.get(banned)).toBeNull();
    }

    // The first frame sent is the TEXT start frame.
    const frame = JSON.parse(ws.sent[0] as string);
    expect(typeof ws.sent[0]).toBe("string");
    expect(frame.type).toBe("start");

    const auth = frame.auth;
    expect(auth.sdkappid).toBe("1400000000");
    expect(auth.usersig).toBeTruthy();
    expect(Object.keys(auth).sort()).toEqual(["sdkappid", "usersig"]);

    const params = frame.params;
    expect(params.voice_id).toBe("voice-1");
    expect(params.engine_model_type).toBe("16k_zh_en");
    expect(params.voice_format).toBe(1);
    expect(params.needvad).toBe(1);
    expect(params.convert_num_mode).toBe(0); // explicit 0 preserved
    expect(params.filter_empty_result).toBe(0); // explicit 0 preserved
    expect(params.vad_level).toBe(0); // explicit 0 preserved
    expect(params.noise_threshold).toBe(1.5);
    expect(params.hotword_list).toBe("深度学习|10");
    expect(params.speaker_diarization).toBe(3);
    expect(params.voiceprint_ids).toEqual(["vp-1"]);
    // speaker_roles elements are snake_case, not the v2 CamelCase wire.
    expect(params.speaker_roles).toEqual([
      { role_name: "teacher", audio_url: "https://example.com/t.wav" },
    ]);
    expect(params.context).toEqual({
      text: "bg",
      terms: ["ASR"],
      general: [{ key: "domain", value: "Meeting" }],
    });
    expect(params.sdk_info.sdk_lang).toBe("nodejs");
  });

  test("unset setters omit the wire field; SDK-managed defaults are sent", () => {
    const recognizer = makeRecognizer();
    const params = (recognizer as any).buildParams();
    for (const absent of [
      "vad_level",
      "noise_threshold",
      "filter_empty_result",
      "vad_silence_time",
      "input_sample_rate",
      "hotword_id",
      "hotword_list",
      "speaker_diarization",
      "context",
    ]) {
      expect(params[absent]).toBeUndefined();
    }
    expect(params.needvad).toBe(1);
    expect(params.convert_num_mode).toBe(1);
    expect(params.voice_format).toBe(1);
    expect(params.engine_model_type).toBe("16k_zh_en");
    expect(params.sdk_info.sdk_lang).toBe("nodejs");
  });
});

describe("v3 sync ack handling", () => {
  test("auth error (4002) rejects start synchronously", async () => {
    const recognizer = makeRecognizer();
    const pending = recognizer.start();
    const ws = instances()[instances().length - 1];
    ws.emit("open");
    ws.emit("message", JSON.stringify({ code: 4002, message: "auth failed", voice_id: "v1" }));
    await expect(pending).rejects.toMatchObject({ code: 4002 });
    expect(ws.closed).toBe(true);
    await expect(recognizer.write(Buffer.from("abc"))).rejects.toMatchObject({
      code: ErrorCode.NOT_STARTED,
    });
  });

  test("4001 rejects start synchronously", async () => {
    const recognizer = makeRecognizer();
    const pending = recognizer.start();
    const ws = instances()[instances().length - 1];
    ws.emit("open");
    ws.emit(
      "message",
      JSON.stringify({ code: 4001, message: "v3 interface not enabled", voice_id: "v1" }),
    );
    await expect(pending).rejects.toMatchObject({ code: 4001 });
  });

  test("ack timeout rejects start", async () => {
    jest.useFakeTimers();
    const recognizer = makeRecognizer();
    const pending = recognizer.start();
    const ws = instances()[instances().length - 1];
    ws.emit("open"); // no ack arrives
    jest.advanceTimersByTime(6000);
    await expect(pending).rejects.toMatchObject({ code: ErrorCode.READ_FAILED });
    jest.useRealTimers();
  });
});

describe("v3 normal flow", () => {
  test("ack → events → end → final, with binary audio frames", async () => {
    const captured = {
      start: 0,
      begin: 0,
      change: 0,
      ends: [] as string[],
      complete: 0,
      fail: [] as any[],
    };
    const recognizer = makeRecognizer({
      onRecognitionStart: () => captured.start++,
      onSentenceBegin: () => captured.begin++,
      onRecognitionResultChange: () => captured.change++,
      onSentenceEnd: (resp: SpeechRecognitionResponse) =>
        captured.ends.push(resp.result?.voice_text_str ?? ""),
      onRecognitionComplete: () => captured.complete++,
      onFail: (_r: SpeechRecognitionResponse | null, e: Error) => captured.fail.push(e),
    });

    const pending = recognizer.start();
    const ws = instances()[instances().length - 1];
    ws.emit("open");
    ws.emit("message", ack());
    await pending;

    await recognizer.write(Buffer.alloc(1280));
    ws.emit("message", resultFrame(0));
    ws.emit("message", resultFrame(1, 0, "你好"));
    ws.emit("message", resultFrame(2, 0, "你好。"));

    // Real-world ordering: stop() sends "end" while the server still owes us
    // the final frame; the final arrives and resolves the pending stop.
    const stopPending = recognizer.stop();
    ws.emit("message", resultFrame(2, 1, "你好。"));
    await stopPending;

    // The standalone sentence-end (slice_type=2, final=0) and the terminal
    // final=1&slice_type=2 frame each dispatch onSentenceEnd — mirroring Go.
    expect(captured.start).toBe(1);
    expect(captured.begin).toBe(1);
    expect(captured.change).toBe(1);
    expect(captured.ends).toEqual(["你好。", "你好。"]);
    expect(captured.complete).toBe(1);
    expect(captured.fail).toEqual([]);

    // Exactly one binary audio frame; the end signal is a TEXT frame.
    const binary = (ws.sent.filter((f: any) => Buffer.isBuffer(f)) as Buffer[]);
    expect(binary).toEqual([Buffer.alloc(1280)]);
    const textFrames = (ws.sent.filter((f: any) => typeof f === "string") as string[]).map(
      (f) => JSON.parse(f),
    );
    expect(textFrames.some((f) => f.type === "end")).toBe(true);
  });

  test("mid-session error frame terminates with onFail(server code)", async () => {
    const failures: any[] = [];
    const recognizer = makeRecognizer({
      onFail: (_r: SpeechRecognitionResponse | null, e: Error) => failures.push(e),
    });
    const pending = recognizer.start();
    const ws = instances()[instances().length - 1];
    ws.emit("open");
    ws.emit("message", ack());
    await pending;
    ws.emit("message", JSON.stringify({ code: 4008, message: "audio timeout", voice_id: "v1" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(failures).toHaveLength(1);
    expect(failures[0].code).toBe(4008);
  });

  test("oversized audio frame fails locally with INVALID_PARAM", async () => {
    const recognizer = makeRecognizer();
    const pending = recognizer.start();
    const ws = instances()[instances().length - 1];
    ws.emit("open");
    ws.emit("message", ack());
    await pending;
    await expect(
      recognizer.write(Buffer.alloc(256 * 1024 + 1)),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAM });
  });
});

describe("v3 local validation", () => {
  type Ctx = (r: SpeechRecognizer) => void;
  const cases: Array<[string, Ctx]> = [
    ["voice_id too long", (r) => r.setVoiceId("x".repeat(129))],
    ["max_speak_time too small", (r) => r.setMaxSpeakTime(1000)],
    ["max_speak_time too large", (r) => r.setMaxSpeakTime(90001)],
    ["vad_silence_time too small", (r) => r.setVadSilenceTime(100)],
    ["vad_silence_time too large", (r) => r.setVadSilenceTime(2001)],
    ["needvad invalid", (r) => r.setNeedVad(2)],
    ["convert_num_mode invalid", (r) => r.setConvertNumMode(2)],
    ["filter_dirty invalid", (r) => r.setFilterDirty(3)],
    ["filter_modal invalid", (r) => r.setFilterModal(3)],
    ["filter_punc invalid", (r) => r.setFilterPunc(2)],
    ["word_info invalid", (r) => r.setWordInfo(3)],
    ["word_with_space invalid", (r) => r.setWordWithSpace(2)],
    ["voice_format invalid", (r) => r.setVoiceFormat(2)],
    ["input_sample_rate invalid", (r) => r.setInputSampleRate(16000)],
    ["filter_empty_result invalid", (r) => r.setFilterEmptyResult(2)],
    ["vad_level invalid", (r) => r.setVadLevel(2)],
    ["noise_threshold out of range", (r) => r.setNoiseThreshold(4.1)],
    ["diarization invalid", (r) => r.setSpeakerDiarization(2)],
  ];
  test.each(cases)("%s fails locally with INVALID_PARAM", (_name, apply) => {
    const recognizer = makeRecognizer();
    apply(recognizer);
    expect(() => (recognizer as any).validateOptions()).toThrow(
      expect.objectContaining({ code: ErrorCode.INVALID_PARAM }),
    );
  });

  const valid: Array<[string, Ctx]> = [
    ["max_speak_time lower bound", (r) => r.setMaxSpeakTime(5000)],
    ["max_speak_time upper bound", (r) => r.setMaxSpeakTime(90000)],
    ["vad_silence_time bounds", (r) => r.setVadSilenceTime(240)],
    [
      "vad_silence_time out of range but vad off",
      (r) => {
        r.setNeedVad(0);
        r.setVadSilenceTime(100);
      },
    ],
    ["voice_format wav", (r) => r.setVoiceFormat(12)],
    ["word_info caption", (r) => r.setWordInfo(100)],
  ];
  test.each(valid)("%s passes local validation", (_name, apply) => {
    const recognizer = makeRecognizer();
    apply(recognizer);
    expect(() => (recognizer as any).validateOptions()).not.toThrow();
  });

  test("newCredential skips the Tencent Cloud AppID", () => {
    const cred = newCredential(1400188366, "secret");
    expect(cred.sdkAppId).toBe(1400188366);
    expect(cred.appId).toBe(0);
  });
});
