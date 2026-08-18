"""V-Model Test Manager - Streamlit multipage shell.

Five pages in the fixed order of spec 1.0 (Requirements, Test Specification, Test
Implementation, Test Run, Test Result), one always-visible version selector, and
nothing else. The pages live in ``views/`` rather than ``pages/`` on purpose:
``pages/`` would also be picked up by Streamlit's automatic page discovery and
compete with ``st.navigation``, which is the mechanism this app uses so each page
gets an explicit ``url_path`` - and those paths are part of a contract, because the
report generator links back into ``/Requirements`` and ``/Test_Specification``.

Order of operations matters: page config, then navigation, then the sidebar (which
applies queued link targets and query parameters *before* it builds its widgets),
then the page body.
"""

from dotenv import load_dotenv

load_dotenv()  # reads .env if present; never overrides platform-injected variables

import streamlit as st  # noqa: E402

from ui import nav, sidebar  # noqa: E402

st.set_page_config(
    page_title="V-Model Test Manager",
    page_icon=":material/checklist:",
    layout="wide",
)

page = st.navigation(nav.build_pages())
sidebar.render()
page.run()
