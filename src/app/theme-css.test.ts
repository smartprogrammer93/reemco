import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * REEA-1159 — theme CSS parity.
 *
 * The theme control adds an explicit `data-theme` override on top of the
 * shipped OS-following dark rules. CSS has no mixins, so the dark token map and
 * the six component-level contrast remedies are declared twice: once inside
 * `@media (prefers-color-scheme: dark)` (guarded so an explicit LIGHT choice
 * wins on a dark-OS device) and once under `:root[data-theme="dark"]` (the
 * stored choice on any OS). This test pins the two copies together: a future
 * contrast fix applied to one side and not the other fails here instead of
 * shipping a half-themed surface.
 */
const CSS_PATH = join(process.cwd(), "src/app/globals.css");
const raw = readFileSync(CSS_PATH, "utf8");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

const MEDIA_MARKER = "@media (prefers-color-scheme: dark)";
const OS_GUARD = ':root:not([data-theme="light"])';
const EXPLICIT = ':root[data-theme="dark"]';

function blockBody(src: string, openIndex: number): { body: string; end: number } {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return { body: src.slice(openIndex + 1, i), end: i };
    }
  }
  throw new Error("unbalanced braces in globals.css");
}

function mediaDarkBlocks(src: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(MEDIA_MARKER, from);
    if (at === -1) break;
    const open = src.indexOf("{", at + MEDIA_MARKER.length);
    const { body, end } = blockBody(src, open);
    blocks.push(body);
    from = end + 1;
  }
  return blocks;
}

type Rule = { selectors: string[]; declarations: Set<string> };

function parseRules(src: string): Rule[] {
  const rules: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    rules.push({
      selectors: m[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      declarations: new Set(
        m[2]
          .replace(/\s+/g, "")
          .split(";")
          .filter(Boolean),
      ),
    });
  }
  return rules;
}

const mediaBlocks = mediaDarkBlocks(css);

/** base selector (guard stripped) -> declarations declared for explicit dark. */
const explicitDark = new Map<string, Set<string>>();
for (const rule of parseRules(css)) {
  for (const selector of rule.selectors) {
    if (!selector.startsWith(EXPLICIT)) continue;
    const stripped = selector.slice(EXPLICIT.length).trim();
    const base = stripped === "" ? ":root" : stripped;
    const merged = explicitDark.get(base) ?? new Set<string>();
    rule.declarations.forEach((d) => merged.add(d));
    explicitDark.set(base, merged);
  }
}

describe("OS dark blocks stay guarded (REEA-1159 AC2)", () => {
  it("ships the dark media blocks the board measured", () => {
    expect(mediaBlocks.length).toBeGreaterThanOrEqual(6);
  });

  it("every rule inside an OS dark block yields to an explicit light choice", () => {
    for (const block of mediaBlocks) {
      for (const rule of parseRules(block)) {
        expect(rule.selectors.length).toBeGreaterThan(0);
        for (const selector of rule.selectors) {
          expect(selector).toContain(OS_GUARD);
        }
      }
    }
  });
});

describe("explicit dark parity (REEA-1159 AC2/AC5)", () => {
  it("every OS-dark declaration has the identical explicit-dark declaration", () => {
    for (const block of mediaBlocks) {
      for (const rule of parseRules(block)) {
        for (const selector of rule.selectors) {
          const stripped = selector.split(OS_GUARD).join("").trim();
          const target = stripped === "" ? ":root" : stripped;
          const declared = explicitDark.get(target);
          expect(declared, `missing explicit-dark rule for "${target}"`).toBeDefined();
          for (const declaration of rule.declarations) {
            expect(
              declared?.has(declaration),
              `"${target}" is missing "${declaration}"`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("the explicit dark token block also sets color-scheme: dark", () => {
    expect(css).toMatch(/:root\[data-theme="dark"\]\s*\{[^}]*color-scheme:\s*dark/);
  });

  it("an explicit light choice sets color-scheme: light (no new palette)", () => {
    expect(css).toMatch(/:root\[data-theme="light"\]\s*\{[^}]*color-scheme:\s*light/);
  });

  it("reuses only the shipped --rc-dark-* tokens in the dark mapping", () => {
    const mapping = css.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/);
    expect(mapping).not.toBeNull();
    const values = [...(mapping?.[1] ?? "").matchAll(/var\((--rc-dark-[a-z-]+)\)/g)].map(
      (m) => m[1],
    );
    expect(values.length).toBeGreaterThan(15);
    for (const token of values) expect(raw).toContain(`${token}:`);
  });
});

describe("theme control geometry (REEA-1159 AC1/AC4)", () => {
  it("rides the shared 44px header-control box", () => {
    expect(css).toMatch(
      /\.rc-icon-btn,\s*\.rc-lang-btn\s*\{[^}]*min-inline-size:\s*var\(--rc-tap\)[^}]*block-size:\s*var\(--rc-tap\)/,
    );
  });

  it("styles the theme button and its pressed state", () => {
    expect(css).toContain(".rc-theme-btn");
    expect(css).toMatch(/\.rc-theme-btn\[aria-pressed="true"\]/);
  });
});
