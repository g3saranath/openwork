import { useMemo } from "react";
import { Lock } from "lucide-react";

import { MessageList } from "@/components/chat/message-list";
import { MessageListProvider } from "@/components/chat/message-list-provider";
import { t } from "@/i18n";
import { useLocal } from "@/react-app/kernel/local-provider";
import { NewTaskComposer, type NewTaskComposerContext } from "../chat/new-task-composer";
import { applyRevertCursor } from "../sync/transcript-reconcile";
import { snapshotToUIMessages } from "../sync/usechat-adapter";
import { useImportedSessionHistory, useImportedSessionsStore } from "./imported-sessions";

const noop = () => {};
const rejectReconnect = () => Promise.reject(new Error(t("session_transfer.read_only")));

/** An imported conversation, drawn with the same chat components as a live one but never sent to the engine. */
export function ImportedSessionView(props: { importId: string; composer: NewTaskComposerContext | null }) {
  const summary = useImportedSessionsStore((state) => state.summaries.find((entry) => entry.id === props.importId));
  const history = useImportedSessionHistory(props.importId);
  const { prefs } = useLocal();
  const messages = useMemo(
    () => history.data ? applyRevertCursor(snapshotToUIMessages(history.data), history.data.session.revert?.messageID ?? null) : [],
    [history.data],
  );

  return <div className="flex h-full min-h-0 flex-col" data-imported-session={props.importId}>
    <div className="relative min-h-0 flex-1">
      <div className="absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-y-contain touch-pan-y px-3 pb-4 pt-4 sm:px-5">
        <div className="mx-auto w-full max-w-[720px]">
          {history.data === null ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{t("session_transfer.missing")}</p>
          ) : (
            <MessageListProvider
              readOnly
              workspaceId={`imported:${props.importId}`}
              sessionId={history.data?.session.id ?? props.importId}
              showThinking={prefs.showThinking}
              developerMode={false}
              displaySuggestions={false}
              providerConnectedCount={0}
              onRevertToUserMessage={noop}
              onForkAtMessage={noop}
              onEditUserMessage={noop}
              onMcpReconnect={rejectReconnect}
              onMcpReopenAuthorization={rejectReconnect}
              dispatchAction={noop}
              setPrompt={noop}
            >
              <MessageList messages={messages} status="ready" activityStatus="idle" />
            </MessageListProvider>
          )}
        </div>
      </div>
    </div>
    <div className="shrink-0 px-0 pb-2 pt-2 max-lg:pb-0">
      <p data-testid="imported-session-read-only" className="mx-auto mb-1.5 flex w-full max-w-[720px] items-center gap-1.5 px-5 text-[13px] text-muted-foreground">
        <Lock className="size-3.5 shrink-0" aria-hidden="true" />
        {summary ? t("session_transfer.read_only_from", { workspace: summary.sourceWorkspace }) : t("session_transfer.read_only")}
      </p>
      <div inert className="opacity-60">
        <NewTaskComposer draft="" onDraftChange={noop} onRunTask={noop} busy={false} flush={false}
          context={props.composer ? { ...props.composer, draftOwnerKey: undefined, draftScope: null,
            draftSessionId: undefined, destination: undefined, client: null, workspaceId: null } : null} />
      </div>
    </div>
  </div>;
}
