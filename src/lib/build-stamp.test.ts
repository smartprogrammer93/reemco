/**
 * REEA-1051 — /api/health build stamp resolution on a non-Vercel runtime.
 *
 * The regression: on the self-hosted box the health body answered
 * `build:""` while /__commit.txt served the deployed sha, because the runtime
 * image does not carry VERCEL_GIT_COMMIT_SHA (it is a build-time value there).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBuildStamp } from "@/lib/build-stamp";

describe("resolveBuildStamp (REEA-1051)", () => {
  const dirs: string[] = [];
  function stampFile(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "reemco-stamp-"));
    dirs.push(dir);
    const file = join(dir, "__commit.txt");
    writeFileSync(file, contents);
    return file;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the Vercel runtime value first (unchanged behaviour)", () => {
    expect(resolveBuildStamp({ VERCEL_GIT_COMMIT_SHA: "abc123def4567890" }, "/nope")).toBe(
      "abc123def456",
    );
  });

  it("honours an explicit REEMCO_COMMIT runtime tag", () => {
    expect(resolveBuildStamp({ REEMCO_COMMIT: "22c00e9804ad0f1b2d52be6222986ec40fcdaf70" }, "/nope")).toBe(
      "22c00e9804ad",
    );
  });

  it("falls back to the shipped public/__commit.txt on the self-hosted image", () => {
    const file = stampFile("b742a3b51736dd3bb13d1d1305c78c706b6dc9b1\n");
    expect(resolveBuildStamp({}, file)).toBe("b742a3b51736");
  });

  it("answers an empty stamp when no env value and no stamp file exist", () => {
    expect(resolveBuildStamp({}, "/definitely/not/here/__commit.txt")).toBe("");
  });
});
