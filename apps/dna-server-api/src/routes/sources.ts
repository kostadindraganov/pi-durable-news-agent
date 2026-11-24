// Sources: feeds, Hacker News, GitHub releases and pages, with their last fetch status.
import type { SourceKind } from "@dna/sdk";
import { int, invalid, notFound } from "../errors.ts";
import { watching } from "../news/sources/discover.ts";
import { youtubeChannelId, youtubeFeedUrl } from "../news/sources/youtube.ts";
import { bodyOf, bool, num, oneOf, str, type Handlers, type RouteDeps } from "./types.ts";

const KINDS: readonly SourceKind[] = [
  "rss",
  "atom",
  "hn_front",
  "hn_search",
  "github_releases",
  "web_page",
];

export function sourceRoutes({
  app,
}: RouteDeps): Handlers<"sources.list" | "sources.add" | "sources.update" | "sources.remove"> {
  const { store } = app;
  return {
    "sources.list": (_req, res) => res.json(store.sources.list()),
    "sources.add": (req, res) => {
      const body = bodyOf(req);
      const kind = oneOf(body.kind, "kind", KINDS)!;
      const url = str(body, "url", { max: 500, optional: true });
      if (url && !url.startsWith("https://")) throw invalid("url must start with https://");
      if (kind !== "hn_front" && kind !== "hn_search" && !url) throw invalid(`${kind} needs a url`);
      const name = str(body, "name", { max: 80 });
      const weight = num(body, "weight", { min: 0.1, max: 2 });
      const intervalMin = num(body, "intervalMin", { min: 15, max: 1440, integer: true });
      const query = str(body, "query", { max: 200, optional: true });
      const parsed = url && (kind === "atom" || kind === "rss") ? URL.parse(url) : null;
      const id = parsed && youtubeChannelId(parsed);
      const feedUrl = id ? youtubeFeedUrl(id) : undefined;
      if (feedUrl) {
        const existing = watching(store.sources.list(), feedUrl);
        if (existing) return res.status(200).json(existing);
      }
      const source = store.sources.add({
        kind: feedUrl ? "atom" : kind,
        name,
        url: feedUrl ?? url,
        query,
        weight,
        intervalMin,
        origin: "user",
      });
      app.log.info("sources.added", { id: source.id, kind: source.kind, name: source.name });
      res.status(201).json(source);
    },
    "sources.update": (req, res) => {
      const body = bodyOf(req);
      const source = store.sources.update(int(req.params.id, "id"), {
        name: str(body, "name", { max: 80, optional: true }),
        enabled: bool(body, "enabled"),
        weight: num(body, "weight", { min: 0.1, max: 2 }),
        intervalMin: num(body, "intervalMin", { min: 15, max: 1440, integer: true }),
      });
      if (!source) throw notFound(`No source ${req.params.id}`);
      res.json(source);
    },
    "sources.remove": (req, res) => {
      if (!store.sources.remove(int(req.params.id, "id")))
        throw notFound(`No source ${req.params.id}`);
      res.json({ ok: true });
    },
  };
}
