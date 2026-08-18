from dotenv import load_dotenv
load_dotenv()  # reads .env if present; does not override env vars already set by the platform

import json

import pandas as pd
import streamlit as st

from api_client import create_item, evaluate, list_items

st.set_page_config(page_title="Test Manager", layout="wide")
st.title("Test Manager")

ENTITIES = {
    "Requirements": "/requirements",
    "Test Specifications": "/test-specs",
    "Test Runs": "/test-runs",
}


def render_entity_tab(label: str, path: str) -> None:
    st.subheader(label)

    try:
        items = list_items(path)
    except Exception as exc:
        st.error(f"Could not load {label.lower()}: {exc}")
        items = []

    if items:
        st.dataframe(pd.DataFrame(items), use_container_width=True)
    else:
        st.info(f"No {label.lower()} yet.")

    with st.expander(f"Create new {label[:-1] if label.endswith('s') else label}"):
        raw_json = st.text_area("JSON payload", value="{}", key=f"create_{path}")
        if st.button("Create", key=f"create_button_{path}"):
            try:
                payload = json.loads(raw_json)
                created = create_item(path, payload)
                st.success(f"Created: {created}")
            except Exception as exc:
                st.error(f"Failed to create: {exc}")


def render_results_tab() -> None:
    st.subheader("Results")

    col1, col2 = st.columns(2)
    test_run_id = col1.text_input("Filter by test_run_id", value="")
    status = col2.text_input("Filter by status", value="")

    try:
        data = evaluate(test_run_id=test_run_id or None, status=status or None)
    except Exception as exc:
        st.error(f"Could not load results: {exc}")
        return

    st.metric("Total results", data.get("count", 0))

    summary = data.get("summary", {})
    if summary:
        st.bar_chart(pd.DataFrame({"status": list(summary.keys()), "count": list(summary.values())}).set_index("status"))
    else:
        st.info("No results to summarize yet.")

    results = data.get("results", [])
    if results:
        st.dataframe(pd.DataFrame(results), use_container_width=True)
    else:
        st.info("No results found for the given filters.")


tabs = st.tabs(["Requirements", "Test Specifications", "Test Runs", "Results"])

with tabs[0]:
    render_entity_tab("Requirements", ENTITIES["Requirements"])

with tabs[1]:
    render_entity_tab("Test Specifications", ENTITIES["Test Specifications"])

with tabs[2]:
    render_entity_tab("Test Runs", ENTITIES["Test Runs"])

with tabs[3]:
    render_results_tab()
