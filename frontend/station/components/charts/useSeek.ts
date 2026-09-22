import { useCallback } from 'react';
import { clock } from '../../playback/clock';
import { useSession } from '../../store/session';

/** Seeks the clock and records it in the URL, like the timeline. */
export function useSeek(): (t: number) => void {
  const syncHash = useSession((s) => s.syncHash);
  return useCallback(
    (t: number) => {
      clock.seek(t);
      syncHash();
    },
    [syncHash],
  );
}
