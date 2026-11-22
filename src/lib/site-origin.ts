/**
 * REEA-1051 — canonical site origin for crawler-facing routes.
 *
 * /sitemap.xml and /robots.txt named `https://reemco.vercel.app` as a literal.
 * On the self-hosted box that advertised the Vercel rollback alias — which is
 * currently answering 402 DEPLOYMENT_DISABLED — as the canonical host, so
 * every URL a crawler learned from the live box pointed at a dead origin.
 *
 * The origin now comes from `REEMCO_SITE_ORIGIN`, which infra/compose.prod.yml
 * derives from the one `REEMCO_SITE_ADDRESS` line in /etc/reemco/release.env.
 * That keeps the crawler surface on whichever host is actually serving
 * (standup hostname today, the cutover domain when the board flips DNS)
 * without a code change, and the historical Vercel origin stays the default so
 * a Vercel rollback deployment (or a plain local run) is byte-for-byte
 * unchanged.
 *
 * Invalid/unusable values fall back to the default rather than emitting a
 * broken absolute URL: a sitemap entry must be an absolute http(s) origin.
 */

export const DEFAULT_SITE_ORIGIN = "https://reemco.vercel.app";

export function siteOrigin(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.REEMCO_SITE_ORIGIN || "").trim();
  if (raw === "") return DEFAULT_SITE_ORIGIN;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return DEFAULT_SITE_ORIGIN;
    return parsed.origin;
  } catch {
    return DEFAULT_SITE_ORIGIN;
  }
}
