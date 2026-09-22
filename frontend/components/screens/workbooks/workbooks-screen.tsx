"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, Plus, Upload } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { FullHeightPage } from "@/components/shared/full-height-page";
import { PageHeader } from "@/components/shared/page-header";
import { Panel, TableScrollArea } from "@/components/shared/panel";
import { ToolbarRow } from "@/components/shared/table-toolbar";
import { TableSearchInput } from "@/components/shared/table-search-input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatTime } from "@/lib/format";
import { ftsConfigured } from "@/lib/fts";
import {
  createWorkbook,
  deleteWorkbook,
  MAX_WORKBOOK_NAME,
  renameWorkbook,
  setWorkbookLayout,
  setWorkbookSessions,
  useWorkbooks,
  type Workbook,
} from "@/lib/workbooks";
import { fromYaml, toYaml } from "@/lib/workbook-yaml";

/** A filename that is safe everywhere and still says which workbook it is. */
function fileName(name: string): string {
  const stem = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${stem || "workbook"}.workbook.yaml`;
}

function download(workbook: Workbook): void {
  const blob = new Blob([toYaml(workbook)], { type: "application/yaml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName(workbook.name);
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Read one exported workbook back in. It always becomes a NEW workbook: an import that
 * overwrote a workbook of the same name would lose whatever that one held, and the two are far
 * too easy to confuse when a file has been round the team.
 */
function importFile(text: string): { ok: true; name: string } | { ok: false; why: string } {
  let file;
  try {
    file = fromYaml(text);
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : "the file could not be read" };
  }
  const created = createWorkbook(file.name);
  if (created === null) return { ok: false, why: "no room for another workbook" };
  setWorkbookLayout(created.id, file.layout);
  setWorkbookSessions(created.id, file.sessions);
  return { ok: true, name: file.name };
}

const ROW_CLASS =
  "cursor-pointer outline-none transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

/** Name a workbook: new, or renamed. */
function NameDialog({
  title,
  initial,
  onSubmit,
  onClose,
}: {
  title: string;
  initial: string;
  onSubmit(name: string): void;
  onClose(): void;
}) {
  const [name, setName] = useState(initial);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="rounded-[10px] p-5 sm:max-w-[420px]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(name);
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-base font-bold tracking-[-0.01em]">{title}</DialogTitle>
            <DialogDescription className="text-[0.8rem] text-ink-2">
              A workbook is a saved station dashboard: its widgets, their places and their
              parameters. It opens on any test run.
            </DialogDescription>
          </DialogHeader>
          <Input
            className="mt-4"
            value={name}
            maxLength={MAX_WORKBOOK_NAME}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workbook name"
            aria-label="Workbook name"
            autoFocus
          />
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={name.trim().length === 0}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function WorkbooksScreen() {
  const router = useRouter();
  const workbooks = useWorkbooks();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Workbook | null>(null);
  const [imported, setImported] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const shown = q
    ? workbooks.filter((w) => w.name.toLowerCase().includes(q.toLowerCase()))
    : workbooks;
  const configured = ftsConfigured();

  return (
    <FullHeightPage>
      <PageHeader
        title="Workbooks"
        sub="Saved Flight Test Station dashboards. Open one on any test run, or on an issue's signal and period."
      />
      <ToolbarRow
        actions={
          <span className="flex items-center gap-1.5">
            <input
              ref={fileInput}
              type="file"
              accept=".yaml,.yml,application/yaml,text/yaml"
              className="hidden"
              onChange={async (e) => {
                const chosen = e.target.files?.[0];
                e.target.value = "";
                if (!chosen) return;
                const result = importFile(await chosen.text());
                setImported(
                  result.ok
                    ? `Imported \u201c${result.name}\u201d.`
                    : `${chosen.name} was not imported: ${result.why}`,
                );
              }}
            />
            <Button
              size="sm"
              variant="outline"
              className="font-semibold"
              onClick={() => fileInput.current?.click()}
            >
              <Upload /> Import
            </Button>
            <Button size="sm" className="font-semibold" onClick={() => setCreating(true)}>
              <Plus /> New workbook
            </Button>
          </span>
        }
      >
        <TableSearchInput value={q} onDebouncedChange={setQ} placeholder="Filter workbooks…" />
      </ToolbarRow>
      <div className="mb-2.5" />
      {imported !== null && (
        <p role="status" className="mb-2.5 text-[0.78rem] text-ink-3">
          {imported}
        </p>
      )}
      {!configured && (
        <p role="alert" className="mb-2.5 text-[0.78rem] text-ink-3">
          No Flight Test Station is configured on this deployment, so a workbook cannot open.
          Set TM_FTS_URL on the API.
        </p>
      )}
      <Panel className="flex min-h-0 flex-1 flex-col">
        <TableScrollArea>
          <table aria-label="Workbooks" className="w-full">
            <thead>
              <tr>
                <th>Workbook</th>
                <th className="text-right">Widgets</th>
                <th className="text-right">Updated</th>
                <th className="w-40">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={4}>
                    <EmptyState
                      title={q ? "No workbook matches" : "No workbooks yet"}
                      message={
                        q
                          ? "Try another word."
                          : "A new workbook starts from the station's standard dashboard. Arrange it, add waveforms, and it is saved as you go."
                      }
                    />
                  </td>
                </tr>
              )}
              {shown.map((w) => (
                <tr
                  key={w.id}
                  className={ROW_CLASS}
                  onClick={() => router.push(`/workbooks/${encodeURIComponent(w.id)}`)}
                >
                  <td>
                    <Link
                      href={`/workbooks/${encodeURIComponent(w.id)}`}
                      className="font-medium text-ink-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {w.name}
                    </Link>
                  </td>
                  <td className="text-right font-mono text-[0.78rem]">
                    {w.layout.length === 0 ? (
                      <span className="text-ink-3">standard</span>
                    ) : (
                      w.layout.length
                    )}
                  </td>
                  <td className="text-right font-mono text-[0.72rem] whitespace-nowrap">
                    {formatTime(new Date(w.updated_at).toISOString())}
                  </td>
                  <td className="text-right" onClick={(e) => e.stopPropagation()}>
                    <span className="flex items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => download(w)}
                        aria-label={`Export workbook ${w.name}`}
                      >
                        <Download /> Export
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRenaming(w)}>
                        Rename
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => deleteWorkbook(w.id)}
                        aria-label={`Delete workbook ${w.name}`}
                      >
                        Delete
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScrollArea>
      </Panel>
      {creating && (
        <NameDialog
          title="New workbook"
          initial=""
          onClose={() => setCreating(false)}
          onSubmit={(name) => {
            const w = createWorkbook(name);
            setCreating(false);
            if (w !== null) router.push(`/workbooks/${encodeURIComponent(w.id)}`);
          }}
        />
      )}
      {renaming !== null && (
        <NameDialog
          title="Rename workbook"
          initial={renaming.name}
          onClose={() => setRenaming(null)}
          onSubmit={(name) => {
            renameWorkbook(renaming.id, name);
            setRenaming(null);
          }}
        />
      )}
    </FullHeightPage>
  );
}
