"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/shared/page-header";
import { Panel, PanelHead } from "@/components/shared/panel";
import { SourceBadge } from "@/components/shared/source-badge";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { MetaGrid, MetaCell } from "@/components/shared/meta-grid";
import { StatCard } from "@/components/shared/stat-card";
import { Crumbs, Crumb } from "@/components/shared/crumbs";
import { ChipRow, Chip } from "@/components/shared/filter-chips";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingRows } from "@/components/shared/loading-rows";
import { ThemeToggle } from "@/components/theme/theme-toggle";

const COLORS: { name: string; varName: string; hex: string; usage: string }[] = [
  { name: "bg", varName: "--bg", hex: "#f6f6f4", usage: "App background" },
  { name: "surface", varName: "--surface", hex: "#ffffff", usage: "Panels, cards, tables" },
  { name: "surface-2", varName: "--surface-2", hex: "#fbfbfa", usage: "Table headers, subtle fills" },
  { name: "ink", varName: "--ink", hex: "#17191e", usage: "Primary text" },
  { name: "ink-2", varName: "--ink-2", hex: "#4b4f58", usage: "Secondary text" },
  { name: "ink-3", varName: "--ink-3", hex: "#878b94", usage: "Muted text, labels" },
  { name: "line", varName: "--line", hex: "#e5e5e1", usage: "Borders" },
  { name: "line-2", varName: "--line-2", hex: "#eeeeea", usage: "Internal dividers" },
  { name: "line-strong", varName: "--line-strong", hex: "#c9c9c4", usage: "Hover borders" },
  { name: "primary / accent", varName: "--accent", hex: "#24408e", usage: "Links, active nav — lifts in dark" },
  { name: "accent-fill", varName: "--accent-fill", hex: "#24408e", usage: "Solid CTA fills — stays deep in dark" },
  { name: "accent-soft", varName: "--accent-soft", hex: "#eef1f9", usage: "Active nav bg, api badges, hovers" },
  { name: "amber", varName: "--amber", hex: "#9a5b10", usage: "Awaiting / manual states" },
  { name: "amber-bg", varName: "--amber-bg", hex: "#fdf3e3", usage: "Amber badge fill" },
  { name: "amber-dot", varName: "--amber-dot", hex: "#e8a33d", usage: "Amber status dot" },
  { name: "green", varName: "--green", hex: "#1d6b3c", usage: "Linked / registered" },
  { name: "green-bg", varName: "--green-bg", hex: "#e9f4ec", usage: "Green badge fill" },
  { name: "green-dot", varName: "--green-dot", hex: "#3d9963", usage: "Green status dot" },
  { name: "red", varName: "--red", hex: "#a02c2c", usage: "Invalid / quarantined / errors" },
  { name: "red-bg", varName: "--red-bg", hex: "#faeceb", usage: "Red badge fill" },
  { name: "red-dot", varName: "--red-dot", hex: "#cf5b52", usage: "Red status dot" },
];

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-1 text-base font-bold tracking-tight">{title}</h2>
      {note ? <p className="mb-3 text-xs text-ink-3">{note}</p> : <div className="mb-3" />}
      {children}
    </section>
  );
}

function Swatch({ name, varName, hex, usage }: (typeof COLORS)[number]) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-line bg-surface p-2.5">
      {/* Renders the live var() so the swatch follows the active theme. */}
      <div
        className="size-9 shrink-0 rounded border border-line-2"
        style={{ background: `var(${varName})` }}
      />
      <div className="min-w-0">
        <div className="text-xs font-semibold">{name}</div>
        <div className="font-mono text-[0.65rem] text-ink-3">
          {varName} · {hex} light
        </div>
        <div className="truncate text-[0.68rem] text-ink-3">{usage}</div>
      </div>
    </div>
  );
}

export default function DesignSystemPage() {
  const [chip, setChip] = useState(0);
  const [on, setOn] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title="Design system"
          sub="Living overview of tokens and components. Internal reference — not part of the product navigation."
        />
        <div className="flex items-center gap-2 pt-1">
          <span className="text-[0.65rem] font-semibold tracking-[0.07em] text-ink-3 uppercase">
            Theme
          </span>
          <ThemeToggle />
        </div>
      </div>

      <Section
        title="Colors"
        note="Defined in app/globals.css and exposed as Tailwind utilities (bg-surface-2, text-ink-3, bg-amber-bg …). Swatches render the live var() value — toggle the theme to see the dark counterparts; the hex shown is the light reference."
      >
        <div className="grid grid-cols-3 gap-2 xl:grid-cols-4">
          {COLORS.map((c) => (
            <Swatch key={c.name} {...c} />
          ))}
        </div>
      </Section>

      <Section title="Typography" note="Schibsted Grotesk (UI) + IBM Plex Mono (identifiers, data). Base size 14px.">
        <Panel className="p-4">
          <div className="space-y-3">
            <div className="text-[1.45rem] font-bold tracking-tight">Page title — 1.45rem / 700</div>
            <div className="text-base font-bold tracking-tight">Section title — 1rem / 700</div>
            <div className="text-sm">Body text — 0.875rem / 400. The registry of runs, files and signals.</div>
            <div className="text-xs text-ink-3">Muted / sub text — 0.75rem, ink-3</div>
            <div className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-ink-3">
              Micro label — 0.65rem uppercase letterspaced
            </div>
            <div className="font-mono text-sm font-semibold">TAS-88214 · mono id — IBM Plex Mono 600</div>
            <div className="font-mono text-xs text-ink-3">sha256:9f2c8a41d6e0b3f7…c2ad90e1a7 — mono small muted</div>
          </div>
        </Panel>
      </Section>

      <Section title="Source badges" note="Per-field provenance. Every metadata value carries one of these — the core product idea.">
        <div className="flex items-center gap-3">
          <SourceBadge source="embedded" />
          <SourceBadge source="api:planning" />
          <SourceBadge source="api:catalogue" />
          <SourceBadge source="manual" />
        </div>
      </Section>

      <Section title="Status badges" note="Run and file lifecycle states. ToneBadge is the generic variant for anything else (Active, Closed, TAS, INCA …).">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status="complete" />
          <StatusBadge status="awaiting_work_order" />
          <StatusBadge status="invalid" />
          <StatusBadge status="registered" />
          <StatusBadge status="quarantined" />
          <ToneBadge tone="green" dot>
            Active
          </ToneBadge>
          <ToneBadge tone="neutral">Closed</ToneBadge>
          <ToneBadge tone="neutral">TAS</ToneBadge>
          <ToneBadge tone="amber" dot>
            missing
          </ToneBadge>
        </div>
      </Section>

      <Section title="Breadcrumbs / lineage crumbs" note="Mono chips. Dashed = entity not yet synced from the planning system. Dark = current.">
        <Crumbs>
          <Crumb type="WO" href="/work-orders">
            WO-2026-0851
          </Crumb>
          <Crumb type="Def" missing>
            not yet synced
          </Crumb>
          <Crumb type="Run" current>
            TAS-88214
          </Crumb>
        </Crumbs>
      </Section>

      <Section title="Stat cards">
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="Test runs" value="128" meta="+6 today" />
          <StatCard label="Files registered" value="512" meta="+31 today" />
          <StatCard label="Signals cataloged" value="6,412" meta="across 4 rigs" />
          <StatCard label="Work orders mirrored" value="42" meta="last sync: just now" />
        </div>
      </Section>

      <Section title="Meta grid" note="4-column bordered metadata layout. muted renders the not-yet-linked empty state.">
        <Panel>
          <MetaGrid>
            <MetaCell label="Work order">
              <span className="font-mono">WO-2026-0851</span>
            </MetaCell>
            <MetaCell label="Rig">
              <span className="font-mono">RIG-04</span>
            </MetaCell>
            <MetaCell label="Operator">
              A. Bergström
            </MetaCell>
            <MetaCell label="Project" muted>
              — awaiting sync
            </MetaCell>
          </MetaGrid>
        </Panel>
      </Section>

      <Section title="Filter chips">
        <ChipRow>
          {["All", "Awaiting work order", "Invalid", "RIG-04", "Project · EX90"].map((label, i) => (
            <Chip key={label} active={chip === i} onClick={() => setChip(i)}>
              {label}
            </Chip>
          ))}
        </ChipRow>
      </Section>

      <Section title="Panel + table" note="The standard list pattern: Panel > PanelHead > dense Table. Rows are keyboard-focusable links on real screens.">
        <Panel>
          <PanelHead title="Recent test runs" action={<span className="font-mono text-[0.68rem] text-ink-3">3 shown</span>} />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Rig</TableHead>
                <TableHead className="text-right">Signals</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>
                  <span className="font-mono">TAS-88214</span>
                  <div className="text-xs text-ink-3">HV battery thermal cycling</div>
                </TableCell>
                <TableCell className="font-mono">RIG-04</TableCell>
                <TableCell className="text-right font-mono">142</TableCell>
                <TableCell>
                  <StatusBadge status="awaiting_work_order" />
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>
                  <span className="font-mono">TAS-88213</span>
                  <div className="text-xs text-ink-3">E-machine efficiency map</div>
                </TableCell>
                <TableCell className="font-mono">RIG-02</TableCell>
                <TableCell className="text-right font-mono">96</TableCell>
                <TableCell>
                  <StatusBadge status="complete" />
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>
                  <span className="font-mono">TAS-88209</span>
                  <div className="text-xs text-ink-3">Inverter derating sweep</div>
                </TableCell>
                <TableCell className="font-mono">RIG-07</TableCell>
                <TableCell className="text-right font-mono">64</TableCell>
                <TableCell>
                  <StatusBadge status="invalid" />
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Panel>
      </Section>

      <Section title="Buttons">
        <div className="flex items-center gap-3">
          <Button>Primary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="outline" className="text-red hover:bg-red-bg">
            Danger ghost
          </Button>
          <Button variant="destructive">Destructive</Button>
          <Button onClick={() => toast("This is a toast", { description: "Composed with sonner." })}>Show toast</Button>
        </div>
      </Section>

      <Section title="Form elements">
        <div className="flex max-w-md items-center gap-4">
          <Input placeholder="e.g. °C" />
          <div className="flex items-center gap-2">
            {/* a11y: the adjacent span is visual only — the switch needs its
                own accessible name. */}
            <Switch checked={on} onCheckedChange={setOn} aria-label="Planning sync" />
            <span className="text-xs font-semibold uppercase tracking-[0.07em] text-ink-3">Planning sync</span>
          </div>
        </div>
      </Section>

      <Section title="Tabs">
        <Tabs defaultValue="signals">
          {/* dark:text-ink-2 on the counters, stated: the default TabsList
              variant paints the active trigger with a bg-input/30 wash in
              dark, and ink-3 only reaches 3.3:1 on that lighter fill (axe
              color-contrast). The product tabs use the transparent line
              variant, where ink-3 stays AA on the plain surface. */}
          <TabsList>
            <TabsTrigger value="signals">
              Signals{" "}
              <span className="ml-1 font-mono text-[0.68rem] text-ink-3 dark:text-ink-2">142</span>
            </TabsTrigger>
            <TabsTrigger value="files">
              Files{" "}
              <span className="ml-1 font-mono text-[0.68rem] text-ink-3 dark:text-ink-2">3</span>
            </TabsTrigger>
            <TabsTrigger value="journal">
              Journal{" "}
              <span className="ml-1 font-mono text-[0.68rem] text-ink-3 dark:text-ink-2">4</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="signals" className="pt-3 text-sm text-ink-2">
            Tab content area.
          </TabsContent>
          <TabsContent value="files" className="pt-3 text-sm text-ink-2">
            Files tab.
          </TabsContent>
          <TabsContent value="journal" className="pt-3 text-sm text-ink-2">
            Journal tab.
          </TabsContent>
        </Tabs>
      </Section>

      <Section title="Dialog" note="Pattern used by the invalid-flag flow: explainer, required field, destructive confirm.">
        <Button variant="outline" className="text-red hover:bg-red-bg" onClick={() => setDialogOpen(true)}>
          Open example dialog
        </Button>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Mark TAS-88214 as invalid</DialogTitle>
              <DialogDescription>
                The run stays in the registry and remains filterable — it is never deleted. A reason is required and
                will be journalled with your name.
              </DialogDescription>
            </DialogHeader>
            <Input placeholder="Reason…" />
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => setDialogOpen(false)}>
                Flag invalid
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Section>

      <Section title="States" note="Every fetch renders one of these three.">
        <div className="grid grid-cols-3 gap-3">
          <Panel>
            <Table>
              <TableBody>
                <LoadingRows rows={3} cols={3} />
              </TableBody>
            </Table>
          </Panel>
          <Panel className="p-2">
            <EmptyState title="Nothing needs attention." message="All runs complete, no quarantined files." />
          </Panel>
          <Panel className="p-2">
            <ErrorState message="Could not load test runs." onRetry={() => toast("Retry clicked")} />
          </Panel>
        </div>
      </Section>

      <Section title="Skeleton">
        <div className="flex max-w-md flex-col gap-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </Section>
    </div>
  );
}
