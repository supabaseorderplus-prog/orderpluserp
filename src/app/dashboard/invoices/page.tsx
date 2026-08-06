"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { api, getUser } from "@/lib/api";
import InvoiceRequestsSection from "@/components/invoice-requests-section";
import {
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  Clock,
  FileText,
  Image as ImageIcon,
  Loader2,
  MapPinned,
  Package,
  Printer,
  RotateCcw,
  Search,
  Send,
  Truck,
  Upload,
  X,
  XCircle,
  Boxes,
} from "lucide-react";
import {
  DeliveryLot,
  DeliveryLotStatus,
  fetchDeliveryLots,
} from "@/lib/delivery-lots";
import { invoiceRequestsByOrder } from "@/lib/invoice-request-display";

/* ─── Types ─── */
interface Order {
  id: string;
  order_number: string;
  buyer_id?: string | null;
  billing_party_id?: string | null;
  status: string;
  grand_total: number;
  subtotal: number;
  discount_amount: number;
  gst_amount: number;
  payment_status: string;
  delivery_date: string | null;
  notes: string | null;
  created_at: string;
  buyer: {
    id: string;
    name: string;
    party_code?: string;
    gstin?: string | null;
    address_line1?: string | null;
    city?: string | null;
    state_id?: string | null;
    party_types?: { name: string } | null;
    states?: { name: string; state_code: string } | null;
  } | null;
  order_items: {
    id: string;
    product_id: string;
    quantity: number;
    unit_price: number;
    discount_percent: number;
    discount_amount: number;
    gst_rate: number;
    gst_amount: number;
    line_total: number;
    products: { name: string; sku: string; unit_of_measure?: string } | null;
  }[];
}

interface InvoiceRequest {
  id: string;
  order_id: string;
  lot_id: string | null;
  party_id: string;
  status: "PENDING" | "CONFIRMED" | "REJECTED";
  invoice_number: string | null;
  notes: string | null;
  created_at: string;
  confirmed_at: string | null;
}

interface ShareInvoiceData {
  whatsapp_url: string;
  approval_url: string;
  pdf_url: string;
  expires_at: string;
}

function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
    </svg>
  );
}

type LotFilter = "all" | "DISPATCHED" | "DELIVERED" | "INVOICED";
type TabView = "lots";

const fmt = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n);
const fmtDate = (s: string) =>
  new Date(s).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

const lotStatusColor = (status: DeliveryLotStatus) =>
  status === "DELIVERED"
    ? "text-emerald-500 bg-emerald-500/10 border-emerald-500/30"
    : status === "DISPATCHED"
      ? "text-sky-500 bg-sky-500/10 border-sky-500/30"
      : "text-zinc-500 bg-black/[0.03] border-black/10";

const invoiceReqStatusStyle = (s: string) =>
  s === "CONFIRMED"
    ? "text-emerald-500 bg-emerald-500/10 border-emerald-500/20"
    : s === "REJECTED"
      ? "text-red-500 bg-red-500/10 border-red-500/20"
      : "text-amber-500 bg-amber-500/10 border-amber-500/20";

/* ─── Print HTML generator ─── */
function generateOrderInvoiceHTML(order: Order, logoUrl?: string | null): string {
  const itemRows = (order.order_items || []).map((item, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${item.products?.name || "—"}<br><small style="color:#666">${item.products?.sku || ""}</small></td>
      <td>${item.quantity} ${item.products?.unit_of_measure || ""}</td>
      <td>${fmt(item.unit_price)}</td>
      <td>${item.discount_percent || 0}%</td>
      <td style="font-weight:600">${fmt(item.line_total)}</td>
    </tr>`).join("");

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${order.order_number}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;font-size:12px;color:#111;padding:28px}.top{text-align:center;margin-bottom:20px;border-bottom:2px solid #111;padding-bottom:12px}.top h1{font-size:20px;letter-spacing:2px}.top h2{font-size:13px;color:#555;margin-top:4px}.top img{max-height:60px;margin-bottom:8px}.header{display:flex;justify-content:space-between;margin-bottom:20px}.party{max-width:48%}.party .label{font-size:9px;text-transform:uppercase;color:#888;margin-bottom:4px;letter-spacing:1px}.party .name{font-weight:700;font-size:14px}.party .info{color:#555;margin-top:2px;font-size:11px}table{width:100%;border-collapse:collapse;margin-top:8px}th{background:#f4f4f5;text-align:left;padding:7px 6px;font-size:10px;text-transform:uppercase;border:1px solid #ddd}td{padding:7px 6px;border:1px solid #eee;vertical-align:top}.totals{margin-top:18px;display:flex;justify-content:flex-end}.totals-box{width:300px;border:1px solid #eee;padding:12px}.totals-row{display:flex;justify-content:space-between;padding:3px 0;font-size:12px}.totals-row.grand{border-top:2px solid #111;margin-top:8px;padding-top:8px;font-weight:700;font-size:15px}.footer{margin-top:36px;text-align:center;color:#aaa;font-size:10px;border-top:1px solid #eee;padding-top:12px}@media print{body{padding:10px}}</style></head><body>
<div class="top">${logoUrl ? `<img src="${logoUrl}" alt="Logo"/>` : ""}<h1>TAX INVOICE</h1><h2>${order.order_number} &bull; ${fmtDate(order.created_at)}</h2></div>
<div class="header"><div class="party"><div class="label">Bill To</div><div class="name">${order.buyer?.name || "—"}</div>${order.buyer?.party_code ? `<div class="info">Code: ${order.buyer.party_code}</div>` : ""}${order.buyer?.gstin ? `<div class="info">GSTIN: <strong>${order.buyer.gstin}</strong></div>` : ""}${order.buyer?.address_line1 ? `<div class="info">${order.buyer.address_line1}${order.buyer.city ? `, ${order.buyer.city}` : ""}</div>` : ""}</div><div class="party" style="text-align:right"><div class="label">Order Details</div><div class="info">Order No: <strong>${order.order_number}</strong></div><div class="info">Date: ${fmtDate(order.created_at)}</div><div class="info">Status: ${order.status}</div></div></div>
<table><thead><tr><th>#</th><th>Product</th><th>Qty</th><th>Rate</th><th>Disc%</th><th>Total</th></tr></thead><tbody>${itemRows}</tbody></table>
<div class="totals"><div class="totals-box"><div class="totals-row"><span>Subtotal</span><span>${fmt(order.subtotal || 0)}</span></div>${order.discount_amount ? `<div class="totals-row"><span>Discount</span><span>-${fmt(order.discount_amount)}</span></div>` : ""}${order.gst_amount ? `<div class="totals-row"><span>GST</span><span>${fmt(order.gst_amount)}</span></div>` : ""}<div class="totals-row grand"><span>Grand Total</span><span>${fmt(order.grand_total)}</span></div></div></div>
<div class="footer">This is a computer-generated invoice. No signature required.</div></body></html>`;
}

/* ─── Main Page ─── */
export default function InvoicesPage() {
  const [lots, setLots] = useState<DeliveryLot[]>([]);
  const [ordersMap, setOrdersMap] = useState<Record<string, Order>>({});
  const [allOrders, setAllOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [lotFilter, setLotFilter] = useState<LotFilter>("DISPATCHED");
  const [expandedLot, setExpandedLot] = useState<string | null>(null);
  const [activeTab] = useState<TabView>("lots");


  // Invoice requests state
  const [invoiceRequests, setInvoiceRequests] = useState<Record<string, InvoiceRequest>>({});
  const [initiatingOrderId, setInitiatingOrderId] = useState<string | null>(null);
  const [sharingOrderId, setSharingOrderId] = useState<string | null>(null);

  // Multi-select state for bulk invoice initiation
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set());
  const [bulkInitiating, setBulkInitiating] = useState(false);
  const [actionError, setActionError] = useState("");

  // Modal state
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);

    // Logo upload state
    const [companyLogo, setCompanyLogo] = useState<string | null>(null);
    const [logoUploading, setLogoUploading] = useState(false);
    const [companyId, setCompanyId] = useState<string | null>(null);
    const logoInputRef = useRef<HTMLInputElement>(null);

    // Party user flag — party users cannot initiate invoices
    const [isPartyUser, setIsPartyUser] = useState(false);
    // Admin flag — only ADMIN / SUPER_ADMIN can re-initiate a rejected invoice
    const [isAdminUser, setIsAdminUser] = useState(false);

  // Fetch company info + logo
  useEffect(() => {
    api<{ success: boolean; data: { id: string; logo_url?: string | null }[] }>("/api/v1/parties?limit=1&is_company=true")
      .then((r) => {
        // Fallback: get from localStorage or just fetch first party with logo
      })
      .catch(() => {});

    // Detect party user from stored session
    const authData = getUser();
    if (authData?.party_id && !["SUPER_ADMIN", "ADMIN"].includes(authData.role || "")) {
      setIsPartyUser(true);
    }
    if (["SUPER_ADMIN", "ADMIN"].includes(authData?.role || "")) {
      setIsAdminUser(true);
    }
    if (authData?.party_id) {
      setCompanyId(authData.party_id);
      api<{ success: boolean; data: { logo_url?: string | null } }>(`/api/v1/parties/${authData.party_id}`)
        .then((r) => {
          if (r.data && (r.data as any).logo_url) {
            setCompanyLogo((r.data as any).logo_url);
          }
        })
        .catch(() => {});
    }
  }, []);

  // Fetch invoice requests
  const fetchInvoiceRequests = useCallback(() => {
    api<{ success: boolean; data: InvoiceRequest[] }>("/api/v1/invoice-requests?limit=500")
      .then((r) => {
        setInvoiceRequests(invoiceRequestsByOrder(r.data || []));
      })
      .catch(() => {});
  }, []);

    const fetchData = useCallback(() => {
      setLoading(true);

    const lotsP = fetchDeliveryLots().catch(() => [] as DeliveryLot[]);
    const ordersP = Promise.all([
      api<{ success: boolean; data: Order[] }>("/api/v1/orders?status=DISPATCHED&limit=500").catch(() => ({ data: [] as Order[] })),
      api<{ success: boolean; data: Order[] }>("/api/v1/orders?status=DELIVERED&limit=500").catch(() => ({ data: [] as Order[] })),
      api<{ success: boolean; data: Order[] }>("/api/v1/orders?status=APPROVED&limit=500").catch(() => ({ data: [] as Order[] })),
      api<{ success: boolean; data: Order[] }>("/api/v1/orders?status=PROCUREMENT&limit=500").catch(() => ({ data: [] as Order[] })),
      api<{ success: boolean; data: Order[] }>("/api/v1/orders?limit=200").catch(() => ({ data: [] as Order[] })),
    ]);

    Promise.all([lotsP, ordersP]).then(([allLots, [dispatched, delivered, approved, procurement, recent]]) => {
        const relevantLots = allLots.filter((l) => l.status === "DISPATCHED" || l.status === "DELIVERED");
        setLots(relevantLots);

        const merged = [
          ...(dispatched.data || []),
          ...(delivered.data || []),
          ...(approved.data || []),
          ...(procurement.data || []),
          ...(recent.data || []),
        ];
        const seen = new Set<string>();
        const unique: Order[] = [];
        merged.forEach((o) => { if (!seen.has(o.id)) { seen.add(o.id); unique.push(o); } });

        const map: Record<string, Order> = {};
        unique.forEach((o) => { map[o.id] = o; });
        setOrdersMap(map);
        setAllOrders(unique.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()));
      }).finally(() => setLoading(false));

      fetchInvoiceRequests();
    }, [fetchInvoiceRequests]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Confirmation commonly happens on the party's phone while this dashboard is
  // already open. Refresh pending badges in the background and immediately when
  // staff return to the tab, so WhatsApp confirmations do not look stuck.
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") fetchInvoiceRequests();
    };
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") fetchInvoiceRequests();
    }, 30000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [fetchInvoiceRequests]);

  async function createInvoiceRequestWithAutoRetry(order: Order, lotId?: string, forcePartyApproval = false) {
    const partyId = order.buyer?.id || order.buyer_id || order.billing_party_id || null;
    if (!partyId) {
      throw new Error("Cannot initiate invoice: buyer/party is missing on this order.");
    }

    const payload = {
      order_id: order.id,
      party_id: partyId,
      lot_id: lotId || null,
      force_party_approval: forcePartyApproval,
    };

    try {
      return await api<{ success: boolean; data: InvoiceRequest }>("/api/v1/invoice-requests", {
        method: "POST",
        body: payload,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const shouldRetry = message.toLowerCase().includes("invoice module was auto-initialized");
      if (!shouldRetry) throw err;

      return await api<{ success: boolean; data: InvoiceRequest }>("/api/v1/invoice-requests", {
        method: "POST",
        body: payload,
      });
    }
  }

  async function shareInvoiceOnWhatsApp(order: Order, lotId?: string, current?: InvoiceRequest | null) {
    if (sharingOrderId) return;
    setSharingOrderId(order.id);
    setActionError("");

    // Reserve the popup during the click gesture. Once the secure token is minted
    // asynchronously we navigate this tab to the party's WhatsApp conversation.
    const waWindow = typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;
    try {
      let request = current || null;
      if (!request) {
        const created = await createInvoiceRequestWithAutoRetry(order, lotId, true);
        request = created.data;
      } else if (request.status === "REJECTED") {
        await api(`/api/v1/invoice-requests/${request.id}`, { method: "PUT", body: { status: "PENDING" } });
        request = { ...request, status: "PENDING" };
      }

      if (!request?.id) throw new Error("The invoice request could not be prepared.");
      if (request.status === "CONFIRMED") throw new Error("This invoice has already been generated.");

      const shared = await api<{ success: boolean; data: ShareInvoiceData }>(
        `/api/v1/orders/${order.id}/share-approval`,
        { method: "POST", body: { purpose: "INVOICE", invoice_request_id: request.id } },
      );
      if (!shared.data?.whatsapp_url) throw new Error("Could not build the WhatsApp message.");

      if (waWindow && !waWindow.closed) waWindow.location.href = shared.data.whatsapp_url;
      else if (typeof window !== "undefined") window.location.href = shared.data.whatsapp_url;
      await fetchInvoiceRequests();
    } catch (err) {
      if (waWindow && !waWindow.closed) waWindow.close();
      setActionError(err instanceof Error ? err.message : "Failed to open WhatsApp invoice confirmation.");
    } finally {
      setSharingOrderId(null);
    }
  }


  async function initiateInvoice(order: Order, lotId?: string) {
    setInitiatingOrderId(order.id);
    setActionError("");
    try {
      await createInvoiceRequestWithAutoRetry(order, lotId);
      fetchInvoiceRequests();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to initiate invoice.");
    }
    setInitiatingOrderId(null);
  }

  // Re-initiate a REJECTED invoice — admin only. Resets the request back to
  // PENDING so it goes to the party for confirmation again.
  async function reinitiateInvoice(order: Order, ir: InvoiceRequest) {
    setInitiatingOrderId(order.id);
    setActionError("");
    try {
      await api(`/api/v1/invoice-requests/${ir.id}`, {
        method: "PUT",
        body: { status: "PENDING" },
      });
      fetchInvoiceRequests();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to re-initiate invoice.");
    }
    setInitiatingOrderId(null);
  }

  // Bulk invoice initiation
  async function bulkInitiateInvoices(orders: Order[], lotId?: string) {
    setBulkInitiating(true);
    setActionError("");
    for (const order of orders) {
      const partyId = order.buyer?.id || order.buyer_id || order.billing_party_id || null;
      if (!partyId || invoiceRequests[order.id]) continue;
      try {
        await createInvoiceRequestWithAutoRetry(order, lotId);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Some invoices could not be initiated.");
      }
    }
    fetchInvoiceRequests();
    setSelectedOrderIds(new Set());
    setBulkInitiating(false);
  }

  function toggleOrderSelection(orderId: string) {
    setSelectedOrderIds((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }

  function toggleSelectAllOrders(orders: Order[]) {
    const selectableIds = orders
      .filter((o) => !invoiceRequests[o.id] && !!(o.buyer?.id || o.buyer_id || o.billing_party_id))
      .map((o) => o.id);
    const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedOrderIds.has(id));
    if (allSelected) {
      setSelectedOrderIds(new Set());
    } else {
      setSelectedOrderIds(new Set(selectableIds));
    }
  }

  function printInvoice(order: Order) {
    const win = window.open("", "_blank", "width=900,height=700");
    if (!win) return;
    win.document.write(generateOrderInvoiceHTML(order, companyLogo));
    win.document.close();
    setTimeout(() => { win.print(); }, 500);
  }

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !companyId) return;
    setLogoUploading(true);
    try {
      const formData = new FormData();
      formData.append("logo", file);
      const res = await fetch(`/api/v1/companies/${companyId}/logo`, {
        method: "POST",
        body: formData,
      });
      const json = await res.json();
      if (json.success && json.data?.logo_url) {
        setCompanyLogo(json.data.logo_url);
      }
    } catch {}
    setLogoUploading(false);
    if (logoInputRef.current) logoInputRef.current.value = "";
  }

  async function removeLogo() {
    if (!companyId) return;
    setLogoUploading(true);
    try {
      await fetch(`/api/v1/companies/${companyId}/logo`, { method: "DELETE" });
      setCompanyLogo(null);
    } catch {}
    setLogoUploading(false);
  }

    // Collect IDs of orders that belong to a lot
    const orderIdsInLots = new Set<string>();
    lots.forEach((l) => l.order_ids.forEach((id) => orderIdsInLots.add(id)));

    // Standalone orders: not in any lot (all statuses except CANCELLED/PENDING)
    const standaloneOrders = allOrders.filter(
      (o) => !orderIdsInLots.has(o.id) && !["CANCELLED", "PENDING"].includes(o.status)
    );
    const standaloneDelivered = standaloneOrders.filter((o) => o.status === "DELIVERED");
    const standaloneDispatched = standaloneOrders.filter((o) => o.status === "DISPATCHED");

    // Filtered lots
    const filteredLots = lots.filter((lot) => {
      if (lotFilter === "INVOICED") {
        return lot.order_ids.some((oid) => invoiceRequests[oid]?.status === "CONFIRMED");
      }
      if (lotFilter !== "all" && getLotEffectiveStatus(lot) !== lotFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        const lotMatch = lot.lot_number.toLowerCase().includes(q) || lot.name.toLowerCase().includes(q) ||
          (lot.vehicle_no || "").toLowerCase().includes(q) || (lot.driver_name || "").toLowerCase().includes(q) ||
          (lot.destination || "").toLowerCase().includes(q);
        if (lotMatch) return true;
        return lot.order_ids.some((oid) => {
          const o = ordersMap[oid];
          return o && (o.order_number.toLowerCase().includes(q) || (o.buyer?.name || "").toLowerCase().includes(q));
        });
      }
      return true;
    });

    // Filtered standalone orders based on active tab
    const filteredStandaloneOrders = standaloneOrders.filter((o) => {
      if (lotFilter === "DISPATCHED") return o.status === "DISPATCHED";
      if (lotFilter === "DELIVERED") return o.status === "DELIVERED";
      if (lotFilter === "INVOICED") {
        return invoiceRequests[o.id]?.status === "CONFIRMED";
      }
      if (search) {
        const q = search.toLowerCase();
        return o.order_number.toLowerCase().includes(q) || (o.buyer?.name || "").toLowerCase().includes(q);
      }
      return true;
    });

    // Filtered orders for "Orders" tab
    const filteredOrders = allOrders.filter((o) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return o.order_number.toLowerCase().includes(q) || (o.buyer?.name || "").toLowerCase().includes(q);
    });

    // Stats - include both lot-based and standalone
    const lotDispatchedCount = lots.filter((l) => getLotEffectiveStatus(l) === "DISPATCHED").length;
    const lotDeliveredCount = lots.filter((l) => getLotEffectiveStatus(l) === "DELIVERED").length;
    const dispatchedCount = lotDispatchedCount + standaloneDispatched.length;
    const deliveredCount = lotDeliveredCount + standaloneDelivered.length;
    const lotTotalValue = lots.reduce((sum, l) =>
      sum + l.order_ids.reduce((s, oid) => s + Number(ordersMap[oid]?.grand_total || 0), 0), 0);
    const standaloneTotalValue = standaloneOrders.reduce((sum, o) => sum + Number(o.grand_total || 0), 0);
    const totalValue = lotTotalValue + standaloneTotalValue;
    const pendingInvoices = Object.values(invoiceRequests).filter((r) => r.status === "PENDING").length;
    const confirmedInvoices = Object.values(invoiceRequests).filter((r) => r.status === "CONFIRMED").length;
    const invoicedCount = confirmedInvoices;

  function getLotValue(lot: DeliveryLot) {
    return lot.order_ids.reduce((sum, oid) => sum + Number(ordersMap[oid]?.grand_total || 0), 0);
  }

  // A lot is effectively DELIVERED once every order in it is delivered — i.e. its
  // invoice request has been confirmed by the party (or the order is already
  // marked DELIVERED). Until then it stays DISPATCHED, even if some invoices were
  // merely initiated/pending. This keeps the lot in the right tab/section.
  function getLotEffectiveStatus(lot: DeliveryLot): DeliveryLotStatus {
    if (lot.status === "DELIVERED") return "DELIVERED";
    const orderIds = lot.order_ids || [];
    if (orderIds.length === 0) return lot.status;
    const allDelivered = orderIds.every(
      (oid) => invoiceRequests[oid]?.status === "CONFIRMED" || ordersMap[oid]?.status === "DELIVERED"
    );
    return allDelivered ? "DELIVERED" : lot.status;
  }

  function getInvoiceRequestStatus(orderId: string) {
    return invoiceRequests[orderId] || null;
  }

  function renderInvoiceButton(order: Order, lotId?: string) {
    const ir = getInvoiceRequestStatus(order.id);
    const isInitiating = initiatingOrderId === order.id;
    const isSharing = sharingOrderId === order.id;

    const whatsappButton = (request?: InvoiceRequest | null) => (
      <button
        onClick={(e) => { e.stopPropagation(); shareInvoiceOnWhatsApp(order, lotId, request); }}
        disabled={isSharing || isInitiating}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#25D366] text-white hover:brightness-95 transition-all font-semibold disabled:opacity-60"
        style={{ fontSize: "0.7rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}
        title="Send item PDF and secure invoice confirmation link on WhatsApp"
      >
        {isSharing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <WhatsAppIcon className="w-3.5 h-3.5" />}
        WhatsApp Invoice
      </button>
    );

    if (ir) {
      const badge = (
        <span
          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border font-semibold ${invoiceReqStatusStyle(ir.status)}`}
          style={{ fontSize: "0.65rem" }}
        >
          {ir.status === "PENDING" && <><Clock className="w-3 h-3" /> Pending Confirmation</>}
          {ir.status === "CONFIRMED" && <><CheckCircle2 className="w-3 h-3" /> Invoice Generated</>}
          {ir.status === "REJECTED" && <><XCircle className="w-3 h-3" /> Rejected</>}
        </span>
      );

      // A party-rejected invoice can be re-sent for confirmation — admins only.
      if (ir.status === "REJECTED" && isAdminUser) {
        return (
          <div className="flex items-center gap-2 flex-wrap">
            {badge}
            <button
              onClick={(e) => { e.stopPropagation(); reinitiateInvoice(order, ir); }}
              disabled={isInitiating}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 text-white hover:bg-amber-600 transition-all font-semibold disabled:opacity-60"
              style={{ fontSize: "0.7rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}
              title="Send this invoice to the party for confirmation again"
            >
              {isInitiating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
              Re-initiate
            </button>
            {!isPartyUser && whatsappButton(ir)}
          </div>
        );
      }

      return (
        <div className="flex items-center gap-2 flex-wrap">
          {badge}
          {ir.status === "PENDING" && !isPartyUser && whatsappButton(ir)}
        </div>
      );
    }

    // Party users cannot initiate invoices
    if (isPartyUser) return null;

    return (
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={(e) => { e.stopPropagation(); initiateInvoice(order, lotId); }}
          disabled={isInitiating || isSharing}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 text-white hover:bg-amber-600 transition-all font-semibold disabled:opacity-60"
          style={{ fontSize: "0.7rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}
        >
          {isInitiating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          Initiate Invoice
        </button>
        {whatsappButton(null)}
      </div>
    );
  }

  const currentUser = getUser();

  // Retailer/party users only see their Invoice Requests — not the lot history
  if (isPartyUser) {
    return (
      <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
        {currentUser?.party_id
          ? <InvoiceRequestsSection partyId={currentUser.party_id} />
          : <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-8 text-center"><p className="text-zinc-500 text-sm">Your account is not linked to a party yet. Please contact your distributor.</p></div>
        }
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      {/* Header + Logo Upload */}
      <div className="flex items-start justify-between mb-6 gap-4">
        <div className="flex items-center gap-4">
          {/* Company Logo */}
          <div className="relative group">
            {companyLogo ? (
              <div className="relative w-14 h-14 rounded-xl border border-black/[0.08] bg-white overflow-hidden flex items-center justify-center">
                <img src={companyLogo} alt="Logo" className="max-w-full max-h-full object-contain p-1" />
                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1">
                  <button
                    onClick={() => logoInputRef.current?.click()}
                    className="p-1 rounded text-white/90 hover:text-white"
                    style={{ background: "none", border: "none", cursor: "pointer" }}
                    title="Change logo"
                  >
                    <Upload className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={removeLogo}
                    className="p-1 rounded text-white/90 hover:text-red-400"
                    style={{ background: "none", border: "none", cursor: "pointer" }}
                    title="Remove logo"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => logoInputRef.current?.click()}
                disabled={logoUploading || !companyId}
                className="w-14 h-14 rounded-xl border-2 border-dashed border-black/10 bg-white flex flex-col items-center justify-center text-zinc-400 hover:border-amber-500/30 hover:text-amber-500 transition-all disabled:opacity-50"
                style={{ cursor: "pointer" }}
                title="Upload company logo"
              >
                {logoUploading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <>
                    <ImageIcon className="w-5 h-5" />
                    <span style={{ fontSize: "0.5rem", marginTop: 2 }}>Logo</span>
                  </>
                )}
              </button>
            )}
            <input ref={logoInputRef} type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-zinc-900 mb-0.5" style={{ fontSize: "1.5rem" }}>
              Invoices &mdash; Lot History
            </h1>
            <p className="text-zinc-500" style={{ fontSize: "0.8rem" }}>
              {isPartyUser
                ? "View your invoice requests. Approve delivery to confirm invoices."
                : "Dispatched & delivered lots. Initiate invoices that parties must confirm before generation."}
            </p>
          </div>
        </div>
        <button
          onClick={fetchData}
          className="px-3 py-1.5 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:border-black/20 transition-all shrink-0"
          style={{ fontSize: "0.75rem", background: "none", fontFamily: "inherit", cursor: "pointer" }}
        >
          Refresh
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
        <div className="rounded-xl border border-black/[0.07] bg-white p-3.5">
          <div className="text-zinc-400 mb-1" style={{ fontSize: "0.6rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Total Lots</div>
          <div className="text-xl font-bold text-zinc-900">{lots.length}</div>
        </div>
        <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 p-3.5">
          <div className="text-sky-500 mb-1" style={{ fontSize: "0.6rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Dispatched</div>
          <div className="text-xl font-bold text-sky-500">{dispatchedCount}</div>
        </div>
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3.5">
          <div className="text-emerald-600 mb-1" style={{ fontSize: "0.6rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Delivered</div>
          <div className="text-xl font-bold text-emerald-500">{deliveredCount}</div>
        </div>
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3.5">
          <div className="text-amber-500 mb-1" style={{ fontSize: "0.6rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Pending Invoices</div>
          <div className="text-xl font-bold text-amber-500">{pendingInvoices}</div>
        </div>
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3.5">
          <div className="text-amber-500 mb-1" style={{ fontSize: "0.6rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Total Value</div>
          <div className="text-lg font-bold text-amber-500">{fmt(totalValue)}</div>
        </div>
      </div>

      {/* Tab switcher: Lots / Orders */}
        <div className="flex flex-wrap items-center gap-3 mb-5">

        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <input
            type="text"
              placeholder="Search lot, vehicle, driver, order, party..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-black/[0.08] bg-white text-zinc-900 placeholder:text-zinc-400 outline-none focus:border-amber-500/40"
            style={{ fontSize: "0.82rem", fontFamily: "inherit" }}
          />
        </div>

          <div className="flex items-center gap-1.5 p-1 rounded-xl bg-black/[0.04] border border-black/[0.06]">
              {([
                { key: "DISPATCHED" as LotFilter, label: `Dispatched (${dispatchedCount})` },
                { key: "DELIVERED" as LotFilter, label: `Delivered (${deliveredCount})` },
                { key: "INVOICED" as LotFilter, label: `Invoiced (${invoicedCount})` },
              ]).map((f) => (
              <button
                key={f.key}
                onClick={() => setLotFilter(f.key)}
                className={`px-3 py-1.5 rounded-lg text-sm transition-all ${
                  lotFilter === f.key ? "bg-white text-zinc-900 shadow-sm border border-black/[0.06]" : "text-zinc-500 hover:text-zinc-700"
                }`}
                style={{ fontSize: "0.75rem", fontFamily: "inherit", cursor: "pointer", border: lotFilter === f.key ? undefined : "none" }}
              >
                {f.label}
              </button>
            ))}
            </div>
        </div>

        {actionError && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-red-700" style={{ fontSize: "0.78rem" }}>
            {actionError}
          </div>
        )}

        {/* ─── LOT HISTORY + STANDALONE ORDERS ─── */}
            {loading ? (
            <div className="flex items-center justify-center py-16 text-zinc-500" style={{ fontSize: "0.9rem" }}>
              <Loader2 className="w-5 h-5 animate-spin mr-2 text-amber-400" />
              Loading invoice data...
            </div>
          ) : filteredLots.length === 0 && filteredStandaloneOrders.length === 0 ? (
            <div className="rounded-2xl border border-black/[0.06] bg-white p-14 text-center">
              <Boxes className="w-12 h-12 text-zinc-200 mx-auto mb-4" />
              <div className="text-zinc-500 font-medium mb-1" style={{ fontSize: "0.95rem" }}>
                {lots.length === 0 && standaloneOrders.length === 0
                  ? "No dispatched or delivered orders yet"
                  : "No items match your filter"}
              </div>
              {lots.length === 0 && standaloneOrders.length === 0 && (
                <div className="text-zinc-400" style={{ fontSize: "0.8rem" }}>
                  Orders marked as <strong>DISPATCHED</strong> or <strong>DELIVERED</strong> will appear here for invoicing.
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {/* Lot-based orders */}
              {filteredLots.map((lot) => {
                const isExpanded = expandedLot === lot.id;
                const lotOrders = lot.order_ids.map((oid) => ordersMap[oid]).filter(Boolean) as Order[];
                const lotValue = getLotValue(lot);
                const lotInitiatedCount = lotOrders.filter((o) => invoiceRequests[o.id]).length;
                const lotStatus = getLotEffectiveStatus(lot);

                return (
                  <div key={lot.id} className="rounded-2xl border border-black/[0.06] bg-white shadow-sm overflow-hidden">
                    {/* Lot header */}
                    <div
                      className="flex cursor-pointer items-center gap-4 px-5 py-4 hover:bg-black/[0.02] transition-colors"
                        onClick={() => { setExpandedLot(isExpanded ? null : lot.id); setSelectedOrderIds(new Set()); }}
                    >
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border ${
                        lotStatus === "DELIVERED" ? "bg-emerald-500/10 border-emerald-500/20" : "bg-sky-500/10 border-sky-500/20"
                      }`}>
                        {lotStatus === "DELIVERED" ? <CheckCircle2 className="w-5 h-5 text-emerald-400" /> : <Truck className="w-5 h-5 text-sky-400" />}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-0.5">
                          <span className="font-semibold text-zinc-900" style={{ fontSize: "0.88rem" }}>{lot.name || lot.lot_number}</span>
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-medium ${lotStatusColor(lotStatus)}`} style={{ fontSize: "0.6rem", letterSpacing: "0.04em" }}>{lotStatus}</span>
                        </div>
                        <div className="flex flex-wrap gap-3 text-zinc-500" style={{ fontSize: "0.68rem" }}>
                          {lot.vehicle_no && <span className="inline-flex items-center gap-1"><Truck className="w-3 h-3" /> {lot.vehicle_no}</span>}
                          {lot.driver_name && <span className="inline-flex items-center gap-1 text-amber-500 font-medium">Driver: {lot.driver_name}</span>}
                          {lot.destination && <span className="inline-flex items-center gap-1"><MapPinned className="w-3 h-3" /> {lot.destination}</span>}
                          {lot.dispatch_date && <span>{fmtDate(lot.dispatch_date)}</span>}
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <div className="font-bold text-zinc-900" style={{ fontSize: "0.92rem" }}>{fmt(lotValue)}</div>
                        <div className="text-zinc-500" style={{ fontSize: "0.68rem" }}>
                          {lotOrders.length} order{lotOrders.length !== 1 ? "s" : ""}
                          {lotInitiatedCount > 0 && <span className="text-amber-500 ml-1">({lotInitiatedCount} initiated)</span>}
                        </div>
                      </div>

                      <svg className={`w-5 h-5 text-zinc-400 shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>

                    {/* Expanded: orders inside lot */}
                    {isExpanded && (
                      <div className="border-t border-black/[0.06] bg-black/[0.01]">
                        {lotOrders.length === 0 ? (
                          <div className="px-5 py-6 text-center text-zinc-400" style={{ fontSize: "0.82rem" }}>No order data available for this lot.</div>
                        ) : (
                          <div>
                              {/* Selection toolbar */}
                              {(() => {
                                const selectableOrders = lotOrders.filter((o) => !invoiceRequests[o.id] && !!(o.buyer?.id || o.buyer_id || o.billing_party_id));
                                const selectedInLot = selectableOrders.filter((o) => selectedOrderIds.has(o.id));
                                if (!isPartyUser && selectableOrders.length > 0 && selectedInLot.length > 0) {
                                  return (
                                    <div className="flex items-center justify-between px-5 py-2.5 bg-amber-500/10 border-b border-amber-500/20">
                                      <span className="text-amber-700 font-medium" style={{ fontSize: "0.78rem" }}>
                                        {selectedInLot.length} order{selectedInLot.length !== 1 ? "s" : ""} selected
                                      </span>
                                      <button
                                        onClick={() => bulkInitiateInvoices(selectedInLot, lot.id)}
                                        disabled={bulkInitiating}
                                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-500 text-white hover:bg-amber-600 transition-all font-semibold disabled:opacity-60"
                                        style={{ fontSize: "0.75rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}
                                      >
                                        {bulkInitiating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                                        Initiate Invoice for Selected ({selectedInLot.length})
                                      </button>
                                    </div>
                                  );
                                }
                                return null;
                              })()}
                              <div className="grid grid-cols-[auto_auto_1fr_auto_auto_auto] gap-4 px-5 py-2.5 border-b border-black/[0.06] bg-black/[0.02]">
                                {!isPartyUser && (() => {
                                  const selectableOrders = lotOrders.filter((o) => !invoiceRequests[o.id] && !!(o.buyer?.id || o.buyer_id || o.billing_party_id));
                                  const allSelected = selectableOrders.length > 0 && selectableOrders.every((o) => selectedOrderIds.has(o.id));
                                  return selectableOrders.length > 0 ? (
                                    <div className="flex items-center w-6">
                                      <input
                                        type="checkbox"
                                        checked={allSelected}
                                        onChange={() => toggleSelectAllOrders(lotOrders)}
                                        className="w-3.5 h-3.5 rounded border-zinc-300 text-amber-500 accent-amber-500 cursor-pointer"
                                      />
                                    </div>
                                  ) : <div className="w-6" />;
                                })()}
                                <div className="text-zinc-400 w-8" style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>#</div>
                                <div className="text-zinc-400" style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Order / Party</div>
                                <div className="text-zinc-400" style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Items</div>
                                <div className="text-zinc-400 text-right" style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Amount</div>
                                <div className="text-zinc-400 text-right" style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Action</div>
                              </div>
                              {lotOrders.map((order, idx) => {
                                const isSelectable = !invoiceRequests[order.id] && !!(order.buyer?.id || order.buyer_id || order.billing_party_id) && !isPartyUser;
                                const isSelected = selectedOrderIds.has(order.id);
                                return (
                                <div
                                  key={order.id}
                                  className={`grid grid-cols-[auto_auto_1fr_auto_auto_auto] gap-4 items-center px-5 py-3.5 hover:bg-black/[0.015] transition-colors ${
                                    idx < lotOrders.length - 1 ? "border-b border-black/[0.04]" : ""
                                  } ${isSelected ? "bg-amber-500/[0.04]" : ""}`}
                                >
                                  <div className="flex items-center w-6">
                                    {isSelectable ? (
                                      <input
                                        type="checkbox"
                                        checked={isSelected}
                                        onChange={() => toggleOrderSelection(order.id)}
                                        className="w-3.5 h-3.5 rounded border-zinc-300 text-amber-500 accent-amber-500 cursor-pointer"
                                      />
                                    ) : <div className="w-3.5" />}
                                  </div>
                                  <div className="text-zinc-400 w-8" style={{ fontSize: "0.72rem" }}>{idx + 1}</div>
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2 mb-0.5">
                                    <span className="text-zinc-900 font-semibold" style={{ fontSize: "0.82rem" }}>{order.order_number}</span>
                                  </div>
                                  <div className="text-zinc-500 truncate" style={{ fontSize: "0.72rem" }}>
                                    {order.buyer?.name || "—"}
                                    {order.buyer?.party_types?.name && <span className="text-zinc-400 ml-1.5">({order.buyer.party_types.name.replace(/_/g, " ")})</span>}
                                  </div>
                                </div>
                                <div className="text-zinc-500 shrink-0" style={{ fontSize: "0.72rem" }}>
                                  {(order.order_items || []).length} item{(order.order_items || []).length !== 1 ? "s" : ""}
                                </div>
                                <div className="text-right shrink-0">
                                  <div className="font-bold text-zinc-900" style={{ fontSize: "0.88rem" }}>{fmt(Number(order.grand_total))}</div>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  <button
                                    onClick={() => setSelectedOrder(order)}
                                    className="px-3 py-1.5 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:border-black/20 transition-all"
                                    style={{ fontSize: "0.7rem", background: "none", fontFamily: "inherit", cursor: "pointer" }}
                                  >
                                    <FileText className="w-3.5 h-3.5 inline mr-1" /> View
                                  </button>
                                  <button
                                    onClick={() => printInvoice(order)}
                                    className="px-3 py-1.5 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:border-black/20 transition-all"
                                    style={{ fontSize: "0.7rem", background: "none", fontFamily: "inherit", cursor: "pointer" }}
                                  >
                                    <Printer className="w-3.5 h-3.5 inline mr-1" /> Print
                                  </button>
                                    {renderInvoiceButton(order, lot.id)}
                                  </div>
                                </div>
                                );
                              })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

            </div>
          )}

      {/* ─── GENERATED INVOICES SECTION (only on Invoiced filter) ─── */}
      {lotFilter === "INVOICED" && (() => {
        const confirmedRequests = Object.values(invoiceRequests).filter((ir) => ir.status === "CONFIRMED");
        return (
          <div className="mt-8">
            <div className="flex items-center gap-2 mb-3">
              <FileText className="w-4 h-4 text-amber-500" />
              <h2 className="font-bold text-zinc-900" style={{ fontSize: "1rem" }}>Generated Invoices</h2>
              <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 font-semibold border border-amber-500/20" style={{ fontSize: "0.68rem" }}>
                {confirmedRequests.length}
              </span>
            </div>
            {confirmedRequests.length === 0 ? (
              <div className="rounded-2xl border border-black/[0.06] bg-white p-10 text-center">
                <FileText className="w-10 h-10 text-zinc-200 mx-auto mb-3" />
                <div className="text-zinc-500 font-medium" style={{ fontSize: "0.9rem" }}>No generated invoices yet</div>
              </div>
            ) : (
              <div className="rounded-2xl border border-black/[0.06] bg-white shadow-sm overflow-hidden">
                <div className="grid border-b border-black/[0.06] bg-black/[0.02] px-5 py-2.5" style={{ gridTemplateColumns: "1.2fr 1.5fr 1fr 1fr auto" }}>
                  {["Invoice #", "Order", "Party", "Confirmed", "Amount"].map((h) => (
                    <div key={h} className="text-zinc-400" style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</div>
                  ))}
                </div>
                {confirmedRequests.map((ir) => {
                  const order = ordersMap[ir.order_id];
                  return (
                    <div key={ir.id} className="grid items-center border-b border-black/[0.04] px-5 py-3 hover:bg-black/[0.015] transition-colors" style={{ gridTemplateColumns: "1.2fr 1.5fr 1fr 1fr auto" }}>
                      <div className="font-mono font-semibold text-zinc-900" style={{ fontSize: "0.8rem" }}>{ir.invoice_number || "—"}</div>
                      <div className="text-zinc-700 truncate pr-2" style={{ fontSize: "0.8rem" }}>{order?.order_number || "—"}</div>
                      <div className="text-zinc-600 truncate pr-2" style={{ fontSize: "0.78rem" }}>{order?.buyer?.name || "—"}</div>
                      <div className="text-zinc-500" style={{ fontSize: "0.75rem" }}>{ir.confirmed_at ? fmtDate(ir.confirmed_at) : "—"}</div>
                      <div className="font-bold text-zinc-900" style={{ fontSize: "0.85rem" }}>{order ? fmt(Number(order.grand_total)) : "—"}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      {selectedOrder && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
          style={{ background: "rgba(0,0,0,0.55)" }}
          onClick={(e) => { if (e.target === e.currentTarget) setSelectedOrder(null); }}
        >
          <div className="bg-white rounded-2xl border border-black/[0.08] shadow-2xl w-full max-w-3xl my-8">
            {/* Modal header */}
            <div className="sticky top-0 bg-white rounded-t-2xl border-b border-black/[0.06] px-6 py-4 flex items-center justify-between z-10">
              <div className="flex items-center gap-3">
                {companyLogo && (
                  <img src={companyLogo} alt="Logo" className="h-8 object-contain" />
                )}
                <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                  <FileText className="w-4 h-4 text-amber-400" />
                </div>
                <div>
                  <div className="font-bold text-zinc-900" style={{ fontSize: "0.95rem" }}>{selectedOrder.order_number}</div>
                  <div className="text-zinc-500" style={{ fontSize: "0.7rem" }}>{fmtDate(selectedOrder.created_at)} · {selectedOrder.buyer?.name}</div>
                </div>
                {(() => {
                  const ir = getInvoiceRequestStatus(selectedOrder.id);
                  if (!ir) return null;
                  return (
                    <span className={`px-2 py-0.5 rounded-full border font-bold ${invoiceReqStatusStyle(ir.status)}`} style={{ fontSize: "0.6rem" }}>
                      {ir.status === "PENDING" ? "AWAITING CONFIRMATION" : ir.status === "CONFIRMED" ? "INVOICE GENERATED" : "REJECTED"}
                    </span>
                  );
                })()}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => printInvoice(selectedOrder)}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:border-black/20 transition-all"
                  style={{ fontSize: "0.75rem", background: "none", fontFamily: "inherit", cursor: "pointer" }}
                >
                  <Printer className="w-3.5 h-3.5" /> Print
                </button>
                {renderInvoiceButton(selectedOrder)}
                <button
                  onClick={() => setSelectedOrder(null)}
                  className="p-2 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/5 transition-all"
                  style={{ background: "none", border: "none", cursor: "pointer" }}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Modal body */}
            <div className="p-6 space-y-6">
              {/* Party + Order info */}
              <div className="grid grid-cols-2 gap-6">
                <div className="rounded-xl border border-black/[0.07] bg-black/[0.015] p-4">
                  <div className="text-zinc-400 mb-2" style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.07em" }}>Bill To</div>
                  <div className="font-bold text-zinc-900 mb-1" style={{ fontSize: "0.92rem" }}>{selectedOrder.buyer?.name}</div>
                  {selectedOrder.buyer?.party_code && <div className="text-zinc-500" style={{ fontSize: "0.72rem" }}>Code: {selectedOrder.buyer.party_code}</div>}
                  {selectedOrder.buyer?.gstin && <div className="text-zinc-500 font-mono mt-0.5" style={{ fontSize: "0.72rem" }}>GSTIN: {selectedOrder.buyer.gstin}</div>}
                  {selectedOrder.buyer?.address_line1 && (
                    <div className="text-zinc-600 mt-1" style={{ fontSize: "0.72rem" }}>
                      {selectedOrder.buyer.address_line1}{selectedOrder.buyer.city ? `, ${selectedOrder.buyer.city}` : ""}
                    </div>
                  )}
                </div>
                <div className="rounded-xl border border-black/[0.07] bg-black/[0.015] p-4">
                  <div className="text-zinc-400 mb-2" style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.07em" }}>Order Details</div>
                  <div className="space-y-1.5">
                    {[
                      ["Order No", selectedOrder.order_number],
                      ["Date", fmtDate(selectedOrder.created_at)],
                      ["Status", selectedOrder.status],
                      ...(selectedOrder.delivery_date ? [["Delivery Date", fmtDate(selectedOrder.delivery_date)]] : []),
                    ].map(([label, value]) => (
                      <div key={label} className="flex justify-between">
                        <span className="text-zinc-500" style={{ fontSize: "0.75rem" }}>{label}</span>
                        <span className="text-zinc-900 font-medium" style={{ fontSize: "0.75rem" }}>{value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Items table */}
              <div className="rounded-xl border border-black/[0.08] overflow-x-auto">
                <table className="w-full min-w-[540px]" style={{ borderCollapse: "collapse" }}>
                  <thead>
                    <tr className="bg-black/[0.03] border-b border-black/[0.08]">
                      {["#", "Product", "Qty", "Rate", "Disc%", "Total"].map((h) => (
                        <th key={h} className="text-left px-3 py-2.5 text-zinc-500" style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(selectedOrder.order_items || []).map((item, i) => (
                      <tr key={item.id} className="border-b border-black/[0.04] hover:bg-black/[0.015]">
                        <td className="px-3 py-2.5 text-zinc-400" style={{ fontSize: "0.72rem" }}>{i + 1}</td>
                        <td className="px-3 py-2.5" style={{ fontSize: "0.8rem" }}>
                          <div className="text-zinc-900">{item.products?.name || "—"}</div>
                          <div className="text-zinc-400" style={{ fontSize: "0.62rem" }}>{item.products?.sku}</div>
                        </td>
                        <td className="px-3 py-2.5 text-zinc-700" style={{ fontSize: "0.78rem" }}>
                          {item.quantity} <span className="text-zinc-400">{item.products?.unit_of_measure}</span>
                        </td>
                        <td className="px-3 py-2.5 text-zinc-700" style={{ fontSize: "0.78rem" }}>{fmt(item.unit_price)}</td>
                        <td className="px-3 py-2.5 text-zinc-600" style={{ fontSize: "0.78rem" }}>{item.discount_percent || 0}%</td>
                        <td className="px-3 py-2.5 text-zinc-900 font-semibold" style={{ fontSize: "0.82rem" }}>{fmt(item.line_total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Totals */}
              <div className="flex justify-end">
                <div className="rounded-xl border border-black/[0.08] p-5 w-full max-w-sm">
                  <div className="font-semibold text-zinc-900 mb-4" style={{ fontSize: "0.85rem" }}>Summary</div>
                  <div className="space-y-2.5">
                    <div className="flex justify-between">
                      <span className="text-zinc-500" style={{ fontSize: "0.8rem" }}>Subtotal</span>
                      <span className="text-zinc-900" style={{ fontSize: "0.8rem" }}>{fmt(selectedOrder.subtotal || 0)}</span>
                    </div>
                    {(selectedOrder.discount_amount || 0) > 0 && (
                      <div className="flex justify-between">
                        <span className="text-zinc-500" style={{ fontSize: "0.8rem" }}>Discount</span>
                        <span className="text-red-500" style={{ fontSize: "0.8rem" }}>-{fmt(selectedOrder.discount_amount)}</span>
                      </div>
                    )}
                    {(selectedOrder.gst_amount || 0) > 0 && (
                      <div className="flex justify-between">
                        <span className="text-zinc-500" style={{ fontSize: "0.8rem" }}>GST</span>
                        <span className="text-zinc-700" style={{ fontSize: "0.8rem" }}>{fmt(selectedOrder.gst_amount)}</span>
                      </div>
                    )}
                    <div className="border-t border-black/[0.07] pt-3 mt-1">
                      <div className="flex justify-between items-center">
                        <span className="font-bold text-zinc-900" style={{ fontSize: "1rem" }}>Grand Total</span>
                        <span className="font-bold text-amber-400" style={{ fontSize: "1.3rem" }}>{fmt(selectedOrder.grand_total)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Invoice Request Status */}
              {(() => {
                const ir = getInvoiceRequestStatus(selectedOrder.id);
                if (!ir) return null;
                return (
                  <div className={`p-4 rounded-xl border ${invoiceReqStatusStyle(ir.status)}`}>
                    <div className="flex items-center gap-2 mb-1">
                      {ir.status === "PENDING" && <Clock className="w-4 h-4" />}
                      {ir.status === "CONFIRMED" && <CheckCircle2 className="w-4 h-4" />}
                      {ir.status === "REJECTED" && <XCircle className="w-4 h-4" />}
                      <span className="font-semibold" style={{ fontSize: "0.85rem" }}>
                        {ir.status === "PENDING" && "Invoice Request Sent — Awaiting Party Confirmation"}
                        {ir.status === "CONFIRMED" && "Party Confirmed Delivery — Invoice Generated"}
                        {ir.status === "REJECTED" && "Party Rejected — Delivery Not Confirmed"}
                      </span>
                    </div>
                    <div style={{ fontSize: "0.72rem" }}>
                      {ir.invoice_number && <span>Invoice: <strong>{ir.invoice_number}</strong> · </span>}
                      Sent to: <strong>{selectedOrder.buyer?.name}</strong>
                      {ir.confirmed_at && <span> · {ir.status === "CONFIRMED" ? "Confirmed" : "Responded"}: {fmtDate(ir.confirmed_at)}</span>}
                    </div>
                  </div>
                );
              })()}

              {selectedOrder.notes && (
                <div className="p-4 rounded-xl border border-black/[0.07] bg-black/[0.02]">
                  <div className="text-zinc-400 mb-1" style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Notes</div>
                  <div className="text-zinc-700" style={{ fontSize: "0.82rem" }}>{selectedOrder.notes}</div>
                </div>
              )}

              {/* Bottom CTA */}
              <div className="flex items-center justify-between pt-2 border-t border-black/[0.06]">
                <div className="text-zinc-400" style={{ fontSize: "0.72rem" }}>
                  {(() => {
                    const ir = getInvoiceRequestStatus(selectedOrder.id);
                    if (!ir) return "Invoice not yet initiated";
                    if (ir.status === "PENDING") return `Invoice request sent on ${fmtDate(ir.created_at)}`;
                    if (ir.status === "CONFIRMED") return `Invoice generated on ${fmtDate(ir.confirmed_at!)}`;
                    return `Rejected on ${fmtDate(ir.confirmed_at!)}`;
                  })()}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => printInvoice(selectedOrder)}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl border border-black/10 text-zinc-700 hover:border-black/20 hover:text-zinc-900 transition-all font-medium"
                    style={{ fontSize: "0.8rem", background: "none", fontFamily: "inherit", cursor: "pointer" }}
                  >
                    <Printer className="w-4 h-4" /> Print Invoice
                  </button>
                  {renderInvoiceButton(selectedOrder)}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
