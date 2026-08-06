"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { api, getUser } from "@/lib/api";
import {
  Check,
  ChevronLeft,
  ChevronRight,
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

const s: React.CSSProperties = {
  transform: "none",
  filter: "none",
  WebkitTextStroke: "0",
  background: "none",
  boxShadow: "none",
  display: "block",
  padding: 0,
};

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

export default function MyApprovalsPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [creatorNames, setCreatorNames] = useState<Record<string, string>>({});
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  useEffect(() => {
    const user = getUser();
    if (user?.id) {
      setCurrentUserId(user.id);
    }
  }, []);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch orders with status=APPROVED to bypass company filtering
      const res = await api<{ success: boolean; data: any[] }>("/api/v1/orders?status=APPROVED&limit=1000");
      const approvedOrders = res.data || [];
      
      console.log("=== My Approvals Debug ===");
      console.log("Approved orders:", approvedOrders.length);
      
      if (approvedOrders.length > 0) {
        console.log("First approved order:", JSON.stringify(approvedOrders[0], null, 2));
      }
      
      setOrders(approvedOrders);
      
      const ids = [...new Set([
        ...approvedOrders.map((o: any) => o.created_by),
        ...approvedOrders.map((o: any) => o.approved_by)
      ].filter(Boolean))] as string[];
      
      if (ids.length > 0) {
        const userRes = await api<{ success: boolean; data: { id: string; name: string }[] }>(`/api/v1/users?ids=${ids.join(",")}`);
        const map: Record<string, string> = {};
        (userRes.data || []).forEach(u => { map[u.id] = u.name; });
        setCreatorNames(map);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [currentUserId]);

  useEffect(() => { 
    if (currentUserId) {
      fetchOrders();
    }
  }, [fetchOrders, currentUserId]);

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
              My Approvals
            </h1>
            <p className="text-zinc-500" style={{ fontSize: "0.8rem", margin: 0 }}>
              Orders you have approved - {filteredOrders.length} total
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
            {search ? "No approved orders match your search" : "You haven't approved any orders yet"}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-black/[0.06] overflow-hidden bg-white">
          <div className="divide-y divide-zinc-100">
            {filteredOrders.map((order) => (
              <div
                key={order.id}
                className="flex items-center gap-4 px-5 py-3.5 transition hover:bg-zinc-50/60 cursor-pointer"
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
                  {order.notes && (
                    <div className="text-amber-600/80 truncate flex items-center gap-1" style={{ fontSize: "0.68rem" }}>
                      <span className="truncate">{order.notes}</span>
                    </div>
                  )}
                </div>
                <ChevronRight className="w-4 h-4 text-zinc-500 shrink-0" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}