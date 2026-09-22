"""Push docs/test-manager-agent.md to the Quix.AI org agent it describes.

The markdown file is the source of truth; the Portal's stored prompt is a
cache of it (AI-SIDEBAR §10, U-1). The script parses the file's front fields
(name, displayName, description) and the text between the prompt markers,
resolves the agent BY NAME via ``GET {portal}/ai/api/org/agents``, and PUTs
the full agent body back with the file's prompt. ``isDefault``/``isEnabled``
are preserved from the live agent — syncing a prompt never flips enablement.

Env:   portal base per ``api.services.ai_client.portal_base()``
       ``QUIX_PORTAL_TOKEN`` — portal user bearer (not needed for --dry-run)

Usage: uv run python scripts/sync_agent_prompt.py [--dry-run]
       (--dry-run parses and prints the would-be prompt; fully offline)
"""

import argparse
import os
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

import httpx

from api.services.ai_client import portal_base

DOC = pathlib.Path(__file__).parent.parent / "docs" / "test-manager-agent.md"
BEGIN = "<!-- prompt:begin -->"
END = "<!-- prompt:end -->"
_FIELD = re.compile(r"^- \*\*(name|displayName|description):\*\* (.+)$", re.MULTILINE)


def parse_doc(text: str) -> dict[str, str]:
    """Return {name, displayName, description, systemPrompt} from the doc."""
    fields = {key: value.strip().strip("`") for key, value in _FIELD.findall(text)}
    missing = {"name", "displayName", "description"} - fields.keys()
    if missing:
        raise SystemExit(f"{DOC}: missing front fields: {', '.join(sorted(missing))}")
    try:
        start = text.index(BEGIN) + len(BEGIN)
        end = text.index(END, start)
    except ValueError:
        raise SystemExit(f"{DOC}: prompt markers {BEGIN} … {END} not found") from None
    fields["systemPrompt"] = text[start:end].strip("\n")
    return fields


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--dry-run", action="store_true", help="parse and print the prompt; write nothing"
    )
    args = parser.parse_args()

    doc = parse_doc(DOC.read_text(encoding="utf-8"))
    prompt = doc["systemPrompt"]

    if args.dry_run:
        print(f"agent {doc['name']!r} — {doc['displayName']} — prompt {len(prompt)} chars")
        print()
        print(prompt)
        return

    base = portal_base()
    if not base:
        raise SystemExit(
            "No portal base configured (Quix__Portal__Api)"
        )
    token = os.environ.get("QUIX_PORTAL_TOKEN", "").strip()
    if not token:
        raise SystemExit("QUIX_PORTAL_TOKEN is not set")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    with httpx.Client(timeout=30) as client:
        response = client.get(f"{base}/ai/api/org/agents", headers=headers)
        response.raise_for_status()
        agent = next(
            (item for item in response.json() or [] if item.get("name") == doc["name"]), None
        )
        if agent is None:
            raise SystemExit(
                f"agent {doc['name']!r} not found in the org — create it first (AI-SIDEBAR §3)"
            )

        before = len(agent.get("systemPrompt") or "")
        body = {
            "name": doc["name"],
            "displayName": doc["displayName"],
            "description": doc["description"],
            "systemPrompt": prompt,
            "isDefault": agent.get("isDefault", False),
            "isEnabled": agent.get("isEnabled", False),
        }
        put = client.put(f"{base}/ai/api/org/agents/{agent['id']}", headers=headers, json=body)
        put.raise_for_status()

    print(f"synced {doc['name']} ({agent['id']}): prompt {before} -> {len(prompt)} chars")


if __name__ == "__main__":
    main()
