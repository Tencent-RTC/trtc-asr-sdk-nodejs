/**
 * TRTC-ASR v3 protocol client.
 *
 * The v3 protocol restructures the wire format around two separated blocks:
 * an "auth" block consumed by the gateway's authentication layer, and a
 * "params" block consumed by the recognition layer. Field names are
 * snake_case and responses are flat with numeric codes.
 *
 * v3 uses SdkAppID as the only customer dimension; the Tencent Cloud AppID
 * is not needed (see {@link newCredential}).
 *
 * The v2/v1 clients in the parent module remain fully supported and
 * unchanged.
 */

export {
  ENDPOINT,
  SpeechRecognizer,
  SpeechRecognitionListener,
  SpeechRecognitionResponse,
  SpeakerSegment,
  RecognitionResult,
  WordInfo,
} from "./speech-recognizer";
export {
  SentenceRecognizer,
  TranscribeRequest,
  TranscribeResponse,
  SENTENCE_ENDPOINT,
} from "./sentence-recognizer";
export {
  FileRecognizer,
  CreateTranscriptionRequest,
  TranscriptionStatus,
  SentenceDetail,
  FILE_ENDPOINT,
} from "./file-recognizer";
export {
  newCredential,
  SOURCE_TYPE_URL,
  SOURCE_TYPE_DATA,
  TASK_STATUS_WAITING,
  TASK_STATUS_RUNNING,
  TASK_STATUS_SUCCESS,
  TASK_STATUS_FAILED,
  SPEAKER_DIARIZATION_OFF,
  SPEAKER_DIARIZATION_CLUSTER,
  SPEAKER_DIARIZATION_VOICEPRINT,
  SPEAKER_CONTEXT_OFF,
  SPEAKER_CONTEXT_SYNC,
  SPEAKER_CONTEXT_ASYNC,
  CONTINUE_STATUS_FRESH,
  CONTINUE_STATUS_RESUMED,
  CONTINUE_STATUS_DEGRADED,
  CONTINUE_STATUS_DISABLED,
  Context,
  ContextKV,
  SpeakerContinue,
  SpeakerRole,
  AudioURLItem,
  Word,
} from "./wire";
