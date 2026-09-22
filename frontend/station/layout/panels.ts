/** The widgets that exist once: the gallery lists them, the grid places them. */
export const PANEL_IDS = ['map', 'altitude', 'instruments', 'annunciator', 'strips'] as const;

export type PanelId = (typeof PANEL_IDS)[number];

/** A widget instance: a singleton's own id, or `waveform:<n>` for the n-th waveform. */
export type Collapsed = Record<string, boolean>;

export function isPanelId(v: string): v is PanelId {
  return (PANEL_IDS as readonly string[]).includes(v);
}

export function isWidgetInstanceId(v: string): boolean {
  return isPanelId(v) || /^waveform:\d+$/.test(v);
}

/** Every singleton expanded, then what the hash marked collapsed. */
export function collapsedFrom(ids: readonly string[]): Collapsed {
  const out = Object.fromEntries(PANEL_IDS.map((id) => [id, false])) as Collapsed;
  for (const id of ids) if (isWidgetInstanceId(id)) out[id] = true;
  return out;
}

export function collapsedIds(c: Collapsed): string[] {
  return Object.keys(c)
    .filter((id) => c[id])
    .sort();
}
