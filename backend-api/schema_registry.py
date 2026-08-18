"""Published JSON Schemas: loading, cross-file ``$ref`` resolution, hashing.

JSON Schema (draft 2020-12) is the source of truth for *artifact* documents;
Pydantic covers API-only bodies (spec 3.3). Two validators, two jobs, no
duplicated artifact model.

Every artifact-set manifest records the ``schema_sha256`` it was validated
against, so re-validating an old version stays reproducible even after a schema
revision - which is why the hash is taken over the raw file bytes rather than
over a re-serialised object.
"""

import hashlib
import json
from functools import cache, lru_cache
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

SCHEMA_DIR = Path(__file__).resolve().parent / "schemas"
SCHEMA_ID_BASE = "https://acc-project.local/schemas/"


class SchemaNotFoundError(KeyError):
    """Raised when a schema name has no published file."""


class SchemaLoadError(RuntimeError):
    """A published schema file is not loadable, and the message says which one.

    Exists because of a one-character defect that cost a verification round: a
    single illegal JSON escape in ``requirement-1.0.0.schema.json`` made
    ``_registry()`` - which parses *every* published schema to resolve cross-file
    ``$ref``s - raise a bare ``JSONDecodeError`` with no file name in it, so door
    validation failed for all four artifact sets with an opaque 500 and nothing
    pointing at the culprit.

    The registry stays strict: one unparseable schema fails every set, not just
    the sets that reference it. A published schema that cannot be compiled is a
    deployment defect, and a partially-built registry would let a ``$ref`` go
    unresolved and quietly validate less than it claims to. What changes is that
    the failure now names every offending file and its parse position, and
    ``GET /health`` reports it without being asked.
    """


@lru_cache(maxsize=1)
def _files() -> dict[str, Path]:
    """``requirement-1.0.0`` -> path of ``requirement-1.0.0.schema.json``."""
    return {
        path.name.removesuffix(".schema.json"): path
        for path in sorted(SCHEMA_DIR.glob("*.schema.json"))
    }


def schema_names() -> list[str]:
    return sorted(_files())


def _path(name: str) -> Path:
    try:
        return _files()[name]
    except KeyError as exc:
        raise SchemaNotFoundError(
            f"no published schema named {name!r}; known: {', '.join(schema_names())}"
        ) from exc


@cache
def raw_bytes(name: str) -> bytes:
    return _path(name).read_bytes()


@cache
def schema_sha256(name: str) -> str:
    return hashlib.sha256(raw_bytes(name)).hexdigest()


@cache
def schema(name: str) -> dict:
    """The parsed schema document, or ``SchemaLoadError`` naming the file."""
    path = _path(name)
    try:
        return json.loads(raw_bytes(name).decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise SchemaLoadError(
            f"{path.name} is not valid JSON: {exc.msg} at line {exc.lineno} "
            f"column {exc.colno} ({path})"
        ) from exc
    except UnicodeDecodeError as exc:
        raise SchemaLoadError(f"{path.name} is not valid UTF-8: {exc} ({path})") from exc
    except OSError as exc:
        # Same class of failure from the caller's point of view: the schema is not
        # loadable, and /health must be able to say which one and why.
        raise SchemaLoadError(f"{path.name} cannot be read: {exc} ({path})") from exc


def load_errors() -> list[str]:
    """One message per published schema that will not parse or compile.

    Cheap enough to call from ``/health``: the parsed documents and the compiled
    validators are both memoised, so after the first call this is a dictionary
    lookup per schema.
    """
    errors = [message for _, message in _parse_failures()]
    if errors:
        # No point reporting 11 identical "the registry could not be built"
        # messages; the unparseable files are the finding.
        return errors
    for name in schema_names():
        try:
            validator(name)
        except Exception as exc:  # noqa: BLE001 - a valid JSON doc need not be a valid schema
            errors.append(f"{name}.schema.json does not compile as draft 2020-12: {exc}")
    return errors


def _parse_failures() -> list[tuple[str, str]]:
    """``(name, message)`` for every published schema that will not parse."""
    failures = []
    for name in schema_names():
        try:
            schema(name)
        except SchemaLoadError as exc:
            failures.append((name, str(exc)))
    return failures


@lru_cache(maxsize=1)
def _registry() -> Registry:
    """Register every published schema under its ``$id``.

    Sibling ``$ref``s such as ``"requirement-1.0.0.schema.json"`` inside
    ``requirements-set-1.0.0`` resolve relative to the referrer's ``$id``, so
    registering by ``$id`` is all that is needed - no network access, no
    hand-rolled resolver.

    Every published file is parsed here, so a defect in *any* schema surfaces on
    the first validation of *any* artifact set. The parse errors are collected
    first and reported together: the failure names every offending file rather
    than aborting on whichever one ``sorted()`` happened to reach first.
    """
    failures = _parse_failures()
    if failures:
        raise SchemaLoadError(
            "the published JSON Schemas could not be loaded, so no artifact set can be "
            "validated. Offending file(s): " + "; ".join(message for _, message in failures)
        )
    resources = []
    for name in schema_names():
        doc = schema(name)
        resource = Resource.from_contents(doc, default_specification=DRAFT202012)
        resources.append((doc.get("$id", SCHEMA_ID_BASE + name + ".schema.json"), resource))
    return Registry().with_resources(resources)


@cache
def validator(name: str) -> Draft202012Validator:
    return Draft202012Validator(
        schema(name),
        registry=_registry(),
        format_checker=Draft202012Validator.FORMAT_CHECKER,
    )


def iter_errors(name: str, instance) -> list:
    """Schema errors for one instance, deepest-first for readable messages."""
    return sorted(validator(name).iter_errors(instance), key=lambda err: list(err.absolute_path))


def pointer(error) -> str:
    """JSON Pointer of an error's location, for the API error payload."""
    return "/" + "/".join(str(part) for part in error.absolute_path)
