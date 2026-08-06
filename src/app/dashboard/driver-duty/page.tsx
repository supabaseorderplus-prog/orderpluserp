"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, getUser } from "@/lib/api";
import {
  AlertCircle, CheckCircle2, Loader2, MapPin,
  Navigation, PlayCircle, StopCircle, Truck,
} from "lucide-react";

interface DeliveryLot { id: string; lot_number: string; destination: string; driver_id: string; status: string; }
interface DaySession { id: string; salesman_id: string; date: string; check_in_time: string | null; check_out_time: string | null; status: string; notes: string | null; total_distance_km: number; }

const s: React.CSSProperties = { transform: "none", filter: "none", WebkitTextStroke: "0", background: "none", boxShadow: "none", display: "block", padding: 0 };

export default function DriverDutyPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [userName, setUserName] = useState("");
  const [session, setSession] = useState<DaySession | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [currentPos, setCurrentPos] = useState<{ lat: number; lng: number } | null>(null);
  const [tracking, setTracking] = useState(false);
  const [pingCount, setPingCount] = useState(0);
  const [distKm, setDistKm] = useState(0);
  const [activeLot, setActiveLot] = useState<DeliveryLot | null>(null);
  const [lots, setLots] = useState<DeliveryLot[]>([]);
  const [selectedLotId, setSelectedLotId] = useState("");

  const watchId = useRef<number | null>(null);
  const pingInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPingPos = useRef<{ lat: number; lng: number } | null>(null);
  const pingPositions = useRef<{ lat: number; lng: number }[]>([]);

  const loadSession = useCallback(async (uid: string) => {
    try {
      const res = await api<{ data: DaySession[] }>(`/api/v1/tracking/sessions?salesman_id=${uid}`);
      const today = new Date().toISOString().split("T")[0];
      const todaySession = (res.data || []).find(s => s.date === today && s.status === "active") || null;
      setSession(todaySession);
      if (todaySession) {
        setTracking(true);
        setDistKm(todaySession.total_distance_km || 0);
        // Parse lot from notes
        if (todaySession.notes) {
          const lotMatch = todaySession.notes.match(/LOT:([^|]+)/);
          if (lotMatch) {
            const destMatch = todaySession.notes.match(/DEST:(.+)/);
            setActiveLot({ id: "", lot_number: lotMatch[1], destination: destMatch?.[1] || "", driver_id: uid, status: "DISPATCHED" });
          }
        }
      }
    } catch { setSession(null); }
  }, []);

  useEffect(() => {
    const user = getUser();
    if (user) {
      setUserId(user.id);
      setUserName(user.name || "Driver");
    }
  }, []);

  useEffect(() => {
    if (!userId) return;
    setLoading(true);
    loadSession(userId).finally(() => setLoading(false));
    // Load DISPATCHED lots assigned to this driver from delivery-lots store
    try {
      const raw = localStorage.getItem("delivery_lots_v1");
      const allLots: DeliveryLot[] = raw ? JSON.parse(raw) : [];
      const myLots = allLots.filter(l => l.driver_id === userId && (l.status === "READY" || l.status === "DISPATCHED" || l.status === "OPEN"));
      setLots(myLots);
    } catch { setLots([]); }
  }, [userId, loadSession]);

  // Start continuous GPS tracking
  function startGPSWatch(uid: string) {
    if (!navigator.geolocation) { setError("Geolocation not supported on this device"); return; }
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        setCurrentPos({ lat, lng });
        const last = lastPingPos.current;
        if (last) {
          const R = 6371;
          const dLat = ((lat - last.lat) * Math.PI) / 180;
          const dLng = ((lng - last.lng) * Math.PI) / 180;
          const a = Math.sin(dLat/2)**2 + Math.cos(last.lat*Math.PI/180)*Math.cos(lat*Math.PI/180)*Math.sin(dLng/2)**2;
          const km = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
          if (km > 0.01) {
            setDistKm(prev => parseFloat((prev + km).toFixed(2)));
            pingPositions.current.push({ lat, lng });
          }
        }
        lastPingPos.current = { lat, lng };
        // Ping server every ~30s via setInterval instead to avoid flooding
        void api("/api/v1/tracking/location", {
          method: "POST",
          body: { salesman_id: uid, latitude: lat, longitude: lng, accuracy, activity: "moving" },
        }).then(() => setPingCount(p => p + 1)).catch(() => {});
      },
      (err) => { console.warn("GPS error:", err.message); },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
    );
  }

  function stopGPSWatch() {
    if (watchId.current !== null) { navigator.geolocation.clearWatch(watchId.current); watchId.current = null; }
    if (pingInterval.current) { clearInterval(pingInterval.current); pingInterval.current = null; }
  }

  async function handleStartDuty() {
    if (!userId) return;
    setStarting(true); setError("");
    try {
      const pos = await new Promise<GeolocationPosition>((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 10000 })
      );
      const { latitude, longitude } = pos.coords;
      const selectedLot = lots.find(l => l.id === selectedLotId);
      const notes = selectedLot
        ? `LOT:${selectedLot.lot_number}|DEST:${selectedLot.destination}`
        : undefined;

      await api("/api/v1/tracking/sessions", {
        method: "POST",
        body: { salesman_id: userId, latitude, longitude, notes },
      });
      await loadSession(userId);
      startGPSWatch(userId);
      setTracking(true);
      setActiveLot(selectedLot || null);
      setSuccess("Duty started! Your location is now being tracked.");
      if (selectedLot) setSelectedLotId("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not get location. Please allow GPS access.");
    }
    setStarting(false);
  }

  async function handleStopDuty() {
    if (!userId) return;
    setStopping(true); setError("");
    try {
      const pos = await new Promise<GeolocationPosition>((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 10000 })
      ).catch(() => null);
      await api("/api/v1/tracking/sessions", {
        method: "PATCH",
        body: {
          salesman_id: userId,
          latitude: pos?.coords.latitude,
          longitude: pos?.coords.longitude,
          total_distance_km: distKm,
          status: "checked_out",
        },
      });
      stopGPSWatch();
      setTracking(false);
      setSession(null);
      setActiveLot(null);
      setDistKm(0);
      setPingCount(0);
      lastPingPos.current = null;
      setSuccess("Duty ended. Have a safe journey home!");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to stop duty");
    }
    setStopping(false);
  }

  useEffect(() => () => stopGPSWatch(), []);
  useEffect(() => { if (success) { const t = setTimeout(() => setSuccess(""), 4000); return () => clearTimeout(t); } }, [success]);

  if (loading) return (
    <div className="flex items-center justify-center py-24">
      <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
    </div>
  );

  const dutyStart = session?.check_in_time ? new Date(session.check_in_time) : null;
  const dutyMins = dutyStart ? Math.floor((Date.now() - dutyStart.getTime()) / 60000) : 0;
  const dutyLabel = dutyMins < 60 ? `${dutyMins}m` : `${Math.floor(dutyMins/60)}h ${dutyMins%60}m`;

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif", maxWidth: 480, margin: "0 auto" }}>
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-full bg-sky-500/10 flex items-center justify-center shrink-0">
          <Truck className="w-5 h-5 text-sky-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-zinc-900" style={{ ...s, marginBottom: 2 }}>Driver Duty</h1>
          <p className="text-zinc-500" style={{ fontSize: "0.78rem", margin: 0 }}>Welcome, {userName}</p>
        </div>
        {tracking && (
          <span className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" style={{ fontSize: "0.7rem" }}>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            On Duty
          </span>
        )}
      </div>

      {/* Success / Error */}
      {success && (
        <div className="mb-4 flex items-center gap-2 px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400" style={{ fontSize: "0.82rem" }}>
          <CheckCircle2 className="w-4 h-4 shrink-0" /> {success}
        </div>
      )}
      {error && (
        <div className="mb-4 flex items-center gap-2 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400" style={{ fontSize: "0.82rem" }}>
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {/* Status cards when on duty */}
      {tracking && (
        <div className="grid grid-cols-3 gap-3 mb-5">
          {[
            { label: "Distance", value: `${distKm} km`, icon: Navigation, color: "text-sky-400" },
            { label: "Duration", value: dutyLabel, icon: Truck, color: "text-amber-400" },
            { label: "GPS Pings", value: String(pingCount), icon: MapPin, color: "text-emerald-400" },
          ].map(({ label, value, icon: Icon, color }) => (
            <div key={label} className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-3 text-center">
              <Icon className={`w-4 h-4 ${color} mx-auto mb-1`} />
              <div className="text-zinc-900 font-bold" style={{ fontSize: "1rem" }}>{value}</div>
              <div className="text-zinc-500" style={{ fontSize: "0.65rem" }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Active lot info */}
      {activeLot && (
        <div className="mb-5 px-4 py-3 rounded-xl border border-sky-500/20 bg-sky-500/5">
          <div className="flex items-center gap-2 mb-0.5">
            <Truck className="w-3.5 h-3.5 text-sky-400" />
            <span className="text-sky-400 font-semibold" style={{ fontSize: "0.78rem" }}>{activeLot.lot_number}</span>
          </div>
          {activeLot.destination && (
            <div className="flex items-center gap-1 text-zinc-600" style={{ fontSize: "0.75rem" }}>
              <MapPin className="w-3 h-3" /> {activeLot.destination}
            </div>
          )}
        </div>
      )}

      {/* Lot selector (only when not on duty) */}
      {!tracking && lots.length > 0 && (
        <div className="mb-4">
          <label className="block text-xs text-zinc-600 mb-1.5" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Select Delivery Lot (optional)</label>
          <select
            value={selectedLotId}
            onChange={e => setSelectedLotId(e.target.value)}
            className="w-full px-3 py-2.5 rounded-xl border border-black/10 bg-black/[0.02] text-zinc-700 outline-none"
            style={{ fontSize: "0.82rem", fontFamily: "inherit" }}
          >
            <option value="">— No specific lot —</option>
            {lots.map(l => (
              <option key={l.id} value={l.id}>{l.lot_number}{l.destination ? ` → ${l.destination}` : ""}</option>
            ))}
          </select>
        </div>
      )}

      {/* Current location */}
      {currentPos && (
        <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-black/[0.03] border border-black/[0.06]" style={{ fontSize: "0.72rem" }}>
          <MapPin className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span className="text-zinc-600 font-mono">{currentPos.lat.toFixed(5)}, {currentPos.lng.toFixed(5)}</span>
        </div>
      )}

      {/* Main action button */}
      {!tracking ? (
        <button
          onClick={handleStartDuty}
          disabled={starting}
          className="w-full flex items-center justify-center gap-3 py-4 rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-zinc-900 font-bold transition-colors disabled:opacity-50"
          style={{ fontSize: "1rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}
        >
          {starting ? <Loader2 className="w-5 h-5 animate-spin" /> : <PlayCircle className="w-6 h-6" />}
          {starting ? "Getting location…" : "Start Duty"}
        </button>
      ) : (
        <button
          onClick={handleStopDuty}
          disabled={stopping}
          className="w-full flex items-center justify-center gap-3 py-4 rounded-2xl bg-red-500 hover:bg-red-400 text-zinc-900 font-bold transition-colors disabled:opacity-50"
          style={{ fontSize: "1rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}
        >
          {stopping ? <Loader2 className="w-5 h-5 animate-spin" /> : <StopCircle className="w-6 h-6" />}
          {stopping ? "Stopping…" : "Stop Duty"}
        </button>
      )}

      <p className="text-center text-zinc-500 mt-3" style={{ fontSize: "0.7rem" }}>
        {tracking
          ? "Your location is being shared with dispatch. Keep this page open."
          : "Tap Start Duty to begin location tracking. GPS access is required."}
      </p>
    </div>
  );
}
