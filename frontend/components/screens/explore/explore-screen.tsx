"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "next/navigation";
import { ChevronDown, ListChecks, Timer, X } from "lucide-react";
import { toast } from "sonner";
import { SessionsDialog } from "@/components/screens/workbooks/sessions-dialog";
import { EmptyState } from "@/components/shared/empty-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { buttonVariants } from "@/components/ui/button";
import { viewerHeaders } from "@/lib/api/client";
import { readExploreEntry, resolveExploreLayout, resolveRoots } from "@/lib/explore/entry";
import { lakeTable } from "@/lib/explore/lake-schema";
import { ensureMeasureLoaded, type MeasureController } from "@/lib/explore/measure-loader";
import { mergedProvider, type LakeProvider } from "@/lib/explore/merged-provider";
import { SHELL_BREAKOUT_CLASS } from "@/lib/shell-breakout";
import { cn } from "@/lib/utils";

/** Where this browser keeps the Explorer's layout: table, signals, columns, range, cursors. */
export const EXPLORE_LAYOUT_KEY = "tm.explore.layout";
/** The sessions the Explorer's tree is rooted on, in pick order. */
export const EXPLORE_SESSIONS_KEY = "tm.explore.sessions";

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked: it lasts for this page only */
  }
}

function loadSessions(): string[] {
  const raw = readJson(EXPLORE_SESSIONS_KEY);
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string" && s !== "") : [];
}

const getJson = (url: string) =>
  fetch(url, { headers: viewerHeaders() }).then((r) => r.json() as Promise<unknown>);

/** The sessions picked, with the dialog that picks them. */
function ExploreSessions({
  sessions,
  onChange,
}: {
  sessions: readonly string[];
  onChange(next: readonly string[]): void;
}) {
  const [choosing, setChoosing] = useState(false);
  const label =
    sessions.length === 0
      ? "No session"
      : sessions.length === 1
        ? sessions[0]
        : `${sessions.length} sessions`;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "max-w-[24rem] font-mono")}
          aria-label="Sessions"
          title="The test runs the Explorer's tree is rooted on"
        >
          <Timer />
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[60dvh] w-[26rem] overflow-auto">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Sessions</DropdownMenuLabel>
            {sessions.length === 0 && <DropdownMenuItem disabled>No sessions picked yet</DropdownMenuItem>}
            {sessions.map((s) => (
              <DropdownMenuItem
                key={s}
                className="font-mono text-[0.78rem]"
                onClick={() => onChange(sessions.filter((x) => x !== s))}
                aria-label={`Remove ${s}`}
              >
                <X className="opacity-60" />
                {s}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setChoosing(true)}>
            <ListChecks /> Choose sessions…
          </DropdownMenuItem>
          {sessions.length > 0 && (
            <DropdownMenuItem onClick={() => onChange([])}>
              <X /> Clear sessions
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {choosing && (
        <SessionsDialog
          selected={sessions}
          onChange={onChange}
          onClose={() => setChoosing(false)}
          multiDefault
        />
      )}
    </>
  );
}

/**
 * QuixLab's Explorer node, as a page of the Test Manager: the same signal
 * explorer over the lake, code for code, mounted the way QuixLab's Explore
 * node mounts it, over this origin's `/api/lake/*` routes. Its tree is rooted
 * on the sessions picked here, so it shows the signal folders under each run
 * and nothing above them. The layout and the sessions are kept in this
 * browser, so the page reopens where it was left.
 */
export function ExploreScreen() {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<MeasureController | null>(null);
  /* The picked sessions' folders: the provider puts them in front of every path. */
  const roots = useRef<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<string[]>(() => loadSessions());
  const [ready, setReady] = useState(false);
  /* The Explorer's own top bar, once mounted: the sessions control joins it, one header. */
  const [bar, setBar] = useState<HTMLElement | null>(null);
  /* The sessions the mounted tree is rooted on, so a pick that changed nothing loads nothing. */
  const rootedFor = useRef<string>("");
  const params = useSearchParams();
  /* A link names a run, or an issue's signal and period: the Explorer opens on it, the run
     joining the sessions, instead of where this browser left it. */
  const entryKey = params?.toString() ?? "";

  const changeSessions = (next: readonly string[]) => {
    const list = [...new Set(next)];
    writeJson(EXPLORE_SESSIONS_KEY, list);
    setSessions(list);
  };

  useEffect(() => {
    let gone = false;
    window.__tmLakeHeaders = viewerHeaders;
    window.qlToast = (message) => {
      toast(message);
    };
    const entry = readExploreEntry(new URLSearchParams(entryKey));
    const table = lakeTable();
    ensureMeasureLoaded()
      .then(async () => {
        if (gone || host.current === null || !window.MeasureView || !window.MeasureLake) return;
        const picked = loadSessions();
        const runs = entry && !picked.includes(entry.run) ? [...picked, entry.run] : picked;
        if (entry && runs !== picked) {
          writeJson(EXPLORE_SESSIONS_KEY, runs);
          setSessions(runs);
        }
        const stored = readJson(EXPLORE_LAYOUT_KEY) as { table?: string; roots?: unknown } | null;
        const opening = entry ? await resolveExploreLayout(entry, table) : null;
        roots.current = await resolveRoots(runs, table, getJson);
        if (gone || host.current === null) return;
        // The tree is rooted by the provider, never by the layout: no session row.
        const saved = { ...(entry ? opening : stored), table, roots: [] };
        const getTable = () => view.current?.state?.table ?? table;
        const real = window.MeasureLake.provider(getTable) as LakeProvider;
        const v = window.MeasureView.mount(host.current, {
          title: table,
          table,
          provider: mergedProvider(real, () => roots.current),
          theme: "light",
          exploreOnly: true,
          onChange: (layout) => writeJson(EXPLORE_LAYOUT_KEY, layout),
        });
        view.current = v;
        rootedFor.current = JSON.stringify(runs);
        setBar(host.current.querySelector<HTMLElement>(".qm-topbar .qm-id"));
        try {
          v.load(saved);
        } catch {
          toast("Could not restore the saved layout — starting fresh");
        }
        setReady(true);
      })
      .catch((e: unknown) => {
        if (!gone) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      gone = true;
      const v = view.current;
      view.current = null;
      setReady(false);
      setBar(null);
      if (v !== null) {
        try {
          writeJson(EXPLORE_LAYOUT_KEY, v.serialize());
          v.destroy();
        } catch {
          /* torn down already */
        }
      }
    };
  }, [entryKey]);

  /* A new pick re-roots the tree in place; the signals and the range stay. */
  useEffect(() => {
    if (!ready) return undefined;
    const key = JSON.stringify(sessions);
    if (key === rootedFor.current) return undefined;
    rootedFor.current = key;
    let gone = false;
    void resolveRoots(sessions, lakeTable(), getJson).then((found) => {
      if (gone || view.current === null) return;
      roots.current = found;
      try {
        view.current._treeRoot = null;
        view.current.renderTree();
      } catch {
        toast("Could not re-root the tree on the sessions picked");
      }
    });
    return () => {
      gone = true;
    };
  }, [sessions, ready]);

  const control = <ExploreSessions sessions={sessions} onChange={changeSessions} />;
  return (
    <div className={SHELL_BREAKOUT_CLASS}>
      {/* One header: the Explorer's own top bar takes the sessions control at its head.
          Until the bar exists, the control has a row of its own. */}
      {bar !== null ? (
        createPortal(<span className="tm-explore-sessions">{control}</span>, bar)
      ) : (
        <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2">{control}</div>
      )}
      {error !== null && <EmptyState title="The Explorer could not load" message={error} />}
      {/* The three tokens the stylesheet reads from outside its own scope. */}
      <div
        ref={host}
        className="qm-page-host min-h-0 flex-1"
        style={{ "--purple": "#7c3aed", "--text-dim": "var(--ink-3)", "--border": "var(--line)" } as React.CSSProperties}
      />
    </div>
  );
}
