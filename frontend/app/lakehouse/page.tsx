"use client"

import { EmbeddedServiceFrame } from "@/components/integrations/embedded-service-frame"
import { useIntegrationsApi } from "@/lib/hooks/use-api"

/**
 * Lakehouse — frames the Quix Lakehouse tables-and-partitions browser.
 *
 * This is where the decoded signals actually land, so it is the end of the
 * ingestion chain the Test Run reads from. Distinct from the Lakehouse Query API
 * (`Quix__Lakehouse__Query__Url`), which the evaluation uses and which has no UI.
 */
export default function LakehousePage() {
  const integrationsApi = useIntegrationsApi()

  return (
    <EmbeddedServiceFrame
      title="Lakehouse"
      fetchUrl={integrationsApi.getLakehouseUrl}
      notConfiguredMessage="The Lakehouse UI is not configured. Set LAKEHOUSE_UI_URL on the backend deployment."
    />
  )
}
