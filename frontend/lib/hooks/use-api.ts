"use client"

/**
 * Authenticated API Client Hooks - MAIN ENTRY POINT
 *
 * This is the recommended way to use all API clients in this application.
 * These hooks automatically inject authentication tokens and handle token refresh.
 *
 * WHY USE THESE HOOKS:
 * - ✅ Clean, simple API - no manual token passing
 * - ✅ Automatic token refresh on 401/403 errors
 * - ✅ Type-safe with full IntelliSense support
 * - ✅ Consistent pattern across the entire codebase
 *
 * USAGE:
 * ```typescript
 * import { useDacsApi, useTestsApi } from "@/lib/hooks/use-api"
 *
 * function MyComponent() {
 *   const dacsApi = useDacsApi()
 *   const testsApi = useTestsApi()
 *
 *   // Use directly - auth is automatic!
 *   const dacs = await dacsApi.list(params)
 *   const tests = await testsApi.list(query)
 * }
 * ```
 *
 * DO NOT import raw API clients from @/lib/api/* directly.
 * Always use these hooks instead.
 */

import { useMemo } from "react"
import { useQuixAuth } from "../contexts/quix-auth-context"
import { devicesApi as devicesApiRaw } from "../api/devices"
import { testsApi as testsApiRaw } from "../api/tests"
import { lookupsApi as lookupsApiRaw } from "../api/lookups"
import { linksApi as linksApiRaw } from "../api/links"
import { logbookApi as logbookApiRaw } from "../api/logbook"
import { filesApi as filesApiRaw } from "../api/files"
import { adminApi as adminApiRaw } from "../api/admin"
import { integrationsApi as integrationsApiRaw } from "../api/integrations"
import { vmRequirementsApi as vmRequirementsApiRaw } from "../api/vm-requirements"
import { vmTestSpecsApi as vmTestSpecsApiRaw } from "../api/vm-test-specs"

/**
 * Generic helper to create an authenticated API client hook
 */
function createAuthenticatedApi<T extends Record<string, (...args: any[]) => any>>(
  api: T
) {
  return function useAuthenticatedApiHook() {
    const { token, refreshToken } = useQuixAuth()

    // Memoize the authenticated API object to prevent infinite re-renders
    // Only recreate when token or refreshToken changes
    const authenticatedApi = useMemo(() => {
      const apiObj = {} as {
        [K in keyof T]: (...args: Parameters<T[K]> extends [...infer P, any, any] ? P : Parameters<T[K]>) => ReturnType<T[K]>
      }

      for (const key in api) {
        const originalFn = api[key]
        // @ts-ignore - Dynamic function wrapping
        apiObj[key] = (...args: any[]) => {
          return originalFn(...args, token, refreshToken)
        }
      }

      return apiObj
    }, [token, refreshToken])

    return authenticatedApi
  }
}

/**
 * Authenticated Devices API Hook
 *
 * @example
 * ```typescript
 * const devicesApi = useDevicesApi()
 * const devices = await devicesApi.list({ status: "active" })
 * const device = await devicesApi.get("DEV-001")
 * ```
 */
export const useDevicesApi = createAuthenticatedApi(devicesApiRaw)

/**
 * Authenticated Tests API Hook
 *
 * @example
 * ```typescript
 * const testsApi = useTestsApi()
 * const tests = await testsApi.list({ status: "in_progress" })
 * const test = await testsApi.get("test-123")
 * ```
 */
export const useTestsApi = createAuthenticatedApi(testsApiRaw)

/**
 * Authenticated Lookups API Hook
 *
 * @example
 * ```typescript
 * const lookupsApi = useLookupsApi()
 * const sampleTypes = await lookupsApi.getSampleTypes()
 * const locations = await lookupsApi.getLocations()
 * ```
 */
export const useLookupsApi = createAuthenticatedApi(lookupsApiRaw)

/**
 * Authenticated Links API Hook
 *
 * @example
 * ```typescript
 * const linksApi = useLinksApi()
 * const links = await linksApi.list("test-123")
 * await linksApi.create("test-123", { title: "Spec", url: "..." })
 * ```
 */
export const useLinksApi = createAuthenticatedApi(linksApiRaw)

/**
 * Authenticated Logbook API Hook
 *
 * @example
 * ```typescript
 * const logbookApi = useLogbookApi()
 * const entries = await logbookApi.list("test-123")
 * await logbookApi.create("test-123", { content: "Test started" })
 * ```
 */
export const useLogbookApi = createAuthenticatedApi(logbookApiRaw)

/**
 * Authenticated Files API Hook
 *
 * @example
 * ```typescript
 * const filesApi = useFilesApi()
 * const files = await filesApi.list("test-123")
 * const { url } = await filesApi.getPresignedUploadUrl("test-123", "data.csv")
 * ```
 */
export const useFilesApi = createAuthenticatedApi(filesApiRaw)

/**
 * Authenticated Admin API Hook
 *
 * @example
 * ```typescript
 * const adminApi = useAdminApi()
 * await adminApi.seedTestData({ num_dacs: 10, num_tests: 20 })
 * ```
 */
export const useAdminApi = createAuthenticatedApi(adminApiRaw)

/**
 * Authenticated Integrations API Hook
 *
 * @example
 * ```typescript
 * const integrationsApi = useIntegrationsApi()
 * const { url } = await integrationsApi.getConfigManagerUrl("test-123")
 * ```
 */
export const useIntegrationsApi = createAuthenticatedApi(integrationsApiRaw)

/**
 * Authenticated V-model Requirements API Hook
 *
 * @example
 * ```typescript
 * const vmRequirementsApi = useVmRequirementsApi()
 * const page = await vmRequirementsApi.list({ page_size: 500 })
 * const detail = await vmRequirementsApi.get("ACC-SYS-PRF-020@v0003")
 * ```
 */
export const useVmRequirementsApi = createAuthenticatedApi(vmRequirementsApiRaw)

/**
 * Authenticated V-model Test Specifications API Hook
 *
 * @example
 * ```typescript
 * const vmTestSpecsApi = useVmTestSpecsApi()
 * const page = await vmTestSpecsApi.list({ page_size: 200 })
 * ```
 */
export const useVmTestSpecsApi = createAuthenticatedApi(vmTestSpecsApiRaw)
