export interface OdometerReadingCandidate {
  reading: number;
  source: string;
  digits: number;
}

export interface OdometerReadingResult {
  reading: number | null;
  candidates: OdometerReadingCandidate[];
  reason: "detected" | "not_found" | "ambiguous";
}

export const DUTY_ODOMETER_PREFIX = "ORDERPLUS_ODOMETER_V1:";

export interface DutyOdometerCaptureEvidence {
  reading: number;
  confidence: number;
  photo_path: string;
  captured_at: string;
}

export interface DutyOdometerEvidence {
  version: 1;
  start: DutyOdometerCaptureEvidence;
  end: DutyOdometerCaptureEvidence | null;
  distance_km: number | null;
  previous_notes: string | null;
}

const MIN_ODOMETER_DIGITS = 3;
const MAX_ODOMETER_KM = 9_999_999.9;

function parseNumericToken(source: string): OdometerReadingCandidate | null {
  const token = source.trim().replace(/\s+/g, "");
  if (!token) return null;

  const lastSeparator = Math.max(token.lastIndexOf("."), token.lastIndexOf(","));
  const decimalDigits = lastSeparator >= 0 ? token.length - lastSeparator - 1 : 0;
  const hasSingleDecimal = lastSeparator >= 0 && decimalDigits === 1;
  const normalized = hasSingleDecimal
    ? `${token.slice(0, lastSeparator).replace(/[.,]/g, "")}.${token.slice(lastSeparator + 1)}`
    : token.replace(/[.,]/g, "");
  const digits = normalized.replace(/\D/g, "").length;
  const reading = Number(normalized);

  if (digits < MIN_ODOMETER_DIGITS || !Number.isFinite(reading) || reading < 0 || reading > MAX_ODOMETER_KM) {
    return null;
  }

  return { reading, source, digits };
}

export function extractOdometerReading(rawText: string): OdometerReadingResult {
  const normalizedText = rawText
    .replace(/[Oo]/g, "0")
    .replace(/[Il|]/g, "1")
    .replace(/[^0-9.,\s]/g, " ");
  const matches = normalizedText
    .split(/\r?\n/)
    .flatMap((line) => {
      const tokens: string[] = line.match(/\d+(?:[.,]\d+)*/g) || [];
      if (tokens.length >= 3 && tokens.every((token) => token.length === 1)) {
        tokens.push(tokens.join(""));
      }
      return tokens;
    });
  const unique = new Map<number, OdometerReadingCandidate>();

  for (const match of matches) {
    const candidate = parseNumericToken(match);
    if (!candidate) continue;
    const existing = unique.get(candidate.reading);
    if (!existing || candidate.digits > existing.digits) unique.set(candidate.reading, candidate);
  }

  const candidates = [...unique.values()].sort((a, b) => b.digits - a.digits || b.reading - a.reading);
  if (candidates.length === 0) return { reading: null, candidates, reason: "not_found" };

  const best = candidates[0];
  const equallyStrong = candidates.filter((candidate) => candidate.digits === best.digits);
  if (equallyStrong.length > 1) return { reading: null, candidates, reason: "ambiguous" };

  return { reading: best.reading, candidates, reason: "detected" };
}

export function validateOdometerProgress(startKm: number, endKm: number, maxDailyKm = 1_500): string | null {
  if (!Number.isFinite(startKm) || !Number.isFinite(endKm)) return "Odometer reading is invalid.";
  if (endKm < startKm) return "End odometer cannot be lower than the start odometer. Take another photo.";
  if (endKm - startKm > maxDailyKm) return `Daily distance cannot exceed ${maxDailyKm.toLocaleString("en-IN")} km. Take another photo.`;
  return null;
}

export function parseDutyOdometerEvidence(notes: string | null | undefined): DutyOdometerEvidence | null {
  if (!notes?.startsWith(DUTY_ODOMETER_PREFIX)) return null;
  try {
    const evidence = JSON.parse(notes.slice(DUTY_ODOMETER_PREFIX.length)) as DutyOdometerEvidence;
    if (evidence?.version !== 1 || !Number.isFinite(evidence.start?.reading) || !evidence.start?.photo_path) return null;
    return {
      ...evidence,
      end: evidence.end || null,
      distance_km: evidence.distance_km ?? null,
      previous_notes: evidence.previous_notes || null,
    };
  } catch {
    return null;
  }
}

export function encodeDutyOdometerEvidence(
  evidence: Omit<DutyOdometerEvidence, "version" | "previous_notes">,
  currentNotes?: string | null,
): string {
  const existing = parseDutyOdometerEvidence(currentNotes);
  return `${DUTY_ODOMETER_PREFIX}${JSON.stringify({
    version: 1,
    ...evidence,
    previous_notes: existing?.previous_notes ?? currentNotes ?? null,
  } satisfies DutyOdometerEvidence)}`;
}
