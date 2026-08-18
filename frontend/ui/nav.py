"""The five pages, and how a click gets from one record to another.

``st.page_link`` cannot carry query parameters (its first argument is a page, or an
absolute external URL), so traceability navigation is built from a button plus
:func:`go`: the button writes the target ids into selection state, publishes them
to the URL, and calls ``st.switch_page``. The target page reads the ids on its next
run and opens that record directly - a real click, not "now re-drive a selectbox".

``url_path`` values are not decorative: ``backend-api/report_html.py`` links to
``<frontend>/Requirements?...`` and ``<frontend>/Test_Specification?...``, so those
two paths are part of the contract with the report generator.
"""

from dataclasses import dataclass

import streamlit as st

from ui import state


@dataclass(frozen=True)
class PageSpec:
    script: str
    title: str
    url_path: str
    icon: str


REQUIREMENTS = PageSpec("views/requirements.py", "Requirements", "Requirements", ":material/list:")
TEST_SPECIFICATION = PageSpec(
    "views/test_specification.py",
    "Test Specification",
    "Test_Specification",
    ":material/rule:",
)
TEST_IMPLEMENTATION = PageSpec(
    "views/test_implementation.py",
    "Test Implementation",
    "Test_Implementation",
    ":material/code:",
)
TEST_RUN = PageSpec("views/test_run.py", "Test Run", "Test_Run", ":material/play_arrow:")
TEST_RESULT = PageSpec("views/test_result.py", "Test Result", "Test_Result", ":material/analytics:")

PAGES = (REQUIREMENTS, TEST_SPECIFICATION, TEST_IMPLEMENTATION, TEST_RUN, TEST_RESULT)


def build_pages() -> list:
    """``st.Page`` objects in the fixed sidebar order of spec 1.0."""
    return [
        st.Page(spec.script, title=spec.title, url_path=spec.url_path, icon=spec.icon)
        for spec in PAGES
    ]


def go(target: PageSpec, **updates: str | int | None) -> None:
    """Select the target records, then switch page. Never returns.

    The selection is *queued*: the sidebar applies it before it rebuilds its
    widgets on the next run, and publishes it to the URL there, so the address bar
    ends up describing the record that is on screen.
    """
    for key, value in updates.items():
        state.request(key, value)
    st.switch_page(target.script)


def link_button(
    label: str,
    target: PageSpec,
    *,
    key: str,
    help_text: str | None = None,
    container_width: bool = False,
    **updates: str | int | None,
) -> None:
    """A traceability link: one click lands on ``target`` already filtered."""
    if st.button(
        label,
        key=key,
        help=help_text or f"Open {label} on {target.title}",
        use_container_width=container_width,
    ):
        go(target, **updates)


def chip_links(
    ids: list[str],
    target: PageSpec,
    param: str,
    *,
    key_prefix: str,
    empty_note: str = "none",
    columns: int = 6,
) -> None:
    """A row of clickable id chips - the many-to-many links of spec 2.2."""
    if not ids:
        st.caption(empty_note)
        return
    for start in range(0, len(ids), columns):
        row = ids[start : start + columns]
        slots = st.columns(columns)
        for slot, item in zip(slots, row, strict=False):
            with slot:
                link_button(
                    item,
                    target,
                    key=f"{key_prefix}_{item}",
                    container_width=True,
                    **{param: item},
                )
