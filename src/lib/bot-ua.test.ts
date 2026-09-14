import { describe, expect, it } from "vitest";
import { isBotUserAgent } from "@/lib/bot-ua";

/** REEA-965 — the shared bot/health-check definition (R2 spec FR-3.2).
 *  One predicate governs every metrics emitter so the zero-result rate and
 *  CTR denominators always exclude the same traffic. */
describe("isBotUserAgent", () => {
  it("counts real shopper browsers as human", () => {
    expect(
      isBotUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      ),
    ).toBe(false);
    expect(
      isBotUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(false);
    expect(
      isBotUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe(false);
  });

  it("counts crawlers, pingers and client libraries as bots", () => {
    expect(isBotUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(true);
    expect(isBotUserAgent("Mozilla/5.0 (compatible; bingbot/2.0)")).toBe(true);
    expect(isBotUserAgent("curl/8.4.0")).toBe(true);
    expect(isBotUserAgent("python-requests/2.31")).toBe(true);
    expect(isBotUserAgent("node-fetch/1.0 (+https://github.com/bitinn/node-fetch)")).toBe(true);
    expect(isBotUserAgent("Pingdom.com_bot_version_1.4")).toBe(true);
    expect(isBotUserAgent("Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/128")).toBe(true);
    expect(isBotUserAgent("Lighthouse/128")).toBe(true);
  });

  it("treats a missing or empty UA as a bot (health pingers omit it)", () => {
    expect(isBotUserAgent(null)).toBe(true);
    expect(isBotUserAgent(undefined)).toBe(true);
    expect(isBotUserAgent("")).toBe(true);
    expect(isBotUserAgent("   ")).toBe(true);
    expect(isBotUserAgent("-")).toBe(true);
  });
});
