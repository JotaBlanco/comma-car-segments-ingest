export type Theme = 'dark' | 'light';
const KEY = 'fts.theme';

export function nextTheme(t: Theme): Theme {
  return t === 'dark' ? 'light' : 'dark';
}

export function loadTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** The station's own root carries the theme, never the Test Manager's document. */
export function applyTheme(t: Theme): void {
  for (const el of document.querySelectorAll<HTMLElement>('.fts-root')) el.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* storage blocked: theme stays for this page only */
  }
}
