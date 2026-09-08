import { canonicalFields, compatibleFields } from "../src/lib/collect/canonical-product.ts";
const f = (t) => canonicalFields(t);
const show = (label, a, b) => {
  const A = f(a), B = f(b);
  console.log(label, "=> compatible:", compatibleFields(A, { ...B, color: "" }) , "| A:", JSON.stringify(A), "| B:", JSON.stringify(B));
};
show("QC II pair ",
  "Bose QuietComfort II Wireless Earbuds Black",
  "Bose QuietComfort II Earbuds, Noise Cancelling Microphone, Bluetooth, USB (Charging), Built-in Microphone, Eclipse Grey");
show("QC II plum ",
  "Bose QuietComfort II Wireless Earbuds Plum",
  "Bose QuietComfort II Earbuds, Bluetooth, USB-C, Built-in Microphone, Gold");
show("TV bare/full",
  "Samsung Crystal UHD U8000F 4K Smart TV (2025)",
  'Samsung 75" Crystal UHD U8000F 4K Smart TV, UA75U8000FUXZN');
show("TV vs-other",
  "Samsung Crystal UHD U8000F 4K Smart TV (2025)",
  'Samsung 55" FLAT UHD 4K Resolution UA55CU7000UXZN (2023)');
show("iPad11/13   ",
  "Apple iPad Air 11 inch M4 2026 128GB 5G MH794AB/A Blue",
  "Apple iPad Air 13 inch M4 128GB Wi-Fi MH5N4AB/A Grey");
show("iPad merged",
  "Apple iPad Air 11 inch M4 2026 128GB 5G MH794AB/A Blue",
  'Apple iPad Air 11 M4 Tablet - Wi-Fi 2026, Apple Intelligence, 11", 128 GB, Blue, 8-core CPU');
show("Pro/ProMax ",
  "Apple iPhone 17 Pro Max 256GB Black",
  "Apple iPhone 17 Pro, 256 GB Black");
