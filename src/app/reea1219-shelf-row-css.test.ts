import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * REEA-1219 — shelf-card offer-row collision gate (CSS pins).
 *
 * The REEA-1205 responsive-spec block fixed `.rc-card .rc-offer-row` to 72px
 * with 22px/44px grid rows and fixed the 375 row to 92px. A chip-heavy row
 * (label + grade + mismatch + market + status) is genuinely overfull there, so
 * its flex lines painted over the caption and the neighbouring row — the
 * REEA-848/850 defect class the board re-reported. The fix turns both boxes
 * into FLOORS (`min-block-size`) with `minmax(…, auto)` rows, keeps the action
 * in the inline-end slot when line-b wraps, and stops the 375 status token /
 * wordmark from painting outside their own boxes.
 *
 * These pins fail if a future edit restores a fixed height or drops one of the
 * containment rules.
 */
const CSS_PATH = join(process.cwd(), "src/app/globals.css");
const raw = readFileSync(CSS_PATH, "utf8");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

function blockBody(src: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(openIndex + 1, i);
    }
  }
  throw new Error("unbalanced braces in globals.css");
}

function mediaBlocks(src: string, query: string): string {
  const out: string[] = [];
  const marker = `@media ${query}`;
  let from = 0;
  for (;;) {
    const at = src.indexOf(marker, from);
    if (at < 0) return out.join("\n");
    const open = src.indexOf("{", at);
    out.push(blockBody(src, open));
    from = open + 1;
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ruleFor = (src: string, selector: string) => {
  const at = src.indexOf(`${selector} {`);
  if (at < 0) return null;
  const open = src.indexOf("{", at);
  return blockBody(src, open);
};

const min641 = mediaBlocks(css, "(min-width: 641px)");
const max640 = mediaBlocks(css, "(max-width: 640px)");

describe("REEA-1219 — shelf card row is a floor, not a fixed box", () => {
  it("≥641 row keeps the 72px floor and lets an overfull row grow", () => {
    const body = ruleFor(min641, ".rc-card .rc-offer-row") ?? "";
    expect(body).toContain("grid-template-rows: minmax(22px, auto) minmax(44px, auto)");
    expect(body).toContain("min-block-size: 72px");
    expect(body).toContain("block-size: auto");
    expect(body).not.toMatch(/^\s*block-size:\s*72px/m);
  });

  it("≥641 action keeps the inline-end slot when line-b wraps", () => {
    const body = ruleFor(min641, ".rc-card .rc-offer-row .rc-offer-cta") ?? "";
    expect(body).toContain("margin-inline-start: auto");
    expect(body).toContain("min-inline-size: 60px");
  });

  it("<641 row keeps the 92px floor and lets an overfull row grow", () => {
    const bodies = [...max640.matchAll(new RegExp(`${escape(".rc-offer-row")}\\s*\\{[^}]*\\}`, "g"))].map((m) => m[0]);
    const body = bodies.find((b) => b.includes("min-block-size: var(--rc-row-h-mobile)") && b.includes("block-size: auto")) ?? "";
    expect(body).toContain("block-size: auto");
    expect(body).toContain("min-block-size: var(--rc-row-h-mobile)");
  });

  it("<641 wordmark cannot paint outside its cell", () => {
    const retailer = ruleFor(max640, ".rc-card .rc-offer-row .rc-retailer-name") ?? "";
    expect(retailer).toContain("overflow: hidden");
    const logo = ruleFor(max640, ".rc-card .rc-offer-row .rc-retailer-name .logo") ?? "";
    expect(logo).toContain("min-inline-size: 0");
    expect(logo).toContain("inline-size: 100%");
  });

  it("<641 status token takes its natural width and cannot paint outside itself", () => {
    const status = ruleFor(max640, ".rc-card .rc-offer-row .rc-status") ?? "";
    expect(status).toContain("max-inline-size: none");
    expect(status).toContain("overflow: hidden");
  });

  it("price runs are line boxes, not font boxes", () => {
    const selector = [
      ".rc-offer-row .price-cur bdi",
      ".rc-offer-row .rc-row-was bdi",
      ".rc-offer-row .rc-row-savings bdi",
      ".rc-offer-row .price-alt bdi",
      ".rc-price-line .price-cur bdi",
      ".rc-price-line .rc-price-was bdi",
      ".rc-price-line .price-warn bdi",
    ].join(",\n");
    const body = ruleFor(css, selector) ?? "";
    expect(body).toContain("display: inline-block");
  });
});
