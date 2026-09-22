import { log } from '../log';

/** quixlab's contract; the portal origin-checks and relays it. */
export function suggestAgent(
  agentId: string | null,
  embedded: boolean,
  post: (msg: unknown) => void = (m) => window.parent.postMessage(m, '*'),
): boolean {
  if (!embedded || !agentId) return false;
  post({ type: 'quixai:suggestedAgent', suggestedAgentId: agentId, source: 'FlightTestStation' });
  log.info('ai', 'suggested agent to the portal', { agentId });
  return true;
}
