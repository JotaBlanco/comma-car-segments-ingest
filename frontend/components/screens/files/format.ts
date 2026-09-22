const DAY_MS = 86_400_000;

export function formatDay(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const startOfDay = (input: Date): number =>
    new Date(input.getFullYear(), input.getMonth(), input.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return iso.slice(0, 10);
}

export function shortChecksum(hex: string): string {
  return `sha256:${hex.slice(0, 4)}…${hex.slice(-4)}`;
}

export function truncateFilename(name: string): string {
  return name.length > 18 ? `${name.slice(0, 8)}…${name.slice(-8)}` : name;
}

/**
 * Split a filename into stem and extension. The detail header truncates the
 * stem with CSS and keeps the extension whole, so a long name still says what
 * kind of file it is.
 */
export function splitExtension(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf(".");
  // A leading dot is a hidden-file name, not an extension.
  if (dot <= 0) return { stem: name, extension: "" };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

export function formatClock(iso: string | null): string {
  if (iso === null) return "—";
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * One rounding rule for every statistic.
 *
 * One decimal suits a temperature, and it flattens a small value: a lateral
 * acceleration of 0.02 g reads "0.0". So a value below 1 keeps two significant
 * digits instead. A value of 1 or more keeps the one decimal and its magnitude.
 */
export function formatStat(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0 || Math.abs(value) >= 1) return value.toFixed(1);
  return String(Number(value.toPrecision(2)));
}
