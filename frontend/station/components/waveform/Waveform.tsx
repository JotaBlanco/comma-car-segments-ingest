import { useState } from 'react';
import type { LayoutItem } from '../../layout/dashboard';
import { parsePick, useSession, type PickedSignal } from '../../store/session';
import StripChart from '../strips/StripChart';
import ParamPicker from './ParamPicker';

function ParamsIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6h16M4 12h10M4 18h6M17 15v6M14 18h6" />
    </svg>
  );
}

/** The bar's control: choose the waveform's parameters, with their count. */
export function WaveformActions({ item }: { item: LayoutItem }) {
  const [open, setOpen] = useState(false);
  const count = item.params?.length ?? 0;
  return (
    <>
      <button
        type="button"
        className="icon-btn panel-collapse waveform-params"
        onClick={() => setOpen(true)}
        aria-label={`Choose parameters for this waveform (${count} chosen)`}
        title="Choose parameters"
      >
        <ParamsIcon />
        {count > 0 && <span className="waveform-count">{count}</span>}
      </button>
      {open && <ParamPicker item={item} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * A waveform widget: one strip chart per parameter chosen on it, in the order chosen. The
 * parameters live on the layout item, so a saved view brings them back; the ad hoc picks in
 * the tree belong to the Picked parameters widget and never leak in here.
 */
export default function Waveform({ item }: { item: LayoutItem }) {
  const flight = useSession((s) => s.flight);
  const setWidgetParams = useSession((s) => s.setWidgetParams);
  const stripHeight = useSession((s) => s.stripHeight);
  const [open, setOpen] = useState(false);
  const picks = (item.params ?? []).map(parsePick).filter((p): p is PickedSignal => p !== null);
  const remove = (pick: PickedSignal) =>
    setWidgetParams(
      item.id,
      (item.params ?? []).filter((k) => k !== pick.key),
    );
  if (!flight) {
    return <div className="text-muted p-2 text-xs">Open a recording to see this waveform.</div>;
  }
  if (picks.length === 0) {
    return (
      <div className="dash-empty waveform-empty">
        <p className="text-[13px] font-semibold">No parameters yet</p>
        <p className="text-muted text-[13px]">
          Choose the parameters this waveform shows. They are saved with the view.
        </p>
        <button
          type="button"
          className="btn-primary px-3 text-[13px]"
          onClick={() => setOpen(true)}
        >
          Choose parameters
        </button>
        {open && <ParamPicker item={item} onClose={() => setOpen(false)} />}
      </div>
    );
  }
  return (
    <div
      className="strip-list grid strip-scroll"
      style={{ '--strip-h': `${stripHeight}px` } as React.CSSProperties}
    >
      {picks.map((p, i) => (
        <div key={p.key} className="strip-slot">
          <StripChart pick={p} index={i} onRemove={remove} />
        </div>
      ))}
    </div>
  );
}
