"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Camera, CheckCircle2, Gauge, Loader2, RefreshCw, ShieldCheck, X } from "lucide-react";
import { api } from "@/lib/api";

export interface OdometerCapture {
  reading: number;
  confidence: number;
  photoPath: string;
}

interface OdometerCaptureModalProps {
  phase: "start" | "end";
  startReading?: number | null;
  onClose: () => void;
  onConfirm: (capture: OdometerCapture) => Promise<void>;
}

interface OdometerOcrResponse {
  data: {
    reading: number;
    confidence: number;
    photo_path: string;
  };
}

function formatKm(value: number) {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 1 });
}

export function OdometerCaptureModal({ phase, startReading, onClose, onConfirm }: OdometerCaptureModalProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [capture, setCapture] = useState<OdometerCapture | null>(null);
  const [readingPhoto, setReadingPhoto] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const chooseAnotherPhoto = () => {
    setCapture(null);
    setError("");
    inputRef.current?.click();
  };

  const readPhoto = async (file: File) => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    setCapture(null);
    setError("");
    setReadingPhoto(true);

    try {
      const formData = new FormData();
      formData.append("image", file, file.name || `odometer-${phase}.jpg`);
      formData.append("phase", phase);
      const result = await api<OdometerOcrResponse>("/api/v1/duty/odometer", {
        method: "POST",
        formData,
      });
      setCapture({
        reading: Number(result.data.reading),
        confidence: Number(result.data.confidence),
        photoPath: result.data.photo_path,
      });
    } catch (photoError) {
      setError(photoError instanceof Error ? photoError.message : "Kilometres could not be detected. Take another photo.");
    } finally {
      setReadingPhoto(false);
    }
  };

  const confirm = async () => {
    if (!capture) return;
    setConfirming(true);
    setError("");
    try {
      await onConfirm(capture);
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : "Duty could not be updated. Try again.");
    } finally {
      setConfirming(false);
    }
  };

  const distance = phase === "end" && capture && startReading != null
    ? capture.reading - startReading
    : null;
  const busy = readingPhoto || confirming;

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 p-3 backdrop-blur-sm sm:items-center" onClick={busy ? undefined : onClose}>
      <div className="max-h-[94vh] w-full max-w-md overflow-y-auto rounded-3xl border border-white/10 bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between border-b border-black/[0.06] px-5 py-4">
          <div className="flex gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700">
              <Gauge className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-zinc-950">{phase === "start" ? "Start odometer photo" : "End odometer photo"}</h2>
              <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
                {phase === "start" ? "Required before duty and GPS tracking begin." : "Required before today’s duty can be closed."}
              </p>
            </div>
          </div>
          <button type="button" disabled={busy} onClick={onClose} className="rounded-full p-2 text-zinc-400 hover:bg-zinc-100 disabled:opacity-40" aria-label="Close odometer camera">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = "";
              if (file) void readPhoto(file);
            }}
          />

          <div className="relative aspect-[4/3] overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-950">
            {previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewUrl} alt="Odometer photo preview" className="h-full w-full object-contain" />
            ) : (
              <button type="button" onClick={() => inputRef.current?.click()} className="flex h-full w-full flex-col items-center justify-center gap-3 text-white">
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/20"><Camera className="h-6 w-6" /></span>
                <span className="text-sm font-bold">Take odometer photo</span>
                <span className="max-w-[16rem] text-center text-[0.68rem] leading-relaxed text-zinc-400">Fill frame with kilometre display. Keep digits sharp and avoid glare.</span>
              </button>
            )}

            {readingPhoto && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-950/85 text-white">
                <Loader2 className="h-7 w-7 animate-spin text-emerald-400" />
                <div className="text-center">
                  <div className="text-sm font-bold">Reading kilometres…</div>
                  <div className="mt-1 text-[0.68rem] text-zinc-400">Checking photo clarity and odometer digits</div>
                </div>
              </div>
            )}
          </div>

          {capture && (
            <div className="overflow-hidden rounded-2xl border border-emerald-200 bg-emerald-50">
              <div className="flex items-center gap-2 border-b border-emerald-200 px-4 py-2.5 text-xs font-bold text-emerald-800">
                <CheckCircle2 className="h-4 w-4" /> Odometer detected automatically
              </div>
              <div className={`grid ${distance != null ? "grid-cols-2" : "grid-cols-1"} divide-x divide-emerald-200`}>
                <div className="px-4 py-4 text-center">
                  <div className="text-2xl font-black tabular-nums text-zinc-950">{formatKm(capture.reading)}</div>
                  <div className="mt-1 text-[0.62rem] font-bold uppercase tracking-wider text-zinc-500">{phase === "start" ? "Starting km" : "Ending km"}</div>
                </div>
                {distance != null && (
                  <div className="px-4 py-4 text-center">
                    <div className="text-2xl font-black tabular-nums text-emerald-700">{formatKm(distance)}</div>
                    <div className="mt-1 text-[0.62rem] font-bold uppercase tracking-wider text-zinc-500">Driven today</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-800">
              <div className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>
              <button type="button" onClick={chooseAnotherPhoto} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-3 py-2.5 font-bold text-zinc-950">
                <RefreshCw className="h-3.5 w-3.5" /> Take another photo
              </button>
            </div>
          )}

          <div className="flex items-start gap-2 rounded-xl bg-zinc-100 px-3 py-2.5 text-[0.68rem] leading-relaxed text-zinc-600">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
            Reading is extracted automatically. Photo remains attached to today’s duty record for verification.
          </div>

          {previewUrl && !readingPhoto && !error && (
            <div className="flex gap-3">
              <button type="button" onClick={chooseAnotherPhoto} disabled={confirming} className="flex-1 rounded-xl border border-zinc-200 px-4 py-3 text-xs font-bold text-zinc-700 hover:bg-zinc-50">
                Retake photo
              </button>
              <button type="button" onClick={() => void confirm()} disabled={!capture || confirming} className="flex flex-[1.35] items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-3 text-xs font-black text-zinc-950 hover:bg-emerald-400 disabled:bg-zinc-200 disabled:text-zinc-400">
                {confirming ? <Loader2 className="h-4 w-4 animate-spin" /> : phase === "start" ? <Camera className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                {confirming ? "Saving…" : phase === "start" ? `Start at ${formatKm(capture!.reading)} km` : `End at ${formatKm(capture!.reading)} km`}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
