/**
 * Pure reduction of OpenAI Realtime transcription events for composer dictation
 * (#1555). Kept free of React and WebRTC so the transcript rules are directly
 * testable: `use-dictation.ts` only owns the connection lifecycle.
 */

export type DictationEvent =
  /** Streaming partial for the utterance in progress. Not yet in the draft. */
  | { type: "interim"; interim: string }
  /** Utterance finished; `transcript` is the corrected text to commit. */
  | { type: "final"; transcript: string }
  /** Drop the interim buffer without committing anything. */
  | { type: "reset" }
  | { type: "error"; message: string }
  | { type: "ignore" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, key: string) {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field : "";
}

/**
 * The transcriber emits punctuation-only results ("...", ".") for silence and
 * background noise. Committing those would append junk to the draft.
 */
export function isMeaningfulTranscript(value: string) {
  return /[\p{Letter}\p{Number}]/u.test(value);
}

export function readDictationEvent(interim: string, raw: string): DictationEvent {
  let event: unknown = null;
  try {
    event = JSON.parse(raw);
  } catch {
    return { type: "ignore" };
  }
  const type = readString(event, "type");

  if (type === "conversation.item.input_audio_transcription.delta") {
    const delta = readString(event, "delta");
    if (!delta) return { type: "ignore" };
    return { type: "interim", interim: interim + delta };
  }

  if (type === "conversation.item.input_audio_transcription.completed") {
    const transcript = readString(event, "transcript").trim();
    if (!transcript || !isMeaningfulTranscript(transcript)) return { type: "reset" };
    return { type: "final", transcript };
  }

  if (type === "conversation.item.input_audio_transcription.failed") {
    return { type: "reset" };
  }

  if (type === "error") {
    const message = readString(isRecord(event) ? event.error : null, "message");
    return { type: "error", message: message || "Dictation returned an error." };
  }

  return { type: "ignore" };
}
