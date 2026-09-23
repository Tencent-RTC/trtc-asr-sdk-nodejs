/**
 * Realtime speech recognition example over the v3 protocol (/asr/v3).
 *
 * Reads a PCM file (16kHz 16bit mono) and streams it in 200ms chunks.
 *
 * Credentials come from environment variables:
 *   TRTC_ASR_SDK_APP_ID, TRTC_ASR_SECRET_KEY
 * (v3 does not need the Tencent Cloud APPID.)
 *
 * Usage: npx ts-node examples/v3-realtime-asr.ts -f examples/test.pcm [engine]
 *
 * Speaker diarization can be made resumable across connections
 * ("断点续传"): keep the printed speaker_context_id and pass it back on the
 * next connection —
 *   npx ts-node examples/v3-realtime-asr.ts -f examples/test.pcm bigmodel \
 *     -diarization 1 -speaker-context 1 [-speaker-context-id <id>]
 */

import * as fs from "fs";
import { v3 } from "../src/index";
// The v3 response types (the top-level SpeechRecognitionResponse is the v2
// shape and does not carry v3-only fields such as speaker_continue).
import type {
  SpeechRecognitionListener,
  SpeechRecognitionResponse,
} from "../src/v3";

const SDK_APP_ID = Number(process.env.TRTC_ASR_SDK_APP_ID || 0);
const SECRET_KEY = process.env.TRTC_ASR_SECRET_KEY || "";

interface Args {
  file: string;
  engine: string;
  lang: string;
  diarization: number;
  speakerContext: number;
  speakerContextId: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let file = "examples/test.pcm";
  let engine = "";
  let lang = "";
  let diarization = 0;
  let speakerContext = 0;
  let speakerContextId = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-f" && args[i + 1]) {
      file = args[i + 1];
      i++;
    } else if (args[i] === "--lang" && args[i + 1]) {
      lang = args[i + 1];
      i++;
    } else if (args[i] === "-diarization" && args[i + 1]) {
      diarization = Number(args[i + 1]);
      i++;
    } else if (args[i] === "-speaker-context" && args[i + 1]) {
      speakerContext = Number(args[i + 1]);
      i++;
    } else if (args[i] === "-speaker-context-id" && args[i + 1]) {
      speakerContextId = args[i + 1];
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
  return { file, engine, lang, diarization, speakerContext, speakerContextId };
}

const listener: SpeechRecognitionListener = {
  onRecognitionStart(resp: SpeechRecognitionResponse) {
    console.log(`[start] voice_id=${resp.voice_id}`);
    if (resp.speaker_continue) {
      console.log(
        `speaker context: status=${JSON.stringify(resp.speaker_continue.continue_status)}` +
          ` id=${resp.speaker_continue.speaker_context_id}`,
      );
    }
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
    for (const seg of resp.result?.speaker_segments ?? []) {
      const label = seg.speaker_name || `spk${seg.speaker_id}`;
      console.log(`  [${label}] ${seg.text} (${seg.start_time}-${seg.end_time} ms)`);
    }
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
  const { file, engine, lang, diarization, speakerContext, speakerContextId } = parseArgs();

  // v3 credentials need only SDKAppID + SecretKey (no Tencent Cloud APPID).
  const credential = v3.newCredential(SDK_APP_ID, SECRET_KEY);
  const recognizer = new v3.SpeechRecognizer(credential, engine, listener);
  if (lang) recognizer.setLanguage(lang);
  // 调试/抓包：TRTC_ASR_WS_ENDPOINT 可把连接指到本地代理（如 ws://127.0.0.1:8899）。
  const wsEndpoint = process.env.TRTC_ASR_WS_ENDPOINT;
  if (wsEndpoint) recognizer.setEndpoint(wsEndpoint);
  if (diarization) recognizer.setSpeakerDiarization(diarization);
  // Speaker-context persistence requires speaker diarization; the SDK rejects
  // the combination locally otherwise.
  if (speakerContext) recognizer.setEnableSpeakerContext(speakerContext);
  if (speakerContextId) recognizer.setSpeakerContextId(speakerContextId);

  // start() waits synchronously for the server's ack: authentication (4002)
  // and gray-switch (4001) errors are thrown here, not via onFail. While
  // resuming a speaker context the ack arrives once the server has applied
  // the stored snapshot.
  await recognizer.start();

  // The handshake result is also available without a callback. Persist the
  // id: passing it back on the next connection keeps speaker ids stable.
  const speakerContinue = recognizer.getSpeakerContinue();
  if (speakerContinue) {
    console.log(
      `speaker context id: ${speakerContinue.speaker_context_id}` +
        ` (status: ${JSON.stringify(speakerContinue.continue_status)})` +
        " — reuse it with -speaker-context-id",
    );
  }

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
