"use client"

import { EmbeddedServiceFrame } from "@/components/integrations/embedded-service-frame"
import { useIntegrationsApi } from "@/lib/hooks/use-api"

/**
 * File Import — frames the MF4 Import service.
 *
 * Uploading a recording used to mean leaving Test Manager for the MF4 Import tab
 * in the Quix portal, which broke the chain the rest of the app is built around:
 * a file arrives, the decoder resolves its CAN database from DCM, and the signals
 * land in the lake for a Test Run to evaluate. Framing it keeps that first step
 * inside the same window as the four that follow it.
 */
export default function FileImportPage() {
  const integrationsApi = useIntegrationsApi()

  return (
    <EmbeddedServiceFrame
      title="File Import"
      fetchUrl={integrationsApi.getMf4ImportUrl}
      notConfiguredMessage="MF4 Import is not configured. Set MF4_IMPORT_URL on the backend deployment."
    />
  )
}
