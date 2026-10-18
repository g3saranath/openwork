import { downloadTextAsFile } from "@/app/lib/download";
import { composeNativeSessionHistory } from "@/app/lib/opencode-session-native";
import type { OpenworkSessionHistory } from "@/app/lib/openwork-server";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { buildSessionExport, sessionExportFilename } from "./session-transfer";

const PARALLEL_READS = 3;

/** Reads each session's full history from the workspace's engine and saves them as one JSON file. */
export async function exportWorkspaceSessions(
  endpoint: Pick<ResolvedWorkspaceEndpoint, "opencodeBaseUrl" | "token">,
  workspaceName: string,
  sessionIds: string[],
) {
  const histories: OpenworkSessionHistory[] = new Array(sessionIds.length);
  let next = 0;
  const worker = async () => {
    while (next < sessionIds.length) {
      const index = next++;
      histories[index] = await composeNativeSessionHistory(endpoint, sessionIds[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_READS, sessionIds.length) }, worker));
  const bundle = buildSessionExport(workspaceName, histories);
  downloadTextAsFile(sessionExportFilename(workspaceName), `${JSON.stringify(bundle, null, 2)}\n`, "application/json");
}
