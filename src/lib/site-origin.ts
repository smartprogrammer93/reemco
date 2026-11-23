/**
 * REEA-1051 / REEA-1076 — canonical site origin for crawler-facing routes.
 *
 * /sitemap.xml and /robots.txt used to name `https://reemco.vercel.app` as a
 * literal. On the self-hosted box that advertised the Vercel rollback alias —
 * which answered 402 DEPLOYMENT_DISABLED — as the canonical host, so every URL
 * a crawler learned from the live box pointed at a dead origin.
 *
 * The origin now comes from `REEMCO_SITE_ORIGIN`, which infra/compose.prod.yml
 * derives from the one `REEMCO_SITE_ADDRESS` line in /etc/reemco/release.env.
 * That keeps the crawler surface on whichever host is actually serving without
 * a code change. Since REEA-1076 (Vercel decommissioned) the compiled-in
 * fallback is the production host too, so a plain local run does not advertise
 * the dead alias either.
 *
 * Invalid/unusable values fall back to the default rather than emitting a
 * broken absolute URL: a sitemap entry must be an absolute http(s) origin.
 */

export const DEFAULT_SITE_ORIGIN = "https://ns539626.ip-144-217-72.net";

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
