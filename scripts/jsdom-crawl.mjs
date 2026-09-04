import jsdom from "jsdom";
const { JSDOM } = jsdom;

const BASE = "https://reemco-price-compare-preview.surge.sh";
const pages = ["/", "/search", "/results?q=sony", "/results?q=asus", "/results?q=zzzqqq"];

for (const p of pages) {
  const dom = await JSDOM.fromURL(BASE + p, {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
  });
  await new Promise((res) => {
    dom.window.addEventListener("load", () => setTimeout(res, 4000));
    setTimeout(res, 15000);
  });
  const doc = dom.window.document;
  const hrefs = [...doc.querySelectorAll("a[href]")].map(a => a.getAttribute("href"));
  const ids = [...doc.querySelectorAll("[id]")].map(e => e.id);
  console.log(`PAGE ${p}`);
  console.log(`  hrefs(${hrefs.length}): ${JSON.stringify([...new Set(hrefs)])}`);
  console.log(`  ids: ${JSON.stringify([...new Set(ids)])}`);
  dom.window.close();
}
