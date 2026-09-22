/**
 * The Explorer's provider over several sessions at once. QuixLab's provider browses one
 * partition path; this one puts the picked runs' folders in front of every path it is
 * asked about, merges what it finds level by level, and merges the frames of one signal
 * across the runs bucket by bucket. So the tree shows the signal folders alone, never a
 * session, and a ticked signal draws its samples from every session picked.
 */

export interface TreeNode {
  key?: string | null;
  value: string;
  seg?: string;
  leaf: boolean;
  count?: number;
  kind?: string;
  meta?: unknown;
}

export interface Frame {
  min: number[];
  max: number[];
  mean: number[];
  count: number[];
}

export interface Extent {
  t0: number;
  t1: number;
}

export interface LakeProvider {
  children(path: string): Promise<TreeNode[]>;
  frames(ids: readonly string[], q: { cols?: Record<string, string> } & Record<string, unknown>): Promise<Record<string, Frame>>;
  extent?(ids: readonly string[], opts?: unknown): Promise<Extent | null>;
  units?(ids: readonly string[], opts?: unknown): Promise<unknown>;
  meta?(id: string): unknown;
  [other: string]: unknown;
}

/** `root/path`, with an empty or slash-led path handled. */
export function under(root: string, path: string): string {
  const rel = String(path ?? "").replace(/^\/+/, "");
  return rel ? `${root}/${rel}` : root;
}

const segOf = (n: TreeNode): string => n.seg ?? n.value;

/** One level of several roots, merged by segment: a folder found under any run is shown once. */
export function mergeLevels(levels: readonly (readonly TreeNode[])[]): TreeNode[] {
  const out = new Map<string, TreeNode>();
  for (const level of levels) {
    for (const n of level) {
      const seg = segOf(n);
      const have = out.get(seg);
      if (have === undefined) out.set(seg, { ...n });
      else if (typeof n.count === "number") have.count = (have.count ?? 0) + n.count;
    }
  }
  return [...out.values()].sort((a, b) => a.value.localeCompare(b.value, undefined, { numeric: true }));
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** One signal's frames across runs, bucket by bucket: the runs are apart in time, so a
 *  bucket holds one run's samples or none, and the merge is exact. */
export function mergeFrames(frames: readonly Frame[]): Frame | null {
  const present = frames.filter((f) => f && Array.isArray(f.count));
  if (present.length === 0) return null;
  const n = Math.max(...present.map((f) => f.count.length));
  const out: Frame = { min: [], max: [], mean: [], count: [] };
  for (let i = 0; i < n; i += 1) {
    let count = 0;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const f of present) {
      const c = finite(f.count[i]) ? f.count[i] : 0;
      if (c <= 0) continue;
      count += c;
      if (finite(f.min[i])) min = Math.min(min, f.min[i]);
      if (finite(f.max[i])) max = Math.max(max, f.max[i]);
      if (finite(f.mean[i])) sum += f.mean[i] * c;
    }
    out.count.push(count);
    out.min.push(count > 0 && finite(min) ? min : present[0].min[i]);
    out.max.push(count > 0 && finite(max) ? max : present[0].max[i]);
    out.mean.push(count > 0 ? sum / count : present[0].mean[i]);
  }
  return out;
}

export function mergedProvider(real: LakeProvider, getRoots: () => readonly string[]): LakeProvider {
  const roots = () => getRoots().filter((r) => r.length > 0);
  const merged: LakeProvider = {
    ...real,
    async children(path) {
      const rs = roots();
      if (rs.length === 0) return [];
      const levels = await Promise.all(
        rs.map((r) => Promise.resolve(real.children(under(r, path))).catch(() => [] as TreeNode[])),
      );
      return mergeLevels(levels);
    },
    async frames(ids, q) {
      const rs = roots();
      const out: Record<string, Frame> = {};
      if (rs.length === 0) return out;
      const per = await Promise.all(
        rs.map(async (r) => {
          const cols: Record<string, string> = {};
          for (const [k, v] of Object.entries(q.cols ?? {})) cols[under(r, k)] = v;
          try {
            return await real.frames(ids.map((id) => under(r, id)), { ...q, cols });
          } catch {
            return {} as Record<string, Frame>;
          }
        }),
      );
      for (const id of ids) {
        const got = rs.map((r, i) => per[i][under(r, id)]).filter((f): f is Frame => f !== undefined);
        const f = mergeFrames(got);
        if (f !== null) out[id] = f;
      }
      return out;
    },
  };
  if (typeof real.extent === "function") {
    merged.extent = async (ids, opts) => {
      const rs = roots();
      const found = await Promise.all(
        rs.map((r) => Promise.resolve(real.extent!(ids.map((id) => under(r, id)), opts)).catch(() => null)),
      );
      const ok = found.filter((e): e is Extent => e !== null && Number.isFinite(e.t0) && Number.isFinite(e.t1));
      if (ok.length === 0) return null;
      return { t0: Math.min(...ok.map((e) => e.t0)), t1: Math.max(...ok.map((e) => e.t1)) };
    };
  }
  if (typeof real.units === "function") {
    merged.units = async (ids, opts) => {
      const rs = roots();
      const out: Record<string, string> = {};
      for (const r of rs) {
        let got: unknown;
        try {
          got = await real.units!(ids.map((id) => under(r, id)), opts);
        } catch {
          continue;
        }
        const map: Record<string, string> = {};
        if (Array.isArray(got)) for (const e of got as { id: string; unit: string }[]) map[e.id] = e.unit;
        else if (typeof got === "object" && got !== null) Object.assign(map, got as Record<string, string>);
        for (const id of ids) {
          const u = map[under(r, id)];
          if (u && !out[id]) out[id] = u;
        }
      }
      return out;
    };
  }
  if (typeof real.meta === "function") {
    merged.meta = (id) => {
      const rs = roots();
      return rs.length === 0 ? real.meta!(id) : real.meta!(under(rs[0], id));
    };
  }
  return merged;
}
