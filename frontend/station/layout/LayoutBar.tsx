import { useEffect, useRef, useState } from 'react';
import { useSession } from '../store/session';
import { findView, isPreset, PRESET_VIEWS, sameLayout, type SavedView } from './dashboard';
import LayoutIcon from '../components/header/LayoutIcon';
import Gallery from './Gallery';

function EditIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20" />
    </svg>
  );
}

function GalleryIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M17.5 14v7M14 17.5h7" />
    </svg>
  );
}

/** The presets and the saved views; a hand-made layout reads as Custom. */
function ViewPicker({
  value,
  custom,
  views,
  onPick,
}: {
  value: string;
  custom: boolean;
  views: readonly SavedView[];
  onPick(id: string): void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[13px]">
      <span className="text-muted">View</span>
      <select
        className="field layout-select"
        value={value}
        onChange={(e) => e.target.value && onPick(e.target.value)}
        aria-label="View"
      >
        {custom && <option value="">Custom</option>}
        <optgroup label="Presets">
          {PRESET_VIEWS.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </optgroup>
        {views.length > 0 && (
          <optgroup label="Saved views">
            {views.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

/** Name the view, then save: a saved view of that name is overwritten. */
function NameForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave(name: string): void;
  onCancel(): void;
}) {
  const [name, setName] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(name);
      }}
    >
      <input
        ref={input}
        className="field layout-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="View name"
        aria-label="View name"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      />
      <button type="submit" className="btn-primary px-3 text-[13px]" disabled={!name.trim()}>
        Save
      </button>
      <button type="button" className="btn-ghost" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

/** Save the dashboard as a view, and delete the saved view it came from. */
function SaveControls({ active }: { active: SavedView | null }) {
  const saveView = useSession((s) => s.saveView);
  const deleteView = useSession((s) => s.deleteView);
  const [naming, setNaming] = useState(false);
  const own = active !== null && !isPreset(active.id);
  if (naming) {
    return (
      <NameForm
        initial={own ? active.name : ''}
        onSave={(name) => {
          saveView(name);
          setNaming(false);
        }}
        onCancel={() => setNaming(false)}
      />
    );
  }
  return (
    <>
      <button
        type="button"
        className="btn-ghost"
        onClick={() => setNaming(true)}
        title={own ? 'Save this view, or save it under a new name' : 'Save the dashboard as a view'}
      >
        Save view
      </button>
      {own && (
        <button
          type="button"
          className="btn-ghost"
          onClick={() => deleteView(active.id)}
          aria-label={`Delete view ${active.name}`}
          title="Delete this view"
        >
          Delete
        </button>
      )}
    </>
  );
}

/**
 * The dashboard's controls: which view is on, saving one, the gallery and edit mode.
 *
 * A layout changed by hand shows the view it came from as modified; Save writes it back under
 * that name, or under a new one.
 */
export default function LayoutBar() {
  const layout = useSession((s) => s.layout);
  const views = useSession((s) => s.views);
  const activeViewId = useSession((s) => s.activeViewId);
  const workbook = useSession((s) => s.workbook);
  const editing = useSession((s) => s.editing);
  const setEditing = useSession((s) => s.setEditing);
  const applyView = useSession((s) => s.applyView);
  const resetLayout = useSession((s) => s.resetLayout);
  const [gallery, setGallery] = useState(false);

  const active = findView(views, activeViewId);
  const modified = active !== null && !sameLayout(active.layout, layout);

  /* Inside a workbook the Test Manager names and keeps the layout, and the
     controls stay out of the way until a person edits: then the gallery, a
     reset, and Save to leave edit mode. Every change is already kept. */
  if (workbook !== null) {
    return (
      <div className="layout-bar flex items-center gap-2">
        {editing ? (
          <>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setGallery(true)}
              aria-label="Open the widget gallery"
              title="Widgets"
            >
              <GalleryIcon />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={resetLayout}
              aria-label="Reset layout"
              title="Reset layout"
            >
              <LayoutIcon />
            </button>
            <button
              type="button"
              className="btn-primary px-3 text-[13px]"
              onClick={() => setEditing(false)}
              title="Leave edit mode; every change is already kept"
            >
              Save
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn-ghost flex items-center gap-2"
            onClick={() => setEditing(true)}
            title="Move, resize, add and remove widgets"
          >
            <EditIcon />
            <span>Edit dashboard</span>
          </button>
        )}
        {gallery && <Gallery onClose={() => setGallery(false)} />}
      </div>
    );
  }

  return (
    <div className="layout-bar flex items-center gap-2">
      {workbook !== null ? null : (
        <>
          <ViewPicker
            value={activeViewId ?? ''}
            custom={active === null}
            views={views}
            onPick={applyView}
          />
          {modified && (
            <span className="text-muted text-xs" title="The dashboard differs from this view">
              modified
            </span>
          )}
          <SaveControls active={active} />
        </>
      )}
      <button
        type="button"
        className="icon-btn"
        onClick={() => setGallery(true)}
        aria-label="Open the widget gallery"
        title="Widgets"
      >
        <GalleryIcon />
      </button>
      <button
        type="button"
        className={`icon-btn ${editing ? 'icon-btn-on' : ''}`}
        onClick={() => setEditing(!editing)}
        aria-pressed={editing}
        aria-label={editing ? 'Lock the layout' : 'Edit the layout'}
        title={editing ? 'Lock the layout' : 'Edit the layout: move, resize, remove widgets'}
      >
        <EditIcon />
      </button>
      {gallery && <Gallery onClose={() => setGallery(false)} />}
    </div>
  );
}
