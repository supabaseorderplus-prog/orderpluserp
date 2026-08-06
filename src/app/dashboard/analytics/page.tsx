"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { BarChart3, IndianRupee, Loader2, ShoppingCart, TrendingUp, Users } from "lucide-react";

interface AnalyticsData {
  todaySales: number;
  mtdSales: number;
  activeOrders: number;
  outstanding: number;
  lowStockItems: number;
  activeSalesmen: number;
  topProducts?: { name: string; totalQty: number; totalRevenue: number }[];
  topBuyers?: { name: string; totalOrders: number; totalSpent: number }[];
}

const s: React.CSSProperties = { transform: "none", filter: "none", WebkitTextStroke: "0", background: "none", boxShadow: "none", display: "block", padding: 0 };

function formatCurrency(amount: number): string {
  if (amount >= 10000000) return `₹${(amount / 10000000).toFixed(2)} Cr`;
  if (amount >= 100000) return `₹${(amount / 100000).toFixed(2)} L`;
  if (amount >= 1000) return `₹${(amount / 1000).toFixed(1)}K`;
  return `₹${amount.toFixed(0)}`;
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [dashboard, products, buyers] = await Promise.allSettled([
          api<{ data: AnalyticsData }>("/api/v1/analytics/dashboard"),
          api<{ data: { name: string; totalQty: number; totalRevenue: number }[] }>("/api/v1/analytics/top-products?limit=10"),
          api<{ data: { name: string; totalOrders: number; totalSpent: number }[] }>("/api/v1/analytics/top-buyers?limit=10"),
        ]);
        const d = dashboard.status === "fulfilled" ? dashboard.value.data : null;
        const tp = products.status === "fulfilled" ? products.value.data : [];
        const tb = buyers.status === "fulfilled" ? buyers.value.data : [];
        if (d) setData({ ...d, topProducts: tp || [], topBuyers: tb || [] });
      } catch { /* empty */ }
      setLoading(false);
    }
    load();
  }, []);

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-amber-500 animate-spin" /></div>;

  const kpis = data ? [
    { label: "Today Sales", value: formatCurrency(data.todaySales), icon: IndianRupee, color: "text-emerald-400", bg: "from-emerald-500/20 to-emerald-500/5" },
    { label: "MTD Sales", value: formatCurrency(data.mtdSales), icon: TrendingUp, color: "text-amber-400", bg: "from-amber-500/20 to-amber-500/5" },
    { label: "Active Orders", value: String(data.activeOrders), icon: ShoppingCart, color: "text-blue-400", bg: "from-blue-500/20 to-blue-500/5" },
    { label: "Outstanding", value: formatCurrency(data.outstanding), icon: IndianRupee, color: "text-red-400", bg: "from-red-500/20 to-red-500/5" },
  ] : [];

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      <h1 className="text-2xl font-bold text-zinc-900 mb-6" style={{ ...s, fontSize: "1.5rem", marginBottom: "1.5rem" }}>Analytics</h1>

      {/* KPI Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;
          return (
            <div key={kpi.label} className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-5">
              <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${kpi.bg} flex items-center justify-center mb-3`} style={{ borderRadius: "0.75rem" }}>
                <Icon className={`w-5 h-5 ${kpi.color}`} />
              </div>
              <div className="text-xl font-bold text-zinc-900" style={{ ...s, fontSize: "1.25rem" }}>{kpi.value}</div>
              <div className="text-xs text-zinc-500 mt-1" style={{ fontSize: "0.7rem" }}>{kpi.label}</div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top Products */}
        <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] overflow-hidden">
          <div className="px-5 py-4 border-b border-black/[0.06]">
            <h3 className="text-sm font-semibold text-zinc-900" style={{ ...s, fontSize: "0.875rem" }}>Top Products</h3>
          </div>
          <div className="divide-y divide-black/[0.04]">
            {(data?.topProducts || []).length === 0 ? (
              <div className="p-8 text-center text-zinc-500" style={{ fontSize: "0.8rem" }}>No data yet</div>
            ) : (
              data?.topProducts?.map((p, i) => (
                <div key={i} className="flex items-center justify-between px-5 py-3 hover:bg-black/[0.02]">
                  <div className="flex items-center gap-3">
                    <span className="w-6 h-6 rounded-lg bg-black/5 flex items-center justify-center text-zinc-500" style={{ fontSize: "0.65rem" }}>{i + 1}</span>
                    <span className="text-zinc-800" style={{ fontSize: "0.8rem" }}>{p.name}</span>
                  </div>
                  <div className="text-right">
                    <div className="text-zinc-900 font-medium" style={{ fontSize: "0.8rem" }}>{formatCurrency(p.totalRevenue)}</div>
                    <div className="text-zinc-500" style={{ fontSize: "0.65rem" }}>{p.totalQty} units</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Top Buyers */}
        <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] overflow-hidden">
          <div className="px-5 py-4 border-b border-black/[0.06]">
            <h3 className="text-sm font-semibold text-zinc-900" style={{ ...s, fontSize: "0.875rem" }}>Top Buyers</h3>
          </div>
          <div className="divide-y divide-black/[0.04]">
            {(data?.topBuyers || []).length === 0 ? (
              <div className="p-8 text-center text-zinc-500" style={{ fontSize: "0.8rem" }}>No data yet</div>
            ) : (
              data?.topBuyers?.map((b, i) => (
                <div key={i} className="flex items-center justify-between px-5 py-3 hover:bg-black/[0.02]">
                  <div className="flex items-center gap-3">
                    <span className="w-6 h-6 rounded-lg bg-black/5 flex items-center justify-center text-zinc-500" style={{ fontSize: "0.65rem" }}>{i + 1}</span>
                    <span className="text-zinc-800" style={{ fontSize: "0.8rem" }}>{b.name}</span>
                  </div>
                  <div className="text-right">
                    <div className="text-zinc-900 font-medium" style={{ fontSize: "0.8rem" }}>{formatCurrency(b.totalSpent)}</div>
                    <div className="text-zinc-500" style={{ fontSize: "0.65rem" }}>{b.totalOrders} orders</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
