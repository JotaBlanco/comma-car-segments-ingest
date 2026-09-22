/**
 * The Test Manager mark.
 *
 * This is the same artwork as `app/icon.svg`, which is the favicon and the
 * installed-app icon. The topbar used to draw a lettered "Q" tile instead, so
 * the tab and the top-left corner showed two different brands at once. One
 * shape, two places: change the geometry here and in `app/icon.svg` together.
 *
 * The wordmark is drawn on its own 54 x 26 grid and placed by the transform,
 * which scales it to 40 wide and centres it in the 64 tile. That leaves the
 * mark visually even on every side — at the raw size the letters ran to within
 * 5px of the edges while 19px sat empty above and below.
 *
 * It is decorative here: the topbar prints "Test Manager" in text right beside
 * it, so a second accessible name would only make a screen reader say the
 * product twice.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden focusable="false">
      {/* The colours come from Tailwind fill utilities, not from a
          `fill="var(--token)"` attribute. A presentation attribute is parsed
          as an SVG value, where `var()` is not legal, so the attribute form
          paints nothing at all. The utilities compile to real CSS, so the
          mark follows the theme. */}
      <rect width="64" height="64" rx="11" className="fill-accent-fill" />
      <g
        className="fill-accent-ink"
        transform="translate(12 22.37) scale(0.7407) translate(-5 -19)"
      >
        <path d="M5 19h22v7H5z" />
        <path d="M12.5 19h7v26h-7z" />
        <path d="M31 45V19h6l8 11.5L53 19h6v26h-7V28l-4.5 6.5h-5L38 28v17z" />
      </g>
    </svg>
  );
}
