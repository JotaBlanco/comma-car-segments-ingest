"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Crumb, Crumbs } from "@/components/shared/crumbs";
import { EmptyState } from "@/components/shared/empty-state";
import { FullHeightPage } from "@/components/shared/full-height-page";
import { buttonVariants } from "@/components/ui/button";
import { useAllSnippets } from "@/lib/hooks";
import { SHELL_BREAKOUT_CLASS } from "@/lib/shell-breakout";
import { issueHref } from "@/lib/snippets/issue-link";
import { cn } from "@/lib/utils";
import { setWorkbookLayout, setWorkbookSessions, useWorkbook, workbookHref } from "@/lib/workbooks";
import Station from "@/station/Station";
import { ExploreButton } from "@/components/shared/explore-button";
import { useSession } from "@/station/store/session";
import { IssuePanel } from "./issue-panel";
import { SessionMenu } from "./session-menu";
import { WorkbookPicker } from "./workbook-picker";

/**
 * One workbook: the Flight Test Station itself, mounted here on this
 * workbook's dashboard, with every change kept. Its header is the page's
 * header: the workbook's crumbs and the session dropdown lead it, the
 * station's layout controls close it. The run, the signals and the period
 * come from the URL, which is the station's own entry contract, so a test
 * run's or an issue's shortcut lands with the station already open on it.
 */
export function WorkbookScreen({ workbookId }: { workbookId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const workbook = useWorkbook(workbookId);
  /* The flight the station has open: its span is the Explorer's range. */
  const flight = useSession((s) => s.flight);

  const run = params?.get("run") ?? null;
  /* Opened from an issue: it stands beside the dashboard, and the way back leads to it. */
  const issueId = Number(params?.get("issue") ?? "");
  const issues = useAllSnippets();
  const issue =
    Number.isInteger(issueId) && issueId > 0
      ? ((issues.data?.snippets ?? []).find((s) => s.id === issueId) ?? null)
      : null;
  const [panelOpen, setPanelOpen] = useState(true);
  /* The station reads the URL once, on boot: a new run, pick or period is a new mount. */
  const entryKey = useMemo(() => params?.toString() ?? "", [params]);
  const onLayout = useCallback(
    (layout: unknown) => setWorkbookLayout(workbookId, layout),
    [workbookId],
  );
  /* The layout the station starts from: what is stored now. Later changes come back
     through `onLayout` and must not reopen the workbook, so this is read once per mount. */
  const [initialLayout] = useState(() => workbook?.layout ?? []);

  /* A run opened from a shortcut becomes one of the workbook's sessions, and a workbook
     opened with none named starts on its first session. */
  const sessions = workbook?.sessions;
  /* Each run joins the sessions ONCE. Without this the run on screen was added back the
     moment a person unticked it in the dialog, so it could not be unticked at all. */
  const joined = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (sessions === undefined) return;
    if (run !== null) {
      if (joined.current.has(run)) return;
      joined.current.add(run);
      if (!sessions.includes(run)) setWorkbookSessions(workbookId, [...sessions, run]);
    } else if (sessions.length > 0) {
      router.replace(workbookHref(workbookId, { run: sessions[0] }));
    }
  }, [run, sessions, workbookId, router]);

  if (workbook === null) {
    return (
      <FullHeightPage>
        <Crumbs>
          <Crumb type="Workbooks" href="/workbooks">
            Workbooks
          </Crumb>
          <Crumb type="Workbook" current missing>
            not found
          </Crumb>
        </Crumbs>
        <EmptyState
          title="No such workbook"
          message="It may have been deleted, or saved in another browser: workbooks live in this browser."
        />
      </FullHeightPage>
    );
  }

  const segments = flight?.segments ?? [];
  const span =
    segments.length > 0
      ? {
          t0_ms: Math.min(...segments.map((s) => s.t0_ms)),
          t1_ms: Math.max(...segments.map((s) => s.t1_ms)),
        }
      : null;
  const backHref = issue !== null ? issueHref(issue.id) : "/workbooks";
  const backLabel = issue !== null ? "Back to the issue" : "Back to the workbooks";
  const leading = (
    <>
      {/* Every screen states its way back; a workbook opened from an issue returns to it. */}
      <Link
        href={backHref}
        className={cn(buttonVariants({ variant: "ghost", size: "icon" }))}
        aria-label={backLabel}
        title={backLabel}
      >
        <ArrowLeft />
      </Link>
      <WorkbookPicker workbook={workbook} />
      <SessionMenu workbook={workbook} run={run} />
    </>
  );
  const trailing = run !== null && <ExploreButton entry={{ run, frame: span }} label="Explorer" />;

  return (
    /* The station fills the content area edge to edge, the way the expanded Explore
       tab does: no page padding, no frame around it. */
    <div className={cn(SHELL_BREAKOUT_CLASS, "flex-row")}>
      <div className="flex min-w-0 flex-1 flex-col">
        <Station
          key={entryKey}
          workbook={{ name: workbook.name, layout: initialLayout, onLayout }}
          leading={leading}
          trailing={trailing}
        />
      </div>
      {issue !== null && (
        <IssuePanel
          snippet={issue}
          runId={run}
          open={panelOpen}
          onOpenChange={setPanelOpen}
        />
      )}
    </div>
  );
}
