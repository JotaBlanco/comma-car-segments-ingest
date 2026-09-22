"use client";

import { IsRestoringProvider, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { usePortalAuth } from "@/lib/portal/use-portal-auth";

/**
 * Hold every query until the Portal token resolves.
 *
 * The browser states the viewer's token on each call, and `usePortalAuth`
 * writes it to the holder one commit after the mount. Embedded, the postMessage
 * handshake takes up to three seconds on top of that. So the first request of a
 * page load left with no token, the API answered 401, and the screen showed an
 * error card the retry had to repair.
 *
 * `IsRestoringProvider` is React Query's own gate, and it stops the fetch
 * without touching one hook: `useBaseQuery` reads the context, it subscribes no
 * observer while the value is true, and it fires the mount fetch when the value
 * turns false. The app keeps 30-odd `useQuery` calls in 13 hook files and none
 * of them changes.
 *
 * **The gate always opens.** It reads `phase`, and `phase` leaves `"resolving"`
 * on every path: the standalone read settles in the mount effect, the handshake
 * answers, or its own three-second timeout answers for it. A failed handshake
 * therefore runs the queries with no token and the API answers 401 — the
 * honest signed-out answer, which is the same answer the screen shows now.
 * Where no Portal is configured, `requestTokenFromParent` resolves at once, so
 * the gate never holds longer than a microtask.
 *
 * The gate covers queries only. A mutation follows a person's click, which
 * happens long after the phase settles.
 */
function PortalTokenGate({ children }: { children: ReactNode }) {
  const { phase } = usePortalAuth();
  return <IsRestoringProvider value={phase === "resolving"}>{children}</IsRestoringProvider>;
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      {/* Inside the client, because `usePortalAuth` reads it. */}
      <PortalTokenGate>{children}</PortalTokenGate>
    </QueryClientProvider>
  );
}
