"""Facts that live in more than one place, pinned so they cannot drift apart.

Each of these is a value two or more deployments must agree on. None of them is
enforced by anything at runtime: when they disagree the pipeline keeps running
and produces a wrong answer quietly, which is exactly why they are pinned here.
"""

from __future__ import annotations

import pathlib

import pytest
import yaml

REPO = pathlib.Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def project() -> dict:
    return yaml.safe_load((REPO / "quix.yaml").read_text())


def _deployment(project: dict, name: str) -> dict:
    return next(d for d in project["deployments"] if d["name"] == name)


def _variables(project: dict, name: str) -> dict:
    return {v["name"]: v for v in _deployment(project, name).get("variables", [])}


# --- ONE lake table, five readers -------------------------------------------

# The sink WRITES it; the connector claims it on every run; the API and the
# frontend query it. A second spelling anywhere means a screen reads a table
# nothing writes, and answers "no data" rather than an error.
LAKE_TABLE_READERS = {
    "MF4 DataLake Sink": "TABLE_NAME",
    "TS Metadata sink": "LAKE_TABLE",
    "Test Manager - API": "TM_LAKE_TABLE",
    "Test Manager - Frontend": "TM_LAKE_TABLE",
}


@pytest.mark.parametrize("deployment,variable", LAKE_TABLE_READERS.items())
def test_every_lake_reader_binds_the_one_project_variable(project, deployment, variable):
    declared = _variables(project, deployment)[variable]

    assert declared.get("inputType") == "ProjectVariable", (
        f"{deployment}/{variable} states its own table instead of binding LAKE_TABLE"
    )
    assert declared.get("variableKey") == "LAKE_TABLE"


def test_no_deployment_states_a_lake_table_literally(project):
    """A literal value beside four bindings is the drift this rule prevents."""
    for deployment, variable in LAKE_TABLE_READERS.items():
        assert "value" not in _variables(project, deployment)[variable]


# --- ONE run-key pattern, two readers ---------------------------------------


@pytest.mark.parametrize("deployment", ["MF4 Decoder", "TS Metadata sink"])
def test_both_run_key_readers_bind_the_one_project_variable(project, deployment):
    """The decoder partitions by the run; the connector registers it.

    A different pattern on either side puts a file's catalogue in the registry
    under one run and its samples in the lake under another, and nothing reports
    it. tests/test_run_key_agreement.py pins the ladder; this pins the value.
    """
    declared = _variables(project, deployment)["TM_RUN_KEY_PATTERN"]

    assert declared.get("inputType") == "ProjectVariable"
    assert declared.get("variableKey") == "TM_RUN_KEY_PATTERN"


# --- ONE registry token, three presenters -----------------------------------


@pytest.mark.parametrize(
    "deployment",
    ["Test Manager - API", "TS Metadata sink", "Test Manager - Frontend"],
)
def test_everything_that_talks_to_the_registry_presents_the_one_token(project, deployment):
    declared = _variables(project, deployment)["TM_API_TOKEN"]

    assert declared.get("inputType") == "ProjectVariable"
    assert declared.get("variableKey") == "TM_API_TOKEN"


# --- ONE topic pair, and who reads it ----------------------------------------


def test_the_connector_reads_the_topics_the_pipeline_writes(project):
    """Portal arrows are string-matched: mf4_metadata != mf4-metadata."""
    connector = _variables(project, "TS Metadata sink")
    importer = _variables(project, "MF4 Import")
    decoder = _variables(project, "MF4 Decoder")

    metadata_topic = importer.get("output", {}).get("value", "mf4_metadata")
    decoded_topic = decoder.get("output", {}).get("value", "mf4-to-msg")

    assert connector["metadata_input"]["value"] == metadata_topic
    assert connector["batch_input"]["value"] == decoded_topic


def test_the_sink_and_the_connector_read_the_same_decoder_topic(project):
    """One topic, two kinds. The sink expands the batches, the connector
    finalizes on the marker; neither gets its own topic to drift onto."""
    sink_input = _variables(project, "MF4 DataLake Sink").get("input", {})
    connector_batch = _variables(project, "TS Metadata sink")["batch_input"]["value"]

    assert sink_input.get("value", "mf4-to-msg") == connector_batch


def test_every_topic_a_deployment_names_is_declared(project):
    """A topic the portal does not know about is created silently and empty."""
    declared = {topic["name"] for topic in project["topics"]}
    named = set()
    for deployment in project["deployments"]:
        for variable in deployment.get("variables", []):
            if variable["name"] in {"input", "output", "config", "metadata_input", "batch_input"}:
                value = variable.get("value")
                if isinstance(value, str) and value:
                    named.add(value)

    assert named <= declared, f"undeclared topics: {sorted(named - declared)}"


# --- ONE lake writer ----------------------------------------------------------


def test_nothing_but_the_sink_writes_the_lake(project):
    """A second writer would fork the table's partition spec silently."""
    writers = [
        d["name"]
        for d in project["deployments"]
        if any(v["name"] in {"TABLE_NAME", "HIVE_COLUMNS"} for v in d.get("variables", []))
    ]

    assert writers == ["MF4 DataLake Sink"]


# --- the registry keeps its own database --------------------------------------


def test_the_registry_does_not_share_the_configuration_database(project):
    """One MongoDB deployment, two databases. The registry's name is fixed in
    code (`api/api/db.py::DATABASE_NAME`); this pins that it is not the
    Configuration Manager's."""
    from api.db import DATABASE_NAME

    config_manager = _deployment(project, "Dynamic Configuration Manager")

    assert DATABASE_NAME != config_manager["configuration"]["mongoDatabase"]
