"use client";

import { KeyRound, LogOut, RefreshCw } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { isPlaceholderName } from "@/lib/hooks/use-actor";
import { PortalApiError, PortalUnreachableError } from "@/lib/portal/client";
import { isEmbedded } from "@/lib/portal/token-store";
import type { PortalTokenSource } from "@/lib/portal/use-portal-auth";
import { usePortalAuth, usePortalUser } from "@/lib/portal/use-portal-auth";
import { cn } from "@/lib/utils";
import { InitialsAvatar, PlaceholderAvatar } from "./initials-avatar";
import { TokenDialog } from "./token-dialog";

/**
 * What each token source proves. A presenter reads this line and knows whether
 * the platform identified the person, or whether somebody pasted a token.
 */
const SOURCE_TEXT: Record<PortalTokenSource, string> = {
  handshake: "Verified by Portal handshake",
  url: "Token from a link, not verified by the Portal",
  pasted: "Pasted token, not verified by the Portal",
};

/** Color alone never carries the meaning. The text above always goes with it. */
const SOURCE_DOT: Record<PortalTokenSource, string> = {
  handshake: "bg-green-dot",
  url: "bg-amber-dot",
  pasted: "bg-amber-dot",
};

/**
 * The line the menu shows when the token works but the profile names nobody.
 * `lib/portal/client.ts` falls back to "Quix user", and `api/api/provenance.py`
 * refuses that string. So the menu must never present it as a person.
 */
const NO_NAME_TEXT = "Token connected, but the profile names nobody.";

/**
 * `useLayoutEffect` runs before the browser paints, so the menu never shows up
 * and then disappears. It does nothing on the server and React warns about it
 * there, so the server gets `useEffect`.
 */
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Topbar account chip + dropdown. Shows the signed-in Quix Portal user
 * (avatar, name, email, org) with a log-out action; when signed out it offers
 * a "Connect token…" flow for standalone mode. Never blocks the app — auth
 * failures just render the neutral states.
 *
 * It renders nothing inside a frame. The Quix Portal frames this app and shows
 * the signed-in person itself, so a second avatar names the same person twice.
 */
export function AccountMenu() {
  const { token, phase, source, connect, disconnect } = usePortalAuth();
  const user = usePortalUser(token);
  const [dialogOpen, setDialogOpen] = useState(false);

  // The Quix Portal frames this app and already shows the signed-in person at
  // the top right. A second avatar below it is the same person twice.
  //
  // The state starts `false`, so the server and the first browser render both
  // show nothing and hydration matches. The server cannot read `window`. In a
  // frame the markup never arrives, so no avatar flashes.
  const [standalone, setStandalone] = useState(false);
  useBrowserLayoutEffect(() => setStandalone(!isEmbedded()), []);

  const unauthorized = user.error instanceof PortalApiError && user.error.status === 401;
  const unreachable = user.error instanceof PortalUnreachableError;
  const failed = user.isError && user.data === undefined && !unauthorized;

  // Expired/invalid token → drop it and fall back to the signed-out state.
  useEffect(() => {
    if (unauthorized) disconnect();
  }, [unauthorized, disconnect]);

  // Every hook above still runs in a frame. `usePortalAuth` holds the token
  // handshake, and the rest of the app reads that token. Only the markup goes.
  if (!standalone) return null;

  const signedIn = phase === "authenticated" && token !== null;
  const loading = phase === "resolving" || (signedIn && user.isPending);

  const profile = signedIn ? user.data : undefined;
  // A profile with no name and no email names nobody. Never show it as a name.
  const anonymous = profile !== undefined && isPlaceholderName(profile.displayName);
  const sourceText = source === null ? null : SOURCE_TEXT[source];

  let chip: React.ReactNode;
  let chipTitle: string;
  if (profile !== undefined && !anonymous) {
    chip = <InitialsAvatar name={profile.displayName} email={profile.email} />;
    chipTitle = profile.displayName;
  } else if (anonymous) {
    chip = <PlaceholderAvatar glyph="!" />;
    chipTitle = NO_NAME_TEXT;
  } else if (signedIn && failed) {
    chip = <PlaceholderAvatar glyph="!" />;
    chipTitle = unreachable ? "Portal unreachable" : "Could not load profile";
  } else if (loading) {
    chip = <Skeleton className="size-7 rounded-full" />;
    chipTitle = "Account";
  } else {
    chip = <PlaceholderAvatar glyph="?" />;
    chipTitle = "Not signed in";
  }

  // The dot repeats the source in color. The trigger label carries the words,
  // because a screen reader gets no color.
  const triggerTitle = sourceText === null ? chipTitle : `${chipTitle} — ${sourceText}`;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Account menu — ${triggerTitle}`}
          title={triggerTitle}
          className="relative grid place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {chip}
          {source !== null && (
            <span
              aria-hidden
              className={cn(
                "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-surface",
                SOURCE_DOT[source],
              )}
            />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="w-64">
          {signedIn && user.isPending && (
            <div className="flex items-center gap-3 px-2 py-2.5">
              <Skeleton className="size-9 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-3 w-36" />
              </div>
            </div>
          )}

          {profile !== undefined && (
            <>
              {anonymous ? (
                <div className="px-2 py-2.5 text-xs text-ink-3">{NO_NAME_TEXT}</div>
              ) : (
                <div className="flex items-start gap-3 px-2 py-2.5">
                  <InitialsAvatar name={profile.displayName} email={profile.email} size="lg" />
                  <div className="min-w-0 leading-snug">
                    <div className="truncate text-sm font-semibold text-foreground">
                      {profile.displayName}
                    </div>
                    {profile.email !== "" && (
                      <div className="truncate text-xs text-ink-3">{profile.email}</div>
                    )}
                    {profile.organizationName !== null && (
                      <div className="mt-0.5 truncate text-xs font-medium text-accent-foreground">
                        {profile.organizationName}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {source !== null && (
                <div className="flex items-center gap-2 px-2 pb-2.5 text-xs text-ink-3">
                  <span aria-hidden className={cn("size-2 shrink-0 rounded-full", SOURCE_DOT[source])} />
                  <span>{SOURCE_TEXT[source]}</span>
                </div>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={disconnect}>
                <LogOut aria-hidden />
                Log out
              </DropdownMenuItem>
            </>
          )}

          {signedIn && failed && (
            <>
              <div className="px-2 py-2.5 text-xs text-ink-3">
                {unreachable
                  ? "Portal unreachable — your profile could not be loaded."
                  : "Your Quix profile could not be loaded."}
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void user.refetch()}>
                <RefreshCw aria-hidden />
                Retry
              </DropdownMenuItem>
              <DropdownMenuItem onClick={disconnect}>
                <LogOut aria-hidden />
                Log out
              </DropdownMenuItem>
            </>
          )}

          {!signedIn && !loading && (
            <>
              <div className="px-2 py-2.5 text-xs text-ink-3">Not signed in to Quix.</div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setDialogOpen(true)}>
                <KeyRound aria-hidden />
                Connect token…
              </DropdownMenuItem>
            </>
          )}

          {!signedIn && loading && (
            <div className="px-2 py-2.5 text-xs text-ink-3">Signing in…</div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <TokenDialog open={dialogOpen} onOpenChange={setDialogOpen} onConnect={connect} />
    </>
  );
}
