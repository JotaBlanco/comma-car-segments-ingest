import { useEffect, useRef, useState } from 'react';
import type { TableKind } from '../../api/types';
import type { LayoutItem } from '../../layout/dashboard';
import { widgetTitle } from '../../layout/dashboard';
import { pickKey, useSession } from '../../store/session';
import { scopeLabel } from '../tree/format';
import { CheckIcon, ChevronIcon, KindIcon, SignalIcon, SourceIcon } from '../tree/icons';

const KIND_LABEL: Record<TableKind, string> = { a429: 'ARINC 429', analog: 'Analog', fto: 'FTO' };

function Pending() {
  return (
    <li className="tree-row tree-pending">
      <span className="tree-spinner" aria-hidden="true" />
      <span className="text-muted">Loading…</span>
    </li>
  );
}

export interface Chosen {
  keys: readonly string[];
  toggle(key: string): void;
}

function SignalRow({
  table,
  scope,
  signal,
  chosen,
}: {
  table: TableKind;
  scope: string;
  signal: string;
  chosen: Chosen;
}) {
  const key = pickKey(table, scope, signal);
  const index = chosen.keys.indexOf(key);
  const on = index >= 0;
  const series = on ? `var(--chart-s${(index % 8) + 1})` : undefined;
  return (
    <li>
      <label className={`tree-row tree-signal ${on ? 'tree-picked' : ''}`}>
        <span className="tree-spacer" />
        <input
          className="tree-check-input"
          type="checkbox"
          checked={on}
          onChange={() => chosen.toggle(key)}
        />
        <span
          className="tree-check"
          style={series ? { background: series, borderColor: series } : undefined}
        >
          {on && <CheckIcon />}
        </span>
        <SignalIcon className="tree-icon" />
        <span className="tree-label" title={signal}>
          {signal}
        </span>
      </label>
    </li>
  );
}

function ScopeNode({
  node,
  table,
  scope,
  chosen,
}: {
  node: string;
  table: TableKind;
  scope: string;
  chosen: Chosen;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const signals = useSession((s) => s.signalsByNode[`${node}/${scope}`]);
  const loading = useSession((s) => s.treeLoading[`${node}/${scope}`] ?? false);
  const loadSignals = useSession((s) => s.loadSignals);
  const here = chosen.keys.filter((k) => k.startsWith(`${table}:${scope}:`)).length;
  const toggle = () => {
    if (!open) void loadSignals(table, scope);
    setOpen(!open);
  };
  const all = signals ?? [];
  const shown = filter ? all.filter((x) => x.includes(filter)) : all.slice(0, 200);
  return (
    <li>
      <button
        className={`tree-row tree-scope ${open ? 'tree-open' : ''}`}
        aria-expanded={open}
        onClick={toggle}
      >
        <ChevronIcon open={open} />
        <SourceIcon className="tree-icon tree-icon-source" />
        <span className="tree-label">{scopeLabel(table, scope)}</span>
        {here > 0 && <span className="tree-count tree-count-picked">{here}</span>}
        {signals && <span className="tree-meta">{signals.length}</span>}
      </button>
      {open && (
        <ul className="tree-children">
          {loading && !signals && <Pending />}
          {all.length > 200 && (
            <input
              className="field tree-filter"
              placeholder="Filter signals"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
          {shown.map((sig) => (
            <SignalRow key={sig} table={table} scope={scope} signal={sig} chosen={chosen} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function KindNode({ node, kind, chosen }: { node: string; kind: TableKind; chosen: Chosen }) {
  const [open, setOpen] = useState(false);
  const scopes = useSession((s) => s.scopesByNode[node]);
  const loading = useSession((s) => s.treeLoading[node] ?? false);
  const loadScopes = useSession((s) => s.loadScopes);
  const toggle = () => {
    if (!open) void loadScopes(kind);
    setOpen(!open);
  };
  return (
    <li>
      <button
        className={`tree-row tree-kind ${open ? 'tree-open' : ''}`}
        aria-expanded={open}
        onClick={toggle}
      >
        <ChevronIcon open={open} />
        <KindIcon kind={kind} className={`tree-icon tree-icon-${kind}`} />
        <span className="tree-label">{KIND_LABEL[kind]}</span>
        {scopes && <span className="tree-meta">{scopes.length}</span>}
      </button>
      {open && (
        <ul className="tree-children">
          {loading && !scopes && <Pending />}
          {(scopes ?? []).map((scope) => (
            <ScopeNode key={scope} node={node} table={kind} scope={scope} chosen={chosen} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Choose one waveform's parameters: the open recording's protocols, sources and signals, the
 * same tree the sidebar shows, ticked into this widget alone. "Use picked" copies the tree's
 * ad hoc picks in, for a waveform built from what is already on screen.
 */
export default function ParamPicker({ item, onClose }: { item: LayoutItem; onClose(): void }) {
  const aircraft = useSession((s) => s.aircraft);
  const recording = useSession((s) => s.recording);
  const catalog = useSession((s) => s.catalog);
  const picked = useSession((s) => s.picked);
  const setWidgetParams = useSession((s) => s.setWidgetParams);
  const first = useRef<HTMLButtonElement>(null);
  const keys = item.params ?? [];

  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const chosen: Chosen = {
    keys,
    toggle: (key) =>
      setWidgetParams(item.id, keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]),
  };
  const rec = catalog?.aircraft
    .find((a) => a.id === aircraft)
    ?.recordings.find((r) => r.id === recording);
  const notPicked = picked.filter((p) => !keys.includes(p.key));

  return (
    <div
      className="fts-overlay fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="fts-panel modal-card picker w-full max-w-lg p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="picker-title"
      >
        <div className="flex items-center gap-3">
          <h2 id="picker-title" className="text-base font-semibold tracking-[-0.01em]">
            {widgetTitle(item)} parameters
          </h2>
          <span className="text-muted text-[13px]">{keys.length} chosen</span>
          <span className="flex-1" />
          {notPicked.length > 0 && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setWidgetParams(item.id, [...keys, ...notPicked.map((p) => p.key)])}
              title="Add every parameter ticked in the tree"
            >
              Use picked ({notPicked.length})
            </button>
          )}
          {keys.length > 0 && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setWidgetParams(item.id, [])}
            >
              Clear
            </button>
          )}
          <button
            ref={first}
            type="button"
            className="btn-primary px-3 text-[13px]"
            onClick={onClose}
          >
            Done
          </button>
        </div>
        <div className="picker-tree mt-4">
          {!rec || !aircraft ? (
            <div className="tree-empty">Open a recording to choose its parameters.</div>
          ) : (
            <nav className="tree">
              <ul>
                {rec.tables.map((kind) => (
                  <KindNode
                    key={kind}
                    node={`${aircraft}/${rec.id}/${kind}`}
                    kind={kind}
                    chosen={chosen}
                  />
                ))}
              </ul>
            </nav>
          )}
        </div>
      </div>
    </div>
  );
}
