import type uPlot from 'uplot';
import { msToS, sToMs } from '../../api/time';
import { log } from '../../log';
import { dragTarget } from '../../selection/drag';
import { useSession } from '../../store/session';
import { selectToRange } from './viewRange';

/** A finished drag: zoom the shared window, or mark the period, per the mode. */
export function dragEnd(u: uPlot, shift: boolean): void {
  const range = selectToRange(u.select, (px) => sToMs(u.posToVal(px, 'x')));
  u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
  if (!range) return;
  const s = useSession.getState();
  const target = dragTarget(s.dragMode, shift);
  log.debug('chart', 'drag end', { target, ...range });
  if (target === 'select') {
    s.setSelection(range);
    return;
  }
  // Rescale now: y re-ranges before the new line lands.
  u.setScale('x', { min: msToS(range.t0_ms), max: msToS(range.t1_ms) });
  s.setView(range);
}

/** The marked period, read by the highlight plugin at draw time. */
export function currentSelection() {
  return useSession.getState().selection;
}

/** The picked snippets as bands, read by the events plugin at draw time. */
export function currentEvents() {
  return useSession.getState().events;
}
