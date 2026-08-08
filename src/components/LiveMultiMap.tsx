"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { addDetailedBaseLayers } from "@/lib/leaflet-map-layers";
import { getVisibleTrackingUsers } from "@/lib/tracking-map-visibility";

export interface UserMapPin {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  isActive: boolean;
  accuracy?: number;
  address?: string;
  place_name?: string;
  road?: string;
  suburb?: string;
  city?: string;
  recorded_at?: string;
}

export interface TrailPoint {
  latitude: number;
  longitude: number;
  recorded_at: string;
  activity?: string;
  speed?: number;
  accuracy?: number;
  address?: string;
  place_name?: string;
  road?: string;
  suburb?: string;
  city?: string;
  break_before?: boolean;
}

export interface RouteStopPin {
  id: string;
  partyId: string;
  name: string;
  code?: string | null;
  address?: string | null;
  latitude: number;
  longitude: number;
  order: number;
  visited: boolean;
}

interface Props {
  users: UserMapPin[];
  selectedUserId?: string | null;
  trail?: TrailPoint[];
  routeStops?: RouteStopPin[];
  routeStopTotal?: number;
  onUserClick?: (userId: string) => void;
}

type LocationLike = {
  latitude: number;
  longitude: number;
  accuracy?: number;
  address?: string;
  place_name?: string;
  road?: string;
  suburb?: string;
  city?: string;
  recorded_at?: string;
};

type NearbyPlace = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  kind: string;
};

type OverpassPlaceElement = {
  id: number;
  type: string;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: { name?: string; place?: string };
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function fmtTime(iso?: string) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function googleMapsUrl(location: LocationLike) {
  return `https://www.google.com/maps/search/?api=1&query=${location.latitude},${location.longitude}`;
}

function hasHumanPlaceLabel(location: LocationLike) {
  return Boolean(
    location.place_name ||
      location.address ||
      location.road ||
      location.suburb ||
      location.city
  );
}

function buildLocationLabel(location: LocationLike) {
  const placeParts = [location.road, location.suburb, location.city].filter(Boolean);
  return (
    location.place_name ||
    location.address ||
    (placeParts.length > 0 ? placeParts.join(", ") : "") ||
    `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`
  );
}

function haversineM(a: LocationLike, b: LocationLike) {
  const R = 6371000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function compactTrailPoints(points: TrailPoint[]) {
  const compact: TrailPoint[] = [];
  points.forEach((point) => {
    if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) return;
    const last = compact[compact.length - 1];
    if (!last || point.break_before || haversineM(last, point) >= 12) compact.push(point);
  });
  return compact;
}

type LatLng = [number, number];

// Compass bearing (deg, 0 = north) from point a to point b — used for arrows.
function bearingDeg(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const dLng = toRad(b[1] - a[1]);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function buildUserPopup(user: UserMapPin) {
  const label = buildLocationLabel(user);
  const time = fmtTime(user.recorded_at);
  const accuracy = user.accuracy ? `<div style="color:#6b7280;font-size:11px">Accuracy: +/- ${Math.round(user.accuracy)}m</div>` : "";
  const lastSeen = time ? `<div style="color:#6b7280;font-size:11px">Last ping: ${escapeHtml(time)}</div>` : "";

  return `
    <div style="font-family:system-ui,sans-serif;min-width:210px;max-width:280px">
      <div style="font-weight:750;font-size:13px;color:#111827;margin-bottom:4px">${escapeHtml(user.name)}</div>
      <div style="font-size:12px;color:#374151;line-height:1.4;margin-bottom:6px">${escapeHtml(label)}</div>
      <div style="font-size:11px;color:#6b7280">${user.latitude.toFixed(6)}, ${user.longitude.toFixed(6)}</div>
      ${accuracy}
      ${lastSeen}
      <a href="${googleMapsUrl(user)}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;margin-top:8px;color:#2563eb;font-size:12px;font-weight:700;text-decoration:none">Open in Google Maps</a>
    </div>
  `;
}

export default function LiveMultiMap({
  users,
  selectedUserId,
  trail = [],
  routeStops = [],
  routeStopTotal = routeStops.length,
  onUserClick,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<ReturnType<typeof import("leaflet")["map"]> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markersRef = useRef<Record<string, any[]>>({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trailLayerRef = useRef<any>(null);
  // Route line/arrows live in their own group + dedicated SVG renderer so the
  // path is always painted reliably above the tiles.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routeLineGroupRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routeRendererRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routeStopsLayerRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nearbyPlacesLayerRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const LRef = useRef<any>(null);
  const trailSigRef = useRef<string>("");
  const fittedKeyRef = useRef<string>("");
  const fittedStopsKeyRef = useRef<string>("");
  const onUserClickRef = useRef(onUserClick);
  onUserClickRef.current = onUserClick;

  const [mapReady, setMapReady] = useState(false);
  const [reverseLabels, setReverseLabels] = useState<Record<string, string>>({});
  const [reverseLoadingKey, setReverseLoadingKey] = useState<string | null>(null);
  const [nearbyPlaces, setNearbyPlaces] = useState<NearbyPlace[]>([]);

  const visibleUsers = useMemo(
    () => getVisibleTrackingUsers(users, selectedUserId),
    [users, selectedUserId]
  );

  const focusLocation = useMemo<LocationLike | null>(() => {
    if (selectedUserId) {
      const selectedUser = visibleUsers[0];
      if (selectedUser) return selectedUser;
    }
    const latestTrailPoint = trail[trail.length - 1];
    const activeUser = visibleUsers.find((user) => user.isActive) ?? visibleUsers[0];
    return latestTrailPoint ?? activeUser ?? null;
  }, [selectedUserId, trail, visibleUsers]);

  const focusKey = focusLocation
    ? `${focusLocation.latitude.toFixed(5)},${focusLocation.longitude.toFixed(5)}`
    : null;
  const focusLabel =
    (focusKey ? reverseLabels[focusKey] : "") ||
    (focusLocation ? buildLocationLabel(focusLocation) : "");

  // Initialize map once on mount
  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    Promise.all([
      import("leaflet"),
      import("@maplibre/maplibre-gl-leaflet"),
    ]).then(([L]) => {
      if (cancelled || !containerRef.current) return;

      delete (L.Icon.Default.prototype as never as Record<string, unknown>)._getIconUrl;

      const map = L.map(containerRef.current!, {
        center: [23.5, 87.5],
        zoom: 8,
        maxZoom: 16,
        zoomControl: true,
        attributionControl: true,
        preferCanvas: true,
      });
      mapRef.current = map;
      LRef.current = L;

      addDetailedBaseLayers(L, map);

      trailLayerRef.current = L.layerGroup().addTo(map);
      routeRendererRef.current = L.svg({ padding: 0.5 }).addTo(map);
      routeLineGroupRef.current = L.layerGroup().addTo(map);
      routeStopsLayerRef.current = L.layerGroup().addTo(map);
      nearbyPlacesLayerRef.current = L.layerGroup().addTo(map);
      setTimeout(() => map.invalidateSize(), 0);

      setMapReady(true);
    });

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      LRef.current = null;
      trailLayerRef.current = null;
      routeLineGroupRef.current = null;
      routeRendererRef.current = null;
      routeStopsLayerRef.current = null;
      nearbyPlacesLayerRef.current = null;
      markersRef.current = {};
    };
  }, []);

  useEffect(() => {
    if (!focusLocation || !focusKey) return;
    if (hasHumanPlaceLabel(focusLocation) || reverseLabels[focusKey]) return;

    const controller = new AbortController();
    setReverseLoadingKey(focusKey);

    fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${focusLocation.latitude}&lon=${focusLocation.longitude}&zoom=18&addressdetails=1&accept-language=en-IN`,
      {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      }
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { display_name?: string } | null) => {
        if (!data?.display_name) return;
        setReverseLabels((prev) => ({ ...prev, [focusKey]: data.display_name! }));
      })
      .catch(() => {
        // Keep coordinates visible if reverse geocoding is unavailable.
      })
      .finally(() => {
        if (!controller.signal.aborted) setReverseLoadingKey(null);
      });

    return () => controller.abort();
  }, [focusKey, focusLocation, reverseLabels]);

  // OpenFreeMap contains the OSM place data, but its base style intentionally
  // hides many village labels at close zoom. Fetch those named places once for
  // the current area and render them in our own responsive overlay.
  const nearbyAreaKey = focusLocation
    ? `${focusLocation.latitude.toFixed(2)},${focusLocation.longitude.toFixed(2)}`
    : null;

  useEffect(() => {
    if (!nearbyAreaKey) {
      setNearbyPlaces([]);
      return;
    }

    const [areaLatitude, areaLongitude] = nearbyAreaKey.split(",").map(Number);
    if (!Number.isFinite(areaLatitude) || !Number.isFinite(areaLongitude)) return;
    const areaCenter = { latitude: areaLatitude, longitude: areaLongitude };

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 18000);
    const url = `/api/v1/tracking/nearby-places?lat=${areaLatitude}&lon=${areaLongitude}`;

    fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { success?: boolean; elements?: OverpassPlaceElement[] } | null) => {
        if (!data?.success) return;
        const seen = new Set<string>();
        const places = (data?.elements || []).flatMap<NearbyPlace>((element) => {
          const latitude = element.lat ?? element.center?.lat;
          const longitude = element.lon ?? element.center?.lon;
          const name = element.tags?.name?.trim();
          if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
          const key = `${name.toLowerCase()}:${Number(latitude).toFixed(4)},${Number(longitude).toFixed(4)}`;
          if (seen.has(key)) return [];
          seen.add(key);
          return [{
            id: `${element.type}-${element.id}`,
            name,
            latitude: Number(latitude),
            longitude: Number(longitude),
            kind: element.tags?.place || "locality",
          }];
        });
        places.sort((a, b) => haversineM(areaCenter, a) - haversineM(areaCenter, b));
        setNearbyPlaces(places);
      })
      .catch(() => {
        // The vector basemap and exact reverse-geocoded location remain usable.
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [nearbyAreaKey]);

  useEffect(() => {
    if (!mapReady) return;
    const L = LRef.current;
    const map = mapRef.current;
    const layer = nearbyPlacesLayerRef.current;
    if (!L || !map || !layer) return;

    const renderPlaceLabels = () => {
      layer.clearLayers();
      const zoom = map.getZoom();
      const bounds = map.getBounds().pad(0.12);
      const limit = zoom >= 15 ? 26 : zoom >= 13 ? 34 : 42;
      const visible = nearbyPlaces
        .filter((place) => bounds.contains([place.latitude, place.longitude]))
        .filter((place) => zoom >= 12 || ["city", "town"].includes(place.kind))
        .slice(0, limit);

      visible.forEach((place) => {
        const major = ["city", "town"].includes(place.kind);
        const icon = L.divIcon({
          className: "",
          html: `<div class="lmm-map-place-label${major ? " lmm-map-place-major" : ""}"><span></span>${escapeHtml(place.name)}</div>`,
          iconSize: [1, 1],
          iconAnchor: [0, 0],
        });
        L.marker([place.latitude, place.longitude], {
          icon,
          interactive: false,
          keyboard: false,
          zIndexOffset: major ? 260 : 220,
        }).addTo(layer);
      });
    };

    renderPlaceLabels();
    map.on("zoomend moveend", renderPlaceLabels);
    return () => {
      map.off("zoomend moveend", renderPlaceLabels);
      layer.clearLayers();
    };
  }, [mapReady, nearbyPlaces]);

  // Update user markers when users or selectedUserId changes
  useEffect(() => {
    if (!mapReady) return;
    const L = LRef.current;
    const map = mapRef.current;
    if (!L || !map) return;

    // Remove all existing markers and accuracy rings
    Object.values(markersRef.current)
      .flat()
      .forEach((layer) => map.removeLayer(layer));
    markersRef.current = {};

    visibleUsers.forEach((user) => {
      const initials = user.name
        .split(" ")
        .map((n: string) => n[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
      const isSelected = user.id === selectedUserId;

      const bg = isSelected ? "#dc2626" : user.isActive ? "#1e40af" : "#6b7280";
      const pulse = isSelected
        ? `<div style="position:absolute;inset:0;border-radius:50%;background:rgba(220,38,38,0.35);animation:lmmPing 1.4s cubic-bezier(0,0,0.2,1) infinite"></div>`
        : user.isActive
        ? `<div style="position:absolute;inset:0;border-radius:50%;background:rgba(30,64,175,0.25);animation:lmmPing 2s cubic-bezier(0,0,0.2,1) infinite"></div>`
        : "";

      const icon = L.divIcon({
        className: "",
        html: `<div style="position:relative;width:38px;height:38px">
          ${pulse}
          <div style="position:absolute;inset:0;border-radius:50%;background:${bg};display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;border:2.5px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,0.3);cursor:pointer">
            ${escapeHtml(initials)}
          </div>
        </div>`,
        iconSize: [38, 38],
        iconAnchor: [19, 19],
      });

      const marker = L.marker([user.latitude, user.longitude], {
        icon,
        zIndexOffset: isSelected ? 1000 : user.isActive ? 500 : 0,
      })
        .addTo(map)
        .bindPopup(buildUserPopup(user), { maxWidth: 300 })
        .on("click", () => {
          marker.openPopup();
          onUserClickRef.current?.(user.id);
        });

      const userLocationKey = `${user.latitude.toFixed(5)},${user.longitude.toFixed(5)}`;
      const resolvedPlace = reverseLabels[userLocationKey] || buildLocationLabel(user);
      const compactPlace = hasHumanPlaceLabel(user) || Boolean(reverseLabels[userLocationKey])
        ? resolvedPlace.split(",")[0]?.trim()
        : "";
      const showPlaceOnMap = user.isActive && Boolean(compactPlace);
      marker.bindTooltip(
        showPlaceOnMap
          ? `${escapeHtml(user.name)} · ${escapeHtml(compactPlace)}`
          : escapeHtml(user.name),
        {
          permanent: showPlaceOnMap,
          direction: showPlaceOnMap ? "right" : "top",
          offset: showPlaceOnMap ? [22, 0] : [0, -22],
          className: showPlaceOnMap
            ? "lmm-tooltip lmm-active-place-tooltip"
            : "lmm-tooltip",
        },
      );

      const layers = [marker];
      if (isSelected && user.accuracy && user.accuracy > 0) {
        layers.push(
          L.circle([user.latitude, user.longitude], {
            radius: user.accuracy,
            color: "#2563eb",
            weight: 1,
            fillColor: "#2563eb",
            fillOpacity: 0.08,
          }).addTo(map)
        );
      }

      markersRef.current[user.id] = layers;
    });

    // Fit map to show all markers (only when nothing is selected)
    if (!selectedUserId && visibleUsers.length > 0) {
      const bounds = LRef.current.latLngBounds(
        visibleUsers.map((u) => [u.latitude, u.longitude] as [number, number])
      );
      try {
        map.fitBounds(bounds, { padding: [60, 60], maxZoom: 14 });
      } catch {
        // ignore invalid bounds
      }
    }
  }, [mapReady, visibleUsers, selectedUserId, reverseLabels]);

  // Today's locked route is represented by party pins only. No planned line is
  // drawn: the blue trail appears solely where verified movement was recorded.
  useEffect(() => {
    if (!mapReady) return;
    const L = LRef.current;
    const map = mapRef.current;
    const layer = routeStopsLayerRef.current;
    if (!L || !map || !layer) return;
    layer.clearLayers();
    const nextStopOrder = routeStops
      .filter((stop) => !stop.visited)
      .reduce<number | null>((lowest, stop) => lowest === null || stop.order < lowest ? stop.order : lowest, null);

    routeStops.forEach((stop) => {
      const isNext = stop.order === nextStopOrder;
      const color = stop.visited ? "#16a34a" : isNext ? "#2563eb" : "#f59e0b";
      const size = isNext ? 34 : 27;
      const statusLabel = stop.visited
        ? "Visit completed"
        : isNext
          ? "Next planned stop"
          : "Planned for today";
      const icon = L.divIcon({
        className: "",
        html: `<div style="width:${size}px;height:${size}px;border-radius:${isNext ? 11 : 8}px;background:${color};border:2px solid white;display:flex;align-items:center;justify-content:center;color:white;font-size:11px;font-weight:800;box-shadow:0 3px 12px rgba(0,0,0,.22)">${stop.visited ? "✓" : stop.order}</div>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });
      const safeName = escapeHtml(stop.name);
      const safeAddress = stop.address ? escapeHtml(stop.address) : "No saved street address";
      const safeCode = stop.code ? escapeHtml(stop.code) : "Not assigned";
      const navigationUrl = googleMapsUrl({
        latitude: stop.latitude,
        longitude: stop.longitude,
      });
      const popupContent = `
        <div class="lmm-stop-details" style="--stop-color:${color}">
          <div class="lmm-stop-details__eyebrow">Route stop ${stop.order}</div>
          <div class="lmm-stop-details__title">${safeName}</div>
          <div class="lmm-stop-details__status">${escapeHtml(statusLabel)}</div>
          <div class="lmm-stop-details__grid">
            <div><span>Party code</span><strong>${safeCode}</strong></div>
            <div><span>Stop number</span><strong>#${stop.order}</strong></div>
          </div>
          <div class="lmm-stop-details__address"><span>Address</span><strong>${safeAddress}</strong></div>
          <div class="lmm-stop-details__coordinates">${stop.latitude.toFixed(6)}, ${stop.longitude.toFixed(6)}</div>
          <a class="lmm-stop-details__navigate" href="${navigationUrl}" target="_blank" rel="noopener noreferrer">Open directions ↗</a>
        </div>`;
      const marker = L.marker([stop.latitude, stop.longitude], {
        icon,
        zIndexOffset: isNext ? 600 : 350,
        keyboard: true,
        riseOnHover: true,
        riseOffset: 700,
        title: `Stop ${stop.order}: ${stop.name}`,
        alt: `Stop ${stop.order}: ${stop.name}`,
      })
        .addTo(layer)
        .bindTooltip(`${isNext ? "Next · " : `${stop.order}. `}${escapeHtml(stop.name)}`, {
          permanent: isNext,
          direction: isNext ? "left" : "right",
          offset: [isNext ? -(size / 2) : size / 2, 0],
          className: isNext ? "lmm-party-tooltip lmm-next-party-tooltip" : "lmm-party-tooltip",
        });

      marker.on("click keypress", () => {
        L.popup({
          className: "lmm-stop-popup",
          closeButton: true,
          autoClose: true,
          closeOnClick: true,
          autoPan: true,
          autoPanPadding: [48, 48],
          maxWidth: 310,
          minWidth: 260,
          offset: [0, -(size / 2 + 6)],
        })
          .setLatLng([stop.latitude, stop.longitude])
          .setContent(popupContent)
          .openOn(map);
      });
    });
  }, [mapReady, routeStops]);

  // Route stops arrive after the live position on a separate request. Frame
  // them once when that request completes, otherwise the first render can stay
  // centred on the user while every planned party remains off-screen.
  useEffect(() => {
    if (!mapReady || !selectedUserId || routeStops.length === 0) return;
    const L = LRef.current;
    const map = mapRef.current;
    const user = visibleUsers[0];
    if (!L || !map || !user) return;

    const stopsKey = `${selectedUserId}:${routeStops
      .map((stop) => `${stop.id}:${stop.latitude.toFixed(5)},${stop.longitude.toFixed(5)}`)
      .join("|")}`;
    if (fittedStopsKeyRef.current === stopsKey) return;
    fittedStopsKeyRef.current = stopsKey;

    try {
      const points: LatLng[] = [
        [user.latitude, user.longitude],
        ...routeStops.map((stop) => [stop.latitude, stop.longitude] as LatLng),
      ];
      map.fitBounds(L.latLngBounds(points), { padding: [70, 70], maxZoom: 16 });
    } catch {
      // Ignore a malformed coordinate; the current-position marker remains usable.
    }
  }, [mapReady, routeStops, selectedUserId, visibleUsers]);

  // Fly to selected user location (no trail yet)
  useEffect(() => {
    if (!mapReady || !selectedUserId || trail.length > 0) return;
    const map = mapRef.current;
    if (!map) return;
    const user = visibleUsers[0];
    if (user) {
      const points: LatLng[] = [[user.latitude, user.longitude], ...routeStops.map((stop) => [stop.latitude, stop.longitude] as LatLng)];
      if (points.length > 1) map.fitBounds(LRef.current.latLngBounds(points), { padding: [70, 70], maxZoom: 16 });
      else map.flyTo([user.latitude, user.longitude], 17, { duration: 0.7 });
    }
  }, [mapReady, selectedUserId, trail.length, visibleUsers, routeStops]);

  // Update the travelled route (start -> path -> current) when the trail changes
  useEffect(() => {
    if (!mapReady) return;
    const L = LRef.current;
    const tl = trailLayerRef.current;
    const lineGroup = routeLineGroupRef.current;
    const renderer = routeRendererRef.current;
    const map = mapRef.current;
    if (!L || !tl || !lineGroup || !map) return;

    if (trail.length === 0) {
      tl.clearLayers();
      lineGroup.clearLayers();
      trailSigRef.current = "";
      fittedKeyRef.current = "";
      return;
    }

    const compactTrail = compactTrailPoints(trail);
    if (compactTrail.length === 0) return;

    const rawLatLngs: LatLng[] = compactTrail.map((p) => [p.latitude, p.longitude]);
    const segments: LatLng[][] = [];
    compactTrail.forEach((point) => {
      if (segments.length === 0 || point.break_before) segments.push([]);
      segments[segments.length - 1].push([point.latitude, point.longitude]);
    });
    const first = compactTrail[0];
    const last = compactTrail[compactTrail.length - 1];

    // Only redraw when the route actually changed — the parent hands us a new
    // array reference on every poll/MQTT tick, so this prevents needless redraws
    // and keeps us from hammering the OSRM road-snapping service.
    const sig = [
      selectedUserId ?? "",
      compactTrail.length,
      `${first.latitude},${first.longitude}`,
      `${last.latitude},${last.longitude}`,
      last.recorded_at ?? "",
    ].join("|");
    if (sig === trailSigRef.current) return;
    trailSigRef.current = sig;

    tl.clearLayers();
    lineGroup.clearLayers();

    const startIcon = L.divIcon({
      className: "",
      html: `<div style="width:24px;height:24px;border-radius:50%;background:#16a34a;border:3px solid #fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#fff;box-shadow:0 2px 8px rgba(22,163,74,0.45)">S</div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });

    // Single recorded point — only the start matters, no path to draw.
    if (rawLatLngs.length === 1) {
      L.marker(rawLatLngs[0], { icon: startIcon })
        .addTo(tl)
        .bindTooltip("Start", { direction: "top", offset: [0, -14], className: "lmm-tooltip" });
      if (last.accuracy && last.accuracy > 0) {
        L.circle(rawLatLngs[0], {
          renderer,
          radius: last.accuracy,
          color: "#2563eb", weight: 1, fillColor: "#2563eb", fillOpacity: 0.08,
        }).addTo(tl);
      }
      if (selectedUserId && fittedKeyRef.current !== selectedUserId) {
        fittedKeyRef.current = selectedUserId;
        const framePoints = [...rawLatLngs, ...routeStops.map((stop) => [stop.latitude, stop.longitude] as LatLng)];
        if (framePoints.length > 1) map.fitBounds(L.latLngBounds(framePoints), { padding: [70, 70], maxZoom: 16 });
        else map.setView(rawLatLngs[0], 16);
      }
      return;
    }

    // Accuracy ring at the latest position
    if (last.accuracy && last.accuracy > 0) {
      L.circle(rawLatLngs[rawLatLngs.length - 1], {
        renderer,
        radius: last.accuracy,
        color: "#2563eb", weight: 1, fillColor: "#2563eb", fillOpacity: 0.08,
      }).addTo(tl);
    }

    // Paints the glow/line/flow + direction arrows for a given geometry.
    const drawRoute = (geometries: LatLng[][]) => {
      lineGroup.clearLayers();
      geometries.filter((geometry) => geometry.length > 1).forEach((geometry) => {
        L.polyline(geometry, { renderer, color: "#2563eb", weight: 11, opacity: 0.18, lineCap: "round", lineJoin: "round", smoothFactor: 1 }).addTo(lineGroup);
        L.polyline(geometry, { renderer, color: "#2563eb", weight: 5, opacity: 0.95, lineCap: "round", lineJoin: "round", smoothFactor: 1 }).addTo(lineGroup);
        L.polyline(geometry, { renderer, color: "#ffffff", weight: 2.5, opacity: 0.9, dashArray: "1 14", lineCap: "round", className: "lmm-route-flow" }).addTo(lineGroup);
        const arrowCount = Math.min(5, Math.max(1, Math.floor(geometry.length / 8)));
        for (let k = 1; k <= arrowCount; k++) {
          const idx = Math.floor((geometry.length - 1) * (k / (arrowCount + 1)));
          const a = geometry[idx];
          const b = geometry[Math.min(idx + 1, geometry.length - 1)];
          if (!a || !b) continue;
          const ang = bearingDeg(a, b);
          const arrowIcon = L.divIcon({ className: "", html: `<div style="transform:rotate(${ang}deg);width:16px;height:16px;display:flex;align-items:center;justify-content:center"><svg width="13" height="13" viewBox="0 0 24 24"><path d="M12 3 L19 20 L12 15.5 L5 20 Z" fill="#1d4ed8" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
          L.marker(a, { icon: arrowIcon, interactive: false, keyboard: false }).addTo(lineGroup);
        }
      });
    };

    // Draw the raw GPS path immediately so the route is always visible, then
    // upgrade it to a road-snapped line once OSRM responds.
    drawRoute(segments);

    L.marker(rawLatLngs[0], { icon: startIcon })
      .addTo(tl)
      .bindTooltip("Start", { direction: "top", offset: [0, -14], className: "lmm-tooltip" });

    // Auto-frame the whole route only when this user is first opened — never
    // yank the admin's view on subsequent live updates.
    if (selectedUserId && fittedKeyRef.current !== selectedUserId) {
      fittedKeyRef.current = selectedUserId;
      try {
        const framePoints = [...rawLatLngs, ...routeStops.map((stop) => [stop.latitude, stop.longitude] as LatLng)];
        map.fitBounds(L.latLngBounds(framePoints), { padding: [70, 70], maxZoom: 17 });
      } catch {
        // ignore invalid bounds
      }
    }

  }, [mapReady, trail, selectedUserId, routeStops]);

  return (
    <div className="relative w-full h-full">
      <style>{`
        @import url("https://unpkg.com/leaflet@1.9.4/dist/leaflet.css");
        @keyframes lmmPing {
          75%, 100% { transform: scale(2.1); opacity: 0; }
        }
        @keyframes lmmRouteFlow {
          to { stroke-dashoffset: -150; }
        }
        path.lmm-route-flow {
          stroke-dasharray: 1 14;
          animation: lmmRouteFlow 3s linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          path.lmm-route-flow { animation: none; }
        }
        .leaflet-container { background: #f8f9fa !important; }
        .lmm-tooltip {
          background: #1e293b !important;
          color: #f8fafc !important;
          border: none !important;
          border-radius: 6px !important;
          font-size: 11px !important;
          font-weight: 600 !important;
          padding: 3px 8px !important;
          box-shadow: 0 2px 8px rgba(0,0,0,0.3) !important;
          white-space: nowrap !important;
        }
        .lmm-tooltip::before { border-top-color: #1e293b !important; }
        .lmm-active-place-tooltip::before {
          border-top-color: transparent !important;
          border-right-color: #1e293b !important;
        }
        .lmm-map-place-label {
          align-items: center;
          color: #334155;
          display: inline-flex;
          font-size: 10px;
          font-weight: 650;
          gap: 4px;
          line-height: 1;
          pointer-events: none;
          text-shadow: -1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 0 4px #fff;
          white-space: nowrap;
        }
        .lmm-map-place-label span {
          background: #64748b;
          border: 1.5px solid #fff;
          border-radius: 999px;
          box-shadow: 0 1px 3px rgba(15,23,42,.2);
          height: 6px;
          width: 6px;
        }
        .lmm-stop-popup .leaflet-popup-content-wrapper {
          border-radius: 18px;
          border: 1px solid rgba(15, 23, 42, 0.1);
          box-shadow: 0 18px 45px rgba(15, 23, 42, 0.22);
          overflow: hidden;
        }
        .lmm-stop-popup .leaflet-popup-content {
          margin: 0;
          width: auto !important;
        }
        .lmm-stop-popup .leaflet-popup-close-button {
          width: 32px;
          height: 32px;
          top: 7px;
          right: 7px;
          border-radius: 50%;
          color: #64748b;
          font-size: 21px;
          line-height: 30px;
          z-index: 2;
        }
        .lmm-stop-details {
          padding: 18px;
          color: #0f172a;
          font-family: ui-sans-serif, system-ui, sans-serif;
        }
        .lmm-stop-details__eyebrow {
          padding-right: 28px;
          color: var(--stop-color);
          font-size: 10px;
          font-weight: 850;
          letter-spacing: .12em;
          text-transform: uppercase;
        }
        .lmm-stop-details__title {
          margin-top: 5px;
          padding-right: 24px;
          font-size: 16px;
          font-weight: 850;
          line-height: 1.25;
        }
        .lmm-stop-details__status {
          display: inline-flex;
          margin-top: 9px;
          padding: 5px 9px;
          border-radius: 999px;
          background: color-mix(in srgb, var(--stop-color) 10%, white);
          color: var(--stop-color);
          font-size: 10px;
          font-weight: 800;
        }
        .lmm-stop-details__grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
          margin-top: 13px;
        }
        .lmm-stop-details__grid > div,
        .lmm-stop-details__address {
          padding: 9px 10px;
          border-radius: 10px;
          background: #f8fafc;
        }
        .lmm-stop-details__address {
          margin-top: 8px;
        }
        .lmm-stop-details span {
          display: block;
          color: #94a3b8;
          font-size: 9px;
          font-weight: 750;
          letter-spacing: .04em;
          text-transform: uppercase;
        }
        .lmm-stop-details strong {
          display: block;
          margin-top: 3px;
          color: #334155;
          font-size: 11px;
          font-weight: 750;
          line-height: 1.35;
        }
        .lmm-stop-details__coordinates {
          margin-top: 10px;
          color: #94a3b8;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 9px;
        }
        .lmm-stop-details__navigate {
          display: flex;
          align-items: center;
          justify-content: center;
          margin-top: 12px;
          padding: 10px 12px;
          border-radius: 10px;
          background: var(--stop-color);
          color: white !important;
          font-size: 11px;
          font-weight: 800;
          text-decoration: none !important;
        }
        .lmm-map-place-major {
          color: #0f172a;
          font-size: 11px;
          font-weight: 800;
        }
        .lmm-map-place-major span { background: #2563eb; height: 7px; width: 7px; }
        .lmm-party-tooltip {
          background: rgba(255,255,255,.96) !important;
          color: #111827 !important;
          border: 1px solid rgba(15,23,42,.12) !important;
          border-radius: 7px !important;
          box-shadow: 0 2px 8px rgba(15,23,42,.12) !important;
          padding: 3px 7px !important;
          font-size: 10px !important;
          font-weight: 750 !important;
        }
        .lmm-next-party-tooltip {
          border-color: rgba(37,99,235,.25) !important;
          color: #1d4ed8 !important;
          box-shadow: 0 4px 14px rgba(37,99,235,.16) !important;
          font-size: 11px !important;
          padding: 5px 9px !important;
        }
        .leaflet-popup-content-wrapper {
          background: #fff !important;
          border: 1px solid #e5e7eb !important;
          color: #111827 !important;
          border-radius: 10px !important;
          box-shadow: 0 4px 20px rgba(0,0,0,0.12) !important;
          padding: 0 !important;
        }
        .leaflet-popup-content { margin: 10px 28px 10px 12px !important; }
        .leaflet-popup-tip { background: #fff !important; }
        .leaflet-popup-close-button {
          color: #9ca3af !important;
          font-size: 18px !important;
          top: 7px !important;
          right: 7px !important;
        }
        .leaflet-control-zoom a {
          background: #fff !important;
          color: #374151 !important;
          border-color: #e5e7eb !important;
        }
        .leaflet-control-zoom a:hover { background: #f9fafb !important; }
        .leaflet-control-zoom {
          border: 1px solid #e5e7eb !important;
          border-radius: 8px !important;
          box-shadow: 0 1px 4px rgba(0,0,0,0.1) !important;
          overflow: hidden;
        }
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
      `}</style>
      {selectedUserId && routeStopTotal > 0 && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-[1000] -translate-x-1/2 rounded-xl border border-black/10 bg-white/95 px-3 py-2 shadow-lg shadow-black/10 backdrop-blur">
          <div className="flex items-center justify-center gap-3 text-[0.62rem] font-bold text-zinc-700">
            <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px] bg-emerald-600" />Visited</span>
            <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px] bg-blue-600" />Next</span>
            <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px] bg-amber-500" />Pending</span>
          </div>
          <div className="mt-1 text-center text-[0.58rem] font-semibold text-zinc-500">
            {routeStops.length}/{routeStopTotal} party locations mapped
            {routeStopTotal > routeStops.length
              ? ` · ${routeStopTotal - routeStops.length} missing GPS coordinates`
              : ""}
          </div>
        </div>
      )}
      {focusLocation && (
        <div className="absolute bottom-3 left-3 z-[1000] w-[min(330px,calc(100%-1.5rem))] rounded-xl border border-black/10 bg-white/95 p-2.5 text-zinc-900 shadow-lg shadow-black/10 backdrop-blur">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <div className="text-[0.58rem] font-bold uppercase tracking-[0.12em] text-blue-600">Exact location</div>
            {focusLocation.accuracy ? <div className="rounded-full bg-emerald-50 px-2 py-0.5 text-[0.55rem] font-bold text-emerald-700">±{Math.round(focusLocation.accuracy)}m accurate</div> : null}
          </div>
          <div className="line-clamp-2 text-xs font-semibold leading-snug">
            {reverseLoadingKey === focusKey && !hasHumanPlaceLabel(focusLocation)
              ? "Finding nearest place..."
              : focusLabel}
          </div>
          <div className="mt-2 flex items-center justify-between gap-3">
            <div className="truncate font-mono text-[0.58rem] text-zinc-500">
              {focusLocation.latitude.toFixed(6)}, {focusLocation.longitude.toFixed(6)}
            </div>
            <a
              href={googleMapsUrl(focusLocation)}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 text-[0.62rem] font-bold text-blue-600 hover:text-blue-700"
            >
              Google Maps ↗
            </a>
          </div>
        </div>
      )}
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}
