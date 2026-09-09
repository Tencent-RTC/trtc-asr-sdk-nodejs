/**
 * v3 offline interface tests (/v3/transcribe, /v3/create_transcription,
 * /v3/describe_transcription): wire format, flat responses, error mapping.
 */

import { ASRError, ErrorCode } from "../src/errors";
import {
  FileRecognizer,
  CreateTranscriptionRequest,
} from "../src/v3/file-recognizer";
import {
  SentenceRecognizer,
  TranscribeRequest,
} from "../src/v3/sentence-recognizer";
import {
  AudioURLItem,
  Context,
  SOURCE_TYPE_DATA,
  SOURCE_TYPE_URL,
  SPEAKER_DIARIZATION_CLUSTER,
  SPEAKER_DIARIZATION_VOICEPRINT,
  newCredential,
} from "../src/v3/wire";

function makeCredential() {
  return newCredential(1400000000, "test-secret");
}

function mockFetch(responses: Array<{ status: number; body: string }>): jest.Mock {
  const fetchMock = jest.fn();
  for (const r of responses) {
    fetchMock.mockResolvedValueOnce({
      status: r.status,
      text: async () => r.body,
    });
  }
  (global as any).fetch = fetchMock;
  return fetchMock;
}

function lastBody(fetchMock: jest.Mock): any {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return JSON.parse(call[1].body);
}

function lastURL(fetchMock: jest.Mock): string {
  return fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0];
}

// ---------------------------------------------------------------- transcribe

describe("v3 /v3/transcribe", () => {
  test("wire format: {auth, params} snake_case, no query, no headers", async () => {
    const fetchMock = mockFetch([
      {
        status: 200,
        body: JSON.stringify({
          code: 0,
          message: "success",
          request_id: "req-1",
          result: "你好世界",
          audio_duration: 1500,
          language: "zh",
          word_size: 2,
          word_list: [
            { word: "你好", start_time: 0, end_time: 500 },
            { word: "世界", start_time: 500, end_time: 1500 },
          ],
        }),
      },
    ]);

    const recognizer = new SentenceRecognizer(makeCredential());
    const resp = await recognizer.recognize({
      engine_model_type: "16k_zh_en",
      source_type: SOURCE_TYPE_DATA,
      voice_format: "pcm",
      data: Buffer.from("pcm-data").toString("base64"),
      data_len: 8,
      hotword_list: "腾讯云|10",
      needvad: 0, // explicit 0 honored
      language: "zh",
      convert_num_mode: 1,
      word_info: 1,
      filter_punc: 1,
      input_sample_rate: 8000,
      customization_id: "cust-1",
      context: { text: "bg", terms: ["ASR"] },
    });

    expect(lastURL(fetchMock)).toMatch(/\/v3\/transcribe$/);
    expect(lastURL(fetchMock)).not.toContain("?");

    const body = lastBody(fetchMock);
    const auth = body.auth;
    expect(auth.sdkappid).toBe("1400000000");
    expect(auth.usersig).toBeTruthy();
    expect(auth.request_id).toBeTruthy();
    expect(auth.business).toBeUndefined();

    const params = body.params;
    expect(params.engine_model_type).toBe("16k_zh_en");
    expect(params.source_type).toBe(1);
    expect(params.voice_format).toBe("pcm");
    expect(params.data).toBe(Buffer.from("pcm-data").toString("base64"));
    expect(params.data_len).toBe(8);
    expect(params.hotword_list).toBe("腾讯云|10");
    expect(params.needvad).toBe(0);
    expect(params.language).toBe("zh");
    expect(params.word_info).toBe(1);
    expect(params.filter_punc).toBe(1);
    expect(params.input_sample_rate).toBe(8000);
    expect(params.customization_id).toBe("cust-1");
    expect(params.sdk_info.sdk_lang).toBe("nodejs");
    expect(params.context).toEqual({ text: "bg", terms: ["ASR"] });

    expect(resp.result).toBe("你好世界");
    expect(resp.audio_duration).toBe(1500);
    expect(resp.request_id).toBe("req-1");
    expect(resp.word_list[0]).toEqual({ word: "你好", start_time: 0, end_time: 500 });
  });

  test("auth failure: HTTP 200 + body code 4002 → ASRError(4002)", async () => {
    mockFetch([
      { status: 200, body: JSON.stringify({ code: 4002, message: "auth failed", request_id: "req-x" }) },
    ]);
    const recognizer = new SentenceRecognizer(makeCredential());
    const err: ASRError = await recognizer
      .recognizeURL("https://example.com/a.wav", "wav", "16k_zh_en")
      .then(() => {
        throw new Error("expected rejection");
      })
      .catch((e) => e);
    expect(err.code).toBe(4002);
    expect(err.message).toContain("req-x");
  });

  test("503 + flat body code 5000 surfaces the server code", async () => {
    mockFetch([
      { status: 503, body: JSON.stringify({ code: 5000, message: "no worker available", request_id: "r" }) },
    ]);
    const recognizer = new SentenceRecognizer(makeCredential());
    await expect(
      recognizer.recognizeURL("https://example.com/a.wav", "wav", "16k_zh_en"),
    ).rejects.toMatchObject({ code: 5000 });
  });

  test("non-2xx JSON body without code must not be treated as success", async () => {
    mockFetch([{ status: 502, body: JSON.stringify({ error: "upstream unavailable" }) }]);
    const recognizer = new SentenceRecognizer(makeCredential());
    const err: ASRError = await recognizer
      .recognizeURL("https://example.com/a.wav", "wav", "16k_zh_en")
      .then(() => {
        throw new Error("expected rejection");
      })
      .catch((e) => e);
    expect(err.code).toBe(ErrorCode.SERVER_ERROR);
  });

  test("local validation: empty data, missing engine, nil options request", async () => {
    const recognizer = new SentenceRecognizer(makeCredential());
    await expect(recognizer.recognizeData(Buffer.alloc(0), "pcm", "16k_zh_en")).rejects.toMatchObject({
      code: ErrorCode.INVALID_PARAM,
    });
    await expect(
      recognizer.recognize({ engine_model_type: "", source_type: SOURCE_TYPE_DATA, voice_format: "pcm" }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAM });
    await expect(
      recognizer.recognizeDataWithOptions(Buffer.from("abc"), null as any),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAM });
    await expect(
      recognizer.recognize({
        engine_model_type: "16k_zh_en",
        source_type: SOURCE_TYPE_URL,
        voice_format: "wav",
        url: "https://example.com/a.wav",
        needvad: 2,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAM });
  });
});

// ---------------------------------------------------------------- create

describe("v3 /v3/create_transcription", () => {
  test("wire format and transcription_id extraction", async () => {
    const fetchMock = mockFetch([
      { status: 200, body: JSON.stringify({ code: 0, message: "success", request_id: "r", transcription_id: "tid-abc" }) },
    ]);
    const recognizer = new FileRecognizer(makeCredential());
    const id = await recognizer.createTask({
      engine_model_type: "16k_zh_en",
      channel_num: 1,
      res_text_format: 1,
      source_type: SOURCE_TYPE_URL,
      url: "https://example.com/a.wav",
      callback_url: "https://example.com/cb",
      hotword_id: "hw-1",
      vad_silence_ms: 600,
      vad_level: 1,
      language: "zh",
      speaker_diarization: SPEAKER_DIARIZATION_VOICEPRINT,
      speaker_roles: [{ role_name: "teacher", audio_url: "https://example.com/t.wav" }],
      voiceprint_ids: ["vp-1"],
    });
    expect(id).toBe("tid-abc");
    expect(lastURL(fetchMock)).toMatch(/\/v3\/create_transcription$/);

    const body = lastBody(fetchMock);
    expect(body.auth.sdkappid).toBe("1400000000");
    const params = body.params;
    for (const key of [
      "engine_model_type",
      "channel_num",
      "res_text_format",
      "source_type",
      "url",
      "callback_url",
      "hotword_id",
      "vad_silence_ms",
      "vad_level",
      "language",
      "speaker_diarization",
      "speaker_roles",
      "voiceprint_ids",
      "sdk_info",
    ]) {
      expect(params[key]).toBeDefined();
    }
    expect(params.speaker_roles).toEqual([
      { role_name: "teacher", audio_url: "https://example.com/t.wav" },
    ]);
  });

  test("audio_urls distributed path passes and serializes", async () => {
    const fetchMock = mockFetch([
      { status: 200, body: JSON.stringify({ code: 0, message: "success", transcription_id: "tid-d" }) },
    ]);
    const recognizer = new FileRecognizer(makeCredential());
    const id = await recognizer.createTask({
      engine_model_type: "16k_zh_en",
      channel_num: 1,
      res_text_format: 1,
      source_type: SOURCE_TYPE_URL, // zero value; url/data stay empty
      speaker_diarization: SPEAKER_DIARIZATION_CLUSTER,
      audio_urls: [
        { index: 0, url: "https://example.com/a.wav", label: "a" },
        { index: 1, url: "https://example.com/b.wav" },
      ],
    });
    expect(id).toBe("tid-d");
    expect(lastBody(fetchMock).params.audio_urls).toEqual([
      { index: 0, url: "https://example.com/a.wav", label: "a" },
      { index: 1, url: "https://example.com/b.wav" },
    ]);
  });

  test("audio_urls rejects mixed single-audio sources and bad items", async () => {
    const recognizer = new FileRecognizer(makeCredential());
    const base = {
      engine_model_type: "16k_zh_en",
      channel_num: 1,
      res_text_format: 1,
      source_type: SOURCE_TYPE_URL,
      audio_urls: [{ index: 0, url: "https://example.com/a.wav" }],
    };
    await expect(
      recognizer.createTask({ ...base, url: "https://example.com/x.wav" } as any),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAM });
    await expect(
      recognizer.createTask({ ...base, data: "AAAA", data_len: 3 } as any),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAM });
    await expect(
      recognizer.createTask({ ...base, source_type: SOURCE_TYPE_DATA } as any),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAM });
    await expect(
      recognizer.createTask({ ...base, audio_urls: [{ index: -1, url: "https://x" }] }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAM });
    await expect(
      recognizer.createTask({
        ...base,
        audio_urls: [
          { index: 0, url: "https://x" },
          { index: 0, url: "https://y" },
        ],
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAM });
    await expect(
      recognizer.createTask({ ...base, audio_urls: [{ index: 0, url: "ftp://x/a" }] }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAM });
  });

  test("code=0 without transcription_id fails", async () => {
    mockFetch([{ status: 200, body: JSON.stringify({ code: 0, message: "success" }) }]);
    const recognizer = new FileRecognizer(makeCredential());
    await expect(
      recognizer.createTaskFromURL("https://example.com/a.wav", "16k_zh_en"),
    ).rejects.toMatchObject({ code: ErrorCode.SERVER_ERROR });
  });

  test("nil request in createTaskFromDataWithOptions", async () => {
    const recognizer = new FileRecognizer(makeCredential());
    await expect(
      recognizer.createTaskFromDataWithOptions(Buffer.from("abc"), null as any),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAM });
  });
});

// ---------------------------------------------------------------- describe

describe("v3 /v3/describe_transcription", () => {
  test("polling and snake_case result_detail mapping", async () => {
    const fetchMock = mockFetch([
      {
        status: 200,
        body: JSON.stringify({
          code: 0,
          message: "success",
          request_id: "r1",
          transcription_id: "t1",
          status: 1,
          status_str: "executing",
          progress: 40,
        }),
      },
      {
        status: 200,
        body: JSON.stringify({
          code: 0,
          message: "success",
          request_id: "r2",
          transcription_id: "t1",
          status: 2,
          status_str: "success",
          progress: 100,
          audio_duration: 6.312,
          result: "全文",
          result_detail: [
            {
              final_sentence: "第一句话。",
              start_ms: 0,
              end_ms: 1200,
              words_num: 1,
              words: [{ word: "第一句", start_time: 0, end_time: 900 }],
              speaker_id: 1,
              speaker_role_name: "teacher",
              channel_id: 0,
              speech_speed: 3.2,
              language: "zh",
              language_b47: "zh-CN",
            },
          ],
        }),
      },
    ]);

    const recognizer = new FileRecognizer(makeCredential());
    const status = await recognizer.waitForResultWithInterval("t1", 1, 5000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastURL(fetchMock)).toMatch(/\/v3\/describe_transcription$/);
    expect(lastBody(fetchMock).params.transcription_id).toBe("t1");

    expect(status.status).toBe(2);
    expect(status.result).toBe("全文");
    expect(status.audio_duration).toBeCloseTo(6.312);
    const d = status.result_detail[0];
    expect(d.final_sentence).toBe("第一句话。");
    expect(d.speaker_id).toBe(1);
    expect(d.speaker_role_name).toBe("teacher");
    expect(d.words[0]).toEqual({ word: "第一句", start_time: 0, end_time: 900 });
    expect(d.language_b47).toBe("zh-CN");
  });

  test("cross-account query: 403 + 4002 surfaces the body code", async () => {
    mockFetch([
      {
        status: 403,
        body: JSON.stringify({
          code: 4002,
          message: "transcription_id does not belong to this sdkappid",
          request_id: "r",
        }),
      },
    ]);
    const recognizer = new FileRecognizer(makeCredential());
    await expect(recognizer.describeTask("tid-foreign")).rejects.toMatchObject({ code: 4002 });
  });
});
