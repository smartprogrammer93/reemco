import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// REEA-1135 (F6/F7) — two low-severity CI supply-chain / secret-hygiene pins.
//
// F7: workflows used to reference `actions/checkout@v4` and
// `actions/setup-node@v4` by mutable major tag. A tag can be re-pointed by the
// action owner, and the deploy job holds DEPLOY_SSH_KEY, so a silent action
// change would run with production credentials. The fix pins by full commit
// SHA (with the human-readable version kept in a comment) and enables
// Dependabot for github-actions so the pins are bumped in reviewed PRs rather
// than rotting. This test fails if a mutable tag reappears.
//
// F6: scripts/push-main.sh built AUTH_URL="https://x-access-token:$TOKEN@..."
// and passed it to `git fetch` / `git ls-remote`, so the PAT was in those
// processes' argv and readable from `ps`. The fix routes every authenticated
// git call through the same one-shot credential helper (token supplied via the
// exported env var, never in argv). This test pins that shape and checks the
// helper actually reads the token from the environment.
describe("REEA-1135 (F7) — workflow actions are pinned by commit SHA", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const workflowsDir = path.join(repoRoot, ".github", "workflows");
  const workflowFiles = readdirSync(workflowsDir)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();

  const usesLines = workflowFiles.flatMap((file) => {
    const lines = readFileSync(path.join(workflowsDir, file), "utf8").split("\n");
    return lines.flatMap((line, index) => {
      const match = line.match(/^\s*(?:-\s*)?uses:\s*(\S+)/);
      if (!match) return [];
      return [{ file, line: index + 1, raw: line, ref: match[1] }];
    });
  });

  it("finds the action references it is meant to police", () => {
    // A workflow rewrite that removes every `uses:` would make the checks below
    // vacuously pass; assert we still see the two actions we depend on.
    const refs = usesLines.map((entry) => entry.ref);
    expect(refs.some((ref) => ref.startsWith("actions/checkout@"))).toBe(true);
    expect(refs.some((ref) => ref.startsWith("actions/setup-node@"))).toBe(true);
  });

  it("uses a full 40-hex commit SHA, never a mutable tag or branch", () => {
    const offenders: string[] = [];
    for (const entry of usesLines) {
      // Local composite actions and container actions are out of scope: a
      // `./path` action ships with this repo, and a docker:// image should be
      // digest-pinned separately (none are used today).
      if (entry.ref.startsWith("./") || entry.ref.startsWith("docker://")) continue;
      const at = entry.ref.lastIndexOf("@");
      const pinned = at === -1 ? "" : entry.ref.slice(at + 1);
      if (!/^[0-9a-f]{40}$/.test(pinned)) {
        offenders.push(`${entry.file}:${entry.line} ${entry.ref}`);
      }
    }
    expect(
      offenders,
      `mutable action refs (pin by commit SHA + "# vX.Y.Z" comment):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps the human-readable version beside every SHA pin", () => {
    // Dependabot rewrites both the SHA and this comment; without it a reviewer
    // cannot tell which release a bare 40-hex ref is.
    const offenders: string[] = [];
    for (const entry of usesLines) {
      if (entry.ref.startsWith("./") || entry.ref.startsWith("docker://")) continue;
      if (!/#\s*v\d+\.\d+\.\d+/.test(entry.raw)) {
        offenders.push(`${entry.file}:${entry.line} ${entry.ref}`);
      }
    }
    expect(offenders, `SHA pins missing a "# vX.Y.Z" comment:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("enables Dependabot for github-actions so the pins are bumped", () => {
    const dependabotPath = path.join(repoRoot, ".github", "dependabot.yml");
    expect(existsSync(dependabotPath)).toBe(true);
    const config = readFileSync(dependabotPath, "utf8");
    expect(config).toMatch(/version:\s*["']?2["']?/);
    expect(config).toMatch(/package-ecosystem:\s*["']?github-actions["']?/);
    expect(config).toMatch(/directory:\s*["']?\/["']?/);
  });
});

describe("REEA-1135 (F6) — push-main.sh keeps the PAT out of git argv", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const scriptPath = path.join(repoRoot, "scripts", "push-main.sh");
  const script = readFileSync(scriptPath, "utf8");
  const helperMatch = script.match(/^CRED_HELPER='([^']*)'/m);

  it("defines one credential helper and reuses it for fetch, push and ls-remote", () => {
    expect(helperMatch, "push-main.sh must define CRED_HELPER").not.toBeNull();
    const helperUses = script.match(/-c credential\.helper="\$CRED_HELPER"/g) ?? [];
    // fetch (pre-flight), push, and the post-push read-back.
    expect(helperUses.length).toBeGreaterThanOrEqual(3);
    expect(script).toMatch(/fetch --no-tags --quiet origin refs\/heads\/main/);
    expect(script).toMatch(/push --quiet origin "\$SHA:refs\/heads\/main"/);
    expect(script).toMatch(/ls-remote --heads origin refs\/heads\/main/);
  });

  it("never embeds the token in a URL argument (the old AUTH_URL shape)", () => {
    // Any of these would put the PAT in argv and therefore in `ps`.
    expect(script).not.toMatch(/x-access-token:\$(?:TOKEN|DEV_GITHUB_PAT)@/);
    // No URL variable is built with the token any more (the old AUTH_URL).
    expect(script).not.toMatch(/^\s*AUTH_URL=/m);
    // Authenticated calls must not pass a token-bearing URL as an argument.
    expect(script).toMatch(/git -c credential\.helper="\$CRED_HELPER" \\\n\s*fetch/);
  });

  it("supplies the token through the helper's environment, not its arguments", () => {
    expect(helperMatch).not.toBeNull();
    const helper = helperMatch![1];
    // The helper source carries the variable reference, never the value.
    expect(helper).toContain("$DEV_GITHUB_PAT");
    expect(helper).not.toContain("$TOKEN");
    expect(script).toContain('export DEV_GITHUB_PAT="$TOKEN"');

    // Behavioural check: git runs a `!`-prefixed helper in a child shell with
    // the credential request on stdin (it strips the `!` first). The token must
    // come from the environment, not from the helper's arguments.
    //
    // REEA-1122 — this helper answers from the environment and exits without
    // draining git's stdin. Under CI's 110 parallel workers the child can exit
    // before Node finishes writing the request, and that write then raises
    // EPIPE even though the helper already printed the right answer (the
    // deploy gate failed once on exactly this race). Accept the EPIPE when the
    // captured stdout is intact; every other error still fails the test.
    let output: string;
    try {
      output = execFileSync("sh", ["-c", helper.replace(/^!/, "")], {
        input: "protocol=https\nhost=github.com\n\n",
        env: { ...process.env, DEV_GITHUB_PAT: "s3cret-test-value" },
        encoding: "utf8",
      });
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stdout?: string };
      if (err.code !== "EPIPE" || typeof err.stdout !== "string") throw error;
      output = err.stdout;
    }
    expect(output).toContain("username=x-access-token");
    expect(output).toContain("password=s3cret-test-value");
    // The printed helper source cannot leak the token: it is only in the env.
    expect(helper).not.toContain("s3cret-test-value");
  });
});
