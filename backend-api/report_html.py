"""``report.html`` - a single self-contained file rendered from ``report.json``.

Chosen over server-side PDF because the report must carry clickable links back to
requirements, test cases and implementations, and because a PDF would need a
headless browser in the image. A print stylesheet makes the browser's own
"Print to PDF" produce a sane artifact, so nothing is lost.

The renderer reads *only* ``report.json`` plus the already-rendered plot SVGs.
That is what makes the HTML and the JSON twins rather than two independent
summaries that can disagree.
"""

from settings import VERDICTS

STYLE = """
:root{--fg:#1b1b1b;--bg:#fff;--muted:#666;--line:#dcdcdc;--pass:#1e7d32;
--fail:#c0392b;--warn:#b8860b;--info:#2c5f8a}
*{box-sizing:border-box}
body{margin:0;padding:1.5rem;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;
color:var(--fg);background:var(--bg)}
main{max-width:1100px;margin:0 auto}
h1{font-size:1.5rem;margin:.2rem 0 1rem}
h2{font-size:1.15rem;margin:2rem 0 .5rem;border-bottom:1px solid var(--line);
padding-bottom:.25rem}
h3{font-size:1rem;margin:1.2rem 0 .4rem}
table{border-collapse:collapse;width:100%;margin:.5rem 0 1rem;font-size:.9rem}
th,td{border:1px solid var(--line);padding:.35rem .5rem;text-align:left;
vertical-align:top}
th{background:#f6f6f6;font-weight:600}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em}
.header-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.25rem 1rem;
border:1px solid var(--line);padding:.75rem;background:#fafafa}
.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.6rem;margin:.6rem 0}
.card{border:1px solid var(--line);padding:.6rem;background:#fafafa}
.card .v{font-size:1.3rem;font-weight:600}
.card .d{color:var(--muted);font-size:.78rem}
.badge{display:inline-block;padding:0 .4rem;border-radius:3px;font-size:.78rem;
border:1px solid currentColor}
.v-pass{color:var(--pass)}.v-fail{color:var(--fail)}
.v-not_run{color:var(--muted)}.v-error{color:var(--fail)}
.v-inconclusive{color:var(--warn)}.v-partial{color:var(--info)}
.banner{border:1px solid var(--warn);background:#fff8e5;padding:.6rem;margin:.6rem 0}
.plot{border:1px solid var(--line);padding:.4rem;margin:.5rem 0}
.muted{color:var(--muted)}
@media (max-width:900px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}
.header-grid{grid-template-columns:1fr}}
@media (max-width:560px){.cards{grid-template-columns:1fr}body{padding:.75rem}}
@media print{body{padding:0}h2{page-break-after:avoid}table{page-break-inside:avoid}
.plot{page-break-inside:avoid}a{color:inherit;text-decoration:none}}
"""


NONE_CELL = '<span class="muted">none</span>'
NONE_ITEM = '<li class="muted">none</li>'


def _escape(value) -> str:
    return (
        str("" if value is None else value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _pct(value) -> str:
    return "n/a" if value is None else f"{value * 100:.1f}%"


def _verdict(value: str) -> str:
    return f'<span class="badge v-{_escape(value)}">{_escape(value)}</span>'


def _req_link(req_id: str, baseline_id: str, frontend_base: str) -> str:
    if not frontend_base:
        return f'<a href="#req-{_escape(req_id)}"><code>{_escape(req_id)}</code></a>'
    url = f"{frontend_base.rstrip('/')}/Requirements?baseline={baseline_id}&req_id={req_id}"
    return f'<a href="{_escape(url)}"><code>{_escape(req_id)}</code></a>'


def _tc_link(tc_id: str, baseline_id: str, frontend_base: str) -> str:
    if not frontend_base:
        return f'<a href="#tc-{_escape(tc_id)}"><code>{_escape(tc_id)}</code></a>'
    url = (
        f"{frontend_base.rstrip('/')}/Test_Specification"
        f"?baseline={baseline_id}&tc_id={tc_id}"
    )
    return f'<a href="{_escape(url)}"><code>{_escape(tc_id)}</code></a>'


def render(report: dict, plots: dict[str, str], frontend_base: str = "") -> str:
    """Render the whole report. ``plots`` maps file name to inline SVG markup."""
    header = report["header"]
    metrics = report["metrics"]
    baseline_id = header["baseline_id"]
    parts: list[str] = [
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        f"<title>Test report {_escape(report['test_run_id'])} "
        f"v{report['run_version']} {_escape(report['revision'])}</title>",
        f"<style>{STYLE}</style></head><body><main>",
        f"<h1>Test report - {_escape(report['test_run_id'])} "
        f"v{report['run_version']} {_escape(report['revision'])}</h1>",
    ]

    if header.get("provenance_override"):
        parts.append(
            '<p class="banner"><strong>Provenance override active.</strong> This run carries '
            "<code>allow_provenance_mismatch: true</code>: at least one trace was accepted "
            "although its embedded <code>config_hash12</code> did not match the pinned "
            "parameter set. Verdicts below are conditional on that human override.</p>"
        )

    parts.append(_header_block(report, header))
    parts.append(_summary(report, metrics))
    parts.append(_deviations(report, baseline_id, frontend_base))
    parts.append(_completion(report, baseline_id, frontend_base))
    parts.append(_blockers(report))
    parts.append(_measures(report, baseline_id, frontend_base, plots))
    parts.append(_residual_risks(report, baseline_id, frontend_base))
    parts.append(_deliverables(report))
    parts.append(_reusable_assets(report))
    parts.append(
        "<h2>7.4.10 Lessons learned</h2><p>"
        + (_escape(report.get("lessons_learned")) or '<span class="muted">none recorded</span>')
        + "</p>"
    )
    parts.append(_annex(report))
    parts.append("</main></body></html>")
    return "".join(parts)


def _header_block(report: dict, header: dict) -> str:
    rows = [
        ("Device", f"{header['device_id']} sw{header['sw_version']} / hw{header['hw_version']}"),
        ("Baseline", header["baseline_id"]),
        (
            "Parameter set",
            f"{header.get('config_id') or 'none'}@v{header.get('config_version')} "
            f"({header.get('config_hash12') or 'no hash'})",
        ),
        ("Run", f"{report['test_run_id']} v{report['run_version']} {report['revision']}"),
        ("Generated", report["generated_utc"]),
        ("Evaluator", report["evaluator_version"]),
        ("Generator", report["report_generator_version"]),
        ("inputs_digest", report["inputs_digest"]),
        ("Reproducible", "yes" if report.get("reproducible") else "inputs changed"),
        ("Version descriptor", header.get("version_descriptor") or ""),
    ]
    cells = "".join(
        f"<div><strong>{_escape(label)}</strong><br><span class=\"mono\">"
        f"{_escape(value)}</span></div>"
        for label, value in rows
    )
    return f'<div class="header-grid">{cells}</div>'


def _summary(report: dict, metrics: dict) -> str:
    denominators = metrics.get("denominators") or {}
    cards = [
        ("Coverage (testable)", _pct(metrics.get("requirement_coverage_testable")),
         f"denominator {denominators.get('requirements_testable')} requirements"),
        ("Coverage (all)", _pct(metrics.get("requirement_coverage_all")),
         f"denominator {denominators.get('requirements_all')} requirements"),
        ("Verification coverage", _pct(metrics.get("requirement_verification_coverage")),
         "covered and passing / all"),
        ("Static coverage", _pct(metrics.get("baseline_coverage_static")),
         "run-independent, from the baseline"),
        ("Passed", metrics.get("tc_passed"), "cases"),
        ("Failed", metrics.get("tc_failed"), "cases"),
        ("Not run", metrics.get("tc_not_run"), "cases"),
        ("Error / inconclusive",
         f"{metrics.get('tc_error')} / {metrics.get('tc_inconclusive')}", "cases"),
    ]
    card_html = "".join(
        f'<div class="card"><div class="d">{_escape(label)}</div>'
        f'<div class="v">{_escape(value)}</div><div class="d">{_escape(note)}</div></div>'
        for label, value, note in cards
    )

    chapter_rows = "".join(
        f"<tr><td>{_escape(chapter)}</td><td>{_pct(value)}</td>"
        f"<td>{_escape((denominators.get('requirements_by_chapter') or {}).get(chapter))}</td></tr>"
        for chapter, value in sorted((metrics.get("requirement_coverage_chapter") or {}).items())
    )

    sum_check = metrics.get("sum_check_ok")
    total = sum(int(metrics.get(f"tc_{name}") or 0) for name in VERDICTS)
    return (
        "<h2>7.4.1 Overview and 7.4.2 Summary of testing performed</h2>"
        f"<p>Scope selector: <code>{_escape((report.get('scope') or {}).get('selector'))}</code>. "
        f"{len((report.get('scope') or {}).get('planned_tc_ids') or [])} test case(s) planned. "
        f"{_escape((report.get('scope') or {}).get('expansion_note') or '')}</p>"
        f'<div class="cards">{card_html}</div>'
        "<h3>Coverage per chapter</h3>"
        "<table><tr><th>Chapter</th><th>Coverage</th><th>Requirements</th></tr>"
        f"{chapter_rows}</table>"
        "<h3>Pass rates</h3>"
        "<table><tr><th>Metric</th><th>Value</th><th>Denominator</th></tr>"
        f"<tr><td>tc_pass_rate_planned</td><td>{_pct(metrics.get('tc_pass_rate_planned'))}</td>"
        f"<td>{denominators.get('planned_test_cases')} planned</td></tr>"
        f"<tr><td>tc_pass_rate_executed</td><td>{_pct(metrics.get('tc_pass_rate_executed'))}</td>"
        f"<td>{denominators.get('executed_test_cases')} executed (pass+fail)</td></tr>"
        f"<tr><td>tc_execution_rate</td><td>{_pct(metrics.get('tc_execution_rate'))}</td>"
        f"<td>{denominators.get('planned_test_cases')} planned</td></tr></table>"
        f"<p><strong>Sum check</strong>: passed+failed+not_run+error+inconclusive = {total}, "
        f"planned = {denominators.get('planned_test_cases')} - "
        f"{'OK' if sum_check else 'MISMATCH'}.</p>"
    )


def _deviations(report: dict, baseline_id: str, frontend_base: str) -> str:
    rows = "".join(
        f"<tr><td>{_tc_link(entry['tc_id'], baseline_id, frontend_base)}</td>"
        f"<td>{_verdict(entry.get('verdict', 'not_run'))}</td>"
        f"<td><code>{_escape(entry.get('reason_code'))}</code></td>"
        f"<td>{_escape(entry.get('note') or '')}</td></tr>"
        for entry in report.get("deviations") or []
    )
    body = (
        "<table><tr><th>Test case</th><th>Verdict</th><th>Reason</th><th>Note</th></tr>"
        f"{rows}</table>"
        if rows
        else '<p class="muted">Every planned case produced evidence.</p>'
    )
    return f"<h2>7.4.3 Deviations from planned testing</h2>{body}"


def _completion(report: dict, baseline_id: str, frontend_base: str) -> str:
    rows = []
    for entry in report.get("requirement_verdicts") or []:
        covering = " ".join(
            _tc_link(tc_id, baseline_id, frontend_base)
            for tc_id in entry.get("covering_tc_ids") or []
        )
        rows.append(
            f'<tr id="req-{_escape(entry["req_id"])}">'
            f"<td>{_req_link(entry['req_id'], baseline_id, frontend_base)}</td>"
            f"<td>{_verdict(entry['verdict'])}</td>"
            f"<td>{covering or NONE_CELL}</td>"
            f"<td>{len(entry.get('passed_tc_ids') or [])}</td>"
            f"<td>{len(entry.get('failed_tc_ids') or [])}</td>"
            f"<td>{len(entry.get('not_run_tc_ids') or [])}</td></tr>"
        )
    return (
        "<h2>7.4.4 Test completion evaluation</h2>"
        "<table><tr><th>Requirement</th><th>Verdict</th><th>Covering cases</th>"
        "<th>Passed</th><th>Failed</th><th>Not run</th></tr>"
        f"{''.join(rows)}</table>"
    )


def _blockers(report: dict) -> str:
    rows = "".join(
        f"<tr><td><code>{_escape(entry.get('tc_id'))}</code></td>"
        f"<td><code>{_escape(entry.get('reason_code'))}</code></td>"
        f"<td>{_escape(entry.get('message') or '')}</td></tr>"
        for entry in report.get("blockers") or []
    )
    body = (
        "<table><tr><th>Test case</th><th>Reason</th><th>Detail</th></tr>"
        f"{rows}</table>"
        if rows
        else '<p class="muted">Nothing blocked progress.</p>'
    )
    return f"<h2>7.4.5 Factors that blocked progress</h2>{body}"


def _measures(report: dict, baseline_id: str, frontend_base: str,
              plots: dict[str, str]) -> str:
    blocks = []
    for result in report.get("results") or []:
        criterion_rows = "".join(
            "<tr>"
            f"<td><code>{_escape(criterion.get('criterion_id'))}</code></td>"
            f"<td>{_escape(criterion.get('signal'))}</td>"
            f"<td>{_escape(criterion.get('actual'))}</td>"
            f"<td>{_escape(criterion.get('rule_op'))} {_escape(criterion.get('bound'))}</td>"
            f"<td>{_escape(criterion.get('unit'))}</td>"
            f"<td>{_escape(criterion.get('tolerance'))}</td>"
            f"<td>{_escape(criterion.get('uncertainty_s'))}</td>"
            f"<td>{_escape(criterion.get('quantifier'))}</td>"
            f"<td>{_verdict(criterion.get('verdict', 'not_run'))}</td></tr>"
            for criterion in result.get("criteria") or []
        )
        alignment = result.get("alignment") or {}
        plot_markup = "".join(
            f'<div class="plot">{plots[name]}</div>'
            for name in sorted(plots)
            if name.startswith(f"{result['tc_id']}-")
        )
        requirement_links = " ".join(
            _req_link(req_id, baseline_id, frontend_base)
            for req_id in result.get("req_ids") or []
        )
        blocks.append(
            f'<h3 id="tc-{_escape(result["tc_id"])}">{_escape(result["tc_id"])} '
            f"{_verdict(result['verdict'])} "
            f"<code>{_escape(result.get('reason_code') or '')}</code></h3>"
            f"<p>Covers {requirement_links or '-'}; traces "
            f"<code>{_escape(', '.join(result.get('trace_keys') or []) or 'none')}</code>; "
            f"alignment <code>{_escape(alignment.get('method') or 'n/a')}</code> "
            f"base <code>{_escape(alignment.get('base_group') or 'n/a')}</code> "
            f"filled <code>{_escape(', '.join(alignment.get('filled_groups') or []) or '-')}"
            "</code></p>"
            + (
                "<table><tr><th>Criterion</th><th>Signal</th><th>Actual</th><th>Bound</th>"
                "<th>Unit</th><th>Tolerance</th><th>uncertainty_s</th><th>Quantifier</th>"
                f"<th>Verdict</th></tr>{criterion_rows}</table>"
                if criterion_rows
                else '<p class="muted">No criterion was evaluated.</p>'
            )
            + plot_markup
        )
    return (
        "<h2>7.4.6 Test measures</h2>"
        "<p>Measurement uncertainty is reported and is <strong>never</strong> subtracted from a "
        "bound. Tolerance is declared per criterion and always shown.</p>"
        f"{''.join(blocks)}"
    )


def _residual_risks(report: dict, baseline_id: str, frontend_base: str) -> str:
    cells = []
    for entry in report.get("residual_risks") or []:
        entity_id = entry.get("entity_id")
        if entry.get("kind") == "uncovered_requirement" and entity_id:
            entity = _req_link(entity_id, baseline_id, frontend_base)
        else:
            entity = _escape(entity_id)
        cells.append(
            f"<tr><td>{_escape(entry.get('kind'))}</td>"
            f"<td>{entity}</td>"
            f"<td>{_escape(entry.get('message'))}</td>"
            f"<td>{_escape(entry.get('source') or '')}</td></tr>"
        )
    rows = "".join(cells)
    return (
        "<h2>7.4.7 Residual risks</h2>"
        "<table><tr><th>Kind</th><th>Entity</th><th>Statement</th><th>Source</th></tr>"
        f"{rows}</table>"
    )


def _deliverables(report: dict) -> str:
    deliverables = report.get("deliverables") or {}
    trace_rows = "".join(
        f"<tr><td><code>{_escape(trace.get('trace_key'))}</code></td>"
        f"<td><code>{_escape(trace.get('blob_path'))}</code></td>"
        f"<td><code>{_escape((trace.get('content_sha256') or '')[:16])}</code></td>"
        f"<td>{_escape((trace.get('mf4') or {}).get('run_id'))}</td>"
        f"<td>{_escape((trace.get('mf4') or {}).get('scenario_name'))}</td>"
        f"<td>{_escape((trace.get('mf4') or {}).get('config_hash12'))}</td></tr>"
        for trace in deliverables.get("traces") or []
    )
    query_rows = "".join(
        f"<li><code>{_escape(query)}</code></li>" for query in deliverables.get("queries") or []
    )
    return (
        "<h2>7.4.8 Test deliverables</h2>"
        "<table><tr><th>Trace</th><th>Blob path</th><th>sha256</th><th>MF4 run_id</th>"
        f"<th>Scenario</th><th>config_hash12</th></tr>{trace_rows}</table>"
        f"<p>Lake tables: <code>{_escape(', '.join(deliverables.get('lake_tables') or []))}"
        "</code></p>"
        f"<h3>Queries used</h3><ul>{query_rows or NONE_ITEM}</ul>"
    )


def _reusable_assets(report: dict) -> str:
    baseline = report.get("baseline") or {}
    rows = "".join(
        f"<tr><td>{_escape(key)}</td><td><code>{_escape(value)}</code></td></tr>"
        for key, value in sorted(baseline.items())
        if key != "set_hashes"
    )
    hash_rows = "".join(
        f"<tr><td>{_escape(key)}</td><td><code>{_escape(value)}</code></td></tr>"
        for key, value in sorted((baseline.get("set_hashes") or {}).items())
    )
    return (
        "<h2>7.4.9 Reusable test assets</h2>"
        f"<table><tr><th>Pin</th><th>Version</th></tr>{rows}</table>"
        f"<table><tr><th>Set</th><th>set_canonical_sha256</th></tr>{hash_rows}</table>"
    )


def _annex(report: dict) -> str:
    parameter_set = report.get("parameter_set") or {}
    preview_rows = "".join(
        f"<tr><td><code>{_escape(entry.get('tc_id'))}</code></td>"
        f"<td><code>{_escape(entry.get('criterion_id'))}</code></td>"
        f"<td>{_escape(entry.get('signal'))}</td>"
        f"<td>{_escape(entry.get('point_count'))}</td>"
        f"<td>x{_escape(entry.get('decimation_factor'))}</td>"
        f"<td>{_escape(entry.get('t_s_first'))} .. {_escape(entry.get('t_s_last'))}</td></tr>"
        for entry in report.get("data_preview") or []
    )
    return (
        "<h2>Annex - input and output data</h2>"
        "<h3>Parameter set as stored</h3>"
        f"<pre class=\"mono\">{_escape(parameter_set)}</pre>"
        "<h3>Decimated series previews</h3>"
        "<table><tr><th>Case</th><th>Criterion</th><th>Signal</th><th>Points</th>"
        f"<th>Decimation</th><th>t_s span</th></tr>{preview_rows}</table>"
        "<p class=\"muted\">Full series are not duplicated here; they are addressed by the "
        "queries in 7.4.8 against the lake tables, keyed by <code>trace_key</code>.</p>"
    )
