"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getCurrentUser, PortalApiError, PortalUnreachableError } from "@/lib/portal/client";

interface TokenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with a validated token; the caller persists it. */
  onConnect: (token: string) => void;
}

/**
 * Standalone-mode dialog for pasting a Quix Personal Access Token. The token
 * is validated against the Portal API before being stored.
 */
export function TokenDialog({ open, onOpenChange, onConnect }: TokenDialogProps) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setValue("");
      setError(null);
      setSubmitting(false);
    }
    onOpenChange(nextOpen);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = value.trim();
    if (!token || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await getCurrentUser(token);
      onConnect(token);
      handleOpenChange(false);
    } catch (validationError) {
      if (validationError instanceof PortalUnreachableError) {
        setError("Could not reach the Quix Portal API. Check your connection and try again.");
      } else if (validationError instanceof PortalApiError && validationError.status === 401) {
        setError("That token was rejected by the Quix Portal. Check it and try again.");
      } else {
        setError("Token validation failed. Please try again.");
      }
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect Quix token</DialogTitle>
          <DialogDescription>
            Paste a Personal Access Token from the Quix Portal. It is stored locally in this browser
            and only used to identify you.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-3">
          <label htmlFor="portal-pat" className="sr-only">
            Personal Access Token
          </label>
          <Input
            id="portal-pat"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Personal Access Token"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={error !== null || undefined}
            aria-describedby={error !== null ? "portal-pat-error" : undefined}
          />
          {error !== null && (
            <p id="portal-pat-error" role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="mt-1">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={value.trim().length === 0 || submitting}>
              {submitting ? "Validating…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
