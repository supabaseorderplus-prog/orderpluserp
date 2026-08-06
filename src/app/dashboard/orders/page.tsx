"use client";

import { useEffect, useState, useCallback } from "react";
import { api, getUser } from "@/lib/api";
import { fetchDeliveryLots } from "@/lib/delivery-lots";
import { useVisibleInterval } from "@/lib/hooks/use-visible-interval";
import PlaceOrderModal from "@/components/place-order-modal";
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  Filter,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShoppingCart,
  Truck,
  X,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Order {
  id: string;
  order_number: string;
  order_type: string;
  buyer: { id: string; name: string; party_code: string; party_types: { name: string } | null } | null;
  grand_total: number;
  status: string;
  payment_status: string;
  created_at: string;
  order_items: { id: string; product?: { name: string }; quantity: number; unit_price: number }[];
  notes?: string | null;
  billing_address?: string | null;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

const statusColors: Record<string, string> = {
  PENDING: "bg-amber-500/20 text-amber-400",
  APPROVED: "bg-emerald-500/20 text-emerald-400",
  REJECTED: "bg-red-500/20 text-red-400",
  IN_PROCUREMENT: "bg-blue-500/20 text-blue-400",
  PROCUREMENT: "bg-blue-500/20 text-blue-400",
  DISPATCHED: "bg-violet-500/20 text-violet-400",
  DELIVERED: "bg-emerald-500/20 text-emerald-400",
  CANCELLED: "bg-zinc-500/20 text-zinc-400",
};

const paymentStatusColors: Record<string, string> = {
  UNPAID: "bg-red-500/20 text-red-400",
  PARTIAL: "bg-amber-500/20 text-amber-400",
  PAID: "bg-emerald-500/20 text-emerald-400",
  OVERDUE: "bg-orange-500/20 text-orange-400",
};

const COMPANY_ROLES = new Set(["SALESMAN", "ADMIN", "SUPER_ADMIN", "DRIVER"]);

function getStepIndex(status: string) {
  const normalized = (status === "PROCUREMENT") ? "IN_PROCUREMENT" : status;
  return ["APPROVED", "IN_PROCUREMENT", "DISPATCHED", "DELIVERED"].indexOf(normalized);
}

// ─── Retailer Orders View ─────────────────────────────────────────────────────

function RetailerOrdersPage({ partyId }: { partyId: string }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [tab, setTab] = useState<"in_progress" | "delivered">("in_progress");
  const [orderLotMap, setOrderLotMap] = useState<Record<string, string>>({});
  const [showPlaceOrder, setShowPlaceOrder] = useState(false);

  // Lot → order mapping is independent of the orders list, so fetch it once on
  // mount instead of re-running on every 20s poll (each `orders` change used to
  // trigger another delivery-lots round-trip).
  useEffect(() => {
    fetchDeliveryLots().then(lots => {
      const map: Record<string, string> = {};
      lots.forEach(lot => { lot.order_ids.forEach(oid => { map[oid] = lot.lot_number; }); });
      setOrderLotMap(map);
    }).catch(() => {});
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    api<{ success: boolean; data: Order[] }>(`/api/v1/orders?party_id=${partyId}&limit=1000`)
      .then(res => setOrders(res.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [partyId]);

  useEffect(() => {
    // Paint the orders immediately, then heal any orders stuck in PROCUREMENT
    // (confirmed invoice requests) in the background and refresh once it's done.
    // Previously the first load was blocked behind this heal round-trip, which
    // made the page feel slow to open.
    load();
    api("/api/v1/orders/fix-delivered", { method: "POST", body: {} })
      .then(() => load())
      .catch(() => {});
  }, [load]);

  // Poll for status updates only while the page is visible (paused in background).
  useVisibleInterval(load, 30000);

  useEffect(() => {
    window.addEventListener("orderStatusChanged", load);
    return () => window.removeEventListener("orderStatusChanged", load);
  }, [load]);

  const inProgressOrders = orders.filter(o => ["PENDING", "APPROVED", "PROCUREMENT", "IN_PROCUREMENT", "DISPATCHED"].includes(o.status));
  const deliveredOrders = orders.filter(o => o.status === "DELIVERED");
  const displayOrders = tab === "in_progress" ? inProgressOrders : deliveredOrders;

  const pendingCount = inProgressOrders.filter(o => o.status === "PENDING").length;
  const approvedCount = inProgressOrders.filter(o => o.status === "APPROVED").length;
  const procurementCount = inProgressOrders.filter(o => ["PROCUREMENT", "IN_PROCUREMENT"].includes(o.status)).length;
  const dispatchedCount = inProgressOrders.filter(o => o.status === "DISPATCHED").length;

  const fmt = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      <div className="flex items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">My Orders</h1>
          <p className="text-zinc-500 text-xs mt-0.5">Place a new order or track existing ones</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setShowPlaceOrder(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold text-white transition-all"
            style={{ background: "rgb(59,130,246)", border: "none", cursor: "pointer" }}
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Place Order</span>
            <span className="sm:hidden">Order</span>
          </button>
          <button
            onClick={load}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-zinc-500 hover:text-blue-400 hover:bg-blue-500/10 transition-all"
            style={{ background: "transparent", border: "1px solid rgba(0,0,0,0.08)", cursor: "pointer" }}
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Summary bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-3 mb-6">
        {[
          { label: "Pending", value: pendingCount, color: "text-amber-500", bg: "bg-amber-500/10" },
          { label: "Preparing", value: approvedCount + procurementCount, color: "text-blue-500", bg: "bg-blue-500/10" },
          { label: "Dispatched", value: dispatchedCount, color: "text-violet-500", bg: "bg-violet-500/10" },
          { label: "Delivered", value: deliveredOrders.length, color: "text-emerald-500", bg: "bg-emerald-500/10" },
        ].map(stat => (
          <div key={stat.label} className={`rounded-xl border border-black/[0.06] ${stat.bg} p-3 sm:p-4 text-center`}>
            <div className={`text-xl sm:text-2xl font-bold tabular-nums ${stat.color}`}>{stat.value}</div>
            <div className="text-[0.65rem] text-zinc-500 mt-0.5">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-black/[0.06] mb-4">
        <button
          onClick={() => setTab("in_progress")}
          className={`flex-1 py-2.5 text-xs font-semibold text-center transition-all ${tab === "in_progress" ? "text-blue-500" : "text-zinc-500 hover:text-zinc-700"}`}
          style={{ background: tab === "in_progress" ? "rgba(59,130,246,0.04)" : "transparent", border: "none", borderBottom: tab === "in_progress" ? "2px solid rgb(59,130,246)" : "2px solid transparent", cursor: "pointer" }}
        >
          In Progress ({inProgressOrders.length})
        </button>
        <button
          onClick={() => setTab("delivered")}
          className={`flex-1 py-2.5 text-xs font-semibold text-center transition-all ${tab === "delivered" ? "text-emerald-600" : "text-zinc-500 hover:text-zinc-700"}`}
          style={{ background: tab === "delivered" ? "rgba(16,185,129,0.04)" : "transparent", border: "none", borderBottom: tab === "delivered" ? "2px solid rgb(16,185,129)" : "2px solid transparent", cursor: "pointer" }}
        >
          Delivered ({deliveredOrders.length})
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-20 gap-2">
          <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
          <span className="text-sm text-zinc-500">Loading orders…</span>
        </div>
      ) : displayOrders.length === 0 ? (
        <div className="text-center py-20">
          <ShoppingCart className="w-12 h-12 mx-auto mb-4 text-zinc-300" />
          <p className="text-sm font-medium text-zinc-500 mb-1">
            {tab === "in_progress" ? "No orders in progress" : "No delivered orders yet"}
          </p>
          <p className="text-xs text-zinc-400 mb-4">
            {tab === "in_progress"
              ? "Place an order and track it from approval to delivery."
              : "Orders confirmed as delivered will appear here."}
          </p>
          {tab === "in_progress" && (
            <button
              onClick={() => setShowPlaceOrder(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-white transition-all"
              style={{ background: "rgb(59,130,246)", border: "none", cursor: "pointer" }}
            >
              <Plus className="w-3.5 h-3.5" /> Place your first order
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-black/[0.06] overflow-hidden divide-y divide-black/[0.04]">
          {displayOrders.map(order => {
            const stepIdx = getStepIndex(order.status);
            const isExpanded = expandedId === order.id;
            const isDelivered = order.status === "DELIVERED";
            const isPending = order.status === "PENDING";
            const steps = ["Approved", "In Procurement", "Dispatched", "Delivered"];

            return (
              <div key={order.id} className="px-5 py-4">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-zinc-900">{order.order_number}</span>
                      {orderLotMap[order.id] && (
                        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.6rem] font-semibold bg-amber-500/10 text-amber-600 border border-amber-500/20">
                          <Truck className="w-2.5 h-2.5" />
                          {orderLotMap[order.id]}
                        </span>
                      )}
                      <span className={`px-1.5 py-0.5 rounded text-[0.6rem] font-semibold ${statusColors[order.status] || "bg-zinc-500/20 text-zinc-500"}`}>
                        {order.status.replace(/_/g, " ")}
                      </span>
                    </div>
                    <div className="text-[0.65rem] text-zinc-500 mt-0.5">
                      {new Date(order.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                      {" · "}
                      {order.order_items?.length || 0} item{(order.order_items?.length || 0) !== 1 ? "s" : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-sm font-bold text-zinc-900">{fmt(Number(order.grand_total))}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[0.6rem] font-semibold ${paymentStatusColors[order.payment_status] || "bg-zinc-500/20 text-zinc-500"}`}>
                      {order.payment_status}
                    </span>
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : order.id)}
                      className="w-6 h-6 rounded flex items-center justify-center text-zinc-500 hover:text-zinc-900 transition-colors"
                      style={{ background: "transparent", border: "none", cursor: "pointer" }}
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Awaiting approval (party just placed this order) */}
                {isPending && (
                  <div className="flex items-center gap-1.5 mb-3 px-2.5 py-1.5 rounded-lg bg-amber-500/[0.08] border border-amber-500/20 w-fit">
                    <Clock className="w-3 h-3 text-amber-500" />
                    <span className="text-[0.62rem] font-medium text-amber-600">Awaiting distributor approval</span>
                  </div>
                )}

                {/* Progress stepper */}
                {!isDelivered && !isPending && (
                  <div className="flex items-center gap-0 mb-3">
                    {steps.map((step, i) => {
                      const done = i <= stepIdx;
                      const active = i === stepIdx;
                      return (
                        <div key={step} className="flex items-center flex-1 min-w-0">
                          <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-[0.5rem] font-bold transition-all ${done ? (active ? "bg-blue-500 text-white" : "bg-emerald-500 text-white") : "bg-black/[0.06] text-zinc-500"}`}>
                            {done && !active ? "✓" : i + 1}
                          </div>
                          <div className="flex-1 flex flex-col items-start ml-1 min-w-0">
                            <span className={`text-[0.55rem] font-semibold truncate ${active ? "text-blue-500" : done ? "text-emerald-500" : "text-zinc-400"}`}>{step}</span>
                          </div>
                          {i < steps.length - 1 && (
                            <div className={`h-0.5 w-3 shrink-0 mx-1 rounded-full ${i < stepIdx ? "bg-emerald-400" : "bg-black/[0.08]"}`} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Expanded items */}
                {isExpanded && order.order_items && order.order_items.length > 0 && (
                  <div className="mt-3 rounded-lg bg-black/[0.02] border border-black/[0.05] overflow-hidden">
                    <div className="px-3 py-2 border-b border-black/[0.05]">
                      <span className="text-[0.65rem] font-semibold text-zinc-600 uppercase tracking-wide">Order Items</span>
                    </div>
                    <div className="divide-y divide-black/[0.04]">
                      {order.order_items.map((item, idx) => (
                        <div key={item.id || idx} className="flex items-center justify-between px-3 py-2">
                          <span className="text-xs text-zinc-700">{item.product?.name || `Item ${idx + 1}`}</span>
                          <div className="flex items-center gap-3 text-xs text-zinc-500">
                            <span>×{item.quantity}</span>
                            <span className="font-medium text-zinc-900">{fmt(Number(item.unit_price) * Number(item.quantity))}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <PlaceOrderModal
        partyId={partyId}
        open={showPlaceOrder}
        onClose={() => setShowPlaceOrder(false)}
        onPlaced={() => {
          setTab("in_progress");
          load();
          if (typeof window !== "undefined") window.dispatchEvent(new Event("orderStatusChanged"));
        }}
      />
    </div>
  );
}

// ─── Admin Orders View ────────────────────────────────────────────────────────

function AdminOrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 20, total: 0, pages: 0 });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const fetchOrders = useCallback(async (page = 1) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (statusFilter) params.set("status", statusFilter);
      const res = await api<{ success: boolean; data: Order[]; pagination: Pagination }>(`/api/v1/orders?${params}`);
      let data = res.data || [];
      if (search) {
        const q = search.toLowerCase();
        data = data.filter(
          (o) => o.order_number?.toLowerCase().includes(q) || o.buyer?.name?.toLowerCase().includes(q)
        );
      }
      setOrders(data);
      if (res.pagination) setPagination(res.pagination);
    } catch {
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  const fmt = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Orders</h1>
          <p className="text-zinc-600 text-xs mt-0.5">{pagination.total} total orders</p>
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg border border-black/10 text-zinc-700 hover:bg-black/5 transition-all"
          style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", boxShadow: "none", cursor: "pointer" }}
        >
          <Filter className="w-4 h-4" />
          Filters
        </button>
      </div>

      <div className="flex flex-col gap-3 mb-6">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type="text"
            placeholder="Search by order number, party..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-amber-500/40"
            style={{ fontSize: "0.8rem", fontFamily: "inherit" }}
          />
        </div>
        {showFilters && (
          <div className="flex flex-wrap gap-2">
            {["PENDING","APPROVED","REJECTED","DISPATCHED","DELIVERED","CANCELLED"].map((st) => (
              <button
                key={st}
                onClick={() => setStatusFilter(statusFilter === st ? "" : st)}
                className={`px-3 py-1.5 rounded-lg text-xs border transition-all ${
                  statusFilter === st
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                    : "border-black/10 bg-black/[0.03] text-zinc-600 hover:bg-black/5"
                }`}
                style={{ fontSize: "0.7rem", fontFamily: "inherit", textTransform: "none", boxShadow: "none", cursor: "pointer" }}
              >
                {st}
              </button>
            ))}
            {statusFilter && (
              <button
                onClick={() => setStatusFilter("")}
                className="px-2 py-1.5 text-zinc-500 hover:text-zinc-900"
                style={{ fontSize: "0.7rem", fontFamily: "inherit", background: "none", border: "none", boxShadow: "none", cursor: "pointer" }}
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
        </div>
      ) : orders.length === 0 ? (
        <div className="text-center py-20 text-zinc-500">
          <ShoppingCart className="w-12 h-12 mx-auto mb-4 opacity-30" />
          <p style={{ fontSize: "0.875rem" }}>No orders found</p>
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-black/[0.06] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full" style={{ borderCollapse: "collapse" }}>
                <thead>
                  <tr className="border-b border-black/[0.06]">
                    {["Order #","Type","Buyer","Amount","Items","Status","Payment","Date",""].map((h) => (
                      <th key={h} className="text-left px-4 py-3 text-xs font-medium text-zinc-500 bg-black/[0.02]"
                        style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={order.id} className="border-b border-black/[0.04] hover:bg-black/[0.02] transition-colors">
                      <td className="px-4 py-3">
                        <span className="text-zinc-900 font-medium font-mono" style={{ fontSize: "0.8rem" }}>{order.order_number}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-block px-2 py-1 rounded-md text-xs font-medium bg-blue-500/20 text-blue-400" style={{ fontSize: "0.65rem" }}>
                          {order.order_type || "STANDARD"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-zinc-700" style={{ fontSize: "0.8rem" }}>{order.buyer?.name || "—"}</div>
                        <div className="text-zinc-500" style={{ fontSize: "0.65rem" }}>{order.buyer?.party_types?.name || ""}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-zinc-900 font-medium" style={{ fontSize: "0.8rem" }}>{fmt(Number(order.grand_total))}</span>
                      </td>
                      <td className="px-4 py-3 text-zinc-600" style={{ fontSize: "0.8rem" }}>
                        {order.order_items?.length || 0}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-1 rounded-md text-xs font-medium ${statusColors[order.status] || "bg-zinc-500/20 text-zinc-600"}`} style={{ fontSize: "0.65rem" }}>
                          {order.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-1 rounded-md text-xs font-medium ${paymentStatusColors[order.payment_status] || "bg-zinc-500/20 text-zinc-600"}`} style={{ fontSize: "0.65rem" }}>
                          {order.payment_status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-zinc-600" style={{ fontSize: "0.75rem" }}>
                        {new Date(order.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                      </td>
                      <td className="px-4 py-3">
                        <button className="p-1.5 rounded-lg text-zinc-600 hover:text-amber-400 hover:bg-amber-500/10 transition-all inline-flex"
                          style={{ background: "none", border: "none", cursor: "pointer" }}>
                          <Eye className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {pagination.pages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <span className="text-xs text-zinc-500" style={{ fontSize: "0.7rem" }}>
                Page {pagination.page} of {pagination.pages}
              </span>
              <div className="flex gap-2">
                <button onClick={() => fetchOrders(pagination.page - 1)} disabled={pagination.page <= 1}
                  className="p-2 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:bg-black/5 disabled:opacity-30"
                  style={{ fontFamily: "inherit", background: "none", boxShadow: "none", cursor: "pointer" }}>
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button onClick={() => fetchOrders(pagination.page + 1)} disabled={pagination.page >= pagination.pages}
                  className="p-2 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:bg-black/5 disabled:opacity-30"
                  style={{ fontFamily: "inherit", background: "none", boxShadow: "none", cursor: "pointer" }}>
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Page entry ───────────────────────────────────────────────────────────────

export default function OrdersPage() {
  const user = getUser();
  const isPartyUser = !!user && !COMPANY_ROLES.has(user.role || "");

  if (isPartyUser) {
    if (!user.party_id) {
      return (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-8 text-center">
          <p className="text-zinc-500 text-sm">Your account is not linked to a party yet. Please contact your distributor.</p>
        </div>
      );
    }
    return <RetailerOrdersPage partyId={user.party_id} />;
  }

  return <AdminOrdersPage />;
}
