/**
 * Realtime speech recognition example over the v3 protocol (/asr/v3).
 *
 * Reads a PCM file (16kHz 16bit mono) and streams it in 200ms chunks.
 *
 * Credentials come from environment variables:
 *   TRTC_ASR_SDK_APP_ID, TRTC_ASR_SECRET_KEY
 * (v3 does not need the Tencent Cloud APPID.)
 *
 * Prerequisite: the server has enabled the EnableV3Route gray switch for
 * your SDKAppID, otherwise start() fails with 4001.
 *
 * Usage: npx ts-node examples/v3-realtime-asr.ts -f examples/test.pcm [engine]
 */

import * as fs from "fs";
import { v3, SpeechRecognitionListener, SpeechRecognitionResponse } from "../src/index";

const SDK_APP_ID = Number(process.env.TRTC_ASR_SDK_APP_ID || 0);
const SECRET_KEY = process.env.TRTC_ASR_SECRET_KEY || "";

function parseArgs(): { file: string; engine: string } {
  const args = process.argv.slice(2);
  let file = "examples/test.pcm";
  let engine = "16k_zh_en";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-f" && args[i + 1]) {
      file = args[i + 1];
      i++;
    } else if (!args[i].startsWith("-")) {
      engine = args[i];
    }
  }
  return { file, engine };
}

const listener: SpeechRecognitionListener = {
  onRecognitionStart(resp: SpeechRecognitionResponse) {
    console.log(`[start] voice_id=${resp.voice_id}`);
  },
  onSentenceBegin(resp: SpeechRecognitionResponse) {
    console.log(`[begin] index=${resp.result?.index}`);
  },
  onRecognitionResultChange(resp: SpeechRecognitionResponse) {
    console.log(`[change] ${resp.result?.voice_text_str}`);
  },
  onSentenceEnd(resp: SpeechRecognitionResponse) {
    console.log(
      `[end] index=${resp.result?.index} text=${resp.result?.voice_text_str}` +
        ` (${resp.result?.start_time}-${resp.result?.end_time}ms)`,
    );
  },
  onRecognitionComplete() {
    console.log("[complete]");
  },
  onFail(_resp, error) {
    console.error(`[fail] ${error}`);
  },
};

async function main() {
  if (!SDK_APP_ID || !SECRET_KEY) {
    console.error("Set TRTC_ASR_SDK_APP_ID and TRTC_ASR_SECRET_KEY first.");
    process.exit(1);
  }
  const { file, engine } = parseArgs();

  // v3 credentials need only SDKAppID + SecretKey (no Tencent Cloud APPID).
  const credential = v3.newCredential(SDK_APP_ID, SECRET_KEY);
  const recognizer = new v3.SpeechRecognizer(credential, engine, listener);

  // start() waits synchronously for the server's ack: authentication (4002)
  // and gray-switch (4001) errors are thrown here, not via onFail.
  await recognizer.start();

  const fileData = fs.readFileSync(file);
  const SLICE_SIZE = 6400; // 200ms of 16kHz 16bit mono PCM
  // The server rate-limits to at most 3s of audio per 1s wall-clock (error
  // 4000): keep the pacing when enlarging the buffer.
  for (let offset = 0; offset < fileData.length; offset += SLICE_SIZE) {
    await recognizer.write(Buffer.from(fileData.subarray(offset, offset + SLICE_SIZE)));
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  await recognizer.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
