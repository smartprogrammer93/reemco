const { chromium: pw } = await import("playwright-core");
const b = await pw.connectOverCDP("http://127.0.0.1:9223", { timeout: 20000 });
const ctx = b.contexts()[0] || (await b.newContext());
const p = await ctx.newPage();
for (const u of process.argv.slice(2)) {
  try { await p.goto(u, { waitUntil: "domcontentloaded", timeout: 25000 }); console.log("OK", u, "->", await p.title()); }
  catch (e) { console.log("BAD", u, "->", e.message.split("\n")[0]); break; }
}
await b.close();
