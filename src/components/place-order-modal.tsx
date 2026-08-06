"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { api } from "@/lib/api";
import {
  X,
  Search,
  Plus,
  Minus,
  Loader2,
  PackageOpen,
  ShoppingCart,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

interface OrderableProduct {
  id: string;
  name: string;
  sku: string;
  unit_of_measure: string;
  mrp: number;
  effective_price: number;
}

interface PlaceOrderModalProps {
  partyId: string;
  open: boolean;
  onClose: () => void;
  onPlaced: () => void;
}

const inr = (n: number) =>
  "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

export default function PlaceOrderModal({ partyId, open, onClose, onPlaced }: PlaceOrderModalProps) {
  const [products, setProducts] = useState<OrderableProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [qty, setQty] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    api<{ success: boolean; data: OrderableProduct[] }>(`/api/v1/products/orderable`)
      .then((res) => setProducts(res.data || []))
      .catch((err) => {
        setProducts([]);
        setLoadError(err instanceof Error ? err.message : "Failed to load products");
      })
      .finally(() => setLoading(false));
  }, []);

  // Reset and load whenever the modal opens
  useEffect(() => {
    if (!open) return;
    setQty({});
    setNotes("");
    setSubmitError(null);
    setSearch("");
    load();
  }, [open, load]);

  const setQuantity = (id: string, next: number) =>
    setQty((prev) => {
      const value = Math.max(0, Math.floor(next));
      const updated = { ...prev };
      if (value === 0) delete updated[id];
      else updated[id] = value;
      return updated;
    });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)
    );
  }, [products, search]);

  const cartItems = useMemo(() => products.filter((p) => (qty[p.id] || 0) > 0), [products, qty]);
  const total = useMemo(
    () => cartItems.reduce((sum, p) => sum + p.effective_price * (qty[p.id] || 0), 0),
    [cartItems, qty]
  );
  const totalUnits = cartItems.reduce((sum, p) => sum + (qty[p.id] || 0), 0);

  const submit = async () => {
    if (cartItems.length === 0 || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api(`/api/v1/orders`, {
        method: "POST",
        body: {
          buyer_id: partyId,
          items: cartItems.map((p) => ({
            product_id: p.id,
            quantity: qty[p.id],
            unit_price: p.effective_price,
          })),
          notes: notes.trim() || null,
        },
      });
      onPlaced();
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to place order");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      style={{ background: "rgba(9,9,11,0.55)", backdropFilter: "blur(2px)" }}
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-lg bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col"
        style={{ maxHeight: "92vh", fontFamily: "'Inter','system-ui',sans-serif" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-black/[0.06] bg-gradient-to-r from-blue-500/[0.06] to-transparent shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-blue-500/15 border border-blue-500/20 flex items-center justify-center">
              <ShoppingCart className="w-4 h-4 text-blue-600" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-zinc-900">Place an Order</h3>
              <p className="text-[0.65rem] text-zinc-500">Select products and quantities</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-900 hover:bg-black/[0.04] transition-all"
            style={{ background: "transparent", border: "none", cursor: "pointer" }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 pt-4 pb-2 shrink-0">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
            <input
              type="text"
              placeholder="Search products…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-black/10 bg-black/[0.02] text-zinc-900 placeholder:text-zinc-400 outline-none focus:border-blue-500/40 transition-colors"
              style={{ fontSize: "0.8rem" }}
            />
          </div>
        </div>

        {/* Product list */}
        <div className="flex-1 overflow-y-auto px-5 py-2 min-h-[8rem]">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-zinc-500">
              <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
              <span className="text-xs">Loading products…</span>
            </div>
          ) : loadError ? (
            <div className="py-10 text-center">
              <AlertCircle className="w-7 h-7 text-red-400 mx-auto mb-2" />
              <p className="text-xs text-zinc-600 mb-3">{loadError}</p>
              <button
                onClick={load}
                className="text-xs font-medium text-blue-600"
                style={{ background: "none", border: "none", cursor: "pointer" }}
              >
                Retry
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center">
              <PackageOpen className="w-8 h-8 text-zinc-300 mx-auto mb-2" />
              <p className="text-xs font-medium text-zinc-500">
                {products.length === 0 ? "No products available to order" : "No products match your search"}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-black/[0.05]">
              {filtered.map((p) => {
                const count = qty[p.id] || 0;
                const active = count > 0;
                return (
                  <div key={p.id} className="flex items-center gap-3 py-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-[0.8rem] font-semibold text-zinc-900 truncate">{p.name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[0.62rem] text-zinc-400 font-mono">{p.sku}</span>
                        <span className="text-[0.72rem] font-bold text-blue-600">{inr(p.effective_price)}</span>
                        <span className="text-[0.6rem] text-zinc-400">/ {p.unit_of_measure}</span>
                      </div>
                    </div>

                    {active ? (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          onClick={() => setQuantity(p.id, count - 1)}
                          className="w-7 h-7 rounded-lg flex items-center justify-center text-zinc-600 hover:bg-black/[0.05] transition-all"
                          style={{ background: "rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.08)", cursor: "pointer" }}
                        >
                          <Minus className="w-3.5 h-3.5" />
                        </button>
                        <input
                          type="number"
                          value={count}
                          min={0}
                          onChange={(e) => setQuantity(p.id, Number(e.target.value))}
                          className="w-11 text-center text-sm font-bold text-zinc-900 tabular-nums outline-none rounded-lg py-1"
                          style={{ background: "transparent", border: "1px solid rgba(0,0,0,0.08)" }}
                        />
                        <button
                          onClick={() => setQuantity(p.id, count + 1)}
                          className="w-7 h-7 rounded-lg flex items-center justify-center text-white transition-all"
                          style={{ background: "rgb(59,130,246)", border: "none", cursor: "pointer" }}
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setQuantity(p.id, 1)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-blue-600 transition-all shrink-0"
                        style={{ background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.2)", cursor: "pointer" }}
                      >
                        <Plus className="w-3 h-3" /> Add
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer / cart summary */}
        <div className="border-t border-black/[0.06] bg-black/[0.015] px-5 py-3.5 shrink-0">
          {submitError && (
            <div className="flex items-center gap-1.5 mb-2.5 px-2.5 py-1.5 rounded-lg bg-red-500/8 border border-red-500/20">
              <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
              <span className="text-[0.7rem] text-red-600">{submitError}</span>
            </div>
          )}

          {cartItems.length > 0 && (
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add a note for your distributor (optional)…"
              rows={2}
              className="w-full mb-3 px-3 py-2 rounded-xl border border-black/10 bg-white text-zinc-900 placeholder:text-zinc-400 outline-none focus:border-blue-500/40 transition-colors resize-none"
              style={{ fontSize: "0.72rem" }}
            />
          )}

          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[0.6rem] text-zinc-400 uppercase tracking-widest font-semibold">Order total</p>
              <p className="text-lg font-bold text-zinc-900 tabular-nums leading-tight">
                {inr(total)}
                <span className="text-[0.62rem] font-medium text-zinc-400 ml-1.5">
                  {cartItems.length} item{cartItems.length !== 1 ? "s" : ""} · {totalUnits} unit{totalUnits !== 1 ? "s" : ""}
                </span>
              </p>
            </div>
            <button
              onClick={submit}
              disabled={cartItems.length === 0 || submitting}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-white transition-all disabled:opacity-40"
              style={{ background: "rgb(59,130,246)", border: "none", cursor: cartItems.length === 0 || submitting ? "not-allowed" : "pointer" }}
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              {submitting ? "Placing…" : "Place Order"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
