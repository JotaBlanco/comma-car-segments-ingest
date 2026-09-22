"""Integration models. One shape today: where QuixLab answers.

Three fields carry the address, and all three come from the same proved value:

- `url` is the site root. The new-tab controls open it.
- `embed_url` is the same root plus the one query QuixLab reads on an embedded
  page, so the iframe `src` needs no string work in the browser.
- `origin` is the `scheme://host[:port]` the parent uses as the `targetOrigin`
  of every `postMessage`, and compares `event.origin` against on every message
  it receives.

No field carries a run id. The run id travels on a `TM_IMPORT` message, in
memory, after the frame proves a session. It never rides a URL, and neither
does a token.
"""

from pydantic import Field

from api.models.common import ApiModel, RequestModel, UtcDatetime


class QuixLabUrl(ApiModel):
    """Answer of GET /integrations/quixlab-url.

    `url` and `origin` carry no query, no fragment and no credential of any
    kind. `embed_url` carries exactly one query, `isIframe=true`, and never a
    credential. A caller that wants a deep link appends it to `url` itself.
    """

    url: str
    embed_url: str
    origin: str


class FlightTestStationUrl(ApiModel):
    """Answer of GET /integrations/fts-url.

    `url` is the station's site root, with no query, no fragment and no
    credential, so a caller can append the station's entry parameters
    (`?run=&signal=&t=&sel=`). `origin` is the `scheme://host[:port]` the
    parent posts the auth token to and compares `event.origin` against.
    """

    url: str
    origin: str


class LakehouseUrl(ApiModel):
    """Answer of GET /integrations/lakehouse-url.

    `url` is the Portal's own Lakehouse page for this workspace:
    `{portalWeb}/lakehouse?workspace={workspaceId}`. That page resolves the
    Lakehouse itself, so no deployment id rides here. An empty string means the
    API derives no Portal web host or knows no workspace, and the front end
    then shows no Lakehouse link. It carries no credential: a workspace id is
    not a secret.
    """

    url: str


class QuixLabInstance(ApiModel):
    """One row of the QuixLab dropdown.

    `kind` is the field a person reads before they pick. `"deployment"` is
    shared and stable. `"devsession"` belongs to one person and it stops, so it
    is not a place to send a colleague. A list that hid the difference would
    invite exactly that mistake.

    `status` is the Portal's own word, passed through unchanged. The front end
    decides what to grey out; this API does not invent a state machine.

    The three URL fields mean what they mean on `QuixLabUrl`, and they carry no
    credential for the same reason.

    `portal_embedded_url` is the Portal page that frames this instance:
    `/pipeline/deployments/{deploymentId}/embedded?workspace={workspaceId}`.
    A launch control opens THAT, so a person lands inside the Portal and not on
    the raw deployment host. It is empty for a dev session, which has no
    deployment id, and empty when the API could not derive the Portal web host.
    An empty value means "open `url`", which is what every control did before.
    It carries no credential either: a deployment id and a workspace id are not
    secrets.
    """

    id: str
    name: str
    kind: str
    status: str
    url: str
    embed_url: str
    origin: str
    portal_embedded_url: str = ""


class QuixLabList(ApiModel):
    """Answer of GET /integrations/quixlabs.

    An empty `items` is an ordinary answer, not a fault. It means this
    deployment cannot ask the Portal, or the workspace holds no QuixLab. The
    caller falls back to `GET /integrations/quixlab-url`.
    """

    items: list[QuixLabInstance]


class RunQuixLab(ApiModel):
    """One person's lab on one notebook, as the notebook routes answer it.

    `status` is the Portal's own word, passed through unchanged, so the front
    end can wait for a lab that is still building without this API inventing a
    state machine. A lab the Portal has just accepted usually reads as building
    or queued, and `url` is already its address: the page exists before the
    container answers on it.

    `created` is true only when THIS call made the deployment. A second click,
    or a reload while the first one builds, answers the same lab with `false`,
    which is how a caller can tell "yours, already running" from "just spun up
    for you, give it a moment".

    `notebook` is the `blob://` pointer the lab opens, and it names the notebook's
    own folder under the run. It carries no credential: a bucket-relative path is
    not one.
    """

    id: str
    name: str
    status: str
    url: str
    notebook: str
    created: bool = False


class Notebook(ApiModel):
    """One QuixLab notebook of a run: a file in its own blob folder, and the lab that opens it.

    A run holds any number of these. `lab` is this viewer's lab for the notebook when the
    Portal knows one - absent for a notebook nobody has opened from this deployment yet, and
    stopped once it was saved and closed. `saved_at` is the last Save and Close; None until
    the first.
    """

    notebook_id: str = Field(validation_alias="_id")
    run_id: str
    name: str
    created_by: str
    created_at: UtcDatetime
    saved_at: UtcDatetime | None = None
    lab: RunQuixLab | None = None


class NotebookCreateRequest(RequestModel):
    """Body of POST /test-runs/{run_id}/notebooks. Every field optional."""

    name: str | None = None
