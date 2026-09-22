const props = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'currentColor',
  'aria-hidden': true,
} as const;

/** Filled glyphs, so every transport button stays a square. */
export default function TransportIcon({ kind }: { kind: 'play' | 'pause' | 'stop' }) {
  if (kind === 'play')
    return (
      <svg {...props}>
        <path d="M7 4.5v15l12-7.5z" />
      </svg>
    );
  if (kind === 'pause')
    return (
      <svg {...props}>
        <rect x="6" y="4.5" width="4" height="15" rx="1" />
        <rect x="14" y="4.5" width="4" height="15" rx="1" />
      </svg>
    );
  return (
    <svg {...props}>
      <rect x="5.5" y="5.5" width="13" height="13" rx="1.5" />
    </svg>
  );
}
