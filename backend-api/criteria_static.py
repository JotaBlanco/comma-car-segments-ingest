"""Static pass-criteria checks against the pinned signal catalogue (spec 3.5).

These run at **baseline creation**, not at upload: an upload may legitimately
reference a signal-catalogue version that is not yet pinned. Once a baseline
exists, every criterion in it is known to be evaluable before any data arrives -
which is the whole point of naming the channel, the group, the reduction and the
unit in the criterion.

Finding codes come from the closed enum in ``baseline-1.0.0.schema.json``.
"""

import units

REFERENCE_ROLE = "reference"


def finding(severity: str, code: str, message: str, entity_id: str = "") -> dict:
    return {"severity": severity, "code": code, "message": message, "entity_id": entity_id}


def _signals_referenced(criterion: dict) -> list[tuple[str, str]]:
    """Every signal a criterion touches, as ``(signal, where)`` pairs.

    A window or an event may name a *different* channel from the criterion's
    primary signal (the 10 Hz ``ACC_Status`` gating a 100 Hz measurement is the
    canonical case), and those references have to exist too.
    """
    found: list[tuple[str, str]] = [(criterion["signal"], "signal")]

    def from_event(event: dict, where: str) -> None:
        if isinstance(event, dict) and event.get("signal"):
            found.append((event["signal"], where))

    def from_window(window: dict, where: str) -> None:
        if not isinstance(window, dict):
            return
        kind = window.get("type")
        if kind in ("state_mask", "signal_threshold") and window.get("signal"):
            found.append((window["signal"], f"{where}.signal"))
        elif kind == "event_relative":
            from_event(window.get("event") or {}, f"{where}.event")
        elif kind == "all_of":
            for index, part in enumerate(window.get("parts") or []):
                from_window(part, f"{where}.parts[{index}]")

    from_window(criterion.get("window") or {}, "window")
    reduce_spec = criterion.get("reduce") or {}
    for key in ("from", "to", "at"):
        from_event(reduce_spec.get(key) or {}, f"reduce.{key}")
    return found


def check_criterion(tc_id: str, criterion: dict, catalog: dict[str, dict]) -> list[dict]:
    """Findings for one criterion. Empty list means statically evaluable."""
    findings: list[dict] = []
    label = f"{tc_id}/{criterion.get('criterion_id')}"

    for signal, where in _signals_referenced(criterion):
        entry = catalog.get(signal)
        if entry is None:
            findings.append(
                finding(
                    "error",
                    "unknown_signal",
                    f"{label}: {where} names {signal!r}, absent from the pinned signal catalogue",
                    label,
                )
            )
            continue
        if entry.get("role") == REFERENCE_ROLE:
            findings.append(
                finding(
                    "error",
                    "reference_group_signal",
                    (
                        f"{label}: {where} names {signal!r} whose role is 'reference' "
                        f"(channel group {entry.get('channel_group')}); a real vehicle log has "
                        "no ground truth, so no verdict may depend on it"
                    ),
                    label,
                )
            )

    primary = catalog.get(criterion["signal"])
    if primary is None:
        return findings

    if primary.get("channel_group") != criterion.get("channel_group"):
        findings.append(
            finding(
                "error",
                "signal_group_mismatch",
                (
                    f"{label}: criterion declares channel_group "
                    f"{criterion.get('channel_group')!r} but the catalogue puts "
                    f"{criterion['signal']!r} in {primary.get('channel_group')!r}"
                ),
                label,
            )
        )

    reduce_op = (criterion.get("reduce") or {}).get("op", "none")
    try:
        expected = units.transform(primary.get("unit"), reduce_op)
        declared = units.parse(criterion.get("unit"))
    except units.UnitParseError as exc:
        findings.append(
            finding("error", "unit_algebra_mismatch", f"{label}: {exc}", label)
        )
        return findings

    if expected != declared:
        findings.append(
            finding(
                "error",
                "unit_algebra_mismatch",
                (
                    f"{label}: reduce '{reduce_op}' of {primary.get('unit')!r} yields "
                    f"{units.render(expected)!r}, but the criterion declares "
                    f"{criterion.get('unit')!r}"
                ),
                label,
            )
        )
    return findings


def check_test_case(test_case: dict, catalog: dict[str, dict]) -> list[dict]:
    """Findings for every pass criterion and precondition gate of one case."""
    tc_id = test_case.get("tc_id", "")
    findings: list[dict] = []
    for criterion in test_case.get("pass_criteria") or []:
        findings.extend(check_criterion(tc_id, criterion, catalog))
    for gate in (test_case.get("preconditions") or {}).get("gates") or []:
        findings.extend(check_criterion(tc_id, gate, catalog))
    return findings
