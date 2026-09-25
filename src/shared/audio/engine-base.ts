import { Rng } from "../core/random.ts";
import { chain, filter } from "./synth.ts";

/** Margin (s) by which events are scheduled ahead of the next update. */
const LOOKAHEAD = 0.15;
/** Seconds over which a longer spacing between updates is forgotten once they come faster again. */
const CADENCE_MEMORY = 5;
/** Longest update spacing (s) planned for; longer gaps are stalls, not a rhythm to cover. */
export const MAX_CADENCE = 2;
const MASTER_LEVEL = 0.8;

/** A looping noise with a filter and a level to steer. */
export interface Loop {
  source: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  gain: GainNode;
}

/**
 * The part of a work's sound engine every work shares: the audio context,
 * started from a user gesture; muting and resuming; one-shots and loops; and
 * a lookahead that stretches with the spacing of updates, since a hidden page
 * may be updated only once a second. A work builds its sounds (`B`) and its
 * graph, and schedules what it hears in its own `update`.
 */
export abstract class AudioEngineBase<B> {
  protected ctx: AudioContext | null = null;
  protected bank: B | null = null;
  protected readonly rng: Rng;
  protected readonly seed: number;
  /** Everything ends here, through a gentle compressor. */
  protected master!: GainNode;
  /** How far ahead (s) events are scheduled. */
  protected lookahead = LOOKAHEAD;
  private enabled = true;
  /** Audio time of the previous update. */
  private lastUpdate = Number.NaN;
  /** Recent longest spacing (s) between updates on the audio clock. */
  private cadence = 0;

  constructor(seed: number, rngSalt: number) {
    this.seed = seed;
    this.rng = new Rng(seed ^ rngSalt);
  }

  get ready(): boolean {
    return this.bank !== null;
  }

  /** Must be called from a user gesture so the browser lets audio play. */
  async start(): Promise<void> {
    if (this.ctx) {
      return;
    }
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;
    void ctx.resume();
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.01;
    compressor.release.value = 0.3;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    chain(this.master, compressor, ctx.destination);
    this.buildGraph(ctx);
    const bank = await this.buildBank(ctx.sampleRate);
    this.bank = bank;
    this.startLoops(ctx, bank);
    this.master.gain.setTargetAtTime(this.enabled ? MASTER_LEVEL : 0, ctx.currentTime, 1.2);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    if (on) {
      void ctx.resume();
      this.master.gain.setTargetAtTime(MASTER_LEVEL, ctx.currentTime, 0.25);
    } else {
      this.master.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
      window.setTimeout(() => {
        if (!this.enabled) {
          void ctx.suspend();
        }
      }, 600);
    }
  }

  /**
   * Retries a resume after the system interrupted audio, as phones do while
   * the page is in the background. Some browsers only allow it from a user gesture.
   */
  wake(): void {
    const ctx = this.ctx;
    if (ctx && this.enabled && ctx.state !== "running") {
      void ctx.resume();
    }
  }

  /** Builds the buses the work's sounds go through, ending in `master`. */
  protected abstract buildGraph(ctx: AudioContext): void;

  /** Synthesizes the work's one-shot sounds and noise buffers. */
  protected abstract buildBank(sampleRate: number): Promise<B>;

  /** Starts the continuous sounds once the bank is ready. */
  protected abstract startLoops(ctx: AudioContext, bank: B): void;

  /**
   * The audio context and bank when sound is running now; otherwise null, and
   * the update should keep its cursors at the present (nothing that happened
   * meanwhile should play all at once on resume).
   */
  protected running(): { ctx: AudioContext; bank: B; now: number } | null {
    const ctx = this.ctx;
    const bank = this.bank;
    if (!ctx || !bank || ctx.state !== "running") {
      this.lastUpdate = Number.NaN;
      return null;
    }
    const now = ctx.currentTime;
    this.trackCadence(now);
    return { ctx, bank, now };
  }

  /**
   * Schedules far enough ahead to bridge the gap until the next update. A
   * hidden page updates from a timer, which the browser may slow to one tick a
   * second.
   */
  private trackCadence(now: number): void {
    const gap = now - this.lastUpdate;
    if (gap > 0) {
      this.cadence = Math.min(
        MAX_CADENCE,
        Math.max(gap, this.cadence * Math.exp(-gap / CADENCE_MEMORY)),
      );
    }
    this.lastUpdate = now;
    this.lookahead = LOOKAHEAD + this.cadence;
  }

  /** A looping noise through a filter, silent until its gain is raised. */
  protected loop(
    ctx: AudioContext,
    buffer: AudioBuffer,
    type: BiquadFilterType,
    freq: number,
    q: number,
    out: AudioNode,
  ): Loop {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopStart = 0;
    source.loopEnd = buffer.duration;
    const f = filter(ctx, type, freq, q);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    chain(source, f, gain, out);
    source.start(ctx.currentTime, this.rng.next() * buffer.duration * 0.9);
    return { source, filter: f, gain };
  }

  /** Plays a one-shot at `when` (never earlier than now). */
  protected play(
    buffer: AudioBuffer,
    when: number,
    gain: number,
    out: AudioNode,
    pan = 0,
    rate = 1,
  ): AudioBufferSourceNode | null {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running" || gain <= 0.0005) {
      return null;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    if (pan !== 0) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      chain(src, g, p, out);
    } else {
      chain(src, g, out);
    }
    src.start(Math.max(ctx.currentTime, when));
    return src;
  }
}
