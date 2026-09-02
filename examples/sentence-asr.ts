/**
 * Example: One-shot sentence recognition.
 *
 * Usage:
 *   npx ts-node examples/sentence-asr.ts -f test.pcm
 *   npx ts-node examples/sentence-asr.ts -f test.wav --fmt wav
 *   npx ts-node examples/sentence-asr.ts -u https://example.com/test.wav --fmt wav
 *
 * Prerequisites:
 *   1. Get Tencent Cloud APPID: https://console.cloud.tencent.com/cam/capi
 *   2. Create a TRTC application: https://console.cloud.tencent.com/trtc/app
 *   3. Get SDKAppID and SDK secret key from the application overview page
 *   4. Prepare an audio file (duration <= 60s, size <= 3MB)
 */

import * as fs from "fs";
import { parseArgs } from "util";
import { Credential } from "../src/credential";
import {
  SentenceRecognizer,
  SentenceRecognitionRequest,
} from "../src/sentence-recognizer";

// ===== Configuration =====
// Fill in your credentials before running.
const APP_ID = Number(process.env.TRTC_ASR_APP_ID || 0); // Tencent Cloud APPID
const SDK_APP_ID = Number(process.env.TRTC_ASR_SDK_APP_ID || 0); // TRTC application ID
const SECRET_KEY = process.env.TRTC_ASR_SECRET_KEY || ""; // TRTC SDK secret key

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: "string", short: "f", default: "" },
      url: { type: "string", short: "u", default: "" },
      engine: { type: "string", short: "e", default: "16k_zh_en" },
      fmt: { type: "string", default: "pcm" },
      "word-info": { type: "string", short: "w", default: "0" },
    },
  });

  const filePath = values.file!;
  const audioURL = values.url!;
  const engine = values.engine!;
  const voiceFmt = values.fmt!;
  const wordInfo = parseInt(values["word-info"]!, 10);

  if (!APP_ID || !SDK_APP_ID || !SECRET_KEY) {
    console.error(
      "Error: Please set APP_ID, SDK_APP_ID and SECRET_KEY in the code.\n\n" +
        "Steps:\n" +
        "  1. Get APPID from CAM Console: https://console.cloud.tencent.com/cam/capi\n" +
        "  2. Open TRTC Console: https://console.cloud.tencent.com/trtc/app\n" +
        "  3. Create or select an application\n" +
        "  4. Copy SDKAppID and SDK secret key from the application overview\n" +
        "  5. Fill in the credentials at the top of this file.\n",
    );
    process.exit(1);
  }

  if (!filePath && !audioURL) {
    console.error(
      "Error: Please specify either -f (local file) or -u (audio URL).\n\n" +
        "Examples:\n" +
        "  npx ts-node examples/sentence-asr.ts -f test.pcm\n" +
        "  npx ts-node examples/sentence-asr.ts -f test.wav --fmt wav\n" +
        "  npx ts-node examples/sentence-asr.ts -u https://example.com/test.wav --fmt wav\n",
    );
    process.exit(1);
  }

  const credential = new Credential(APP_ID, SDK_APP_ID, SECRET_KEY);
  const recognizer = new SentenceRecognizer(credential);

  let result;

  if (audioURL) {
    console.log(`Recognizing from URL: ${audioURL}`);
    result = await recognizer.recognizeURL(audioURL, voiceFmt, engine);
  } else {
    const data = fs.readFileSync(filePath);
    console.log(`Recognizing from file: ${filePath} (${data.length} bytes)`);

    if (wordInfo > 0) {
      const req: SentenceRecognitionRequest = {
        engServiceType: engine,
        sourceType: 1,
        voiceFormat: voiceFmt,
        wordInfo,
      };
      result = await recognizer.recognizeDataWithOptions(
        Buffer.from(data),
        req,
      );
    } else {
      result = await recognizer.recognizeData(Buffer.from(data), voiceFmt, engine);
    }
  }

  console.log(`Result: ${result.result}`);
  console.log(`Audio Duration: ${result.audioDuration} ms`);
  console.log(`Request ID: ${result.requestId}`);

  if (result.wordList.length > 0) {
    console.log(`Word Count: ${result.wordSize}`);
    for (let i = 0; i < result.wordList.length; i++) {
      const w = result.wordList[i];
      console.log(`  [${i}] ${w.word} (${w.startTime}-${w.endTime} ms)`);
    }
  }
}

main().catch(console.error);
