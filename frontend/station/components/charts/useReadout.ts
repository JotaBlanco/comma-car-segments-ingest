import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { clock } from '../../playback/clock';
import { readoutText } from './valueReadout';

export interface Sample {
  t_ms: number;
  v: number | null;
}

export type SampleAt = (key: number) => Sample | null;

export interface Readout {
  ref: RefObject<HTMLSpanElement | null>;
  onHover: (idx: number | null) => void;
}

/** One header slot: the hovered sample, else the playhead's. */
export function useReadout(atIndex: SampleAt, atTime: SampleAt, unit: string): Readout {
  const node = useRef<HTMLSpanElement>(null);
  const src = useRef({ atIndex, atTime, unit });
  const hovering = useRef(false);

  const write = useCallback((s: Sample | null) => {
    const el = node.current;
    if (!el) return;
    const text = readoutText(s?.t_ms ?? null, s?.v ?? null, src.current.unit);
    // textContent, never state: this runs on every frame.
    if (el.textContent !== text) el.textContent = text;
  }, []);

  const showPlayhead = useCallback(() => write(src.current.atTime(clock.t)), [write]);

  const onHover = useCallback(
    (idx: number | null) => {
      hovering.current = idx !== null;
      if (idx === null) showPlayhead();
      else write(src.current.atIndex(idx));
    },
    [write, showPlayhead],
  );

  useEffect(() => {
    // A refetch lands here; the readout reads it from now on.
    src.current = { atIndex, atTime, unit };
    if (!hovering.current) showPlayhead();
  }, [atIndex, atTime, unit, showPlayhead]);

  useEffect(
    () =>
      clock.subscribe(() => {
        if (!hovering.current) showPlayhead();
      }),
    [showPlayhead],
  );

  return { ref: node, onHover };
}
