/**
 * Example: Async audio file recognition.
 *
 * Usage:
 *   npx ts-node examples/file-asr.ts -f test.wav
 *   npx ts-node examples/file-asr.ts -u https://example.com/test.wav
 *   npx ts-node examples/file-asr.ts -f audio.mp3 -e 16k_zh
 *   npx ts-node examples/file-asr.ts -u https://example.com/call.wav --diarization 1
 *   npx ts-node examples/file-asr.ts -u https://example.com/call.wav --diarization 3 \
 *     --roles "teacher=https://example.com/teacher.wav"
 *
 * Prerequisites:
 *   1. Get Tencent Cloud APPID: https://console.cloud.tencent.com/cam/capi
 *   2. Create a TRTC application: https://console.cloud.tencent.com/trtc/app
 *   3. Get SDKAppID and SDK secret key from the application overview page
 *   4. Prepare an audio file (local ≤5MB, URL ≤1GB / ≤12h)
 */

import * as fs from "fs";
import { parseArgs } from "util";
import { Credential } from "../src/credential";
import {
  FileRecognizer,
  CreateRecTaskRequest,
  FileSourceType,
} from "../src/file-recognizer";
import { SpeakerRole } from "../src/signature";

/** Convert "name=url,name2=url2" into voiceprint enrollment roles. */
function parseRoles(spec: string): SpeakerRole[] {
  if (!spec) return [];
  const roles: SpeakerRole[] = [];
  for (const raw of spec.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      console.error(
        `Invalid --roles entry '${entry}', expected name=https://url`,
      );
      process.exit(1);
    }
    roles.push({
      roleName: entry.slice(0, eq).trim(),
      audioUrl: entry.slice(eq + 1).trim(),
    });
  }
  return roles;
}

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
      res: { type: "string", default: "1" },
      callback: { type: "string", default: "" },
      diarization: { type: "string", default: "0" },
      speakers: { type: "string", default: "0" },
      roles: { type: "string", default: "" },
      "vad-level": { type: "string", default: "-1" },
      "noise-threshold": { type: "string", default: "-1" },
      poll: { type: "string", default: "1000" },
      timeout: { type: "string", default: "600000" },
    },
  });

  const filePath = values.file!;
  const audioURL = values.url!;
  const engine = values.engine!;
  const resFormat = parseInt(values.res!, 10);
  const callbackUrl = values.callback!;
  const diarization = parseInt(values.diarization!, 10);
  const speakers = parseInt(values.speakers!, 10);
  const roles = parseRoles(values.roles!);
  const vadLevel = parseInt(values["vad-level"]!, 10);
  const noiseThreshold = parseFloat(values["noise-threshold"]!);
  const pollMs = parseInt(values.poll!, 10);
  const timeoutMs = parseInt(values.timeout!, 10);

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
        "  npx ts-node examples/file-asr.ts -f test.wav\n" +
        "  npx ts-node examples/file-asr.ts -u https://example.com/test.wav\n",
    );
    process.exit(1);
  }

  const credential = new Credential(APP_ID, SDK_APP_ID, SECRET_KEY);
  const recognizer = new FileRecognizer(credential);

  const commonOptions: Partial<CreateRecTaskRequest> = {};
  if (diarization) {
    commonOptions.speakerDiarization = diarization;
    commonOptions.speakerNumber = speakers;
    if (roles.length > 0) commonOptions.speakerRoles = roles;
  }
  if (vadLevel >= 0) commonOptions.vadLevel = vadLevel;
  if (noiseThreshold >= 0) commonOptions.noiseThreshold = noiseThreshold;

  let taskId: string;

  if (audioURL) {
    console.log(`Submitting URL task: ${audioURL}`);
    const req: CreateRecTaskRequest = {
      engineModelType: engine,
      channelNum: 1,
      resTextFormat: resFormat,
      sourceType: FileSourceType.URL,
      url: audioURL,
      callbackUrl,
      ...commonOptions,
    };
    taskId = await recognizer.createTask(req);
  } else {
    const data = fs.readFileSync(filePath);
    console.log(`Submitting file task: ${filePath} (${data.length} bytes)`);

    const req: CreateRecTaskRequest = {
      engineModelType: engine,
      channelNum: 1,
      resTextFormat: resFormat,
      sourceType: FileSourceType.DATA,
      callbackUrl,
      ...commonOptions,
    };
    taskId = await recognizer.createTaskFromDataWithOptions(
      Buffer.from(data),
      req,
    );
  }

  console.log(`Task created: ${taskId}`);
  console.log(
    `Polling for result (interval=${pollMs}ms, timeout=${timeoutMs}ms)...`,
  );

  const status = await recognizer.waitForResultWithInterval(
    taskId,
    pollMs,
    timeoutMs,
  );

  console.log(`\n=== Recognition Result ===`);
  console.log(`Task ID: ${status.recTaskId}`);
  console.log(`Status: ${status.statusStr}`);
  console.log(`Audio Duration: ${status.audioDuration.toFixed(2)} s`);
  console.log(`Result: ${status.result}`);

  if (status.resultDetail.length > 0) {
    console.log(`\n=== Sentence Details ===`);
    for (let i = 0; i < status.resultDetail.length; i++) {
      const detail = status.resultDetail[i];
      let speaker = "";
      if (detail.speakerRoleName) {
        speaker = ` [${detail.speakerRoleName}]`;
      } else if (detail.speakerId) {
        speaker = ` [spk${detail.speakerId}]`;
      } else if (detail.channelId) {
        speaker = ` [ch${detail.channelId}]`;
      }
      console.log(
        `[${i}]${speaker} ${detail.finalSentence} (${detail.startMs}-${detail.endMs} ms, speed=${detail.speechSpeed.toFixed(1)} words/s)`,
      );

      if (detail.words.length > 0) {
        for (let j = 0; j < detail.words.length; j++) {
          const w = detail.words[j];
          console.log(
            `    [${j}] ${w.word} (${w.offsetStartMs}-${w.offsetEndMs} ms)`,
          );
        }
      }
    }
  }
}

main().catch(console.error);
