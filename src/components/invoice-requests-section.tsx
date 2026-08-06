"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { hideSupersededInvoiceRequests } from "@/lib/invoice-request-display";
import {
  ArrowDownLeft,
  CheckCircle2,
  ChevronDown,
  Clock,
  FileText,
  Loader2,
  Package,
  RefreshCw,
  User,
  XCircle,
  ClipboardList,
  MapPin,
  Tag,
} from "lucide-react";

export interface InvoiceRequest {
  id: string;
  order_id: string;
  invoice_number: string;
  status: string;
  notes: string | null;
  created_at: string;
  confirmed_at?: string | null;
  orders: {
    id: string;
    order_number: string;
    grand_total: number;
    subtotal: number;
    discount_amount: number;
    gst_amount: number;
    status: string;
    created_at: string;
    delivery_date?: string | null;
    salesman?: { id: string; name: string } | null;
    buyer: {
      id: string;
      name: string;
      party_code: string;
      gstin: string | null;
      address_line1?: string | null;
      city?: string | null;
      party_types: { name: string } | null;
    } | null;
    order_items: {
      id: string;
      quantity: number;
      unit_price: number;
      discount_percent?: number;
      discount_amount?: number;
      gst_rate?: number;
      line_total?: number;
      total: number;
      products: { name: string; sku: string; unit_of_measure: string } | null;
    }[];
  } | null;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
}

type OrderDetail = NonNullable<InvoiceRequest["orders"]>;

export default function InvoiceRequestsSection({ partyId }: { partyId: string }) {
  const [requests, setRequests] = useState<InvoiceRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmSuccess, setConfirmSuccess] = useState<string | null>(null);
  const [expandedDetails, setExpandedDetails] = useState<Set<string>>(new Set());
  const [orderCache, setOrderCache] = useState<Record<string, OrderDetail | null>>({});
  const [fetchingOrder, setFetchingOrder] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<"pending" | "delivered">("pending");

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    const failsafe = setTimeout(() => setLoading(false), 30000);
    api<{ success: boolean; data: InvoiceRequest[] }>(`/api/v1/invoice-requests?party_id=${partyId}`)
      .then(res => {
        const data = hideSupersededInvoiceRequests(res.data || []);
        setRequests(data);
        // Eagerly fetch order details for requests where hydration returned null
        data.forEach(req => {
          if (!req.orders && req.order_id) {
            fetchOrderDirect(req.order_id);
          }
        });
      })
      .catch(err => {
        setRequests([]);
        setLoadError(err instanceof Error ? err.message : 'Failed to load invoice requests');
      })
      .finally(() => { clearTimeout(failsafe); setLoading(false); });
  }, [partyId]);

  useEffect(() => { load(); }, [load]);

  const fetchOrderDirect = useCallback(async (orderId: string) => {
    if (!orderId || orderCache[orderId] !== undefined || fetchingOrder.has(orderId)) return;
    setFetchingOrder(prev => new Set(prev).add(orderId));
    try {
      const res = await api<{ success: boolean; data: Record<string, unknown> }>(`/api/v1/orders/${orderId}`);
      const o = res.data as Record<string, unknown> | null;
      if (!o) { setOrderCache(prev => ({ ...prev, [orderId]: null })); return; }

      // Resolve buyer: use embedded buyer if present, otherwise fetch party directly
      let buyerData: OrderDetail["buyer"] = null;
      const rawBuyer = o.buyer as Record<string, unknown> | null;
      if (rawBuyer?.name) {
        buyerData = {
          id: String(rawBuyer.id || ""),
          name: String(rawBuyer.name || ""),
          party_code: String(rawBuyer.party_code || ""),
          gstin: rawBuyer.gstin ? String(rawBuyer.gstin) : null,
          address_line1: rawBuyer.address_line1 ? String(rawBuyer.address_line1) : (rawBuyer.address ? String(rawBuyer.address) : null),
          city: rawBuyer.city ? String(rawBuyer.city) : null,
          party_types: rawBuyer.party_types
            ? { name: String((rawBuyer.party_types as Record<string, unknown>).name || "") }
            : null,
        };
      } else {
        // Embedded buyer join failed — fetch party directly by buyer_id / billing_party_id
        const partyId = String(o.buyer_id || o.billing_party_id || "");
        if (partyId) {
          try {
            const pr = await api<{ success: boolean; data: Record<string, unknown> }>(`/api/v1/parties/${partyId}`);
            const p = pr.data as Record<string, unknown> | null;
            if (p) {
              buyerData = {
                id: String(p.id || ""),
                name: String(p.name || ""),
                party_code: String(p.party_code || ""),
                gstin: p.gstin ? String(p.gstin) : null,
                address_line1: p.address_line1 ? String(p.address_line1) : null,
                city: p.city ? String(p.city) : null,
                party_types: null,
              };
            }
          } catch { /* buyer stays null */ }
        }
      }

      const detail: OrderDetail = {
        id: String(o.id || ""),
        order_number: String(o.order_number || ""),
        grand_total: Number(o.grand_total || 0),
        subtotal: Number(o.subtotal || 0),
        discount_amount: Number(o.discount_amount || 0),
        gst_amount: Number(o.gst_amount || 0),
        status: String(o.status || ""),
        created_at: String(o.created_at || ""),
        delivery_date: o.delivery_date ? String(o.delivery_date) : null,
        buyer: buyerData,
        order_items: ((o.order_items as Record<string, unknown>[] | null) || []).map(item => ({
          id: String(item.id || ""),
          quantity: Number(item.quantity || 0),
          unit_price: Number(item.unit_price || 0),
          discount_percent: Number(item.discount_percent || 0),
          line_total: Number(item.line_total || item.total || 0),
          total: Number(item.line_total || item.total || 0),
          products: (() => {
            const p = item.products as Record<string, unknown> | null;
            if (!p) return null;
            return { name: String(p.name || ""), sku: String(p.sku || ""), unit_of_measure: String(p.unit_of_measure || "") };
          })(),
        })),
      };
      setOrderCache(prev => ({ ...prev, [orderId]: detail }));
    } catch {
      setOrderCache(prev => ({ ...prev, [orderId]: null }));
    }
    setFetchingOrder(prev => { const n = new Set(prev); n.delete(orderId); return n; });
  }, [orderCache, fetchingOrder]);

  const handleAction = async (id: string, status: "CONFIRMED" | "REJECTED") => {
    setActionLoading(id);
    try {
      await api(`/api/v1/invoice-requests/${id}`, { method: "PUT", body: { status } });
      if (status === "CONFIRMED") {
        setConfirmSuccess(id);
        setTimeout(() => setConfirmSuccess(null), 3000);
        window.dispatchEvent(new Event("walletBalanceChanged"));
        window.dispatchEvent(new Event("orderStatusChanged"));
      }
      load();
    } catch {}
    setActionLoading(null);
  };

  const pending = requests.filter(r => r.status === "PENDING");
  const confirmed = requests.filter(r => r.status === "CONFIRMED");
  const rejected = requests.filter(r => r.status === "REJECTED");
  const displayList = tab === "pending" ? pending : confirmed;

  const statusBadge: Record<string, { label: string; color: string; bg: string; border: string; icon: typeof Clock }> = {
    PENDING: { label: "Awaiting Confirmation", color: "text-amber-500", bg: "bg-amber-500/10", border: "border-amber-500/20", icon: Clock },
    CONFIRMED: { label: "Delivered & Invoiced", color: "text-emerald-500", bg: "bg-emerald-500/10", border: "border-emerald-500/20", icon: CheckCircle2 },
    REJECTED: { label: "Rejected", color: "text-red-400", bg: "bg-red-500/10", border: "border-red-500/20", icon: XCircle },
  };

  return (
    <div className="rounded-xl border border-amber-500/15 overflow-hidden mb-6" style={{ background: "linear-gradient(135deg, rgba(245,158,11,0.03) 0%, rgba(17,17,24,0.02) 100%)" }}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-amber-500/10">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-amber-500/20 to-orange-500/10 border border-amber-500/20 flex items-center justify-center">
            <ClipboardList className="w-4 h-4 text-amber-400" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-zinc-900">Invoice Requests</h3>
            <p className="text-[0.65rem] text-zinc-500">Confirm delivery to generate invoice & deduct from wallet</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {pending.length > 0 && (
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
              <span className="text-xs font-bold text-amber-400">{pending.length} pending</span>
            </span>
          )}
          <button onClick={load} className="w-7 h-7 rounded-lg flex items-center justify-center text-zinc-500 hover:text-amber-400 hover:bg-amber-500/10 transition-all" style={{ background: "transparent", border: "none", cursor: "pointer" }}>
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 border-b border-black/[0.06]">
        <div className="px-4 py-3 text-center border-r border-black/[0.06]">
          <div className="text-lg font-bold text-amber-500 tabular-nums">{pending.length}</div>
          <div className="text-[0.6rem] text-zinc-500">Pending</div>
        </div>
        <div className="px-4 py-3 text-center border-r border-black/[0.06]">
          <div className="text-lg font-bold text-emerald-500 tabular-nums">{confirmed.length}</div>
          <div className="text-[0.6rem] text-zinc-500">Delivered</div>
        </div>
        <div className="px-4 py-3 text-center">
          <div className="text-lg font-bold text-red-400 tabular-nums">{rejected.length}</div>
          <div className="text-[0.6rem] text-zinc-500">Rejected</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-black/[0.06]">
        <button
          onClick={() => setTab("pending")}
          className={`flex-1 py-2.5 text-xs font-semibold text-center transition-all ${tab === "pending" ? "text-amber-500" : "text-zinc-500 hover:text-zinc-700"}`}
          style={{ background: tab === "pending" ? "rgba(245,158,11,0.04)" : "transparent", border: "none", borderBottom: tab === "pending" ? "2px solid rgb(245,158,11)" : "2px solid transparent", cursor: "pointer" }}
        >
          Pending ({pending.length})
        </button>
        <button
          onClick={() => setTab("delivered")}
          className={`flex-1 py-2.5 text-xs font-semibold text-center transition-all ${tab === "delivered" ? "text-emerald-600" : "text-zinc-500 hover:text-zinc-700"}`}
          style={{ background: tab === "delivered" ? "rgba(16,185,129,0.04)" : "transparent", border: "none", borderBottom: tab === "delivered" ? "2px solid rgb(16,185,129)" : "2px solid transparent", cursor: "pointer" }}
        >
          Delivered ({confirmed.length})
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="p-8 flex items-center justify-center gap-2">
          <Loader2 className="w-5 h-5 text-amber-500 animate-spin" />
          <span className="text-xs text-zinc-500">Loading invoice requests…</span>
        </div>
      ) : loadError ? (
        <div className="p-8 text-center">
          <XCircle className="w-7 h-7 text-red-400 mx-auto mb-2" />
          <p className="text-sm font-medium text-zinc-600 mb-1">Could not load invoice requests</p>
          <p className="text-[0.65rem] text-zinc-400 mb-3">{loadError}</p>
          <button
            onClick={load}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-amber-500 hover:text-amber-400 transition-colors"
            style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)" }}
          >
            <RefreshCw className="w-3 h-3" /> Retry
          </button>
        </div>
      ) : displayList.length === 0 ? (
        <div className="p-10 text-center">
          <FileText className="w-8 h-8 text-zinc-300 mx-auto mb-2" />
          <p className="text-sm font-medium text-zinc-500 mb-1">
            {tab === "pending" ? "No pending requests" : "No delivered orders yet"}
          </p>
          <p className="text-[0.65rem] text-zinc-400">
            {tab === "pending" ? "All caught up! Check the \"Delivered\" tab for history." : "Delivered & invoiced orders will appear here."}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-black/[0.05]">
          {displayList.map(req => {
            // Use hydrated order from API; fall back to directly-fetched cache
            const order = req.orders ?? orderCache[req.order_id] ?? null;
            const isFetchingThisOrder = fetchingOrder.has(req.order_id);
            const badge = statusBadge[req.status] || statusBadge.PENDING;
            const BadgeIcon = badge.icon;
            const justConfirmed = confirmSuccess === req.id;
            const isPending = req.status === "PENDING";
            const isConfirmed = req.status === "CONFIRMED";
            const items = order?.order_items || [];
            const inrFmt = (n: number) => "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
            const isDetailsOpen = expandedDetails.has(req.id);
            const toggleDetails = () => {
              const opening = !expandedDetails.has(req.id);
              setExpandedDetails(prev => {
                const next = new Set(prev);
                next.has(req.id) ? next.delete(req.id) : next.add(req.id);
                return next;
              });
              // If opening and no order data yet, fetch it directly
              if (opening && !order && req.order_id) {
                fetchOrderDirect(req.order_id);
              }
            };

            return (
              <div key={req.id} className={`px-5 py-5 transition-all ${justConfirmed ? "bg-emerald-500/[0.06]" : ""}`}>

                {/* Confirmed success banner */}
                {justConfirmed && (
                  <div className="flex items-center gap-2 mb-4 px-3 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span className="text-xs font-medium text-emerald-600">
                      Delivery confirmed! Invoice generated &amp; {inrFmt(order?.grand_total || 0)} deducted from wallet.
                    </span>
                  </div>
                )}

                {/* ── Card header: invoice # + status + action buttons ── */}
                <div className="flex items-start justify-between gap-3 mb-4">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <div className={`w-8 h-8 rounded-lg ${badge.bg} ${badge.border} border flex items-center justify-center shrink-0`}>
                      <BadgeIcon className={`w-3.5 h-3.5 ${badge.color}`} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-bold text-zinc-900">{req.invoice_number || "—"}</span>
                        {order?.order_number && (
                          <span className="font-mono font-semibold text-amber-600 border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 rounded" style={{ fontSize: "0.62rem" }}>
                            {order.order_number}
                          </span>
                        )}
                        <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[0.6rem] font-semibold border ${badge.bg} ${badge.color} ${badge.border}`}>
                          <BadgeIcon className="w-2.5 h-2.5" />{badge.label}
                        </span>
                        {isConfirmed && (
                          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[0.6rem] font-semibold bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
                            <Package className="w-2.5 h-2.5" />Delivered
                          </span>
                        )}
                      </div>
                      <div className="text-[0.6rem] text-zinc-400 mt-0.5">
                        Requested {formatDate(req.created_at)}
                        {req.confirmed_at && <> · {isConfirmed ? "Confirmed" : "Responded"} {formatDate(req.confirmed_at)}</>}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {/* Details toggle — always shown */}
                    <button
                      onClick={toggleDetails}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all"
                      style={{
                        background: isDetailsOpen ? "rgba(99,102,241,0.08)" : "rgba(0,0,0,0.04)",
                        border: isDetailsOpen ? "1px solid rgba(99,102,241,0.2)" : "1px solid rgba(0,0,0,0.09)",
                        color: isDetailsOpen ? "#6366f1" : "#71717a",
                        cursor: "pointer",
                        fontFamily: "inherit",
                      }}
                    >
                      <FileText className="w-3.5 h-3.5" />
                      Details
                      <ChevronDown className={`w-3 h-3 transition-transform ${isDetailsOpen ? "rotate-180" : ""}`} />
                    </button>

                    {isPending && (
                      <>
                        <button
                          onClick={() => handleAction(req.id, "REJECTED")}
                          disabled={actionLoading === req.id}
                          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-red-400 transition-all disabled:opacity-40"
                          style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", cursor: "pointer" }}
                        >
                          {actionLoading === req.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
                          <span className="hidden sm:inline">Reject</span>
                        </button>
                        <button
                          onClick={() => handleAction(req.id, "CONFIRMED")}
                          disabled={actionLoading === req.id}
                          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-emerald-400 transition-all disabled:opacity-40"
                          style={{ background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.25)", cursor: "pointer" }}
                        >
                          {actionLoading === req.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                          <span className="hidden sm:inline">Confirm Delivery</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {isDetailsOpen && !order && (
                  <div className="mt-3 rounded-xl border border-black/[0.07] bg-black/[0.015] px-4 py-3 flex items-center gap-2 text-[0.72rem] text-zinc-400">
                    {isFetchingThisOrder
                      ? <><Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> Loading order details…</>
                      : "Order details are not available for this invoice."
                    }
                  </div>
                )}

                {isDetailsOpen && order && (
                  <>
                    {/* ── Party + Order meta ── */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                      {/* Bill To */}
                      <div className="rounded-xl border border-black/[0.07] bg-black/[0.015] p-3.5">
                        <div className="text-[0.58rem] font-semibold text-zinc-400 uppercase tracking-widest mb-2">Bill To</div>
                        <div className="font-bold text-zinc-900 mb-0.5" style={{ fontSize: "0.88rem" }}>{order.buyer?.name || "—"}</div>
                        {order.buyer?.party_types?.name && (
                          <div className="flex items-center gap-1 text-[0.65rem] text-zinc-500 mb-0.5">
                            <Tag className="w-2.5 h-2.5" />{order.buyer.party_types.name.replace(/_/g, " ")}
                          </div>
                        )}
                        {order.buyer?.party_code && (
                          <div className="text-[0.65rem] text-zinc-500">Code: <span className="font-medium text-zinc-700">{order.buyer.party_code}</span></div>
                        )}
                        {order.buyer?.gstin && (
                          <div className="text-[0.65rem] text-zinc-500 font-mono mt-0.5">GSTIN: <span className="font-semibold text-zinc-700">{order.buyer.gstin}</span></div>
                        )}
                        {(order.buyer?.address_line1 || order.buyer?.city) && (
                          <div className="flex items-start gap-1 text-[0.65rem] text-zinc-500 mt-0.5">
                            <MapPin className="w-2.5 h-2.5 shrink-0 mt-0.5" />
                            <span>{[order.buyer.address_line1, order.buyer.city].filter(Boolean).join(", ")}</span>
                          </div>
                        )}
                      </div>

                      {/* Order details */}
                      <div className="rounded-xl border border-black/[0.07] bg-black/[0.015] p-3.5">
                        <div className="text-[0.58rem] font-semibold text-zinc-400 uppercase tracking-widest mb-2">Order Details</div>
                        <div className="space-y-1.5">
                          <div className="flex justify-between">
                            <span className="text-[0.68rem] text-zinc-500">Order No</span>
                            <span className="text-[0.72rem] font-bold text-zinc-900">{order.order_number}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-[0.68rem] text-zinc-500">Order Date</span>
                            <span className="text-[0.72rem] text-zinc-700">{formatDate(order.created_at)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-[0.68rem] text-zinc-500">Status</span>
                            <span className="text-[0.68rem] font-semibold text-zinc-700">{order.status}</span>
                          </div>
                          {order.delivery_date && (
                            <div className="flex justify-between">
                              <span className="text-[0.68rem] text-zinc-500">Delivered</span>
                              <span className="text-[0.72rem] text-zinc-700">{formatDate(order.delivery_date)}</span>
                            </div>
                          )}
                          {order.salesman?.name && (
                            <div className="flex justify-between items-center">
                              <span className="text-[0.68rem] text-zinc-500 flex items-center gap-1"><User className="w-2.5 h-2.5" />Taken by</span>
                              <span className="text-[0.72rem] font-medium text-amber-600">{order.salesman.name}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* ── Product items table ── */}
                    {items.length > 0 && (
                      <div className="rounded-xl border border-black/[0.08] overflow-hidden mb-4">
                        <div className="grid bg-black/[0.025] border-b border-black/[0.06] px-4 py-2" style={{ gridTemplateColumns: "auto 1fr auto auto auto" }}>
                          {["#", "Product", "Qty", "Rate", "Total"].map(h => (
                            <div key={h} className="text-[0.58rem] font-semibold text-zinc-400 uppercase tracking-widest">{h}</div>
                          ))}
                        </div>
                        <div className="divide-y divide-black/[0.04]">
                          {items.map((item, idx) => (
                            <div key={item.id || idx} className="grid items-center px-4 py-2.5 hover:bg-black/[0.015] transition-colors" style={{ gridTemplateColumns: "auto 1fr auto auto auto" }}>
                              <span className="text-[0.65rem] text-zinc-400 w-5">{idx + 1}</span>
                              <div className="min-w-0 pr-3">
                                <div className="text-[0.78rem] font-medium text-zinc-900 truncate">{item.products?.name || "—"}</div>
                                <div className="text-[0.6rem] text-zinc-400">{item.products?.sku}</div>
                              </div>
                              <span className="text-[0.72rem] text-zinc-700 pr-4 tabular-nums">
                                {item.quantity} <span className="text-zinc-400">{item.products?.unit_of_measure || "pcs"}</span>
                              </span>
                              <span className="text-[0.72rem] text-zinc-600 pr-4 tabular-nums">{inrFmt(item.unit_price)}</span>
                              <span className="text-[0.78rem] font-semibold text-zinc-900 tabular-nums text-right">
                                {inrFmt(item.line_total ?? item.total)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ── Financial summary ── */}
                    <div className="flex justify-end mb-3">
                      <div className="rounded-xl border border-black/[0.08] p-4 w-full max-w-xs">
                        <div className="space-y-2">
                          <div className="flex justify-between">
                            <span className="text-[0.72rem] text-zinc-500">Subtotal</span>
                            <span className="text-[0.72rem] text-zinc-700 tabular-nums">{inrFmt(order.subtotal)}</span>
                          </div>
                          {Number(order.discount_amount) > 0 && (
                            <div className="flex justify-between">
                              <span className="text-[0.72rem] text-zinc-500">Discount</span>
                              <span className="text-[0.72rem] text-red-500 tabular-nums">-{inrFmt(order.discount_amount)}</span>
                            </div>
                          )}
                          {Number(order.gst_amount) > 0 && (
                            <div className="flex justify-between">
                              <span className="text-[0.72rem] text-zinc-500">GST</span>
                              <span className="text-[0.72rem] text-zinc-700 tabular-nums">{inrFmt(order.gst_amount)}</span>
                            </div>
                          )}
                          <div className="border-t border-black/[0.07] pt-2 flex justify-between items-center">
                            <span className="text-[0.82rem] font-bold text-zinc-900">Grand Total</span>
                            <span className="text-[1rem] font-bold text-amber-500 tabular-nums">{inrFmt(order.grand_total)}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* ── Post-confirm wallet note ── */}
                    {isConfirmed && (
                      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/5 border border-emerald-500/15">
                        <ArrowDownLeft className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                        <span className="text-[0.68rem] text-emerald-600 font-medium">
                          {inrFmt(order.grand_total)} deducted from wallet · Invoice #{req.invoice_number}
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
