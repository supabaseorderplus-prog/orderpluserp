"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import {
  Boxes,
  CheckCircle2,
  Lock,
  MapPinned,
  RefreshCw,
  Trash2,
  Truck,
  Save,
} from "lucide-react";
import {
  fetchDeliveryLots,
  updateDeliveryLotAPI,
  deleteDeliveryLotAPI,
  type DeliveryLot,
  type DeliveryLotStatus,
} from "@/lib/delivery-lots";
import { useLotsRealtime } from "@/lib/hooks/use-lots-realtime";
import { loadDrivers } from "@/lib/drivers-store";

interface Order {
  id: string;
  order_number: string;
  status: string;
  grand_total: number;
  created_at: string;
  buyer: { id: string; name: string; party_code?: string; party_types?: { name: string } | null } | null;
  order_items: { id: string; quantity: number; unit_price: number; products: { name: string; sku: string } | null }[];
}

const LOT_STATUSES: DeliveryLotStatus[] = ["OPEN", "READY", "DISPATCHED", "DELIVERED"];

const fmt = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n);

const lotStatusColor = (status: DeliveryLotStatus) =>
  status === "DELIVERED"
    ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
    : status === "DISPATCHED"
      ? "text-sky-400 bg-sky-500/10 border-sky-500/30"
      : status === "READY"
        ? "text-amber-400 bg-amber-500/10 border-amber-500/30"
        : "text-zinc-500 bg-black/[0.03] border-black/10";

function getLotValue(lot: DeliveryLot, orders: Order[]) {
  return lot.order_ids.reduce((sum, orderId) => {
    const order = orders.find((item) => item.id === orderId);
    return sum + Number(order?.grand_total || 0);
  }, 0);
}

function isManufacturingComplete(lot: DeliveryLot): boolean {
  // READY status means procurement already confirmed 100% manufacturing
  if (lot.status === "READY" || lot.status === "DISPATCHED" || lot.status === "DELIVERED") return true;
  if (!lot.order_ids.length) return true;
  return lot.order_ids.every(
    (id) => (lot.manufacturing_statuses?.[id] || "").toLowerCase() === "completed"
  );
}

interface Driver { id: string; name: string; }

export default function DeliveryLotsPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [lots, setLots] = useState<DeliveryLot[]>([]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [expandedLot, setExpandedLot] = useState<string | null>(null);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [assignForm, setAssignForm] = useState<Record<string, { driver_id: string; driver_name: string; vehicle_no: string }>>({});
  const [savedLots, setSavedLots] = useState<Set<string>>(new Set());

  const refreshLots = useCallback(async () => {
    try {
      const allLots = await fetchDeliveryLots();
      setLots(allLots);
    } catch {
      setError("Failed to load delivery lots");
    }
  }, []);

  // Keep lots in sync across all devices in real time
  useLotsRealtime(refreshLots);

  const fetchOrders = useCallback(() => {
    // Fetch all relevant statuses so lot contents display correctly
    Promise.all([
      api<{ success: boolean; data: Order[] }>("/api/v1/orders?status=APPROVED&limit=300").catch(() => ({ data: [] as Order[] })),
      api<{ success: boolean; data: Order[] }>("/api/v1/orders?status=PROCUREMENT&limit=300").catch(() => ({ data: [] as Order[] })),
      api<{ success: boolean; data: Order[] }>("/api/v1/orders?status=IN_PROCUREMENT&limit=300").catch(() => ({ data: [] as Order[] })),
      api<{ success: boolean; data: Order[] }>("/api/v1/orders?status=DISPATCHED&limit=300").catch(() => ({ data: [] as Order[] })),
      api<{ success: boolean; data: Order[] }>("/api/v1/orders?status=DELIVERED&limit=300").catch(() => ({ data: [] as Order[] })),
    ]).then(([approved, procurement, inProcurement, dispatched, delivered]) => {
      const merged = [
        ...(approved.data || []),
        ...(procurement.data || []),
        ...(inProcurement.data || []),
        ...(dispatched.data || []),
        ...(delivered.data || []),
      ];
      const seen = new Set<string>();
      const unique: Order[] = [];
      merged.forEach((o) => { if (!seen.has(o.id)) { seen.add(o.id); unique.push(o); } });
      setOrders(unique);
    }).catch((err) => setError(err instanceof Error ? err.message : "Failed to load orders"));
  }, []);

  useEffect(() => {
    refreshLots();
    fetchOrders();
    // Drivers come from two independent sources that must both be offered:
    //  - API auth-metadata drivers (created via Create User, display_role=DRIVER)
    //  - localStorage drivers (created on the /dashboard/drivers page)
    // Merge both and dedupe so a driver shows up regardless of where it was added.
    const localDrivers: Driver[] = loadDrivers()
      .filter(d => d.status !== "INACTIVE")
      .map(d => ({ id: d.id, name: d.name }));
    api<{ data: Driver[] }>("/api/v1/users?role=DRIVER&limit=200")
      .then(r => {
        const apiDrivers = r.data || [];
        const byKey = new Map<string, Driver>();
        for (const d of [...apiDrivers, ...localDrivers]) {
          const key = d.name.trim().toLowerCase();
          if (key && !byKey.has(key)) byKey.set(key, d);
        }
        setDrivers([...byKey.values()]);
      })
      .catch(() => setDrivers(localDrivers));
  }, [fetchOrders, refreshLots]);

  // A lot only belongs in Stage-3 Delivery Lots once Procurement has finished
  // it: every order's manufacturing must be "Completed" AND the lot must have
  // been explicitly "Marked as Completed" (status advanced OPEN → READY). The
  // "Mark as Completed" button only appears once manufacturing is 100%, so a
  // non-OPEN status already implies both gates are satisfied. OPEN lots are
  // still on the manufacturing floor and must stay in Procurement only.
  const displayLots = useMemo(() => lots.filter((lot) => lot.status !== "OPEN"), [lots]);

  const assignedOrderCount = useMemo(
    () => displayLots.reduce((sum, lot) => sum + lot.order_ids.length, 0),
    [displayLots]
  );

  function handleExpandLot(lot: DeliveryLot) {
    const id = lot.id;
    setExpandedLot(expandedLot === id ? null : id);
    if (expandedLot !== id && !assignForm[id]) {
      setAssignForm(prev => ({
        ...prev,
        [id]: { driver_id: lot.driver_id || "", driver_name: lot.driver_name || "", vehicle_no: lot.vehicle_no || "" },
      }));
    }
  }

  async function handleSaveAssignment(lotId: string) {
    const f = assignForm[lotId];
    if (!f) return;
    try {
      await updateDeliveryLotAPI(lotId, { driver_id: f.driver_id, driver_name: f.driver_name, vehicle_no: f.vehicle_no });
      await refreshLots();
      setSuccess("Driver & van saved");
      setSavedLots(prev => new Set(prev).add(lotId));
      setTimeout(() => setSavedLots(prev => { const n = new Set(prev); n.delete(lotId); return n; }), 1800);
    } catch {
      setError("Failed to save assignment");
    }
  }

  async function handleLotStatusChange(lotId: string, status: DeliveryLotStatus) {
    if (status === "DISPATCHED") {
      const lot = lots.find((l) => l.id === lotId);
      if (!lot) return;

      if (!isManufacturingComplete(lot)) {
        const incomplete = lot.order_ids.filter(
          (id) => (lot.manufacturing_statuses?.[id] || "").toLowerCase() !== "completed"
        ).length;
        setError(
          `Cannot dispatch: ${incomplete} order${incomplete !== 1 ? "s" : ""} still pending manufacturing. Mark all orders as Complete first.`
        );
        setTimeout(() => setError(""), 5000);
        return;
      }

      if (!lot.driver_name || !lot.vehicle_no) {
        setError("Please assign a driver and vehicle number first, then save before dispatching.");
        setTimeout(() => setError(""), 4000);
        return;
      }
    }

    try {
      // Backend PUT handler syncs all order statuses automatically when lot is DISPATCHED/DELIVERED
      await updateDeliveryLotAPI(lotId, { status });
      await refreshLots();
      fetchOrders();
      window.dispatchEvent(new Event("orderStatusChanged"));

      const lot = lots.find((l) => l.id === lotId);
      const orderCount = lot?.order_ids.length || 0;

      if (status === "DISPATCHED") {
        setSuccess(`Lot dispatched — ${orderCount} order${orderCount !== 1 ? "s" : ""} marked as Dispatched`);
      } else if (status === "DELIVERED") {
        setSuccess(`Lot delivered — ${orderCount} order${orderCount !== 1 ? "s" : ""} marked as Delivered`);
      } else {
        setSuccess(`Lot updated to ${status}`);
      }
    } catch {
      setError("Failed to update lot status");
    }
  }

  async function handleDeleteLot(lotId: string) {
    try {
      await deleteDeliveryLotAPI(lotId);
      await refreshLots();
      setExpandedLot((current) => (current === lotId ? null : current));
      setSuccess("Lot removed");
    } catch {
      setError("Failed to delete lot");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-zinc-900" style={{ fontSize: "1.3rem" }}>Delivery Lots</h1>
            <p className="text-zinc-500" style={{ fontSize: "0.8rem" }}>
              Stage 3 — lots from <span className="text-blue-400 font-medium">Procurement</span> appear here. When status becomes <span className="text-emerald-500 font-medium">DISPATCHED</span>, orders auto-move to <span className="text-amber-500 font-medium">Invoices</span> for conversion.
            </p>
        </div>
        <div className="inline-flex items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-amber-500" style={{ fontSize: "0.75rem" }}>
          <Boxes className="w-4 h-4" /> Multiple lots per confirmed order
        </div>
      </div>

      {error && <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-red-400" style={{ fontSize: "0.8rem" }}>{error}</div>}
      {success && <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-emerald-500" style={{ fontSize: "0.8rem" }}>{success}</div>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-black/[0.06] bg-white p-5 shadow-sm">
          <div className="text-zinc-500" style={{ fontSize: "0.72rem" }}>Total lots</div>
          <div className="mt-2 text-2xl font-bold text-zinc-900">{displayLots.length}</div>
        </div>
        <div className="rounded-2xl border border-black/[0.06] bg-white p-5 shadow-sm">
          <div className="text-zinc-500" style={{ fontSize: "0.72rem" }}>Total orders</div>
            <div className="mt-2 text-2xl font-bold text-zinc-900">{orders.length}</div>
        </div>
        <div className="rounded-2xl border border-black/[0.06] bg-white p-5 shadow-sm">
          <div className="text-zinc-500" style={{ fontSize: "0.72rem" }}>Lot assignments</div>
          <div className="mt-2 text-2xl font-bold text-zinc-900">{assignedOrderCount}</div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="space-y-4 max-h-[31rem] overflow-y-auto pr-1 scroll-smooth">
          {displayLots.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-black/10 bg-white p-8 text-center text-zinc-500 shadow-sm" style={{ fontSize: "0.82rem" }}>
              {lots.length > 0
                ? <>Lots are waiting in <span className="text-blue-400 font-medium">Procurement</span> — mark every order <span className="text-emerald-500 font-medium">Complete</span>, then click <span className="text-emerald-500 font-medium">Mark as Completed</span> to move them here.</>
                : <>No lots yet. Go to <span className="text-blue-400 font-medium">Procurement</span> → complete manufacturing → <span className="text-emerald-500 font-medium">Mark as Completed</span> → the lot appears here.</>
              }
            </div>
          ) : (
            displayLots.map((lot) => {
              const isExpanded = expandedLot === lot.id;
              const lotOrders = orders.filter((order) => lot.order_ids.includes(order.id));
              const lotValue = getLotValue(lot, orders);
              // Effective status: a dispatched lot whose every order is already
              // DELIVERED should show DELIVERED, even if the stored lot status
              // hasn't caught up yet (older lots predating lot-status sync).
              const allOrdersDelivered =
                lotOrders.length > 0 && lotOrders.every((o) => o.status === "DELIVERED");
              const displayStatus: DeliveryLotStatus =
                allOrdersDelivered && lot.status === "DISPATCHED" ? "DELIVERED" : lot.status;
              return (
                <div key={lot.id} className="rounded-2xl border border-black/[0.06] bg-white shadow-sm overflow-hidden">
                  <div
                    className="flex cursor-pointer items-center gap-4 px-5 py-4 hover:bg-black/[0.02]"
                    onClick={() => handleExpandLot(lot)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="font-semibold text-zinc-900" style={{ fontSize: "0.88rem" }}>{lot.name || lot.lot_number}</div>
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-medium ${lotStatusColor(displayStatus)}`} style={{ fontSize: "0.62rem" }}>
                          {displayStatus}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-3 text-zinc-500" style={{ fontSize: "0.68rem" }}>
                        <span className="inline-flex items-center gap-1"><Truck className="w-3.5 h-3.5" /> {lot.vehicle_no || "Vehicle pending"}</span>
                        <span className="inline-flex items-center gap-1"><MapPinned className="w-3.5 h-3.5" /> {lot.destination || "Destination pending"}</span>
                        <span>{lot.dispatch_date || "No dispatch date"}</span>
                        {lot.driver_name && (
                          <span className="inline-flex items-center gap-1 text-amber-500 font-medium">
                            Driver: {lot.driver_name}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-semibold text-zinc-900" style={{ fontSize: "0.82rem" }}>{fmt(lotValue)}</div>
                      <div className="text-zinc-500" style={{ fontSize: "0.68rem" }}>{lotOrders.length} order{lotOrders.length !== 1 ? "s" : ""}</div>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t border-black/[0.06] px-5 py-4 bg-black/[0.01] space-y-4">
                      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                        <div className="flex flex-wrap gap-2">
                            {LOT_STATUSES.filter((status) => status !== "DELIVERED").map((status) => {
                              const active = lot.status === status;
                              const mfgIncomplete = status === "DISPATCHED" && !isManufacturingComplete(lot);
                              const needsDriver = status === "DISPATCHED" && !mfgIncomplete && (!lot.driver_name || !lot.vehicle_no);
                              const disabled = (mfgIncomplete || needsDriver) && !active;
                              const title = mfgIncomplete
                                ? `Manufacturing incomplete — ${lot.order_ids.filter(id => (lot.manufacturing_statuses?.[id] || "").toLowerCase() !== "completed").length} order(s) pending`
                                : needsDriver ? "Save driver & vehicle first" : "";
                              return (
                                <button
                                  key={status}
                                  onClick={() => { if (!active && !disabled) handleLotStatusChange(lot.id, status); }}
                                  className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 font-medium transition-all ${
                                    active ? lotStatusColor(status)
                                    : mfgIncomplete && !active ? "border-orange-500/20 text-orange-400 bg-orange-500/5 cursor-not-allowed"
                                    : disabled ? "border-black/5 text-zinc-300 cursor-not-allowed"
                                    : "border-black/10 text-zinc-500 hover:border-amber-500/30 hover:text-amber-600"
                                  }`}
                                  style={{ fontSize: "0.68rem", background: mfgIncomplete && !active ? undefined : "none", fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer" }}
                                  title={title}
                                >
                                  {mfgIncomplete && !active && <Lock className="w-2.5 h-2.5" />}
                                  {status}
                                </button>
                              );
                            })}
                        </div>
                        <div className="flex gap-2">
                          {displayStatus === "DISPATCHED" && (
                            <button
                              onClick={async () => {
                                try {
                                  await updateDeliveryLotAPI(lot.id, { status: "DISPATCHED" });
                                  fetchOrders();
                                  window.dispatchEvent(new Event("orderStatusChanged"));
                                  setSuccess("Orders re-synced to Dispatched");
                                } catch { setError("Sync failed"); }
                              }}
                              className="inline-flex items-center gap-2 rounded-lg border border-violet-500/20 px-3 py-1.5 text-violet-500 hover:bg-violet-500/5"
                              style={{ fontSize: "0.72rem", background: "none", fontFamily: "inherit", cursor: "pointer" }}
                            >
                              <RefreshCw className="w-3.5 h-3.5" /> Re-sync Orders
                            </button>
                          )}
                          <button
                            onClick={() => handleDeleteLot(lot.id)}
                            className="inline-flex items-center gap-2 rounded-lg border border-red-500/20 px-3 py-1.5 text-red-400 hover:bg-red-500/5"
                            style={{ fontSize: "0.72rem", background: "none", fontFamily: "inherit", cursor: "pointer" }}
                          >
                            <Trash2 className="w-3.5 h-3.5" /> Delete lot
                          </button>
                        </div>
                      </div>

                      {assignForm[lot.id] && (
                        <div className="rounded-xl border border-black/[0.06] bg-white p-4">
                          <div className="mb-3 flex items-center gap-2">
                            <Truck className="w-4 h-4 text-amber-500" />
                            <h3 className="font-medium text-zinc-900" style={{ fontSize: "0.8rem" }}>Assign Driver & Van</h3>
                          </div>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div>
                              <label className="block text-zinc-500 mb-1" style={{ fontSize: "0.68rem" }}>Driver</label>
                              <select
                                className="w-full rounded-lg border border-black/10 bg-black/[0.02] px-3 py-2 text-zinc-900 outline-none focus:border-amber-400 transition-colors appearance-none"
                                style={{ fontSize: "0.78rem" }}
                                value={assignForm[lot.id].driver_id}
                                onChange={e => {
                                  const d = drivers.find(d => d.id === e.target.value);
                                  setAssignForm(prev => ({ ...prev, [lot.id]: { ...prev[lot.id], driver_id: e.target.value, driver_name: d?.name || "" } }));
                                }}
                              >
                                <option value="">No driver</option>
                                {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                              </select>
                            </div>
                            <div>
                              <label className="block text-zinc-500 mb-1" style={{ fontSize: "0.68rem" }}>Van / Vehicle No.</label>
                              <input
                                type="text"
                                placeholder="e.g. WB-01-AB-1234"
                                className="w-full rounded-lg border border-black/10 bg-black/[0.02] px-3 py-2 text-zinc-900 outline-none focus:border-amber-400 transition-colors"
                                style={{ fontSize: "0.78rem" }}
                                value={assignForm[lot.id].vehicle_no}
                                onChange={e => setAssignForm(prev => ({ ...prev, [lot.id]: { ...prev[lot.id], vehicle_no: e.target.value } }))}
                              />
                            </div>
                          </div>
                          <button
                            onClick={() => handleSaveAssignment(lot.id)}
                            className={`mt-3 inline-flex items-center gap-2 rounded-lg px-4 py-1.5 transition-all duration-300 ${
                              savedLots.has(lot.id)
                                ? "bg-emerald-500/15 border border-emerald-500/30 text-emerald-600 scale-105"
                                : "bg-amber-500/10 border border-amber-500/20 text-amber-600 hover:bg-amber-500/20"
                            }`}
                            style={{ fontSize: "0.72rem", fontFamily: "inherit", cursor: "pointer" }}
                          >
                            {savedLots.has(lot.id) ? (
                              <>
                                <CheckCircle2 className="w-3.5 h-3.5 animate-bounce" /> Saved!
                              </>
                            ) : (
                              <>
                                <Save className="w-3.5 h-3.5" /> Save
                              </>
                            )}
                          </button>
                        </div>
                      )}

                      {lot.notes && (
                        <div className="rounded-xl border border-black/[0.06] bg-white px-4 py-3 text-zinc-600" style={{ fontSize: "0.76rem" }}>
                          {lot.notes}
                        </div>
                      )}

                      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                        <div className="rounded-xl border border-black/[0.06] bg-white p-4">
                          <div className="mb-3 flex items-center gap-2">
                            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                            <h3 className="font-medium text-zinc-900" style={{ fontSize: "0.8rem" }}>Orders in this lot</h3>
                          </div>
                          {lotOrders.length === 0 ? (
                            <div className="text-zinc-500" style={{ fontSize: "0.76rem" }}>No orders assigned yet.</div>
                          ) : (
                            <div className="space-y-2">
                              {lotOrders.map((order) => (
                                <div key={order.id} className="rounded-lg border border-black/[0.06] bg-black/[0.02] px-3 py-2">
                                  <div className="flex items-start justify-between gap-3">
                                    <div>
                                    <div className="font-medium text-zinc-900" style={{ fontSize: "0.76rem" }}>{order.order_number}</div>
                                        <div className="text-zinc-500" style={{ fontSize: "0.66rem" }}>{order.buyer?.name || "—"}</div>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
