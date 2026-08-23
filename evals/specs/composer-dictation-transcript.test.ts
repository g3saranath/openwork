import { test } from "@openwork/testkit";
import { expect } from "vitest";

import { readDictationEvent } from "../../apps/app/src/react-app/domains/session/surface/composer/dictation-events.js";

/**
 * Issue #1555 — the composer mic must show live text while you speak and commit
 * only the corrected transcript into the draft. These are the rules that decide
 * what the user actually sees in the input box.
 */

function event(payload: Record<string, unknown>) {
  return JSON.stringify(payload);
}

const DELTA = "conversation.item.input_audio_transcription.delta";
const COMPLETED = "conversation.item.input_audio_transcription.completed";
const FAILED = "conversation.item.input_audio_transcription.failed";

test("composer dictation streams live partials and commits only corrected transcripts", ({ evidence }) => {
  // Positive: deltas accumulate into a live preview as the user speaks.
  let interim = "";
  for (const delta of ["Send ", "the ", "quarterly "]) {
    const next = readDictationEvent(interim, event({ type: DELTA, delta }));
    expect(next.type).toBe("interim");
    if (next.type !== "interim") throw new Error("expected interim");
    interim = next.interim;
  }
  expect(interim).toBe("Send the quarterly ");

  // Negative: a partial is never treated as committable draft text.
  const stillPartial = readDictationEvent(interim, event({ type: DELTA, delta: "repor" }));
  expect(stillPartial.type).not.toBe("final");

  evidence.recordAssertionEvidence(
    "Speaking produces a live preview that is not yet draft text",
    'Three deltas accumulated to "Send the quarterly " and a fourth delta still reported type "interim", never "final", so nothing reached the composer draft mid-utterance.',
    true,
  );

  // Positive: the completed event carries the corrected transcript, and it
  // replaces the partial rather than appending to it.
  const completed = readDictationEvent("Send the quarterly repor", event({ type: COMPLETED, transcript: "Send the quarterly report." }));
  expect(completed).toEqual({ type: "final", transcript: "Send the quarterly report." });

  evidence.recordAssertionEvidence(
    "The final transcript replaces the live partial instead of appending to it",
    'With partial "Send the quarterly repor" buffered, the completed event returned exactly {type:"final",transcript:"Send the quarterly report."} — the corrected text only, so the draft never contains the truncated partial.',
    true,
  );

  // Negative: silence and noise must not append junk to the user's draft.
  for (const noise of ["...", ".", " ", "?!"]) {
    const result = readDictationEvent("", event({ type: COMPLETED, transcript: noise }));
    expect(result).toEqual({ type: "reset" });
  }
  const failed = readDictationEvent("half a sentence", event({ type: FAILED }));
  expect(failed).toEqual({ type: "reset" });

  evidence.recordAssertionEvidence(
    "Negative: silence, punctuation-only results, and failed turns never reach the draft",
    'Completed transcripts "...", ".", " ", and "?!" each returned {type:"reset"}, as did a transcription.failed event holding a live partial. None produced a "final", so no junk text can be appended to the composer.',
    true,
  );

  // Negative: unrelated Realtime traffic is inert. In particular a model
  // response must never be mistaken for the user's dictated words.
  for (const unrelated of [
    { type: "response.output_text.delta", delta: "I can help with that" },
    { type: "response.done" },
    { type: "input_audio_buffer.speech_started" },
    { type: "session.updated" },
  ]) {
    expect(readDictationEvent("Send the", event(unrelated)).type).toBe("ignore");
  }
  expect(readDictationEvent("Send the", "not json at all").type).toBe("ignore");

  evidence.recordAssertionEvidence(
    "Negative: assistant output and malformed frames are never dictated into the draft",
    'response.output_text.delta ("I can help with that"), response.done, input_audio_buffer.speech_started, session.updated, and a non-JSON frame all returned type "ignore" while a partial was buffered, so only the user\'s own transcribed speech can enter the composer.',
    true,
  );

  // Positive: a surfaced error is reported with the provider's message.
  expect(readDictationEvent("", event({ type: "error", error: { message: "Microphone stream ended." } }))).toEqual({
    type: "error",
    message: "Microphone stream ended.",
  });
  expect(readDictationEvent("", event({ type: "error", error: {} }))).toEqual({
    type: "error",
    message: "Dictation returned an error.",
  });

  evidence.recordAssertionEvidence(
    "Dictation failures surface a message instead of failing silently",
    'An error frame carrying "Microphone stream ended." was reported verbatim, and an error frame with no message fell back to "Dictation returned an error." — so the mic never dies without telling the user.',
    true,
  );
});
