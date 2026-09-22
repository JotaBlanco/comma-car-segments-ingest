"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getCurrentUser, PortalApiError, PortalUnreachableError } from "@/lib/portal/client";
import { usePortalAuth } from "@/lib/portal/use-portal-auth";

/**
 * The screen a person sees when no token reached this app.
 *
 * The Quix Portal frames this app and hands the token over postMessage. A new
 * tab has no parent frame, so it has no handshake. A link may carry the token
 * in its fragment (`#token=...`), and `token-store.ts` reads that. When
 * neither answers, this screen asks the person for a Personal Access Token.
 *
 * It shows only while the phase is `"signed-out"`. `"resolving"` is not
 * `"signed-out"`: the embedded handshake takes up to three seconds, and this
 * screen must never cover the app while that runs.
 *
 * The input is a password field, the way the Lakehouse UI writes it, so the
 * secret never sits in plain sight. The token never reaches a log call.
 */
export function SignedOutScreen() {
  const { phase, connect } = usePortalAuth();
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();
  const titleId = useId();

  if (phase !== "signed-out") return null;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const token = value.trim();
    if (token === "" || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // Ask the Portal who this token names. A refused token never signs in.
      await getCurrentUser(token);
      connect(token);
    } catch (validationError) {
      // The message names the fault only. It never names the token.
      if (validationError instanceof PortalUnreachableError) {
        setError("Could not reach the Quix Portal. Check your connection and try again.");
      } else if (validationError instanceof PortalApiError && validationError.status === 401) {
        setError("The Quix Portal refused that token. Check it and try again.");
      } else {
        setError("The token could not be checked. Please try again.");
      }
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background p-6">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm rounded-xl border border-line bg-surface p-8 shadow-lg"
      >
        <h2 id={titleId} className="text-lg font-semibold text-foreground">
          Sign in to Test Manager
        </h2>
        <p className="mt-2 text-sm text-ink-3">
          Paste a Personal Access Token from the Quix Portal, where your profile page issues one.
        </p>
        <form onSubmit={handleSubmit} className="mt-6 grid gap-3">
          <label htmlFor={inputId} className="text-sm font-medium text-foreground">
            Personal Access Token
          </label>
          <Input
            id={inputId}
            /* A password field hides the secret from anybody behind the
               shoulder. The Lakehouse UI writes its token field the same way,
               and it turns every password manager off. */
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={error !== null || undefined}
            aria-describedby={error !== null ? errorId : undefined}
            disabled={submitting}
          />
          {error !== null && (
            <p id={errorId} role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="mt-1" disabled={value.trim() === "" || submitting}>
            {submitting ? "Checking…" : "Sign in"}
          </Button>
        </form>
      </section>
    </div>
  );
}
