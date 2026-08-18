import os
import sys

os.environ.setdefault("MONGO_HOST", "mongodb:27017")
os.environ.setdefault("MONGO_USER", "admin")
os.environ.setdefault("MONGO_PASSWORD", "test-password")
os.environ.setdefault("MONGO_DB_NAME", "testmanager")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from main import build_mongo_uri


def test_build_mongo_uri_assembles_connection_string_from_env_vars(monkeypatch):
    monkeypatch.setenv("MONGO_HOST", "mongodb:27017")
    monkeypatch.setenv("MONGO_USER", "admin")
    monkeypatch.setenv("MONGO_PASSWORD", "s3cr3t")
    monkeypatch.setenv("MONGO_DB_NAME", "testmanager")

    uri = build_mongo_uri()

    assert uri == "mongodb://admin:s3cr3t@mongodb:27017/testmanager?authSource=admin"


def test_build_mongo_uri_escapes_special_characters(monkeypatch):
    monkeypatch.setenv("MONGO_HOST", "mongodb:27017")
    monkeypatch.setenv("MONGO_USER", "ad min")
    monkeypatch.setenv("MONGO_PASSWORD", "p@ss/word:123")
    monkeypatch.setenv("MONGO_DB_NAME", "testmanager")

    uri = build_mongo_uri()

    assert uri == "mongodb://ad+min:p%40ss%2Fword%3A123@mongodb:27017/testmanager?authSource=admin"
