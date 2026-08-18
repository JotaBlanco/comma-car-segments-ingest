"""Regression tests for the published schemas and their loader.

Round-1 blocker: ``requirement-1.0.0.schema.json`` contained ``\\.`` where JSON
requires ``\\\\.``, so the file did not parse. Because ``_registry()`` parses every
published schema to resolve cross-file ``$ref``s, that one character broke door
validation for all four artifact sets and both affected endpoints answered 500
with no file name anywhere in the response. These tests fail on that state.
"""

import json
import re

import pytest

import schema_registry

_CACHED = (
    schema_registry._files,
    schema_registry.raw_bytes,
    schema_registry.schema_sha256,
    schema_registry.schema,
    schema_registry._registry,
    schema_registry.validator,
)


_REAL_SCHEMA_DIR = schema_registry.SCHEMA_DIR


def _clear_caches() -> None:
    for function in _CACHED:
        function.cache_clear()


@pytest.fixture(autouse=True)
def _isolated_registry():
    """Every test starts and leaves the module with cold caches."""
    _clear_caches()
    yield
    schema_registry.SCHEMA_DIR = _REAL_SCHEMA_DIR
    _clear_caches()


def test_every_published_schema_file_is_valid_json():
    names = schema_registry.schema_names()
    assert names, "no schemas found in backend-api/schemas/"
    for name in names:
        try:
            document = schema_registry.schema(name)
        except schema_registry.SchemaLoadError as exc:  # pragma: no cover - the bug
            pytest.fail(str(exc))
        assert isinstance(document, dict), f"{name} is not a JSON object"
        assert document.get("$schema"), f"{name} declares no $schema"


def test_every_regex_pattern_in_every_schema_compiles():
    """A ``pattern`` that survives JSON parsing can still be an invalid regex."""
    compiled = 0
    for name in schema_registry.schema_names():
        for pattern in _patterns(schema_registry.schema(name)):
            try:
                re.compile(pattern)
            except re.error as exc:  # pragma: no cover - the bug
                pytest.fail(f"{name}: pattern {pattern!r} does not compile: {exc}")
            compiled += 1
    assert compiled > 0


def test_every_schema_compiles_into_a_validator():
    for name in schema_registry.schema_names():
        assert schema_registry.validator(name) is not None, name


def test_load_errors_is_empty_for_the_published_set():
    assert schema_registry.load_errors() == []


def test_a_broken_schema_is_reported_with_its_file_name(tmp_path):
    """The diagnostic that was missing: which file, and where in it."""
    good = _REAL_SCHEMA_DIR / "signal-catalog-1.0.0.schema.json"
    (tmp_path / good.name).write_bytes(good.read_bytes())
    broken = tmp_path / "requirement-1.0.0.schema.json"
    broken.write_text('{"pattern": "^[0-9]+\\.[0-9]+$"}', encoding="utf-8")

    schema_registry.SCHEMA_DIR = tmp_path
    _clear_caches()

    errors = schema_registry.load_errors()
    assert len(errors) == 1
    assert "requirement-1.0.0.schema.json" in errors[0]
    assert "line 1" in errors[0]

    with pytest.raises(schema_registry.SchemaLoadError) as raised:
        schema_registry.validator("signal-catalog-1.0.0")
    # A sibling that never references the broken file still fails - deliberately -
    # but the message names the culprit instead of being a bare JSONDecodeError.
    assert "requirement-1.0.0.schema.json" in str(raised.value)


def _patterns(node) -> list[str]:
    found: list[str] = []
    if isinstance(node, dict):
        if isinstance(node.get("pattern"), str):
            found.append(node["pattern"])
        for value in node.values():
            found.extend(_patterns(value))
    elif isinstance(node, list):
        for value in node:
            found.extend(_patterns(value))
    return found


def test_the_revision_pattern_means_what_it_says():
    """The exact defect: the pattern must match ``1.0`` and reject ``1x0``."""
    document = schema_registry.schema("requirement-1.0.0")
    pattern = document["properties"]["revision"]["pattern"]
    assert re.match(pattern, "1.0")
    assert re.match(pattern, "12.34")
    assert not re.match(pattern, "1x0"), "the dot must be escaped, not a wildcard"
    assert json.loads(json.dumps(pattern)) == pattern
