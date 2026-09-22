"""tm-connector holds no blob credentials. It reads Kafka and calls HTTP.

mf4-import and mf4-decoder bind blob storage; this service binds none. The bytes
were hashed on the way in and read by the decoder, and this service only states
what they found.
"""

import os
import sys

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKAGE_DIR = os.path.join(APP_DIR, "connector")


def _sources() -> dict[str, str]:
    files = {}
    for directory in (APP_DIR, PACKAGE_DIR):
        for name in sorted(os.listdir(directory)):
            if name.endswith(".py"):
                path = os.path.join(directory, name)
                with open(path, encoding="utf-8") as handle:
                    files[name] = handle.read()
    return files


def _app_yaml() -> str:
    with open(os.path.join(APP_DIR, "app.yaml"), encoding="utf-8") as handle:
        return handle.read()


class TestNoStorageClient:
    def test_the_registry_holds_no_storage_client(self):
        from connector.registry import Registry

        registry = Registry("http://tm/api/v1", token=None)
        attributes = vars(registry)
        assert set(attributes) == {
            "base_url",
            "_http",
            "_max_backoff",
            "_max_attempts",
            "_sleep",
            "retries_spent",
        }
        registry.close()

    def test_the_connector_holds_no_storage_client(self, connector):
        names = " ".join(vars(connector)).lower()
        assert "blob" not in names
        assert "storage" not in names
        assert "filesystem" not in names

    def test_no_module_imports_quixportal(self):
        # conftest POISONS quixportal: an accidental import of its storage
        # module raises. This also pins it at the source level. Prose mentioning
        # the name is fine; an import statement is not.
        for name, source in _sources().items():
            imports = [
                line.strip()
                for line in source.splitlines()
                if line.strip().startswith(("import ", "from "))
            ]
            assert not [line for line in imports if "quixportal" in line], name

    def test_the_requirements_declare_no_blob_dependency(self):
        with open(os.path.join(APP_DIR, "requirements.txt"), encoding="utf-8") as handle:
            body = handle.read()
        installs = [
            line.strip()
            for line in body.splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        assert installs == ["quixstreams>=3.0", "httpx>=0.28.1"]

    def test_quixportal_is_never_actually_loaded(self):
        import pytest

        import connector.connector  # noqa: F401
        import connector.registry  # noqa: F401

        # The poisoned placeholder is the only thing under that name. Reaching
        # through it raises, so an accidental import could not have succeeded.
        assert "quixportal.storage" not in sys.modules
        with pytest.raises(AssertionError):
            sys.modules["quixportal"].storage


class TestAppYaml:
    def test_it_declares_no_blob_storage_bind(self):
        assert "blobStorage" not in _app_yaml()

    def test_it_never_declares_a_platform_injected_variable(self):
        body = _app_yaml()
        assert "Quix__Workspace__Id" not in body
        assert "Quix__BlobStorage__Connection__Json" not in body

    def test_no_source_reads_a_blob_connection_variable(self):
        for name, source in _sources().items():
            assert "Quix__BlobStorage" not in source, name
