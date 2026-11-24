import { Type } from "@earendil-works/pi-ai";
import type { AgentChange, Task } from "@earendil-works/pi-durable";
import { defineAppTool, onceInCommit, toolError, toolText } from "@dna/durable-agent";
import type { Deps } from "../../deps.ts";
import { toCandidate, type SweepInput, type SweepResult } from "../../news/sweep-task.ts";
import { needsRelationshipReview } from "../../news/stories.ts";
import { MAX_PER_BATCH, researchItemBatches } from "./research-items.ts";

export function runNewsSweep(
  deps: Deps,
  sweepTask: Task<SweepInput, any, SweepResult, object>,
  researcher: () => AgentChange,
) {
  return defineAppTool({
    name: "run_news_sweep",
    returns:
      "Text: the phase counts (gathered, kept, duplicates) and one line per ranked candidate, or that nothing cleared the gate.",
    description:
      "Run the checkpointed sweep for a sweep id: gather every due source and topic search, gate each item with jev, dedupe, rank. Waits for research on uncertain story relationships, then returns the ranked candidates to present. Call it once per scheduled sweep.",
    parameters: Type.Object({
      sweep_id: Type.Integer({ description: "The SWEEP_ID from the sweep prompt" }),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const sweep = deps.store.sweeps.get(args.sweep_id);
      if (!sweep)
        return toolError(`No sweep #${args.sweep_id}.`, [
          "Use the SWEEP_ID from the sweep prompt.",
        ]);
      if (["completed", "no_news", "skipped"].includes(sweep.status))
        return toolError(`Sweep #${sweep.id} is already ${sweep.status}.`, [
          "Start no new work for it.",
        ]);
      const taskId = await onceInCommit<number>(
        api,
        ctx,
        async (tx) =>
          (await tx.createTask(
            sweepTask,
            { sweepId: sweep.id },
            { ownership: { kind: "task", taskId: api.taskId } },
          )) as number,
      );
      deps.store.sweeps.update(sweep.id, { taskId, status: "running" });
      await api.details({ sweepId: sweep.id, taskId }, ctx);
      const settled = await api.waitForTask(taskId as never, ctx);
      const outcome = settled.state.outcome as {
        status: string;
        result?: SweepResult;
        error?: { message: string };
      };
      if (outcome.status !== "completed" || !outcome.result) {
        return toolError(
          `Sweep #${sweep.id} could not finish: ${outcome.error?.message ?? outcome.status}.`,
          ["Call complete_sweep with status no_news and a summary that names the failure."],
        );
      }
      const r = outcome.result;
      // Keep the batch order stable if research is resumed after some items have been resolved.
      const researchIds =
        (await api.memo<number[]>("relationship-review-items", ctx)) ??
        (await api.memo(
          "relationship-review-items",
          r.candidates
            .map((candidate) => candidate.id)
            .filter((id) => {
              const item = deps.store.news.item(id);
              return item && needsRelationshipReview(item);
            }),
          ctx,
        ));
      const batches = [];
      for (let i = 0; i < researchIds.length; i += MAX_PER_BATCH)
        batches.push({
          item_ids: researchIds.slice(i, i + MAX_PER_BATCH),
          focus:
            "Determine whether the item repeats prior coverage, adds evidence or reports a new development. State what the evidence supports.",
        });
      const children = batches.length
        ? (await researchItemBatches(deps, researcher, sweep.id, batches, api, ctx)).results.map(
            (result) => result.conversationId,
          )
        : [];
      const candidates = r.candidates.flatMap(({ id }) => {
        const item = deps.store.news.item(id);
        return item && item.status !== "duplicate" ? [toCandidate(item)] : [];
      });
      const duplicates = r.duplicates + r.candidates.length - candidates.length;
      deps.store.sweeps.update(sweep.id, { candidates: candidates.length, duplicates });

      const lines = candidates.map(
        (c) =>
          `#${c.id} ${c.title} (${c.source ?? "web"}) attention ${c.attention}${c.discussion ? ", has discussion" : ""}${c.matchedTopic ? `, topic ${c.matchedTopic}` : ""}${researchIds.includes(c.id) ? ", relationship reviewed" : ""}`,
      );
      const head = `Sweep #${sweep.id}: ${r.gathered} gathered, jev kept ${r.kept}, ${duplicates} duplicates, ${candidates.length} candidates.`;
      const details = {
        sweepId: sweep.id,
        taskId,
        candidates: candidates.map((c) => c.id),
        relationshipReviews: researchIds.length,
        children,
      };
      await api.details(details, ctx);
      return toolText(
        candidates.length
          ? `${head}\n${lines.join("\n")}`
          : `${head}\nNo candidates. Call complete_sweep with status no_news.`,
        details,
      );
    },
  });
}
