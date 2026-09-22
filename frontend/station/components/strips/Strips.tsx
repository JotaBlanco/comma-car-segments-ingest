import { useRef, type CSSProperties } from 'react';
import RowDivider from '../../layout/RowDivider';
import { STRIP_HEIGHT_DEFAULT } from '../../layout/panelSizes';
import { useSession } from '../../store/session';
import StripChart from './StripChart';

/** One strip chart per picked signal, in pick order. */
export default function Strips() {
  const picked = useSession((s) => s.picked);
  const flight = useSession((s) => s.flight);
  const stripHeight = useSession((s) => s.stripHeight);
  const setStripHeight = useSession((s) => s.setStripHeight);
  const startHeight = useRef(stripHeight);
  if (!flight) {
    return <div className="text-muted text-xs p-2">Open a recording to see strip charts.</div>;
  }
  if (picked.length === 0) {
    return (
      <div className="text-muted text-xs p-2">Pick parameters in the tree to add strip charts.</div>
    );
  }
  // One height for every strip; every gap between them drags it.
  const style = { '--strip-h': `${stripHeight}px` } as CSSProperties;
  return (
    <div className="strip-list grid strip-scroll" style={style}>
      {picked.map((p, i) => (
        <div key={p.key} className="strip-slot">
          <StripChart pick={p} index={i} />
          <RowDivider
            axis="y"
            label="Resize strip height"
            onStart={() => (startHeight.current = stripHeight)}
            onDrag={(dy) => setStripHeight(startHeight.current + dy)}
            onReset={() => setStripHeight(STRIP_HEIGHT_DEFAULT)}
          />
        </div>
      ))}
    </div>
  );
}
