import { useEffect, useRef } from 'react';
import { useSession } from '../store/session';
import PanelIcon from './PanelIcon';
import { PRESET_VIEWS, WIDGET_KINDS, WIDGETS } from './dashboard';

/**
 * The widget gallery: every widget the station has, added one by one, plus the presets and a
 * blank slate. Opened from the header and from an empty dashboard.
 */
export default function Gallery({ onClose }: { onClose(): void }) {
  const layout = useSession((s) => s.layout);
  const addWidget = useSession((s) => s.addWidget);
  const removeWidget = useSession((s) => s.removeWidget);
  const applyView = useSession((s) => s.applyView);
  const clearDashboard = useSession((s) => s.clearDashboard);
  const setEditing = useSession((s) => s.setEditing);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const placed = (id: string) => layout.some((it) => it.id === id);

  return (
    <div
      className="fts-overlay fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="fts-panel modal-card gallery w-full max-w-2xl p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gallery-title"
      >
        <div className="flex items-center gap-3">
          <h2 id="gallery-title" className="text-base font-semibold tracking-[-0.01em]">
            Widgets
          </h2>
          <span className="text-muted text-[13px]">{layout.length} on the dashboard</span>
          <span className="flex-1" />
          <button
            ref={first}
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close the gallery"
            title="Close"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <ul className="gallery-list mt-4">
          {WIDGET_KINDS.map((kind) => {
            const spec = WIDGETS[kind];
            const count = layout.filter((it) => it.kind === kind).length;
            const on = !spec.multi && placed(kind);
            return (
              <li key={kind} className={`gallery-card ${count > 0 ? 'gallery-card-on' : ''}`}>
                <span className="gallery-icon">
                  <PanelIcon id={kind} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold">
                    {spec.title}
                    {spec.multi && count > 0 && (
                      <span className="text-muted font-normal"> · {count} placed</span>
                    )}
                  </span>
                  <span className="text-muted block text-xs">{spec.description}</span>
                </span>
                <button
                  type="button"
                  className={on ? 'btn-ghost' : 'btn-primary px-3 text-[13px]'}
                  onClick={() => {
                    if (on) removeWidget(kind);
                    else {
                      addWidget(kind);
                      setEditing(true);
                    }
                  }}
                  aria-label={on ? `Remove ${spec.title}` : `Add ${spec.title}`}
                >
                  {on ? 'Remove' : spec.multi && count > 0 ? 'Add another' : 'Add'}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <span className="text-muted text-xs font-semibold tracking-[0.08em] uppercase">
            Start from
          </span>
          {PRESET_VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              className="btn-ghost"
              onClick={() => {
                applyView(v.id);
                onClose();
              }}
            >
              {v.name}
            </button>
          ))}
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              clearDashboard();
            }}
            title="Remove every widget, then add the ones you want"
          >
            Scratch
          </button>
        </div>
      </div>
    </div>
  );
}
