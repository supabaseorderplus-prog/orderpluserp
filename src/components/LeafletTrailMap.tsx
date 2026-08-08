"use client";

import { useEffect, useRef } from "react";
import { addDetailedBaseLayers } from "@/lib/leaflet-map-layers";

export interface LocationLog {
  id?: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  battery_level?: number;
  speed?: number;
  heading?: number;
  address?: string;
  place_name?: string;
  road?: string;
  suburb?: string;
  city?: string;
  activity?: string;
  note?: string;
  recorded_at: string;
}

interface WeatherData {
  temp: number;
  feelsLike: number;
  humidity: number;
  windspeed: number;
  weathercode: number;
}

function weatherEmoji(code: number): string {
  if (code === 0) return "☀️";
  if (code <= 2) return "⛅";
  if (code === 3) return "☁️";
  if (code <= 49) return "🌫️";
  if (code <= 59) return "🌦️";
  if (code <= 69) return "🌧️";
  if (code <= 79) return "❄️";
  if (code <= 84) return "🌦️";
  if (code <= 94) return "⛈️";
  return "🌩️";
}

function weatherLabel(code: number): string {
  if (code === 0) return "Clear sky";
  if (code <= 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code <= 49) return "Foggy";
  if (code <= 59) return "Drizzle";
  if (code <= 69) return "Rain";
  if (code <= 79) return "Snow";
  if (code <= 84) return "Rain showers";
  if (code <= 94) return "Thunderstorm";
  return "Storm";
}

interface Salesman {
  id: string;
  name: string;
}

interface Props {
  trail: LocationLog[];
  salesman: Salesman;
  fallbackLat?: number;
  fallbackLng?: number;
  liveLocation?: LocationLog | null;
  weather?: WeatherData | null;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
}

function fmtSpeed(mps?: number) {
  if (mps == null || mps < 0.5) return null;
  return `${(mps * 3.6).toFixed(1)} km/h`;
}

function activityEmoji(activity?: string) {
  switch (activity) {
    case "stopped":  return "🛑";
    case "meeting":  return "🤝";
    case "delivery": return "📦";
    default:         return "🚶";
  }
}

function buildLabel(log: LocationLog): string {
  if (log.place_name) return log.place_name;
  if (log.address)    return log.address;
  return `${log.latitude.toFixed(5)}, ${log.longitude.toFixed(5)}`;
}

function buildPopupHtml(log: LocationLog, salesman: Salesman, isLive = false, isStart = false, weather?: WeatherData | null): string {
  const label   = buildLabel(log);
  const road    = log.road    ? `<div style="color:#6b7280;font-size:10px;margin-top:2px">🛣️ ${log.road}</div>` : "";
  const suburb  = log.suburb  ? `<div style="color:#6b7280;font-size:10px">📌 ${log.suburb}</div>` : "";
  const city    = log.city    ? `<div style="color:#6b7280;font-size:10px">🏙️ ${log.city}</div>` : "";
  const note    = log.note    ? `<div style="color:#d97706;font-size:10px;margin-top:4px">📝 ${log.note}</div>` : "";
  const speed   = fmtSpeed(log.speed) ? `<div style="color:#16a34a;font-size:10px">⚡ ${fmtSpeed(log.speed)}</div>` : "";
  const battery = log.battery_level != null ? `<div style="color:#6b7280;font-size:10px">🔋 ${log.battery_level}%</div>` : "";
  const acc     = log.accuracy != null ? `<div style="color:#9ca3af;font-size:9px">Accuracy: ±${Math.round(log.accuracy)}m</div>` : "";
  const badge   = isLive  ? `<span style="background:#fff7ed;color:#d97706;font-size:9px;padding:1px 6px;border-radius:999px;border:1px solid #fed7aa">LIVE</span>`
                : isStart ? `<span style="background:#f0fdf4;color:#16a34a;font-size:9px;padding:1px 6px;border-radius:999px;border:1px solid #bbf7d0">START</span>`
                : "";
  const weatherBlock = (isLive && weather)
    ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #f3f4f6;display:flex;align-items:center;gap:6px">
        <span style="font-size:18px;line-height:1">${weatherEmoji(weather.weathercode)}</span>
        <div>
          <div style="color:#111827;font-size:11px;font-weight:600">${weather.temp}°C &nbsp;<span style="color:#6b7280;font-weight:400;font-size:10px">${weatherLabel(weather.weathercode)}</span></div>
          <div style="color:#6b7280;font-size:9px">Feels ${weather.feelsLike}°C · 💨 ${weather.windspeed} km/h${weather.humidity != null ? ` · 💧 ${weather.humidity}%` : ""}</div>
        </div>
      </div>`
    : "";

  return `
    <div style="font-family:system-ui,sans-serif;min-width:160px;max-width:220px">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
        <span style="font-size:14px">${activityEmoji(log.activity)}</span>
        <span style="font-weight:600;font-size:11px;color:#111827;flex:1">${isLive ? salesman.name : label}</span>
        ${badge}
      </div>
      ${isLive ? `<div style="color:#374151;font-size:11px;margin-bottom:2px">${label}</div>` : ""}
      ${road}${suburb}${city}
      <div style="color:#6b7280;font-size:10px;margin-top:4px">🕐 ${fmtTime(log.recorded_at)}</div>
      ${speed}${battery}${acc}${note}
      ${weatherBlock}
    </div>`;
}

export default function LeafletTrailMap({ trail, salesman, fallbackLat = 20.5937, fallbackLng = 78.9629, liveLocation, weather }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<ReturnType<typeof import("leaflet")["map"]> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    Promise.all([
      import("leaflet"),
      import("@maplibre/maplibre-gl-leaflet"),
    ]).then(([L]) => {
      delete (L.Icon.Default.prototype as never as Record<string, unknown>)._getIconUrl;
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
        iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
        shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
      });

      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }

      const hasTrail = trail.length > 0;
      const lats     = hasTrail ? trail.map((p) => p.latitude)  : [fallbackLat];
      const lngs     = hasTrail ? trail.map((p) => p.longitude) : [fallbackLng];
      const cLat     = (Math.min(...lats) + Math.max(...lats)) / 2;
      const cLng     = (Math.min(...lngs) + Math.max(...lngs)) / 2;

      const map = L.map(containerRef.current!, {
        center: [cLat, cLng],
        zoom: hasTrail ? 16 : 5,
        maxZoom: 16,
        zoomControl: true,
        attributionControl: true,
      });
      mapRef.current = map;

      addDetailedBaseLayers(L, map);

      if (!hasTrail) {
        if (liveLocation) {
          const liveIcon = L.divIcon({
            className: "",
            html: `<div style="position:relative;width:28px;height:28px">
              <div style="position:absolute;inset:0;border-radius:50%;background:rgba(234,88,12,0.25);animation:ping 1.4s cubic-bezier(0,0,0.2,1) infinite"></div>
              <div style="position:absolute;inset:4px;border-radius:50%;background:#ea580c;border:2.5px solid #fff;box-shadow:0 2px 8px rgba(234,88,12,0.5),0 0 0 1px rgba(234,88,12,0.2)"></div>
            </div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          });
          L.marker([liveLocation.latitude, liveLocation.longitude], { icon: liveIcon })
            .addTo(map)
            .bindPopup(buildPopupHtml(liveLocation, salesman, true, false, weather), { maxWidth: 260 })
            .openPopup();
          map.setView([liveLocation.latitude, liveLocation.longitude], 15);
        }
        return;
      }

      // Jitter filter — keep only points ≥ 15 m apart
      function haversineM(a: [number, number], b: [number, number]): number {
        const R = 6371000;
        const dLat = (b[0] - a[0]) * Math.PI / 180;
        const dLng = (b[1] - a[1]) * Math.PI / 180;
        const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
      }
      const rawLatLngs = trail.map((p) => [p.latitude, p.longitude] as [number, number]);
      const latLngs: [number, number][] = [rawLatLngs[0]];
      for (let i = 1; i < rawLatLngs.length; i++) {
        if (haversineM(latLngs[latLngs.length - 1], rawLatLngs[i]) >= 15) {
          latLngs.push(rawLatLngs[i]);
        }
      }

      // Trail — Google Maps-style blue route line
      L.polyline(latLngs, { color: "rgba(66,133,244,0.18)", weight: 14, smoothFactor: 3 }).addTo(map);
      L.polyline(latLngs, { color: "#4285F4", weight: 4, smoothFactor: 3 }).addTo(map);

      const keptSet = new Set(latLngs.map(([la, ln]) => `${la},${ln}`));

      // Mid-point dots
      trail.forEach((log, i) => {
        const isFirst = i === 0;
        const isLast  = i === trail.length - 1;
        if (isFirst || isLast) return;
        if (!keptSet.has(`${log.latitude},${log.longitude}`)) return;

        const isStop = log.activity === "stopped" || log.activity === "meeting";
        const dot = L.divIcon({
          className: "",
          html: `<div style="width:9px;height:9px;border-radius:50%;background:${isStop ? "#6366f1" : "#4285F4"};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.25)"></div>`,
          iconSize: [9, 9],
          iconAnchor: [4, 4],
        });
        L.marker([log.latitude, log.longitude], { icon: dot })
          .addTo(map)
          .bindPopup(buildPopupHtml(log, salesman), { maxWidth: 240 });
      });

      // Start marker — green pin
      const startIcon = L.divIcon({
        className: "",
        html: `<div style="width:24px;height:24px;border-radius:50%;background:#16a34a;border:3px solid #fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;box-shadow:0 2px 8px rgba(22,163,74,0.45),0 0 0 1px rgba(22,163,74,0.15)">S</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
      L.marker([trail[0].latitude, trail[0].longitude], { icon: startIcon })
        .addTo(map)
        .bindPopup(buildPopupHtml(trail[0], salesman, false, true), { maxWidth: 240 });

      // Live / End marker — pulsing orange
      const last = trail[trail.length - 1];
      const liveIcon = L.divIcon({
        className: "",
        html: `<div style="position:relative;width:28px;height:28px">
          <div style="position:absolute;inset:0;border-radius:50%;background:rgba(234,88,12,0.22);animation:ping 1.4s cubic-bezier(0,0,0.2,1) infinite"></div>
          <div style="position:absolute;inset:4px;border-radius:50%;background:#ea580c;border:2.5px solid #fff;box-shadow:0 2px 8px rgba(234,88,12,0.5),0 0 0 1px rgba(234,88,12,0.15)"></div>
        </div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      L.marker([last.latitude, last.longitude], { icon: liveIcon })
        .addTo(map)
        .bindPopup(buildPopupHtml(last, salesman, true, false, weather), { maxWidth: 260 })
        .openPopup();

      if (latLngs.length > 1) {
        map.fitBounds(L.latLngBounds(latLngs), { padding: [48, 48] });
      } else {
        map.setView(latLngs[0] ?? [fallbackLat, fallbackLng], 16);
      }
    });

    return () => {
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, [trail, salesman, fallbackLat, fallbackLng, liveLocation, weather]);

  return (
    <div className="relative isolate z-0 w-full overflow-hidden rounded-xl" style={{ height: 460 }}>
      <style>{`
        @import url("https://unpkg.com/leaflet@1.9.4/dist/leaflet.css");
        @keyframes ping {
          75%, 100% { transform: scale(2.2); opacity: 0; }
        }
        .leaflet-container { background: #f8f9fa !important; }
        .leaflet-popup-content-wrapper {
          background: #ffffff !important;
          border: 1px solid #e5e7eb !important;
          color: #111827 !important;
          border-radius: 10px !important;
          box-shadow: 0 4px 20px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.08) !important;
          font-family: system-ui, sans-serif !important;
          padding: 0 !important;
        }
        .leaflet-popup-content { margin: 10px 28px 10px 12px !important; }
        .leaflet-popup-tip-container { filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1)); }
        .leaflet-popup-tip { background: #ffffff !important; }
        .leaflet-popup-close-button {
          color: #9ca3af !important;
          font-size: 18px !important;
          line-height: 1 !important;
          top: 7px !important;
          right: 7px !important;
          width: 20px !important;
          height: 20px !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
        }
        .leaflet-popup-close-button:hover { color: #374151 !important; }
        .leaflet-control-zoom a {
          background: #ffffff !important;
          color: #374151 !important;
          border-color: #e5e7eb !important;
          font-weight: 400 !important;
        }
        .leaflet-control-zoom a:hover { background: #f9fafb !important; color: #111827 !important; }
        .leaflet-control-zoom { border: 1px solid #e5e7eb !important; border-radius: 8px !important; box-shadow: 0 1px 4px rgba(0,0,0,0.1) !important; overflow: hidden; }
        .leaflet-control-layers {
          border: 1px solid #e5e7eb !important;
          border-radius: 10px !important;
          box-shadow: 0 4px 18px rgba(0,0,0,0.12) !important;
          overflow: hidden;
        }
        .leaflet-control-layers-expanded {
          padding: 8px 10px !important;
          background: rgba(255,255,255,0.96) !important;
          color: #111827 !important;
          backdrop-filter: blur(8px);
        }
        .leaflet-control-layers label {
          margin: 3px 0 !important;
          font-size: 12px !important;
          font-weight: 650 !important;
        }
        .leaflet-control-attribution {
          background: rgba(255,255,255,0.85) !important;
          color: #9ca3af !important;
          font-size: 9px !important;
          backdrop-filter: blur(4px);
        }
        .leaflet-control-attribution a { color: #6b7280 !important; }
      `}</style>

      <div ref={containerRef} style={{ width: "100%", height: "100%", borderRadius: "0.75rem", overflow: "hidden" }} />

      {/* Legend */}
      <div className="absolute bottom-4 left-4 z-[1000] flex items-center gap-3 text-[0.65rem] text-gray-500 bg-white/90 backdrop-blur-sm px-3 py-1.5 rounded-lg border border-gray-200 shadow-sm pointer-events-none">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-green-600 inline-block" />Start</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-orange-600 inline-block" />Live</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-indigo-500 inline-block" />Stop/Visit</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-5 border-t-2 border-blue-500" />Trail</span>
      </div>

      {/* Name badge */}
      <div className="absolute top-4 left-4 z-[1000] text-xs text-gray-600 font-medium bg-white/90 backdrop-blur-sm px-3 py-1.5 rounded-lg border border-gray-200 shadow-sm pointer-events-none">
        {salesman.name} · {trail.length} pings
      </div>
    </div>
  );
}
