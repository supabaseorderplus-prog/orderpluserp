"use client";

import { useEffect, useState, useCallback, useRef, useLayoutEffect } from "react";
import { api } from "@/lib/api";
import {
  ChevronRight, ClipboardList, Loader2, Package, ShoppingCart, X,
    CreditCard, Factory, CheckCircle2, AlertCircle, Clock,
    Layers, Truck, CheckSquare, MapPin, Eye, Printer,
} from "lucide-react";
import { createDeliveryLotAPI, fetchDeliveryLots, updateDeliveryLotAPI, deleteDeliveryLotAPI, updateManufacturingStatusAPI, type DeliveryLot, type DeliveryLotStatus, type OrderMeta } from "@/lib/delivery-lots";
import { useLotsRealtime } from "@/lib/hooks/use-lots-realtime";

interface Driver { id: string; name: string; }

interface Order {
  id: string;
  order_number: string;
  created_at: string;
  grand_total: number;
  payment_status: string;
  status: string;
  order_status?: string;
  buyer: { id: string; name: string; party_code?: string } | null;
  order_items: { id: string; quantity: number; unit_price: number; products: { name: string; sku: string; pack_size?: number; unit_of_measure?: string; category_id?: string; product_categories?: { id: string; name: string } | null; technical_specs?: { net_weight_with_packaging?: number; net_weight_unit?: string } | null } | null }[];
  salesman: { id: string; name: string } | null;
  created_by: string | null;
  notes: string | null;
}

type ManufacturingStage = "Not Started" | "In Progress" | "Completed";

interface ProcurementStages {
  manufacturing: ManufacturingStage;
}

interface CombinedCategoryProduct {
  name: string;
  sku: string;
  unit: string;
  packSize: number;
  totalQty: number;
  totalWeight: number;
  totalValue: number;
}

interface CombinedCategorySummary {
  categoryId: string;
  categoryName: string;
  products: CombinedCategoryProduct[];
  totalQty: number;
  totalWeight: number;
  totalValue: number;
}

interface CombinedOutputSummary {
  categories: CombinedCategorySummary[];
  totalItems: number;
  totalQty: number;
  totalWeight: number;
  totalValue: number;
}

function defaultStages(): ProcurementStages {
  return { manufacturing: "Not Started" };
}

function loadStages(orderId: string): ProcurementStages {
  try {
    const raw = localStorage.getItem("procurement_stages_v1");
    const all = raw ? JSON.parse(raw) : {};
    return all[orderId] || defaultStages();
  } catch { return defaultStages(); }
}

function persistStages(orderId: string, stages: ProcurementStages) {
  try {
    const raw = localStorage.getItem("procurement_stages_v1");
    const all = raw ? JSON.parse(raw) : {};
    all[orderId] = stages;
    localStorage.setItem("procurement_stages_v1", JSON.stringify(all));
  } catch { /* ignore */ }
}

const payLabel = (ps: string, amountPaid: number) =>
  ps === "PAID" ? "PAID" : (ps === "PARTIAL" && amountPaid > 0) ? "PARTIAL" : "UNPAID";

const payColor = (label: string) =>
  label === "PAID"
    ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
    : label === "PARTIAL"
    ? "text-amber-400 bg-amber-500/10 border-amber-500/30"
    : "text-red-400 bg-red-500/10 border-red-500/30";

const mfgColor = (s: string) =>
  s === "Completed" ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30" :
  s === "In Progress" ? "text-amber-400 bg-amber-500/10 border-amber-500/30" :
  "text-zinc-600 bg-black/[0.03] border-black/10";

const fmt = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n);

const orderNetWeight = (order: Order) =>
  (order.order_items || []).reduce((sum, item) => {
    const netWeight = item.products?.technical_specs?.net_weight_with_packaging || item.products?.pack_size || 0;
    return sum + (item.quantity * netWeight);
  }, 0);

function buildCombinedOutputSummary(lot: DeliveryLot, allOrdersMap: Map<string, Order>): CombinedOutputSummary | null {
  const categoryMap = new Map<string, { categoryName: string; products: Map<string, CombinedCategoryProduct> }>();

  lot.order_ids.forEach((orderId) => {
    const order = allOrdersMap.get(orderId);
    if (!order) return;

    (order.order_items || []).forEach((item) => {
      const categoryId = item.products?.category_id || "uncategorized";
      const categoryName = item.products?.product_categories?.name || "Uncategorized";
      const productId = item.products?.sku || item.id;

      if (!categoryMap.has(categoryId)) {
        categoryMap.set(categoryId, { categoryName, products: new Map() });
      }

      const category = categoryMap.get(categoryId)!;
      const existing = category.products.get(productId);
      const qty = item.quantity;
      const weight = qty * (item.products?.pack_size || 0);
      const value = qty * Number(item.unit_price);

      if (existing) {
        existing.totalQty += qty;
        existing.totalWeight += weight;
        existing.totalValue += value;
        return;
      }

      category.products.set(productId, {
        name: item.products?.name || "—",
        sku: item.products?.sku || "—",
        unit: item.products?.unit_of_measure || "KG",
        packSize: item.products?.pack_size || 0,
        totalQty: qty,
        totalWeight: weight,
        totalValue: value,
      });
    });
  });

  if (categoryMap.size === 0) return null;

  const categories = [...categoryMap.entries()].map(([categoryId, category]) => {
    const products = [...category.products.values()];
    return {
      categoryId,
      categoryName: category.categoryName,
      products,
      totalQty: products.reduce((sum, product) => sum + product.totalQty, 0),
      totalWeight: products.reduce((sum, product) => sum + product.totalWeight, 0),
      totalValue: products.reduce((sum, product) => sum + product.totalValue, 0),
    };
  });

  return {
    categories,
    totalItems: categories.reduce((sum, category) => sum + category.products.length, 0),
    totalQty: categories.reduce((sum, category) => sum + category.totalQty, 0),
    totalWeight: categories.reduce((sum, category) => sum + category.totalWeight, 0),
    totalValue: categories.reduce((sum, category) => sum + category.totalValue, 0),
  };
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export default function ProcurementPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [allOrdersMap, setAllOrdersMap] = useState<Map<string, Order>>(new Map());
  const [loading, setLoading] = useState(true);
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);
  const [updatingPayId, setUpdatingPayId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [filterCreatedBy, setFilterCreatedBy] = useState("");
  const [stages, setStages] = useState<Record<string, ProcurementStages>>({});
  const [partialModal, setPartialModal] = useState<{ orderId: string; grandTotal: number; currentPaid: number } | null>(null);
  const [partialInput, setPartialInput] = useState("");
  const [creatorNames, setCreatorNames] = useState<Record<string, string>>({});

  // ── Combine into Lot ──────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Order-selection list: show exactly 5 cards, scroll the rest. Cards vary in
  // height, so measure the 5th card at runtime instead of hardcoding a height.
  const VISIBLE_ORDER_CARDS = 5;
  const orderListRef = useRef<HTMLDivElement>(null);
  const [orderListMaxH, setOrderListMaxH] = useState<number | undefined>(undefined);
  const [lotModal, setLotModal] = useState(false);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [lotForm, setLotForm] = useState({
    name: "",
    destination: "",
    dispatch_date: new Date().toISOString().split("T")[0],
    vehicle_no: "",
    driver_id: "",
    driver_name: "",
    notes: "",
  });
  const [creatingLot, setCreatingLot] = useState(false);

  // ── Delivery Lots section ─────────────────────────────────────────────────
  const [lots, setLots] = useState<DeliveryLot[]>([]);
  const [expandedLot, setExpandedLot] = useState<string | null>(null);
  const [expandedLotOrder, setExpandedLotOrder] = useState<string | null>(null);

  const printCombinedOutput = useCallback((lot: DeliveryLot) => {
    const summary = buildCombinedOutputSummary(lot, allOrdersMap);
    if (!summary) {
      setError("No category-wise output available to print for this lot.");
      return;
    }

    const printWindow = window.open("", "_blank", "width=1100,height=800");
    if (!printWindow) {
      setError("Unable to open print window. Please allow pop-ups and try again.");
      return;
    }

    const categorySections = summary.categories.map((category) => {
      const rows = category.products.map((product, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(product.name)}</td>
          <td>${escapeHtml(product.sku)}</td>
          <td>${product.totalQty}</td>
          <td>${product.totalWeight > 0 ? `${product.totalWeight} ${escapeHtml(product.unit)}` : "—"}</td>
          <td>${escapeHtml(fmt(product.totalValue))}</td>
        </tr>
      `).join("");

      return `
        <section class="category">
          <div class="category-header">
            <div>
              <h2>${escapeHtml(category.categoryName)}</h2>
              <p>${category.products.length} product${category.products.length !== 1 ? "s" : ""}</p>
            </div>
            <div class="category-metrics">
              <span>Qty: ${category.totalQty}</span>
              <span>${escapeHtml(fmt(category.totalValue))}</span>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Product</th>
                <th>SKU</th>
                <th>Qty</th>
                <th>Weight</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </section>
      `;
    }).join("");

    const printable = `<!DOCTYPE html>
      <html>
        <head>
          <title>${escapeHtml(lot.lot_number)} - Combined Output</title>
          <meta charset="utf-8" />
          <style>
            * { box-sizing: border-box; }
            body { margin: 0; padding: 28px; font-family: Inter, Arial, sans-serif; color: #111827; background: #ffffff; }
            .top { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 2px solid #111827; }
            .title { font-size: 24px; font-weight: 800; margin: 0 0 6px; }
            .subtitle { margin: 0; color: #4b5563; font-size: 13px; }
            .badge { display: inline-block; padding: 6px 10px; border-radius: 999px; background: #ecfdf5; color: #047857; font-size: 12px; font-weight: 700; }
            .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 18px 0 24px; }
            .card { border: 1px solid #e5e7eb; border-radius: 14px; padding: 14px; background: #fafafa; }
            .card-label { font-size: 11px; text-transform: uppercase; color: #6b7280; letter-spacing: 0.06em; margin-bottom: 6px; }
            .card-value { font-size: 18px; font-weight: 800; }
            .category { margin-bottom: 20px; border: 1px solid #e5e7eb; border-radius: 16px; overflow: hidden; }
            .category-header { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 14px 16px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; }
            .category-header h2 { margin: 0 0 4px; font-size: 16px; }
            .category-header p { margin: 0; color: #6b7280; font-size: 12px; }
            .category-metrics { display: flex; gap: 18px; font-size: 13px; font-weight: 700; }
            table { width: 100%; border-collapse: collapse; }
            th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #f1f5f9; font-size: 12px; }
            th { background: #ffffff; color: #6b7280; text-transform: uppercase; font-size: 10px; letter-spacing: 0.08em; }
            .footer { margin-top: 24px; padding-top: 16px; border-top: 2px solid #111827; display: flex; justify-content: space-between; gap: 16px; font-weight: 800; }
            @media print { body { padding: 14px; } }
          </style>
        </head>
        <body>
          <div class="top">
            <div>
              <p class="badge">Printable Category-Wise List</p>
              <h1 class="title">Combined Output — Category Wise</h1>
              <p class="subtitle">Lot ${escapeHtml(lot.lot_number)}${lot.name ? ` • ${escapeHtml(lot.name)}` : ""}</p>
            </div>
            <div>
              <p class="subtitle">Dispatch Date: ${escapeHtml(lot.dispatch_date || "—")}</p>
              <p class="subtitle">Destination: ${escapeHtml(lot.destination || "—")}</p>
            </div>
          </div>

          <div class="summary">
            <div class="card"><div class="card-label">Categories</div><div class="card-value">${summary.categories.length}</div></div>
            <div class="card"><div class="card-label">Products</div><div class="card-value">${summary.totalItems}</div></div>
            <div class="card"><div class="card-label">Total Units</div><div class="card-value">${summary.totalQty}</div></div>
            <div class="card"><div class="card-label">Total Value</div><div class="card-value">${escapeHtml(fmt(summary.totalValue))}</div></div>
          </div>

          ${categorySections}

          <div class="footer">
            <span>Total Quantity: ${summary.totalQty}</span>
            <span>Total Weight: ${summary.totalWeight > 0 ? `${summary.totalWeight} KG` : "—"}</span>
            <span>Grand Total: ${escapeHtml(fmt(summary.totalValue))}</span>
          </div>
          <script>window.onload = () => window.print()</script>
        </body>
      </html>`;

    printWindow.document.open();
    printWindow.document.write(printable);
    printWindow.document.close();
    setSuccess(`Printable combined list opened for ${lot.lot_number}. Use Print or Save as PDF.`);
  }, [allOrdersMap]);

  useEffect(() => {
    try {
      localStorage.removeItem("delivery_lots_fallback_v1");
      localStorage.removeItem("delivery_lots_force_local_v1");
    } catch {}

    fetchDeliveryLots({ silent: true })
      .then(setLots)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load delivery lots"));
  }, []);

  function refreshLots() {
    return fetchDeliveryLots({ silent: true })
      .then(setLots)
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load delivery lots");
      });
  }

  // Keep lots in sync across all devices in real time
  useLotsRealtime(refreshLots);

  async function changeLotStatus(lotId: string, status: DeliveryLotStatus) {
    await updateDeliveryLotAPI(lotId, { status });
    refreshLots();
  }

  async function removeLot(lotId: string) {
    await deleteDeliveryLotAPI(lotId);
    refreshLots();
    fetchOrders();
  }

  const LOT_STATUSES: DeliveryLotStatus[] = ["OPEN", "READY", "DISPATCHED", "DELIVERED"];
  const lotStatusColor = (s: DeliveryLotStatus) =>
    s === "DELIVERED" ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30" :
    s === "DISPATCHED" ? "text-blue-400 bg-blue-500/10 border-blue-500/30" :
    s === "READY" ? "text-amber-400 bg-amber-500/10 border-amber-500/30" :
    "text-zinc-500 bg-black/[0.04] border-black/10";

  const toggleSelect = (id: string) =>
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const openLotModal = () => {
    const sel = orders.filter(o => selectedIds.has(o.id));
    setLotForm({
      name: "",
      destination: "",
      dispatch_date: new Date().toISOString().split("T")[0],
      vehicle_no: "",
      driver_id: "",
      driver_name: "",
      notes: "",
    });
    setLotModal(true);
    api<{ data: Driver[] }>("/api/v1/users?role=DRIVER&limit=200")
      .then(r => setDrivers(r.data || [])).catch(() => setDrivers([]));
  };

  const handleCreateLot = async () => {
    if (!lotForm.name.trim()) return;
    setCreatingLot(true);
    try {
      // Build order metadata snapshot
      const orderMetaSnapshot: Record<string, OrderMeta> = {};
      const manufacturingStatuses: Record<string, string> = {};
      selectedIds.forEach(oid => {
        const o = orders.find(x => x.id === oid);
        if (o) orderMetaSnapshot[oid] = {
          invoice_number: o.order_number,
          party_name: o.buyer?.name || "",
          grand_total: Number(o.grand_total),
        };
        manufacturingStatuses[oid] = stages[oid]?.manufacturing || "Not Started";
      });

      const assignedIds = [...selectedIds];

      const lot = await createDeliveryLotAPI({
        name: lotForm.name,
        dispatch_date: lotForm.dispatch_date,
        destination: lotForm.destination,
        vehicle_no: lotForm.vehicle_no,
        notes: lotForm.notes,
        driver_id: lotForm.driver_id,
        driver_name: lotForm.driver_name,
        order_ids: assignedIds,
        order_meta: orderMetaSnapshot,
        manufacturing_statuses: manufacturingStatuses,
      });

      // Optimistic update — show the lot and remove the assigned orders from
      // the unassigned list immediately, without waiting for a server round-trip.
      // The background refreshes below will confirm/correct the data.
      const now = new Date().toISOString();
      setLots(prev => [{
        id: lot.id,
        lot_number: lot.lot_number,
        name: lotForm.name,
        dispatch_date: lotForm.dispatch_date || '',
        destination: lotForm.destination || '',
        vehicle_no: lotForm.vehicle_no || '',
        notes: lotForm.notes || '',
        status: 'OPEN',
        order_ids: assignedIds,
        order_meta: orderMetaSnapshot,
        driver_id: lotForm.driver_id || '',
        driver_name: lotForm.driver_name || '',
        created_at: lot.created_at || now,
        updated_at: lot.updated_at || now,
        manufacturing_statuses: manufacturingStatuses,
      }, ...prev]);
      setOrders(prev => prev.filter(o => !assignedIds.includes(o.id)));

      setLotModal(false);
      setSelectedIds(new Set());
      setSuccess(`Lot ${lot.lot_number} created with ${assignedIds.length} order${assignedIds.length !== 1 ? "s" : ""} and moved to Delivery Lots.`);

      // Sync with server in background to confirm persisted state
      refreshLots();
      fetchOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create lot");
    }
    setCreatingLot(false);
  };

  const fetchOrders = useCallback(() => {
    setLoading(true);
    // Fetch both new and legacy "confirmed" statuses for procurement page.
    Promise.all([
      api<{ success: boolean; data: Order[] }>("/api/v1/orders?status=APPROVED&limit=200"),
      api<{ success: boolean; data: Order[] }>("/api/v1/orders?status=PROCUREMENT&limit=200"),
      api<{ success: boolean; data: Order[] }>("/api/v1/orders?status=IN_PROCUREMENT&limit=200"),
      api<{ success: boolean; data: Order[] }>("/api/v1/orders?status=CONFIRM&limit=200"),
      api<{ success: boolean; data: Order[] }>("/api/v1/orders?status=CONFIRMED&limit=200"),
      fetchDeliveryLots(),
    ]).then(([approvedRes, procRes, inProcRes, confirmRes, confirmedRes, allLots]) => {
        const combined = [
          ...(approvedRes.data || []),
          ...(procRes.data || []),
          ...(inProcRes.data || []),
          ...(confirmRes.data || []),
          ...(confirmedRes.data || []),
        ];
        const byId = new Map(combined.map(o => [o.id, o]));
        const confirmed = Array.from(byId.values()).filter((order) => {
          const normalizedStatus = String(order.status || order.order_status || "").toUpperCase();
          return normalizedStatus === "APPROVED" ||
            normalizedStatus === "PROCUREMENT" ||
            normalizedStatus === "IN_PROCUREMENT" ||
            normalizedStatus === "CONFIRM" ||
            normalizedStatus === "CONFIRMED";
        });
        setAllOrdersMap(new Map(confirmed.map(o => [o.id, o])));
        setLots(allLots);
        const assignedOrderIds = new Set(allLots.flatMap(lot => lot.order_ids || []));
        const stagesMap: Record<string, ProcurementStages> = {};

        // Initialize stages for all confirmed orders
        confirmed.forEach(o => {
          const lotForOrder = allLots.find(l => l.order_ids.includes(o.id));
          const mfgFromLot = lotForOrder?.manufacturing_statuses?.[o.id];
          stagesMap[o.id] = mfgFromLot
            ? { manufacturing: mfgFromLot as ProcurementStages["manufacturing"] }
            : loadStages(o.id);
        });

        // Also ensure every lot order_id has a stage entry — lot orders may not
        // appear in confirmed if their order status is unexpected.
        allLots.forEach(lot => {
          lot.order_ids.forEach(oid => {
            if (!stagesMap[oid]) {
              const mfgFromLot = lot.manufacturing_statuses?.[oid];
              stagesMap[oid] = mfgFromLot
                ? { manufacturing: mfgFromLot as ProcurementStages["manufacturing"] }
                : loadStages(oid);
            }
          });
        });
        const inProgress = confirmed.filter(o =>
          stagesMap[o.id]?.manufacturing !== "Completed" && !assignedOrderIds.has(o.id)
        );
        setOrders(inProgress);
        setStages(stagesMap);

        // Resolve creator names
        const ids = [...new Set(inProgress.map(o => o.created_by).filter(Boolean))] as string[];
        if (ids.length > 0) {
          api<{ success: boolean; data: { id: string; name: string }[] }>(`/api/v1/users?ids=${ids.join(",")}`)
            .then(ur => {
              const map: Record<string, string> = {};
              (ur.data || []).forEach(u => { map[u.id] = u.name; });
              setCreatorNames(prev => ({ ...prev, ...map }));
            })
            .catch(() => {});
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  async function updatePayment(orderId: string, status: string, amountPaid?: number) {
    setUpdatingPayId(orderId);
    setError("");
    try {
      await api(`/api/v1/orders/${orderId}`, {
        method: "PUT",
        body: { payment_status: status },
      });
      setSuccess(`Payment marked as ${status}`);
      fetchOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update payment");
    } finally {
      setUpdatingPayId(null);
    }
  }

  async function updateStage(orderId: string, key: keyof ProcurementStages, value: string) {
    // 1. Update local state immediately so UI responds at once
    const current = stages[orderId] || defaultStages();
    const updated = { ...current, [key]: value } as ProcurementStages;
    persistStages(orderId, updated);
    setStages(prev => ({ ...prev, [orderId]: updated }));

    // 2. Persist to DB
    if (key === "manufacturing") {
      const lot = lots.find(l => l.order_ids.includes(orderId));
      if (lot) {
        try {
          await updateManufacturingStatusAPI(lot.id, orderId, value);
          // Refresh lots so manufacturing_statuses in memory stays in sync with DB
          refreshLots();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to save manufacturing status");
          setTimeout(() => setError(""), 4000);
          // Revert local state on failure
          setStages(prev => ({ ...prev, [orderId]: current }));
          persistStages(orderId, current);
          return;
        }
      }

      // Keep order status in sync
      if (value === "In Progress" || value === "Completed") {
        api(`/api/v1/orders/${orderId}`, { method: "PUT", body: { status: "PROCUREMENT" } }).catch(() => {});
      }
    }

    // 3. If manufacturing just completed, remove from unassigned list
    if (key === "manufacturing" && value === "Completed") {
      setOrders(prev => prev.filter(o => o.id !== orderId));
      setExpandedOrder(null);
      setSuccess("Manufacturing complete — order moved to Delivery Lots");
    }
  }

  const filtered = orders.filter(o => {
    if (filterCreatedBy && o.created_by !== filterCreatedBy) return false;
    if (filterDateFrom && o.created_at < filterDateFrom) return false;
    if (filterDateTo && o.created_at > filterDateTo) return false;
    return true;
  });

  useLayoutEffect(() => {
    const el = orderListRef.current;
    if (!el) return;
    const compute = () => {
      const cards = Array.from(el.children) as HTMLElement[];
      if (cards.length <= VISIBLE_ORDER_CARDS) {
        setOrderListMaxH(prev => (prev === undefined ? prev : undefined));
        return;
      }
      const containerTop = el.getBoundingClientRect().top;
      const fifthBottom = cards[VISIBLE_ORDER_CARDS - 1].getBoundingClientRect().bottom;
      const next = Math.ceil(fifthBottom - containerTop);
      setOrderListMaxH(prev => (prev === next ? prev : next));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [filtered]);

  const uniqueCreators = [
    ...new Map(
      orders
        .filter(o => o.created_by && creatorNames[o.created_by])
        .map(o => [o.created_by!, { id: o.created_by!, name: creatorNames[o.created_by!] }])
    ).values(),
  ];

  const grandTotalSum = filtered.reduce((sum, o) => sum + Number(o.grand_total), 0);
  const paidSum = 0; // payment tracking not on orders table
  const unpaidSum = grandTotalSum - paidSum;

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      {/* Header */}
      <div className="flex items-center gap-3 mb-1">
        <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
          <ShoppingCart className="w-5 h-5 text-emerald-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-zinc-900" style={{ fontSize: "1.3rem" }}>Procurement</h1>
          <p className="text-zinc-500" style={{ fontSize: "0.75rem" }}>Stage 2 — take confirmed orders, complete manufacturing, then move them to delivery lots</p>
        </div>
      </div>

      {error && (
        <div className="my-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 flex items-center justify-between" style={{ fontSize: "0.8rem" }}>
          {error}
          <button onClick={() => setError("")} style={{ background: "none", border: "none", cursor: "pointer" }}><X className="w-4 h-4" /></button>
        </div>
      )}
      {success && (
        <div className="my-3 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-between" style={{ fontSize: "0.8rem" }}>
          {success}
          <button onClick={() => setSuccess("")} style={{ background: "none", border: "none", cursor: "pointer" }}><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Summary cards */}
      {!loading && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 my-5">
          <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-4">
            <div className="text-zinc-500 mb-1" style={{ fontSize: "0.68rem" }}>CONFIRMED ORDERS</div>
            <div className="text-zinc-900 font-bold" style={{ fontSize: "1.4rem" }}>{filtered.length}</div>
          </div>
          <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-4">
            <div className="text-zinc-500 mb-1" style={{ fontSize: "0.68rem" }}>TOTAL VALUE</div>
            <div className="text-zinc-900 font-bold" style={{ fontSize: "1.1rem" }}>{fmt(grandTotalSum)}</div>
          </div>
          <div className="rounded-xl border border-emerald-500/10 bg-emerald-500/[0.03] p-4">
            <div className="text-zinc-500 mb-1" style={{ fontSize: "0.68rem" }}>AMOUNT RECEIVED</div>
            <div className="text-emerald-400 font-bold" style={{ fontSize: "1.1rem" }}>{fmt(paidSum)}</div>
          </div>
          <div className="rounded-xl border border-red-500/10 bg-red-500/[0.03] p-4">
            <div className="text-zinc-500 mb-1" style={{ fontSize: "0.68rem" }}>OUTSTANDING</div>
            <div className="text-red-400 font-bold" style={{ fontSize: "1.1rem" }}>{fmt(unpaidSum)}</div>
          </div>
        </div>
      )}

      {/* Filters */}
      {!loading && (
        <div className="flex flex-wrap items-center gap-2 mb-4 p-3 rounded-xl border border-black/[0.06] bg-black/[0.02]">
          <select
            value={filterCreatedBy}
            onChange={e => setFilterCreatedBy(e.target.value)}
            className="flex-1 min-w-[130px] px-3 py-1.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-emerald-500/40"
            style={{ fontSize: "0.75rem", fontFamily: "inherit" }}
          >
            <option value="" className="bg-white">All creators</option>
            {uniqueCreators.map(u => (
              <option key={u.id} value={u.id} className="bg-white">{u.name}</option>
            ))}
          </select>
          <div className="flex items-center gap-1.5 flex-1 min-w-[260px]">
            <span className="text-zinc-500 shrink-0" style={{ fontSize: "0.7rem" }}>From</span>
            <div className="relative flex-1">
              <input type="date" value={filterDateFrom} max={filterDateTo || undefined}
                onChange={e => setFilterDateFrom(e.target.value)}
                className="w-full px-3 py-1.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-emerald-500/40"
                style={{ fontSize: "0.75rem", fontFamily: "inherit", paddingRight: filterDateFrom ? "1.75rem" : undefined }}
              />
              {filterDateFrom && (
                <button
                  onClick={() => setFilterDateFrom("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700 transition-colors"
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 1 }}
                  title="Clear date"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
            <span className="text-zinc-500 shrink-0" style={{ fontSize: "0.7rem" }}>To</span>
            <div className="relative flex-1">
              <input type="date" value={filterDateTo} min={filterDateFrom || undefined}
                onChange={e => setFilterDateTo(e.target.value)}
                className="w-full px-3 py-1.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-emerald-500/40"
                style={{ fontSize: "0.75rem", fontFamily: "inherit", paddingRight: filterDateTo ? "1.75rem" : undefined }}
              />
              {filterDateTo && (
                <button
                  onClick={() => setFilterDateTo("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700 transition-colors"
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 1 }}
                  title="Clear date"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
          <span className="ml-auto text-zinc-500 shrink-0" style={{ fontSize: "0.72rem" }}>
            {filtered.length} of {orders.length}
          </span>
          {(filterCreatedBy || filterDateFrom || filterDateTo) && (
            <button
              onClick={() => { setFilterCreatedBy(""); setFilterDateFrom(""); setFilterDateTo(""); }}
              className="px-3 py-1.5 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:border-black/20 transition-all"
              style={{ fontSize: "0.72rem", background: "none", fontFamily: "inherit", cursor: "pointer", whiteSpace: "nowrap" }}
            >
              Clear all
            </button>
          )}
        </div>
      )}

      {/* Order list */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-zinc-500" style={{ fontSize: "0.85rem" }}>
          <Loader2 className="w-5 h-5 animate-spin mr-2 text-emerald-400" /> Loading confirmed orders…
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-12 text-center">
          <ClipboardList className="w-10 h-10 text-zinc-600 mx-auto mb-3" />
          <p className="text-zinc-600 font-medium" style={{ fontSize: "0.9rem" }}>No orders in procurement yet</p>
          <p className="text-zinc-600 mt-1" style={{ fontSize: "0.75rem" }}>
            Orders appear here automatically once an invoice is <span className="text-emerald-400 font-semibold">Confirmed</span>.
          </p>
        </div>
      ) : (
        <div>
        {/* Select all / deselect all bar */}
        {filtered.length > 0 && (
          <div className="flex items-center gap-3 mb-2 px-1">
            <button
              onClick={() => setSelectedIds(selectedIds.size === filtered.length ? new Set() : new Set(filtered.map(o => o.id)))}
              className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-900 transition-colors"
              style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}
            >
              <CheckSquare className={`w-3.5 h-3.5 ${selectedIds.size === filtered.length && filtered.length > 0 ? "text-emerald-400" : "text-zinc-400"}`} />
              {selectedIds.size === filtered.length && filtered.length > 0 ? "Deselect all" : "Select all"}
            </button>
            {selectedIds.size > 0 && (
              <span className="text-xs text-emerald-400 font-medium">{selectedIds.size} selected</span>
            )}
          </div>
        )}

        <div
          ref={orderListRef}
          className="space-y-2 overflow-y-auto pr-1"
          style={orderListMaxH ? { maxHeight: orderListMaxH } : undefined}
        >
          {filtered.map(order => {
            const isExpanded = expandedOrder === order.id;
            const orderStages = stages[order.id] || defaultStages();
            const ps = order.payment_status;
            const amtPaid = 0;
            const amtOutstanding = Number(order.grand_total || 0);
            const payDisplay = payLabel(ps, amtPaid);
            const isSelected = selectedIds.has(order.id);

            return (
              <div key={order.id} className={`rounded-xl border overflow-hidden transition-all ${isSelected ? "border-emerald-500/30 bg-emerald-500/[0.02]" : "border-emerald-500/10 bg-black/[0.02]"}`}>
                {/* Collapsed row */}
                <div className="flex items-center gap-3 px-4 py-3.5 hover:bg-black/[0.03] transition-all">
                  {/* Checkbox */}
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleSelect(order.id); }}
                    className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition-all ${
                      isSelected ? "bg-emerald-500 border-emerald-500" : "border-black/20 hover:border-emerald-400/50"
                    }`}
                    style={{ background: isSelected ? "#10b981" : "none", cursor: "pointer", padding: 0 }}
                  >
                    {isSelected && (
                      <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                        <path d="M1 3.5L3.8 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </button>
                  <div
                    className="flex-1 min-w-0 space-y-1 cursor-pointer"
                    onClick={(e) => { e.stopPropagation(); setExpandedOrder(isExpanded ? null : order.id); }}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-zinc-900 font-medium" style={{ fontSize: "0.82rem" }}>{order.order_number}</span>
                        <span className="text-zinc-500" style={{ fontSize: "0.65rem" }}>
                          {new Date(order.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                        </span>
                        {/* Payment badge always visible */}
                        <span className={`px-1.5 py-0.5 rounded-full border text-[0.55rem] font-bold ${payColor(payDisplay)}`}>
                          {payDisplay}
                        </span>
                      </div>
                      <div className="text-right">
                        <div className="text-zinc-900 font-bold" style={{ fontSize: "0.9rem" }}>{fmt(Number(order.grand_total))}</div>
                          <div className="text-zinc-500" style={{ fontSize: "0.6rem" }}>
                            {(order.order_items || []).length} item{(order.order_items || []).length !== 1 ? "s" : ""}
                              {order.created_by && creatorNames[order.created_by] && <span> · by {creatorNames[order.created_by]}</span>}
                          </div>
                          {orderNetWeight(order) > 0 && (
                            <div className="text-zinc-400 font-medium" style={{ fontSize: "0.58rem" }}>
                              {orderNetWeight(order)} KG
                            </div>
                          )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-zinc-700 truncate" style={{ fontSize: "0.78rem" }}>{order.buyer?.name || "—"}</span>
                      {/* Stage badges */}
                      <span className={`hidden sm:inline px-1.5 py-0.5 rounded-full border text-[0.55rem] font-medium ${mfgColor(orderStages.manufacturing)}`}>
                        {orderStages.manufacturing}
                      </span>
                    </div>
                  </div>

                  <ChevronRight
                    className={`w-4 h-4 text-zinc-500 shrink-0 transition-transform cursor-pointer ${isExpanded ? "rotate-90" : ""}`}
                    onClick={(e) => { e.stopPropagation(); setExpandedOrder(isExpanded ? null : order.id); }}
                  />
                </div>

                {/* Expanded section */}
                {isExpanded && (
                  <div className="border-t border-black/[0.06] px-5 py-4 bg-black/[0.01] space-y-4">

                    {/* Creator */}
                    {order.created_by && creatorNames[order.created_by] && (
                      <div className="text-zinc-500" style={{ fontSize: "0.72rem" }}>
                        Taken by: <span className="text-zinc-700 font-medium">{creatorNames[order.created_by]}</span>
                      </div>
                    )}

                      {/* Order items */}
                    <div>
                      <div className="text-zinc-500 mb-2" style={{ fontSize: "0.68rem", letterSpacing: "0.05em" }}>ORDER ITEMS</div>
                      <div className="space-y-1.5">
                        {(order.order_items || []).map(item => (
                          <div key={item.id} className="flex items-center gap-3 p-2.5 rounded-lg border border-black/[0.04] bg-black/[0.02]">
                            <Package className="w-4 h-4 text-emerald-400/60 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="text-zinc-900" style={{ fontSize: "0.78rem" }}>{item.products?.name || "—"}</div>
                              <div className="text-zinc-500 font-mono" style={{ fontSize: "0.6rem" }}>{item.products?.sku}</div>
                            </div>
                            <div className="text-right">
                              <div className="text-zinc-700" style={{ fontSize: "0.78rem" }}>Qty: {item.quantity}</div>
                              <div className="text-zinc-500" style={{ fontSize: "0.65rem" }}>{fmt(Number(item.unit_price))} each</div>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="mt-3 pt-3 border-t border-black/[0.06] flex justify-between">
                        <span className="text-zinc-600" style={{ fontSize: "0.75rem" }}>Order Total</span>
                        <span className="text-zinc-900 font-bold" style={{ fontSize: "0.85rem" }}>{fmt(Number(order.grand_total))}</span>
                      </div>
                    </div>

                  </div>
                )}
              </div>
            );
          })}
        </div>
        </div>
      )}

      {/* ── Delivery Lots Section ─────────────────────────────────────── */}
      <div className="mt-10">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-8 h-8 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
            <Truck className="w-4 h-4 text-blue-400" />
          </div>
          <h2 className="text-zinc-900 font-semibold" style={{ fontSize: "1.05rem" }}>Lots</h2>
          <span className="px-2 py-0.5 rounded-full bg-black/[0.04] border border-black/[0.06] text-zinc-500 font-medium" style={{ fontSize: "0.68rem" }}>
            {lots.filter(lot => {
              const count = lot.order_ids.length;
              if (count === 0) return true;
              const completed = lot.order_ids.filter(oid => (stages[oid]?.manufacturing || "Not Started") === "Completed").length;
              return completed < count;
            }).length}
          </span>
        </div>

        {lots.filter(lot => {
          const count = lot.order_ids.length;
          if (count === 0) return true;
          const completed = lot.order_ids.filter(oid => (stages[oid]?.manufacturing || "Not Started") === "Completed").length;
          return completed < count;
        }).length === 0 ? (
          <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-10 text-center">
            <Layers className="w-8 h-8 text-zinc-600 mx-auto mb-2" />
            <p className="text-zinc-600 font-medium" style={{ fontSize: "0.85rem" }}>No active lots</p>
            <p className="text-zinc-400 mt-1" style={{ fontSize: "0.72rem" }}>Select orders above and click <span className="text-emerald-400 font-semibold">Combine into Lot</span> to create one.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {lots.filter(lot => {
              // Hide lots that are 100% manufactured — they move to Manufactured Lots section
              const count = lot.order_ids.length;
              if (count === 0) return true;
              const completed = lot.order_ids.filter(oid => (stages[oid]?.manufacturing || "Not Started") === "Completed").length;
              return completed < count;
            }).map(lot => {
              const isLotExpanded = expandedLot === lot.id;
              const lotOrders = orders.filter(o => lot.order_ids.includes(o.id));
              const lotTotal = lotOrders.reduce((s, o) => s + Number(o.grand_total), 0);
              const lotOrderCount = lot.order_ids.length;
              const lotCompletedCount = lot.order_ids.filter(oid => (stages[oid]?.manufacturing || "Not Started") === "Completed").length;
              const lotInProgressCount = lot.order_ids.filter(oid => (stages[oid]?.manufacturing || "Not Started") === "In Progress").length;
              const lotPct = lotOrderCount > 0 ? Math.round((lotCompletedCount / lotOrderCount) * 100) : 0;
              const lotInPct = lotOrderCount > 0 ? Math.round((lotInProgressCount / lotOrderCount) * 100) : 0;
              return (
                <div key={lot.id} className="rounded-xl border border-black/[0.07] bg-white overflow-hidden">
                  {/* Collapsed row */}
                  <div
                    className="flex items-center gap-3 px-4 py-3.5 hover:bg-black/[0.02] transition-all cursor-pointer"
                    onClick={() => setExpandedLot(isLotExpanded ? null : lot.id)}
                  >
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-zinc-900 font-semibold" style={{ fontSize: "0.85rem" }}>{lot.name || lot.lot_number}</span>
                          <span className="text-zinc-400 font-mono" style={{ fontSize: "0.65rem" }}>{lot.lot_number}</span>
                          <span className={`px-1.5 py-0.5 rounded-full border text-[0.55rem] font-bold ${lotStatusColor(lot.status)}`}>
                            {lot.status}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                          {lot.destination && (
                            <span className="flex items-center gap-1 text-zinc-500" style={{ fontSize: "0.68rem" }}>
                              <MapPin className="w-3 h-3" /> {lot.destination}
                            </span>
                          )}
                          {lot.vehicle_no && (
                            <span className="text-zinc-500" style={{ fontSize: "0.68rem" }}>
                              <Truck className="w-3 h-3 inline mr-0.5" />{lot.vehicle_no}
                            </span>
                          )}
                          <span className="text-zinc-400" style={{ fontSize: "0.68rem" }}>
                            {new Date(lot.dispatch_date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                          </span>
                          <span className="text-zinc-500" style={{ fontSize: "0.68rem" }}>
                            {lot.order_ids.length} order{lot.order_ids.length !== 1 ? "s" : ""}
                            {lotTotal > 0 && <span className="text-zinc-700 font-semibold ml-1">{fmt(lotTotal)}</span>}
                          </span>
                        </div>
                      {/* Manufacturing progress bar — hidden when expanded */}
                      {!isLotExpanded && <div className="mt-2 flex items-center gap-2">
                        <div className="relative flex-1 h-1.5 rounded-full bg-black/[0.06] overflow-hidden">
                          <div className="absolute left-0 top-0 h-full rounded-full transition-all duration-500"
                            style={{ width: `${lotPct + lotInPct}%`, background: "rgba(245,158,11,0.35)" }} />
                          <div className="absolute left-0 top-0 h-full rounded-full transition-all duration-500"
                            style={{
                              width: `${lotPct}%`,
                              background: lotPct === 100 ? "linear-gradient(90deg,#10b981,#059669)" : "linear-gradient(90deg,#10b981,#34d399)"
                            }} />
                        </div>
                        <span
                          className={`shrink-0 font-semibold ${lotPct === 100 ? "text-emerald-400" : lotPct > 0 ? "text-amber-400" : "text-zinc-400"}`}
                          style={{ fontSize: "0.62rem" }}
                        >
                          {lotCompletedCount}/{lotOrderCount} · {lotPct}%
                        </span>
                      </div>}
                    </div>
                    <ChevronRight className={`w-4 h-4 text-zinc-400 shrink-0 transition-transform ${isLotExpanded ? "rotate-90" : ""}`} />
                  </div>

                  {/* Expanded */}
                  {isLotExpanded && (
                    <div className="border-t border-black/[0.05] px-5 py-4 bg-black/[0.01] space-y-4">
                      {/* Manufacturing status */}
                      {lot.order_ids.length > 0 && (() => {
                        const total = lot.order_ids.length;
                        const completedCount = lot.order_ids.filter(oid => (stages[oid]?.manufacturing || "Not Started") === "Completed").length;
                        const inProgressCount = lot.order_ids.filter(oid => (stages[oid]?.manufacturing || "Not Started") === "In Progress").length;
                        const pct = total > 0 ? Math.round((completedCount / total) * 100) : 0;
                        const inProgressPct = total > 0 ? Math.round((inProgressCount / total) * 100) : 0;
                        return (
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <div className="text-zinc-400" style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Manufacturing Status</div>
                              <div className="flex items-center gap-2">
                                <span className="text-zinc-500" style={{ fontSize: "0.65rem" }}>
                                  {completedCount}/{total} completed
                                </span>
                                <span
                                  className={`font-bold ${pct === 100 ? "text-emerald-400" : pct > 0 ? "text-amber-400" : "text-zinc-500"}`}
                                  style={{ fontSize: "0.78rem" }}
                                >
                                  {pct}%
                                </span>
                              </div>
                            </div>
                            {/* Progress bar */}
                            <div className="relative h-2 rounded-full bg-black/[0.06] overflow-hidden mb-3">
                              {/* In Progress segment (amber) behind completed */}
                              <div
                                className="absolute left-0 top-0 h-full rounded-full transition-all duration-500"
                                style={{
                                  width: `${pct + inProgressPct}%`,
                                  background: "rgba(245,158,11,0.35)",
                                }}
                              />
                              {/* Completed segment (emerald) */}
                              <div
                                className="absolute left-0 top-0 h-full rounded-full transition-all duration-500"
                                style={{
                                  width: `${pct}%`,
                                  background: pct === 100
                                    ? "linear-gradient(90deg,#10b981,#059669)"
                                    : "linear-gradient(90deg,#10b981,#34d399)",
                                }}
                              />
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {lot.order_ids.map(oid => {
                                const meta = lot.order_meta?.[oid];
                                const o = allOrdersMap.get(oid);
                                const invoiceNum = meta?.invoice_number || o?.order_number || oid.slice(0, 8) + "…";
                                const manufacturing = stages[oid]?.manufacturing || defaultStages().manufacturing;
                                return (
                                  <div key={oid} className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${mfgColor(manufacturing)}`}>
                                    <Factory className="w-3.5 h-3.5" />
                                    <span className="text-zinc-800 font-mono" style={{ fontSize: "0.68rem" }}>{invoiceNum}</span>
                                    <span className="font-semibold" style={{ fontSize: "0.66rem" }}>{manufacturing}</span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}

                      {/* Orders in this lot */}
                      {lot.order_ids.length > 0 && (
                        <div>
                          <div className="text-zinc-400 mb-2" style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Orders in this lot</div>
                          <div className="space-y-1.5">
                              {lot.order_ids.map(oid => {
                                const meta = lot.order_meta?.[oid];
                                const o = allOrdersMap.get(oid);
                                const invoiceNum = meta?.invoice_number || o?.order_number || oid.slice(0, 8) + "…";
                                const partyName = meta?.party_name || o?.buyer?.name || "";
                                const total = meta?.grand_total ?? (o ? Number(o.grand_total) : null);
                                const isOrderExpanded = expandedLotOrder === oid;
                                return (
                                  <div key={oid} className={`rounded-lg border overflow-hidden transition-all ${isOrderExpanded ? "border-blue-500/20 bg-blue-500/[0.02]" : "border-black/[0.04] bg-black/[0.02]"}`}>
                                    <div className="flex items-center gap-3 px-3 py-2.5">
                                      <Package className="w-3.5 h-3.5 text-blue-400/60 shrink-0" />
                                      <span className="text-zinc-900 font-mono font-semibold" style={{ fontSize: "0.78rem" }}>{invoiceNum}</span>
                                      {partyName && <span className="text-zinc-500 truncate flex-1" style={{ fontSize: "0.7rem" }}>{partyName}</span>}
                                      {total !== null && <span className="text-zinc-700 font-semibold shrink-0" style={{ fontSize: "0.75rem" }}>{fmt(total)}</span>}
                                      <button
                                        onClick={() => setExpandedLotOrder(isOrderExpanded ? null : oid)}
                                        className={`flex items-center gap-1 px-2 py-1 rounded-md border transition-all shrink-0 ${
                                          isOrderExpanded
                                            ? "border-blue-500/30 text-blue-500 bg-blue-500/10"
                                            : "border-black/10 text-zinc-400 hover:text-zinc-700 hover:border-black/20"
                                        }`}
                                        style={{ fontSize: "0.6rem", background: isOrderExpanded ? undefined : "none", fontFamily: "inherit", cursor: "pointer" }}
                                        title="View order details"
                                      >
                                        <Eye className="w-3 h-3" />
                                        <span className="hidden sm:inline">{isOrderExpanded ? "Hide" : "Details"}</span>
                                      </button>
                                    </div>
                                    {/* Manufacturing stage buttons */}
                                    <div className="flex items-center gap-1.5 px-3 pb-2.5 pl-9">
                                      <span className="text-zinc-400 shrink-0" style={{ fontSize: "0.58rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Mfg:</span>
                                      {(["Not Started", "In Progress", "Completed"] as ManufacturingStage[]).map(s => {
                                        const active = (stages[oid]?.manufacturing || "Not Started") === s;
                                        return (
                                          <button
                                            key={s}
                                            onClick={(e) => { e.stopPropagation(); updateStage(oid, "manufacturing", s); }}
                                            className={`px-2 py-0.5 rounded-full border font-semibold transition-all ${active ? mfgColor(s) : "border-black/10 text-zinc-400 hover:border-black/20 hover:text-zinc-600"}`}
                                            style={{ fontSize: "0.58rem", background: "none", fontFamily: "inherit", cursor: "pointer" }}
                                          >
                                            {s}
                                          </button>
                                        );
                                      })}
                                    </div>
                                    {/* Expanded order details */}
                                    {isOrderExpanded && o && (
                                      <div className="border-t border-black/[0.06] px-4 py-3 bg-white/60 space-y-3">
                                        {/* Order info */}
                                        <div className="flex flex-wrap gap-x-6 gap-y-1" style={{ fontSize: "0.72rem" }}>
                                          <div>
                                            <span className="text-zinc-400">Party: </span>
                                            <span className="text-zinc-800 font-medium">{o.buyer?.name || "—"}</span>
                                            {o.buyer?.party_code && <span className="text-zinc-400 ml-1">({o.buyer.party_code})</span>}
                                          </div>
                                          <div>
                                            <span className="text-zinc-400">Date: </span>
                                            <span className="text-zinc-800 font-medium">{new Date(o.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</span>
                                          </div>
                                          {o.created_by && creatorNames[o.created_by] && (
                                            <div>
                                              <span className="text-zinc-400">Taken by: </span>
                                              <span className="text-zinc-800 font-medium">{creatorNames[o.created_by]}</span>
                                            </div>
                                          )}
                                          <div>
                                            <span className="text-zinc-400">Status: </span>
                                            <span className="text-zinc-800 font-medium">{o.status}</span>
                                          </div>
                                        </div>
                                        {/* Order items table */}
                                        <div>
                                          <div className="text-zinc-400 mb-1.5" style={{ fontSize: "0.6rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Ordered Items</div>
                                          <div className="rounded-lg border border-black/[0.06] overflow-hidden">
                                            <table className="w-full" style={{ fontSize: "0.72rem" }}>
                                              <thead>
                                                <tr className="bg-black/[0.03] border-b border-black/[0.06]">
                                                  <th className="text-left px-3 py-2 text-zinc-500 font-medium">#</th>
                                                  <th className="text-left px-3 py-2 text-zinc-500 font-medium">Product</th>
                                                  <th className="text-left px-3 py-2 text-zinc-500 font-medium">SKU</th>
                                                  <th className="text-right px-3 py-2 text-zinc-500 font-medium">Qty</th>
                                                  <th className="text-right px-3 py-2 text-zinc-500 font-medium">Unit Price</th>
                                                  <th className="text-right px-3 py-2 text-zinc-500 font-medium">Total</th>
                                                </tr>
                                              </thead>
                                              <tbody>
                                                {(o.order_items || []).map((item, idx) => (
                                                  <tr key={item.id} className="border-b border-black/[0.04] last:border-b-0">
                                                    <td className="px-3 py-2 text-zinc-400">{idx + 1}</td>
                                                    <td className="px-3 py-2 text-zinc-900 font-medium">{item.products?.name || "—"}</td>
                                                    <td className="px-3 py-2 text-zinc-500 font-mono">{item.products?.sku || "—"}</td>
                                                    <td className="px-3 py-2 text-right text-zinc-800">{item.quantity}</td>
                                                    <td className="px-3 py-2 text-right text-zinc-600">{fmt(Number(item.unit_price))}</td>
                                                    <td className="px-3 py-2 text-right text-zinc-900 font-semibold">{fmt(Number(item.unit_price) * item.quantity)}</td>
                                                  </tr>
                                                ))}
                                              </tbody>
                                            </table>
                                          </div>
                                          <div className="flex justify-between items-center mt-2 pt-2 border-t border-black/[0.06]">
                                            <span className="text-zinc-500" style={{ fontSize: "0.72rem" }}>
                                              {(o.order_items || []).length} item{(o.order_items || []).length !== 1 ? "s" : ""}
                                            </span>
                                            <span className="text-zinc-900 font-bold" style={{ fontSize: "0.85rem" }}>
                                              Grand Total: {fmt(Number(o.grand_total))}
                                            </span>
                                          </div>
                                        </div>
                                      </div>
                                    )}
                                    {isOrderExpanded && !o && (
                                      <div className="border-t border-black/[0.06] px-4 py-4 text-center">
                                        <p className="text-zinc-400" style={{ fontSize: "0.72rem" }}>Order details not available — order may have been updated or removed.</p>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                          </div>
                        </div>
                      )}

                        {/* Lot details */}
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                          {lot.driver_name && (
                          <div className="rounded-lg border border-black/[0.05] bg-black/[0.02] px-3 py-2">
                            <div className="text-zinc-400" style={{ fontSize: "0.6rem", textTransform: "uppercase" }}>Driver</div>
                            <div className="text-zinc-800 font-medium" style={{ fontSize: "0.78rem" }}>{lot.driver_name}</div>
                          </div>
                        )}
                        {lot.vehicle_no && (
                          <div className="rounded-lg border border-black/[0.05] bg-black/[0.02] px-3 py-2">
                            <div className="text-zinc-400" style={{ fontSize: "0.6rem", textTransform: "uppercase" }}>Vehicle</div>
                            <div className="text-zinc-800 font-medium" style={{ fontSize: "0.78rem" }}>{lot.vehicle_no}</div>
                          </div>
                        )}
                        {lot.destination && (
                          <div className="rounded-lg border border-black/[0.05] bg-black/[0.02] px-3 py-2">
                            <div className="text-zinc-400" style={{ fontSize: "0.6rem", textTransform: "uppercase" }}>Destination</div>
                            <div className="text-zinc-800 font-medium" style={{ fontSize: "0.78rem" }}>{lot.destination}</div>
                          </div>
                        )}
                      </div>

                        {/* Combined category-wise product summary */}
                        {lot.order_ids.length > 0 && (() => {
                          const summary = buildCombinedOutputSummary(lot, allOrdersMap);
                          if (!summary) return null;

                          return (
                            <div>
                              <div className="flex flex-col gap-2 mb-2">
                                <div className="flex items-center justify-between gap-3 flex-wrap">
                                  <div className="text-zinc-400" style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Combined Output — Category Wise</div>
                                  <div className="flex items-center gap-3 flex-wrap">
                                    <span className="text-zinc-500" style={{ fontSize: "0.65rem" }}>{summary.totalItems} product{summary.totalItems !== 1 ? "s" : ""}</span>
                                    {summary.totalWeight > 0 && <span className="text-zinc-500" style={{ fontSize: "0.65rem" }}>{summary.totalWeight} KG</span>}
                                    <span className="text-zinc-700 font-bold" style={{ fontSize: "0.75rem" }}>{fmt(summary.totalValue)}</span>
                                  </div>
                                </div>

                                <div className="flex items-center justify-between gap-3 flex-wrap rounded-xl border border-emerald-500/15 bg-emerald-500/[0.04] px-3.5 py-2.5">
                                  <div>
                                    <div className="text-zinc-900 font-semibold" style={{ fontSize: "0.76rem" }}>Printable combined list is ready here</div>
                                    <div className="text-zinc-500" style={{ fontSize: "0.68rem" }}>Use this button to print the category-wise output or save it as PDF.</div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => printCombinedOutput(lot)}
                                    className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-white px-3 py-2 text-emerald-700 hover:bg-emerald-50 transition-all"
                                    style={{ fontSize: "0.72rem", fontFamily: "inherit", fontWeight: 700, cursor: "pointer" }}
                                  >
                                    <Printer className="w-3.5 h-3.5" />
                                    Print / Save PDF
                                  </button>
                                </div>
                              </div>
                              <div className="rounded-xl border border-black/[0.06] overflow-hidden">
                                {summary.categories.map((category, catIdx) => {
                                  return (
                                    <div key={category.categoryId} className={catIdx > 0 ? "border-t border-black/[0.06]" : ""}>
                                      {/* Category header */}
                                      <div className="flex items-center justify-between px-3.5 py-2.5 bg-black/[0.03]">
                                        <div className="flex items-center gap-2">
                                          <div className="w-2 h-2 rounded-full bg-emerald-400/60"></div>
                                          <span className="text-zinc-800 font-semibold" style={{ fontSize: "0.78rem" }}>{category.categoryName}</span>
                                          <span className="text-zinc-400" style={{ fontSize: "0.62rem" }}>{category.products.length} product{category.products.length !== 1 ? "s" : ""}</span>
                                        </div>
                                        <div className="flex items-center gap-3">
                                          <span className="text-zinc-500" style={{ fontSize: "0.65rem" }}>Qty: {category.totalQty}</span>
                                          {category.totalWeight > 0 && <span className="text-zinc-500" style={{ fontSize: "0.65rem" }}>{category.totalWeight} KG</span>}
                                          <span className="text-zinc-700 font-semibold" style={{ fontSize: "0.72rem" }}>{fmt(category.totalValue)}</span>
                                        </div>
                                      </div>
                                      {/* Products under this category */}
                                      <div>
                                        {category.products.map((prod, pIdx) => (
                                          <div key={prod.sku + pIdx} className={`flex items-center gap-3 px-3.5 py-2 ${pIdx > 0 ? "border-t border-black/[0.03]" : ""}`}>
                                            <Package className="w-3.5 h-3.5 text-zinc-400/50 shrink-0" />
                                            <div className="flex-1 min-w-0">
                                              <span className="text-zinc-800" style={{ fontSize: "0.75rem" }}>{prod.name}</span>
                                              <span className="text-zinc-400 font-mono ml-2" style={{ fontSize: "0.6rem" }}>{prod.sku}</span>
                                            </div>
                                            <div className="flex items-center gap-4 shrink-0">
                                              <span className="text-zinc-600" style={{ fontSize: "0.72rem" }}>x{prod.totalQty}</span>
                                              {prod.totalWeight > 0 && <span className="text-zinc-400" style={{ fontSize: "0.65rem" }}>{prod.totalWeight} {prod.unit}</span>}
                                              <span className="text-zinc-700 font-semibold" style={{ fontSize: "0.72rem", minWidth: "5rem", textAlign: "right" }}>{fmt(prod.totalValue)}</span>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  );
                                })}
                                {/* Grand totals footer */}
                                <div className="flex items-center justify-between px-3.5 py-2.5 bg-black/[0.04] border-t border-black/[0.08]">
                                  <span className="text-zinc-600 font-semibold" style={{ fontSize: "0.72rem" }}>Total ({summary.totalQty} units)</span>
                                  <div className="flex items-center gap-3">
                                    {summary.totalWeight > 0 && <span className="text-zinc-500 font-medium" style={{ fontSize: "0.68rem" }}>{summary.totalWeight} KG</span>}
                                    <span className="text-zinc-900 font-bold" style={{ fontSize: "0.82rem" }}>{fmt(summary.totalValue)}</span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })()}

                      {lot.notes && (
                        <div className="text-zinc-500 px-3 py-2 rounded-lg bg-amber-500/5 border border-amber-500/15" style={{ fontSize: "0.72rem" }}>
                          <span className="font-semibold text-amber-500">Note: </span>{lot.notes}
                        </div>
                      )}

                      {/* Delete lot */}
                      <div className="flex justify-end pt-1">
                        <button
                          onClick={() => { if (confirm(`Delete lot ${lot.lot_number}?`)) removeLot(lot.id); }}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/20 text-red-400 hover:bg-red-500/10 transition-all"
                          style={{ fontSize: "0.7rem", background: "none", fontFamily: "inherit", cursor: "pointer" }}
                        >
                          <X className="w-3 h-3" /> Delete Lot
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Manufactured Lots Section ─────────────────────────────────── */}
      {(() => {
        const manufacturedLots = lots.filter(lot => {
          const count = lot.order_ids.length;
          if (count === 0) return false;
          const completed = lot.order_ids.filter(oid => (stages[oid]?.manufacturing || "Not Started") === "Completed").length;
          return completed === count;
        });
        if (manufacturedLots.length === 0) return null;
        return (
          <div className="mt-10">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-8 h-8 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              </div>
              <h2 className="text-zinc-900 font-semibold" style={{ fontSize: "1.05rem" }}>Manufactured Lots</h2>
              <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 font-medium" style={{ fontSize: "0.68rem" }}>
                {manufacturedLots.length}
              </span>
              <span className="text-zinc-400" style={{ fontSize: "0.72rem" }}>Manufacturing complete — ready to dispatch</span>
            </div>
            <div
              className="space-y-2 overflow-y-auto pr-1"
              style={{ maxHeight: "356px" }}
            >
              {manufacturedLots.map(lot => {
                const metaTotals = Object.values(lot.order_meta || {}).reduce((s, m) => s + (m.grand_total || 0), 0);
                const liveTotals = orders.filter(o => lot.order_ids.includes(o.id)).reduce((s, o) => s + Number(o.grand_total), 0);
                const lotTotal = liveTotals || metaTotals;
                return (
                  <div key={lot.id} className="rounded-xl border border-emerald-500/20 bg-white overflow-hidden">
                    <div className="flex items-center gap-3 px-4 py-3.5">
                      <div className="w-7 h-7 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-zinc-900 font-semibold" style={{ fontSize: "0.85rem" }}>{lot.name || lot.lot_number}</span>
                            <span className="text-zinc-400 font-mono" style={{ fontSize: "0.65rem" }}>{lot.lot_number}</span>
                          <span className={`px-1.5 py-0.5 rounded-full border text-[0.55rem] font-bold ${lotStatusColor(lot.status)}`}>{lot.status}</span>
                        </div>
                        <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                          <span className="text-zinc-400" style={{ fontSize: "0.68rem" }}>
                            {new Date(lot.dispatch_date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                          </span>
                          <span className="text-zinc-500" style={{ fontSize: "0.68rem" }}>
                            {lot.order_ids.length} order{lot.order_ids.length !== 1 ? "s" : ""}
                          </span>
                          {lotTotal > 0 && <span className="text-zinc-700 font-semibold" style={{ fontSize: "0.68rem" }}>{fmt(lotTotal)}</span>}
                          <span className="text-emerald-500 font-semibold" style={{ fontSize: "0.65rem" }}>✓ 100% Manufactured</span>
                        </div>
                      </div>
                      {lot.status === "OPEN" ? (
                        <button
                          onClick={() => changeLotStatus(lot.id, "READY")}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-semibold text-white transition-all shrink-0"
                          style={{
                            fontSize: "0.7rem",
                            background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
                            border: "none",
                            cursor: "pointer",
                            fontFamily: "inherit",
                          }}
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Mark as Completed
                        </button>
                      ) : (
                        <span className={`px-2.5 py-1 rounded-xl border text-xs font-semibold ${lotStatusColor(lot.status)}`}>
                          {lot.status === "READY" ? "✓ Completed" : lot.status}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ── Floating "Combine into Lot" bar ───────────────────────────── */}
      {selectedIds.size > 0 && !lotModal && (
        <div
          className="fixed bottom-6 left-1/2 z-40 flex items-center gap-4 px-5 py-3.5 rounded-2xl shadow-2xl"
          style={{
            transform: "translateX(-50%)",
            background: "linear-gradient(135deg, #065f46 0%, #064e3b 100%)",
            border: "1px solid rgba(16,185,129,0.4)",
            boxShadow: "0 8px 32px rgba(16,185,129,0.25), 0 2px 8px rgba(0,0,0,0.3)",
          }}
        >
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-400/20 flex items-center justify-center shrink-0">
              <Layers className="w-4 h-4 text-emerald-300" />
            </div>
            <div>
            <div className="text-emerald-100 font-semibold text-sm leading-tight">
                  {selectedIds.size} order{selectedIds.size !== 1 ? "s" : ""} selected
                </div>
                <div className="text-emerald-400/70 text-xs">
                  {fmt(orders.filter(o => selectedIds.has(o.id)).reduce((s, o) => s + Number(o.grand_total), 0))} total value
                  {(() => {
                    const totalWeight = orders.filter(o => selectedIds.has(o.id)).reduce((s, o) => s + orderNetWeight(o), 0);
                    return totalWeight > 0 ? <span className="ml-1.5 text-emerald-300/80">· {totalWeight} KG</span> : null;
                  })()}
                </div>
            </div>
          </div>
          <div className="flex items-center gap-2 ml-2">
            <button
              onClick={() => setSelectedIds(new Set())}
              className="p-2 rounded-lg text-emerald-400/60 hover:text-emerald-300 hover:bg-white/10 transition-all"
              style={{ background: "none", border: "none", cursor: "pointer" }}
              title="Clear selection"
            >
              <X className="w-4 h-4" />
            </button>
            <button
              onClick={openLotModal}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-sm transition-all"
              style={{
                background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
                border: "1px solid rgba(16,185,129,0.5)",
                color: "#ffffff",
                cursor: "pointer",
                fontFamily: "inherit",
                boxShadow: "0 2px 8px rgba(16,185,129,0.4)",
              }}
            >
              <Truck className="w-4 h-4" />
              Combine into Lot
            </button>
          </div>
        </div>
      )}

      {/* ── Create Lot Modal ───────────────────────────────────────────── */}
      {lotModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}>
          <div className="w-full max-w-md rounded-2xl border border-black/[0.08] bg-white shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="px-6 py-5 border-b border-black/[0.06]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                    <Layers className="w-5 h-5 text-emerald-400" />
                  </div>
                  <div>
                    <h3 className="text-zinc-900 font-semibold text-base">Combine into Delivery Lot</h3>
                      <p className="text-zinc-500 text-xs mt-0.5">
                        {selectedIds.size} order{selectedIds.size !== 1 ? "s" : ""} · {fmt(orders.filter(o => selectedIds.has(o.id)).reduce((s, o) => s + Number(o.grand_total), 0))}
                        {(() => {
                          const totalWeight = orders.filter(o => selectedIds.has(o.id)).reduce((s, o) => s + orderNetWeight(o), 0);
                          return totalWeight > 0 ? <span className="text-zinc-700 font-semibold"> · {totalWeight} KG</span> : null;
                        })()}
                      </p>
                  </div>
                </div>
                <button onClick={() => setLotModal(false)} className="p-2 rounded-lg text-zinc-500 hover:bg-black/5 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}>
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Selected orders summary */}
            <div className="px-6 pt-4 pb-2">
              <div className="text-[0.65rem] font-semibold text-zinc-500 uppercase tracking-wider mb-2">Selected Orders</div>
                <div className="max-h-28 overflow-y-auto space-y-1">
                  {orders.filter(o => selectedIds.has(o.id)).map(o => {
                    const w = orderNetWeight(o);
                    return (
                      <div key={o.id} className="flex items-center justify-between py-1.5 px-2.5 rounded-lg bg-black/[0.02] border border-black/[0.04]">
                        <div>
                          <span className="text-zinc-900 text-xs font-medium">{o.order_number}</span>
                          <span className="text-zinc-500 text-[0.6rem] ml-2">{o.buyer?.name || "—"}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          {w > 0 && <span className="text-zinc-400 text-[0.6rem]">{w} KG</span>}
                          <span className="text-zinc-700 text-xs font-semibold">{fmt(Number(o.grand_total))}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {/* Combined net weight summary */}
                {(() => {
                  const totalWeight = orders.filter(o => selectedIds.has(o.id)).reduce((s, o) => s + orderNetWeight(o), 0);
                  return totalWeight > 0 ? (
                    <div className="mt-2 flex items-center justify-between px-2.5 py-2 rounded-lg bg-emerald-500/[0.06] border border-emerald-500/15">
                      <span className="text-zinc-500 text-[0.65rem] font-medium">Combined Net Weight</span>
                      <span className="text-emerald-600 text-xs font-bold">{totalWeight} KG</span>
                    </div>
                  ) : null;
                })()}
            </div>

            {/* Form */}
            <div className="px-6 py-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-zinc-600 mb-1">Lot Name *</label>
                <input
                  className="w-full px-3 py-2 rounded-lg border border-black/10 bg-black/[0.02] text-zinc-900 text-sm outline-none focus:border-emerald-400 transition-colors"
                  value={lotForm.name}
                  onChange={e => setLotForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. Batch for North Zone"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-600 mb-1">Notes</label>
                <input
                  className="w-full px-3 py-2 rounded-lg border border-black/10 bg-black/[0.02] text-zinc-900 text-sm outline-none focus:border-emerald-400 transition-colors"
                  value={lotForm.notes}
                  onChange={e => setLotForm(p => ({ ...p, notes: e.target.value }))}
                  placeholder="Optional notes"
                />
              </div>
            </div>

            {/* Actions */}
            <div className="px-6 pb-5 flex gap-3">
              <button
                onClick={() => setLotModal(false)}
                className="flex-1 py-2.5 rounded-xl border border-black/10 text-zinc-600 text-sm hover:bg-black/5 transition-all"
                style={{ background: "none", cursor: "pointer", fontFamily: "inherit" }}
              >
                Cancel
              </button>
              <button
                onClick={handleCreateLot}
                disabled={creatingLot || !lotForm.name.trim()}
                className="flex-1 py-2.5 rounded-xl font-semibold text-sm text-white transition-all disabled:opacity-50"
                style={{ background: "linear-gradient(135deg, #10b981 0%, #059669 100%)", border: "none", cursor: "pointer", fontFamily: "inherit" }}
              >
                {creatingLot ? "Creating…" : "Create Lot"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Partial payment modal */}
      {partialModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)" }}>
          <div className="w-full max-w-sm rounded-2xl border border-black/10 bg-zinc-950 p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-zinc-900 font-semibold" style={{ fontSize: "0.95rem" }}>Partial Payment</h3>
              <button onClick={() => setPartialModal(null)} style={{ background: "none", border: "none", cursor: "pointer" }}>
                <X className="w-5 h-5 text-zinc-600" />
              </button>
            </div>
            <div style={{ fontSize: "0.75rem" }}>
              <div className="text-zinc-500 mb-1">Order total: <span className="text-zinc-900">{fmt(partialModal.grandTotal)}</span></div>
              <label className="block text-zinc-600 mb-1.5">Amount received (₹)</label>
              <input
                type="number"
                value={partialInput}
                onChange={e => setPartialInput(e.target.value)}
                min={0}
                max={partialModal.grandTotal}
                className="w-full px-4 py-2.5 rounded-xl border border-black/10 bg-black/[0.04] text-zinc-900 outline-none focus:border-amber-500/50"
                style={{ fontSize: "0.9rem", fontFamily: "inherit",  }}
                placeholder="0"
                autoFocus
              />
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setPartialModal(null)}
                className="flex-1 py-2 rounded-xl border border-black/10 text-zinc-600 hover:text-zinc-900 transition-all"
                style={{ fontSize: "0.75rem", background: "none", fontFamily: "inherit", cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const amt = Number(partialInput);
                  if (!amt || amt <= 0 || amt > partialModal.grandTotal) return;
                  updatePayment(partialModal.orderId, "PARTIAL", amt);
                  setPartialModal(null);
                }}
                className="flex-1 py-2 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-all"
                style={{ fontSize: "0.75rem", background: undefined, fontFamily: "inherit", cursor: "pointer" }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
