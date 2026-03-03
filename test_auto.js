import fs from "fs";

const SERVER = process.env.SERVER || "http://localhost:3000";
const IMAGE_PATH = process.env.IMAGE || "test_converted.jpg"; // βάλε default το converted

function toBase64(path) {
  return fs.readFileSync(path).toString("base64");
}

async function postJSON(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) {
    throw new Error(`HTTP ${r.status} from ${url}: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json;
}

async function main() {
  const imageBase64 = toBase64(IMAGE_PATH);

  console.log("➡️  Calling /estimate_auto ...");
  const first = await postJSON(`${SERVER}/estimate_auto`, {
    imageBase64,
    allow_training: false,
  });

  console.log("✅ /estimate_auto response:");
  console.log(JSON.stringify(first, null, 2));

    if (first.stage === "confirm") {
    console.log("\n❓ CONFIRM REQUIRED");
    console.log("question:", first.question);
    console.log("analysis_id:", first.analysis_id);
    console.log("proposals:", first.proposals);
    console.log("\nNow call /estimate_confirm with the user's choice.");
    return;
  }

  if (first.stage !== "estimated") {
    console.log("\n⚠️ Unexpected stage:", first.stage);
    return;
  }

  console.log("\n✅ ESTIMATED:", first.estimate);


  // εδώ normally θα ρωτήσεις τον χρήστη στο UI:
  // "Είναι σωστό; (ναι/όχι + επιλογές)"
  // για test, κάνουμε confirm με τις προτάσεις που έστειλε το API.
  const analysis_id = first.analysis_id;
  const confirmed_material = first.proposals?.confirmed_material ?? "unknown";
  const confirmed_mode = first.proposals?.confirmed_mode ?? "unknown";

  console.log("\n❓ Server asks confirmation:");
  console.log(first.question);
  console.log("➡️  Auto-confirming with proposals:", { confirmed_material, confirmed_mode });

  console.log("\n➡️  Calling /estimate_confirm ...");
  const second = await postJSON(`${SERVER}/estimate_confirm`, {
    analysis_id,
    imageBase64,
    confirmed_material,
    confirmed_mode,
    allow_training: false,
  });

  console.log("✅ /estimate_confirm response:");
  console.log(JSON.stringify(second, null, 2));
  console.log("\n🎉 Done (confirmed -> estimated).");
}

main().catch((e) => {
  console.error("❌ Test failed:", e.message);
  process.exit(1);
});
