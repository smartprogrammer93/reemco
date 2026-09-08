import * as m from "../src/lib/collect/canonical-product.ts";
const show = (label, t) => {
  console.log(label, JSON.stringify(m.canonicalTokens(t)));
  console.log("   fields:", JSON.stringify(m.canonicalFields(t)));
};
show("s96wl ", "Asus ROG Strix Scope II 96 Wireless RGB Mechanical Gaming Keyboard (ROG NX Snow Switch) - Black");
show("boseV ", "Bose QuietComfort II Earbuds, Noise Cancelling Microphone, Bluetooth, USB (Charging), Built-in Microphone, Eclipse Grey");
show("tvFull", 'Samsung 75" Crystal UHD U8000F 4K Smart TV, UA75U8000FUXZN');
