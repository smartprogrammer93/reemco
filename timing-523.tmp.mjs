import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";
process.env.HOME = "/tmp"; process.env.FONTCONFIG_PATH = "/tmp/fonts";
process.env.LD_LIBRARY_PATH = ["/tmp/al2023/lib", "/tmp", process.env.LD_LIBRARY_PATH || ""].filter(Boolean).join(":");
const BASE = process.env.BASE || "http://localhost:3111";
const QUERIES = ["iPhone 17 Pro", "samsung galaxy s25 fe", "Scope II keyboard", "\u0622\u064a\u0641\u0648\u0646 17", "zzqx vbnt"];
const SUF = ["", ".", "..", "...", "...."];
const browser = await pw.launch({ executablePath: await chromium.executablePath(), args: ["--no-sandbox","--disable-dev-shm-usage","--disable-gpu"], headless: true });
const page = await browser.newPage({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36" });
await page.goto(BASE + "/", { waitUntil: "load", timeout: 30000 });
async function measure(q){
  const t0 = Date.now();
  await page.goto(BASE + "/results?q=" + encodeURIComponent(q), { waitUntil: "commit", timeout: 45000 });
  let fo=null, comp=null, last=null, hv=null, cards=0;
  while (Date.now()-t0 < 45000){
    const s = await page.evaluate(() => ({ c:[...document.querySelectorAll("article.result-card")].filter(x=>x.getAttribute("aria-hidden")!=="true"&&x.getAttribute("aria-hidden")!=="").length, h:((document.querySelector("h1 .tabular, span.tabular"))||{}).textContent||"", rs:document.readyState })).catch(()=>null);
    if (!s){ await new Promise(r=>setTimeout(r,50)); continue; }
    const now = Date.now()-t0;
    if (fo===null && s.c>=1) fo=now;
    const hvv=s.h.trim();
    if (hvv && hvv!==last){ hv=Number(hvv); last=hvv; }
    if (comp===null && s.rs!=="loading"){ comp=now; cards=s.c; break; }
    await new Promise(r=>setTimeout(r,50));
  }
  return {fo,comp,hv,cards};
}
const rows=[];
for (let r=0;r<5;r++) for (const bq of QUERIES){
  const q=bq+SUF[r];
  const cold=await measure(q); const warm=await measure(q);
  rows.push({round:r+1,q:bq,cold,warm});
  console.log(JSON.stringify(rows[rows.length-1]));
}
const p75=(a)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.ceil(0.75*s.length)-1];};
console.log("SUMMARY", JSON.stringify({coldP75:p75(rows.map(r=>r.cold.comp??99999)), warmP75:p75(rows.map(r=>r.warm.comp??99999))}));
await browser.close();
