import { ToneBadge, type BadgeTone } from "@/components/shared/status-badge";
import { Panel, PanelHead } from "@/components/shared/panel";
import { MetaCell, MetaGrid } from "@/components/shared/meta-grid";
import type { FileDetail, StageStatus } from "@/types";

/**
 * The three ingestion stages of one file (FR-DM-006b).
 *
 * The pipeline runs the sync, the upload and the conversion outside the
 * registry and reports each outcome on the file row. An absent value means no
 * stage report arrived, so the panel prints "No report" and never "Failed".
 */
const STAGE_LOOK: Record<StageStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: "Pending", tone: "neutral" },
  in_progress: { label: "In progress", tone: "amber" },
  success: { label: "Success", tone: "green" },
  failed: { label: "Failed", tone: "red" },
};

function StageCell({ label, value }: { label: string; value: StageStatus | null | undefined }) {
  const look = value == null ? null : STAGE_LOOK[value];
  return (
    <MetaCell label={label} className="[&:nth-child(3n)]:border-r-0">
      {look === null ? (
        <ToneBadge tone="neutral">No report</ToneBadge>
      ) : (
        <ToneBadge tone={look.tone} dot>
          {look.label}
        </ToneBadge>
      )}
    </MetaCell>
  );
}

interface StageStatusPanelProps {
  file: Pick<
    FileDetail,
    "sync_status" | "upload_status" | "conversion_status" | "stage_error"
  >;
  className?: string;
}

export function StageStatusPanel({ file, className }: StageStatusPanelProps) {
  const stages = [file.sync_status, file.upload_status, file.conversion_status];
  const failed = stages.some((stage) => stage === "failed");
  const reported = stages.filter((stage) => stage != null).length;

  return (
    <Panel className={className}>
      <PanelHead
        title="Ingestion stages"
        action={
          <span className="text-[0.7rem] text-ink-3">
            {reported === 0
              ? "the pipeline reported no stage yet"
              : `${reported} of 3 stages reported`}
          </span>
        }
      />
      <MetaGrid className="grid-cols-3">
        <StageCell label="Sync" value={file.sync_status} />
        <StageCell label="Upload" value={file.upload_status} />
        <StageCell label="Conversion" value={file.conversion_status} />
      </MetaGrid>
      {failed && (
        <div className="border-t border-line-2 bg-red-bg px-4 py-2.5 text-[0.76rem] text-red">
          <span className="font-semibold">Stage error: </span>
          {file.stage_error != null && file.stage_error.length > 0
            ? file.stage_error
            : "The pipeline reported a failed stage and sent no error detail."}
        </div>
      )}
      {!failed && file.stage_error != null && file.stage_error.length > 0 && (
        <div className="border-t border-line-2 px-4 py-2.5 text-[0.76rem] text-ink-2">
          <span className="font-semibold">Last stage error: </span>
          {file.stage_error}
        </div>
      )}
    </Panel>
  );
}
