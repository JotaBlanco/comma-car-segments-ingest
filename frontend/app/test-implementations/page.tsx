"use client"

import { EmbeddedServiceFrame } from "@/components/integrations/embedded-service-frame"
import { useIntegrationsApi } from "@/lib/hooks/use-api"

/**
 * Test Implementation — frames QuixLab, where the analysis scripts live.
 *
 * This is the project's own QuixLab, deliberately not the one the Analytics page
 * frames: that one lives in a separate workspace and is maintained separately.
 * The two are configured independently (QUIXLAB_URL here, ANALYTICS_URL there) so
 * neither can be repointed by changing the other.
 *
 * Everything about the framing - why the URL comes from the backend, why no token
 * goes in it, and why the postMessage handshake is answered anyway - is in
 * EmbeddedServiceFrame.
 */
export default function TestImplementationsPage() {
  const integrationsApi = useIntegrationsApi()

  return (
    <EmbeddedServiceFrame
      title="QuixLab"
      fetchUrl={integrationsApi.getQuixlabUrl}
      notConfiguredMessage="QuixLab is not configured. Set QUIXLAB_URL on the backend deployment."
    />
  )
}
