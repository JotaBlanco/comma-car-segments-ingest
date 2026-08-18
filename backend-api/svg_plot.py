"""Self-contained SVG plots for the report and for page 5.

Hand-rolled rather than matplotlib on purpose: the report must be a single
self-contained HTML file with no CDN, no external font and no JavaScript, and the
same SVG bytes have to be servable to the frontend so that the page and the
report show the identical artifact. A plotting stack would add a heavy
dependency to produce a few hundred line segments.

Colours use ``currentColor`` where possible so the plot inherits the page's
theme, matching the convention of the requirement figures.
"""

WIDTH = 720
HEIGHT = 260
PAD_LEFT = 62
PAD_RIGHT = 16
PAD_TOP = 22
PAD_BOTTOM = 34
MAX_POINTS = 2000


def decimate(t_values: list[float], y_values: list[float],
             max_points: int = MAX_POINTS) -> tuple[list[float], list[float], int]:
    """Uniform decimation, reporting the factor so the report can state it."""
    count = min(len(t_values), len(y_values))
    if count <= max_points:
        return list(t_values[:count]), list(y_values[:count]), 1
    factor = (count + max_points - 1) // max_points
    return t_values[:count:factor], y_values[:count:factor], factor


def _scale(value: float, lo: float, hi: float, out_lo: float, out_hi: float) -> float:
    if hi == lo:
        return (out_lo + out_hi) / 2
    return out_lo + (value - lo) * (out_hi - out_lo) / (hi - lo)


def _escape(text: str) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def criterion_plot(
    title: str,
    signal: str,
    unit: str,
    t_values: list[float],
    y_values: list[float],
    bound: float | None = None,
    bound2: float | None = None,
    tolerance_abs: float | None = None,
    window_spans: list[tuple[float, float]] | None = None,
) -> str:
    """One criterion: the evaluated signal, its bound and its tolerance band."""
    t_plot, y_plot, factor = decimate(t_values, y_values)
    if not t_plot:
        return _empty_plot(title, "no samples in the evaluation window")

    t_lo, t_hi = min(t_plot), max(t_plot)
    candidates = [*y_plot]
    for extra in (bound, bound2):
        if extra is not None:
            candidates.append(extra)
    y_lo, y_hi = min(candidates), max(candidates)
    span = (y_hi - y_lo) or (abs(y_hi) or 1.0)
    y_lo -= 0.08 * span
    y_hi += 0.08 * span

    plot_x0, plot_x1 = PAD_LEFT, WIDTH - PAD_RIGHT
    plot_y0, plot_y1 = HEIGHT - PAD_BOTTOM, PAD_TOP

    parts = [
        (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH} {HEIGHT}" '
            f'width="100%" role="img" aria-label="{_escape(title)}">'
        ),
        (
            "<style>"
            ".axis{stroke:currentColor;stroke-width:1;opacity:.45}"
            ".grid{stroke:currentColor;stroke-width:.5;opacity:.15}"
            ".trace{fill:none;stroke:currentColor;stroke-width:1.4}"
            ".bound{stroke:#c0392b;stroke-width:1.2;stroke-dasharray:5 3}"
            ".band{fill:#c0392b;opacity:.12}"
            ".win{fill:currentColor;opacity:.06}"
            ".lbl{font:11px sans-serif;fill:currentColor;opacity:.8}"
            ".ttl{font:12px sans-serif;fill:currentColor}"
            "</style>"
        ),
        f'<text class="ttl" x="{PAD_LEFT}" y="14">{_escape(title)}</text>',
    ]

    for span_start, span_end in window_spans or []:
        x_start = _scale(span_start, t_lo, t_hi, plot_x0, plot_x1)
        x_end = _scale(span_end, t_lo, t_hi, plot_x0, plot_x1)
        parts.append(
            f'<rect class="win" x="{x_start:.1f}" y="{plot_y1}" '
            f'width="{max(x_end - x_start, 0.5):.1f}" height="{plot_y0 - plot_y1}"/>'
        )

    if bound is not None and tolerance_abs:
        band_lo = _scale(bound - abs(tolerance_abs), y_lo, y_hi, plot_y0, plot_y1)
        band_hi = _scale(bound + abs(tolerance_abs), y_lo, y_hi, plot_y0, plot_y1)
        parts.append(
            f'<rect class="band" x="{plot_x0}" y="{min(band_lo, band_hi):.1f}" '
            f'width="{plot_x1 - plot_x0}" height="{abs(band_hi - band_lo):.1f}"/>'
        )

    for fraction in (0.0, 0.25, 0.5, 0.75, 1.0):
        y_pixel = plot_y1 + fraction * (plot_y0 - plot_y1)
        value = y_hi - fraction * (y_hi - y_lo)
        parts.append(
            f'<line class="grid" x1="{plot_x0}" y1="{y_pixel:.1f}" '
            f'x2="{plot_x1}" y2="{y_pixel:.1f}"/>'
        )
        parts.append(
            f'<text class="lbl" x="6" y="{y_pixel + 3:.1f}">{value:.3g}</text>'
        )

    for extra, label in ((bound, "bound"), (bound2, "bound2")):
        if extra is None:
            continue
        y_pixel = _scale(extra, y_lo, y_hi, plot_y0, plot_y1)
        parts.append(
            f'<line class="bound" x1="{plot_x0}" y1="{y_pixel:.1f}" '
            f'x2="{plot_x1}" y2="{y_pixel:.1f}"/>'
        )
        parts.append(
            f'<text class="lbl" x="{plot_x1 - 58}" y="{y_pixel - 4:.1f}">'
            f"{_escape(label)} {extra:.4g}</text>"
        )

    points = " ".join(
        f"{_scale(t, t_lo, t_hi, plot_x0, plot_x1):.1f},"
        f"{_scale(y, y_lo, y_hi, plot_y0, plot_y1):.1f}"
        for t, y in zip(t_plot, y_plot, strict=False)
    )
    parts.append(f'<polyline class="trace" points="{points}"/>')

    parts.append(
        f'<line class="axis" x1="{plot_x0}" y1="{plot_y0}" x2="{plot_x1}" y2="{plot_y0}"/>'
    )
    parts.append(
        f'<line class="axis" x1="{plot_x0}" y1="{plot_y0}" x2="{plot_x0}" y2="{plot_y1}"/>'
    )
    parts.append(
        f'<text class="lbl" x="{plot_x0}" y="{HEIGHT - 10}">t_s {t_lo:.2f}</text>'
    )
    parts.append(
        f'<text class="lbl" x="{plot_x1 - 70}" y="{HEIGHT - 10}">t_s {t_hi:.2f}</text>'
    )
    parts.append(
        f'<text class="lbl" x="{(plot_x0 + plot_x1) / 2 - 60:.0f}" y="{HEIGHT - 10}">'
        f"{_escape(signal)} [{_escape(unit)}] decimation x{factor}</text>"
    )
    parts.append("</svg>")
    return "".join(parts)


def _empty_plot(title: str, message: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH} 80" width="100%" '
        f'role="img" aria-label="{_escape(title)}">'
        f'<text x="10" y="26" style="font:12px sans-serif;fill:currentColor">'
        f"{_escape(title)}</text>"
        f'<text x="10" y="48" style="font:11px sans-serif;fill:currentColor;opacity:.7">'
        f"{_escape(message)}</text></svg>"
    )
