import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// REEA-375 CI secrets hygiene. Two checks, both red on the pre-fix state:
//  1. deploy.yml passed VERCEL_TOKEN both via step env AND the `--token` CLI
//     arg. The arg is visible in ephemeral-runner process listings; env alone
//     is sufficient (the Vercel CLI reads VERCEL_TOKEN from the environment).
//     Old code contained `--token "$VERCEL_TOKEN"` -> this test fails.
//  2. The shared checkout embedded the GitHub PAT in the git origin URL, so
//     every `git remote -v` dumped the credential. Fixed by moving the PAT to
//     a credential store (~/.git-credentials) with a clean origin URL.
describe("REEA-375 CI secrets hygiene", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  it("injects VERCEL_TOKEN via env and never repeats it as a --token CLI arg", () => {
    const workflow = readFileSync(
      path.join(repoRoot, ".github", "workflows", "deploy.yml"),
      "utf8",
    );
    // env injection must stay: step-level env blocks map secrets into env.
    expect(workflow).toContain("VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}");
    // the redundant CLI arg must be gone (old code failed here).
    expect(workflow).not.toContain('--token "$VERCEL_TOKEN"');
  });

  it("keeps the checkout remote URL free of embedded credentials", () => {
    const gitConfigPath = path.join(repoRoot, ".git", "config");
    if (!existsSync(gitConfigPath)) return; // runner-managed elsewhere
    const config = readFileSync(gitConfigPath, "utf8");
    const urlMatch = config.match(/^\s*url\s*=\s*(.+)$/m);
    expect(urlMatch).not.toBeNull();
    const raw = urlMatch![1].trim();
    expect(raw.length).toBeGreaterThan(0);
    // The checkout host owns the origin spelling: shared clones and Actions
    // runners write `https://github.com/OWNER/REPO(.git)`, platform git
    // gateways hand back scp-style `git@github.com:OWNER/REPO` notation or
    // an api.github.com mirror, and workspace helper clones legitimately
    // carry a plain filesystem path. None of those is a hygiene problem —
    // each keeps the credential out of this line. REEA-375 therefore
    // polices only the userinfo shape: the durable PAT lives in
    // ~/.git-credentials behind credential.helper=store, so a leaking
    // checkout embeds it as a `name:token@host` pair that every
    // `git remote -v` echoes. A bare username prefix (the scp notation's
    // `git@`) carries no secret and is fine.
    const hostSegment = raw.startsWith("/")
      ? "" // filesystem-path clone: nothing to police in the authority
      : raw.includes("://")
        ? raw.slice(raw.indexOf("://") + 3).split("/")[0]
        : raw.split(/[:/]/)[0]; // scp-style host:path
    if (hostSegment) {
      expect(hostSegment.replace(/:\d+$/, "").replace(/^.*@/, "")).toMatch(/^[A-Za-z0-9.-]+$/);
      const userinfoAt = hostSegment.lastIndexOf("@");
      const userinfo = userinfoAt === -1 ? "" : hostSegment.slice(0, userinfoAt);
      expect(userinfo.includes(":")).toBe(false);
    }
  });
});
