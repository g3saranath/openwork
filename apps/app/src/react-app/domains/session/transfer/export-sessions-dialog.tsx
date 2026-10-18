import { useEffect, useState } from "react";
import { Download, LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { t } from "@/i18n";

export type ExportableSession = { id: string; title: string; updatedAt: number };

export type ExportSessionsRequest = {
  workspaceId: string;
  workspaceName: string;
  sessions: ExportableSession[];
};

/** Workspace menu › Export sessions: every session starts ticked; untick any to leave it out of the file. */
export function ExportSessionsDialog(props: {
  request: ExportSessionsRequest | null;
  onOpenChange: (open: boolean) => void;
  onExport: (request: ExportSessionsRequest, sessionIds: string[]) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const request = props.request;

  useEffect(() => {
    setSelected(new Set(request?.sessions.map((session) => session.id)));
  }, [request]);

  const allSelected = request !== null && selected.size === request.sessions.length;
  const toggle = (sessionId: string, checked: boolean) => setSelected((current) => {
    const next = new Set(current);
    if (checked) next.add(sessionId);
    else next.delete(sessionId);
    return next;
  });

  const runExport = async () => {
    if (!request) return;
    setExporting(true);
    try {
      await props.onExport(request, request.sessions.filter((session) => selected.has(session.id)).map((session) => session.id));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open={request !== null} onOpenChange={(open) => { if (!exporting) props.onOpenChange(open); }}>
      <DialogContent className="w-full max-w-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("session_transfer.export_title", { workspace: request?.workspaceName ?? "" })}</DialogTitle>
          <DialogDescription>{t("session_transfer.export_description")}</DialogDescription>
        </DialogHeader>
        {request && request.sessions.length > 0 ? (
          <div className="flex flex-col gap-1">
            <Field orientation="horizontal" className="border-b border-border pb-2">
              <Checkbox
                id="export-sessions-all"
                checked={allSelected}
                indeterminate={!allSelected && selected.size > 0}
                onCheckedChange={(checked) => setSelected(new Set(checked ? request.sessions.map((session) => session.id) : []))}
              />
              <FieldLabel htmlFor="export-sessions-all">{t("session_transfer.select_all", { count: request.sessions.length })}</FieldLabel>
            </Field>
            <div className="max-h-72 overflow-y-auto">
              {request.sessions.map((session) => (
                <Field key={session.id} orientation="horizontal" className="py-1.5">
                  <Checkbox
                    id={`export-session-${session.id}`}
                    checked={selected.has(session.id)}
                    onCheckedChange={(checked) => toggle(session.id, checked)}
                  />
                  <FieldLabel htmlFor={`export-session-${session.id}`} className="min-w-0 flex-1 truncate font-normal">
                    {session.title || t("session_transfer.untitled")}
                  </FieldLabel>
                </Field>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("session_transfer.export_empty")}</p>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />} disabled={exporting}>
            {t("common.cancel")}
          </DialogClose>
          <Button onClick={() => void runExport()} disabled={exporting || selected.size === 0}>
            {exporting ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
            {t("session_transfer.export_action", { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
