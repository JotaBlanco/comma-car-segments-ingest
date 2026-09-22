/**
 * Map-backed `Storage` shared by both test setups:
 *  - `tests/components/setup.ts` installs it on window/globalThis for the
 *    jsdom component suite (Node 26's experimental global localStorage is
 *    undefined without --localstorage-file and shadows jsdom's own).
 *  - `tests/unit/support/local-storage.ts` installs it for the node-env unit
 *    suite (vitest 4 dropped the per-file @vitest-environment pragma).
 * One implementation so the two shims can never drift apart.
 */
export class MemoryStorage implements Storage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}
