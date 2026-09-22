import { cn } from "@/lib/utils";

/**
 * Deterministic avatar palette — deep, saturated tones that hold AA contrast
 * with white initials in both themes. First entry matches the app accent.
 */
const AVATAR_PALETTE = [
  "#24408e", // accent blue
  "#1d6b5e", // teal
  "#7a3e9d", // violet
  "#a34d20", // rust
  "#8e2450", // raspberry
  "#4d6b1d", // olive
  "#20627a", // steel
  "#6b4a1d", // bronze
] as const;

function hashString(value: string): number {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return Math.abs(hash);
}

export function avatarColor(seed: string): string {
  return AVATAR_PALETTE[hashString(seed) % AVATAR_PALETTE.length];
}

export function initialsFor(name: string, email: string): string {
  const source = name.trim() || email.trim();
  if (!source) return "?";
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0]![0] ?? ""}${words[1]![0] ?? ""}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

interface InitialsAvatarProps {
  name: string;
  email: string;
  size?: "sm" | "lg";
  className?: string;
}

/** Colored circle with the user's initials; color derived from the email hash. */
export function InitialsAvatar({ name, email, size = "sm", className }: InitialsAvatarProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-bold text-white",
        size === "sm" ? "size-7 text-[0.7rem]" : "size-9 text-[0.85rem]",
        className,
      )}
      style={{ backgroundColor: avatarColor(email || name) }}
    >
      {initialsFor(name, email)}
    </span>
  );
}

interface PlaceholderAvatarProps {
  glyph: "?" | "!";
  size?: "sm" | "lg";
  className?: string;
}

/** Neutral chip used for the signed-out ("?") and unreachable ("!") states. */
export function PlaceholderAvatar({ glyph, size = "sm", className }: PlaceholderAvatarProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full border border-line bg-surface-2 font-bold text-ink-3",
        size === "sm" ? "size-7 text-[0.7rem]" : "size-9 text-[0.85rem]",
        className,
      )}
    >
      {glyph}
    </span>
  );
}
