"""A test definition run as a QuixLab headless Job: the start answer and the poll answer."""

from typing import Literal

from api.models.common import ApiModel
from api.models.results import VerdictOut


class DefinitionRunJob(ApiModel):
    """The Job the Portal accepted, or the one already going on this pair."""

    id: str
    name: str
    status: str


class DefinitionRunResult(ApiModel):
    """Where a definition run stands. `state` follows the exit code, never `status` alone.

    `id` is the Job's deployment id, None once the Job was deleted after its verdict was
    recorded. `result_id` and `verdict` name the stored `processed_results` document.
    `error` is QuixLab's first failure, or why no verdict could be read.
    """

    id: str | None = None
    name: str
    state: Literal["running", "finished", "failed"]
    status: str = ""
    exit_code: int | None = None
    quixlab_run_id: str | None = None
    error: str | None = None
    result_id: str | None = None
    verdict: VerdictOut | None = None
