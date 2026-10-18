import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { OpenworkSessionHistory } from "@/app/lib/openwork-server";
import { parseSessionExport, SessionImportError } from "./session-transfer";

export type ImportedSessionSummary = {
  id: string;
  title: string;
  sourceWorkspace: string;
  importedAt: number;
  updatedAt: number;
  /** Source session id plus its last message id: importing the same conversation twice is skipped. */
  fingerprint: string;
};

type ImportedSessionRecord = { id: string; history: OpenworkSessionHistory };

const DB_NAME = "openwork-imported-sessions";
const SUMMARIES = "summaries";
const HISTORIES = "histories";

let database: Promise<IDBDatabase> | null = null;

function openDatabase() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(SUMMARIES, { keyPath: "id" });
      request.result.createObjectStore(HISTORIES, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = null;
      reject(request.error);
    };
  });
  return database;
}

function promised<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(mode: IDBTransactionMode, run: (summaries: IDBObjectStore, histories: IDBObjectStore) => void) {
  const db = await openDatabase();
  const tx = db.transaction([SUMMARIES, HISTORIES], mode);
  run(tx.objectStore(SUMMARIES), tx.objectStore(HISTORIES));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export type SessionsSidebarView = "workspaces" | "imported";

type ImportedSessionsStore = {
  summaries: ImportedSessionSummary[];
  loaded: boolean;
  sidebarView: SessionsSidebarView;
  setSidebarView: (view: SessionsSidebarView) => void;
};

export const useImportedSessionsStore = create<ImportedSessionsStore>()(
  persist(
    (set) => ({
      summaries: [],
      loaded: false,
      sidebarView: "workspaces",
      setSidebarView: (sidebarView) => set({ sidebarView }),
    }),
    {
      name: "openwork.imported-sessions.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ sidebarView: state.sidebarView }),
    },
  ),
);

export async function loadImportedSessions() {
  if (useImportedSessionsStore.getState().loaded) return;
  const db = await openDatabase();
  const summaries: ImportedSessionSummary[] = await promised(db.transaction(SUMMARIES).objectStore(SUMMARIES).getAll());
  useImportedSessionsStore.setState({ summaries: summaries.sort((a, b) => b.importedAt - a.importedAt), loaded: true });
}

export type SessionImportResult = {
  imported: number;
  skipped: number;
  failures: { file: string; message: string }[];
};

export async function importSessionFiles(files: File[]): Promise<SessionImportResult> {
  await loadImportedSessions();
  const known = new Set(useImportedSessionsStore.getState().summaries.map((summary) => summary.fingerprint));
  const result: SessionImportResult = { imported: 0, skipped: 0, failures: [] };
  const added: ImportedSessionSummary[] = [];
  const records: ImportedSessionRecord[] = [];
  for (const file of files) {
    try {
      const bundle = parseSessionExport(await file.text());
      for (const history of bundle.sessions) {
        const fingerprint = `${history.session.id}:${history.messages.at(-1)?.info.id ?? ""}`;
        if (known.has(fingerprint)) {
          result.skipped += 1;
          continue;
        }
        known.add(fingerprint);
        const id = crypto.randomUUID();
        added.push({
          id,
          title: history.session.title,
          sourceWorkspace: bundle.workspace.name,
          importedAt: Date.now(),
          updatedAt: history.session.time.updated,
          fingerprint,
        });
        records.push({ id, history });
      }
    } catch (error) {
      result.failures.push({
        file: file.name,
        message: error instanceof SessionImportError ? error.message : "Couldn't read this file.",
      });
    }
  }
  if (added.length > 0) {
    await transaction("readwrite", (summaries, histories) => {
      for (const summary of added) summaries.put(summary);
      for (const record of records) histories.put(record);
    });
    useImportedSessionsStore.setState((state) => ({ summaries: [...added, ...state.summaries] }));
  }
  result.imported = added.length;
  return result;
}

export async function removeImportedSession(id: string) {
  await transaction("readwrite", (summaries, histories) => {
    summaries.delete(id);
    histories.delete(id);
  });
  useImportedSessionsStore.setState((state) => ({ summaries: state.summaries.filter((summary) => summary.id !== id) }));
}

export function useImportedSessionHistory(id: string) {
  return useQuery({
    queryKey: ["imported-session", id],
    queryFn: async () => {
      const db = await openDatabase();
      const record: ImportedSessionRecord | undefined = await promised(db.transaction(HISTORIES).objectStore(HISTORIES).get(id));
      return record?.history ?? null;
    },
    staleTime: Infinity,
  });
}

/** Opens a file picker for exported session files. Resolves with no files when the picker is dismissed. */
export function pickSessionExportFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.multiple = true;
    input.hidden = true;
    // Attached until the picker settles: a detached input can be collected before its change event fires.
    const settle = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => settle(Array.from(input.files ?? [])), { once: true });
    input.addEventListener("cancel", () => settle([]), { once: true });
    document.body.append(input);
    input.click();
  });
}
