import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
console.log("BUILD:", "spoon_mode_v1");

console.log("OPENAI_API_KEY exists:", !!process.env.OPENAI_API_KEY);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- basic routes
app.get("/", (req, res) => res.send("OK ✅ ScalePocketServer is running"));
app.get("/health", (req, res) => res.json({ ok: true }));

// ---- dataset logging (opt-in)
const DATA_DIR = path.join(process.cwd(), "data");
const LOG_PATH = path.join(DATA_DIR, "labels.ndjson");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// ---- in-memory store for analysis
const analyses = new Map(); // analysis_id -> stored info

function sha256(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

function clamp01(x) {
  if (typeof x !== "number" || !Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function toDataUrl(imageBase64) {
  if (typeof imageBase64 !== "string" || imageBase64.length < 20) return null;

  if (imageBase64.startsWith("data:image/")) return imageBase64;

  const b64 = imageBase64.replace(/\s+/g, "");

  // base64 magic numbers
  let mime = "image/jpeg";
  if (b64.startsWith("iVBORw0KGgo")) mime = "image/png";
  else if (b64.startsWith("UklGR")) mime = "image/webp";
  else if (b64.startsWith("/9j/")) mime = "image/jpeg";

  return `data:${mime};base64,${b64}`;
}

async function callOpenAI(payload, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await openai.responses.create(payload, { signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---------- JSON Schemas (strict) ----------
const analyzeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    detected_mode: { type: "string", enum: ["bag", "bowl", "surface", "spoon", "unknown"] },
    material_guess: { type: "string", enum: ["creatine", "whey", "loose_tea", "sugar", "unknown"] },
    material_confidence: { type: "number", minimum: 0, maximum: 1 },
    needs_confirmation: { type: "boolean" },
    quality: { type: "string", enum: ["good", "ok", "bad"] },
    quality_notes: { type: "string" }
  },
  required: ["detected_mode", "material_guess", "material_confidence", "needs_confirmation", "quality", "quality_notes"]
};

const estimateSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
   detected_mode: { type: "string", enum: ["bag", "bowl", "surface", "spoon", "unknown"] },
    grams: { anyOf: [{ type: "number" }, { type: "null" }] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    range_grams: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } },
    too_small: { type: "boolean" }, // ✅ NEW
    notes: { type: "string" }
  },
  required: ["grams", "confidence", "range_grams", "detected_mode", "too_small", "notes"] // ✅ updated
};

// ---------- Prompts ----------
const analyzeSystem = `
You analyze ONE photo of LEGAL everyday dry materials (powders/granules/loose tea).
Do NOT estimate grams here. Only classify and assess quality.

Return:
- detected_mode: bag|bowl|surface|spoon|unknown
- material_guess: creatine|whey|loose_tea|sugar|unknown
- material_confidence: 0..1 (be conservative; powders look similar)
- needs_confirmation: true if confidence < 0.85 OR quality != "good"
- quality: good|ok|bad
- quality_notes: short reason

- If the photo could plausibly be more than one material (common for white powders),
  set material_guess="unknown" and keep material_confidence <= 0.7.
- Prefer "unknown" over guessing when confidence < 0.85.
- If the material is placed on a spoon, set detected_mode="spoon".
- Prefer "spoon" over "bowl" when a spoon is clearly visible as the container.


Output ONLY valid JSON matching the schema.`;

const estimateSystem = `
You estimate approximate NET weight in grams from ONE photo of LEGAL everyday dry materials:
creatine powder, whey protein powder, loose tea/dried herbs, sugar, or unknown dry material.

You will be given CONFIRMED material and mode from the user. Treat them as truth.

Rules:
- If amount is unclear/occluded, blurry, glare, or no usable reference -> grams=null and confidence<=0.35 and range_grams=[0,0] and too_small=false.
- If the estimated amount is below 0.5 grams OR appears as tiny residue/specks:
  set too_small=true, grams=null, confidence<=0.25, range_grams=[0,0],
  and notes must be exactly: "Κάτω από 0,5g — πολύ μικρό για αξιόπιστη εκτίμηση."
- Otherwise too_small=false.
- range_grams must be [min,max]. If grams!=null then min<=grams<=max.
- Be conservative: widen range when uncertain.

If REFERENCE object is "spoon":
- Use the spoon bowl as a rough size reference, but be conservative because spoons vary.
- Prefer wider ranges if the spoon size is unclear.

Output ONLY valid JSON matching the schema.`;

// ---------- Helpers ----------
function shouldAutoConfirm(a) {
  return (
    a.quality === "good" &&
    a.material_confidence >= 0.88 &&
    a.detected_mode !== "unknown" &&
    a.needs_confirmation === false
  );
}

function buildConfirmationQuestion(a) {
  const modeGR =
    a.detected_mode === "bag" ? "σακουλάκι" :
    a.detected_mode === "bowl" ? "μπολ/καπάκι" :
    a.detected_mode === "spoon" ? "κουτάλι" :
    a.detected_mode === "surface" ? "επιφάνεια" :
    "άγνωστο";

  const matGR =
    a.material_guess === "creatine" ? "κρεατίνη" :
    a.material_guess === "whey" ? "whey/πρωτεΐνη" :
    a.material_guess === "loose_tea" ? "χύμα τσάι/βότανο" :
    a.material_guess === "sugar" ? "ζάχαρη" :
    "άγνωστο υλικό";

  return `Φαίνεται ${matGR} σε ${modeGR}. Είναι σωστό;`;
}


function normalizeReference(ref) {
  return ref === "spoon" ? "spoon" : "none";
}

// ---------- ROUTES ----------

/**
 * POST /estimate_auto
 * body: { imageBase64: "...", reference_object?: "none"|"spoon", allow_training?: boolean }
 */
app.post("/estimate_auto", async (req, res) => {
  const requestId = req.headers["x-request-id"] || crypto.randomUUID();
  const { imageBase64, allow_training, reference_object } = req.body ?? {};
  const reference = normalizeReference(reference_object);

  const dataUrl = toDataUrl(imageBase64);
  if (!dataUrl) return res.status(400).json({ error: "Missing/invalid imageBase64" });

  try {
    // 1) ANALYZE
    const analyzeResp = await callOpenAI({
      model: "gpt-4.1-mini",
      temperature: 0,
      text: { format: { type: "json_schema", name: "photo_analyze_v1", schema: analyzeSchema } },
      metadata: { requestId, stage: "analyze" },
      input: [
        { role: "system", content: [{ type: "input_text", text: analyzeSystem }] },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Analyze the photo for container mode, material guess, and quality." },
            { type: "input_image", image_url: dataUrl }
          ]
        }
      ]
    });

    const analysis = JSON.parse(analyzeResp.output_text || "{}");
    analysis.material_confidence = clamp01(analysis.material_confidence);

    const analysis_id = crypto.randomUUID();
    const image_hash = sha256(dataUrl);

    analyses.set(analysis_id, {
      created_at: Date.now(),
      image_hash,
      detected_mode: analysis.detected_mode,
      material_guess: analysis.material_guess,
      material_confidence: analysis.material_confidence,
      quality: analysis.quality,
      reference_object: reference
    });

    // 2) auto confirm?
    if (!shouldAutoConfirm(analysis)) {
      return res.json({
        stage: "confirm",
        analysis_id,
        question: buildConfirmationQuestion(analysis),
        proposals: {
          confirmed_material: analysis.material_guess,
          confirmed_mode: analysis.detected_mode
        },
        analysis
      });
    }

    // 3) ESTIMATE (auto-confirmed)
    const confirmed_material = analysis.material_guess;
    const confirmed_mode = analysis.detected_mode;

    const estimateResp = await callOpenAI({
      model: "gpt-4.1-mini",
      temperature: 0,
      text: { format: { type: "json_schema", name: "weight_estimate_v3", schema: estimateSchema } },
      metadata: { requestId, stage: "estimate_auto" },
      input: [
        { role: "system", content: [{ type: "input_text", text: estimateSystem }] },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                `CONFIRMED material: ${confirmed_material}\n` +
                `CONFIRMED mode: ${confirmed_mode}\n` +
                `REFERENCE object: ${reference}\n` +
                `Estimate NET grams only (exclude container weight).`
            },
            { type: "input_image", image_url: dataUrl }
          ]
        }
      ]
    });

    const estimate = JSON.parse(estimateResp.output_text || "{}");
    estimate.detected_mode = confirmed_mode;

    // Safety: if too_small true, force grams null and range [0,0]
    if (estimate.too_small === true) {
      estimate.grams = null;
      estimate.range_grams = [0, 0];
      estimate.confidence = Math.min(0.25, clamp01(estimate.confidence));
      estimate.notes = "Κάτω από 0,5g — πολύ μικρό για αξιόπιστη εκτίμηση.";
    } else {
      estimate.too_small = false;
    }

    if (allow_training === true) {
      const record = {
        ts: new Date().toISOString(),
        analysis_id,
        image_hash,
        reference_object: reference,
        model_detected_mode: analysis.detected_mode,
        model_material_guess: analysis.material_guess,
        model_material_confidence: analysis.material_confidence,
        user_confirmed_mode: confirmed_mode,
        user_confirmed_material: confirmed_material,
        auto_confirmed: true
      };
      fs.appendFileSync(LOG_PATH, JSON.stringify(record) + "\n", "utf8");
    }

    return res.json({ stage: "estimated", analysis_id, analysis, estimate });
  } catch (e) {
    console.error("estimate_auto_error FULL", e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

/**
 * POST /estimate_confirm
 * body: { analysis_id, imageBase64, confirmed_material, confirmed_mode, reference_object?: "none"|"spoon", allow_training?: boolean }
 */
app.post("/estimate_confirm", async (req, res) => {
  const requestId = req.headers["x-request-id"] || crypto.randomUUID();
  const { analysis_id, imageBase64, confirmed_material, confirmed_mode, allow_training, reference_object } = req.body ?? {};
  const reference = normalizeReference(reference_object);

  const dataUrl = toDataUrl(imageBase64);
  if (!dataUrl) return res.status(400).json({ error: "Missing/invalid imageBase64" });
  if (!analysis_id) return res.status(400).json({ error: "Missing analysis_id" });

  const material = ["creatine", "whey", "loose_tea", "sugar", "unknown"].includes(confirmed_material)
    ? confirmed_material
    : "unknown";
  const mode = ["bag", "bowl", "surface", "spoon", "unknown"].includes(confirmed_mode)
  ? confirmed_mode
  : "unknown";

  try {
    const estimateResp = await callOpenAI({
      model: "gpt-4.1-mini",
      temperature: 0,
      text: { format: { type: "json_schema", name: "weight_estimate_v3", schema: estimateSchema } },
      metadata: { requestId, stage: "estimate_confirm" },
      input: [
        { role: "system", content: [{ type: "input_text", text: estimateSystem }] },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                `CONFIRMED material: ${material}\n` +
                `CONFIRMED mode: ${mode}\n` +
                `REFERENCE object: ${reference}\n` +
                `Estimate NET grams only (exclude container weight).`
            },
            { type: "input_image", image_url: dataUrl }
          ]
        }
      ]
    });

    const estimate = JSON.parse(estimateResp.output_text || "{}");
    estimate.detected_mode = mode;

    // Safety: if too_small true, force grams null and range [0,0]
    if (estimate.too_small === true) {
      estimate.grams = null;
      estimate.range_grams = [0, 0];
      estimate.confidence = Math.min(0.25, clamp01(estimate.confidence));
      estimate.notes = "Κάτω από 0,5g — πολύ μικρό για αξιόπιστη εκτίμηση.";
    } else {
      estimate.too_small = false;
    }

    if (allow_training === true) {
      const stored = analyses.get(analysis_id) || null;
      const record = {
        ts: new Date().toISOString(),
        analysis_id,
        image_hash: stored?.image_hash || sha256(dataUrl),
        reference_object: reference,
        model_detected_mode: stored?.detected_mode || null,
        model_material_guess: stored?.material_guess || null,
        model_material_confidence: stored?.material_confidence ?? null,
        user_confirmed_mode: mode,
        user_confirmed_material: material,
        auto_confirmed: false
      };
      fs.appendFileSync(LOG_PATH, JSON.stringify(record) + "\n", "utf8");
    }

    return res.json({ stage: "estimated", analysis_id, estimate });
  } catch (e) {
    console.error("estimate_confirm_error FULL", e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// --- 404 JSON fallback (must be after ALL routes)
app.use((req, res) => {
  res.status(404).json({
    error: "Not found",
    method: req.method,
    path: req.originalUrl
  });
});

// --- global error handler (optional but recommended)
app.use((err, req, res, next) => {
  console.error("unhandled_error", err);
  res.status(err?.status || 500).json({
    error: err?.message || "Internal error"
  });
});

// ---- start
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on http://localhost:${PORT}`));
