"""
Integrations routes for external services
"""

import httpx
import logging
import os
from urllib.parse import quote
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

from ..auth import read_permission
from ..settings import get_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/integrations", tags=["integrations"])


class ConfigManagerUrl(BaseModel):
    """Configuration Manager URL response"""

    url: str


@router.get("/config-manager-url", response_model=ConfigManagerUrl)
async def get_config_manager_url(
    stream_id: str | None = Query(None, description="Optional stream_id for context-aware filtering"),
    authorization: str = Header(...),
    _auth: None = Depends(read_permission),
) -> ConfigManagerUrl:
    """
    Get Portal-embedded URL for Configuration Manager.

    Returns a URL that opens Configuration Manager in Portal's embedded view.
    If stream_id is provided, it will be appended as a query parameter for
    context-aware filtering.

    Args:
        stream_id: Optional test ID to filter configurations
        authorization: Bearer token from request header

    Returns:
        ConfigManagerUrl with the Portal embedded URL
    """
    # Get Portal API URL and workspace ID
    portal_api_url = os.getenv("Quix__Portal__Api")
    settings = get_settings()
    workspace_id = settings.workspace_id

    if not portal_api_url or not workspace_id:
        # Local development fallback
        # Return a mock URL for local testing
        base_url = "http://localhost:8001"
        if stream_id:
            base_url += f"?stream_id={stream_id}"
        return ConfigManagerUrl(url=base_url)

    # Extract token from Authorization header
    if authorization.startswith(("bearer ", "Bearer ")):
        token = authorization[7:]
    else:
        token = authorization

    try:
        # Query Portal API for deployments
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{portal_api_url}/workspaces/{workspace_id}/deployments",
                headers={
                    "Authorization": f"Bearer {token}",
                    "X-Version": "2.0",
                    "Content-Type": "application/json",
                },
                timeout=10.0,
            )

            if not response.is_success:
                raise HTTPException(
                    status_code=response.status_code,
                    detail=f"Portal API error: {response.status_code}",
                )

            deployments = response.json()

            # Find Dynamic Configuration Manager deployment
            config_manager = next(
                (d for d in deployments if d.get("name") == "Dynamic Configuration Manager"),
                None,
            )

            if not config_manager:
                raise HTTPException(
                    status_code=404,
                    detail="Dynamic Configuration Manager deployment not found",
                )

            deployment_id = config_manager.get("deploymentId")
            if not deployment_id:
                raise HTTPException(
                    status_code=500,
                    detail="Deployment ID not found in response",
                )

            # Build Portal embedded URL
            portal_url = f"https://portal.cloud.quix.io/pipeline/deployments/{deployment_id}/embedded?workspace={workspace_id}"

            # Append stream_id if provided
            if stream_id:
                portal_url += f"&stream_id={stream_id}"

            return ConfigManagerUrl(url=portal_url)

    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Portal API timeout")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=500, detail=f"Portal API error: {str(e)}")


@router.get("/config-manager-frontend-url", response_model=ConfigManagerUrl)
async def get_config_manager_frontend_url(
    config_id: str | None = Query(None, description="Optional config ID for context-aware filtering"),
    config_version: int | None = Query(None, description="Optional config version"),
    authorization: str = Header(...),
    _auth: None = Depends(read_permission),
) -> ConfigManagerUrl:
    """
    Get direct frontend URL for Configuration Manager (for iframe embedding).

    Returns the direct frontend URL from plugin.embeddedViewUrl.
    If config_id and config_version are provided, appends the details path.

    Args:
        config_id: Optional configuration ID to view specific config
        config_version: Optional configuration version
        authorization: Bearer token from request header

    Returns:
        ConfigManagerUrl with the direct frontend URL
    """
    # Get Portal API URL and workspace ID
    portal_api_url = os.getenv("Quix__Portal__Api")
    settings = get_settings()
    workspace_id = settings.workspace_id

    if not portal_api_url or not workspace_id:
        # Local development fallback
        base_url = "http://localhost:8001"
        if config_id and config_version is not None:
            base_url += f"/details/{config_id}?version={config_version}"
        return ConfigManagerUrl(url=base_url)

    # Extract token from Authorization header
    if authorization.startswith(("bearer ", "Bearer ")):
        token = authorization[7:]
    else:
        token = authorization

    try:
        # Query Portal API for deployments
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{portal_api_url}/workspaces/{workspace_id}/deployments",
                headers={
                    "Authorization": f"Bearer {token}",
                    "X-Version": "2.0",
                    "Content-Type": "application/json",
                },
                timeout=10.0,
            )

            if not response.is_success:
                raise HTTPException(
                    status_code=response.status_code,
                    detail=f"Portal API error: {response.status_code}",
                )

            deployments = response.json()

            # Find Dynamic Configuration Manager deployment
            config_manager = next(
                (d for d in deployments if d.get("name") == "Dynamic Configuration Manager"),
                None,
            )

            if not config_manager:
                raise HTTPException(
                    status_code=404,
                    detail="Dynamic Configuration Manager deployment not found",
                )

            # Get the direct frontend URL from plugin.embeddedViewUrl
            frontend_url = config_manager.get("plugin", {}).get("embeddedViewUrl")
            if not frontend_url:
                raise HTTPException(
                    status_code=500,
                    detail="Frontend URL (plugin.embeddedViewUrl) not found in deployment",
                )

            # Append context path if config_id provided
            if config_id and config_version is not None:
                frontend_url += f"/details/{config_id}?version={config_version}"

            return ConfigManagerUrl(url=frontend_url)

    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Portal API timeout")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=500, detail=f"Portal API error: {str(e)}")


@router.get("/data-lake-url", response_model=ConfigManagerUrl)
async def get_data_lake_url(
    test_id: str | None = Query(None, description="Optional test ID for filtering"),
    _auth: None = Depends(read_permission),
) -> ConfigManagerUrl:
    """
    Get Data Lake Explorer URL.

    Returns Portal Data Explorer URL with optional test_id filter.
    Opens in new tab/window.
    """
    settings = get_settings()
    workspace_id = settings.data_lake_workspace_id or settings.workspace_id

    # Build Portal Data Explorer URL
    url = f"https://portal.cloud.quix.io/data?workspace={workspace_id}"

    # Add test_id filter if provided
    if test_id:
        url += f"&key={test_id}"

    return ConfigManagerUrl(url=url)


@router.get("/measurements-url", response_model=ConfigManagerUrl)
async def get_measurements_url(
    test_id: str | None = Query(None, description="Test ID for SQL filter"),
    campaign_id: str | None = Query(None, description="Campaign ID for SQL filter"),
    environment_id: str | None = Query(None, description="Environment ID for SQL filter"),
    _auth: None = Depends(read_permission),
) -> ConfigManagerUrl:
    """
    Get Measurements/Query Builder URL.

    Returns Query Builder URL with pre-filled SQL query and authentication token.
    SQL query filters by test context (campaign_id, environment_id, test_id).
    """
    settings = get_settings()

    # Check if measurements URL is configured
    if not settings.measurements_url:
        raise HTTPException(
            status_code=501,
            detail="Measurements service not configured. Set MEASUREMENTS_URL environment variable."
        )

    # Check if DataLake table name is configured
    if not settings.data_lake_v2_topic_name:
        raise HTTPException(
            status_code=501,
            detail="DataLake table not configured. Set DATA_LAKE_V2_TOPIC_NAME environment variable."
        )

    # Build SQL query with filters
    sql_parts = [f"SELECT * FROM {settings.data_lake_v2_topic_name} WHERE 1=1"]
    if campaign_id:
        sql_parts.append(f"AND campaign_id = '{campaign_id}'")
    if environment_id:
        sql_parts.append(f"AND environment_id = '{environment_id}'")
    if test_id:
        sql_parts.append(f"AND test_id = '{test_id}'")
    sql_parts.append("LIMIT 100")

    sql_query = " ".join(sql_parts)
    encoded_sql = quote(sql_query)

    # Build URL with token and SQL
    url = f"{settings.measurements_url}?token={settings.sdk_token}&sql={encoded_sql}"

    # Add autorun only if test_id exists (contextual mode)
    if test_id:
        url += "&autorun=true"

    return ConfigManagerUrl(url=url)


@router.get("/analytics-url", response_model=ConfigManagerUrl)
async def get_analytics_url(
    test_id: str | None = Query(None, description="Test ID for context"),
    campaign_id: str | None = Query(None, description="Campaign ID for context"),
    environment_id: str | None = Query(None, description="Environment ID for context"),
    _auth: None = Depends(read_permission),
) -> ConfigManagerUrl:
    """
    Get Analytics/Notebook URL.

    Returns Notebook URL with authentication token and test context parameters.
    """
    settings = get_settings()

    # Check if analytics URL is configured
    if not settings.analytics_url:
        raise HTTPException(
            status_code=501,
            detail="Analytics service not configured. Set ANALYTICS_URL environment variable."
        )

    # Build URL with token and context parameters
    url = f"{settings.analytics_url}?token={settings.sdk_token}"

    if campaign_id:
        url += f"&campaign_id={campaign_id}"
    if environment_id:
        url += f"&environment_id={environment_id}"
    if test_id:
        url += f"&test_id={test_id}"

    return ConfigManagerUrl(url=url)


@router.get("/download-test-data")
async def download_test_data(
    test_id: str | None = Query(None, description="Test ID for filtering"),
    campaign_id: str | None = Query(None, description="Campaign ID for filtering"),
    environment_id: str | None = Query(None, description="Environment ID for filtering"),
    _auth: None = Depends(read_permission),
):
    """
    Download test measurement data from DataLake.

    Queries the Quix Lake Query API with SQL filter and returns raw JSON data.
    Frontend will convert to CSV format.
    """
    settings = get_settings()

    # Check if measurements URL is configured
    if not settings.measurements_url:
        raise HTTPException(
            status_code=501,
            detail="Measurements service not configured. Set MEASUREMENTS_URL environment variable."
        )

    # Check if DataLake table name is configured
    if not settings.data_lake_v2_topic_name:
        raise HTTPException(
            status_code=501,
            detail="DataLake table not configured. Set DATA_LAKE_V2_TOPIC_NAME environment variable."
        )

    # Build SQL query with filters
    sql_parts = [f"SELECT * FROM {settings.data_lake_v2_topic_name} WHERE 1=1"]
    if campaign_id:
        sql_parts.append(f"AND campaign_id = '{campaign_id}'")
    if environment_id:
        sql_parts.append(f"AND environment_id = '{environment_id}'")
    if test_id:
        sql_parts.append(f"AND test_id = '{test_id}'")

    sql_query = " ".join(sql_parts)

    # Query the Quix Lake Query API
    try:
        async with httpx.AsyncClient() as client:
            logger.info(f"Querying Quix Lake API: {settings.measurements_url}/api/query")
            logger.info(f"SQL Query: {sql_query}")

            response = await client.post(
                f"{settings.measurements_url}/api/query",
                content=sql_query,
                headers={
                    "Authorization": f"Bearer {settings.sdk_token}",
                    "Content-Type": "text/plain",
                },
                timeout=30.0,
            )

            # Log response details for debugging
            logger.info(f"Response status: {response.status_code}")
            logger.info(f"Response headers: {dict(response.headers)}")
            logger.info(f"Response content-type: {response.headers.get('content-type', 'not set')}")
            logger.info(f"Response body length: {len(response.content)}")
            logger.info(f"Response body (first 500 chars): {response.text[:500]}")

            if not response.is_success:
                raise HTTPException(
                    status_code=response.status_code,
                    detail=f"Query API error: {response.status_code} - {response.text}",
                )

            # Return CSV data directly (Quix Lake Query API returns CSV format)
            csv_data = response.text

            # Return empty response if no data
            if not csv_data or csv_data.strip() == "":
                logger.warning("Received empty response from Query API")
                return Response(content="", media_type="text/csv")

            logger.info(f"Returning CSV data with {len(csv_data)} characters")
            return Response(content=csv_data, media_type="text/csv")

    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Query API timeout")
    except httpx.HTTPError as e:
        logger.error(f"HTTP error querying Quix Lake API: {e}")
        raise HTTPException(status_code=500, detail=f"Query API error: {str(e)}")

@router.get("/quixlab-url", response_model=ConfigManagerUrl)
async def get_quixlab_url(
    _auth: None = Depends(read_permission),
) -> ConfigManagerUrl:
    """
    Get the QuixLab URL for the Test Implementation page.

    Served from the backend rather than a NEXT_PUBLIC_* build arg because the
    frontend image is built once and deployed with runtime variables: a
    NEXT_PUBLIC value is inlined at build time and would be undefined here.

    No token is appended. QuixLab is gated at the Quix ingress, which rejects
    PATs and SDK tokens on every path and wants a portal session cookie instead,
    so a token in the URL buys nothing and would only leak into history and
    referrer headers.
    """
    settings = get_settings()

    if not settings.quixlab_url:
        raise HTTPException(
            status_code=501,
            detail="QuixLab not configured. Set QUIXLAB_URL environment variable.",
        )

    return ConfigManagerUrl(url=settings.quixlab_url)


@router.get("/mf4-import-url", response_model=ConfigManagerUrl)
async def get_mf4_import_url(
    _auth: None = Depends(read_permission),
) -> ConfigManagerUrl:
    """Get the MF4 Import URL for the File Import page.

    Same contract as quixlab-url: served from the backend because a NEXT_PUBLIC_*
    value would be inlined at frontend build time and undefined at runtime, and no
    token is appended because the service is gated at the Quix ingress, which wants
    a portal session cookie rather than a PAT.
    """
    settings = get_settings()

    if not settings.mf4_import_url:
        raise HTTPException(
            status_code=501,
            detail="MF4 Import not configured. Set MF4_IMPORT_URL environment variable.",
        )

    return ConfigManagerUrl(url=settings.mf4_import_url)


@router.get("/lakehouse-url", response_model=ConfigManagerUrl)
async def get_lakehouse_url(
    _auth: None = Depends(read_permission),
) -> ConfigManagerUrl:
    """Get the Lakehouse UI URL for the Lakehouse page.

    This is the tables-and-partitions browser, not ``Quix__Lakehouse__Query__Url``:
    that one is the Query API the Test Run evaluation reads decoded signals from and
    is injected by the platform, whereas this is a UI address nothing injects.
    """
    settings = get_settings()

    if not settings.lakehouse_ui_url:
        raise HTTPException(
            status_code=501,
            detail="Lakehouse UI not configured. Set LAKEHOUSE_UI_URL environment variable.",
        )

    return ConfigManagerUrl(url=settings.lakehouse_ui_url)
