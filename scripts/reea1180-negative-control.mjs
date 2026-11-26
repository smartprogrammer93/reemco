/**
 * REEA-1180 — negative control for the deploy gate's link-health classifier.
 *
 * This harness imports the SAME exported classifier the deploy gate reuses in
 * scripts/smoke-check.mjs step 6 (`classifyAttempt` / `checkUrl` from
 * scripts/dead-link-smoke.mjs). It does not reimplement classification.
 *
 * For every case it reports the classifier verdict and the gate outcome under
 * the exact step-6 rule: a URL fails the gate when it is not ok AND the verdict
 * is not `challenge` (the 503 "عذرًا/Sorry" apology exception is not exercised
 * here; none of these cases hit it).
 *
 * Exit 0 only when every case matches its expectation.
 */
import { classifyAttempt, checkUrl } from "./dead-link-smoke.mjs";

const GATE_HEADERS = {
  accept: "text/html,application/xhtml+xml",
  "accept-language": "en",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
};

// Step 6's decision: status/title must be ok, or the classifier must say the
// host answered with a bot-wall (`challenge`). Anything else is a gate failure.
function gateOutcome({ status, title, verdict }) {
  const ok = status < 400 && !/^(?:404\b|page not found\b)/i.test(title ?? "");
  if (ok) return { pass: true, why: "reachable (<400, title not a 404 shell)" };
  if (verdict === "challenge") return { pass: true, why: "bot-wall classified challenge" };
  return { pass: false, why: `not reachable (${verdict})` };
}

async function probeHtml(url) {
  const res = await fetch(url, {
    headers: GATE_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  const html = await res.text();
  const title = html.match(/<title[^>]*>([^<]+?)\s*<\/title>/i)?.[1]?.trim() ?? "";
  const verdict = classifyAttempt(res.status, res.headers, html.slice(0, 4000));
  return { status: res.status, title, verdict, server: res.headers.get("server"), mitigated: res.headers.get("cf-mitigated") };
}

async function probeNetwork(url, timeoutMs) {
  const r = await checkUrl(fetch, url, { timeoutMs, transientBackoffMs: 0, challengeBackoffMs: 0 });
  return { outcome: r.outcome, attempts: r.attempts };
}

const cases = [];

// 1. Live retailer URL answering 200.
{
  const url = "https://www.xcite.com/apple-iphone-17-pro-6-3-256gb-silver/p";
  const p = await probeHtml(url);
  const gate = gateOutcome(p);
  cases.push({ id: 1, kind: "live 200", url, expected: "reachable / gate PASS", actual: `${p.status} -> ${p.verdict}`, gate: gate.pass ? "PASS" : "FAIL", pass: p.verdict === "ok" && gate.pass, detail: `title="${p.title}"` });
}

// 2. Cloudflare challenge: 403 with cf-mitigated / server: cloudflare / CF body.
{
  const url = "https://www.jarir.com/?q=Apple%20iPhone%2017%20Pro%20256GB";
  const p = await probeHtml(url);
  const gate = gateOutcome(p);
  cases.push({ id: 2, kind: "CF challenge 403", url, expected: "challenge / gate PASS", actual: `${p.status} cf-mitigated=${p.mitigated} server=${p.server} -> ${p.verdict}`, gate: gate.pass ? "PASS" : "FAIL", pass: p.verdict === "challenge" && gate.pass, detail: `title="${p.title}"` });
}

// 3a. Genuine 404 (our own production host, real missing path).
{
  const url = "https://ns539626.ip-144-217-72.net/reea1180-does-not-exist";
  const p = await probeHtml(url);
  const gate = gateOutcome(p);
  cases.push({ id: "3a", kind: "404 URL", url, expected: "dead / gate FAIL", actual: `${p.status} -> ${p.verdict}`, gate: gate.pass ? "PASS" : "FAIL", pass: p.verdict === "dead" && !gate.pass, detail: `title="${p.title}"` });
}

// 3b. Genuine 410.
{
  const url = "https://httpbin.org/status/410";
  const p = await probeHtml(url);
  const gate = gateOutcome(p);
  cases.push({ id: "3b", kind: "410 URL", url, expected: "dead / gate FAIL", actual: `${p.status} -> ${p.verdict}`, gate: gate.pass ? "PASS" : "FAIL", pass: p.verdict === "dead" && !gate.pass, detail: `title="${p.title}"` });
}

// 3c. DNS failure (.invalid is guaranteed non-resolving, RFC 2606).
{
  const url = "https://no-such-host.reea1180.invalid/";
  const r = await probeNetwork(url, 5000);
  cases.push({ id: "3c", kind: "DNS failure", url, expected: "dead / gate FAIL", actual: `${r.outcome} after ${r.attempts} attempt(s)`, gate: r.outcome === "dead" ? "FAIL" : "PASS", pass: r.outcome === "dead", detail: "ECONNREFUSED-equivalent resolver error" });
}

// 3d. Connection refused (closed loopback port).
{
  const url = "http://127.0.0.1:9/";
  const r = await probeNetwork(url, 5000);
  cases.push({ id: "3d", kind: "connection refused", url, expected: "dead / gate FAIL", actual: `${r.outcome} after ${r.attempts} attempt(s)`, gate: r.outcome === "dead" ? "FAIL" : "PASS", pass: r.outcome === "dead", detail: "ECONNREFUSED" });
}

// 3e. Timeout (non-routable address, bounded timeout).
{
  const url = "http://10.255.255.1/";
  const r = await probeNetwork(url, 3000);
  cases.push({ id: "3e", kind: "timeout", url, expected: "dead / gate FAIL", actual: `${r.outcome} after ${r.attempts} attempt(s)`, gate: r.outcome === "dead" ? "FAIL" : "PASS", pass: r.outcome === "dead", detail: "aborted after 3000ms" });
}

console.log("| # | Case | URL | Expected | Actual classification | Gate outcome | Result |");
console.log("|---|---|---|---|---|---|---|");
for (const c of cases) {
  console.log(`| ${c.id} | ${c.kind} | ${c.url} | ${c.expected} | ${c.actual} | ${c.gate} | ${c.pass ? "MATCH" : "MISMATCH"} |`);
}
const failed = cases.filter((c) => !c.pass);
if (failed.length) {
  console.error(`\nNEGATIVE CONTROL FAILED: ${failed.length} mismatch(es)`);
  process.exit(1);
}
console.log(`\nNEGATIVE CONTROL PASSED: ${cases.length}/${cases.length} cases matched expectations.`);
