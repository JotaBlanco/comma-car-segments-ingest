"use client"

import { EmbeddedServiceFrame } from "@/components/integrations/embedded-service-frame"
import { useIntegrationsApi } from "@/lib/hooks/use-api"

/**
 * Measurements — frames Grafana, which charts the decoded signals.
 *
 * Grafana reads the Lakehouse Query API, so this is the visualisation of what
 * the sink wrote. The Lakehouse page is the other half: the table-and-partition
 * browser showing what physically landed. Charts here, structure there.
 *
 * This page previously framed a query-builder UI in a different workspace's
 * warehouse, which never held this pipeline's data and so always read as empty.
 */
export default function MeasurementsPage() {
  const integrationsApi = useIntegrationsApi()

  return (
    <EmbeddedServiceFrame
      title="Measurements"
      fetchUrl={integrationsApi.getMeasurementsUrl}
      notConfiguredMessage="Measurements is not configured. Set MEASUREMENTS_URL on the backend deployment."
    />
  )
}
