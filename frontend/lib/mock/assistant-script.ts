/**
 * Deterministic assistant scripts (AS-6).
 *
 * The mock chat route replays one of these frame sequences verbatim — no CI
 * job ever calls a live model (the stubbed-LLM rule in AI-SIDEBAR.md §7).
 * Tests import the same arrays, so the expected frames and the served frames
 * can never drift apart.
 *
 * The sensor script is the approved concept conversation
 * (plans/prototype/ai-sidebar-concept.html): two tool calls, three invalid
 * EX90 runs with quoted journal reasons, and the filtered-view deep link.
 */

import type { AssistantFrame } from "@/types";

export const ASSISTANT_MOCK_SESSION = "mock-assistant-sess-1";

const S = ASSISTANT_MOCK_SESSION;

/** "Which tests failed because of sensor issues on EX90 in the last month?" */
export const SENSOR_FRAMES: AssistantFrame[] = [
  { type: "status", session_id: S, message: "thinking" },
  {
    type: "tool_start",
    session_id: S,
    tool_call_id: "t1",
    tool_name: "list_runs",
    display_name: "invalid-flags",
  },
  {
    type: "tool_result",
    session_id: S,
    tool_call_id: "t1",
    summary: "3 invalid runs on EX90 in the window",
    is_error: false,
  },
  {
    type: "tool_start",
    session_id: S,
    tool_call_id: "t2",
    tool_name: "list_run_journal",
    display_name: "journal",
  },
  {
    type: "tool_result",
    session_id: S,
    tool_call_id: "t2",
    summary: "3 reasons quoted from the journal",
    is_error: false,
  },
  { type: "answer_delta", session_id: S, text: "3 runs on EX90 were flagged invalid " },
  {
    type: "answer_delta",
    session_id: S,
    text: "in the last 30 days with sensor-related reasons:",
  },
  {
    type: "hits",
    session_id: S,
    hits: [
      {
        entity: "run",
        run_id: "TAS-88012",
        status: "invalid",
        rig_id: "rig-03",
        project: "EX90",
        first_data_at: "2026-08-12T14:05:00Z",
        url: "/runs/TAS-88012",
        reason: {
          text: "Thermocouple drift on TC-4 during thermal soak — values diverge after 40 min.",
          actor: "e.lindqvist",
          at: "2026-08-12T15:20:00Z",
          journal_id: "J-88012-3",
        },
      },
      {
        entity: "run",
        run_id: "TAS-87996",
        status: "invalid",
        rig_id: "rig-04",
        project: "EX90",
        first_data_at: "2026-08-09T10:52:00Z",
        url: "/runs/TAS-87996",
        reason: {
          text: "INCA channel dropout — HV_Batt_Cell_Temp_Max unrecorded for 12 min.",
          actor: "m.okafor",
          at: "2026-08-09T12:04:00Z",
          journal_id: "J-87996-2",
        },
      },
      {
        entity: "run",
        run_id: "TAS-87911",
        status: "invalid",
        rig_id: "rig-03",
        project: "EX90",
        first_data_at: "2026-08-04T11:19:00Z",
        url: "/runs/TAS-87911",
        reason: {
          text: "Pressure sensor offset outside calibration window; rerun scheduled.",
          actor: "j.svensson",
          at: "2026-08-04T13:41:00Z",
          journal_id: "J-87911-2",
        },
      },
    ],
  },
  {
    type: "deeplink",
    session_id: S,
    label: "Open filtered view",
    url: "/runs?status=invalid&project=EX90&q=sensor",
  },
  { type: "done", session_id: S },
];

/** "Trace WO-2026-0851 to its results" — the lineage chain answer. */
export const TRACE_FRAMES: AssistantFrame[] = [
  { type: "status", session_id: S, message: "thinking" },
  {
    type: "tool_start",
    session_id: S,
    tool_call_id: "t1",
    tool_name: "get_work_order_detail",
    display_name: "work-orders",
  },
  {
    type: "tool_result",
    session_id: S,
    tool_call_id: "t1",
    summary: "WO-2026-0851 · HV battery thermal · active",
    is_error: false,
  },
  {
    type: "tool_start",
    session_id: S,
    tool_call_id: "t2",
    tool_name: "run_lineage",
    display_name: "lineage",
  },
  {
    type: "tool_result",
    session_id: S,
    tool_call_id: "t2",
    summary: "chain complete · 4 nodes",
    is_error: false,
  },
  {
    type: "answer_delta",
    session_id: S,
    text: "The chain is complete — every link is registered:",
  },
  {
    type: "chain",
    session_id: S,
    nodes: [
      {
        kind: "work_order",
        id: "WO-2026-0851",
        label: "HV battery thermal · active",
        url: "/work-orders/WO-2026-0851",
      },
      { kind: "definition", id: "TD-BAT-114", label: "3 planned runs", url: null },
      { kind: "run", id: "TAS-88214", label: "6 files · 11 signals", url: "/runs/TAS-88214" },
      { kind: "results", id: "psd-analysis v2", label: "provenance verified", url: null },
    ],
  },
  {
    type: "deeplink",
    session_id: S,
    label: "Open lineage",
    url: "/runs/TAS-88214/lineage",
  },
  { type: "done", session_id: S },
];

/** Anything the scripts don't recognize — a short capability answer. */
export const FALLBACK_FRAMES: AssistantFrame[] = [
  { type: "status", session_id: S, message: "thinking" },
  {
    type: "answer_delta",
    session_id: S,
    text:
      "I can help you find runs, files, signals and work orders — try asking " +
      "what arrived today, about quarantined files, or which runs are missing " +
      "work orders.",
  },
  { type: "done", session_id: S },
];

/** Pick the scripted conversation for a message (deterministic, keyword match). */
export function scriptForMessage(message: string): AssistantFrame[] {
  const lower = message.toLowerCase();
  if (lower.includes("sensor")) return SENSOR_FRAMES;
  if (lower.includes("trace")) return TRACE_FRAMES;
  return FALLBACK_FRAMES;
}
