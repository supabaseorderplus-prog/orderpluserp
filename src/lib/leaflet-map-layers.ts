import type {} from "@maplibre/maplibre-gl-leaflet";

type LeafletModule = typeof import("leaflet");
type LeafletMap = ReturnType<LeafletModule["map"]>;

export function addDetailedBaseLayers(L: LeafletModule, map: LeafletMap) {
  // The Leaflet/MapLibre bridge augments Leaflet's CommonJS default object.
  // Next's dynamic import exposes that object under `default`, while the rest
  // of Leaflet's methods are also mirrored on the module namespace.
  const leafletWithMaplibre =
    (L as unknown as { default?: LeafletModule }).default ?? L;

  // Esri stops publishing usable raster tiles around zoom 18 in parts of rural
  // India. Keep its last reliable level as a fallback and let Leaflet upscale it
  // instead of requesting the grey "Map data not yet available" placeholder.
  const rasterFallback = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    {
      maxNativeZoom: 17,
      maxZoom: 16,
      attribution: "Tiles &copy; Esri",
    },
  );

  // OpenFreeMap renders OpenStreetMap vector data in the browser, so locality,
  // road and POI labels remain sharp and available at deep zoom levels.
  const vectorPane = map.createPane("vectorStreetPane");
  vectorPane.style.zIndex = "250";
  vectorPane.style.pointerEvents = "none";
  const vectorOptions = {
    style: "https://tiles.openfreemap.org/styles/liberty",
    interactive: false,
    maxZoom: 16,
    pane: "vectorStreetPane",
  };
  const vectorStreet = leafletWithMaplibre.maplibreGL(vectorOptions);
  const detailedStreet = L.layerGroup([rasterFallback, vectorStreet]).addTo(map);
  map.attributionControl?.addAttribution(
    '&copy; <a href="https://openfreemap.org/">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  );

  const satellite = L.layerGroup([
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        maxNativeZoom: 17,
        maxZoom: 16,
        attribution:
          "Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community",
      }
    ),
    L.tileLayer(
      "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
      {
        maxNativeZoom: 17,
        maxZoom: 16,
        attribution: "Transportation labels &copy; Esri",
      }
    ),
    L.tileLayer(
      "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      {
        maxNativeZoom: 17,
        maxZoom: 16,
        attribution: "Place labels &copy; Esri",
      }
    ),
  ]);

  const light = L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    {
      maxNativeZoom: 16,
      maxZoom: 16,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: "abcd",
    }
  );

  L.control
    .layers(
      {
        "Detailed streets & places": detailedStreet,
        "Satellite hybrid": satellite,
        "Light map": light,
      },
      undefined,
      {
        collapsed: true,
        position: "topright",
      }
    )
    .addTo(map);

  return { detailedStreet, vectorStreet, rasterFallback, satellite, light };
}
