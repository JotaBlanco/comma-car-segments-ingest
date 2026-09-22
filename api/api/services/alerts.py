"""The quarantine alert (FR-DM-004).

The acceptance clause of FR-DM-004 reads: "the file is quarantined (isolated),
**an alert is raised**, and error details are logged". Two of the three passed
and the middle one had no code anywhere.

## The channel

**The requirement names no channel, and this deployment carries no target.**
No SMTP host and no webhook URL reaches the Test Manager API, and inventing a
name for one would give an operator a switch nobody sets. So the alert is a
**structured WARNING log line**, which is the same answer FR-DM-055 took for
the refused logins (`api/api/auth.py` `_refuse`). A cluster log rule reads a
line; a person reads the Home needs-attention panel, which already counts the
quarantine (`api/api/services/queries_runs.py`).

`raise_quarantine_alert` is the one seam a real channel plugs into later. A
webhook or an SMTP call goes inside this function and nowhere else.

## The alert never breaks the ingestion

`POST /files` stores the quarantined file and journals it FIRST. The alert runs
last, and this module swallows every failure into a log line. The never-drop
rule beats the alert: a file must land even when nobody can be told about it.

**A log line carries no credential.** It names the file, the run and the
reason, which is what an operator acts on.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# The prefix a log rule matches on. Keep it stable: an operator's alert rule
# reads this string, so a reword breaks the rule in silence.
ALERT_PREFIX = "QUARANTINE ALERT"


def raise_quarantine_alert(file_doc: dict) -> None:
    """Raise the alert for one quarantined file. Never raise an exception.

    The caller runs this after the file and its journal entry are stored, so a
    failure here loses the alert and never the file.
    """
    try:
        logger.warning(
            "%s file=%s filename=%s run=%s reason=%s",
            ALERT_PREFIX,
            file_doc.get("_id"),
            file_doc.get("filename"),
            file_doc.get("run_id"),
            file_doc.get("quarantine_reason"),
        )
    except Exception:  # noqa: BLE001, S110 — an alert must never fail an ingestion.
        # Nothing is logged here on purpose. The line above is the log call, so
        # a second one would take the path that just failed. The file and its
        # journal entry are already stored, and losing the alert is the cheap
        # half of this pair.
        pass
