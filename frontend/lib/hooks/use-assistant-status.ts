"use client";

import { useQuery } from "@tanstack/react-query";
import { getAssistantStatus } from "@/lib/api/assistant";
import { keys } from "./keys";

/**
 * `GET /assistant/status` — the only way the FE learns availability (plan
 * §5.2: a server-component env read would be baked at image build time).
 * The trigger and panel render nothing until this answers `enabled: true`.
 * No retry: a disabled or unreachable assistant must not become a request
 * storm on every screen; staleTime keeps it to one probe a minute.
 */
export function useAssistantStatus() {
  return useQuery({
    queryKey: keys.assistantStatus,
    queryFn: getAssistantStatus,
    staleTime: 60_000,
    retry: false,
  });
}
