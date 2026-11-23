// The cron tick checks whether the selected interval has elapsed since the last scheduled sweep.
// Changing the interval updates the stored schedule and the next due time.
import type { ScheduleState } from "@dna/sdk";
import type { Store } from "../db/store.ts";

export const SCHEDULE_PRESETS = [1, 5, 10, 15, 30, 60, 360, 720, 1440] as const;
/** Scheduled sweeps run this often until the reader picks another preset. */
export const DEFAULT_EVERY = 5;
/** The most cards one sweep presents until the reader picks another number. */
export const DEFAULT_CARDS = 7;
export const MAX_CARDS = 30;

interface ScheduleSetting {
  everyMinutes?: number | null;
  cardsPerSweep?: number;
}
const MINUTE = 60_000;

/** The crontab's tick in minutes: 1 for every minute, N for a step of N minutes, else an hour. */
export function tickMinutes(cronSchedule: string): number {
  const minute = cronSchedule.trim().split(/\s+/)[0];
  if (minute === "*") return 1;
  const step = minute.match(/^\*\/(\d+)$/)?.[1];
  return step ? Number(step) : 60;
}

export class Schedule {
  constructor(private readonly deps: { store: Store; cronSchedule: string }) {}

  get tick(): number {
    return tickMinutes(this.deps.cronSchedule);
  }

  /** Intervals this device's tick can keep: multiples of the tick. */
  presets(): number[] {
    return SCHEDULE_PRESETS.filter((m) => m >= this.tick && m % this.tick === 0);
  }

  private setting(): ScheduleSetting {
    return this.deps.store.settings.get<ScheduleSetting>("schedule", {});
  }

  /** Minutes between sweeps, or null when scheduled sweeps are off. */
  every(): number | null {
    const saved = this.setting().everyMinutes;
    return saved !== undefined
      ? saved
      : (this.presets().find((m) => m >= DEFAULT_EVERY) ?? this.tick);
  }

  /** The most cards one sweep presents. */
  cards(): number {
    return this.setting().cardsPerSweep ?? DEFAULT_CARDS;
  }

  set(patch: ScheduleSetting): ScheduleState {
    this.deps.store.settings.set("schedule", { ...this.setting(), ...patch });
    return this.state();
  }

  private dueAt(every: number): number | undefined {
    const last = this.deps.store.sweeps.lastCronAt();
    if (!last) return undefined;
    // Cron requests arrive shortly after the minute starts. Use the scheduled minute
    // so sub-second request delays do not push each sweep back an extra tick.
    return (Math.floor(Date.parse(last) / MINUTE) + every) * MINUTE;
  }

  /** Whether a cron tick can start a sweep. */
  due(now = Date.now()): { due: true } | { due: false; reason: string } {
    const every = this.every();
    if (every === null) return { due: false, reason: "Scheduled sweeps are off" };
    const at = this.dueAt(every);
    if (at !== undefined && now < at)
      return { due: false, reason: `Next scheduled sweep is at ${new Date(at).toISOString()}` };
    return { due: true };
  }

  /** The next tick that can start a sweep. */
  next(now = Date.now()): Date | undefined {
    const every = this.every();
    if (every === null) return undefined;
    const tick = this.tick * MINUTE;
    const nextTick = (Math.floor(now / tick) + 1) * tick;
    return new Date(Math.max(nextTick, this.dueAt(every) ?? nextTick));
  }

  state(now = Date.now()): ScheduleState {
    return {
      everyMinutes: this.every(),
      cardsPerSweep: this.cards(),
      presets: this.presets(),
      tickMinutes: this.tick,
      nextSweepAt: this.next(now)?.toISOString(),
    };
  }
}
