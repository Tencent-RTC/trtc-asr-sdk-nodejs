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
