/**
 * Speaker diarization / VAD tuning end-to-end tests (aligned with Go
 * asr/diarization_test.go, asr/file_recognizer_speaker_test.go and
 * asr/sentence_recognizer_speaker_test.go).
 */

import { Credential } from "../src/credential";
import { ASRError, ErrorCode } from "../src/errors";
import {
  CreateRecTaskRequest,
  FileRecognizer,
} from "../src/file-recognizer";
import {
  SentenceRecognitionRequest,
  SentenceRecognizer,
} from "../src/sentence-recognizer";
import {
  SPEAKER_DIARIZATION_VOICEPRINT,
  SpeakerRole,
} from "../src/signature";
import {
  SpeechRecognizer,
  SpeechRecognitionListener,
  SpeechRecognitionResponse,
} from "../src/speech-recognizer";

// Mock the ws default export so the WebSocket constructor is captured
// instead of dialing the network. The fake connection fires "open" right
// away so start() resolves.
jest.mock("ws", () => {
  const mockWs: any = jest.fn().mockImplementation(function (this: any) {
    return {
      on(event: string, handler: (...args: unknown[]) => void) {
        if (event === "open") {
          handler();
        }
        return this;
      },
      close() {
        /* noop */
      },
    };
  });
  mockWs.default = mockWs;
  return mockWs;
});

function makeCredential(): Credential {
  return new Credential(1300000000, 1400000000, "test-secret");
}

// --------------------------------------------------------------- message
// pump (Go: TestReadLoopDecodesSpeakerDiarizationResult and the ack-frame
// skip fix)

const DIARIZATION_END_MESSAGE = {
  code: 0,
  message: "ok",
  voice_id: "v1",
  result: {
    slice_type: 2,
    index: 1,
    start_time: 3640,
    end_time: 6600,
    voice_text_str: "你好 嗯我想咨询一下",
    word_size: 3,
    finish_silence_ms: 800,
    last_token_runtime_ms: 42,
    word_list: [
      { word: "你", start_time: 3640, end_time: 3760, stable_flag: 1, speaker_id: 1, speaker_name: "teacher" },
      { word: "好", start_time: 3760, end_time: 3880, stable_flag: 1, speaker_id: 1, speaker_name: "teacher" },
      { word: "嗯", start_time: 5400, end_time: 5550, stable_flag: 1, speaker_id: 2, speaker_name: "student" },
    ],
    speaker_segments: [
      { speaker_id: 1, speaker_name: "teacher", start_time: 3640, end_time: 3880, text: "你好", word_start: 0, word_end: 1, stable_flag: 1 },
      { speaker_id: 2, speaker_name: "student", start_time: 5400, end_time: 6600, text: "嗯我想咨询一下", stable_flag: 0 },
    ],
  },
};

interface Captured {
  start: string[];
  begin: number[];
  change: string[];
  end: SpeechRecognitionResponse[];
  complete: string[];
  fail: [SpeechRecognitionResponse | null, Error][];
}

function makeCaptureListener(): { listener: SpeechRecognitionListener; captured: Captured } {
  const captured: Captured = {
    start: [],
    begin: [],
    change: [],
    end: [],
    complete: [],
    fail: [],
  };
  return {
    captured,
    listener: {
      onRecognitionStart: (resp) => captured.start.push(resp.voice_id),
      onSentenceBegin: (resp) => captured.begin.push(resp.result?.index ?? -1),
      onRecognitionResultChange: (resp) => captured.change.push(resp.result?.voice_text_str ?? ""),
      onSentenceEnd: (resp) => captured.end.push(resp),
      onRecognitionComplete: (resp) => captured.complete.push(resp.voice_id),
      onFail: (resp, err) => captured.fail.push([resp, err]),
    },
  };
}

function makeRecognizer(listener: SpeechRecognitionListener): SpeechRecognizer {
  return new SpeechRecognizer(makeCredential(), "16k_zh", listener);
}

describe("message pump diarization decoding", () => {
  test("decodes every speaker field on a sentence end", () => {
    const { captured, listener } = makeCaptureListener();
    const recognizer = makeRecognizer(listener);

    (recognizer as any).handleMessage(JSON.stringify(DIARIZATION_END_MESSAGE));

    expect(captured.end).toHaveLength(1);
    const resp = captured.end[0];

    expect(resp.result?.speaker_segments).toHaveLength(2);
    const first = resp.result!.speaker_segments![0];
    expect(first.speaker_id).toBe(1);
    expect(first.speaker_name).toBe("teacher");
    expect(first.text).toBe("你好");
    expect(first.start_time).toBe(3640);
    expect(first.end_time).toBe(3880);
    expect(first.stable_flag).toBe(1);
    expect(first.word_start).toBe(0);
    expect(first.word_end).toBe(1);

    const second = resp.result!.speaker_segments![1];
    // word_info-less segments omit the indexes; undefined must be preserved
    // so the caller can tell "no index" from index 0.
    expect(second.word_start).toBeUndefined();
    expect(second.word_end).toBeUndefined();
    expect(second.stable_flag).toBe(0);

    expect(resp.result?.word_list).toHaveLength(3);
    const w = resp.result!.word_list[2];
    expect(w.speaker_id).toBe(2);
    expect(w.speaker_name).toBe("student");

    expect(resp.result?.finish_silence_ms).toBe(800);
    expect(resp.result?.last_token_runtime_ms).toBe(42);
    // The sentence-level speaker stays absent on this engine; undefined
    // distinguishes that from speaker 0.
    expect(resp.result?.speaker_id).toBeUndefined();
  });

  test("skips the connection ack frame (no result object)", () => {
    const { captured, listener } = makeCaptureListener();
    const recognizer = makeRecognizer(listener);

    const ack = JSON.stringify({ code: 0, message: "success", voice_id: "v1" });
    (recognizer as any).handleMessage(ack);
    (recognizer as any).handleMessage(ack);

    // No spurious onSentenceBegin from the zero-valued slice_type.
    expect(captured.begin).toHaveLength(0);
    expect(captured.end).toHaveLength(0);
    expect(captured.fail).toHaveLength(0);
  });

  test("final frame: sentence end dispatched, then complete, state stopped", () => {
    const { captured, listener } = makeCaptureListener();
    const recognizer = makeRecognizer(listener);

    const frame = { ...DIARIZATION_END_MESSAGE, final: 1 };
    (recognizer as any).handleMessage(JSON.stringify(frame));

    expect(captured.end).toHaveLength(1);
    expect(captured.complete).toEqual(["v1"]);
    // Terminal response: the recognizer reached the stopped state before
    // the complete callback, so a re-entrant stop() would reject immediately.
    expect((recognizer as any).state).toBe(4); // STOPPED
    expect(captured.fail).toHaveLength(0);
  });

  test("final frame without slice_type=2 dispatches nothing but complete", () => {
    const { captured, listener } = makeCaptureListener();
    const recognizer = makeRecognizer(listener);

    const frame = {
      code: 0,
      message: "ok",
      voice_id: "v1",
      final: 1,
      result: { slice_type: 1, index: 0, voice_text_str: "x" },
    };
    (recognizer as any).handleMessage(JSON.stringify(frame));

    expect(captured.begin).toHaveLength(0);
    expect(captured.change).toHaveLength(0);
    expect(captured.end).toHaveLength(0);
    expect(captured.complete).toEqual(["v1"]);
    expect((recognizer as any).state).toBe(4); // STOPPED
  });

  test("swallows listener exceptions (panic shielding)", () => {
    const base = makeCaptureListener();
    const brokenListener: SpeechRecognitionListener = {
      ...base.listener,
      onSentenceEnd: () => {
        throw new Error("listener bug");
      },
    };
    const recognizer = makeRecognizer(brokenListener);

    const frame = {
      code: 0,
      message: "ok",
      voice_id: "v1",
      final: 1,
      result: { slice_type: 2, index: 0, voice_text_str: "x" },
    };

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() =>
        (recognizer as any).handleMessage(JSON.stringify(frame)),
      ).not.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("listener callback raised"),
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
    }

    // complete still delivered after the broken sentence-end callback.
    expect(base.captured.complete).toEqual(["v1"]);
    expect((recognizer as any).state).toBe(4); // STOPPED
  });

  test("non-zero code: state stopped before onFail", () => {
    const { captured, listener } = makeCaptureListener();
    const recognizer = makeRecognizer(listener);

    const frame = { code: 4001, message: "参数不合法", voice_id: "v1" };
    (recognizer as any).handleMessage(JSON.stringify(frame));

    expect(captured.fail).toHaveLength(1);
    expect((captured.fail[0][1] as ASRError).code).toBe(4001);
    expect((recognizer as any).state).toBe(4); // STOPPED
  });
});

describe("start() local validation", () => {
  test("rejects roles without mode 3 before dialing", async () => {
    const { listener } = makeCaptureListener();
    const recognizer = makeRecognizer(listener);
    recognizer.setSpeakerRoles([
      { roleName: "teacher", audioUrl: "https://example.com/a.wav" },
    ]);

    await expect(recognizer.start()).rejects.toMatchObject({
      code: ErrorCode.INVALID_PARAM,
    });
    await expect(recognizer.start()).rejects.toThrow(
      /require SpeakerDiarization=3/,
    );
    // Invalid options leave the recognizer idle and restartable.
    expect((recognizer as any).state).toBe(0); // IDLE
  });

  test("rejects out-of-range noise threshold", async () => {
    const { listener } = makeCaptureListener();
    const recognizer = makeRecognizer(listener);
    recognizer.setNoiseThreshold(4.5);

    await expect(recognizer.start()).rejects.toThrow(
      /NoiseThreshold must be between 0.0 and 4.0/,
    );
  });
});

describe("connect() query authentication", () => {
  test("sends speaker / VAD options and auth identity in the query string", async () => {
    // The ws module is mocked at the file level; grab the mock to inspect
    // the constructor calls.
    const wsMock = require("ws") as jest.Mock;

    const credential = makeCredential();
    const recognizer = new SpeechRecognizer(credential, "16k_zh", makeCaptureListener().listener);
    recognizer.setVoiceId("voice-diarization");
    recognizer.setWordInfo(1);
    recognizer.setSpeakerDiarization(SPEAKER_DIARIZATION_VOICEPRINT);
    recognizer.setSpeakerNumber(2);
    recognizer.setSpeakerRoles([
      { roleName: "teacher", audioUrl: "https://example.com/a.wav" },
    ]);
    recognizer.setVoiceprintIds(["vp-1"]);
    recognizer.setVadLevel(0);
    recognizer.setNoiseThreshold(1.5);
    recognizer.setFilterEmptyResult(0);
    recognizer.setHotwordList("腾讯云|5");
    recognizer.setReplaceTextId("replace-1");
    recognizer.setInputSampleRate(8000);

    await recognizer.start();

    expect(wsMock.mock.calls.length).toBeGreaterThan(0);
    const capturedUrl = wsMock.mock.calls[0][0] as string;
    const capturedOptions = wsMock.mock.calls[0][1] as any;

    const query = new URLSearchParams(capturedUrl.split("?")[1]);
    expect(query.get("sdkappid")).toBe("1400000000");
    expect(query.get("speaker_diarization")).toBe("3");
    expect(query.get("speaker_number")).toBe("2");
    expect(query.get("voiceprintids")).toBe('["vp-1"]');
    expect(query.get("vad_level")).toBe("0");
    expect(query.get("noise_threshold")).toBe("1.500");
    expect(query.get("filter_empty_result")).toBe("0");
    expect(query.get("hotword_list")).toBe("腾讯云|5");
    expect(query.get("replace_text_id")).toBe("replace-1");
    expect(query.get("input_sample_rate")).toBe("8000");
    expect(query.get("word_info")).toBe("1");
    const roles = JSON.parse(query.get("speaker_roles") || "[]");
    expect(roles[0].RoleName).toBe("teacher");

    // signature and usersig carry the same UserSig value.
    const sig = query.get("signature");
    const sigQ = query.get("usersig");
    expect(sig).toBeTruthy();
    expect(sigQ).toBe(sig);

    // No auth identity in handshake options any more (query-only auth).
    expect(capturedOptions?.headers).toBeUndefined();

    // The UserSig is resolved locally and never written back to the shared
    // credential: a single Credential reused by concurrent recognizers
    // must not race (mirrors the Go fix).
    expect(credential.userSig).toBe("");
  });
});

// ---------------------------------------------------------------- file
// recognizer (Go: TestFileRecognizer_CreateTask_SpeakerDiarizationBody and
// friends)

function mockFetchOnce(body: unknown): { calls: any[] } {
  const calls: any[] = [];
  (global as any).fetch = async (url: string, init?: any) => {
    calls.push({ url, init });
    return {
      status: 200,
      text: async () => JSON.stringify(body),
    };
  };
  return { calls };
}

describe("FileRecognizer speaker diarization", () => {
  afterEach(() => {
    delete (global as any).fetch;
  });

  test("serializes diarization / VAD fields with server-side names", async () => {
    const { calls } = mockFetchOnce({
      Response: { Data: { RecTaskId: "task-1" }, RequestId: "r1" },
    });

    const recognizer = new FileRecognizer(makeCredential());
    const req: CreateRecTaskRequest = {
      engineModelType: "16k_zh",
      channelNum: 1,
      resTextFormat: 1,
      sourceType: 0,
      url: "https://example.com/audio.wav",
      speakerDiarization: SPEAKER_DIARIZATION_VOICEPRINT,
      speakerNumber: 2,
      speakerRoles: [
        { roleName: "teacher", audioUrl: "https://example.com/a.wav" },
      ],
      voiceprintIds: ["vp-1"],
      vadSilenceMs: 800,
      vadLevel: 0,
      noiseThreshold: 0.0,
      language: "zh",
      replaceTextId: "replace-1",
    };

    await expect(recognizer.createTask(req)).resolves.toBe("task-1");

    const body = JSON.parse(calls[0].init.body);
    // Explicit zeros must survive: undefined means "not configured" while 0
    // is a valid, meaningful value for both VadLevel and NoiseThreshold.
    expect(body.SpeakerDiarization).toBe(3);
    expect(body.SpeakerNumber).toBe(2);
    expect(body.VadSilenceMs).toBe(800);
    expect(body.VadLevel).toBe(0);
    expect(body.NoiseThreshold).toBe(0);
    expect(body.Language).toBe("zh");
    expect(body.ReplaceTextId).toBe("replace-1");

    expect(body.SpeakerRoles).toEqual([
      { RoleName: "teacher", AudioUrl: "https://example.com/a.wav" },
    ]);
    expect(body.VoiceprintIds).toEqual(["vp-1"]);
  });

  test("rejects roles without SpeakerDiarization=3", async () => {
    const recognizer = new FileRecognizer(makeCredential());
    const req: CreateRecTaskRequest = {
      engineModelType: "16k_zh",
      channelNum: 1,
      resTextFormat: 1,
      sourceType: 0,
      url: "https://example.com/audio.wav",
      speakerRoles: [
        { roleName: "teacher", audioUrl: "https://example.com/a.wav" },
      ],
    };

    await expect(recognizer.createTask(req)).rejects.toThrow(
      /require SpeakerDiarization=3/,
    );
  });

  test("parses per-sentence speaker fields and progress", async () => {
    mockFetchOnce({
      Response: {
        RequestId: "req-1",
        Data: {
          RecTaskId: "task-1",
          Status: 2,
          StatusStr: "success",
          Progress: 100,
          AudioDuration: 12.5,
          Result: "你好\n嗯",
          ResultDetail: [
            {
              FinalSentence: "你好",
              StartMs: 0,
              EndMs: 1200,
              WordsNum: 2,
              Words: [{ Word: "你", OffsetStartMs: 0, OffsetEndMs: 120 }],
              SpeakerId: 1,
              SpeakerRoleName: "teacher",
              Language: "zh",
            },
            {
              FinalSentence: "嗯",
              StartMs: 1300,
              EndMs: 1500,
              SpeakerId: 2,
              ChannelId: 2,
            },
          ],
        },
      },
    });

    const recognizer = new FileRecognizer(makeCredential());
    const status = await recognizer.describeTaskStatus("task-1");

    expect(status.progress).toBe(100);
    expect(status.resultDetail).toHaveLength(2);

    const first = status.resultDetail[0];
    expect(first.speakerId).toBe(1);
    expect(first.speakerRoleName).toBe("teacher");
    expect(first.language).toBe("zh");

    // Stereo recordings report the channel instead of a clustered speaker.
    expect(status.resultDetail[1].channelId).toBe(2);
  });
});

// ---------------------------------------------------------------- sentence
// recognizer (Go:
// TestSentenceRecognizer_Recognize_CustomizationAndLanguageBody)

describe("SentenceRecognizer customization / language body", () => {
  afterEach(() => {
    delete (global as any).fetch;
  });

  test("serializes CustomizationId / Language and never speaker fields", async () => {
    const { calls } = mockFetchOnce({
      Response: { Result: "ok", RequestId: "req-1" },
    });

    const recognizer = new SentenceRecognizer(makeCredential());
    const req: SentenceRecognitionRequest = {
      engServiceType: "16k_zh",
      sourceType: 0,
      voiceFormat: "wav",
      url: "https://example.com/a.wav",
      customizationId: "custom-1",
      language: "zh",
    };

    await recognizer.recognize(req);

    const body = JSON.parse(calls[0].init.body);
    expect(body.CustomizationId).toBe("custom-1");
    expect(body.Language).toBe("zh");
    // Sentence recognition does not support speaker diarization; the request
    // must not grow those fields.
    expect(body.SpeakerDiarization).toBeUndefined();
  });
});
