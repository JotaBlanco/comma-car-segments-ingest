/** Panel with a left rail; the chevron shows where it moves. */
export default function SidebarIcon({ open = true }: { open?: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      stroke="currentColor"
      fill="none"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d={open ? 'm16 9-3 3 3 3' : 'm14 9 3 3-3 3'} />
    </svg>
  );
}
