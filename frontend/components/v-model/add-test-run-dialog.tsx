"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
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
import {
  MF4_UPLOAD_UNCONFIGURED_MESSAGE,
  resolveMf4UploadBase,
  uploadMf4Direct,
} from "@/lib/mf4/upload-client"
import type { RunSummary, TestSpec } from "@/types/vmodel"
import { TcUploadRow, type TcUploadState } from "./tc-upload-row"

interface AddTestRunDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the created run so the caller can navigate or refetch. */
  onCreated?: (run: RunSummary) => void
}

/**
 * Add Test Run.
 *
 * The dialog contains exactly two things, and deliberately nothing else:
 *
 *   1. a multi-select of test cases from `GET /api/v1/vmodel/test-specs`
 *   2. one MF4 upload control per selected test case
 *
 * No campaign, environment, operator, dates or sensors. `POST /api/v1/vmodel/runs`
 * needs none of them (see backend/api/routes/vm_runs.py create_run, which documents
 * why it is not routed through `POST /tests`), and a field the run does not use is a
 * field that invents data.
 *
 * The label is left to the backend, which derives it from the run id and the number of
 * planned cases - one less box to fill in, and it can never disagree with the run.
 *
 * The form body lives in `AddTestRunForm` so that Radix only mounts it - and only then
 * fetches the test specification register - when the dialog is actually opened.
 */
export function AddTestRunDialog({ open, onOpenChange, onCreated }: AddTestRunDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Test Run</DialogTitle>
          <DialogDescription>
            Pick the test cases to run and attach the MF4 measurement for each.
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
  const [uploads, setUploads] = useState<Record<string, TcUploadState>>({})
  const [mf4Base, setMf4Base] = useState<string | null>(null)
  const [baseResolved, setBaseResolved] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // The upload service is a separate deployment; its URL comes from an environment
  // variable, resolved once when the dialog opens.
  useEffect(() => {
    let cancelled = false
    resolveMf4UploadBase().then((base) => {
      if (!cancelled) {
        setMf4Base(base)
        setBaseResolved(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

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

  const titleFor = useCallback(
    (tcId: string) => options.find((spec) => spec.tc_id === tcId)?.title ?? "",
    [options]
  )

  const toggle = useCallback((tcId: string) => {
    setSelected((prev) =>
      prev.includes(tcId) ? prev.filter((id) => id !== tcId) : [...prev, tcId]
    )
    // Deselecting drops the attachment too: an upload with no selected case would be
    // silently excluded from the payload, which is worse than losing the file handle.
    setUploads((prev) => {
      if (!(tcId in prev)) return prev
      const next = { ...prev }
      delete next[tcId]
      return next
    })
  }, [])

  const handleFile = useCallback(
    async (tcId: string, file: File) => {
      if (!mf4Base) return

      setUploads((prev) => ({
        ...prev,
        [tcId]: { filename: file.name, sizeBytes: file.size, progress: 0 },
      }))

      try {
        const result = await uploadMf4Direct(mf4Base, file, (percent) => {
          setUploads((prev) => {
            const current = prev[tcId]
            if (!current) return prev
            return { ...prev, [tcId]: { ...current, progress: percent } }
          })
        })

        setUploads((prev) => ({
          ...prev,
          [tcId]: {
            filename: result.filename || file.name,
            sizeBytes: result.size_bytes ?? file.size,
            progress: 100,
            uploadId: result.upload_id,
            blobPath: result.blob_path ?? null,
          },
        }))
      } catch (uploadError) {
        const message =
          uploadError instanceof Error ? uploadError.message : "Upload failed"
        setUploads((prev) => ({
          ...prev,
          [tcId]: { filename: file.name, sizeBytes: file.size, progress: 0, error: message },
        }))
        toast({
          title: `Upload failed for ${tcId}`,
          description: message,
          variant: "destructive",
        })
      }
    },
    [mf4Base, toast]
  )

  const clearUpload = useCallback((tcId: string) => {
    setUploads((prev) => {
      const next = { ...prev }
      delete next[tcId]
      return next
    })
  }, [])

  const readyCount = selected.filter((tcId) => uploads[tcId]?.uploadId).length
  // Selecting test cases is enough to create a run. An MF4 is optional here and can be
  // attached later; requiring one blocked planning a run before the measurement exists.
  const canSubmit = selected.length > 0 && !submitting

  const handleSubmit = useCallback(async () => {
    setSubmitting(true)
    try {
      // Exactly the shape POST /vmodel/runs expects. planned_tc_ids is derived
      // server-side from this list, so it is never sent twice.
      const run = await vmRunsApi.create({
        tc_uploads: selected.map((tcId) => {
          const upload = uploads[tcId]
          return {
            tc_id: tcId,
            upload_id: upload?.uploadId ?? null,
            filename: upload?.filename ?? null,
            blob_path: upload?.blobPath ?? null,
            size_bytes: upload?.sizeBytes ?? null,
          }
        }),
      })

      toast({
        title: `Test run ${run.run_id} created`,
        description: `${run.planned_tc_ids.length} test case(s) planned. Execution is not wired yet.`,
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
  }, [onCreated, onOpenChange, selected, toast, uploads, vmRunsApi])

  const uploadDisabled = baseResolved && !mf4Base

  return (
    <>
      <div className="max-h-[55vh] space-y-6 overflow-y-auto pr-1">
        {/* Thing 1 of 2 - the test case multi-select */}
        <section className="space-y-2">
          <h3 className="text-sm font-medium">
            Test cases
            {selected.length > 0 && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {selected.length} selected
              </span>
            )}
          </h3>

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
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
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
        </section>

        {/* Thing 2 of 2 - one MF4 upload control per selected test case */}
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Measurement file per test case</h3>
          {selected.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Select a test case above to attach its MF4.
            </p>
          ) : (
            <div className="space-y-2">
              {selected.map((tcId) => (
                <TcUploadRow
                  key={tcId}
                  tcId={tcId}
                  title={titleFor(tcId)}
                  state={uploads[tcId]}
                  disabled={uploadDisabled}
                  disabledReason={MF4_UPLOAD_UNCONFIGURED_MESSAGE}
                  onFileSelected={(file) => handleFile(tcId, file)}
                  onClear={() => clearUpload(tcId)}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      <DialogFooter className="items-center gap-2 sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {selected.length === 0
            ? "Nothing selected yet."
            : `${selected.length} test case${selected.length === 1 ? "" : "s"} selected · ${readyCount} with an MF4 (optional).`}
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
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
