import { z } from "zod";
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client";

import type { OpenworkSessionHistory } from "@/app/lib/openwork-server";

export const SESSION_EXPORT_FORMAT = "openwork.sessions";
export const SESSION_EXPORT_VERSION = 1;

export type SessionExportBundle = {
  format: typeof SESSION_EXPORT_FORMAT;
  version: typeof SESSION_EXPORT_VERSION;
  exportedAt: string;
  workspace: { name: string };
  sessions: OpenworkSessionHistory[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The chat view renders these objects as-is, so a file is only accepted when every
// field the renderer reads has the expected type.
const sessionSchema = z.custom<Session>((value) =>
  isRecord(value)
  && typeof value.id === "string"
  && typeof value.title === "string"
  && isRecord(value.time)
  && typeof value.time.created === "number"
  && typeof value.time.updated === "number");

const messageInfoSchema = z.custom<Message>((value) =>
  isRecord(value)
  && typeof value.id === "string"
  && typeof value.sessionID === "string"
  && (value.role === "user" || value.role === "assistant")
  && isRecord(value.time)
  && typeof value.time.created === "number");

const partSchema = z.custom<Part>((value) =>
  isRecord(value) && typeof value.id === "string" && typeof value.type === "string");

const bundleSchema = z.object({
  format: z.literal(SESSION_EXPORT_FORMAT),
  version: z.literal(SESSION_EXPORT_VERSION),
  exportedAt: z.string(),
  workspace: z.object({ name: z.string() }),
  sessions: z.array(z.object({
    session: sessionSchema,
    messages: z.array(z.object({ info: messageInfoSchema, parts: z.array(partSchema) })),
  })).min(1),
});

export class SessionImportError extends Error {}

export function parseSessionExport(text: string): SessionExportBundle {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SessionImportError("This file isn't a session export. Choose a .json file exported from OpenWork.");
  }
  const parsed = bundleSchema.safeParse(json);
  if (!parsed.success) {
    throw new SessionImportError("This file isn't a session export OpenWork can open. It may be damaged or from a newer version.");
  }
  return parsed.data;
}

// Transcripts routinely hold tool output and pasted credentials. Export replaces
// secret values while keeping the surrounding text readable.
const SECRET_KEY_NAMES = /^(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|secret|client[_-]?secret|password|passwd|authorization|private[_-]?key|credentials?|cookie)$/i;
const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, "$1[redacted]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g, "[redacted]"],
  [/\b(?:gh[pousr]_|github_pat_|xox[baprs]-|sk-|sk_live_|sk_test_|rk_live_|pk_live_|owt_)[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[redacted]"],
  [/([?&](?:access_token|api_key|apikey|key|password|token|secret|code)=)[^&\s"'<>]+/gi, "$1[redacted]"],
  [/(\b(?:api[_-]?key|token|secret|password|passwd|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*["']?)(?!\[redacted)[^\s"',;}{&]{6,}/gi, "$1[redacted]"],
];

export function redactSecretText(text: string): string {
  return SECRET_VALUE_PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}

function redactValue(value: unknown, key: string | null): unknown {
  if (typeof value === "string") return key && SECRET_KEY_NAMES.test(key) ? "[redacted]" : redactSecretText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, null));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, redactValue(entry, entryKey)]));
  return value;
}

export function buildSessionExport(workspaceName: string, histories: OpenworkSessionHistory[]): SessionExportBundle {
  const bundle: SessionExportBundle = {
    format: SESSION_EXPORT_FORMAT,
    version: SESSION_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    workspace: { name: workspaceName },
    sessions: histories.map(({ session, messages }) => ({ session, messages })),
  };
  // Redaction keeps every key and only rewrites string values, so the shape the parser checks is unchanged.
  return parseSessionExport(JSON.stringify(redactValue(bundle, null)));
}

export function sessionExportFilename(workspaceName: string, date = new Date()): string {
  const slug = workspaceName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return `${slug}-sessions-${day}.json`;
}
