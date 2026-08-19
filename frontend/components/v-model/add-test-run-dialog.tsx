"use client"

import { useCallback, useMemo, useState } from "react"
import { AlertTriangle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useToast } from "@/lib/hooks/use-toast"
import { useVmRunsApi } from "@/lib/hooks/use-api"
import { useVmTestSpecs } from "@/lib/hooks/use-vm-test-specs"
import type { RunSummary, TestSpec } from "@/types/vmodel"

interface AddTestRunDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the created run so the caller can select it or refetch. */
  onCreated?: (run: RunSummary) => void
}

/**
 * Add Test Run.
 *
 * The dialog contains exactly one thing: which test cases to run.
 *
 * It used to contain a second thing - an MF4 upload control per selected test case -
 * and that is deliberately gone. The measurement data a test case is evaluated
 * against is produced by QuixLab, not hand-attached here, and `POST /vmodel/runs`
 * already treats `upload_id` as optional. Keeping the control meant every run
 * dragged an upload service dependency, a progress state machine and a failure mode
 * behind it to reach the same result as ticking a box. Uploading a measurement is a
 * separate job and belongs on its own surface, not in the way of planning a run.
 *
 * Still absent, for the same reason as before: campaign, environment, operator, dates
 * and sensors. The run does not use them, and a field the run does not use is a field
 * that invents data. The label is derived server-side from the run id and the number
 * of planned cases, so it can never disagree with the run.
 *
 * The form body lives in `AddTestRunForm` so Radix only mounts it - and only then
 * fetches the test specification register - when the dialog is actually opened.
 */
export function AddTestRunDialog({ open, onOpenChange, onCreated }: AddTestRunDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Test Run</DialogTitle>
          <DialogDescription>
            Pick the test cases to run. Measurement data comes from QuixLab - nothing to
            upload here.
          </DialogDescription>
        </DialogHeader>
        <AddTestRunForm onOpenChange={onOpenChange} onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  )
}

function AddTestRunForm({
  onOpenChange,
  onCreated,
}: Pick<AddTestRunDialogProps, "onOpenChange" | "onCreated">) {
  const { testSpecs, loading, error } = useVmTestSpecs()
  const vmRunsApi = useVmRunsApi()
  const { toast } = useToast()

  const [selected, setSelected] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)

  // One row per test case id. The register returns every artifact version, so keep the
  // newest version of each id - a test case must never appear twice in the picker.
  const options = useMemo(() => {
    const newest = new Map<string, TestSpec>()
    for (const spec of testSpecs) {
      const existing = newest.get(spec.tc_id)
      if (!existing || (spec.artifact_version ?? "") > (existing.artifact_version ?? "")) {
        newest.set(spec.tc_id, spec)
      }
    }
    return [...newest.values()].sort((a, b) => a.tc_id.localeCompare(b.tc_id))
  }, [testSpecs])

  const toggle = useCallback((tcId: string) => {
    setSelected((prev) =>
      prev.includes(tcId) ? prev.filter((id) => id !== tcId) : [...prev, tcId]
    )
  }, [])

  const allSelected = options.length > 0 && selected.length === options.length

  const toggleAll = useCallback(() => {
    setSelected((prev) => (prev.length === options.length ? [] : options.map((s) => s.tc_id)))
  }, [options])

  const handleSubmit = useCallback(async () => {
    setSubmitting(true)
    try {
      // Exactly the shape POST /vmodel/runs expects. planned_tc_ids is derived
      // server-side from this list, so it is never sent twice. `upload_id` is left
      // null: a run is planned from its test cases, and the measurement is whatever
      // QuixLab produced for them.
      const run = await vmRunsApi.create({
        tc_uploads: selected.map((tcId) => ({ tc_id: tcId, upload_id: null })),
      })

      toast({
        title: `Test run ${run.run_id} created`,
        description: `${run.planned_tc_ids.length} test case(s) planned. Hit Run to start it.`,
      })
      onOpenChange(false)
      onCreated?.(run)
    } catch (createError) {
      toast({
        title: "Could not create the test run",
        description:
          createError instanceof Error ? createError.message : "POST /vmodel/runs failed",
        variant: "destructive",
      })
    } finally {
      setSubmitting(false)
    }
  }, [onCreated, onOpenChange, selected, toast, vmRunsApi])

  return (
    <>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Test cases</h3>
          {options.length > 0 && (
            <Button type="button" variant="ghost" size="sm" onClick={toggleAll}>
              {allSelected ? "Clear all" : "Select all"}
            </Button>
          )}
        </div>

        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading test specifications&hellip;
          </p>
        ) : error ? (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {error.message}
          </p>
        ) : options.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The test specification register is empty. Seed it, then reopen this dialog.
          </p>
        ) : (
          <div className="max-h-[45vh] space-y-1 overflow-y-auto rounded-md border p-2">
            {options.map((spec) => (
              <label
                key={spec.tc_id}
                className="flex cursor-pointer items-start gap-3 rounded px-2 py-1.5 hover:bg-foreground/5"
              >
                <Checkbox
                  className="mt-0.5"
                  checked={selected.includes(spec.tc_id)}
                  onCheckedChange={() => toggle(spec.tc_id)}
                />
                <span className="min-w-0">
                  <span className="block font-mono text-sm">{spec.tc_id}</span>
                  <span className="block text-xs text-muted-foreground">{spec.title}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      <DialogFooter className="items-center gap-2 sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {selected.length === 0
            ? "Nothing selected yet."
            : `${selected.length} of ${options.length} test cases selected.`}
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={selected.length === 0 || submitting}
            loading={submitting}
            onClick={handleSubmit}
          >
            Create Test Run
          </Button>
        </div>
      </DialogFooter>
    </>
  )
}
