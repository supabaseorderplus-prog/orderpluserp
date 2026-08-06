"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  BadgeCheck,
  CheckCircle2,
  Clock,
  Download,
  Loader2,
  Package,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { downloadOrderPdf, type OrderPdfData } from "@/lib/order-pdf";

interface ApprovalItem {
  name: string;
  sku: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  unit?: string;
}

interface ApprovalView {
  status: "ACTIVE" | "APPROVED" | "EXPIRED" | "REVOKED";
  order_number: string;
  order_date: string;
  company_name: string;
  party_name: string;
  party_phone: string;
  grand_total: number;
  staff_approved: boolean;
  party_confirmed: boolean;
  party_confirmed_name: string | null;
  party_confirmed_at: string | null;
  expires_at: string;
  purpose?: "ORDER" | "INVOICE";
  invoice_request_id?: string | null;
  items: ApprovalItem[];
}

const money = (n: number) =>
  "₹" + new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);

const fmtDate = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? v
    : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

export default function OrderApprovalPage() {
  const params = useParams<{ token: string }>();
  const token = Array.isArray(params?.token) ? params.token[0] : params?.token;

  const [view, setView] = useState<ApprovalView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [closedStatus, setClosedStatus] = useState<"APPROVED" | "EXPIRED" | "REVOKED" | null>(null);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/public/order-approval/${token}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        setClosedStatus(
          json?.status === "APPROVED" || json?.status === "EXPIRED" || json?.status === "REVOKED"
            ? json.status
            : null,
        );
        setNotFound(true);
        setView(null);
      } else {
        setView(json.data as ApprovalView);
        setNotFound(false);
        setClosedStatus(null);
      }
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const confirm = async () => {
    if (!token || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/public/order-approval/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const json = await res.json();
      if (res.ok && json?.success) {
        setView((prev) =>
          prev
            ? {
                ...prev,
                status: "APPROVED",
                party_confirmed: true,
                party_confirmed_name: json.data?.party_confirmed_name || name.trim() || prev.party_name,
                party_confirmed_at: json.data?.party_confirmed_at || new Date().toISOString(),
              }
            : prev,
        );
      } else {
        setError(json?.message || `Could not confirm the ${view?.purpose === "INVOICE" ? "invoice" : "order"}.`);
        // Re-sync to reflect the true server state (expired / already confirmed).
        load();
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const pdfData: OrderPdfData | null = useMemo(() => {
    if (!view) return null;
    return {
      order_number: view.order_number,
      order_date: view.order_date,
      company_name: view.company_name,
      party_name: view.party_name,
      party_phone: view.party_phone,
      items: view.items,
      grand_total: view.grand_total,
      staff_approved: view.staff_approved,
      party_confirmed: view.party_confirmed,
      party_confirmed_name: view.party_confirmed_name,
      party_confirmed_at: view.party_confirmed_at,
      approval_url: typeof window !== "undefined" ? window.location.href : null,
    };
  }, [view]);

  const confirmed = view?.status === "APPROVED";
  const dead = view?.status === "EXPIRED" || view?.status === "REVOKED";
  const isInvoice = view?.purpose === "INVOICE";

  return (
    <div className="min-h-screen bg-zinc-100 text-zinc-900" style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:py-10">
        {/* Brand header */}
        <div className="mb-5 flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-900">
            <Package className="h-5 w-5 text-amber-400" />
          </div>
          <div>
            <div className="text-sm font-bold leading-tight">{view?.company_name || "Order Confirmation"}</div>
            <div className="text-[0.7rem] text-zinc-500">Secure {isInvoice ? "invoice" : "order"} approval</div>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center rounded-2xl border border-black/[0.06] bg-white py-24 shadow-sm">
            <Loader2 className="h-7 w-7 animate-spin text-amber-500" />
          </div>
        ) : notFound || !view ? (
          <div className="rounded-2xl border border-black/[0.06] bg-white p-8 text-center shadow-sm">
            {closedStatus === "APPROVED" ? (
              <CheckCircle2 className="mx-auto mb-3 h-12 w-12 text-emerald-500" />
            ) : (
              <XCircle className="mx-auto mb-3 h-12 w-12 text-zinc-300" />
            )}
            <h1 className="text-lg font-bold">
              {closedStatus === "APPROVED" ? "Order already confirmed" : "Link not available"}
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              {closedStatus === "APPROVED"
                ? "This secure link expired immediately after confirmation. No further action is needed."
                : "This approval link is invalid or expired. Please contact your supplier for a fresh link."}
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-black/[0.06] bg-white shadow-sm">
            {/* Status banner */}
            {confirmed ? (
              <div className="flex items-center gap-3 bg-emerald-50 px-5 py-4 text-emerald-800">
                <CheckCircle2 className="h-6 w-6 shrink-0" />
                <div>
                  <div className="text-sm font-bold">{isInvoice ? "Invoice confirmed and generated" : "Order confirmed"}</div>
                  <div className="text-[0.72rem] text-emerald-700/80">
                    Confirmed by {view.party_confirmed_name || view.party_name}
                    {view.party_confirmed_at ? ` · ${fmtDate(view.party_confirmed_at)}` : ""}. This link is now closed.
                  </div>
                </div>
              </div>
            ) : dead ? (
              <div className="flex items-center gap-3 bg-zinc-100 px-5 py-4 text-zinc-600">
                <Clock className="h-6 w-6 shrink-0" />
                <div>
                  <div className="text-sm font-bold">Link expired</div>
                  <div className="text-[0.72rem] text-zinc-500">This approval link is no longer valid.</div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 bg-amber-50 px-5 py-4 text-amber-800">
                <ShieldCheck className="h-6 w-6 shrink-0" />
                <div>
                  <div className="text-sm font-bold">Awaiting your confirmation</div>
                  <div className="text-[0.72rem] text-amber-700/80">
                    Review the products, quantities and prices below, then confirm the {isInvoice ? "invoice" : "order"}.
                  </div>
                </div>
              </div>
            )}

            {/* Order head */}
            <div className="flex items-start justify-between gap-4 border-t border-zinc-100 px-5 py-4">
              <div>
                <div className="text-base font-bold">{view.order_number}</div>
                <div className="text-[0.72rem] text-zinc-500">{fmtDate(view.order_date)}</div>
              </div>
              <div className="text-right">
                <div className="text-[0.62rem] uppercase tracking-wide text-zinc-400">Bill to</div>
                <div className="text-sm font-semibold">{view.party_name}</div>
              </div>
            </div>

            {/* Dual-approval strip */}
            <div className="grid grid-cols-2 gap-px border-t border-zinc-100 bg-zinc-100">
              <div className="flex items-center gap-2 bg-white px-5 py-3">
                <BadgeCheck className="h-4 w-4 text-emerald-500" />
                <div className="text-[0.72rem]">
                  <div className="font-semibold text-zinc-700">Supplier approved</div>
                  <div className="text-zinc-400">{view.company_name || "Seller"}</div>
                </div>
              </div>
              <div className="flex items-center gap-2 bg-white px-5 py-3">
                {confirmed ? (
                  <BadgeCheck className="h-4 w-4 text-emerald-500" />
                ) : (
                  <Clock className="h-4 w-4 text-amber-500" />
                )}
                <div className="text-[0.72rem]">
                  <div className="font-semibold text-zinc-700">{confirmed ? "You confirmed" : "Your confirmation"}</div>
                  <div className="text-zinc-400">{confirmed ? view.party_confirmed_name || view.party_name : "Pending"}</div>
                </div>
              </div>
            </div>

            {/* Items */}
            <div className="border-t border-zinc-100">
              <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-5 py-2 text-[0.62rem] uppercase tracking-wide text-zinc-400">
                <span>Product</span>
                <span className="text-right">Qty × Price</span>
                <span className="text-right">Amount</span>
              </div>
              {view.items.length === 0 ? (
                <div className="px-5 py-6 text-center text-sm text-zinc-400">No items on this order.</div>
              ) : (
                view.items.map((it, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[1fr_auto_auto] items-center gap-2 border-t border-zinc-50 px-5 py-3"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-zinc-800">{it.name}</div>
                      {it.sku ? <div className="text-[0.66rem] text-zinc-400">{it.sku}</div> : null}
                    </div>
                    <div className="whitespace-nowrap text-right text-[0.72rem] text-zinc-500">
                      {it.quantity}
                      {it.unit ? ` ${it.unit}` : ""} × {money(it.unit_price)}
                    </div>
                    <div className="whitespace-nowrap text-right text-sm font-semibold text-zinc-900">
                      {money(it.line_total)}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Total */}
            <div className="flex items-center justify-between border-t border-zinc-100 bg-zinc-50 px-5 py-4">
              <span className="text-sm font-semibold text-zinc-600">Grand Total</span>
              <span className="text-xl font-bold text-amber-600">{money(view.grand_total)}</span>
            </div>

            {/* Actions */}
            <div className="space-y-3 border-t border-zinc-100 px-5 py-5">
              <button
                onClick={() => pdfData && downloadOrderPdf(pdfData)}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 py-3 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-50"
              >
                <Download className="h-4 w-4" />
                Download PDF
              </button>

              {!confirmed && !dead && (
                <>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name (optional)"
                    className="w-full rounded-xl border border-zinc-200 px-4 py-3 text-sm outline-none focus:border-amber-400"
                  />
                  {error && <div className="text-[0.72rem] font-medium text-red-500">{error}</div>}
                  <button
                    onClick={confirm}
                    disabled={submitting}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3.5 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-60"
                  >
                    {submitting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4" />
                    )}
                    {submitting ? "Confirming…" : isInvoice ? "Confirm & Generate Invoice" : "Confirm Order"}
                  </button>
                  <p className="text-center text-[0.66rem] text-zinc-400">
                    By confirming you approve the products, quantities and prices above.
                    {isInvoice ? " Your invoice will be generated immediately." : ""} This link is single-use and expires once confirmed.
                  </p>
                </>
              )}
            </div>
          </div>
        )}

        <div className="mt-5 text-center text-[0.66rem] text-zinc-400">
          Powered by OrderPlus ERP · Secure single-use link
        </div>
      </div>
    </div>
  );
}
