import { ToneBadge, type BadgeTone } from "@/components/shared/status-badge";
import type { FileLifecycle } from "@/types";

/**
 * The lifecycle of one file, as its own badge.
 *
 * `lifecycle` and `status` are two separate fields. `status` is the verdict of
 * the registry on the bytes. `lifecycle` states what a person did with the
 * record. So this badge stands **beside** the status badge and never replaces
 * it: an archived file can still be quarantined, and a restore never changes
 * the status.
 */
const LIFECYCLE: Record<FileLifecycle, { label: string; tone: BadgeTone }> = {
  active: { label: "Active", tone: "green" },
  archived: { label: "Archived", tone: "amber" },
  deleted: { label: "Deleted", tone: "red" },
};

/** One sentence per lifecycle, for the title and for the screen banner. */
export const LIFECYCLE_SENTENCE: Record<FileLifecycle, string> = {
  active: "This file sits in the file table.",
  archived:
    "A person archived this file. It left the file table and it keeps every byte, so it still downloads. Restore it before you edit it or add a version.",
  deleted:
    "A person deleted this file. The delete is a soft delete: the registry keeps every byte and keeps the storage location, and only the download refuses. Restore the file to open the download again.",
};

interface LifecycleBadgeProps {
  lifecycle: FileLifecycle;
  className?: string;
}

export function LifecycleBadge({ lifecycle, className }: LifecycleBadgeProps) {
  const config = LIFECYCLE[lifecycle];
  return (
    <span title={LIFECYCLE_SENTENCE[lifecycle]}>
      <ToneBadge tone={config.tone} dot className={className}>
        {config.label}
      </ToneBadge>
    </span>
  );
}
