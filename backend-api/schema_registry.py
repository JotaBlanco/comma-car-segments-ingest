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
from functools import lru_cache
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

SCHEMA_DIR = Path(__file__).resolve().parent / "schemas"
SCHEMA_ID_BASE = "https://acc-project.local/schemas/"


class SchemaNotFoundError(KeyError):
    """Raised when a schema name has no published file."""


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


@lru_cache(maxsize=None)
def raw_bytes(name: str) -> bytes:
    return _path(name).read_bytes()


@lru_cache(maxsize=None)
def schema_sha256(name: str) -> str:
    return hashlib.sha256(raw_bytes(name)).hexdigest()


@lru_cache(maxsize=None)
def schema(name: str) -> dict:
    return json.loads(raw_bytes(name).decode("utf-8"))


@lru_cache(maxsize=1)
def _registry() -> Registry:
    """Register every published schema under its ``$id``.

    Sibling ``$ref``s such as ``"requirement-1.0.0.schema.json"`` inside
    ``requirements-set-1.0.0`` resolve relative to the referrer's ``$id``, so
    registering by ``$id`` is all that is needed - no network access, no
    hand-rolled resolver.
    """
    resources = []
    for name in schema_names():
        doc = schema(name)
        resource = Resource.from_contents(doc, default_specification=DRAFT202012)
        resources.append((doc.get("$id", SCHEMA_ID_BASE + name + ".schema.json"), resource))
    return Registry().with_resources(resources)


@lru_cache(maxsize=None)
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
