"""MongoDB connection helper.

**The timeouts are not defaults and must not go back to being defaults.**
PyMongo's ``serverSelectionTimeoutMS`` is 30 000 ms. The frontend's read timeout
is 10 s. With Mongo stopped, that combination produced exactly the wrong
behaviour: the browser saw a bare ``Read timed out`` with no cause named, while
the API kept a worker blocked for another 20 s on a request nobody was waiting
for any more. The 503 that ``deps.get_db`` raises for a ``PyMongoError`` was
correct all along - it just could not run in time to be useful.

So server selection is bounded well below the client's read timeout, and the
socket and connect budgets are stated rather than inherited. The arithmetic that
matters: connect 3 s + socket 5 s = 8 s worst case for one round trip, inside the
frontend's 10 s. Retryable reads can double a socket-timeout case, which is why
the *selection* timeout - the one that fires when the server is simply gone, the
case actually observed - is the tightest of the three.

Every value is env-overridable so an operator can widen them for a slow link
without a code change.
"""

import os
from urllib.parse import quote_plus

from pymongo import MongoClient

# Fires when no server can be selected: Mongo stopped, DNS gone, wrong host.
SERVER_SELECTION_TIMEOUT_MS = int(os.environ.get("MONGO_SERVER_SELECTION_TIMEOUT_MS", "3000"))
# Fires when the TCP connect itself hangs.
CONNECT_TIMEOUT_MS = int(os.environ.get("MONGO_CONNECT_TIMEOUT_MS", "3000"))
# Fires when a connected server stops answering mid-operation.
SOCKET_TIMEOUT_MS = int(os.environ.get("MONGO_SOCKET_TIMEOUT_MS", "5000"))


def build_mongo_uri() -> str:
    """Assemble the MongoDB connection URI from discrete env vars.

    Using separate host/user/password/db vars (rather than a single
    pre-built URI) lets MONGO_PASSWORD be sourced from a Quix project
    secret and keeps special characters in credentials safe via
    urllib.parse.quote_plus.
    """
    mongo_host = os.environ["MONGO_HOST"]
    mongo_user = quote_plus(os.environ["MONGO_USER"])
    mongo_password = quote_plus(os.environ["MONGO_PASSWORD"])
    mongo_db_name = os.environ["MONGO_DB_NAME"]
    return f"mongodb://{mongo_user}:{mongo_password}@{mongo_host}/{mongo_db_name}?authSource=admin"


def get_client() -> MongoClient:
    """A client with explicit, bounded timeouts. Does no I/O at construction."""
    return MongoClient(
        build_mongo_uri(),
        serverSelectionTimeoutMS=SERVER_SELECTION_TIMEOUT_MS,
        connectTimeoutMS=CONNECT_TIMEOUT_MS,
        socketTimeoutMS=SOCKET_TIMEOUT_MS,
        appname="backend-api",
    )


def get_db(client: MongoClient):
    return client[os.environ["MONGO_DB_NAME"]]


def timeouts() -> dict:
    """The configured budgets, for ``/health`` to state rather than imply."""
    return {
        "server_selection_timeout_ms": SERVER_SELECTION_TIMEOUT_MS,
        "connect_timeout_ms": CONNECT_TIMEOUT_MS,
        "socket_timeout_ms": SOCKET_TIMEOUT_MS,
    }
