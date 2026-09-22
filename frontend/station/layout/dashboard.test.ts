import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addWidget,
  cellAt,
  cellsFor,
  colWidth,
  COLS,
  compact,
  effectiveLayout,
  findView,
  itemRect,
  layoutHeight,
  loadActiveView,
  loadLayout,
  loadViews,
  missingWidgets,
  moveItem,
  normalizeLayout,
  PRESET_VIEWS,
  nextWaveformId,
  removeWidget,
  resizeItem,
  setWidgetParams,
  ROW_PX,
  sameLayout,
  STANDARD_LAYOUT,
  storeActiveView,
  storeLayout,
  storeViews,
  widgetTitle,
  WIDGETS,
  type Layout,
} from './dashboard';
import { collapsedFrom } from './panels';

function stubStorage(seed: Record<string, string> = {}): Record<string, string> {
  const store = { ...seed };
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  });
  return store;
}

function at(layout: Layout, id: string) {
  const it = layout.find((x) => x.id === id);
  if (!it) throw new Error(`no ${id}`);
  return it;
}

function overlaps(layout: Layout): boolean {
  return layout.some((a, i) =>
    layout
      .slice(i + 1)
      .some((b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y),
  );
}

describe('the standard layout', () => {
  it('places every widget once, inside the columns, with no overlap', () => {
    expect(STANDARD_LAYOUT.map((it) => it.id).sort()).toEqual(
      Object.keys(WIDGETS)
        .filter((k) => !WIDGETS[k as keyof typeof WIDGETS].multi)
        .sort(),
    );
    expect(STANDARD_LAYOUT.every((it) => it.x + it.w <= COLS)).toBe(true);
    expect(overlaps(STANDARD_LAYOUT)).toBe(false);
    expect(compact(STANDARD_LAYOUT)).toEqual(STANDARD_LAYOUT);
    for (const v of PRESET_VIEWS) expect(normalizeLayout(v.layout)).toEqual(compact(v.layout));
  });
});

describe('compact', () => {
  it('floats items up to the top or onto the item above', () => {
    const out = compact([
      { id: 'map', kind: 'map', x: 0, y: 3, w: 6, h: 2 },
      { id: 'altitude', kind: 'altitude', x: 0, y: 9, w: 6, h: 2 },
      { id: 'strips', kind: 'strips', x: 6, y: 5, w: 6, h: 1 },
    ]);
    expect(at(out, 'map').y).toBe(0);
    expect(at(out, 'altitude').y).toBe(2);
    expect(at(out, 'strips').y).toBe(0);
  });
});

describe('moveItem', () => {
  it('pushes what it lands on down, then closes the gap it left', () => {
    const out = moveItem(STANDARD_LAYOUT, 'strips', 0, 0);
    expect(at(out, 'strips')).toMatchObject({ x: 0, y: 0 });
    expect(at(out, 'map').y).toBe(8);
    expect(at(out, 'altitude').y).toBe(8);
    expect(at(out, 'instruments').y).toBe(17);
    expect(overlaps(out)).toBe(false);
    expect(layoutHeight(out)).toBe(25);
  });
  it('clamps to the columns and ignores a move to the same cell', () => {
    const out = moveItem(STANDARD_LAYOUT, 'annunciator', 20, -3);
    expect(at(out, 'annunciator')).toMatchObject({ x: COLS - 4, y: 0 });
    expect(moveItem(STANDARD_LAYOUT, 'map', 0, 0)).toBe(STANDARD_LAYOUT);
    expect(moveItem(STANDARD_LAYOUT, 'strips', 1, 1)).not.toBe(STANDARD_LAYOUT);
  });
});

describe('resizeItem', () => {
  it('keeps the minimum, fits the columns, and pushes neighbours below', () => {
    const wide = resizeItem(STANDARD_LAYOUT, 'map', 30, 12);
    expect(at(wide, 'map')).toMatchObject({ x: 0, w: COLS, h: 12 });
    expect(at(wide, 'altitude').y).toBe(12);
    expect(overlaps(wide)).toBe(false);
    const tiny = resizeItem(STANDARD_LAYOUT, 'map', 0, 0);
    expect(at(tiny, 'map')).toMatchObject({ w: WIDGETS.map.minW, h: WIDGETS.map.minH });
  });
});

describe('add and remove', () => {
  it('adds a widget at the bottom in its default size, once, and removes it', () => {
    const empty: Layout = [];
    const one = addWidget(empty, 'map');
    expect(one).toEqual([{ id: 'map', kind: 'map', x: 0, y: 0, w: 6, h: 9 }]);
    const two = addWidget(one, 'strips');
    expect(at(two, 'strips')).toMatchObject({ x: 0, y: 9, w: 12, h: 8 });
    expect(addWidget(two, 'map')).toBe(two);
    expect(missingWidgets(two)).toEqual(['altitude', 'instruments', 'annunciator']);
    const gone = removeWidget(two, 'map');
    expect(gone).toEqual([{ id: 'strips', kind: 'strips', x: 0, y: 0, w: 12, h: 8 }]);
    expect(removeWidget(gone, 'map')).toBe(gone);
  });
});

describe('effectiveLayout', () => {
  it('shrinks a collapsed widget to one row and floats the rest up', () => {
    const c = collapsedFrom(['map', 'altitude']);
    const out = effectiveLayout(STANDARD_LAYOUT, c);
    expect(at(out, 'map').h).toBe(1);
    expect(at(out, 'instruments').y).toBe(1);
    expect(at(out, 'strips').y).toBe(9);
    expect(sameLayout(effectiveLayout(STANDARD_LAYOUT, collapsedFrom([])), STANDARD_LAYOUT)).toBe(
      true,
    );
  });
});

describe('normalizeLayout', () => {
  it('drops unknown and duplicate widgets, clamps cells, and separates overlaps', () => {
    const out = normalizeLayout([
      { id: 'map', kind: 'map', x: -2, y: 1, w: 40, h: 2 },
      { id: 'map', kind: 'map', x: 0, y: 0, w: 2, h: 2 },
      { id: 'ghost', x: 0, y: 0, w: 2, h: 2 },
      { id: 'altitude', kind: 'altitude', x: 3, y: 0, w: 3, h: 4 },
      null,
      'strips',
    ]);
    expect(out.map((it) => it.id).sort()).toEqual(['altitude', 'map']);
    expect(at(out, 'map')).toMatchObject({ x: 0, w: COLS, h: WIDGETS.map.minH });
    expect(overlaps(out)).toBe(false);
    expect(normalizeLayout('nope')).toEqual([]);
    expect(normalizeLayout([{ id: 'strips' }])).toEqual([
      { id: 'strips', kind: 'strips', x: 0, y: 0, w: 12, h: 8 },
    ]);
  });
});

describe('persistence', () => {
  beforeEach(() => stubStorage());
  afterEach(() => vi.unstubAllGlobals());
  it('reads the standard layout when nothing is stored, else what was stored', () => {
    expect(loadLayout()).toEqual(STANDARD_LAYOUT);
    storeLayout([]);
    expect(loadLayout()).toEqual([]);
    const moved = moveItem(STANDARD_LAYOUT, 'strips', 0, 0);
    storeLayout(moved);
    expect(loadLayout()).toEqual(moved);
  });
  it('keeps saved views apart from presets and finds either by id', () => {
    storeViews([
      {
        id: 'view:a',
        name: ' Mine ',
        layout: [{ id: 'map', kind: 'map', x: 0, y: 0, w: 6, h: 9 }],
      },
      { id: 'preset:standard', name: 'Fake', layout: [] },
      { id: 'view:a', name: 'Dup', layout: [] },
    ]);
    const views = loadViews();
    expect(views).toEqual([
      { id: 'view:a', name: 'Mine', layout: [{ id: 'map', kind: 'map', x: 0, y: 0, w: 6, h: 9 }] },
    ]);
    expect(findView(views, 'preset:standard')?.name).toBe('Standard');
    expect(findView(views, 'view:a')?.name).toBe('Mine');
    expect(findView(views, 'view:zz')).toBeNull();
    storeActiveView('view:a');
    expect(loadActiveView()).toBe('view:a');
    storeActiveView(null);
    expect(loadActiveView()).toBeNull();
  });
  it('survives a blocked storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(loadLayout()).toEqual(STANDARD_LAYOUT);
    expect(loadViews()).toEqual([]);
    expect(() => storeLayout([])).not.toThrow();
    expect(() => storeViews([])).not.toThrow();
  });
});

describe('pixels', () => {
  it('turns cells into a rectangle and pixels back into cells', () => {
    const colW = colWidth(1200 + 11 * 10, 10);
    expect(colW).toBe(100);
    expect(itemRect({ id: 'map', kind: 'map', x: 1, y: 2, w: 2, h: 3 }, colW, 10)).toEqual({
      left: 110,
      top: 2 * (ROW_PX + 10),
      width: 210,
      height: 3 * ROW_PX + 20,
    });
    expect(cellAt(115, 2 * (ROW_PX + 10) + 4, colW, 10)).toEqual({ x: 1, y: 2 });
    expect(cellsFor(210, 3 * ROW_PX + 20, colW, 10)).toEqual({ w: 2, h: 3 });
  });
});

describe('waveforms', () => {
  it('adds a numbered instance every time, with its own parameters', () => {
    const one = addWidget([], 'waveform');
    expect(one).toEqual([
      { id: 'waveform:1', kind: 'waveform', x: 0, y: 0, w: 6, h: 8, params: [] },
    ]);
    const two = addWidget(one, 'waveform');
    expect(two.map((it) => it.id)).toEqual(['waveform:1', 'waveform:2']);
    expect(at(two, 'waveform:2')).toMatchObject({ x: 0, y: 8 });
    expect(nextWaveformId(removeWidget(two, 'waveform:1'))).toBe('waveform:1');
    expect(widgetTitle(at(two, 'waveform:2'))).toBe('Waveform 2');
    expect(widgetTitle(STANDARD_LAYOUT[0])).toBe('Map');
  });
  it("sets a waveform's parameters as pick keys, once each, and no other widget's", () => {
    const base = addWidget(addWidget([], 'waveform'), 'map');
    const set = setWidgetParams(base, 'waveform:1', [
      'a429:INS1:alt',
      'a429:INS1:alt',
      'bad',
      'fto:fcc=2:pitch',
    ]);
    expect(at(set, 'waveform:1').params).toEqual(['a429:INS1:alt', 'fto:fcc=2:pitch']);
    expect(setWidgetParams(set, 'waveform:1', ['a429:INS1:alt', 'fto:fcc=2:pitch'])).toBe(set);
    expect(setWidgetParams(set, 'map', ['a429:INS1:alt'])).toBe(set);
    expect(sameLayout(set, base)).toBe(false);
    expect(normalizeLayout([{ id: 'waveform:3', params: ['x:y:z', 7, 'nope'] }])).toEqual([
      { id: 'waveform:3', kind: 'waveform', x: 0, y: 0, w: 6, h: 8, params: ['x:y:z'] },
    ]);
    expect(normalizeLayout([{ id: 'waveform:x' }])).toEqual([]);
  });
});
