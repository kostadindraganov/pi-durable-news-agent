import { parseHTML } from "linkedom";
import type { Http } from "../http.ts";

const YOUTUBE = "https://www.youtube.com";
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const FEED_PATH = /^\/(?:xml\/)?feeds\/videos\.xml\/?$/;
const CHANNEL_ALIAS = /^\/(?:@[^/]+|(?:c|user)\/[^/]+)(?=\/|$)/;

export function isYouTube(url: URL): boolean {
  return /^(?:(?:www|m)\.)?youtube\.com$/i.test(url.hostname);
}

export function isYouTubeChannelUrl(url: URL): boolean {
  return (
    isYouTube(url) &&
    (CHANNEL_ALIAS.test(url.pathname) ||
      url.pathname.startsWith("/channel/") ||
      (FEED_PATH.test(url.pathname) && url.searchParams.has("channel_id")))
  );
}

export function youtubeChannelId(url: URL): string | undefined {
  if (!isYouTube(url)) return undefined;
  const id = FEED_PATH.test(url.pathname)
    ? url.searchParams.get("channel_id")
    : url.pathname.match(/^\/channel\/([^/]+)/)?.[1];
  return id && CHANNEL_ID.test(id) ? id : undefined;
}

export function youtubeFeedUrl(id: string): string {
  return `${YOUTUBE}/feeds/videos.xml?channel_id=${id}`;
}

export async function resolveYouTubeChannel(http: Http, url: URL): Promise<string> {
  const id = youtubeChannelId(url);
  if (id) return id;

  const alias = url.pathname.match(CHANNEL_ALIAS)?.[0];
  if (!alias) throw new Error("Use a YouTube channel link (youtube.com/@handle or /channel/UC…).");
  const page = `${YOUTUBE}${alias}`;
  const res = await http.get(page, { headers: { accept: "text/html" }, timeoutMs: 10_000 });
  const redirected = URL.parse(res.url);
  const redirectedId = redirected && youtubeChannelId(redirected);
  if (redirectedId) return redirectedId;

  const { document } = parseHTML(res.text);
  const channelId = document.querySelector('meta[itemprop="channelId"]')?.getAttribute("content");
  if (channelId && CHANNEL_ID.test(channelId)) return channelId;
  for (const link of document.querySelectorAll(
    'link[rel="canonical"], link[rel~="alternate"], meta[property="og:url"]',
  )) {
    const href = link.getAttribute("href") ?? link.getAttribute("content");
    if (!href) continue;
    const target = URL.parse(href, page);
    const targetId = target && youtubeChannelId(target);
    if (targetId) return targetId;
  }

  for (const script of document.querySelectorAll("script")) {
    const data = script.textContent?.trim().match(/^var ytInitialData\s*=\s*([\s\S]+?);?$/)?.[1];
    if (!data) continue;
    try {
      const initial = JSON.parse(data) as {
        metadata?: { channelMetadataRenderer?: { externalId?: unknown } };
      } | null;
      const externalId = initial?.metadata?.channelMetadataRenderer?.externalId;
      if (typeof externalId === "string" && CHANNEL_ID.test(externalId)) return externalId;
    } catch {
      // The page may return an incomplete script. Only use successfully parsed channel metadata.
    }
  }
  throw new Error(`Could not resolve the YouTube channel at ${page}. Use its /channel/UC… link.`);
}
