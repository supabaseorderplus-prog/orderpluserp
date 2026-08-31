"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Camera, CheckCircle2, Gauge, Loader2, RefreshCw, ScanLine, ShieldCheck, X } from "lucide-react";
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
  data: { reading: number; confidence: number; photo_path: string };
}

const SCAN_TIMEOUT_MS = 30_000;
const SCAN_RETRY_DELAY_MS = 450;
const GUIDE = { x: 0.08, y: 0.27, width: 0.84, height: 0.34 };

function formatKm(value: number) {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 1 });
}

function wait(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

async function captureOdometerFrames(video: HTMLVideoElement, phase: "start" | "end") {
  const fullCanvas = document.createElement("canvas");
  fullCanvas.width = video.videoWidth;
  fullCanvas.height = video.videoHeight;
  const fullContext = fullCanvas.getContext("2d");
  if (!fullContext) throw new Error("Live photo could not be captured. Try again.");
  fullContext.drawImage(video, 0, 0, fullCanvas.width, fullCanvas.height);

  // Video uses object-cover. Translate visible guide into source pixels so OCR
  // receives only the odometer display while the stored evidence stays full-frame.
  const visibleWidth = Math.max(1, video.clientWidth);
  const visibleHeight = Math.max(1, video.clientHeight);
  const scale = Math.max(visibleWidth / video.videoWidth, visibleHeight / video.videoHeight);
  const overflowX = Math.max(0, (video.videoWidth * scale - visibleWidth) / 2);
  const overflowY = Math.max(0, (video.videoHeight * scale - visibleHeight) / 2);
  const sourceX = Math.max(0, Math.round((visibleWidth * GUIDE.x + overflowX) / scale));
  const sourceY = Math.max(0, Math.round((visibleHeight * GUIDE.y + overflowY) / scale));
  const sourceWidth = Math.min(video.videoWidth - sourceX, Math.round((visibleWidth * GUIDE.width) / scale));
  const sourceHeight = Math.min(video.videoHeight - sourceY, Math.round((visibleHeight * GUIDE.height) / scale));

  const ocrCanvas = document.createElement("canvas");
  ocrCanvas.width = Math.max(1, sourceWidth);
  ocrCanvas.height = Math.max(1, sourceHeight);
  const ocrContext = ocrCanvas.getContext("2d");
  if (!ocrContext) throw new Error("Odometer scan could not be prepared. Try again.");
  ocrContext.filter = "grayscale(1) contrast(1.65)";
  ocrContext.drawImage(fullCanvas, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);

  const [photoBlob, ocrBlob] = await Promise.all([canvasBlob(fullCanvas, 0.9), canvasBlob(ocrCanvas, 0.95)]);
  if (!photoBlob || !ocrBlob) throw new Error("Live photo could not be captured. Try again.");

  const timestamp = Date.now();
  return {
    photoFile: new File([photoBlob], `odometer-${phase}-${timestamp}.jpg`, { type: "image/jpeg" }),
    ocrFile: new File([ocrBlob], `odometer-${phase}-${timestamp}-scan.jpg`, { type: "image/jpeg" }),
  };
}

export function OdometerCaptureModal({ phase, startReading, onClose, onConfirm }: OdometerCaptureModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanAbortRef = useRef<AbortController | null>(null);
  const previewUrlRef = useRef("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [capture, setCapture] = useState<OdometerCapture | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [readingPhoto, setReadingPhoto] = useState(false);
  const [scanSeconds, setScanSeconds] = useState(30);
  const [scanAttempt, setScanAttempt] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  const replacePreview = useCallback((file?: File) => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = file ? URL.createObjectURL(file) : "";
    setPreviewUrl(previewUrlRef.current);
  }, []);

  const stopCamera = useCallback(() => {
    scanAbortRef.current?.abort();
    scanAbortRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
    setReadingPhoto(false);
  }, []);

  useEffect(() => () => {
    scanAbortRef.current?.abort();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!cameraActive || !video || !stream) return;
    video.srcObject = stream;
    void video.play().catch(() => {});
    return () => { if (video.srcObject === stream) video.srcObject = null; };
  }, [cameraActive]);

  useEffect(() => {
    if (!cameraActive) return;

    let cancelled = false;
    const deadline = Date.now() + SCAN_TIMEOUT_MS;
    let lastFailure = "";
    setReadingPhoto(false);
    setScanSeconds(30);
    setScanAttempt(0);

    const countdown = window.setInterval(() => {
      setScanSeconds(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    }, 250);

    const finishWithTimeout = () => {
      if (cancelled) return;
      stopCamera();
      setError(lastFailure && !/could not be read|could not be detected|possible reading|clearly/i.test(lastFailure)
        ? lastFailure
        : "Odometer was not recognized within 30 seconds. Clean the display, avoid glare, place all digits inside the green box, then retry.");
    };

    const scan = async () => {
      const video = videoRef.current;
      if (!video) return;
      while (!cancelled && Date.now() < deadline) {
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) {
          await wait(120);
          continue;
        }

        try {
          setScanAttempt((attempt) => attempt + 1);
          setReadingPhoto(true);
          const { photoFile, ocrFile } = await captureOdometerFrames(video, phase);
          const formData = new FormData();
          formData.append("image", photoFile, photoFile.name);
          formData.append("ocr_image", ocrFile, ocrFile.name);
          formData.append("phase", phase);

          const controller = new AbortController();
          scanAbortRef.current = controller;
          const abortTimer = window.setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
          try {
            const result = await api<OdometerOcrResponse>("/api/v1/duty/odometer", {
              method: "POST",
              formData,
              signal: controller.signal,
              suppressErrorLog: true,
            });
            if (cancelled) return;
            replacePreview(photoFile);
            setCapture({
              reading: Number(result.data.reading),
              confidence: Number(result.data.confidence),
              photoPath: result.data.photo_path,
            });
            setError("");
            stopCamera();
            return;
          } finally {
            window.clearTimeout(abortTimer);
            if (scanAbortRef.current === controller) scanAbortRef.current = null;
          }
        } catch (scanError) {
          if (cancelled) return;
          if (scanError instanceof Error && scanError.name === "AbortError") break;
          lastFailure = scanError instanceof Error ? scanError.message : "Kilometres could not be detected.";
        } finally {
          if (!cancelled) setReadingPhoto(false);
        }

        const remaining = deadline - Date.now();
        if (remaining > 0) await wait(Math.min(SCAN_RETRY_DELAY_MS, remaining));
      }
      finishWithTimeout();
    };

    void scan();
    return () => {
      cancelled = true;
      window.clearInterval(countdown);
      scanAbortRef.current?.abort();
      scanAbortRef.current = null;
    };
  }, [cameraActive, phase, replacePreview, stopCamera]);

  const startCamera = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Live camera is not available on this device. Odometer photos cannot be uploaded from the gallery.");
      return;
    }
    stopCamera();
    replacePreview();
    setCapture(null);
    setError("");
    setScanAttempt(0);
    setScanSeconds(30);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      streamRef.current = stream;
      setCameraActive(true);
    } catch (cameraError) {
      const denied = cameraError instanceof DOMException && cameraError.name === "NotAllowedError";
      setError(denied
        ? "Camera permission is required. Allow camera access, then retry. Gallery upload is disabled."
        : "Live camera could not be opened. Check the camera and retry. Gallery upload is disabled.");
    }
  };

  const confirm = async () => {
    if (!capture) return;
    setConfirming(true);
    setError("");
    try { await onConfirm(capture); }
    catch (confirmError) { setError(confirmError instanceof Error ? confirmError.message : "Duty could not be updated. Try again."); }
    finally { setConfirming(false); }
  };

  const distance = phase === "end" && capture && startReading != null ? capture.reading - startReading : null;

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 p-3 backdrop-blur-sm sm:items-center" onClick={confirming ? undefined : onClose}>
      <div className="max-h-[94vh] w-full max-w-md overflow-y-auto rounded-3xl border border-white/10 bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between border-b border-black/[0.06] px-5 py-4">
          <div className="flex gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700"><Gauge className="h-5 w-5" /></div>
            <div>
              <h2 className="text-base font-bold text-zinc-950">{phase === "start" ? "Start odometer scan" : "End odometer scan"}</h2>
              <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{phase === "start" ? "Required before duty and GPS tracking begin." : "Required before today’s duty can be closed."}</p>
            </div>
          </div>
          <button type="button" disabled={confirming} onClick={onClose} className="rounded-full p-2 text-zinc-400 hover:bg-zinc-100 disabled:opacity-40" aria-label="Close odometer camera"><X className="h-4 w-4" /></button>
        </div>

        <div className="space-y-4 p-5">
          <div className="relative aspect-[4/3] overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-950">
            {previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewUrl} alt="Automatically captured odometer" className="h-full w-full object-contain" />
            ) : cameraActive ? (
              <>
                <video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-cover" aria-label="Live rear camera preview" />
                <div className="pointer-events-none absolute inset-x-[8%] top-[27%] h-[34%] rounded-xl border-2 border-emerald-400 shadow-[0_0_0_999px_rgba(0,0,0,0.28),0_0_24px_rgba(52,211,153,0.35)]">
                  <span className="absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-emerald-500 px-3 py-1 text-[0.62rem] font-black text-zinc-950">PLACE ODOMETER DIGITS HERE</span>
                  <ScanLine className="absolute left-1/2 top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 animate-pulse text-emerald-300" />
                </div>
                <div className="absolute inset-x-3 bottom-3 overflow-hidden rounded-xl border border-white/15 bg-zinc-950/85 px-3 py-2.5 text-white backdrop-blur">
                  <div className="flex items-center justify-between gap-3 text-[0.68rem]"><span className="flex items-center gap-2 font-bold"><Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" /> {readingPhoto ? "Reading digits…" : "Scanning automatically…"}</span><span className="font-black tabular-nums text-emerald-300">{scanSeconds}s</span></div>
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/15"><div className="h-full bg-emerald-400 transition-all" style={{ width: `${Math.max(0, Math.min(100, (scanSeconds / 30) * 100))}%` }} /></div>
                  <div className="mt-1.5 text-[0.58rem] text-zinc-400">Attempt {Math.max(1, scanAttempt)} · Hold phone steady. Photo captures automatically.</div>
                </div>
              </>
            ) : (
              <button type="button" onClick={() => void startCamera()} className="flex h-full w-full flex-col items-center justify-center gap-3 text-white">
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/20"><Camera className="h-6 w-6" /></span>
                <span className="text-sm font-bold">Open live camera</span>
                <span className="max-w-[17rem] text-center text-[0.68rem] leading-relaxed text-zinc-400">Automatic scan and capture. No shutter button or gallery upload.</span>
              </button>
            )}
          </div>

          {capture && (
            <div className="overflow-hidden rounded-2xl border border-emerald-200 bg-emerald-50">
              <div className="flex items-center gap-2 border-b border-emerald-200 px-4 py-2.5 text-xs font-bold text-emerald-800"><CheckCircle2 className="h-4 w-4" /> Photo captured and saved automatically</div>
              <div className={`grid ${distance != null ? "grid-cols-2" : "grid-cols-1"} divide-x divide-emerald-200`}>
                <div className="px-4 py-4 text-center"><div className="text-2xl font-black tabular-nums text-zinc-950">{formatKm(capture.reading)}</div><div className="mt-1 text-[0.62rem] font-bold uppercase tracking-wider text-zinc-500">{phase === "start" ? "Starting km" : "Ending km"}</div></div>
                {distance != null && <div className="px-4 py-4 text-center"><div className="text-2xl font-black tabular-nums text-emerald-700">{formatKm(distance)}</div><div className="mt-1 text-[0.62rem] font-bold uppercase tracking-wider text-zinc-500">Driven today</div></div>}
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-800">
              <div className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>
              <button type="button" onClick={() => void startCamera()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-3 py-2.5 font-bold text-zinc-950"><RefreshCw className="h-3.5 w-3.5" /> Retry automatic scan</button>
            </div>
          )}

          <div className="flex items-start gap-2 rounded-xl bg-zinc-100 px-3 py-2.5 text-[0.68rem] leading-relaxed text-zinc-600"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" /> Camera scans continuously for up to 30 seconds. Successful photo and reading stay attached to today’s duty record for verification.</div>

          {previewUrl && !error && (
            <div className="flex gap-3">
              <button type="button" onClick={() => void startCamera()} disabled={confirming} className="flex-1 rounded-xl border border-zinc-200 px-4 py-3 text-xs font-bold text-zinc-700 hover:bg-zinc-50">Retry scan</button>
              <button type="button" onClick={() => void confirm()} disabled={!capture || confirming} className="flex flex-[1.35] items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-3 text-xs font-black text-zinc-950 hover:bg-emerald-400 disabled:bg-zinc-200 disabled:text-zinc-400">
                {confirming ? <Loader2 className="h-4 w-4 animate-spin" /> : phase === "start" ? <Camera className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                {confirming ? "Saving duty…" : phase === "start" ? `Start at ${formatKm(capture!.reading)} km` : `End at ${formatKm(capture!.reading)} km`}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
