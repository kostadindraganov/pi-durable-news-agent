import type { ReadRetention } from "@dna/sdk";
import type { Store } from "../db/store.ts";
import type { Deps } from "../deps.ts";

export function readRetention(store: Store): ReadRetention {
  return store.settings.get<ReadRetention>("readRetention", { days: null });
}

export function pruneReadCards(
  { store, bus, log }: Pick<Deps, "store" | "bus" | "log">,
  now = Date.now(),
) {
  const { days } = readRetention(store);
  if (days === null) return;
  const ids = store.news.pruneReadCards(new Date(now - days * 86_400_000).toISOString());
  if (ids.length) {
    // Keep frames small when a shorter policy removes a backlog.
    for (let i = 0; i < ids.length; i += 500)
      bus.publish({ type: "feed.read_removed", ids: ids.slice(i, i + 500) });
    log.info("feed.read_pruned", { days, count: ids.length });
  }
}
