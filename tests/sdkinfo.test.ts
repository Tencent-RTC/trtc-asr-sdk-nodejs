/**
 * SDK self-identification reporting tests (aligned with Go
 * asr/sdkinfo_test.go).
 *
 * Every transport must carry platform / sdk_lang / sdk_type / version so a
 * customer report can be traced back to a concrete client build.
 */

import { Credential } from "../src/credential";
import { FileRecognizer } from "../src/file-recognizer";
import {
  SDK_LANGUAGE,
  SDK_TYPE,
  SDK_VERSION,
  sdkPlatform,
  sdkReportQuery,
} from "../src/sdkinfo";
import { SentenceRecognizer, SourceType } from "../src/sentence-recognizer";
import { SignatureParams } from "../src/signature";
import {
  SpeechRecognitionListener,
  SpeechRecognizer,
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

/**
 * Assert a captured request query carries the SDK identification the service
 * relies on for diagnostics.
 */
function expectSDKReportParams(query: URLSearchParams): void {
  expect(query.get("sdk_lang")).toBe(SDK_LANGUAGE);
  expect(query.get("sdk_type")).toBe(SDK_TYPE);
  expect(query.get("version")).toBe(SDK_VERSION);
  expect(query.get("platform")).toBe(sdkPlatform());
}

/** Install a fetch stub that records the request URL and replies with body. */
function stubFetch(responseBody: unknown): { urls: string[] } {
  const urls: string[] = [];
  (global as any).fetch = jest.fn(async (url: string) => {
    urls.push(url);
    return {
      status: 200,
      text: async () => JSON.stringify(responseBody),
    };
  });
  return { urls };
}

const noopListener: SpeechRecognitionListener = {
  onRecognitionStart: () => undefined,
  onSentenceBegin: () => undefined,
  onRecognitionResultChange: () => undefined,
  onSentenceEnd: () => undefined,
  onRecognitionComplete: () => undefined,
  onFail: () => undefined,
};

describe("sdkinfo", () => {
  test("reports the fixed language, type and version", () => {
    expect(SDK_LANGUAGE).toBe("nodejs");
    expect(SDK_TYPE).toBe("server");
    expect(SDK_VERSION).toBe("1.0.0");
  });

  test("normalizes the current platform to the service vocabulary", () => {
    const platform = sdkPlatform();
    // On unlisted platforms the raw os.platform() value is reported, so only
    // the mapped ones can be asserted against a fixed set.
    const mapped: Record<string, string> = {
      darwin: "mac",
      win32: "windows",
      linux: "linux",
      android: "android",
    };
    const expected = mapped[process.platform] ?? process.platform;
    expect(platform).toBe(expected);
  });

  test("sdkReportQuery is a sorted, encoded fragment without a leading &", () => {
    const query = sdkReportQuery();
    expect(query.startsWith("&")).toBe(false);
    expect(query.split("&").map((p) => p.split("=")[0])).toEqual([
      "platform",
      "sdk_lang",
      "sdk_type",
      "version",
    ]);
    expectSDKReportParams(new URLSearchParams(query));
  });
});

describe("SDK identification on every transport", () => {
  afterEach(() => {
    delete (global as any).fetch;
    jest.clearAllMocks();
  });

  test("WebSocket handshake query reports the SDK identity", async () => {
    const wsMock = require("ws") as jest.Mock;

    const recognizer = new SpeechRecognizer(
      makeCredential(),
      "16k_zh",
      noopListener,
    );
    recognizer.setVoiceId("voice-sdkinfo");

    await recognizer.start();

    expect(wsMock.mock.calls.length).toBeGreaterThan(0);
    const capturedUrl = wsMock.mock.calls[0][0] as string;
    const query = new URLSearchParams(capturedUrl.split("?")[1]);

    expectSDKReportParams(query);
    // The pre-existing protocol parameters must survive the addition.
    expect(query.get("secretid")).toBe("1300000000");
    expect(query.get("sdkappid")).toBe("1400000000");
    expect(query.get("engine_model_type")).toBe("16k_zh");
    expect(query.get("voice_id")).toBe("voice-sdkinfo");
    expect(query.get("signature")).toBeTruthy();
    expect(query.get("usersig")).toBe(query.get("signature"));
    expect(new URL(capturedUrl).host).toBe("asr.cloud-rtc.com");
  });

  test("WebSocket handshake uses the international host when setSite(SITE_INTL)", async () => {
    const wsMock = require("ws") as jest.Mock;
    wsMock.mockClear();

    const cred = makeCredential();
    cred.setSite("intl");
    const recognizer = new SpeechRecognizer(cred, "16k_zh", noopListener);
    await recognizer.start();
    const capturedUrl = wsMock.mock.calls[0][0] as string;
    expect(new URL(capturedUrl).host).toBe("asr-intl.cloud-rtc.com");
  });

  test("SignatureParams query carries the SDK identity", () => {
    const params = new SignatureParams({
      appId: 1300000000,
      engineModelType: "16k_zh",
      voiceId: "voice-1",
    });

    expectSDKReportParams(
      new URLSearchParams(params.buildQueryStringWithSignature("sig")),
    );
    expectSDKReportParams(new URLSearchParams(params.buildQueryString()));
  });

  test("SentenceRecognition request URL reports the SDK identity", async () => {
    const { urls } = stubFetch({
      Response: { RequestId: "req-1", Result: "hello" },
    });

    const recognizer = new SentenceRecognizer(makeCredential());
    await recognizer.recognize({
      engServiceType: "16k_zh",
      voiceFormat: "wav",
      sourceType: SourceType.URL,
      url: "https://example.com/test.wav",
    });

    expect(urls).toHaveLength(1);
    const query = new URLSearchParams(urls[0].split("?")[1]);

    expectSDKReportParams(query);
    expect(query.get("AppId")).toBe("1300000000");
    expect(query.get("Secretid")).toBe("1300000000");
    expect(query.get("RequestId")).toBeTruthy();
    expect(query.get("Timestamp")).toBeTruthy();
  });

  test("CreateRecTask request URL reports the SDK identity", async () => {
    const { urls } = stubFetch({
      Response: { RequestId: "req-1", Data: { RecTaskId: "task-42" } },
    });

    const recognizer = new FileRecognizer(makeCredential());
    const taskId = await recognizer.createTaskFromURL(
      "https://example.com/test.wav",
      "16k_zh",
    );
    expect(taskId).toBe("task-42");

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/v1/CreateRecTask");
    const query = new URLSearchParams(urls[0].split("?")[1]);

    expectSDKReportParams(query);
    expect(query.get("AppId")).toBe("1300000000");
    expect(query.get("Secretid")).toBe("1300000000");
    expect(query.get("RequestId")).toBeTruthy();
    expect(query.get("Timestamp")).toBeTruthy();
  });

  test("DescribeTaskStatus request URL reports the SDK identity", async () => {
    const { urls } = stubFetch({
      Response: {
        RequestId: "req-2",
        Data: { TaskId: 42, Status: 2, StatusStr: "success", Result: "hi" },
      },
    });

    const recognizer = new FileRecognizer(makeCredential());
    await recognizer.describeTaskStatus("task-42");

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/v1/DescribeTaskStatus");
    const query = new URLSearchParams(urls[0].split("?")[1]);

    expectSDKReportParams(query);
    expect(query.get("AppId")).toBe("1300000000");
    expect(query.get("RequestId")).toBeTruthy();
  });
});
