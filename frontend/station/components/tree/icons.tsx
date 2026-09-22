import type { TableKind } from '../../api/types';

interface IconProps {
  className?: string;
  size?: number;
}

function Svg({ className, size = 16, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** An aircraft, nose up: the platform level. */
export function PlaneIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 2.5c.8 0 1.5 1.2 1.5 3v4l7 4.5v2l-7-2v4l2 1.5v1.5L12 20l-3.5 1v-1.5l2-1.5v-4l-7 2v-2l7-4.5v-4c0-1.8.7-3 1.5-3z" />
    </Svg>
  );
}

/** A recording: a flight leg with its two ends. */
export function FlightIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="5" cy="18" r="2" />
      <circle cx="19" cy="6" r="2" />
      <path d="M6.5 16.5C9 13 11 12 13 11c2-1 3.5-2 4.5-3.5" />
    </Svg>
  );
}

/** ARINC 429: a two-wire bus with its taps. */
export function BusIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 8h18M3 16h18" />
      <path d="M8 8v8M16 8v8" />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="16" cy="16" r="1.5" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Analog: a sine trace. */
export function WaveIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2 12c2.5 0 2.5-6 5-6s2.5 12 5 12 2.5-12 5-12 2.5 6 5 6" />
    </Svg>
  );
}

/** FTO: the flight control computer. */
export function ChipIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <rect x="10" y="10" width="4" height="4" rx="0.5" />
      <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
    </Svg>
  );
}

/** A source under a protocol (bus, stream, FCC): a tagged folder. */
export function SourceIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 7.5V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9.5a2 2 0 0 0-2-2h-7l-2-2.5H5a2 2 0 0 0-2 2z" />
      <path
        d="m12 11.2 1 2 2.2.3-1.6 1.5.4 2.2-2-1-2 1 .4-2.2-1.6-1.5 2.2-.3z"
        fill="currentColor"
        stroke="none"
      />
    </Svg>
  );
}

/** A signal: a pulse. */
export function SignalIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 12h4l2.5-6 4 12 2.5-6h5" />
    </Svg>
  );
}

export function ChevronIcon({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      className={`tree-chevron ${open ? 'tree-chevron-open' : ''} ${className ?? ''}`}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function CheckIcon(p: IconProps) {
  return (
    <svg
      className={p.className}
      width={p.size ?? 10}
      height={p.size ?? 10}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

/** The protocol's icon. */
export function KindIcon({ kind, className }: { kind: TableKind; className?: string }) {
  if (kind === 'a429') return <BusIcon className={className} />;
  if (kind === 'analog') return <WaveIcon className={className} />;
  return <ChipIcon className={className} />;
}
