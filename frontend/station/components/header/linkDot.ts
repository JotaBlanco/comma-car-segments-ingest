import type { LinkState } from '../../api/events';

/** Class and tooltip for the header's agent-link indicator. */
export function linkDot(state: LinkState): { className: string; title: string } {
  const on = state === 'connected';
  return {
    className: `size-2 rounded-full ${on ? 'bg-ok' : 'bg-muted'}`,
    title: `Flight Test agent: ${on ? 'connected' : 'not connected'}`,
  };
}
