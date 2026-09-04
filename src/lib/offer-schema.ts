/**
 * F3 remediation — scraped-record ingestion schema (REEA-13).
 *
 * Zod schema applied to every record the scraper produces BEFORE it is
 * persisted. Bounds every attacker-influenced field; strips control
 * characters; makes price spoofing attributable via provenance fields.
 * Security lenses: Input validation (allowlist/bounds), Data protection,
 * STRIDE Tampering on the retailer->scraper flow.
 *
 * Requires: npm i zod
 */
import { z } from "zod";

// C0 controls + DEL, stripped from all scraped free-text fields.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

const cleanString = (max: number) =>
  z
    .string()
    .transform((s) => s.replace(CONTROL_CHARS, "").trim())
    .pipe(z.string().min(1).max(max));

/** Reuse the F1 allowlist so URL rules live in exactly one place. */
const safeUrl = z.string().max(2048).superRefine((val, ctx) => {
  // Import cycle-safe inline check mirroring sanitizeExternalUrl;
  // prefer importing { sanitizeExternalUrl } from "./safe-url" in-repo.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(val)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "control characters in URL" });
    return;
  }
  let u: URL;
  try {
    u = new URL(val);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "unparseable URL" });
    return;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `scheme not allowed: ${u.protocol}` });
  }
  if (u.username || u.password) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "userinfo in URL" });
  }
});

export const ISO_4217 = z.enum([
  "USD", "EUR", "GBP", "CAD", "AUD", "NZD", "JPY", "CNY", "INR", "BRL",
  "MXN", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK", "ZAR", "SGD", "HKD", "KRW",
]);

export const priceSchema = z
  .number()
  .nonnegative("price must be >= 0")
  .max(10_000_000, "price above sane upper bound — likely parse corruption");

export const offerSchema = z.object({
  merchantName: cleanString(120),
  url: safeUrl,
  price: priceSchema,
  currency: ISO_4217,
  availability: z.enum(["in_stock", "out_of_stock", "preorder", "unknown"]).default("unknown"),
  couponCode: cleanString(64).optional(),
  // Provenance — mandatory so spoofed prices are attributable and stale
  // data is renderable as "price as of <fetchedAt>".
  sourceUrl: safeUrl,
  fetchedAt: z.coerce.date(),
  scraperRunId: z.string().min(1).max(64),
});

export const productSchema = z.object({
  title: cleanString(300),
  brand: cleanString(120).optional(),
  imageUrl: safeUrl.optional(),
  offers: z.array(offerSchema).min(1).max(50),
});

export type Offer = z.infer<typeof offerSchema>;
export type Product = z.infer<typeof productSchema>;

/** Scraper fetch guard: configured retailer domains ONLY (SSRF defense). */
export function assertFetchAllowed(targetUrl: string, retailerAllowlist: readonly string[]): URL {
  const u = new URL(targetUrl);
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`Scraper fetch refused, scheme not allowed: ${u.protocol}`);
  }
  const host = u.hostname.toLowerCase();
  const ok = retailerAllowlist.some(
    (d) => host === d.toLowerCase() || host.endsWith("." + d.toLowerCase()),
  );
  if (!ok) {
    // Fail securely: never fetch user- or retailer-submitted arbitrary URLs.
    throw new Error(`Scraper fetch refused, host not in retailer allowlist: ${host}`);
  }
  return u;
}
