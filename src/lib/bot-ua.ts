/**
 * REEA-965 — shared bot/health-check traffic definition (R2 spec FR-3.2).
 *
 * One predicate, one vocabulary: every metrics emitter (server render
 * events today, any future surface) asks this module whether a request is
 * bot traffic, so the zero-result rate and CTR denominators always exclude
 * the same requests. Engineering-owned mechanism per the spec — a
 * User-Agent allowlist filter, the cheapest honest signal available
 * server-side.
 *
 * Data minimization note: the UA string is read for this decision only and
 * is never stored on any event.
 *
 * Missing UA counts as a bot: real browsers always send one, while uptime
 * pingers and health probes frequently don't. A missing UA is therefore
 * noise to exclude, not a human to count.
 */

/** Tokens that identify non-human fetchers (case-insensitive substrings). */
const BOT_TOKENS: readonly string[] = [
  "bot",
  "crawl",
  "spider",
  "slurp",
  "curl",
  "wget",
  "httpclient",
  "okhttp",
  "python-requests",
  "python-urllib",
  "go-http-client",
  "java/",
  "apache-httpclient",
  "libwww",
  "scrapy",
  "axios",
  "node-fetch",
  "undici",
  "postman",
  "insomnia",
  "headless",
  "uptime",
  "pingdom",
  "statuscake",
  "lighthouse",
  "pagespeed",
  "monitor",
  "preview",
  "vercel",
  "healthcheck",
  "health-check",
];

/** Fetchers that name no bot token but are still not shoppers. */
const EXACT_UAS: readonly string[] = ["", "-", "unknown", "mozilla", "dart:io"];

export function isBotUserAgent(ua: string | null | undefined): boolean {
  if (ua == null) return true;
  const uaNormalized = String(ua).trim().toLowerCase();
  if (EXACT_UAS.includes(uaNormalized)) return true;
  return BOT_TOKENS.some((token) => uaNormalized.includes(token));
}
