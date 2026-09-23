/** v2 断点续传：query 参数下发、本地校验与首响应 speaker_continue 捕获。 */
import { WebSocketServer, WebSocket } from "ws";

import { Credential } from "../src/credential";
import { SignatureParams } from "../src/signature";
import { SpeechRecognizer, SpeakerContinue } from "../src/speech-recognizer";

function makeCredential(): Credential {
  return new Credential(1300000000, 1400000000, "test-secret");
}

const SPEAKER_CONTEXT_SYNC = 1;

describe("v2 speaker context (断点续传)", () => {
  test("signature params emit enable_speaker_context / speaker_context_id", () => {
    const p = new SignatureParams({
      appId: 1400000000,
      engineModelType: "bigmodel",
      voiceId: "v1",
      speakerDiarization: 1,
      enableSpeakerContext: SPEAKER_CONTEXT_SYNC,
      speakerContextId: "abc123",
    });
    const query = p.buildQueryString();
    expect(query).toContain("enable_speaker_context=1");
    expect(query).toContain("speaker_context_id=abc123");

    // 关闭时不下发；只带 id 也不下发
    const off = new SignatureParams({
      appId: 1400000000,
      engineModelType: "bigmodel",
      voiceId: "v1",
      speakerDiarization: 1,
      speakerContextId: "abc123",
    });
    expect(off.buildQueryString()).not.toContain("speaker_context");
  });

  test("enable_speaker_context requires speaker diarization", async () => {
    const recognizer = new SpeechRecognizer(makeCredential(), "bigmodel");
    recognizer.setEnableSpeakerContext(SPEAKER_CONTEXT_SYNC);
    await expect(recognizer.start()).rejects.toThrow(/setSpeakerDiarization/);
  });

  test("enable_speaker_context rejects unknown modes", async () => {
    const recognizer = new SpeechRecognizer(makeCredential(), "bigmodel");
    recognizer.setSpeakerDiarization(1);
    recognizer.setEnableSpeakerContext(3);
    await expect(recognizer.start()).rejects.toThrow(/EnableSpeakerContext/);
  });

  test(
    "start query carries the context params and first response is captured",
    (done) => {
      let serverQuery = "";
      let captured: SpeakerContinue | null = null;

      const wss = new WebSocketServer({ port: 0 }, () => {
        const addr = wss.address() as { port: number };
        const recognizer = new SpeechRecognizer(makeCredential(), "bigmodel");
        recognizer.setEndpoint(`ws://127.0.0.1:${addr.port}`);
        recognizer.setSpeakerDiarization(1);
        recognizer.setEnableSpeakerContext(SPEAKER_CONTEXT_SYNC);
        recognizer.setSpeakerContextId("feedface");
        recognizer
          .start()
          .then(async () => {
            // v2 的 onRecognitionStart 先于服务端首响应，且该响应无 result
            // 不会触发任何回调，只能轮询 getter。
            for (let i = 0; i < 50 && !captured; i++) {
              captured = recognizer.getSpeakerContinue();
              if (!captured) await new Promise((r) => setTimeout(r, 20));
            }
            await recognizer.stop();
          })
          .catch((err) => done.fail(err as string));
      });

      wss.on("connection", (ws, req) => {
        serverQuery = req.url || "";
        ws.send(
          JSON.stringify({
            code: 0,
            message: "success",
            voice_id: "v1",
            speaker_continue: {
              continue_status: "resumed",
              speaker_context_id: "feedface",
            },
          }),
        );
        ws.send(
          JSON.stringify({
            code: 0,
            message: "success",
            voice_id: "v1",
            final: 1,
            result: { slice_type: 2, index: 0 },
          }),
        );
      });

      setTimeout(() => {
        try {
          expect(serverQuery).toContain("enable_speaker_context=1");
          expect(serverQuery).toContain("speaker_context_id=feedface");
          expect(captured).not.toBeNull();
          expect((captured as SpeakerContinue).continue_status).toBe("resumed");
          done();
        } catch (err) {
          done(err as Error);
        } finally {
          wss.close();
        }
      }, 1500);
    },
    10000,
  );
});
