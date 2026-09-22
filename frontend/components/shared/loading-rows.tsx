import { Skeleton } from "@/components/ui/skeleton";

interface LoadingRowsProps {
  rows?: number;
  cols?: number;
  /** Announced while the skeletons are on screen. */
  label?: string;
}

/**
 * Skeleton rows for a loading table body. The skeletons are decoration, so
 * they carry `aria-hidden`; the one thing a screen reader hears is the
 * sr-only status label in the first cell. Without it a slow fetch was
 * indistinguishable from an empty table.
 */
export function LoadingRows({ rows = 5, cols = 5, label = "Loading rows" }: LoadingRowsProps) {
  return (
    <>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <tr key={rowIndex}>
          {Array.from({ length: cols }, (_, colIndex) => (
            <td key={colIndex}>
              {rowIndex === 0 && colIndex === 0 && (
                <span role="status" className="sr-only">
                  {label}
                </span>
              )}
              <Skeleton aria-hidden className="h-3.5 w-full max-w-28" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
