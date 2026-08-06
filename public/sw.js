/* Order Plus ERP PWA Service Worker — v4 */
const CACHE_NAME = 'order-plus-erp-v4';
const IDB_NAME   = 'order-plus-duty';
const IDB_STORE  = 'ping-queue';

// ─── Install / Activate ───────────────────────────────────────────────────────
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ─── Fetch: network-first, skip API + HMR ────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (
    request.method !== 'GET' ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/_next/') ||
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1'
  ) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          caches.open(CACHE_NAME).then((c) => c.put(request, res.clone()));
        }
        return res;
      })
      .catch(() => caches.match(request))
  );
});

// ─── IndexedDB helpers ────────────────────────────────────────────────────────
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE, { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function swQueuePing(ping) {
  try {
    const db = await openIDB();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).add(ping);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  } catch (_) {}
}

async function swDrainQueue(token, baseUrl) {
  try {
    const db = await openIDB();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const all = await new Promise((res, rej) => {
      const results = [];
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const c = e.target.result;
        if (c) { results.push({ key: c.key, value: c.value }); c.continue(); }
        else res(results);
      };
      req.onerror = () => rej(req.error);
    });
    db.close();

    for (const { key, value } of all) {
      try {
        const resp = await fetch(`${baseUrl}/api/v1/duty/location`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(value),
        });
        if (resp.ok) {
          const db2 = await openIDB();
          const tx2 = db2.transaction(IDB_STORE, 'readwrite');
          tx2.objectStore(IDB_STORE).delete(key);
          await new Promise((res) => { tx2.oncomplete = res; });
          db2.close();
        }
      } catch (_) { break; }
    }
  } catch (_) {}
}

// ─── Duty Location Tracking ───────────────────────────────────────────────────
let dutyToken   = null;
let dutyBaseUrl = null;
let dutyInterval = null;
let lastLat     = null;
let lastLng     = null;
let totalDistance = 0;

function haversineMetres(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function pingLocation() {
  if (!dutyToken || !dutyBaseUrl) return;
  try {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.length === 0) return;

    const client = clients[0];
    const coords = await new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => resolve(e.data);
      client.postMessage({ type: 'GET_LOCATION' }, [channel.port2]);
      setTimeout(() => resolve(null), 10000);
    });

    if (!coords || coords.latitude == null) return;

    const { latitude, longitude, accuracy, speed, heading } = coords;

    if (lastLat != null) {
      const dist = haversineMetres(lastLat, lastLng, latitude, longitude);
      if (dist > 20) {
        totalDistance += dist;
        lastLat = latitude;
        lastLng = longitude;
      }
    } else {
      lastLat = latitude;
      lastLng = longitude;
    }

    const ping = {
      latitude, longitude,
      accuracy: accuracy ?? null,
      speed: speed ?? null,
      heading: heading ?? null,
      total_distance_km: totalDistance / 1000,
      queued_at: new Date().toISOString(),
    };

    try {
      await fetch(`${dutyBaseUrl}/api/v1/duty/location`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${dutyToken}`,
        },
        body: JSON.stringify(ping),
      });
    } catch (_) {
      // Network unavailable — save to IndexedDB for later drain
      await swQueuePing(ping);
    }
  } catch (_) {}
}

self.addEventListener('message', (event) => {
  const { data } = event;
  if (!data || !data.type) return;

  if (data.type === 'DUTY_START') {
    dutyToken   = data.token;
    dutyBaseUrl = data.baseUrl || '';
    totalDistance = 0;
    lastLat = null;
    lastLng = null;

    if (dutyInterval) clearInterval(dutyInterval);
    pingLocation();
    dutyInterval = setInterval(pingLocation, 30000);

    // Drain any previously queued offline pings now that we have a token
    swDrainQueue(dutyToken, dutyBaseUrl);

    event.source?.postMessage({ type: 'DUTY_START_ACK' });
  }

  if (data.type === 'DUTY_END') {
    if (dutyInterval) {
      clearInterval(dutyInterval);
      dutyInterval = null;
    }
    pingLocation().then(() => {
      // Final drain before clearing token
      swDrainQueue(dutyToken, dutyBaseUrl).then(() => {
        dutyToken   = null;
        dutyBaseUrl = null;
      });
    });
    event.source?.postMessage({ type: 'DUTY_END_ACK', totalDistanceKm: totalDistance / 1000 });
  }

  if (data.type === 'DUTY_SYNC_DISTANCE') {
    totalDistance = (data.distanceKm || 0) * 1000;
    lastLat = data.lastLat ?? null;
    lastLng = data.lastLng ?? null;
  }
});
