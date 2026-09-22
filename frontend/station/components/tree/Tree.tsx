import { useSession } from '../../store/session';
import { PlaneIcon } from './icons';
import KeyTag from './KeyTag';
import TreeRecording from './TreeRecording';

function Empty({ text }: { text: string }) {
  return <div className="tree-empty">{text}</div>;
}

export default function Tree() {
  const catalog = useSession((s) => s.catalog);
  const needsPat = useSession((s) => s.needsPat);
  const error = useSession((s) => s.error);
  if (!catalog) {
    if (needsPat) return <Empty text="Connect to Quix to load recordings" />;
    if (error) return <Empty text="Catalogue unavailable — see the error above" />;
    return <Empty text="Loading catalogue…" />;
  }
  if (catalog.aircraft.length === 0) return <Empty text="No recordings in the lake yet" />;
  return (
    <nav className="tree">
      <ul>
        {catalog.aircraft.map((a) => (
          <li key={a.id} className="tree-aircraft">
            <div className="tree-row tree-group">
              <PlaneIcon className="tree-icon tree-icon-plane" />
              <span className="tree-label">{a.id.toUpperCase()}</span>
              <KeyTag name="platform" />
              <span className="tree-meta">
                {a.recordings.length} {a.recordings.length === 1 ? 'flight' : 'flights'}
              </span>
            </div>
            <ul className="tree-children">
              {a.recordings.map((r) => (
                <TreeRecording key={r.id} aircraft={a.id} rec={r} />
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  );
}
