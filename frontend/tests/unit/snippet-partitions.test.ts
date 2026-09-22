/**
 * A snippet's partitions read the way QuixLab's console reads them: shared levels as chips,
 * differing levels as a table.
 */
import { describe, expect, it } from "vitest";
import { segments, showValue, summarisePartitions } from "@/lib/snippets/partitions";

const A = "platform=sn002/work_order=WO-2025-0110/test_definition=TD-ANALOG-DAQ/run_id=r1/protocol=analog/bus=__None__/stream=rh_wing_accel/signal=P255";
const B = "platform=sn002/work_order=WO-2025-0110/test_definition=TD-ANALOG-DAQ/run_id=r1/protocol=analog/bus=__None__/stream=rh_wing_accel/signal=P112";

describe("summarisePartitions", () => {
  it("shares what every folder agrees on and tabulates the rest", () => {
    const s = summarisePartitions([A, B]);
    expect(s.whole).toBe(false);
    expect(s.rows).toHaveLength(2);
    expect(s.shared.map((x) => x.value)).toEqual([
      "sn002",
      "WO-2025-0110",
      "TD-ANALOG-DAQ",
      "r1",
      "analog",
      "__None__",
      "rh_wing_accel",
    ]);
    expect(s.columns).toEqual(["signal"]);
    expect(s.rows.map((r) => r.values.signal)).toEqual(["P255", "P112"]);
  });
  it("shows a lone folder as chips alone, and the table root as whole", () => {
    const s = summarisePartitions([A]);
    expect(s.shared.map((x) => x.key)).toEqual([
      "platform",
      "work_order",
      "test_definition",
      "run_id",
      "protocol",
      "bus",
      "stream",
      "signal",
    ]);
    expect(s.columns).toEqual([]);
    expect(summarisePartitions([""]).whole).toBe(true);
    expect(summarisePartitions([]).rows).toEqual([]);
  });
  it("keeps a level that only some folders carry as a column", () => {
    const s = summarisePartitions(["platform=sn002/run_id=r1", "platform=sn002/run_id=r2/protocol=fto"]);
    expect(s.shared.map((x) => x.key)).toEqual(["platform"]);
    expect(s.columns).toEqual(["run_id", "protocol"]);
    expect(showValue(s.rows[0].values.protocol)).toBe("any");
  });
  it("reads segments and spells the null value", () => {
    expect(segments("a=1/b=x%20y/noeq/=bad")).toEqual([
      ["a", "1"],
      ["b", "x y"],
    ]);
    expect(showValue("__None__")).toBe("(none)");
    expect(showValue("")).toBe("(none)");
    expect(showValue("v")).toBe("v");
  });
});
