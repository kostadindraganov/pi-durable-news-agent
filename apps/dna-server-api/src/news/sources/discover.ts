// Turn a link into a source future sweeps can fetch: the page's own feed, a feed it links to, a common feed path,
// GitHub releases for a repo, or the page itself as an article listing.
import { parseHTML } from "linkedom";
import type { Source, SourceKind } from "@dna/sdk";
import type { Http } from "../http.ts";
import { parseFeed } from "./rss.ts";
import { listingLinks } from "./webpage.ts";
import {
  isYouTube,
  isYouTubeChannelUrl,
  resolveYouTubeChannel,
  youtubeChannelId,
  youtubeFeedUrl,
} from "./youtube.ts";

/** Sites that are already searched every sweep, or that have no feed to follow. */
export const AGGREGATORS = [
  "news.ycombinator.com",
  "hn.algolia.com",
  "bing.com",
  "google.com",
  "x.com",
  "twitter.com",
  "t.co",
];

const FEED_PATHS = ["/feed", "/rss.xml", "/atom.xml", "/feed.xml", "/index.xml"];

export interface Discovered {
  kind: SourceKind;
  url: string;
  name: string;
  entries: number;
}

/** The host, with separate keys for GitHub repos and identified YouTube channels. */
export function siteKey(url: string): string {
  const u = new URL(url);
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (isYouTube(u)) {
    const id = youtubeChannelId(u);
    return id ? `youtube.com/channel/${id}` : "youtube.com";
  }
  if (host === "github.com") {
    const [owner, repo] = u.pathname.split("/").filter(Boolean);
    if (owner && repo) return `github.com/${owner}/${repo}`.toLowerCase();
  }
  return host;
}

export const isAggregator = (url: string) => {
  const host = siteKey(url);
  return AGGREGATORS.some((a) => host === a || host.endsWith(`.${a}`));
};

/** The source already watching this site, if any. */
export function watching(sources: Source[], url: string): Source | undefined {
  const key = siteKey(url);
  const kinds = key.startsWith("youtube.com/channel/")
    ? ["rss", "atom"]
    : ["rss", "atom", "github_releases", "web_page"];
  return sources.find((s) => s.url && kinds.includes(s.kind) && siteKey(s.url) === key);
}

export const isFeed = (text: string) => /<(rss|feed|rdf:RDF)[\s>]/i.test(text.slice(0, 4000));

const feedKind = (text: string): SourceKind =>
  /<feed[\s>]/i.test(text.slice(0, 4000)) ? "atom" : "rss";

function titleOf(text: string, fallback: string): string {
  const t = text.match(/<title[^>]*>([^<]{2,120})<\/title>/i)?.[1]?.trim();
  return (t ? t.replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "") || fallback;
}

export async function discoverSource(http: Http, link: string): Promise<Discovered> {
  const page = new URL(link);
  const host = siteKey(link);
  const youtube = isYouTubeChannelUrl(page);
  const feedUrl = youtube ? youtubeFeedUrl(await resolveYouTubeChannel(http, page)) : link;
  const tryFeed = async (url: string): Promise<Discovered | undefined> => {
    try {
      const res = await http.get(url, {
        headers: { accept: "application/rss+xml, application/atom+xml, application/xml" },
        timeoutMs: 10_000,
      });
      if (!isFeed(res.text)) return undefined;
      return {
        kind: feedKind(res.text),
        url: res.url || url,
        name: titleOf(res.text, host),
        entries: parseFeed(res.text, url).length,
      };
    } catch {
      return undefined;
    }
  };

  if (host.startsWith("github.com/")) {
    const url = `https://${host}/releases.atom`;
    const feed = await tryFeed(url);
    if (!feed) throw new Error(`No releases feed for ${host}`);
    return { ...feed, kind: "github_releases", url, name: `${host.split("/")[2]} releases` };
  }

  const res = await http.get(feedUrl, {
    headers: {
      accept: youtube
        ? "application/atom+xml, application/xml"
        : "text/html, application/rss+xml, application/atom+xml",
    },
    timeoutMs: 10_000,
  });
  if (isFeed(res.text) && (!youtube || feedKind(res.text) === "atom"))
    return {
      kind: feedKind(res.text),
      url: youtube ? feedUrl : res.url || link,
      name: titleOf(res.text, host),
      entries: parseFeed(res.text, feedUrl).length,
    };
  if (youtube) throw new Error(`YouTube did not return an Atom feed for ${feedUrl}.`);

  const { document } = parseHTML(res.text);
  const alternates = (
    [
      ...document.querySelectorAll(
        'link[rel~="alternate"][type="application/rss+xml"], link[rel~="alternate"][type="application/atom+xml"]',
      ),
    ] as any[]
  )
    .map((l) => {
      try {
        return new URL(l.getAttribute("href"), page).toString();
      } catch {
        return undefined;
      }
    })
    .filter((u): u is string => !!u && !/comments/i.test(u))
    .slice(0, 3);
  for (const url of alternates) {
    const feed = await tryFeed(url);
    if (feed) return feed;
  }
  for (const path of FEED_PATHS) {
    const feed = await tryFeed(new URL(path, page.origin).toString());
    if (feed) return feed;
  }
  const links = listingLinks(res.text, link);
  if (links.length >= 3)
    return { kind: "web_page", url: link, name: titleOf(res.text, host), entries: links.length };
  throw new Error(
    `No feed and no article listing at ${link}. Pass the site's blog or news page instead.`,
  );
}
