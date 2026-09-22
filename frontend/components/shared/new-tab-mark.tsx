import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The one mark for "this control opens a new tab".
 *
 * Two parts, and each serves one audience:
 *
 *   - the words serve the screen reader. The icon is `aria-hidden`, so the
 *     fact must reach the accessible name in words. The leading space keeps
 *     the name apart ("QuixLab (opens…", not "QuixLab(opens…") — flexbox
 *     drops a whitespace-only item, so it changes no pixel;
 *   - the icon serves the eye. It trails the label, because it states a
 *     consequence of the activation, not the identity of the control. The
 *     leading slot of a nav row holds the row's own icon.
 *
 * `icon={false}` keeps the words and drops the icon — the collapsed sidebar
 * rail shows one icon per row, and a second one would read as a second row.
 * The icon inherits `currentColor`, so it takes the token of its control.
 */
export function NewTabMark({
  icon = true,
  iconClassName,
}: {
  icon?: boolean;
  iconClassName?: string;
}) {
  return (
    <>
      {" "}
      <span className="sr-only">(opens in a new tab)</span>
      {icon && (
        <ExternalLink
          size={12}
          strokeWidth={2}
          aria-hidden
          className={cn("flex-none", iconClassName)}
        />
      )}
    </>
  );
}
