from functools import lru_cache
import secrets

from pydantic import Field, computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict


class MongoSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MONGO_")

    user: str = Field(..., description="MongoDB username")
    password: str = Field(..., description="MongoDB password")
    host: str = Field("localhost", description="MongoDB host address")
    port: int = Field(27017, description="MongoDB port")
    database: str = Field("test_manager", description="MongoDB database name")

    @computed_field  # type: ignore[prop-decorator]
    @property
    def url(self) -> str:
        return f"mongodb://{self.user}:{self.password}@{self.host}:{self.port}"


class InfluxSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="INFLUXDB_")

    user: str | None = Field(
        None, description="InfluxDB username; unset disables logbook mirroring"
    )
    password: str | None = Field(
        None, description="InfluxDB password; unset disables logbook mirroring"
    )
    host: str = Field("localhost", description="InfluxDB host address")
    port: int = Field(8086, description="InfluxDB port")
    database: str = Field("test_manager", description="InfluxDB database name")
    measurement: str = Field("logbook", description="InfluxDB measurement name")

    @computed_field  # type: ignore[prop-decorator]
    @property
    def enabled(self) -> bool:
        """Whether the logbook mirror should connect at all.

        InfluxDB is a write-only mirror of the logbook - every read path uses
        MongoDB - so missing credentials must degrade to a no-op rather than
        block application startup.
        """
        return bool(self.user and self.password)


class Settings(BaseSettings):
    # API settings
    api_host: str = Field("0.0.0.0", description="Host address")
    api_port: int = Field(8080, description="Port number")
    api_workers: int = Field(1, description="Number of workers")

    # TODO: Remove this to enforce authentication
    api_auth_active: bool = Field(
        True, description="Whether API authentication is active"
    )

    # Quix settings
    workspace_id: str = Field(
        alias="Quix__Workspace__Id", description="Quix workspace ID"
    )
    sdk_token: str = Field(alias="Quix__Sdk__Token", description="SDK token")

    # Blob storage settings
    secret_key: str = Field(
        default_factory=lambda: secrets.token_hex(32),
        description="Secret key for signing URLs",
    )
    file_signature_expiration_seconds: int = Field(
        30, description="File upload signature expiration time in seconds"
    )

    # Configuration API settings
    config_api_url: str = Field(..., description="Configuration API URL")

    # Integration services URLs
    measurements_url: str | None = Field(
        None, description="Measurements/Query Builder service URL"
    )
    analytics_url: str | None = Field(
        None, description="Analytics/Notebook service URL"
    )
    quixlab_url: str | None = Field(
        None, description="QuixLab public URL; the Test Implementation page frames it"
    )
    mf4_import_url: str | None = Field(
        None,
        description=(
            "MF4 Import public URL; the File Import page frames it so uploads happen "
            "inside Test Manager instead of on a separate tab"
        ),
    )
    lakehouse_ui_url: str | None = Field(
        None,
        description=(
            "Quix Lakehouse UI URL, framed by the Lakehouse page. Distinct from "
            "lakehouse_query_url below, which is the Query API the evaluation reads "
            "signals from - this one is the tables-and-partitions browser."
        ),
    )
    data_lake_workspace_id: str | None = Field(
        None, description="Data Lake workspace ID (defaults to workspace_id if not set)"
    )
    data_lake_v2_topic_name: str | None = Field(
        None, description="DataLake v2 Sink topic/table name for test measurements"
    )
    lakehouse_query_url: str | None = Field(
        None,
        alias="Quix__Lakehouse__Query__Url",
        description=(
            "Lakehouse Query API base URL, injected by the platform. Test Run execution "
            "reads decoded MF4 signals from it; when it is unset - local development, "
            "where the platform injects nothing - evaluation falls back to the committed "
            "signal fixture instead of failing."
        ),
    )

    # Nested settings
    mongo: MongoSettings = Field(default_factory=MongoSettings)  # type: ignore[arg-type]
    influx: InfluxSettings = Field(default_factory=InfluxSettings)  # type: ignore[arg-type]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
