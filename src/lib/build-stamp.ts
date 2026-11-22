/**
 * REEA-1051 — served build stamp for /api/health.
 *
 * REEA-377 stamped the health body with `VERCEL_GIT_COMMIT_SHA` because that
 * was the only artifact identity a serverless deployment exposed. The
 * self-hosted image (infra/Dockerfile) sets that same variable as a BUILD-time
 * value — it is what generateBuildId() and public/__commit.txt use — but the
 * runtime stage deliberately does not carry it, so /api/health answered
 * `{"ok":true,"build":""}` on the box while /__commit.txt served the real sha
 * (measured live 2026-11-22). Anything that falls back to the health body for
 * parity (the stamp-parity tripwire does exactly that when the stamp route is
 * challenged) then had nothing to compare.
 *
 * Resolution order:
 *  1. `VERCEL_GIT_COMMIT_SHA` — Vercel runtime (unchanged behaviour);
 *  2. `REEMCO_COMMIT` — a runtime that injects the deployed tag explicitly;
 *  3. `public/__commit.txt` — the artifact stamp the image ships, which is the
 *     same value the build wrote (standalone output keeps `public/`);
 *  4. empty string — plain local runs with no git metadata and no stamp.
 *
 * The value is a short sha (12 chars), matching the documented body shape;
 * it is not a secret.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function resolveBuildStamp(
  env: Record<string, string | undefined> = process.env,
  stampPath: string = join(process.cwd(), "public", "__commit.txt"),
): string {
  const fromEnv = (env.VERCEL_GIT_COMMIT_SHA || env.REEMCO_COMMIT || "").trim();
  if (fromEnv !== "") return fromEnv.slice(0, 12);
  try {
    return readFileSync(stampPath, "utf8").trim().slice(0, 12);
  } catch {
    return "";
  }
}
