import * as React from "react";
import { Check, ChevronDown, FileUp, Lock, Trash2 } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { SIDEBAR_ROW_LANE, SIDEBAR_SECTION_LABEL, SidebarGlyphSlot } from "../sidebar/sidebar-lanes";
import {
  importSessionFiles,
  loadImportedSessions,
  pickSessionExportFiles,
  removeImportedSession,
  useImportedSessionsStore,
  type ImportedSessionSummary,
  type SessionsSidebarView,
} from "./imported-sessions";

export type SessionTransferSidebar = {
  selectedImportId: string | null;
  onOpenImportedSession: (importId: string) => void;
  onCloseImportedSession: () => void;
  onExportWorkspace: (workspaceId: string) => void;
};

const VIEW_LABELS: Record<SessionsSidebarView, () => string> = {
  workspaces: () => t("workspace_list.title"),
  imported: () => t("session_transfer.imported_title"),
};

/** The sidebar heading doubles as a switch between your workspaces and sessions imported from elsewhere. */
export function SessionsViewMenu() {
  const view = useImportedSessionsStore((state) => state.sidebarView);
  const setView = useImportedSessionsStore((state) => state.setSidebarView);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="sidebar-sessions-view"
        className={cn("-ms-1 flex items-center gap-1 rounded px-1 transition-colors hover:bg-sidebar-accent", SIDEBAR_SECTION_LABEL)}
      >
        {VIEW_LABELS[view]()}
        <ChevronDown className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={4} className="w-52">
        {(["workspaces", "imported"] as const).map((option) => (
          <DropdownMenuItem key={option} onClick={() => setView(option)}>
            <span className="flex-1">{VIEW_LABELS[option]()}</span>
            {view === option ? <Check className="size-4" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export async function importSessionsFromPicker(onOpen: (importId: string) => void) {
  const files = await pickSessionExportFiles();
  if (files.length === 0) return;
  const result = await importSessionFiles(files);
  for (const failure of result.failures) toast.error(t("session_transfer.import_failed", { file: failure.file, message: failure.message }));
  if (result.imported > 0) {
    toast.success(t("session_transfer.imported", { count: result.imported }));
    const newest = useImportedSessionsStore.getState().summaries[0];
    if (newest) onOpen(newest.id);
  } else if (result.skipped > 0) {
    toast.info(t("session_transfer.already_imported", { count: result.skipped }));
  }
}

function groupBySource(summaries: ImportedSessionSummary[]) {
  const groups = new Map<string, ImportedSessionSummary[]>();
  for (const summary of summaries) groups.set(summary.sourceWorkspace, [...(groups.get(summary.sourceWorkspace) ?? []), summary]);
  return [...groups.entries()];
}

export function ImportedSessionsSection(props: { transfer: SessionTransferSidebar }) {
  const summaries = useImportedSessionsStore((state) => state.summaries);
  const loaded = useImportedSessionsStore((state) => state.loaded);
  React.useEffect(() => {
    void loadImportedSessions();
  }, []);

  if (loaded && summaries.length === 0) {
    return (
      <div data-imported-sessions-empty className={cn("flex flex-col items-start gap-2 py-3", "mx-2 ps-2.5 pe-2")}>
        <p className="text-[13px] text-muted-foreground">{t("session_transfer.empty")}</p>
        <button
          type="button"
          className="flex items-center gap-1.5 text-[13px] font-medium text-foreground hover:underline"
          onClick={() => void importSessionsFromPicker(props.transfer.onOpenImportedSession)}
        >
          <FileUp className="size-3.5" />
          {t("session_transfer.import_action")}
        </button>
      </div>
    );
  }

  return (
    <div data-imported-sessions className="flex flex-col gap-2">
      {groupBySource(summaries).map(([source, entries]) => (
        <SidebarGroup key={source} className="pb-0 pt-0">
          <SidebarGroupContent>
            <div className={cn("flex h-6 items-center gap-2", SIDEBAR_ROW_LANE)}>
              <SidebarGlyphSlot>
                <Lock className="size-3 text-muted-foreground" />
              </SidebarGlyphSlot>
              <span className={cn("min-w-0 truncate", SIDEBAR_SECTION_LABEL)} title={source}>{source}</span>
            </div>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuSub>
                  {entries.map((entry) => <ImportedSessionRow key={entry.id} entry={entry} transfer={props.transfer} />)}
                </SidebarMenuSub>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </div>
  );
}

function ImportedSessionRow(props: { entry: ImportedSessionSummary; transfer: SessionTransferSidebar }) {
  const selected = props.transfer.selectedImportId === props.entry.id;
  const remove = async () => {
    await removeImportedSession(props.entry.id);
    if (selected) props.transfer.onCloseImportedSession();
    toast.success(t("session_transfer.removed"));
  };
  return (
    <SidebarMenuSubItem className="group/imported-row">
      <div className="relative min-w-0 flex-1">
        <SidebarMenuSubButton
          render={<button type="button" />}
          isActive={selected}
          data-testid={`sidebar-imported-${props.entry.id}`}
          onClick={() => props.transfer.onOpenImportedSession(props.entry.id)}
          className="w-full pe-8 text-start"
        >
          <span className="min-w-0 flex-1 truncate" title={props.entry.title}>{props.entry.title || t("session_transfer.untitled")}</span>
        </SidebarMenuSubButton>
        <button
          type="button"
          className="absolute end-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 group-hover/imported-row:opacity-100"
          onClick={() => void remove()}
          aria-label={t("session_transfer.remove")}
          title={t("session_transfer.remove")}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </SidebarMenuSubItem>
  );
}
