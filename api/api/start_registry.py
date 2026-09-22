"""Start the registry against the Configuration Manager's Mongo.

Overlay file (this estate's, like api/app.yaml and api/api/config_push.py; it sits inside the
package because the image copies only api/, mock_planning/, seed/ and ingest/). The mirrored
API takes one MONGO_URL string,
while the Configuration Manager is configured with pieces - host, user and a password secret.
This builds the URL from the same pieces (URL-encoded, so a password with @ : / or % is fine)
and hands over to uvicorn, exactly as the image's default command would. The deployment runs it
through TM_COMMAND, which the image expands with `sh -c "exec ${TM_COMMAND}"`: a value with
quotes in it is split into words, never re-parsed, so the command has to be this plain.
"""

import os
from urllib.parse import quote

user = os.environ["MONGO_USER"]
password = os.environ["MONGO_PASSWORD"]
host = os.environ.get("MONGO_HOST", "config-mongo")
port = os.environ.get("MONGO_PORT", "27017")
os.environ["MONGO_URL"] = f"mongodb://{quote(user, '')}:{quote(password, '')}@{host}:{port}"
os.execvp("uvicorn", ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"])  # noqa: S606
