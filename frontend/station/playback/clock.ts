import { advance, clampToSegments, type Segment } from './gaps';

type TimeListener = (t: number) => void;
type StateListener = () => void;

/** Master replay clock outside React; widgets update the DOM. */
export class PlaybackClock {
  t = 0;
  speed = 1;
  playing = false;
  segments: Segment[] = [];
  private timeSubs = new Set<TimeListener>();
  private stateSubs = new Set<StateListener>();
  private raf = 0;
  private last = 0;

  load(segments: Segment[], t?: number): void {
    this.pause();
    this.segments = [...segments].sort((a, b) => a.t0 - b.t0);
    this.t = clampToSegments(t ?? this.segments[0]?.t0 ?? 0, this.segments);
    this.emitTime();
    this.emitState();
  }

  subscribe(fn: TimeListener): () => void {
    this.timeSubs.add(fn);
    fn(this.t);
    return () => this.timeSubs.delete(fn);
  }

  onState(fn: StateListener): () => void {
    this.stateSubs.add(fn);
    return () => this.stateSubs.delete(fn);
  }

  seek(t: number): void {
    this.t = clampToSegments(t, this.segments);
    this.emitTime();
  }

  setSpeed(s: number): void {
    this.speed = s;
    this.emitState();
  }

  play(): void {
    if (this.playing || this.segments.length === 0) return;
    const end = this.segments[this.segments.length - 1].t1;
    if (this.t >= end) this.t = this.segments[0].t0;
    this.playing = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
    this.emitState();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emitState();
  }

  stop(): void {
    this.pause();
    this.seek(this.segments[0]?.t0 ?? 0);
  }

  private tick = (now: number): void => {
    const dt = (now - this.last) * this.speed;
    this.last = now;
    const next = advance(this.t + dt, this.segments);
    this.t = next.t;
    this.emitTime();
    if (next.ended) {
      this.pause();
      return;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private emitTime(): void {
    for (const fn of this.timeSubs) fn(this.t);
  }

  private emitState(): void {
    for (const fn of this.stateSubs) fn();
  }
}

export const clock = new PlaybackClock();
