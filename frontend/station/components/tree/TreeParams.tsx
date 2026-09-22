import { useState } from 'react';
import type { Recording, TableKind } from '../../api/types';
import { pickKey, useSession } from '../../store/session';
import { scopeKey, scopeLabel } from './format';
import KeyTag from './KeyTag';
import { CheckIcon, ChevronIcon, KindIcon, SignalIcon, SourceIcon } from './icons';
import TreeAnomalies from './TreeAnomalies';

const KIND_LABEL: Record<TableKind, string> = { a429: 'ARINC 429', analog: 'Analog', fto: 'FTO' };

function Pending() {
  return (
    <li className="tree-row tree-pending">
      <span className="tree-spinner" aria-hidden="true" />
      <span className="text-muted">Loading…</span>
    </li>
  );
}

function SignalRow({ table, scope, signal }: { table: TableKind; scope: string; signal: string }) {
  const key = pickKey(table, scope, signal);
  const index = useSession((s) => s.picked.findIndex((p) => p.key === key));
  const togglePick = useSession((s) => s.togglePick);
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
          onChange={() => togglePick({ key, table, scope, signal })}
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
        <KeyTag name="signal" />
      </label>
    </li>
  );
}

/** One source (bus, stream, FCC): its signals are looked up when it opens. */
function ScopeNode({ node, table, scope }: { node: string; table: TableKind; scope: string }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const signals = useSession((s) => s.signalsByNode[`${node}/${scope}`]);
  const loading = useSession((s) => s.treeLoading[`${node}/${scope}`] ?? false);
  const loadSignals = useSession((s) => s.loadSignals);
  const pickedHere = useSession(
    (s) => s.picked.filter((p) => p.table === table && p.scope === scope).length,
  );
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
        <KeyTag name={scopeKey(scope)} />
        {pickedHere > 0 && <span className="tree-count tree-count-picked">{pickedHere}</span>}
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
            <SignalRow key={sig} table={table} scope={scope} signal={sig} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** One protocol: its sources are looked up when it opens. */
function KindNode({ node, kind }: { node: string; kind: TableKind }) {
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
        <KeyTag name="protocol" />
        {scopes && <span className="tree-meta">{scopes.length}</span>}
      </button>
      {open && (
        <ul className="tree-children">
          {loading && !scopes && <Pending />}
          {(scopes ?? []).map((scope) => (
            <ScopeNode key={scope} node={node} table={kind} scope={scope} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** The tree under an open recording: protocol -> source -> signal, each level one catalog call. */
export default function TreeParams({ aircraft, rec }: { aircraft: string; rec: Recording }) {
  return (
    <ul className="tree-children">
      {rec.tables.map((kind) => (
        <KindNode key={kind} node={`${aircraft}/${rec.id}/${kind}`} kind={kind} />
      ))}
      <TreeAnomalies />
    </ul>
  );
}
