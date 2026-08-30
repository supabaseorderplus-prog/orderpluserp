import { randomUUID } from "node:crypto";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { createWorker, OEM, PSM } from "tesseract.js";
import { getUserFromToken, supabaseAdmin } from "@/lib/supabase-server";
import { istToday } from "@/lib/datetime";
import { extractOdometerReading, parseDutyOdometerEvidence, validateOdometerProgress } from "@/lib/odometer-reading";
import { previousSessionNotes } from "@/lib/duty-signoff";

export const runtime = "nodejs";
export const maxDuration = 60;

const BUCKET = "duty-odometer-photos";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MIN_OCR_CONFIDENCE = 35;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const LANGUAGE_PATH = path.join(process.cwd(), "node_modules", "@tesseract.js-data", "eng", "4.0.0");

interface OcrPass {
  text: string;
  confidence: number;
}

async function readOdometer(buffer: Buffer): Promise<OcrPass> {
  const passes: OcrPass[] = [];
  const worker = await createWorker("eng", OEM.LSTM_ONLY, {
    langPath: LANGUAGE_PATH,
    gzip: true,
    logger: () => {},
  });

  try {
    for (const mode of [PSM.SPARSE_TEXT, PSM.SINGLE_LINE]) {
      await worker.setParameters({
        tessedit_pageseg_mode: mode,
        tessedit_char_whitelist: "0123456789.,",
        preserve_interword_spaces: "1",
      });
      const result = await worker.recognize(buffer);
      passes.push({ text: result.data.text || "", confidence: Number(result.data.confidence || 0) });
    }
  } finally {
    await worker.terminate();
  }

  return {
    text: passes.map((pass) => pass.text).join("\n"),
    confidence: Math.max(...passes.map((pass) => pass.confidence), 0),
  };
}

async function ensureBucket() {
  const { data: buckets, error: listError } = await supabaseAdmin.storage.listBuckets();
  if (listError) throw new Error(`Photo storage is unavailable: ${listError.message}`);
  if ((buckets || []).some((bucket) => bucket.name === BUCKET)) return;

  const { error } = await supabaseAdmin.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: MAX_IMAGE_BYTES,
    allowedMimeTypes: [...ALLOWED_IMAGE_TYPES],
  });
  if (error && !error.message.toLowerCase().includes("already exists")) {
    throw new Error(`Could not prepare photo storage: ${error.message}`);
  }
}

function imageExtension(file: File): string {
  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  return "jpg";
}

export async function POST(req: NextRequest) {
  try {
    const caller = await getUserFromToken(req);
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const salesmanId = caller.app_user_id || caller.id;
    const today = istToday();
    const formData = await req.formData();
    const image = formData.get("image");
    const phase = formData.get("phase");

    if (!(image instanceof File) || (phase !== "start" && phase !== "end")) {
      return NextResponse.json({ error: "An odometer photo and valid duty phase are required." }, { status: 400 });
    }
    if (!ALLOWED_IMAGE_TYPES.has(image.type)) {
      return NextResponse.json({ error: "Use a JPEG, PNG, or WebP odometer photo." }, { status: 400 });
    }
    if (image.size === 0 || image.size > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: "Photo must be smaller than 8 MB." }, { status: 400 });
    }

    const sessionQuery = await supabaseAdmin
      .from("salesman_day_sessions")
      .select("*")
      .eq("salesman_id", salesmanId)
      .eq("date", today)
      .maybeSingle();

    if (sessionQuery.error) {
      const schemaMissing = sessionQuery.error.code === "42703" || sessionQuery.error.message.includes("start_odometer_km");
      return NextResponse.json({
        error: schemaMissing
          ? "Odometer database migration has not been applied."
          : sessionQuery.error.message,
      }, { status: schemaMissing ? 503 : 500 });
    }
    const session = sessionQuery.data as { status?: string; start_odometer_km?: number | null } | null;
    if (phase === "start" && session) {
      return NextResponse.json({ error: "Today’s duty has already been started." }, { status: 409 });
    }
    if (phase === "end" && session?.status !== "active") {
      return NextResponse.json({ error: "No active duty session was found." }, { status: 409 });
    }

    const buffer = Buffer.from(await image.arrayBuffer());
    const ocr = await readOdometer(buffer);
    const extracted = extractOdometerReading(ocr.text);
    if (extracted.reading == null || ocr.confidence < MIN_OCR_CONFIDENCE) {
      return NextResponse.json({
        error: extracted.reason === "ambiguous"
          ? "More than one possible reading was found. Move closer so only the odometer fills the frame, then retake the photo."
          : "Kilometres could not be read clearly. Clean the display, avoid glare, and take another photo.",
        code: "ODOMETER_UNREADABLE",
      }, { status: 422 });
    }

    if (phase === "end") {
      const fallbackEvidence = parseDutyOdometerEvidence(previousSessionNotes((session as { notes?: string | null } | null)?.notes));
      const startKm = Number(session?.start_odometer_km ?? fallbackEvidence?.start.reading);
      const progressError = validateOdometerProgress(startKm, extracted.reading);
      if (progressError) {
        return NextResponse.json({ error: progressError, code: "ODOMETER_INVALID_PROGRESS" }, { status: 422 });
      }
    }

    await ensureBucket();
    const filePath = `${salesmanId}/${today}/${phase}-${Date.now()}-${randomUUID()}.${imageExtension(image)}`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(filePath, buffer, { contentType: image.type, upsert: false });
    if (uploadError) throw new Error(`Photo upload failed: ${uploadError.message}`);

    return NextResponse.json({
      data: {
        reading: extracted.reading,
        confidence: Math.round(ocr.confidence),
        photo_path: filePath,
      },
    });
  } catch (error) {
    console.error("duty/odometer POST error:", error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Could not read the odometer photo.",
    }, { status: 500 });
  }
}
