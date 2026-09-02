/**
 * Tencent TRTC ASR SDK for Node.js.
 */

export { Credential } from "./credential";
export { ASRError, ErrorCode } from "./errors";
export {
  SignatureParams,
  SpeakerRole,
  SPEAKER_DIARIZATION_OFF,
  SPEAKER_DIARIZATION_CLUSTER,
  SPEAKER_DIARIZATION_VOICEPRINT,
} from "./signature";
export { genUserSig } from "./usersig";
export { SDK_VERSION, SDK_LANGUAGE, SDK_TYPE, sdkPlatform } from "./sdkinfo";
export {
  SpeechRecognizer,
  SpeechRecognitionListener,
  SpeechRecognitionResponse,
  RecognitionResult,
  SpeakerSegment,
  WordInfo,
  ENDPOINT,
} from "./speech-recognizer";
export {
  SentenceRecognizer,
  SentenceRecognitionRequest,
  SentenceRecognitionResult,
  SentenceWord,
  SourceType,
  SENTENCE_ENDPOINT,
} from "./sentence-recognizer";
export {
  FileRecognizer,
  CreateRecTaskRequest,
  TaskStatus,
  SentenceDetail,
  SentenceWords,
  FileSourceType,
  TaskStatusCode,
  FILE_ENDPOINT,
} from "./file-recognizer";
