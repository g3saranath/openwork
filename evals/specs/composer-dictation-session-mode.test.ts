import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@openwork/testkit";
import { expect } from "vitest";

// Extension-less on purpose: matching evals/specs/server-error-boundaries.test.ts.
// Adding ".js" resolves the whole apps/server module graph into the evals
// tsconfig and surfaces unrelated pre-existing errors across that package.
import { startServer } from "../../apps/server/src/server";
import type { ServerConfig } from "../../apps/server/src/types";

/**
 * Issue #1555 — the composer mic mints its Realtime session through the same
 * OpenWork server surface Voice Mode uses, but in `transcription` mode. That
 * mode must be dictation-only: the model may not speak back, may not reach the
 * OpenWork tool surface, and may not interrupt a user who pauses mid-sentence.
 */

const HOST_TOKEN = "owt_dictation_host_token";

function baseConfig(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "owt_dictation_client_token",
    hostToken: HOST_TOKEN,
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  } as ServerConfig;
}

type RealtimeSession = {
  type: string;
  model: string;
  output_modalities: string[];
  audio: { input: { transcription: { model: string }; turn_detection: Record<string, unknown> } };
  instructions?: string;
  tools?: unknown[];
  tool_choice?: string;
};

test("composer dictation mints a listen-only Realtime session while Voice Mode is untouched", async ({ evidence }) => {
  const dir = mkdtempSync(join(tmpdir(), "openwork-dictation-spec-"));
  const nativeFetch = globalThis.fetch;
  const priorEnvStore = process.env.OPENWORK_ENV_STORE;
  const priorTokenStore = process.env.OPENWORK_TOKEN_STORE;
  const priorOpenAiKey = process.env.OPENAI_API_KEY;
  const priorOpenWorkKey = process.env.OPENWORK_API_KEY;

  process.env.OPENWORK_ENV_STORE = join(dir, "env.json");
  process.env.OPENWORK_TOKEN_STORE = join(dir, "tokens.json");
  process.env.OPENAI_API_KEY = "sk-dictation-spec";
  delete process.env.OPENWORK_API_KEY;

  const minted: RealtimeSession[] = [];
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) === "https://api.openai.com/v1/realtime/client_secrets") {
      const body: unknown = JSON.parse(String(init?.body ?? "{}"));
      if (body && typeof body === "object" && "session" in body) {
        minted.push((body as { session: RealtimeSession }).session);
      }
      return Promise.resolve(
        new Response(JSON.stringify({ client_secret: { value: "rt-secret", expires_at: 123 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return nativeFetch(input, init);
  }) as typeof fetch;

  const server = (await startServer(baseConfig())) as { port: number; stop: (force?: boolean) => void | Promise<void> };
  const base = `http://127.0.0.1:${server.port}`;

  try {
    const hostAuth = { "x-openwork-host-token": HOST_TOKEN, "content-type": "application/json" };

    const mint = async (payload: Record<string, unknown>) => {
      const response = await fetch(`${base}/voice/realtime/session`, {
        method: "POST",
        headers: hostAuth,
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as { ok: true; tools: string[]; transcriptionModel: string };
    };

    // --- Dictation lane -----------------------------------------------------
    const dictation = await mint({ mode: "transcription" });
    const dictationSession = minted.at(-1);
    if (!dictationSession) throw new Error("dictation session was never minted");

    expect(dictationSession.output_modalities).toEqual(["text"]);
    expect(dictationSession.audio.input.turn_detection.create_response).toBe(false);
    expect(dictationSession.audio.input.turn_detection.interrupt_response).toBe(false);
    expect(dictationSession.audio.input.transcription.model).toBe("gpt-4o-transcribe");

    evidence.recordAssertionEvidence(
      "Dictation mode transcribes without the model ever speaking back",
      `POST /voice/realtime/session {"mode":"transcription"} minted a session with output_modalities=${JSON.stringify(dictationSession.output_modalities)}, create_response=false and interrupt_response=false, transcribed by gpt-4o-transcribe. The model cannot emit audio or take a turn, so the mic behaves as a transcriber.`,
      true,
    );

    // Negative half: dictation must not carry the OpenWork tool surface, so a
    // stray utterance cannot drive the UI or send a message on the user's behalf.
    expect(dictationSession.tools).toBeUndefined();
    expect(dictationSession.tool_choice).toBeUndefined();
    expect(dictationSession.instructions).toBeUndefined();
    expect(dictation.tools).toEqual([]);

    evidence.recordAssertionEvidence(
      "Negative: dictation cannot reach the OpenWork tool surface",
      "The dictation session body carried no tools, no tool_choice, and no instructions, and the endpoint reported tools: []. Spoken words can only become draft text — they cannot execute composer.send or any other OpenWork action.",
      true,
    );

    // Negative half: pausing mid-sentence must not end the turn as aggressively
    // as conversational Voice Mode, which is tuned to answer fast.
    expect(dictationSession.audio.input.turn_detection.silence_duration_ms).toBe(600);

    // --- Voice Mode lane (regression) ---------------------------------------
    const voice = await mint({ sessionContext: "User: hello" });
    const voiceSession = minted.at(-1);
    if (!voiceSession) throw new Error("voice session was never minted");

    expect(voiceSession.output_modalities).toEqual(["audio"]);
    expect(voiceSession.audio.input.turn_detection.create_response).toBe(true);
    expect(voiceSession.audio.input.turn_detection.interrupt_response).toBe(true);
    expect(voiceSession.audio.input.turn_detection.silence_duration_ms).toBe(320);
    expect(voiceSession.tool_choice).toBe("auto");
    expect(voice.tools).toEqual(["openwork_snapshot", "openwork_list_actions", "openwork_execute_action"]);
    expect(voiceSession.instructions).toContain("OpenWork Voice Mode");
    expect(voiceSession.instructions).toContain("User: hello");

    evidence.recordAssertionEvidence(
      "Negative: adding dictation did not change existing Voice Mode behavior",
      `The same endpoint without a mode still minted output_modalities=["audio"], create_response=true, interrupt_response=true, silence_duration_ms=320, tool_choice="auto", tools=${JSON.stringify(voice.tools)}, and instructions carrying both the Voice Mode role and the supplied session context. Voice Mode is unregressed.`,
      true,
    );

    // Both lanes must differ on exactly the response-generation switches while
    // sharing one transcription model, proving one broker serves both.
    expect(dictation.transcriptionModel).toBe(voice.transcriptionModel);
    expect(dictationSession.model).toBe(voiceSession.model);

    evidence.recordAssertionEvidence(
      "Dictation reuses the existing voice broker rather than a parallel stack",
      `Both lanes reported transcriptionModel="${dictation.transcriptionModel}" and realtime model "${dictationSession.model}" from the same POST /voice/realtime/session route; only the response-generation switches differ. No second transcription backend was introduced.`,
      true,
    );
  } finally {
    await server.stop(true);
    globalThis.fetch = nativeFetch;
    if (priorEnvStore === undefined) delete process.env.OPENWORK_ENV_STORE;
    else process.env.OPENWORK_ENV_STORE = priorEnvStore;
    if (priorTokenStore === undefined) delete process.env.OPENWORK_TOKEN_STORE;
    else process.env.OPENWORK_TOKEN_STORE = priorTokenStore;
    if (priorOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorOpenAiKey;
    if (priorOpenWorkKey !== undefined) process.env.OPENWORK_API_KEY = priorOpenWorkKey;
    rmSync(dir, { recursive: true, force: true });
  }
});
