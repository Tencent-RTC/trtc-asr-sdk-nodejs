import { Credential } from "../src/credential";
import { ASRError, ErrorCode } from "../src/errors";
import { SpeechRecognitionListener, SpeechRecognizer } from "../src/speech-recognizer";

function createListener(): SpeechRecognitionListener {
  return {
    onRecognitionStart: () => undefined,
    onSentenceBegin: () => undefined,
    onRecognitionResultChange: () => undefined,
    onSentenceEnd: () => undefined,
    onRecognitionComplete: () => undefined,
    onFail: () => undefined,
  };
}

function createRecognizer(): SpeechRecognizer {
  const credential = new Credential(1300000000, 1400000000, "secret");
  return new SpeechRecognizer(credential, "16k_zh_en", createListener());
}

describe("SpeechRecognizer lifecycle robustness", () => {
  test("write before start should reject with NOT_STARTED", async () => {
    const recognizer = createRecognizer();

    await expect(recognizer.write(Buffer.from("abc"))).rejects.toMatchObject({
      code: ErrorCode.NOT_STARTED,
    });
  });

  test("write when stopped is a no-op", async () => {
    const recognizer = createRecognizer() as any;
    recognizer.state = 4; // STOPPED

    await expect(recognizer.write(Buffer.from("abc"))).resolves.toBeUndefined();
  });

  test("write when stopping is a no-op", async () => {
    const recognizer = createRecognizer() as any;
    recognizer.state = 3; // STOPPING

    await expect(recognizer.write(Buffer.from("abc"))).resolves.toBeUndefined();
  });

  test("partial listener only needs the callbacks it cares about", () => {
    const texts: string[] = [];
    const credential = new Credential(1300000000, 1400000000, "secret");
    const recognizer = new SpeechRecognizer(credential, "16k_zh", {
      onSentenceEnd: (resp) => texts.push(resp.result?.voice_text_str ?? ""),
    });

    (recognizer as any).handleMessage(
      JSON.stringify({
        code: 0,
        message: "ok",
        voice_id: "v1",
        result: { slice_type: 2, index: 1, voice_text_str: "你好" },
      }),
    );

    expect(texts).toEqual(["你好"]);
  });

  test("empty listener is accepted", () => {
    const credential = new Credential(1300000000, 1400000000, "secret");
    const recognizer = new SpeechRecognizer(credential, "16k_zh");

    expect(() =>
      (recognizer as any).handleMessage(
        JSON.stringify({
          code: 0,
          message: "ok",
          voice_id: "v1",
          result: { slice_type: 2, index: 1, voice_text_str: "你好" },
        }),
      ),
    ).not.toThrow();
  });

  test("stop when already stopped is a no-op", async () => {
    const recognizer = createRecognizer() as any;
    recognizer.state = 4; // STOPPED

    await expect(recognizer.stop()).resolves.toBeUndefined();
    expect(recognizer.state).toBe(4);
  });

  test("stop without connection should throw NOT_STARTED and move to STOPPED", async () => {
    const recognizer = createRecognizer() as any;
    recognizer.state = 2; // RUNNING
    recognizer.ws = null;

    await expect(recognizer.stop()).rejects.toMatchObject({
      code: ErrorCode.NOT_STARTED,
    });
    expect(recognizer.state).toBe(4); // STOPPED
  });

  test("stop send failure should throw WRITE_FAILED and move to STOPPED", async () => {
    const recognizer = createRecognizer() as any;
    recognizer.state = 2; // RUNNING
    recognizer.ws = {
      send: (_data: string, cb: (err?: Error) => void) => cb(new Error("send failed")),
      close: () => undefined,
    };

    await expect(recognizer.stop()).rejects.toMatchObject({
      code: ErrorCode.WRITE_FAILED,
    });
    expect(recognizer.state).toBe(4); // STOPPED
  });
});
