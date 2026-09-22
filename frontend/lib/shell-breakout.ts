/**
 * The class two panels share to break out of AppShell's centered
 * max-w-[1280px] column and take the whole content area: the Explore split
 * (run-detail-screen) and the QuixLab embed (quixlab-panel).
 *
 * Both are `fixed`, so they leave the shell grid and must restate its edges
 * themselves. They stop at the sidebar through `--sidebar-w`, and — since the
 * assistant dock is a grid column they would otherwise cover — at the dock
 * through `--dock-w` / `--dock-left-w`. Those two default to 0px in
 * globals.css and the assistant panel keeps them current.
 *
 * Pinning the right edge to the viewport instead is what hid the assistant on
 * Explore: the overlay is opaque and z-30, the docked panel has no z-index, so
 * clicking Ask AI opened a panel painted underneath it.
 *
 * The easing matches the panel's own width transition (assistant-panel.tsx),
 * so the overlay edge and the panel edge move together on open and close.
 *
 * One constant, two consumers — the strings drifted apart once already.
 */
export const SHELL_BREAKOUT_CLASS =
  "fixed top-[52px] bottom-0 z-30 flex min-h-0 flex-col " +
  "left-[calc(var(--sidebar-w)+var(--dock-left-w))] right-(--dock-w) " +
  "transition-[left,right] duration-[280ms] ease-[cubic-bezier(.32,.72,.28,1)]";
