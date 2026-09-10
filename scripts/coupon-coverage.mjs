/** REEA-488 item 2 + metrics — weekly export for coupon coverage and the
 *  alternatives fill rate. Fetches the fixed top-query set against the
 *  deployed site, pulls the FINAL per-stage notes array out of the streamed
 *  flight payload (same unescape pattern as reaa397-amazon-counts.mjs), and
 *  aggregates exactly what coverage.ts computes server-side:
 *    - aggregateCouponCoverage: couponOffers/offers per merchant, summed
 *      across snapshots in COVERAGE_ORDER;
 *    - aggregateAlternativesFill: products with >=1 alternative over products
 *      seen on the FINAL snapshot.
 *  Print one JSON document to stdout — the weekly numbers are plain counts,
 *  no percentile games. */
const BASE = "https://reemco.vercel.app";
const QUERIES = ["iPhone 17 Pro","iPhone 17 Pro Max","Samsung Galaxy S25 Ultra","Samsung Galaxy S25","Xiaomi 15","Redmi Note","Sony WH-1000XM6","Sony WF","AirPods Pro 3","AirPods 4","JBL Tune","Samsung washing machine","LG refrigerator","Whirlpool microwave","Philips air fryer","Nutribullet","iphon 17 pro","reciever","samsng s25","whirpool microwave"];
const HEADERS = { accept:"text/html,application/xhtml+xml","accept-language":"en","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36" };

/* Fixed presentation order — parity with COVERAGE_ORDER in
   src/lib/collect/coverage.ts (kept as a plain list here because this probe
   runs under plain node without the "@/..." alias). Unknown merchants rank
   last, exactly like coverageRank. */
const COVERAGE_ORDER = ["Xcite","Blink","Eureka","Sultan Center","Jarir","Amazon.eg","Quadra Stores","Next Store","PC Kuwait","Lulu Hypermarket","Switch","Wibi","Astore","Zayoom","Yousifi","Aster Pharmacy","Nahdi","Ounass","Danube Home"];
const rank = (m) => { const i = COVERAGE_ORDER.indexOf(m); return i < 0 ? COVERAGE_ORDER.length : i; };

/** All `notes:[...]` arrays in the streamed flight, in render order. Notes
 *  never nest arrays, so the flat character-class regex is safe. */
function notesArrays(html){let s=html;for(let i=0;i<4;i++){const t=s.replace(/\\"/g,'"');if(t===s)break;s=t;}const out=[];const re=/"notes":\[([^\]]*)\]/g;let m;while((m=re.exec(s))!==null){try{out.push(JSON.parse(`[${m[1]}]`));}catch{}}return out;}

/** Final-snapshot fill rate on the SAME unescaped string: one product is a
 *  `"productId":` entry; its alternatives are non-empty when the field opens
 *  with an object (`[{`) or a flight reference (`"$`) — REEA-254 shares one
 *  alternatives entry across sibling products, and a referenced entry counts
 *  as filled for every product reading it. Counted across every serialized
 *  snapshot of a query (each staged flush delivers its cards), so the rate
 *  reads over DELIVERED cards — the weekly number is a plain count pair. */
function fillStats(html){let s=html;for(let i=0;i<4;i++){const t=s.replace(/\\"/g,'"');if(t===s)break;s=t;}let seen=0,filled=0;const re=/"productId":"([^"]*)"[\s\S]{0,6000}?"alternatives":(\[\]|\[\{|\\"\$|\$)/g;let m;while((m=re.exec(s))!==null){seen+=1;if(m[2]!=="[]")filled+=1;}return{seen,filled};}

/* The edge sometimes answers with the Vercel Security Checkpoint (HTTP 403,
   x-vercel-mitigated: challenge) instead of the page — transient, and a plain
   retry usually lands. One bounded retry loop per query; a still-challenged
   query is recorded as an error row rather than a fake zero. */
async function one(q){const t0=Date.now();for(let attempt=1;attempt<=3;attempt++){try{const r=await fetch(`${BASE}/results?q=${encodeURIComponent(q)}`,{headers:HEADERS,signal:AbortSignal.timeout(35000)});let h="";const d=new TextDecoder();for await(const c of r.body)h+=d.decode(c,{stream:true});h+=d.decode();if(r.status===200){const snap=notesArrays(h);const finalNotes=snap[snap.length-1]??[];const fill=fillStats(h);return{q,ms:Date.now()-t0,stages:snap.length,notes:finalNotes,fill};}}catch(e){}await new Promise((res)=>setTimeout(res,1200));}return{q,ms:Date.now()-t0,err:"ERR challenge-or-non200",notes:[],fill:{seen:0,filled:0}};}

/* Mirrors aggregateCouponCoverage in coverage.ts: sums per merchant over all
   FINAL note sets (one stage per query — the converged answer), sorts by the
   fixed order, coverage = couponOffers/offers, null on an empty window. */
function aggregateCouponCoverage(noteSets){const totals=new Map();for(const notes of noteSets){for(const n of notes){const t=totals.get(n.merchant)??{offers:0,couponOffers:0};t.offers+=n.hits;t.couponOffers+=n.coupons??0;totals.set(n.merchant,t);}}return[...totals.entries()].sort((a,b)=>rank(a[0])-rank(b[0])).map(([merchant,t])=>({merchant,offers:t.offers,couponOffers:t.couponOffers,coverage:t.offers>0?t.couponOffers/t.offers:null}));}

const rows=[];
const its=[...QUERIES];
const workers=Array.from({length:5},async()=>{while(its.length){rows.push(await one(its.shift()));}});
await Promise.all(workers);
rows.sort((a,b)=>QUERIES.indexOf(a.q)-QUERIES.indexOf(b.q));
const seen=rows.reduce((n,r)=>n+r.fill.seen,0);
const filled=rows.reduce((n,r)=>n+r.fill.filled,0);
console.log(JSON.stringify({
  generatedAt:new Date().toISOString(),
  queries:rows.length,
  errors:rows.filter(r=>r.err).length,
  couponCoverage:aggregateCouponCoverage(rows.map(r=>r.notes)),
  alternativesFill:{productsSeen:seen,productsWithAlternatives:filled,nonEmptyRate:seen>0?filled/seen:null},
  perQuery:rows.map(r=>({q:r.q,ms:r.ms,stages:r.stages,err:r.err??null})),
},null,2));
