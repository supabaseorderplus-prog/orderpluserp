"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, Search, Warehouse } from "lucide-react";

interface StockItem {
  id: string;
  product: { name: string; sku: string } | null;
  warehouse: { name: string } | null;
  qty: number;
  minQty: number;
  maxQty: number;
}

const s: React.CSSProperties = { transform: "none", filter: "none", WebkitTextStroke: "0", background: "none", boxShadow: "none", display: "block", padding: 0 };

export default function InventoryPage() {
  const [items, setItems] = useState<StockItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [lowOnly, setLowOnly] = useState(false);

  const fetchData = useCallback(async (p = 1) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(p), limit: "20" });
      if (search) params.set("search", search);
      if (lowOnly) params.set("lowStock", "true");
      const res = await api<{ data: StockItem[]; meta: { total: number; page: number; totalPages: number } }>(`/api/v1/inventory?${params}`);
      setItems(res.data || []);
      if (res.meta) { setTotal(res.meta.total); setPage(res.meta.page); setTotalPages(res.meta.totalPages); }
    } catch { setItems([]); }
    setLoading(false);
  }, [search, lowOnly]);

  useEffect(() => { fetchData(); }, [fetchData]);

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900" style={{ ...s, fontSize: "1.5rem", marginBottom: "0.25rem" }}>Inventory</h1>
          <p className="text-zinc-600" style={{ fontSize: "0.8rem", margin: 0 }}>{total} stock entries</p>
        </div>
        <button
          onClick={() => setLowOnly(!lowOnly)}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg border transition-all ${lowOnly ? "border-orange-500/40 bg-orange-500/10 text-orange-400" : "border-black/10 text-zinc-700 hover:bg-black/5"}`}
          style={{ fontSize: "0.8rem", fontFamily: "inherit", textTransform: "none", background: lowOnly ? undefined : "none", boxShadow: "none", cursor: "pointer" }}
        >
          <AlertTriangle className="w-4 h-4" />
          Low Stock
        </button>
      </div>

      <div className="relative mb-6">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
        <input type="text" placeholder="Search inventory..." value={search} onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-amber-500/40"
          style={{ fontSize: "0.8rem", fontFamily: "inherit" }} />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-amber-500 animate-spin" /></div>
      ) : items.length === 0 ? (
        <div className="text-center py-20 text-zinc-500"><Warehouse className="w-12 h-12 mx-auto mb-4 opacity-30" /><p style={{ fontSize: "0.875rem" }}>No inventory records</p></div>
      ) : (
        <>
          <div className="rounded-xl border border-black/[0.06] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full" style={{ borderCollapse: "collapse" }}>
                <thead>
                  <tr className="border-b border-black/[0.06]">
                    {["Product","SKU","Warehouse","Qty","Min","Max","Status"].map((h) => (
                      <th key={h} className="text-left px-4 py-3 text-xs font-medium text-zinc-500 bg-black/[0.02]" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const isLow = item.qty <= item.minQty;
                    return (
                      <tr key={item.id} className="border-b border-black/[0.04] hover:bg-black/[0.02] transition-colors">
                        <td className="px-4 py-3 text-zinc-800" style={{ fontSize: "0.8rem" }}>{item.product?.name || "—"}</td>
                        <td className="px-4 py-3 text-zinc-600 font-mono" style={{ fontSize: "0.75rem" }}>{item.product?.sku || "—"}</td>
                        <td className="px-4 py-3 text-zinc-600" style={{ fontSize: "0.8rem" }}>{item.warehouse?.name || "—"}</td>
                        <td className="px-4 py-3">
                          <span className={`font-medium ${isLow ? "text-orange-400" : "text-zinc-900"}`} style={{ fontSize: "0.8rem" }}>{item.qty}</span>
                        </td>
                        <td className="px-4 py-3 text-zinc-500" style={{ fontSize: "0.8rem" }}>{item.minQty}</td>
                        <td className="px-4 py-3 text-zinc-500" style={{ fontSize: "0.8rem" }}>{item.maxQty}</td>
                        <td className="px-4 py-3">
                          {isLow ? (
                            <span className="inline-flex items-center gap-1.5 text-orange-400" style={{ fontSize: "0.75rem" }}>
                              <AlertTriangle className="w-3 h-3" /> Low Stock
                            </span>
                          ) : (
                            <span className="text-emerald-400" style={{ fontSize: "0.75rem" }}>In Stock</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <span className="text-xs text-zinc-500" style={{ fontSize: "0.7rem" }}>Page {page} of {totalPages}</span>
              <div className="flex gap-2">
                <button onClick={() => fetchData(page - 1)} disabled={page <= 1} className="p-2 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:bg-black/5 disabled:opacity-30" style={{ fontFamily: "inherit", background: "none", boxShadow: "none", cursor: "pointer" }}><ChevronLeft className="w-4 h-4" /></button>
                <button onClick={() => fetchData(page + 1)} disabled={page >= totalPages} className="p-2 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:bg-black/5 disabled:opacity-30" style={{ fontFamily: "inherit", background: "none", boxShadow: "none", cursor: "pointer" }}><ChevronRight className="w-4 h-4" /></button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
