import type { Theme } from '../../theme/theme';

const props = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  stroke: 'currentColor',
  fill: 'none',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/** Shows the current theme: a moon while dark, a sun while light. */
export default function ThemeIcon({ theme }: { theme: Theme }) {
  if (theme === 'light')
    return (
      <svg {...props} aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  return (
    <svg {...props} aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
