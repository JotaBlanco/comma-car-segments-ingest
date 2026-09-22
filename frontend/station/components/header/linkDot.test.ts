import { describe, expect, it } from 'vitest';
import { linkDot } from './linkDot';

describe('linkDot', () => {
  it('describes both link states', () => {
    expect(linkDot('connected')).toEqual({
      className: 'size-2 rounded-full bg-ok',
      title: 'Flight Test agent: connected',
    });
    expect(linkDot('off')).toEqual({
      className: 'size-2 rounded-full bg-muted',
      title: 'Flight Test agent: not connected',
    });
  });
});
