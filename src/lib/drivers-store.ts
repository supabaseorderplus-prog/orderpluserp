export interface Driver {
  id: string;
  name: string;
  phone: string;
  vehicle_no: string;
  status: "ACTIVE" | "INACTIVE";
  created_at: string;
}

const KEY = "drivers_store_v1";

function canStore() {
  return typeof window !== "undefined" && !!window.localStorage;
}

function genId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return `drv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function loadDrivers(): Driver[] {
  if (!canStore()) return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveDrivers(drivers: Driver[]) {
  if (!canStore()) return;
  window.localStorage.setItem(KEY, JSON.stringify(drivers));
}

export function createDriver(input: { name: string; phone?: string; vehicle_no?: string }): Driver {
  const driver: Driver = {
    id: genId(),
    name: input.name.trim(),
    phone: input.phone?.trim() || "",
    vehicle_no: input.vehicle_no?.trim() || "",
    status: "ACTIVE",
    created_at: new Date().toISOString(),
  };
  saveDrivers([driver, ...loadDrivers()]);
  return driver;
}

export function updateDriver(id: string, updates: Partial<Omit<Driver, "id" | "created_at">>) {
  const drivers = loadDrivers().map((d) => (d.id === id ? { ...d, ...updates } : d));
  saveDrivers(drivers);
  return drivers;
}

export function deleteDriver(id: string) {
  const drivers = loadDrivers().filter((d) => d.id !== id);
  saveDrivers(drivers);
  return drivers;
}
