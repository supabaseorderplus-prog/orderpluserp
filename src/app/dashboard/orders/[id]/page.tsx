"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  Loader2,
  Package,
  Truck,
  XCircle,
} from "lucide-react";

interface OrderDetail {
  id: string;
  orderNumber: string;
  buyer: { name: string; phone: string; address?: string } | null;
  seller: { name: string } | null;
  salesman: { name: string } | null;
  zone: { name: string } | null;
  items: { id: string; product: { name: string; sku: string } | null; qty: number; rate: number; amount: number; gstPercent: number }[];
  grandTotal: number;
  totalGst: number;
  status: string;
  paymentStatus: string;
  paymentMode: string;
  remarks: string | null;
  createdAt: string;
  updatedAt: string;
  timeline: { id: string; action: string; performedBy: { name: string } | null; createdAt: string; remarks: string | null }[];
}

const statusFlow = ["PENDING", "APPROVED", "PROCESSING", "DISPATCHED", "DELIVERED"];
const statusIcons: Record<string, React.ReactNode> = {
  PENDING: <Clock className="w-4 h-4" />,
  APPROVED: <CheckCircle2 className="w-4 h-4" />,
  PROCESSING: <Package className="w-4 h-4" />,
  DISPATCHED: <Truck className="w-4 h-4" />,
  DELIVERED: <CheckCircle2 className="w-4 h-4" />,
  CANCELLED: <XCircle className="w-4 h-4" />,
};

const s: React.CSSProperties = { transform: "none", filter: "none", WebkitTextStroke: "0", background: "none", boxShadow: "none", display: "block", padding: 0 };

export default function OrderDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const res = await api<{ data: OrderDetail }>(`/api/v1/orders/${params.id}`);
        setOrder(res.data);
      } catch { /* empty */ }
      setLoading(false);
    }
    load();
  }, [params.id]);

  const updateStatus = async (action: string) => {
    setActing(true);
    try {
      await api(`/api/v1/orders/${params.id}/${action}`, { method: "POST" });
      const res = await api<{ data: OrderDetail }>(`/api/v1/orders/${params.id}`);
      setOrder(res.data);
    } catch { /* empty */ }
    setActing(false);
  };

  const fmt = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-amber-500 animate-spin" /></div>;
  if (!order) return <div className="text-center py-20 text-zinc-500" style={{ fontSize: "0.875rem" }}>Order not found</div>;

  const currentStep = statusFlow.indexOf(order.status);

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <button
          onClick={() => router.push("/dashboard/orders")}
          className="p-2 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:bg-black/5"
          style={{ fontFamily: "inherit", background: "none", boxShadow: "none", cursor: "pointer" }}
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div>
          <h1 className="text-xl font-bold text-zinc-900" style={{ ...s, fontSize: "1.25rem", marginBottom: "0.15rem" }}>
            {order.orderNumber}
          </h1>
          <p className="text-zinc-500" style={{ fontSize: "0.75rem", margin: 0 }}>
            Created {new Date(order.createdAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          {order.status === "PENDING" && (
            <button
              onClick={() => updateStatus("approve")}
              disabled={acting}
              className="px-4 py-2 rounded-lg bg-blue-600 text-zinc-900 hover:bg-blue-700 disabled:opacity-50"
              style={{ fontSize: "0.8rem", fontFamily: "inherit", border: "none", cursor: "pointer", boxShadow: "none" }}
            >
              Approve
            </button>
          )}
          {order.status === "APPROVED" && (
            <button
              onClick={() => updateStatus("dispatch")}
              disabled={acting}
              className="px-4 py-2 rounded-lg bg-cyan-600 text-zinc-900 hover:bg-cyan-700 disabled:opacity-50"
              style={{ fontSize: "0.8rem", fontFamily: "inherit", border: "none", cursor: "pointer", boxShadow: "none" }}
            >
              Dispatch
            </button>
          )}
          {order.status === "DISPATCHED" && (
            <button
              onClick={() => updateStatus("deliver")}
              disabled={acting}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-zinc-900 hover:bg-emerald-700 disabled:opacity-50"
              style={{ fontSize: "0.8rem", fontFamily: "inherit", border: "none", cursor: "pointer", boxShadow: "none" }}
            >
              Mark Delivered
            </button>
          )}
          {["PENDING", "APPROVED"].includes(order.status) && (
            <button
              onClick={() => updateStatus("cancel")}
              disabled={acting}
              className="px-4 py-2 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 disabled:opacity-50"
              style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", cursor: "pointer", boxShadow: "none" }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Status Timeline */}
      <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-6 mb-6">
        <div className="flex items-center justify-between">
          {statusFlow.map((step, i) => {
            const done = currentStep >= i;
            const isCurrent = order.status === step;
            return (
              <div key={step} className="flex items-center flex-1">
                <div className="flex flex-col items-center">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                    done ? "bg-amber-500/20 text-amber-400" : "bg-black/5 text-zinc-600"
                  } ${isCurrent ? "ring-2 ring-amber-500/40" : ""}`}>
                    {statusIcons[step]}
                  </div>
                  <span className={`text-xs mt-2 ${done ? "text-zinc-700" : "text-zinc-600"}`} style={{ fontSize: "0.65rem" }}>
                    {step}
                  </span>
                </div>
                {i < statusFlow.length - 1 && (
                  <div className={`flex-1 h-px mx-2 ${currentStep > i ? "bg-amber-500/40" : "bg-black/[0.06]"}`} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Order Info */}
        <div className="lg:col-span-2 space-y-6">
          {/* Items */}
          <div className="rounded-xl border border-black/[0.06] overflow-hidden">
            <div className="px-4 py-3 bg-black/[0.02] border-b border-black/[0.06]">
              <h3 className="text-sm font-semibold text-zinc-900" style={{ ...s, fontSize: "0.8rem" }}>Items ({order.items.length})</h3>
            </div>
            <table className="w-full" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr className="border-b border-black/[0.04]">
                  {["Product","Qty","Rate","GST","Amount"].map((h) => (
                    <th key={h} className="text-left px-4 py-2 text-xs text-zinc-500 font-medium" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {order.items.map((item) => (
                  <tr key={item.id} className="border-b border-black/[0.04]">
                    <td className="px-4 py-3">
                      <div className="text-zinc-800" style={{ fontSize: "0.8rem" }}>{item.product?.name || "—"}</div>
                      <div className="text-zinc-500" style={{ fontSize: "0.65rem" }}>{item.product?.sku || ""}</div>
                    </td>
                    <td className="px-4 py-3 text-zinc-700" style={{ fontSize: "0.8rem" }}>{item.qty}</td>
                    <td className="px-4 py-3 text-zinc-700" style={{ fontSize: "0.8rem" }}>{fmt(item.rate)}</td>
                    <td className="px-4 py-3 text-zinc-600" style={{ fontSize: "0.75rem" }}>{item.gstPercent}%</td>
                    <td className="px-4 py-3 text-zinc-900 font-medium" style={{ fontSize: "0.8rem" }}>{fmt(item.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-4 py-3 bg-black/[0.02] border-t border-black/[0.06] flex justify-between">
              <span className="text-zinc-600" style={{ fontSize: "0.8rem" }}>Grand Total</span>
              <span className="text-zinc-900 font-bold" style={{ fontSize: "0.9rem" }}>{fmt(order.grandTotal)}</span>
            </div>
          </div>

          {/* Timeline */}
          {order.timeline && order.timeline.length > 0 && (
            <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-5">
              <h3 className="text-sm font-semibold text-zinc-900 mb-4" style={{ ...s, fontSize: "0.8rem", marginBottom: "1rem" }}>Activity Timeline</h3>
              <div className="space-y-4">
                {order.timeline.map((evt) => (
                  <div key={evt.id} className="flex gap-3">
                    <div className="w-2 h-2 rounded-full bg-amber-500 mt-1.5 shrink-0" />
                    <div>
                      <div className="text-zinc-700" style={{ fontSize: "0.8rem" }}>{evt.action}</div>
                      <div className="text-zinc-500" style={{ fontSize: "0.7rem" }}>
                        {evt.performedBy?.name || "System"} · {new Date(evt.createdAt).toLocaleString("en-IN")}
                      </div>
                      {evt.remarks && <div className="text-zinc-500 mt-0.5" style={{ fontSize: "0.7rem" }}>{evt.remarks}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Sidebar Info */}
        <div className="space-y-4">
          {[
            { title: "Buyer", rows: [{ l: "Name", v: order.buyer?.name }, { l: "Phone", v: order.buyer?.phone }] },
            { title: "Seller", rows: [{ l: "Name", v: order.seller?.name }] },
            { title: "Payment", rows: [{ l: "Status", v: order.paymentStatus }, { l: "Mode", v: order.paymentMode }] },
          ].map((card) => (
            <div key={card.title} className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-4">
              <h4 className="text-xs font-semibold text-zinc-600 mb-3" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>{card.title}</h4>
              <div className="space-y-2">
                {card.rows.map((r) => (
                  <div key={r.l} className="flex justify-between">
                    <span className="text-zinc-500" style={{ fontSize: "0.75rem" }}>{r.l}</span>
                    <span className="text-zinc-800" style={{ fontSize: "0.75rem" }}>{r.v || "—"}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
