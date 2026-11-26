/**
 * REEA-1224 — pins for the deploy gate's flight-payload notes parser.
 *
 * The bug this closes: scripts/smoke-check.mjs step 7 regexed
 * `notes\":[([^\]]*)]` out of the served results HTML. That stops at the first
 * `]` ANYWHERE, including inside a note's `error` string. The Next Store
 * browser-tier failure now carries such a character (`... --disable-background-n]`),
 * so the "longest" match was really an intermediate flush and the gate reported
 * Sultan Center / Lulu Hypermarket / Aster Pharmacy as missing from a healthy
 * build — run 45843129328 rolled 4ae6884 back on that false positive.
 *
 * The unit is scripts/flight-notes.mjs; the static pins keep smoke-check.mjs
 * wired to it so the naive regex cannot come back.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const flight: any = await import("../../../scripts/flight-notes.mjs");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Build a raw RSC notes array the way the flight payload escapes it. */
function notesArray(notes: Array<{ merchant: string; error?: string }>) {
  const body = notes
    .map((n) => {
      const error = n.error === undefined ? "" : `,\\"error\\":\\"${n.error}\\"`;
      return `{\\"merchant\\":\\"${n.merchant}\\",\\"hits\\":0,\\"coupons\\":0${error}}`;
    })
    .join(",");
  return `notes\\":[${body}]`;
}

describe("REEA-1224 flight-notes parser", () => {
  it("keeps a note whose error string contains a literal ]", () => {
    const error = "blocked: no usable payload from any Next Store hop (challenge shell, no Magento grid) [browser: launch closed\\\\nBrowser logs:\\\\n\\\\n\u003claunching\u003e /tmp/chromium --disable-field-trial-config --disable-background-n]";
    const html = `{"a":1,${notesArray([{ merchant: "Xcite" }, { merchant: "Next Store", error }])},\\"suggestions\\":[]}`;
    const arrays = flight.extractNotesArrays(html);
    expect(arrays).toHaveLength(1);
    expect(flight.notesMerchants(arrays[0])).toEqual(["Xcite", "Next Store"]);
  });

  it("does not treat ] inside a plain note as the array end", () => {
    const html = notesArray([{ merchant: "Xcite" }, { merchant: "Eureka" }]);
    expect(flight.notesMerchants(flight.extractNotesArrays(html)[0])).toEqual(["Xcite", "Eureka"]);
  });

  it("returns every dispatched lane from the longest (final) flush", () => {
    const required = ["Xcite", "Blink", "Eureka", "Sultan Center", "Jarir", "Amazon.eg", "Quadra Stores", "Lulu Hypermarket"];
    const early = notesArray([{ merchant: "Xcite" }, { merchant: "Next Store", error: "browser: closed]" }]);
    const final = notesArray([
      ...required.map((merchant) => ({ merchant })),
      { merchant: "Next Store", error: "browser: closed] and [more]" },
      { merchant: "Aster Pharmacy" },
    ]);
    const html = `[${early}],"x":1,${final},"y":2`;
    const longest = flight.longestNotesArray(html);
    expect(longest).not.toBeNull();
    const merchants = flight.notesMerchants(longest);
    for (const m of required) expect(merchants).toContain(m);
    expect(merchants).toHaveLength(10);
  });

  it("returns null when the payload has no notes array", () => {
    expect(flight.longestNotesArray("<html><body>no payload</body></html>")).toBeNull();
  });

  it("does not stop at a bracket inside an escaped backslash sequence", () => {
    const html = notesArray([
      { merchant: "Xcite", error: "line1\\\\nline2 \\\\u005b not a bracket" },
      { merchant: "Eureka" },
    ]);
    expect(flight.notesMerchants(flight.extractNotesArrays(html)[0])).toEqual(["Xcite", "Eureka"]);
  });
});

describe("REEA-1224 gate wiring", () => {
  const smoke = readFileSync(path.join(repoRoot, "scripts", "smoke-check.mjs"), "utf8");

  it("step 7 parses notes through the bracket-aware helper", () => {
    expect(smoke).toContain('from "./flight-notes.mjs"');
    expect(smoke).toContain("longestNotesArray(html)");
    expect(smoke).toContain("notesMerchants(finalNotes)");
  });

  it("no naive notes regex remains in the smoke", () => {
    expect(smoke).not.toContain("matchAll(/notes");
  });
});
