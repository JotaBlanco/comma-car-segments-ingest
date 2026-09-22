"use client";

import { usePortalAuth, usePortalUser } from "@/lib/portal/use-portal-auth";

/**
 * The display name `lib/portal/client.ts` returns when the profile carries no
 * name and no email. `api/api/provenance.py` refuses that string, so it names
 * nobody. Every control treats it as "not signed in" and never sends it.
 */
const PLACEHOLDER_NAME = "quix user";

/**
 * True when the display name is the placeholder and names nobody.
 *
 * The account menu reads this too, so one comparison serves both. A second
 * copy would drift.
 */
export function isPlaceholderName(displayName: string): boolean {
  return displayName.trim().toLowerCase() === PLACEHOLDER_NAME;
}

/** The one sentence a control shows when no identity signs the change. */
export const NO_ACTOR_MESSAGE =
  "This change needs a signed-in Quix identity, because the journal names the person who made it. Sign in to the Quix Portal, then save.";

/**
 * The name the API writes into the journal for a manual change.
 *
 * It comes from the signed-in Quix Portal profile and from nowhere else. The
 * hook answers null while no identity resolves. A control reads that null,
 * shows `NO_ACTOR_MESSAGE` and disables its submit button.
 */
export function useActor(): string | null {
  const { token } = usePortalAuth();
  const portalUser = usePortalUser(token);
  const displayName = portalUser.data?.displayName.trim() ?? "";
  if (displayName.length === 0) return null;
  if (isPlaceholderName(displayName)) return null;
  return displayName;
}

/**
 * Return the actor, or refuse the write.
 *
 * A mutation calls this in its `mutationFn`. The button is already disabled
 * without an identity, so this guard catches the paths a button cannot: a
 * keyboard submit, a race with the profile query, a future caller.
 */
export function requireActor(actor: string | null): string {
  if (actor === null) throw new Error(NO_ACTOR_MESSAGE);
  return actor;
}
