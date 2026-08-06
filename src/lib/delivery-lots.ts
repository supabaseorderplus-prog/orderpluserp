import { api } from "@/lib/api";
import { announceLotsChanged } from "@/lib/hooks/use-lots-realtime";

export type DeliveryLotStatus = "OPEN" | "READY" | "DISPATCHED" | "DELIVERED";

export interface OrderMeta {
  invoice_number: string;
  party_name: string;
  grand_total: number;
}

export interface DeliveryLot {
  id: string;
  lot_number: string;
  name: string;
  dispatch_date: string;
  destination: string;
  vehicle_no: string;
  notes: string;
  status: DeliveryLotStatus;
  order_ids: string[];
  order_meta: Record<string, OrderMeta>;
  driver_id: string;
  driver_name: string;
  created_at: string;
  updated_at: string;
  manufacturing_statuses?: Record<string, string>;
}

function normalizeError(err: unknown, fallback: string): Error {
  if (err instanceof Error) return err;
  if (typeof err === "object" && err !== null && "message" in err) {
    return new Error(String((err as { message?: string }).message || fallback));
  }
  return new Error(fallback);
}

function isDeliveryLotsSchemaError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("public.delivery_lots") || lower.includes("schema cache") || lower.includes("delivery_lots table is missing");
}

let repairInFlight: Promise<void> | null = null;

async function ensureDeliveryLotsReady(): Promise<void> {
  if (repairInFlight) return repairInFlight;
  repairInFlight = (async () => {
    await api<{ success: boolean; message?: string }>("/api/v1/execute-migration", {
      method: "POST",
      body: { migrationName: "delivery-lots-schema" },
      suppressErrorLog: true,
    }).catch(() => null);

    await api<{ success: boolean; message?: string }>("/api/v1/execute-migration", {
      method: "POST",
      body: { migrationName: "delivery-lots-rpc" },
      suppressErrorLog: true,
    }).catch(() => null);
  })().finally(() => {
    repairInFlight = null;
  });
  return repairInFlight;
}

export async function fetchDeliveryLots(options?: { silent?: boolean }): Promise<DeliveryLot[]> {
  try {
    const res = await api<{ success: boolean; data: DeliveryLot[]; source?: string; message?: string }>("/api/v1/delivery-lots", {
      noCache: true,
      suppressErrorLog: options?.silent,
    });
    return res.data || [];
  } catch (err) {
    const normalized = normalizeError(err, "Failed to fetch delivery lots from cloud database");
    if (isDeliveryLotsSchemaError(normalized.message)) {
      await ensureDeliveryLotsReady();
      const retry = await api<{ success: boolean; data: DeliveryLot[]; source?: string; message?: string }>("/api/v1/delivery-lots", {
        noCache: true,
        suppressErrorLog: true,
      });
      return retry.data || [];
    }
    if (options?.silent) return [];
    throw normalized;
  }
}

export async function createDeliveryLotAPI(input: {
  name: string;
  dispatch_date: string;
  destination?: string;
  vehicle_no?: string;
  notes?: string;
  driver_id?: string;
  driver_name?: string;
  order_ids?: string[];
  order_meta?: Record<string, OrderMeta>;
  manufacturing_statuses?: Record<string, string>;
}): Promise<DeliveryLot> {
  try {
    const res = await api<{ success: boolean; data: DeliveryLot }>("/api/v1/delivery-lots", {
      method: "POST",
      body: input,
    });
    announceLotsChanged();
    return res.data;
  } catch (err) {
    const normalized = normalizeError(err, "Failed to create delivery lot in cloud database");
    if (isDeliveryLotsSchemaError(normalized.message)) {
      await ensureDeliveryLotsReady();
      const retry = await api<{ success: boolean; data: DeliveryLot }>("/api/v1/delivery-lots", {
        method: "POST",
        body: input,
        suppressErrorLog: true,
      });
      announceLotsChanged();
      return retry.data;
    }
    throw normalized;
  }
}

export async function updateDeliveryLotAPI(
  lotId: string,
  updates: Partial<Omit<DeliveryLot, "id" | "created_at" | "lot_number">>
): Promise<void> {
  try {
    await api("/api/v1/delivery-lots", {
      method: "PUT",
      body: { id: lotId, ...updates },
    });
  } catch (err) {
    const normalized = normalizeError(err, "Failed to update delivery lot in cloud database");
    if (isDeliveryLotsSchemaError(normalized.message)) {
      await ensureDeliveryLotsReady();
      await api("/api/v1/delivery-lots", {
        method: "PUT",
        body: { id: lotId, ...updates },
        suppressErrorLog: true,
      });
      return;
    }
    throw normalized;
  }
}

export async function deleteDeliveryLotAPI(lotId: string): Promise<void> {
  try {
    await api(`/api/v1/delivery-lots?id=${lotId}`, { method: "DELETE" });
  } catch (err) {
    const normalized = normalizeError(err, "Failed to delete delivery lot from cloud database");
    if (isDeliveryLotsSchemaError(normalized.message)) {
      await ensureDeliveryLotsReady();
      await api(`/api/v1/delivery-lots?id=${lotId}`, { method: "DELETE", suppressErrorLog: true });
      return;
    }
    throw normalized;
  }
}

export async function updateManufacturingStatusAPI(
  lotId: string,
  orderId: string,
  status: string
): Promise<void> {
  try {
    await api("/api/v1/delivery-lots", {
      method: "PUT",
      body: { id: lotId, manufacturing_statuses: { [orderId]: status } },
    });
  } catch (err) {
    const normalized = normalizeError(err, "Failed to update manufacturing status in cloud database");
    if (isDeliveryLotsSchemaError(normalized.message)) {
      await ensureDeliveryLotsReady();
      await api("/api/v1/delivery-lots", {
        method: "PUT",
        body: { id: lotId, manufacturing_statuses: { [orderId]: status } },
        suppressErrorLog: true,
      });
      return;
    }
    throw normalized;
  }
}
