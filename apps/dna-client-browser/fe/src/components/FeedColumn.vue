<script setup lang="ts">
// News and its tabs. News is always the first tab; timelines open from a card's chip, searches from the search box
// or the agent's open_tab. A card you voted down leaves News (search and timeline tabs still show it).
import { computed, ref, watch } from "vue";
import { BookOpenCheck, GitCommitVertical, Hash, Link, Newspaper, Search, X } from "@lucide/vue";
import { READ_RETENTION_DAYS, type ReadRetention, type ReadRetentionDays } from "@dna/sdk";
import { closeTab, layout, tabKey, type FeedTab } from "../client/layout";
import { api, attempt, feed, feedState, loaded } from "../client/store";
import BottomPane from "./BottomPane.vue";
import FeedRow from "./FeedRow.vue";
import LoadingRows from "./LoadingRows.vue";
import SearchBox from "./SearchBox.vue";
import SearchView from "./SearchView.vue";
import TimelineView from "./TimelineView.vue";

const ICONS = { timeline: GitCommitVertical, search: Search, keyword: Hash, url: Link };
const counts = computed(() => {
  const out = new Map<number, number>();
  for (const c of feedState.value.news)
    if (c.timeline) out.set(c.timeline.id, Math.max(out.get(c.timeline.id) ?? 0, c.timeline.count));
  return out;
});
/** News in the order it arrived, the newest card last and lowest; each rail shows when the item was published. */
const news = computed(() =>
  feedState.value.news.filter((c) => !c.read && c.feedback?.signal !== "less"),
);
const read = computed(() => feedState.value.news.filter((c) => c.read && !c.readRemoved));
const readingArchive = computed(() => layout.tab === "read");
const retention = ref<ReadRetention>();
const changingRetention = ref(false);
const RETENTION_LABELS = { 1: "After 1 day", 7: "After 1 week", 30: "After 1 month (30 days)" };
watch(
  readingArchive,
  async (open) => {
    if (open) retention.value = await attempt(() => api.readRetention());
  },
  { immediate: true },
);
async function changeRetention(select: HTMLSelectElement) {
  const days = select.value === "off" ? null : (Number(select.value) as ReadRetentionDays);
  changingRetention.value = true;
  try {
    const result = await attempt(() => api.setReadRetention(days));
    if (result) retention.value = result;
    else select.value = String(retention.value?.days ?? "off");
  } finally {
    changingRetention.value = false;
  }
}
const visibleCards = computed(() => (readingArchive.value ? read.value : news.value));
const label = (t: FeedTab) =>
  t.kind === "timeline" ? (feed.timeline(t.id)[0]?.timeline?.title ?? t.title) : t.value;
const active = computed(() => layout.tabs.find((t) => tabKey(t) === layout.tab));
</script>

<template>
  <section class="column feed-column" data-col="feed" data-cap="feed.read" aria-label="News">
    <div class="feed-bar">
      <nav class="feed-tabs" role="tablist" aria-label="News and tabs" data-cap="timelines.read">
        <button
          role="tab"
          class="feed-tab"
          data-tab="news"
          :aria-selected="layout.tab === 'news'"
          @click="layout.tab = 'news'"
        >
          <Newspaper :size="15" /><span>News</span><small>{{ news.length }}</small>
        </button>
        <button
          role="tab"
          class="feed-tab"
          data-tab="read"
          :aria-selected="readingArchive"
          @click="layout.tab = 'read'"
        >
          <BookOpenCheck :size="15" /><span>Read</span><small>{{ read.length }}</small>
        </button>
        <div
          v-for="t in layout.tabs"
          :key="tabKey(t)"
          class="feed-tab closable"
          :class="[t.kind, { on: layout.tab === tabKey(t) }]"
          :data-tab="tabKey(t)"
        >
          <button
            role="tab"
            :aria-selected="layout.tab === tabKey(t)"
            :title="t.kind === 'timeline' ? undefined : `${t.kind}: ${t.value}`"
            @click="layout.tab = tabKey(t)"
          >
            <component :is="ICONS[t.kind]" :size="15" /><span>{{ label(t) }}</span
            ><small v-if="t.kind === 'timeline'">{{ counts.get(t.id) ?? "" }}</small>
          </button>
          <button
            class="tab-close"
            :aria-label="`Close the ${label(t)} ${t.kind === 'timeline' ? 'timeline' : t.kind}`"
            @click="closeTab(tabKey(t))"
          >
            <X :size="13" />
          </button>
        </div>
      </nav>
      <SearchBox />
    </div>
    <div v-if="readingArchive" class="read-toolbar">
      <label>
        Auto-delete from Read
        <select
          class="schedule-select"
          aria-label="Auto-delete from Read"
          title="Time since marking a card as read"
          :value="retention?.days ?? 'off'"
          :disabled="!retention || changingRetention"
          @change="changeRetention($event.target as HTMLSelectElement)"
        >
          <option value="off">Off</option>
          <option v-for="days in READ_RETENTION_DAYS" :key="days" :value="days">
            {{ RETENTION_LABELS[days] }}
          </option>
        </select>
      </label>
    </div>
    <BottomPane
      v-if="!active"
      :key="layout.tab"
      :count="visibleCards.length"
      :label="readingArchive ? 'Read' : 'News'"
      class="feed-list"
    >
      <LoadingRows v-if="!loaded" kind="cards" :count="3" label="Loading the news" />
      <p v-else-if="!visibleCards.length" class="empty">
        {{ readingArchive ? "No read cards yet." : "No unread cards." }}
      </p>
      <FeedRow v-for="card in visibleCards" :key="card.id" :card="card" read-controls />
    </BottomPane>
    <TimelineView v-else-if="active.kind === 'timeline'" :id="active.id" :key="layout.tab" />
    <SearchView v-else :by="active.kind" :value="active.value" :key="layout.tab" />
  </section>
</template>
