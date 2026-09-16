/**
 * Async audio file recognition example over the v3 protocol
 * (POST /v3/create_transcription + /v3/describe_transcription).
 *
 * Credentials come from environment variables:
 *   TRTC_ASR_SDK_APP_ID, TRTC_ASR_SECRET_KEY
 * (v3 does not need the Tencent Cloud APPID.)
 *
 * Usage:
 *   npx ts-node examples/v3-file-asr.ts -f local.wav [engine]
 *   npx ts-node examples/v3-file-asr.ts -u https://example.com/audio.wav [engine]
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
  let file = "";
  let url = "";
  let engine = "";
  let lang = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-f" && args[i + 1]) {
      file = args[i + 1];
      i++;
    } else if (args[i] === "-u" && args[i + 1]) {
      url = args[i + 1];
      i++;
    } else if (args[i] === "--lang" && args[i + 1]) {
      lang = args[i + 1];
      i++;
    } else if (!args[i].startsWith("-")) {
      engine = args[i];
    }
  }
  if (!engine) {
    console.error("error: engine argument is required (engine model type, e.g. bigmodel)");
    process.exit(2);
  }
  // The bigmodel engine is best used with an explicit language; every other
  // engine falls back to server-side detection unless --lang is given.
  if (!lang && engine === "bigmodel") lang = "zh";
  if ((file === "") === (url === "")) {
    console.error("Pass exactly one of -f (local file) or -u (URL).");
    process.exit(1);
  }

  // v3 credentials need only SDKAppID + SecretKey (no Tencent Cloud APPID).
  const credential = v3.newCredential(SDK_APP_ID, SECRET_KEY);
  const recognizer = new v3.FileRecognizer(credential);

  const req: v3.CreateTranscriptionRequest = {
    engine_model_type: engine,
    channel_num: 1,
    res_text_format: 1,
    source_type: 0, // SOURCE_TYPE_URL; createTaskFromDataWithOptions switches it
    language: lang,
  };
  let taskId: string;
  if (url) {
    req.url = url;
    taskId = await recognizer.createTask(req);
  } else {
    taskId = await recognizer.createTaskFromDataWithOptions(
      Buffer.from(fs.readFileSync(file)),
      req,
    );
  }
  console.log(`Task created: ${taskId}`);

  const status = await recognizer.waitForResult(taskId);
  console.log(`Status: ${status.status_str}  Duration: ${status.audio_duration.toFixed(2)} s`);
  console.log(`Result: ${status.result}`);
  for (const d of status.result_detail ?? []) {
    const speaker = d.speaker_role_name
      ? ` [${d.speaker_role_name}]`
      : d.speaker_id > 0
        ? ` [spk${d.speaker_id}]`
        : "";
    console.log(`  [${d.start_ms} - ${d.end_ms}]${speaker} ${d.final_sentence}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
