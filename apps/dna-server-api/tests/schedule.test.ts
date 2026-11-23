import assert from "node:assert/strict";
import { test } from "node:test";
import { Schedule } from "../src/news/schedule.ts";
import { tempStore } from "./helpers.ts";

test("scheduled sweeps are spaced from the last cron sweep and react to interval changes", async () => {
  const { store, cleanup } = tempStore();
  try {
    const schedule = new Schedule({ store, cronSchedule: "*/5 * * * *" });
    assert.equal(schedule.every(), 5, "every 5 minutes by default");
    assert.deepEqual(
      new Schedule({ store, cronSchedule: "* * * * *" }).presets(),
      [1, 5, 10, 15, 30, 60, 360, 720, 1440],
    );
    const now = Date.parse("2026-11-23T23:46:21Z");
    assert.deepEqual(schedule.due(now), { due: true }, "no cron sweep yet");
    assert.equal(schedule.next(now)?.toISOString(), "2026-11-23T23:50:00.000Z");
    const cron = store.sweeps.create({ requestId: "c1", trigger: "cron", status: "completed" });
    const last = Date.parse("2026-11-23T23:00:00Z");
    store.db
      .prepare("UPDATE sweeps SET created_at = ? WHERE id = ?")
      .run(new Date(last + 500).toISOString(), cron.id);
    store.sweeps.create({ requestId: "c2", trigger: "cron", status: "skipped" });
    store.sweeps.create({ requestId: "m1", trigger: "manual", status: "completed" });
    schedule.set({ everyMinutes: 15 });
    assert.deepEqual(schedule.due(now), { due: true }, "a shorter interval is already due");
    assert.equal(schedule.next(now)?.toISOString(), "2026-11-23T23:50:00.000Z");
    for (const everyMinutes of [360, 720, 1440]) {
      schedule.set({ everyMinutes });
      const next = last + everyMinutes * 60_000;
      assert.equal(schedule.due(now).due, false);
      assert.equal(schedule.next(now)?.getTime(), next);
      assert.equal(schedule.due(next - 1).due, false);
      assert.equal(schedule.due(next).due, true);
    }
    schedule.set({ everyMinutes: null });
    assert.deepEqual(schedule.due(now), { due: false, reason: "Scheduled sweeps are off" });
    assert.equal(schedule.next(now), undefined);
    assert.deepEqual(
      new Schedule({ store, cronSchedule: "*/15 * * * *" }).presets(),
      [15, 30, 60, 360, 720, 1440],
    );
  } finally {
    cleanup();
  }
});

test("a sweep whose agent run already ended is closed at once instead of skipping every tick", async () => {
  const { closeStalledSweeps } = await import("../src/news/sweep.ts");
  const { Bus } = await import("../src/events.ts");
  const { store, cleanup } = tempStore();
  try {
    const open = store.sweeps.create({ requestId: "c-open", trigger: "cron", status: "running" });
    const fresh = store.sweeps.create({ requestId: "c-fresh", trigger: "cron", status: "running" });
    store.sweeps.update(open.id, { submissionId: 10 });
    store.sweeps.update(fresh.id, { submissionId: 20 });
    const run = store.db.prepare(
      "INSERT INTO agent_runs (run_entry_id, conversation_id, submission_id, sweep_id, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    run.run(1, 1, 10, open.id, "unanswered", Date.now() - 60_000, Date.now() - 30_000);
    // Between tool calls a run has ended_at stamped but is still running.
    run.run(2, 1, 20, fresh.id, "running", Date.now() - 60_000, Date.now() - 30_000);
    // Its researcher subagent finished: a done run with the same sweep id that is not the sweep's own run.
    run.run(3, 7, 30, fresh.id, "done", Date.now() - 50_000, Date.now() - 40_000);
    const log = {
      info() {},
      warn() {},
      error() {},
      debug() {},
      child() {
        return log;
      },
    } as any;
    closeStalledSweeps({ store, log, bus: new Bus(), config: { stallMinutes: 30 } as any });
    assert.equal(store.sweeps.get(open.id)!.status, "stalled");
    assert.match(
      store.sweeps.get(open.id)!.error!,
      /run ended \(unanswered\) before complete_sweep/,
    );
    assert.equal(store.sweeps.get(fresh.id)!.status, "running", "a sweep still at work stays open");
  } finally {
    cleanup();
  }
});

test("a sweep queued behind a failed run is withdrawn from the inbox and closed, so the next tick can start", async () => {
  const { withdrawStuckSweeps } = await import("../src/news/sweep.ts");
  const { Bus } = await import("../src/events.ts");
  const { store, cleanup } = tempStore();
  try {
    const failed = Date.now() + 1_000;
    const queued = store.sweeps.create({ requestId: "q-1", trigger: "cron", status: "queued" });
    store.sweeps.update(queued.id, { submissionId: 40 });
    const log = { info() {}, warn() {}, error() {}, debug() {}, child: () => log } as any;
    const withdrawn: number[] = [];
    const queue = {
      mainId: 1,
      withdraw: async (id: number) => (withdrawn.push(id), "aborted"),
    };
    const run = store.db.prepare(
      "INSERT INTO agent_runs (run_entry_id, conversation_id, submission_id, status, started_at, ended_at) VALUES (?, 1, ?, ?, ?, ?)",
    );
    run.run(1, 30, "running", Date.now() - 60_000, Date.now());
    await withdrawStuckSweeps({ store, log, bus: new Bus() }, queue);
    assert.equal(store.sweeps.get(queued.id)!.status, "queued", "behind a working run it waits");
    store.db.prepare("UPDATE agent_runs SET status = 'unanswered', ended_at = ?").run(failed);
    await withdrawStuckSweeps({ store, log, bus: new Bus() }, queue);
    assert.deepEqual(withdrawn, [40]);
    assert.equal(store.sweeps.get(queued.id)!.status, "stalled");
    assert.match(store.sweeps.get(queued.id)!.error!, /failed, so it was withdrawn/);
  } finally {
    cleanup();
  }
});
