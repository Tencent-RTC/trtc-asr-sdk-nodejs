/**
 * Sentence (one-shot) speech recognition example over the v3 protocol
 * (POST /v3/transcribe).
 *
 * Recognizes a local audio file (<=60s, <=3MB).
 *
 * Credentials come from environment variables:
 *   TRTC_ASR_SDK_APP_ID, TRTC_ASR_SECRET_KEY
 * (v3 does not need the Tencent Cloud APPID.)
 *
 * Prerequisite: the server has enabled the EnableV3Route gray switch for
 * your SDKAppID, otherwise requests fail with 404/4001.
 *
 * Usage: npx ts-node examples/v3-sentence-asr.ts -f examples/test.pcm [engine]
 */

import * as fs from "fs";
import { v3 } from "../src/index";

const SDK_APP_ID = Number(process.env.TRTC_ASR_SDK_APP_ID || 0);
const SECRET_KEY = process.env.TRTC_ASR_SECRET_KEY || "";

async function main() {
  if (!SDK_APP_ID || !SECRET_KEY) {
    console.error("Set TRTC_ASR_SDK_APP_ID and TRTC_ASR_SECRET_KEY first.");
    process.exit(1);
  }
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

  // v3 credentials need only SDKAppID + SecretKey (no Tencent Cloud APPID).
  const credential = v3.newCredential(SDK_APP_ID, SECRET_KEY);
  const recognizer = new v3.SentenceRecognizer(credential);

  const data = fs.readFileSync(file);
  const result = await recognizer.recognizeData(Buffer.from(data), "pcm", engine);

  console.log(`Result: ${result.result}`);
  console.log(`Duration: ${result.audio_duration} ms  RequestId: ${result.request_id}`);
  for (const w of result.word_list ?? []) {
    console.log(`  [${w.start_time} - ${w.end_time}] ${w.word}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
