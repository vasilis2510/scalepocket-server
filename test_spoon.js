import fs from "fs";

const SERVER = "http://localhost:3000";
const IMAGE_PATH = "spoon.jpg"; // βάλε εδώ φωτο με ποσότητα σε κουτάλι

function toBase64(path) {
  return fs.readFileSync(path).toString("base64");
}

async function postJSON(url, body, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const ct = r.headers.get("content-type") || "";
    const text = await r.text();

    console.log("\n➡️ POST", url);
    console.log("HTTP", r.status, "| content-type:", ct);

    if (!ct.includes("application/json")) {
      throw new Error(
        `Expected JSON but got content-type="${ct}". First 200 chars:\n${text.slice(0, 200)}`
      );
    }

    const json = JSON.parse(text);
    console.log(JSON.stringify(json, null, 2));
    return json;
  } finally {
    clearTimeout(t);
  }
}


async function main() {
  const imageBase64 = toBase64(IMAGE_PATH);

  console.log("🧪 TEST: estimate_auto with reference_object = spoon");

  const auto = await postJSON(`${SERVER}/estimate_auto`, {
    imageBase64,
    reference_object: "spoon",
    allow_training: false,
  });

  if (auto.stage === "estimated") {
    console.log("\n✅ Auto-estimated directly");
    return;
  }

  if (auto.stage !== "confirm") {
    console.log("\n⚠️ Unexpected stage:", auto.stage);
    return;
  }

  console.log("\n❓ Confirmation required:");
  console.log("Question:", auto.question);
  console.log("Proposals:", auto.proposals);

  console.log("\n🧪 TEST: estimate_confirm with same spoon reference");

  await postJSON(`${SERVER}/estimate_confirm`, {
    analysis_id: auto.analysis_id,
    imageBase64,
    confirmed_material: auto.proposals.confirmed_material,
    confirmed_mode: auto.proposals.confirmed_mode,
    reference_object: "spoon",
    allow_training: false,
  });
}

main().catch((e) => {
  console.error("❌ Test failed:", e);
  process.exit(1);
});
