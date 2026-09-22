"""Write the OpenAPI snapshot the FE generates types from."""

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

from api.main import app

path = pathlib.Path(__file__).parent.parent / "docs" / "openapi.v1.json"
# `newline="\n"` on purpose: without it a Windows run writes CRLF, git stores LF,
# and the file on disk then never matches the file in the index.
path.write_text(
    json.dumps(app.openapi(), indent=2, ensure_ascii=False) + "\n",
    encoding="utf-8",
    newline="\n",
)
print(f"wrote {path}")
