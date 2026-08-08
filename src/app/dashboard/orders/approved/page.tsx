"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useVisibleInterval } from "@/lib/hooks/use-visible-interval";
import {
  ChevronLeft,
  ChevronRight,
  Check,
  Clock,
  Loader2,
  Package,
  RefreshCw,
  Search,
} from "lucide-react";

interface Order {
  id: string;
  order_number: string;
  created_at: string;
  grand_total: number;
  status: string;
  notes: string | null;
  approved_by: string | null;
  buyer: { id: string; name: string; party_code: string } | null;
  order_items: {
    id: string;
    product_id: string;
    quantity: number;
    unit_price: number;
    line_total: number;
    products: {
      name: string;
      sku: string;
      technical_specs?: { net_weight_with_packaging?: number; net_weight_unit?: string } | null;
    } | null;
  }[];
  salesman: { id: string; name: string } | null;
  created_by: string | null;
}

interface ApprovalSummary {
  order_id: string;
  status: "ACTIVE" | "APPROVED" | "EXPIRED" | "REVOKED";
  approved_at: string | null;
  approved_name: string | null;
  has_active_link: boolean;
}

interface ShareApprovalData {
  token: string;
  approval_url: string;
  pdf_url: string;
  whatsapp_delivery: { status: "sent"; to: string; message_id: string | null };
  message: string;
  company_name: string;
  party: { id: string | null; name: string; phone: string; whatsapp_number: string };
}

const s: React.CSSProperties = {
  transform: "none",
  filter: "none",
  WebkitTextStroke: "0",
  background: "none",
  boxShadow: "none",
  display: "block",
  padding: 0,
};

function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
    </svg>
  );
}

function orderNetWeight(order: Order): number {
  let totalWeight = 0;
  for (const item of order.order_items || []) {
    const w = item.products?.technical_specs?.net_weight_with_packaging;
    if (w && typeof w === "number") {
      totalWeight += w * item.quantity;
    }
  }
  return totalWeight;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
}

export default function ApprovedOrdersPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [creatorNames, setCreatorNames] = useState<Record<string, string>>({});
  const [approvals, setApprovals] = useState<Record<string, ApprovalSummary>>({});
  const [sharingId, setSharingId] = useState<string | null>(null);

  const fetchApprovals = useCallback(async () => {
    try {
      const res = await api<{ success: boolean; data: Record<string, ApprovalSummary> }>(
        "/api/v1/orders/approval-status",
        { noCache: true },
      );
      setApprovals(res.data || {});
    } catch (e) {
      console.error(e);
    }
  }, []);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ success: boolean; data: Order[] }>("/api/v1/orders?limit=1000");
      const approvedOrders = (res.data || []).filter(o => o.status === "APPROVED");
      setOrders(approvedOrders);
      const ids = [...new Set([...approvedOrders.map(o => o.created_by), ...approvedOrders.map(o => o.approved_by)].filter(Boolean))] as string[];
      if (ids.length > 0) {
        const userRes = await api<{ success: boolean; data: { id: string; name: string }[] }>(`/api/v1/users?ids=${ids.join(",")}`);
        const map: Record<string, string> = {};
        (userRes.data || []).forEach(u => { map[u.id] = u.name; });
        setCreatorNames(map);
      }
      fetchApprovals();
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [fetchApprovals]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);
  useVisibleInterval(fetchApprovals, 30_000);

  // Mint a single-use approval link and deliver it through the server-side
  // WhatsApp automation service. No browser or manual Send step is involved.
  const openShare = async (order: Order, e: React.MouseEvent) => {
    e.stopPropagation();
    if (sharingId) return;
    setSharingId(order.id);
    try {
      const res = await api<{ success: boolean; data: ShareApprovalData }>(
        `/api/v1/orders/${order.id}/share-approval`,
        { method: "POST", body: {} },
      );
      if (res?.data?.whatsapp_delivery?.status !== "sent") throw new Error("WhatsApp did not confirm the automatic send.");
      fetchApprovals();
      alert("Order confirmation was sent automatically on WhatsApp.");
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to send WhatsApp automatically");
    } finally {
      setSharingId(null);
    }
  };

  const filteredOrders = search.trim() === ""
    ? orders
    : orders.filter(o =>
        o.order_number.toLowerCase().includes(search.toLowerCase()) ||
        o.buyer?.name?.toLowerCase().includes(search.toLowerCase()) ||
        o.buyer?.party_code?.toLowerCase().includes(search.toLowerCase())
      );

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/dashboard/invoices/new")}
            className="p-2 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:bg-black/5 transition-all"
            style={{ background: "none", cursor: "pointer" }}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-zinc-900 flex items-center gap-2" style={{ ...s, fontSize: "1.5rem", marginBottom: "0.25rem" }}>
              <Check className="w-5 h-5 text-emerald-500" />
              Approved Orders
            </h1>
            <p className="text-zinc-500" style={{ fontSize: "0.8rem", margin: 0 }}>
              {filteredOrders.length} orders approved and ready for processing
            </p>
          </div>
        </div>
        <button
          onClick={fetchOrders}
          className="flex items-center gap-2 px-4 py-2 rounded-lg border border-black/10 text-zinc-700 hover:bg-black/5 transition-all"
          style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      <div className="mb-6">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type="text"
            placeholder="Search by order number, party name or code..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-amber-500/40"
            style={{ fontSize: "0.8rem", fontFamily: "inherit" }}
          />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
        </div>
      ) : filteredOrders.length === 0 ? (
        <div className="text-center py-20 text-zinc-500">
          <Package className="w-12 h-12 mx-auto mb-4 opacity-30" />
          <p style={{ fontSize: "0.875rem" }}>
            {search ? "No approved orders match your search" : "No approved orders yet"}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-black/[0.06] overflow-hidden bg-white">
          <div className="divide-y divide-zinc-100">
            {filteredOrders.map((order) => {
              const summary = approvals[order.id];
              return (
              <div
                key={order.id}
                className="flex items-center gap-3 px-5 py-3.5 transition hover:bg-zinc-50/60 cursor-pointer"
                onClick={() => router.push(`/dashboard/orders/${order.id}`)}
              >
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-zinc-900 font-medium" style={{ fontSize: "0.82rem" }}>
                        {order.order_number}
                      </span>
                      <span className="ml-2 text-zinc-500" style={{ fontSize: "0.65rem" }}>
                        {formatDate(order.created_at)}
                      </span>
                    </div>
                    <div className="text-right">
                      <div className="text-amber-400 font-bold" style={{ fontSize: "0.9rem" }}>
                        {formatCurrency(Number(order.grand_total))}
                      </div>
                      <div className="text-zinc-500" style={{ fontSize: "0.6rem" }}>
                        {(order.order_items || []).length} item{(order.order_items || []).length !== 1 ? "s" : ""}
                        {(() => { const w = orderNetWeight(order); return w > 0 ? ` · ${w.toFixed(1)} kg` : ""; })()}
                        {order.created_by && creatorNames[order.created_by] && (
                          <span> · by {creatorNames[order.created_by]}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="text-zinc-700 truncate" style={{ fontSize: "0.78rem" }}>
                    {order.buyer?.name || "—"}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {order.approved_by && creatorNames[order.approved_by] && (
                      <span className="text-emerald-600/80 inline-flex items-center gap-1" style={{ fontSize: "0.66rem" }}>
                        <Check className="w-3 h-3 shrink-0" />
                        {creatorNames[order.approved_by]}
                      </span>
                    )}
                    {summary?.status === "APPROVED" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200 px-2 py-0.5" style={{ fontSize: "0.6rem", fontWeight: 700 }}>
                        <Check className="w-3 h-3" />
                        Confirmed by {summary.approved_name || "party"}
                      </span>
                    ) : summary?.has_active_link ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 border border-amber-200 px-2 py-0.5" style={{ fontSize: "0.6rem", fontWeight: 700 }}>
                        <Clock className="w-3 h-3" />
                        Awaiting party · link sent
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 text-zinc-500 border border-zinc-200 px-2 py-0.5" style={{ fontSize: "0.6rem", fontWeight: 700 }}>
                        Not sent to party
                      </span>
                    )}
                  </div>
                </div>

                <button
                  onClick={(e) => openShare(order, e)}
                  disabled={sharingId === order.id || summary?.status === "APPROVED"}
                  title={summary?.status === "APPROVED" ? "Party has confirmed this order" : "Send to party on WhatsApp for confirmation"}
                  className="shrink-0 flex items-center gap-1.5 rounded-lg bg-[#25D366] text-white px-3 py-2 font-semibold hover:brightness-95 transition disabled:cursor-not-allowed disabled:opacity-60"
                  style={{ fontSize: "0.72rem" }}
                >
                  {sharingId === order.id ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : summary?.status === "APPROVED" ? (
                    <Check className="w-4 h-4" />
                  ) : (
                    <WhatsAppIcon className="w-4 h-4" />
                  )}
                  <span className="hidden sm:inline">
                    {summary?.status === "APPROVED" ? "Confirmed" : summary?.has_active_link ? "Resend" : "Send"}
                  </span>
                </button>
                <ChevronRight className="w-4 h-4 text-zinc-500 shrink-0" />
              </div>
            );})}
          </div>
        </div>
      )}
    </div>
  );
}
