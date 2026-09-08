import * as m from "../src/lib/collect/canonical-product.ts";
const parts = [
  "Asus ROG Strix Scope II 96 Wireless RGB Mechanical Gaming Keyboard (ROG NX Snow Switch) - Black",
  "Asus ROG Strix Scope II 96 Wireless RGB Mechanical Gaming Keyboard",
  "Asus ROG Strix Scope II 96 Wireless RGB Mechanical",
  "Asus ROG Strix Scope II 96 Wireless",
  "Asus ROG Strix Scope II 96 RGB Mechanical Gaming Keyboard - Black",
];
for (const p of parts) console.log(JSON.stringify(m.canonicalFields(p)));
