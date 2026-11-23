import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// REEA-375 / REEA-1076 CI secrets hygiene. Two checks:
//  1. The self-hosted deploy injects its SSH key from repo secrets and never
//     repeats it as a CLI argument (an arg is visible in ephemeral-runner
//     process listings). The Vercel decommission (REEA-1076) removed the last
//     workflow that read a Vercel credential, so no workflow may reference
//     VERCEL_TOKEN any more.
//  2. The shared checkout embedded the GitHub PAT in the git origin URL, so
//     every `git remote -v` dumped the credential. Fixed by moving the PAT to
//     a credential store (~/.git-credentials) with a clean origin URL.
describe("REEA-375 / REEA-1076 CI secrets hygiene", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const workflowsDir = path.join(repoRoot, ".github", "workflows");

  it("injects the deploy SSH key via env and never repeats it as a CLI arg", () => {
    const workflow = readFileSync(
      path.join(workflowsDir, "deploy-selfhosted.yml"),
      "utf8",
    );
    // env/printf injection must stay: the key comes from repo secrets only.
    expect(workflow).toContain("secrets.DEPLOY_SSH_KEY");
    expect(workflow).not.toContain("--token");
  });

  it("has no Vercel credential left in any workflow", () => {
    for (const file of ["deploy-selfhosted.yml", "smoke-scheduled.yml", "stamp-parity.yml", "timing-probe.yml", "uptime.yml"]) {
      const workflow = readFileSync(path.join(workflowsDir, file), "utf8");
      expect(workflow, `${file} still injects secrets.VERCEL_TOKEN`).not.toContain("secrets.VERCEL_TOKEN");
      expect(workflow, `${file} still injects secrets.VERCEL_TEAM_ID`).not.toContain("secrets.VERCEL_TEAM_ID");
    }
  });

  it("no longer ships a Vercel deploy path (REEA-1076)", () => {
    expect(existsSync(path.join(workflowsDir, "deploy.yml"))).toBe(false);
    expect(existsSync(path.join(workflowsDir, "pickup.yml"))).toBe(false);
    expect(existsSync(path.join(repoRoot, "vercel.json"))).toBe(false);
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
    // `git@`) carries no secret and is fine. REEA-813: platform CI hosts
    // (the retired Vercel git integration among them) legitimately check out
    // through ephemeral app identities like
    // `x-access-token:<ephemeral>@github.com` — a short-lived, host-issued
    // token that is not the durable PAT and never lands in the durable repo
    // config. Rejecting every `user:pass@` pair made the deploy gate
    // (`npm run test`) red on exactly those checkouts while the CLI deploy
    // path (no `.git` uploaded, test skipped) stayed green — the "two
    // deployments per commit, one fails one passes" pattern. The check now
    // polices the credential-embedding shape itself: a `user:secret@` pair
    // is tolerated only when the username is a platform-issued ephemeral
    // identity (x-access-token / git / oauth2); any other embedded pair
    // (e.g. `owner:github_pat_…`) still fails.
    const hostSegment = raw.startsWith("/")
      ? "" // filesystem-path clone: nothing to police in the authority
      : raw.includes("://")
        ? raw.slice(raw.indexOf("://") + 3).split("/")[0]
        : raw.split(/[:/]/)[0]; // scp-style host:path
    if (hostSegment) {
      expect(hostSegment.replace(/:\d+$/, "").replace(/^.*@/, "")).toMatch(/^[A-Za-z0-9.-]+$/);
      const userinfoAt = hostSegment.lastIndexOf("@");
      const userinfo = userinfoAt === -1 ? "" : hostSegment.slice(0, userinfoAt);
      if (userinfo.includes(":")) {
        const platformIssuedUser = new Set(["x-access-token", "git", "oauth2"]);
        const embeddedUser = userinfo.slice(0, userinfo.indexOf(":"));
        expect(
          platformIssuedUser.has(embeddedUser),
          `origin URL embeds a non-platform credential pair ('${embeddedUser}:…') — ` +
            `move the credential to ~/.git-credentials / credential.helper per REEA-375`,
        ).toBe(true);
      }
    }
  });
});
