"""The platform surface: app.yaml legality, the topic edges, the consumer group."""

import os

import pytest

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# app.yaml legal keys ONLY. Anything else is silently dropped by the Portal, so
# a stray key is a bug that never announces itself.
LEGAL_APP_KEYS = {
    "name",
    "language",
    "variables",
    "dockerfile",
    "runEntryPoint",
    "defaultFile",
    "libraryItemId",
    "blobStorage",
    "includedFolders",
}


@pytest.fixture(scope="module")
def app_yaml():
    """A tiny reader — the estate does not install a YAML parser for tests."""
    path = os.path.join(APP_DIR, "app.yaml")
    with open(path, encoding="utf-8") as handle:
        lines = handle.read().splitlines()

    top_level = [line.split(":", 1)[0] for line in lines if line and not line[0].isspace()]
    variables = []
    current = None
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("- name:"):
            current = {"name": stripped.split(":", 1)[1].strip()}
            variables.append(current)
        elif current is not None and stripped and ":" in stripped and line.startswith("    "):
            key, value = stripped.split(":", 1)
            current[key.strip()] = value.strip()
        elif line and not line[0].isspace():
            current = None
    return {"keys": top_level, "variables": {item["name"]: item for item in variables}}


class TestAppYamlLegality:
    def test_every_top_level_key_is_legal(self, app_yaml):
        assert set(app_yaml["keys"]) <= LEGAL_APP_KEYS

    def test_deployment_only_keys_never_appear_here(self, app_yaml):
        # resources / network / state / plugin live in quix.yaml only.
        assert {"resources", "network", "state", "plugin"} & set(app_yaml["keys"]) == set()

    def test_the_consumer_group_is_not_a_variable(self, app_yaml):
        # A Portal-rotated group is a full topic replay. Keeping it out of
        # app.yaml means the Portal cannot rotate it (mf4-decoder/main.py:68-83).
        names = {name.lower() for name in app_yaml["variables"]}
        assert "consumer_group" not in names
        assert not any("group" in name for name in names)


class TestTopicEdges:
    def test_both_inputs_are_declared_with_a_default(self, app_yaml):
        variables = app_yaml["variables"]
        assert variables["metadata_input"]["inputType"] == "InputTopic"
        assert variables["metadata_input"]["defaultValue"] == "mf4_metadata"
        assert variables["batch_input"]["inputType"] == "InputTopic"
        # The decoder's own topic. It carries the kind:"samples" batches and the
        # one terminal kind:"file_complete" marker, and the marker holds the
        # inventory measured in the decoder's own process — so there is no
        # enrichment stage to point a second topic at.
        assert variables["batch_input"]["defaultValue"] == "mf4-to-msg"

    def test_the_topic_names_are_spelled_exactly(self, app_yaml):
        # Portal arrows are string-matched: mf4_metadata != mf4-metadata.
        assert app_yaml["variables"]["metadata_input"]["defaultValue"] == "mf4_metadata"
        assert app_yaml["variables"]["batch_input"]["defaultValue"] == "mf4-to-msg"

    def test_there_is_no_output_topic(self, app_yaml):
        types = {item.get("inputType") for item in app_yaml["variables"].values()}
        assert "OutputTopic" not in types


class TestSecretSpelling:
    def test_the_token_is_a_secret_project_variable(self, app_yaml):
        token = app_yaml["variables"]["TM_API_TOKEN"]
        assert token["inputType"] == "ProjectVariable"
        assert token["secret"] == "true"

    def test_the_legacy_secret_spelling_is_not_used(self, app_yaml):
        # The retired landing-zone watcher declared `inputType: Secret`; that
        # spelling is legacy and must not come back with a new app.
        assert all(
            item.get("inputType") != "Secret" for item in app_yaml["variables"].values()
        )

    def test_the_actor_default_is_not_a_placeholder(self, app_yaml):
        from api.models.journal import PLACEHOLDER_ACTORS

        actor = app_yaml["variables"]["TM_ACTOR"]["defaultValue"]
        assert actor.lower() not in PLACEHOLDER_ACTORS


class TestMainWiring:
    def test_the_consumer_group_is_hard_coded_in_code(self, monkeypatch):
        monkeypatch.setenv("metadata_input", "mf4_metadata")
        monkeypatch.setenv("batch_input", "mf4-to-msg")
        import main

        app, connector = main.build()

        assert main.CONSUMER_GROUP == "tm-connector-v2"
        assert app.kwargs["consumer_group"] == "tm-connector-v2"
        assert app.kwargs["auto_offset_reset"] == "earliest"
        assert connector is not None

    def test_both_topics_are_registered_and_routed(self, monkeypatch):
        monkeypatch.setenv("metadata_input", "mf4_metadata")
        monkeypatch.setenv("batch_input", "mf4-to-msg")
        import main

        app, connector = main.build()

        assert [topic.name for topic in app.topics] == ["mf4_metadata", "mf4-to-msg"]
        handlers = [frame.updates[0] for frame in app.dataframes]
        assert handlers == [connector.on_metadata, connector.on_batch]

    def test_the_payloads_are_json_and_the_keys_are_strings(self, monkeypatch):
        monkeypatch.setenv("metadata_input", "mf4_metadata")
        monkeypatch.setenv("batch_input", "mf4-to-msg")
        import main

        app, _connector = main.build()
        for topic in app.topics:
            assert topic.kwargs["value_deserializer"] == "json"
            assert topic.kwargs["key_deserializer"] == "str"
