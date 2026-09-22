"""Render one requirements document per test definition.

The document is what a person reads on the definition screen: the requirement in
its EARS form with the parameter tokens resolved, the test case's objective and
pass criteria, and the evidence — which run answers it, where its rows sit in
the lake, and what verdict the generator measured.

House style is `CLAUDE.md`'s: decimal comma in a threshold, one `shall` per
requirement, every timing bound explicit.
"""

from __future__ import annotations

import re

from seed import sources

#: Where the rendered evidence points. `platform` doubles as the work order's
#: `project`, which is what the lake falls back to for a file naming no platform.
LAKE_PLATFORM = "BATTERY_DC_V1"

_TOKEN = re.compile(r"\{([A-Za-z0-9_]+)\}")


def _decimal_comma(value: float | int) -> str:
    """Render one number in house style: decimal comma, no trailing zeros."""
    text = f"{value:g}"
    return text.replace(".", ",")


def resolve_tokens(text: str, parameters: dict[str, dict]) -> str:
    """Replace each `{parameter}` token with `name = value unit`, bolded.

    A token naming no parameter stays as it is: the requirement set is the
    statement of record, and silently dropping a token would hide the gap.
    """

    def replace(match: re.Match[str]) -> str:
        parameter = parameters.get(match.group(1))
        if parameter is None:
            return match.group(0)
        return (
            f"**{parameter['name']} = {_decimal_comma(parameter['value'])} "
            f"{parameter['unit']}**"
        )

    return _TOKEN.sub(replace, text)


def resolve_display(text: str, parameters: dict[str, dict]) -> str:
    """Replace each `{parameter}` token with `name (value unit)`, plain text.

    This is `text_rendered`, the mirrored display string the requirements
    page renders (dev-planning/requirements-page/spec.md §7B) — no markdown,
    unlike `resolve_tokens`, which is the `.md` document's own house style.
    """

    def replace(match: re.Match[str]) -> str:
        parameter = parameters.get(match.group(1))
        if parameter is None:
            return match.group(0)
        return f"{parameter['name']} ({_decimal_comma(parameter['value'])} {parameter['unit']})"

    return _TOKEN.sub(replace, text)


def _parameter_table(requirement: dict, parameters: dict[str, dict]) -> list[str]:
    names = requirement.get("parameters") or []
    if not names:
        return []
    lines = [
        "### Parameters",
        "| Name | Value | Unit | Description |",
        "|---|---|---|---|",
    ]
    for name in names:
        parameter = parameters[name]
        lines.append(
            f"| `{name}` | {_decimal_comma(parameter['value'])} | "
            f"{parameter['unit']} | {parameter['description']} |"
        )
    return [*lines, ""]


def _criteria_table(spec: dict) -> list[str]:
    lines = [
        "### Pass criteria",
        "| Id | Signal | Window | Reduce | Rule | Tolerance |",
        "|---|---|---|---|---|---|",
    ]
    for criterion in spec.get("pass_criteria") or []:
        window = criterion.get("window") or {}
        states = ", ".join(str(state) for state in window.get("in") or [])
        settle = window.get("settle_s")
        window_text = f"{window.get('signal', '—')} in {{{states}}}" if states else "whole run"
        if settle is not None:
            window_text += f", settle {_decimal_comma(settle)} s"
        rule = criterion.get("rule") or {}
        value = rule.get("value")
        rule_text = f"{rule.get('op', '—')} {_decimal_comma(value)} {criterion.get('unit', '')}"
        tolerance = criterion.get("tolerance") or {}
        absolute = tolerance.get("abs")
        tolerance_text = "—" if absolute is None else f"abs {_decimal_comma(absolute)}"
        lines.append(
            f"| {criterion['criterion_id']} | `{criterion['signal']}` | {window_text} | "
            f"{(criterion.get('reduce') or {}).get('op', '—')} | {rule_text.strip()} | "
            f"{tolerance_text} |"
        )
    return [*lines, ""]


def _evidence(tc_id: str, verdict: dict, run_key: str, trace_file: str) -> list[str]:
    partition = (
        f"platform={LAKE_PLATFORM}/work_order=WO-BAT-2026-001/run_id={run_key}"
    )
    expected = verdict["expected"]
    lines = [
        "## Evidence",
        "| | |",
        "|---|---|",
        f"| Run | `{run_key}` (trace {trace_file}) |",
        f"| Lake table | `battery_data_v1`, partition `{partition}` |",
        f"| Implementation | `{tc_id}.py` |",
        f"| Expected verdict | **{expected}** |",
        f"| Expected measurement | {verdict['measured']} |",
        "",
    ]
    if expected == "FAIL":
        lines.append(
            f"> **Expected verdict: FAIL.** Mechanism: {verdict['mechanism']}. "
            f"Measured {verdict['measured']} against the limit stated above."
        )
        lines.append("")
    return lines


def render(tc_id: str) -> str:
    """The whole markdown document of one test definition."""
    parameters = sources.parameters()
    requirements = sources.requirements()
    spec = sources.test_specs()[tc_id]
    verdict = sources.verdicts()[tc_id]
    run_key = sources.run_of_definition()[tc_id]
    trace_file = sources.trace_of_definition()[tc_id]
    requirement = requirements[spec["covers_req_ids"][0]]

    lines = [
        f"# {tc_id} — {requirement['title']}",
        "",
        f"## Requirement {requirement['id']} ({requirement['chapter']}, "
        f"{requirement['ears_pattern']}, rev {requirement['revision']}, "
        f"{requirement['status']})",
        "",
        f"> {resolve_tokens(requirement['text'], parameters)}",
        "",
        "| | |",
        "|---|---|",
        "| Measurand | "
        + "; ".join(
            f"`{item['name']}` ({item['unit']})" for item in requirement["measurand"]
        )
        + " |",
        f"| System states | {', '.join(requirement.get('system_states') or []) or '—'} |",
        f"| Verification method | {requirement['verification_method']} |",
        f"| Source | {'; '.join(requirement['source'])} |",
        f"| Rationale | {requirement['rationale']} |",
        f"| Verified by (derived) | "
        f"{', '.join(sources.covers_index().get(requirement['id'], []))} |",
        "",
        *_parameter_table(requirement, parameters),
        "## Test case",
        f"**Objective.** {spec['objective']}",
        "",
        f"**Entry criteria.** {spec['entry_criteria']}",
        f"**Exit criteria.** {spec['exit_criteria']}",
        "",
        *_criteria_table(spec),
        *_evidence(tc_id, verdict, run_key, trace_file),
    ]
    return "\n".join(lines)


def render_all() -> dict[str, str]:
    """`{tc_id: markdown}` for all ten definitions, in id order."""
    return {tc_id: render(tc_id) for tc_id in sorted(sources.test_specs())}
