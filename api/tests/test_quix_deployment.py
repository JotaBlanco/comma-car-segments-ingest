"""Guards for the Quix deployment files. This file is UTF-8.

Three files deploy this system: `quix.yaml` at the repository root, `api/app.yaml`
and `frontend/app.yaml`. Two faults hide in such a file, and both stay silent:

1. The file names a variable no code reads. The platform sets it, nothing reads
   it, and the person who wrote it believes the system is configured.
2. The code needs a variable the file never names. The deployment starts, the
   first request fails, and the log names no file.

These tests read every file as text. No test here needs Docker, a network, a
cluster or a YAML library. PyYAML is a transitive dependency only, so an import
of it would break this file on a clean install.
"""

import pytest

pytest.skip(
    "The demo repo maintains quix.yaml as an OVERLAY with its own estate "
    "(test bench, importer, decoder, stats, sink, connector, Planning Sync "
    "Mock) and its own law, tests/test_architecture_law.py in the root "
    "suite. This suite describes upstream s descriptor, not the overlay.",
    allow_module_level=True,
)

import re
from pathlib import Path

import pytest

from api.services import ai_client, lake

REPO_ROOT = Path(__file__).resolve().parents[2]

QUIX_PATH = REPO_ROOT / "quix.yaml"
API_APP_PATH = REPO_ROOT / "api" / "app.yaml"
FRONTEND_APP_PATH = REPO_ROOT / "frontend" / "app.yaml"
API_DOCKERFILE_PATH = REPO_ROOT / "api" / "Dockerfile"
FRONTEND_DOCKERFILE_PATH = REPO_ROOT / "frontend" / "dockerfile"

# The three files that name variables. Every name rule below reads all three.
VARIABLE_FILES = {
    "quix.yaml": QUIX_PATH,
    "api/app.yaml": API_APP_PATH,
    "frontend/app.yaml": FRONTEND_APP_PATH,
}

# The lake names come from the code, never from a literal here. A rename in
# `api/api/services/lake.py` must move this file with it.
LAKE_URL_VAR = lake._URL_VARS[0]
LAKE_TOKEN_VAR = lake._TOKEN_VARS[0]


def _read(path: Path) -> str:
    assert path.is_file(), f"{path} is missing, so the deployment cannot build"
    return path.read_text(encoding="utf-8")


def _code_lines(path: Path) -> list[str]:
    """Return one file with every comment line removed.

    A comment sets no variable. `quix.yaml` names the platform-injected
    variables in its comments on purpose, so a raw text search would read a
    warning as a declaration.
    """
    return [
        line for line in _read(path).splitlines() if not line.strip().startswith("#")
    ]


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip())


def _value(lines: list[str], key: str) -> str:
    """Read the value of the first `key:` line of a block. Empty means absent.

    A list item starts with `- `, so this drops that marker first. `defaultValue:`
    never matches the key `value`, because the match starts at the first letter.
    """
    for line in lines:
        stripped = line.strip().removeprefix("- ")
        if stripped.startswith(f"{key}:"):
            return stripped.partition(":")[2].strip()
    return ""


def _sub_block(lines: list[str], key: str) -> list[str]:
    """Return the lines nested under one `key:` line. Empty means absent."""
    for index, line in enumerate(lines):
        if line.strip() != f"{key}:":
            continue
        base = _indent(line)
        nested = []
        for candidate in lines[index + 1 :]:
            if not candidate.strip():
                continue
            if _indent(candidate) <= base:
                break
            nested.append(candidate)
        return nested
    return []


def _deployment_blocks() -> dict[str, list[str]]:
    """Return every deployment of `quix.yaml`, mapped from its name.

    A deployment starts at a `  - ` line under `deployments:`. It ends at the
    next such line, or at the next top-level key.
    """
    lines = _code_lines(QUIX_PATH)
    start = lines.index("deployments:")
    blocks: dict[str, list[str]] = {}
    current: list[str] | None = None
    for line in lines[start + 1 :]:
        if line.strip() and not line.startswith(" "):
            break
        if line.startswith("  - "):
            current = [line]
            blocks[line.partition("name:")[2].strip()] = current
        elif current is not None:
            current.append(line)
    return blocks


def _variable_blocks(lines: list[str]) -> list[list[str]]:
    """Return every variable under every `variables:` key of some lines.

    A variable starts at a `- name:` line. A key at a smaller indent closes the
    whole list, so `plugin:` and the next deployment both end it.
    """
    blocks: list[list[str]] = []
    current: list[str] | None = None
    item_indent = -1
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped == "variables:":
            item_indent = _indent(line) + 2
            current = None
            continue
        if item_indent < 0:
            continue
        if _indent(line) < item_indent:
            item_indent = -1
            current = None
            continue
        if stripped.startswith("- name:"):
            current = [line]
            blocks.append(current)
        elif current is not None:
            current.append(line)
    return blocks


def _declared_names(path: Path) -> set[str]:
    """Return every variable name one file declares."""
    return {_value(block, "name") for block in _variable_blocks(_code_lines(path))}


# --- Every variable name the CODE really reads ---
#
# A name in a deployment file that no code reads is a silent no-op. This scan
# builds the truth from the source, so a rename on either side goes red.

PYTHON_SOURCE_DIRS = (
    REPO_ROOT / "api" / "api",
    REPO_ROOT / "api" / "ingest",
    REPO_ROOT / "api" / "seed",
    REPO_ROOT / "api" / "mock_planning",
)

TYPESCRIPT_SOURCE_DIRS = (
    REPO_ROOT / "frontend" / "app",
    REPO_ROOT / "frontend" / "lib",
    REPO_ROOT / "frontend" / "components",
)

TYPESCRIPT_SOURCE_FILES = (REPO_ROOT / "frontend" / "next.config.ts",)

# A test reads a name our deployment never sets, so this scan skips test trees.
SKIPPED_PARTS = frozenset({"node_modules", "e2e", "tests", "__pycache__"})

# `os.environ.get("NAME")`, `os.getenv("NAME")` and `os.environ["NAME"]`.
_PYTHON_LITERAL_READ = re.compile(
    r"""os\.(?:environ\.get|getenv)\(\s*["']([A-Za-z_]\w*)["']"""
    r"""|os\.environ\[\s*["']([A-Za-z_]\w*)["']"""
)

# `os.environ.get(SOME_CONSTANT, "")`. `api/quix_identity.py:166` reads this way.
_PYTHON_CONSTANT_READ = re.compile(
    r"""os\.(?:environ\.get|getenv)\(\s*([A-Z]\w*)|os\.environ\[\s*([A-Z]\w*)"""
)

# A module-level `SOME_CONSTANT = "NAME"` line.
_PYTHON_CONSTANT = re.compile(r"""(?m)^([A-Z]\w*)\s*=\s*["']([A-Za-z_]\w*)["']\s*$""")

# `process.env.NAME` and `process.env["NAME"]`.
_TYPESCRIPT_READ = re.compile(
    r"""process\.env\.([A-Za-z_]\w*)|process\.env\[\s*["']([A-Za-z_]\w*)["']"""
)

# `${TM_COMMAND:-...}` on api/Dockerfile:29.
_SHELL_READ = re.compile(r"""\$\{([A-Za-z_]\w*)""")


def _first_group(match: re.Match[str]) -> str:
    """Return the one group of an alternation that matched."""
    return next(group for group in match.groups() if group)


def _source_files(directory: Path, suffixes: tuple[str, ...]) -> list[Path]:
    """Return every source file under one directory, minus the skipped trees."""
    return sorted(
        path
        for path in directory.rglob("*")
        if path.suffix in suffixes
        and not SKIPPED_PARTS & set(path.parts)
        and path.is_file()
    )


def _python_names(text: str) -> set[str]:
    """Return every variable name one Python file reads.

    A module may hold the name in a constant. This resolves such a constant
    inside the same file, so an indirect read counts as a read.
    """
    constants = dict(_PYTHON_CONSTANT.findall(text))
    names = {_first_group(match) for match in _PYTHON_LITERAL_READ.finditer(text)}
    for match in _PYTHON_CONSTANT_READ.finditer(text):
        resolved = constants.get(_first_group(match))
        if resolved:
            names.add(resolved)
    return names


def _code_variable_names() -> set[str]:
    """Return every variable name the whole system really reads."""
    names: set[str] = set()
    for directory in PYTHON_SOURCE_DIRS:
        for path in _source_files(directory, (".py",)):
            names |= _python_names(_read(path))
    for directory in TYPESCRIPT_SOURCE_DIRS:
        for path in _source_files(directory, (".ts", ".tsx")):
            names |= {
                _first_group(match) for match in _TYPESCRIPT_READ.finditer(_read(path))
            }
    for path in TYPESCRIPT_SOURCE_FILES:
        names |= {
            _first_group(match) for match in _TYPESCRIPT_READ.finditer(_read(path))
        }
    names |= {
        match.group(1) for match in _SHELL_READ.finditer(_read(API_DOCKERFILE_PATH))
    }
    # The lake client holds its names in two tuples. Import them, never retype them.
    names |= set(lake._URL_VARS) | set(lake._TOKEN_VARS)
    return names


CODE_VARIABLE_NAMES = _code_variable_names()


def test_the_code_scan_finds_every_kind_of_read():
    """A scan that finds nothing would make the dead-name rule pass on nothing.

    One name stands for each source: Python, TypeScript, the Dockerfile and the
    lake tuples. A broken regex drops a whole source and this goes red.
    """
    expected = {
        "MONGO_URL",  # api/api, a literal os.environ.get read
        # `api/ingest/store.py:160` reads `os.environ.get(WORKSPACE_VARIABLE)`,
        # and the constant sits at `:40`. The name appears in no `environ.get`
        # literal anywhere, so only the constant leg can find it. This example
        # read `TM_RUN_KEY_PATTERN` through `api/ingest/mf4.py` until 19 Aug
        # 2026. That module moved to the ingestion pipeline. It then read
        # `TM_QUIX_PORTAL_URL` until later the same day, when `quix_identity.py`
        # took the injected name `Quix__Portal__Api`. `ai_client.py` reads that
        # name as a literal, so it no longer proves the constant leg.
        "Quix__Workspace__Id",  # api/ingest/store.py, a read through a constant
        "TM_BE_URL",  # frontend/next.config.ts, a process.env read
        "TM_COMMAND",  # api/Dockerfile, the ${NAME:-default} read
        LAKE_URL_VAR,  # the lake._URL_VARS tuple
        LAKE_TOKEN_VAR,  # the lake._TOKEN_VARS tuple
    }
    missing = sorted(expected - CODE_VARIABLE_NAMES)

    assert not missing, f"the code scan reads no {missing}, so fix the scan regexes"


def test_the_code_scan_reads_more_than_one_file():
    """A scan of one file would pass the rule below and prove nothing."""
    assert len(CODE_VARIABLE_NAMES) > 10, (
        "the code scan found almost no name, so fix the source directory list"
    )


# --- Rule 1: no dead name ---
#
# A variable that no code reads sets nothing. The platform still ships it, so a
# reader believes the system is configured and the screen still fails.

# The only names our own code never reads. A third-party image reads each one,
# and the comment names that image.
IMAGE_VARIABLES = frozenset(
    {
        "MONGO_INITDB_ROOT_USERNAME",  # the mongo:7 image, its init step
        "MONGO_INITDB_ROOT_PASSWORD",  # the mongo:7 image, its init step
        "NODE_ENV",  # the Next.js runtime
        "NEXT_TELEMETRY_DISABLED",  # the Next.js runtime
    }
)


def _every_declared_name() -> list[tuple[str, str]]:
    """Every (file, variable name) pair of the three deployment files."""
    return sorted(
        (label, name)
        for label, path in VARIABLE_FILES.items()
        for name in _declared_names(path)
    )


def test_the_variable_parse_finds_every_declared_name():
    """A parse that finds nothing would make every name rule pass on nothing."""
    for label, path in VARIABLE_FILES.items():
        declared = _declared_names(path)
        lines = sum(
            1 for line in _code_lines(path) if line.strip().startswith("- name:")
        )

        assert declared, f"the parse reads no variable from {label}, so fix _variable_blocks"
        assert len(declared) <= lines, f"the parse invents a variable in {label}"


def test_the_variable_parse_reads_the_known_frontend_names():
    """This pins the parser to a file a reader can check by eye."""
    assert _declared_names(FRONTEND_APP_PATH) == {
        "API_URL",
        "TM_BE_URL",
        "TM_API_TOKEN",
        "NODE_ENV",
        "NEXT_TELEMETRY_DISABLED",
        "TM_LAKE_TABLE",
    }, "frontend/app.yaml changed, so update this pin or fix _variable_blocks"


@pytest.mark.parametrize("label,name", _every_declared_name())
def test_no_deployment_file_names_a_variable_no_code_reads(label, name):
    """A name no code reads is a silent no-op. It configures nothing."""
    assert name in CODE_VARIABLE_NAMES or name in IMAGE_VARIABLES, (
        f"{label} sets {name}, and no code reads it. It is a silent no-op. "
        f"Delete it, or add it to IMAGE_VARIABLES with the image that reads it."
    )


@pytest.mark.parametrize("name", sorted(IMAGE_VARIABLES))
def test_every_image_variable_is_really_declared_somewhere(name):
    """A stale exemption hides the next dead name behind it."""
    declared = set().union(*(_declared_names(path) for path in VARIABLE_FILES.values()))

    assert name in declared, f"no file names {name}, so drop it from IMAGE_VARIABLES"


# --- Rule 2: no missing name ---
#
# A deployment that misses one name starts, answers the first request with an
# error, and names no file in the log.

REQUIRED_VARIABLES = {
    # No Mongo means no registry. No planning URL means no work orders. No token
    # means every /api/v1 route answers 401. No TM_INGEST_SOURCE means the
    # download route answers 503 on every file.
    # The lake names are ABSENT here on purpose. The platform injects them through
    # the blob bind, so rule 6 below forbids the declaration this rule would need.
    "Test Manager API": frozenset(
        {
            "MONGO_URL",
            "PLANNING_API_URL",
            "TM_API_TOKEN",
            "TM_INGEST_SOURCE",
        }
    ),
    # No API_URL means the proxy calls itself. No TM_BE_URL means the built-in
    # mock answers. No token means every screen answers 401.
    "Test Manager Frontend": frozenset({"API_URL", "TM_BE_URL", "TM_API_TOKEN"}),
    # Without TM_COMMAND this container runs the API duty, not the mock.
    "Test Manager Planning Mock": frozenset({"TM_COMMAND"}),
    # No duty, no database, no API address and no lake means the seed writes nothing.
    "Test Manager Seed": frozenset(
        {
            "TM_COMMAND",
            "MONGO_URL",
            "TM_API_URL",
            "TM_API_TOKEN",
        }
    ),
    # The mongo:7 image starts with no authentication when these two are absent.
    "MongoDB": frozenset({"MONGO_INITDB_ROOT_USERNAME", "MONGO_INITDB_ROOT_PASSWORD"}),
}


def test_the_deployment_parse_finds_every_deployment():
    """A parse that finds nothing would make every deployment rule pass on nothing."""
    found = _deployment_blocks()
    declared = _read(QUIX_PATH).count("\n  - name: ")

    assert len(found) == declared, f"the parse reads {len(found)} of {declared} deployments"
    assert set(found) == set(REQUIRED_VARIABLES), (
        f"quix.yaml holds {sorted(found)}, so update REQUIRED_VARIABLES"
    )


@pytest.mark.parametrize("name", sorted(REQUIRED_VARIABLES))
def test_every_deployment_names_the_variables_its_duty_needs(name):
    """A missing name gives a deployment that starts and then fails every request."""
    block = _deployment_blocks()[name]
    declared = {_value(item, "name") for item in _variable_blocks(block)}
    missing = sorted(REQUIRED_VARIABLES[name] - declared)

    assert not missing, f"the {name} deployment sets no {missing}, so add them to quix.yaml"


# --- Rule 3: no secret in the file ---
#
# A Secret variable names a workspace secret. `quix.yaml` spells that name
# `secretKey:`, and an app.yaml spells it `defaultValue:`. A `value:` line on a
# Secret variable commits the secret itself into git.


def _secret_variables(path: Path) -> list[list[str]]:
    """Every `inputType: Secret` variable of one file, in file order.

    This returns a LIST, never a map keyed by name. `quix.yaml` declares
    `TM_API_TOKEN` on four deployments, and a map would keep one of the four.
    A committed value on any of the other three would then pass unseen.
    """
    return [
        block
        for block in _variable_blocks(_code_lines(path))
        if _value(block, "inputType") == "Secret"
    ]


def _every_secret() -> list[tuple[str, int, str]]:
    """Every (file, position, secret name) of the three deployment files."""
    return [
        (label, index, _value(block, "name"))
        for label, path in VARIABLE_FILES.items()
        for index, block in enumerate(_secret_variables(path))
    ]


def test_the_secret_parse_finds_every_secret_in_every_file():
    """A parse that finds nothing would make the two secret rules pass on nothing."""
    for label, path in VARIABLE_FILES.items():
        assert _secret_variables(path), f"the parse reads no secret from {label}"

    names = [name for label, _, name in _every_secret() if label == "quix.yaml"]

    # The count read four until 19 Aug 2026, when the watcher deployment left
    # with the ingest split, and three until 20 Aug 2026, when the planning
    # mock took the token back: it PUSHES to the registry now, and every write
    # there carries the bearer.
    assert names.count("TM_API_TOKEN") == 4, (
        f"the parse reads TM_API_TOKEN {names.count('TM_API_TOKEN')} times of four. "
        f"A map keyed by name would hide three of them."
    )


@pytest.mark.parametrize("label,index,name", _every_secret())
def test_no_secret_variable_carries_a_committed_value(label, index, name):
    """A `value:` line on a secret puts the secret itself into git."""
    block = _secret_variables(VARIABLE_FILES[label])[index]

    assert not _value(block, "value"), (
        f"{label} commits a value for the secret {name}. "
        f"Delete the value line and name a workspace secret instead."
    )


@pytest.mark.parametrize(
    "index,name",
    [(index, name) for label, index, name in _every_secret() if label == "quix.yaml"],
)
def test_every_quix_secret_names_a_workspace_secret(index, name):
    """`secretKey:` sends the platform to the workspace for the value."""
    block = _secret_variables(QUIX_PATH)[index]

    assert _value(block, "secretKey"), (
        f"quix.yaml gives the secret {name} no secretKey, so the platform sets it empty"
    )


@pytest.mark.parametrize(
    "label,index,name",
    [item for item in _every_secret() if item[0] != "quix.yaml"],
)
def test_every_application_secret_names_a_workspace_secret(label, index, name):
    """An app.yaml holds the secret NAME in `defaultValue:`, never the secret."""
    block = _secret_variables(VARIABLE_FILES[label])[index]

    assert _value(block, "defaultValue"), (
        f"{label} gives the secret {name} no defaultValue, "
        f"so the platform offers no workspace secret name"
    )


# --- Rule 4: Mongo keeps its data ---


def test_the_mongo_deployment_keeps_its_data_across_a_restart():
    """Without `state:` the platform mounts no volume and every restart drops the data.

    Kubernetes drops the writable layer of a container on each restart. The
    registry lives in Mongo, so the whole demo would empty itself.
    """
    state = _sub_block(_deployment_blocks()["MongoDB"], "state")

    assert state, "the MongoDB deployment declares no state, so every restart drops the data"
    assert _value(state, "enabled") == "true", (
        "the MongoDB state is not enabled, so the platform mounts no volume"
    )
    assert _value(state, "size").isdigit() and int(_value(state, "size")) > 0, (
        "the MongoDB state size is not a positive number, so the volume claim fails"
    )
    assert _value(state, "path") == "/data/db", (
        "the MongoDB volume misses Mongo's own data path, so the data stays on the layer"
    )


# --- Rule 5: every blob duty reaches the storage gateway ---
#
# The API streams one object out per download, and it streams one object in per
# result upload. Both legs need the minted credential, so the API needs the bind.
#
# CHANGED ON 19 AUG 2026. `Test Manager Watcher` stood in this list until the
# boss moved the file watcher into the ingestion pipeline. That deployment left
# `quix.yaml`, so it left this list too. The API is now the ONE deployment that
# binds. See plans/design/INGEST-SPLIT.md.

# CHANGED ON 21 AUG 2026. The seed joined this list. It calls the lake straight
# (`api/seed/fixtures_inventory.py:357,371`), and the bind is what makes the
# platform inject `Quix__Lakehouse__Query__Url` and its token. The file declared
# both names by hand until that day.
BLOB_DEPLOYMENTS = ("Test Manager API", "Test Manager Seed")


@pytest.mark.parametrize("name", BLOB_DEPLOYMENTS)
def test_every_blob_deployment_binds_to_the_storage_gateway(name):
    """`blobStorage: bind: true` is the one key that mints the credential.

    The platform then injects `Quix__BlobStorage__Connection__Json`. A sync from
    a file without this key UNSETS the binding again. Then
    `GET /files/{file_id}/download` answers 503 on every file, and
    `POST /results/upload` stores no processed byte.
    """
    binding = _sub_block(_deployment_blocks()[name], "blobStorage")

    assert binding, (
        f"{name} declares no blobStorage, so the next sync unbinds it from the gateway"
    )
    assert _value(binding, "bind") == "true", (
        f"the {name} blobStorage bind is not true, so the platform mints no credential"
    )


# --- Rule 6: the file never names an injected variable ---
#
# The platform writes both names by itself. A declared name overwrites the
# injected value with our empty one.

# The lake pair joined this tuple on 21 Aug 2026. `blobStorage: bind: true` brings
# the whole Lakehouse family, so a declaration of either name overwrites the real
# external URL with our `http://quixlake`.
INJECTED_VARIABLES = (
    "Quix__BlobStorage__Connection__Json",
    "Quix__Workspace__Id",
    # The public host of this deployment. `ai_client.mcp_url` reads it and
    # builds the /mcp address the platform registers, so a declaration here
    # would empty it and the assistant would lose every registry tool.
    ai_client.PUBLIC_URL_VAR,
    LAKE_URL_VAR,
    LAKE_TOKEN_VAR,
)


@pytest.mark.parametrize("name", INJECTED_VARIABLES)
@pytest.mark.parametrize("label", sorted(VARIABLE_FILES))
def test_no_file_declares_a_platform_injected_variable(label, name):
    """A declared empty value overwrites the value the platform injects.

    A comment may name it. A variable declaration may never.
    """
    assert name not in _declared_names(VARIABLE_FILES[label]), (
        f"{label} declares {name}, and the platform injects it. "
        f"Delete the declaration, or the injected value becomes empty."
    )


# --- Rule 7: every application exists ---


def _application_values() -> list[str]:
    """Every distinct `application:` value of quix.yaml."""
    return sorted(
        {
            value
            for block in _deployment_blocks().values()
            if (value := _value(block, "application"))
        }
    )


def test_the_application_parse_finds_both_applications():
    """A parse that finds nothing would make the rule below pass on nothing."""
    assert _application_values() == ["api", "frontend"], (
        f"quix.yaml names the applications {_application_values()}"
    )


@pytest.mark.parametrize("name", _application_values())
def test_every_application_names_a_real_folder(name):
    """The platform builds the folder named here. A typo builds nothing."""
    app_file = REPO_ROOT / name / "app.yaml"

    assert app_file.is_file(), f"quix.yaml names the application {name}, and {app_file} is missing"
    assert _value(_code_lines(app_file), "name") == name, (
        f"{app_file} names another application, so the platform builds the wrong folder"
    )


# --- Rule 8: a public deployment answers on port 80 ---


def _public_deployments() -> list[str]:
    """Every deployment of quix.yaml that the platform gives a public URL."""
    return sorted(
        name
        for name, block in _deployment_blocks().items()
        if _value(_sub_block(block, "publicAccess"), "enabled") == "true"
    )


def test_the_public_access_parse_finds_both_public_deployments():
    """A parse that finds nothing would make the port rule pass on nothing."""
    assert _public_deployments() == ["Test Manager API", "Test Manager Frontend"], (
        f"quix.yaml publishes {_public_deployments()}"
    )


@pytest.mark.parametrize("name", _public_deployments())
def test_every_public_deployment_answers_on_port_eighty(name):
    """The ingress is hard-wired to service port 80.

    Any other number gives a public URL that reaches nothing, and the platform
    reports no error for it.
    """
    ports = _sub_block(_sub_block(_deployment_blocks()[name], "network"), "ports")
    numbers = [line.strip().removeprefix("- ") for line in ports]

    assert ports, f"{name} is public and declares no network ports, so the ingress finds no service"
    assert "port: 80" in numbers, (
        f"{name} is public and publishes no port 80, so its public URL reaches nothing"
    )


# --- Rule 9: an embedded view needs a public URL ---


def _embedded_deployments() -> list[str]:
    """Every deployment that the Portal shows inside its own frame."""
    return sorted(
        name
        for name, block in _deployment_blocks().items()
        if _value(
            _sub_block(_sub_block(block, "plugin"), "embeddedView"), "enabled"
        )
        == "true"
    )


def test_the_embedded_view_parse_finds_the_front_end():
    """A parse that finds nothing would make the rule below pass on nothing."""
    assert _embedded_deployments() == ["Test Manager Frontend"], (
        f"quix.yaml embeds {_embedded_deployments()}"
    )


@pytest.mark.parametrize("name", _embedded_deployments())
def test_every_embedded_view_also_has_a_public_url(name):
    """The platform refuses an embedded view with no public access."""
    assert name in _public_deployments(), (
        f"{name} embeds a view and has no publicAccess, so the platform refuses the sync"
    )


# --- Rule 10: the image and the application never both appear ---


@pytest.mark.parametrize("name", sorted(_deployment_blocks()))
def test_every_deployment_names_one_source_of_its_container(name):
    """The platform's own validator refuses a deployment that names both."""
    block = _deployment_blocks()[name]
    application = _value(block, "application")
    image = _value(block, "image")

    assert application or image, f"{name} names no application and no image, so it builds nothing"
    assert not (application and image), (
        f"{name} names both an application and an image, so the validator refuses it"
    )


def _image_deployments() -> list[str]:
    """Every deployment of quix.yaml that runs a third-party image."""
    return sorted(
        name
        for name, block in _deployment_blocks().items()
        if _value(block, "image")
    )


def test_the_image_parse_finds_the_mongo_deployment():
    """A parse that finds nothing would make the version rule pass on nothing."""
    assert _image_deployments() == ["MongoDB"], (
        f"quix.yaml runs the images of {_image_deployments()}"
    )


@pytest.mark.parametrize("name", _image_deployments())
def test_no_image_deployment_names_a_version(name):
    """`version:` belongs to an application build. An image carries its own tag."""
    block = _deployment_blocks()[name]

    assert not _value(block, "version"), (
        f"{name} runs an image and names a version, so the validator refuses it"
    )


# --- Rule 11: the front-end image copies a config file that exists ---
#
# The old line named `next.config.js` while the repository holds
# `next.config.ts`. The production build failed on the COPY step, so no front
# end could deploy at all.

_CONFIG_COPY = re.compile(
    r"""(?m)^COPY\s+--from=builder\s+/app/(next\.config\.\w+)\s"""
)


def _copied_config_files() -> list[str]:
    """Every `next.config.*` file the production image copies."""
    return _CONFIG_COPY.findall(_read(FRONTEND_DOCKERFILE_PATH))


def test_the_dockerfile_parse_finds_the_config_copy():
    """A parse that finds nothing would make the rule below pass on nothing."""
    assert _copied_config_files(), (
        "the parse reads no next.config copy from frontend/dockerfile, so fix the regex"
    )


@pytest.mark.parametrize("name", _copied_config_files())
def test_the_front_end_image_copies_a_config_file_that_exists(name):
    """A COPY of a missing file fails the build, and no front end then deploys."""
    assert (REPO_ROOT / "frontend" / name).is_file(), (
        f"frontend/dockerfile copies {name}, and the repository holds no such file. "
        f"Name the file that exists on disk."
    )


# --- Rule 12: a blob reader says so, and it binds ---
#
# Rule 5 pins the bind. This rule pins the other half: the VALUE of
# `TM_INGEST_SOURCE`. The name alone proves nothing, because `local` is a legal
# value and it reads a folder no pod holds. The API then answers 503 on every
# `GET /files/{file_id}/download`.
#
# The two halves also have to agree. A deployment that reads the gateway without
# the bind gets no credential.
#
# The reverse is NOT true. A deployment may bind and read no file byte: the seed
# binds for the injected Lakehouse pair alone, and it names no TM_INGEST_SOURCE.
# So this rule reads its own list, never BLOB_DEPLOYMENTS.

_BLOB_SOURCE_VALUE = "blob"

# Every deployment that streams FILE BYTES through the gateway. The API streams
# one object out per download and one object in per result upload.
BLOB_BYTE_READERS = ("Test Manager API",)


def _ingest_sources() -> dict[str, str]:
    """Every deployment that names TM_INGEST_SOURCE, mapped to the value it sets."""
    found: dict[str, str] = {}
    for name, block in _deployment_blocks().items():
        for item in _variable_blocks(block):
            if _value(item, "name") == "TM_INGEST_SOURCE":
                found[name] = _value(item, "value")
    return found


def test_the_ingest_source_parse_finds_every_declaration():
    """A parse that finds nothing would make both rules below pass on nothing."""
    assert sorted(_ingest_sources()) == sorted(BLOB_BYTE_READERS), (
        f"quix.yaml sets TM_INGEST_SOURCE on {sorted(_ingest_sources())}, "
        f"and the byte readers are {sorted(BLOB_BYTE_READERS)}"
    )


@pytest.mark.parametrize("name", BLOB_BYTE_READERS)
def test_every_blob_deployment_reads_the_storage_gateway(name):
    """`local` reads a folder the pod never holds, and the read then fails."""
    source = _ingest_sources().get(name, "")

    assert source == _BLOB_SOURCE_VALUE, (
        f"the {name} deployment sets TM_INGEST_SOURCE to {source or '(nothing)'}, "
        f"so it reads no blob. Set it to {_BLOB_SOURCE_VALUE}."
    )


def _blob_readers() -> list[str]:
    """Every deployment that really reads the storage gateway."""
    return sorted(
        name
        for name, source in _ingest_sources().items()
        if source == _BLOB_SOURCE_VALUE
    )


@pytest.mark.parametrize("name", _blob_readers())
def test_every_blob_reader_also_binds_to_the_gateway(name):
    """A gateway read needs the minted credential, so the two keys travel together.

    This rule reads the file, never the BLOB_DEPLOYMENTS list. A new deployment
    that reads the gateway therefore fails here even if nobody updates the list.
    """
    binding = _sub_block(_deployment_blocks()[name], "blobStorage")

    assert _value(binding, "bind") == "true", (
        f"{name} reads the storage gateway and declares no blobStorage bind, "
        f"so the platform mints no credential and every read answers 503"
    )


# --- Rule 13: an app.yaml declares exactly the names quix.yaml sets ---
#
# ADDED 21 AUG 2026, for the overlay. The Portal syncs the two files separately,
# so a name that quix.yaml sets and the app.yaml never declares reaches the
# Portal form with no description and no default, and it never self-heals. The
# reverse case is a schema row for a value nobody sets.

APPLICATION_FILES = {"api": API_APP_PATH, "frontend": FRONTEND_APP_PATH}


def _names_quix_sets(application: str) -> set[str]:
    """Every variable name quix.yaml sets on one application, across its deployments."""
    return {
        _value(item, "name")
        for block in _deployment_blocks().values()
        if _value(block, "application") == application
        for item in _variable_blocks(block)
    }


def test_the_application_variable_parse_finds_both_sides():
    """A parse that finds nothing would make the rule below pass on nothing."""
    for application in APPLICATION_FILES:
        assert _names_quix_sets(application), (
            f"the parse reads no quix.yaml variable for the {application} application"
        )


@pytest.mark.parametrize("application", sorted(APPLICATION_FILES))
def test_every_application_declares_exactly_what_quix_sets(application):
    """A missing row loses the description and the default. A spare row is a fiction."""
    declared = _declared_names(APPLICATION_FILES[application])
    used = _names_quix_sets(application)

    assert not used - declared, (
        f"quix.yaml sets {sorted(used - declared)} on the {application} application, "
        f"and {application}/app.yaml declares no such variable. Add the schema row."
    )
    assert not declared - used, (
        f"{application}/app.yaml declares {sorted(declared - used)}, "
        f"and quix.yaml sets no such variable. Delete the schema row."
    )


# --- Rule 14: the api application declares the blob bind too ---
#
# ADDED 21 AUG 2026. The CREATE path treats the deployment key and the
# application key as an OR (DeploymentService.cs:794-796), so this key is the
# belt to the deployment key's braces. The UPDATE path reads the deployment key
# only, which is why rule 5 still stands on its own.


def test_the_api_application_declares_the_blob_bind():
    """Without the bind the platform injects no blob credential and no lake pair."""
    binding = _sub_block(_code_lines(API_APP_PATH), "blobStorage")

    assert _value(binding, "bind") == "true", (
        "api/app.yaml declares no blobStorage bind. The create path reads it, "
        "and the Lakehouse pair and the blob credential both depend on the bind."
    )
