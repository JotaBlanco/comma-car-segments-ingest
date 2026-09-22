import { useEffect, type ReactNode } from 'react';
import AltitudeChart from './components/altitude/AltitudeChart';
import Annunciator from './components/annunciator/Annunciator';
import Header from './components/header/Header';
import MapView from './components/map/MapView';
import SelectionBar from './components/selection/SelectionBar';
import Strips from './components/strips/Strips';
import Instruments from './components/tapes/Instruments';
import Timeline from './components/timeline/Timeline';
import Tree from './components/tree/Tree';
import Layout from './layout/Layout';
import { useSession } from './store/session';

function ErrorBanner({ error }: { error: string }) {
  const loadCatalog = useSession((s) => s.loadCatalog);
  return (
    <div className="banner-alarm fixed top-14 right-4 z-50 flex items-center gap-2 px-3 py-2 rounded text-[13px]">
      <span>{error}</span>
      <button
        className="px-2 py-0.5 rounded border border-white/40"
        onClick={() => void loadCatalog()}
      >
        Retry
      </button>
    </div>
  );
}

/** `leading` heads the header inside a Test Manager workbook, in place of the brand. */
export default function App({
  leading,
  trailing,
}: {
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const boot = useSession((s) => s.boot);
  const error = useSession((s) => s.error);
  const authResolved = useSession((s) => s.authResolved);
  const clearSelection = useSession((s) => s.clearSelection);
  useEffect(() => {
    void boot();
  }, [boot]);
  useEffect(() => {
    // Esc drops the marked period unless a field has the keyboard.
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (e.key === 'Escape' && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
        clearSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clearSelection]);
  const covered = !authResolved;
  return (
    <>
      {error && !covered && <ErrorBanner error={error} />}
      <div className="h-full" inert={covered || undefined}>
        <Layout
          header={<Header leading={leading} trailing={trailing} />}
          tree={<Tree />}
          widgets={{
            map: <MapView />,
            altitude: <AltitudeChart />,
            instruments: <Instruments />,
            annunciator: <Annunciator />,
            strips: <Strips />,
          }}
          selection={<SelectionBar />}
          timeline={<Timeline />}
        />
      </div>
      {!authResolved && <div className="fts-overlay absolute inset-0 z-50 bg-bg" aria-hidden />}
    </>
  );
}
