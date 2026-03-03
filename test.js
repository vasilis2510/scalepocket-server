// test.js
import fs from "fs";

const SERVER = "http://localhost:3000";
const IMAGE_PATH = "./test_converted.jpg";


// Auto-confirm settings (μπορείς να τα αλλάξεις για δοκιμή)
const AUTO_CONFIRM = true;

// Αν AUTO_CONFIRM=false, βάζεις εσύ εδώ τι επιβεβαιώνει ο χρήστης:
const MANUAL_CONFIRMED = {
  confirmed_material: "whey",   // creatine | whey | loose_tea | sugar | unknown
  confirmed_mode: "bowl",       // bag | bowl | surface | unknown
};

// ΜΟΝΟ αν έχεις opt-in από χρήστη
const ALLOW_TRAINING = false;

function toBase64JpegDataUrl(buf) {
  // Στέλνουμε data URL για σιγουριά
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}


async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _non_json: text };
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function main() {
  if (!fs.existsSync(IMAGE_PATH)) {
    console.error(`❌ Δεν βρήκα εικόνα: ${IMAGE_PATH}`);
    console.error(`Βάλε μια φωτο στο ScalePocketServer ως test.jpg`);
    process.exit(1);
  }

  const buf = fs.readFileSync(IMAGE_PATH);
  const imageBase64 = toBase64JpegDataUrl(buf);

  console.log("➡️  Calling /analyze ...");
  const analyze = await postJSON(`${SERVER}/analyze`, { imageBase64 });

  console.log("\n✅ /analyze result:");
  console.log(JSON.stringify(analyze, null, 2));

  const analysis_id = analyze.analysis_id;

  // Decide confirmation
  let confirmed_material, confirmed_mode;

  if (AUTO_CONFIRM) {
    confirmed_material = analyze.material_guess ?? "unknown";
    confirmed_mode = analyze.detected_mode ?? "unknown";
  } else {
    confirmed_material = MANUAL_CONFIRMED.confirmed_material;
    confirmed_mode = MANUAL_CONFIRMED.confirmed_mode;
  }

  console.log("\n➡️  Confirmation that will be sent to /estimate:");
  console.log({ confirmed_material, confirmed_mode, allow_training: ALLOW_TRAINING });

  console.log("\n➡️  Calling /estimate ...");
  const estimate = await postJSON(`${SERVER}/estimate`, {
    imageBase64,
    analysis_id,
    confirmed_material,
    confirmed_mode,
    allow_training: ALLOW_TRAINING,
  });

  console.log("\n✅ /estimate result:");
  console.log(JSON.stringify(estimate, null, 2));

  console.log("\nDone ✅");
}

main().catch((err) => {
  console.error("\n❌ Test failed:", err.message);
  process.exit(1);
});
