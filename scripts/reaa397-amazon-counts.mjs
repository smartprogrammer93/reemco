/** REEA-397 round-B probe: parallel fetch of the fixed 20-query set against
 *  the deployed site; extract the FINAL coverage-notes array per query and
 *  record Amazon.eg hits/error. Two sequential rounds so transient vs
 *  persistent 503s are distinguishable. Concurrency 5. */
const BASE = "https://reemco.vercel.app";
const QUERIES = ["iPhone 17 Pro","iPhone 17 Pro Max","Samsung Galaxy S25 Ultra","Samsung Galaxy S25","Xiaomi 15","Redmi Note","Sony WH-1000XM6","Sony WF","AirPods Pro 3","AirPods 4","JBL Tune","Samsung washing machine","LG refrigerator","Whirlpool microwave","Philips air fryer","Nutribullet","iphon 17 pro","reciever","samsng s25","whirpool microwave"];
const HEADERS = { accept:"text/html,application/xhtml+xml","accept-language":"en","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36" };
function notes(html){let s=html;for(let i=0;i<4;i++){const t=s.replace(/\\"/g,'"');if(t===s)break;s=t;}const out=[];const re=/"notes":\[([^\]]*)\]/g;let m;while((m=re.exec(s))!==null){try{out.push(JSON.parse(`[${m[1]}]`));}catch{}}return out;}
async function one(q){const t0=Date.now();try{const r=await fetch(`${BASE}/results?q=${encodeURIComponent(q)}`,{headers:HEADERS,signal:AbortSignal.timeout(35000)});let h="";const d=new TextDecoder();for await(const c of r.body)h+=d.decode(c,{stream:true});h+=d.decode();const a=notes(h);const f=a[a.length-1];const amz=f?.find(n=>n.merchant==="Amazon.eg");return{q,ms:Date.now()-t0,hits:amz?.hits??null,err:amz?.error??null,snap:a.length};}catch(e){return{q,ms:Date.now()-t0,err:`ERR ${e?.cause?.code??e?.message}`};}}
const rounds=Number(process.argv[2]||2);
for(let round=1;round<=rounds;round++){
  const rows=[];const its=[...QUERIES];
  const workers=Array.from({length:5},async()=>{while(its.length){rows.push(await one(its.shift()));}});
  await Promise.all(workers);
  rows.sort((a,b)=>QUERIES.indexOf(a.q)-QUERIES.indexOf(b.q));
  for(const r of rows)console.log(`R${round} | ${r.q} | hits=${r.hits??"-"}${r.err?` err:${r.err}`:""} | ${r.ms}ms`);
  const withHits=rows.filter(r=>(r.hits??0)>0).length;
  const errs=rows.filter(r=>r.err&&!String(r.err).startsWith("ERR")).length;
  console.log(`R${round} SUMMARY | contributing ${withHits}/${rows.length} | 503-notes ${errs} | fetch-errors ${rows.filter(r=>String(r.err).startsWith("ERR")).length}`);
}
