import { register } from "node:module";
import { pathToFileURL } from "node:url";
register("./alias-hook.mjs", pathToFileURL("./scripts/").href);
const { PRODUCTS } = await import("../src/lib/feed.ts");
const { resolveOfferUrl } = await import("../src/lib/links.ts");
const { merchantSearchUrl } = await import("../src/lib/links.ts");

const internal = new Set(["/", "/search"]);
const external = new Set();
for (const p of PRODUCTS) {
  for (const o of p.offers) {
    const href = resolveOfferUrl(o, p.title);
    if (href) external.add(href);
  }
  for (const a of p.alternatives) internal.add(`/results?q=${encodeURIComponent(a.title)}`);
}
console.log("== internal links ==");
for (const h of internal) console.log(h);
console.log("== external (rendered) links ==");
for (const h of external) console.log(h);

const BASE = "https://reemco.vercel.app";
console.log("== live status codes ==");
for (const h of internal) {
  const r = await fetch(BASE + h);
  console.log(`${r.status} ${h}`);
}
for (const h of external) {
  try {
    const r = await fetch(h, { headers: { "user-agent": "Mozilla/5.0" }, redirect: "follow" });
    console.log(`${r.status} ${h}`);
  } catch (e) {
    console.log(`ERR ${h} (${e.cause?.code ?? e.message})`);
  }
}
