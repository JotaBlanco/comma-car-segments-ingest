import { describe, expect, it, vi } from 'vitest';
import { suggestAgent } from './suggestAgent';

describe('suggestAgent', () => {
  it('posts the portal message once when embedded with an id', () => {
    const post = vi.fn();
    expect(suggestAgent('agent-123', true, post)).toBe(true);
    expect(post).toHaveBeenCalledWith({
      type: 'quixai:suggestedAgent',
      suggestedAgentId: 'agent-123',
      source: 'FlightTestStation',
    });
  });
  it('stays silent standalone or without an id', () => {
    const post = vi.fn();
    expect(suggestAgent('agent-123', false, post)).toBe(false);
    expect(suggestAgent(null, true, post)).toBe(false);
    expect(suggestAgent('', true, post)).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
});
