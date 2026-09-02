import { ASRError, ErrorCode } from "../src/errors";
import {
  Credential,
  HOST_CN,
  HOST_INTL,
  SITE_CN,
  SITE_INTL,
  hostForSite,
  resolveHTTPEndpoint,
  resolveWSEndpoint,
} from "../src/credential";
import { FileRecognizer } from "../src/file-recognizer";
import { SentenceRecognizer } from "../src/sentence-recognizer";
import { SpeechRecognizer } from "../src/speech-recognizer";

describe("site selection", () => {
  test("hostForSite maps empty/cn to domestic and intl to international", () => {
    expect(hostForSite("")).toBe(HOST_CN);
    expect(hostForSite(SITE_CN)).toBe(HOST_CN);
    expect(hostForSite("CN")).toBe(HOST_CN);
    expect(hostForSite(" cn ")).toBe(HOST_CN);
    expect(hostForSite(SITE_INTL)).toBe(HOST_INTL);
    expect(hostForSite("INTL")).toBe(HOST_INTL);
    try {
      hostForSite("mars");
      fail("expected error");
    } catch (err) {
      expect(err).toBeInstanceOf(ASRError);
      expect((err as ASRError).code).toBe(ErrorCode.INVALID_PARAM);
    }
  });

  test("resolve helpers honor override and site", () => {
    expect(resolveWSEndpoint("", SITE_INTL)).toBe("wss://" + HOST_INTL);
    expect(resolveHTTPEndpoint("", "")).toBe("https://" + HOST_CN);
    expect(resolveWSEndpoint("wss://mock.local", SITE_INTL)).toBe(
      "wss://mock.local",
    );
  });

  test("Credential.setSite stores the cluster", () => {
    const cred = new Credential(1, 2, "k");
    expect(cred.site).toBe("");
    cred.setSite(SITE_INTL);
    expect(cred.site).toBe(SITE_INTL);
  });

  test("recognizers derive intl endpoints until setEndpoint wins", () => {
    const cred = new Credential(1300000000, 1400000000, "secret");
    cred.setSite(SITE_INTL);

    const speech = new SpeechRecognizer(cred, "16k_zh");
    expect(resolveWSEndpoint((speech as any).endpoint, cred.site)).toBe(
      "wss://asr-intl.cloud-rtc.com",
    );
    speech.setEndpoint("wss://127.0.0.1:9");
    expect(resolveWSEndpoint((speech as any).endpoint, cred.site)).toBe(
      "wss://127.0.0.1:9",
    );

    const sent = new SentenceRecognizer(cred);
    expect(resolveHTTPEndpoint((sent as any).endpoint, cred.site)).toBe(
      "https://asr-intl.cloud-rtc.com",
    );

    const file = new FileRecognizer(cred);
    expect(resolveHTTPEndpoint((file as any).endpoint, cred.site)).toBe(
      "https://asr-intl.cloud-rtc.com",
    );
  });
});
