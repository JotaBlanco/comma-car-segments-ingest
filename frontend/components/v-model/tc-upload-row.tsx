"use client"

import { useRef } from "react"
import { FileIcon, Upload, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"

/**
 * Upload state of one selected test case. Held by the dialog, rendered here.
 *
 * `uploadId` is only set once the MF4 upload service has answered - it is the value
 * that goes into `tc_uploads[].upload_id`, and its presence is what makes the test
 * case submittable.
 */
export interface TcUploadState {
  filename: string
  sizeBytes: number
  /** 0-100 while transferring; 100 does not by itself mean the service replied. */
  progress: number
  uploadId?: string
  blobPath?: string | null
  error?: string
}

interface TcUploadRowProps {
  tcId: string
  title: string
  state?: TcUploadState
  /** True when no MF4 service base URL is configured. */
  disabled: boolean
  disabledReason: string
  onFileSelected: (file: File) => void
  onClear: () => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/**
 * The MF4 upload control for one selected test case: filename, progress, and the
 * resulting upload key.
 *
 * Interaction pattern is `components/tests/file-upload-manager.tsx` - hidden file
 * input driven by a Button, XHR progress into a `<Progress>` bar, per-item error text
 * instead of a thrown exception. The difference is scope: one file per test case, and
 * the key it returns is kept rather than discarded.
 */
export function TcUploadRow({
  tcId,
  title,
  state,
  disabled,
  disabledReason,
  onFileSelected,
  onClear,
}: TcUploadRowProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const uploading = state !== undefined && !state.uploadId && !state.error

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-sm">{tcId}</p>
          <p className="truncate text-xs text-muted-foreground">{title}</p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept=".mf4,.MF4"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) onFileSelected(file)
              // Reset so the same file can be picked again after a failure.
              if (inputRef.current) inputRef.current.value = ""
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || uploading}
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="mr-2 h-3.5 w-3.5" />
            {state ? "Replace MF4" : "Choose MF4"}
          </Button>
          {state && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Remove file for ${tcId}`}
              onClick={onClear}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {disabled && <p className="mt-2 text-xs text-muted-foreground">{disabledReason}</p>}

      {state && (
        <div className="mt-2 space-y-1">
          <div className="flex items-center gap-2 text-xs">
            <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{state.filename}</span>
            <span className="shrink-0 text-muted-foreground">
              {formatBytes(state.sizeBytes)}
            </span>
          </div>

          {state.error ? (
            <p className="text-xs text-destructive">{state.error}</p>
          ) : state.uploadId ? (
            <p className="break-all text-xs text-muted-foreground">
              key <span className="font-mono text-foreground">{state.uploadId}</span>
            </p>
          ) : (
            <>
              <Progress value={state.progress} className="h-1" />
              <p className="text-xs text-muted-foreground">
                {state.progress === 100 ? "Finalising…" : `${state.progress}%`}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
