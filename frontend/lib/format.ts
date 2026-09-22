const DAY_MS = 86_400_000;

const trimTrailingZeros = (value: string): string =>
  value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

export function formatInt(value: number): string {
  return new Intl.NumberFormat("en-GB").format(value);
}

export function formatCompact(value: number): string {
  if (value < 1000) return String(value);
  return `${trimTrailingZeros((value / 1000).toFixed(1))}k`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${trimTrailingZeros((bytes / 1e9).toFixed(2))} GB`;
  if (bytes >= 1e6) {
    const mb = bytes / 1e6;
    return `${mb >= 100 ? Math.round(mb) : trimTrailingZeros(mb.toFixed(1))} MB`;
  }
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${bytes} B`;
}

/**
 * A sample rate for display. Round to one decimal, then drop a trailing ".0".
 * A clean 100 stays "100". A real 12.5 stays "12.5". A float artefact like
 * 49.89996665555185 becomes "49.9" — rounded, never fabricated. A non-finite
 * value renders as an em dash, per the repo rule. `formatStat` was not reused
 * here because it prints 100 as "100.0".
 */
export function formatRate(hz: number): string {
  if (!Number.isFinite(hz)) return "—";
  return trimTrailingZeros(hz.toFixed(1));
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatArrival(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const startOfDay = (input: Date) =>
    new Date(input.getFullYear(), input.getMonth(), input.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  const time = formatTime(iso);
  if (diffDays <= 0) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  return `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${time}`;
}
