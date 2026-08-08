"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { api } from "@/lib/api";
import {
  AlertTriangle, Calculator, Check, ChevronDown, ChevronLeft, ChevronRight, ClipboardList, Clock, ExternalLink, FileText, FolderOpen, IndianRupee, Layers, Loader2, Minus, Package, Pencil, Percent, Plus, RotateCcw, Save, Search, Trash2, UserCheck, Users, X,
} from "lucide-react";

interface Party {
  id: string;
  name: string;
  party_code: string;
  gstin: string | null;
  state_id: string;
  territory_id: string | null;
  credit_limit: number;
  party_type_id?: string | null;
  party_types: { id?: string; name: string } | null;
  price_list_id: string | null;
  default_tax_template_id: string | null;
}
interface Group {
  id: string;
  name: string;
  code: string | null;
  salesman_id?: string | null;
  member_ids: string[];
  member_count: number;
  salesman_name: string | null;
  price_list: { id: string; name: string } | null;
}
// A group's stored `salesman_name` can come back unresolved (a raw id) on some
// deployments. Guard so we never surface a UUID as if it were a person's name.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const looksLikeUuid = (s: string): boolean => UUID_RE.test(s.trim());

// Deterministic avatar palette so each salesman keeps a stable, distinct colour
// across the accordion. Purely visual — never affects data.
const SALESMAN_THEMES = [
  { ring: "ring-amber-300",   grad: "from-amber-400 to-orange-500",   soft: "bg-amber-50",   softText: "text-amber-700",   softBorder: "border-amber-200" },
  { ring: "ring-indigo-300",  grad: "from-indigo-400 to-violet-500",  soft: "bg-indigo-50",  softText: "text-indigo-700",  softBorder: "border-indigo-200" },
  { ring: "ring-emerald-300", grad: "from-emerald-400 to-teal-500",   soft: "bg-emerald-50", softText: "text-emerald-700", softBorder: "border-emerald-200" },
  { ring: "ring-rose-300",    grad: "from-rose-400 to-pink-500",      soft: "bg-rose-50",    softText: "text-rose-700",    softBorder: "border-rose-200" },
  { ring: "ring-sky-300",     grad: "from-sky-400 to-cyan-500",       soft: "bg-sky-50",     softText: "text-sky-700",     softBorder: "border-sky-200" },
  { ring: "ring-fuchsia-300", grad: "from-fuchsia-400 to-purple-500", soft: "bg-fuchsia-50", softText: "text-fuchsia-700", softBorder: "border-fuchsia-200" },
];
function salesmanTheme(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return SALESMAN_THEMES[h % SALESMAN_THEMES.length];
}
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

interface Product { id: string; sku: string; name: string; base_price: number; effective_price?: number; unit_of_measure: string; image_url?: string | null; technical_specs?: { image_url?: string | null } | null; category_id?: string | null; category_name?: string | null; product_categories?: { name?: string | null } | null }
const UNCATEGORIZED = "__uncat__";
interface GSTTemplate { id: string; product_name: string; gst_rate: number; gst_category: string; cess_rate: number; transaction_type: "intra" | "inter"; created_at: string }
interface LineItem { productId: string; name: string; sku: string; quantity: number; unitPrice?: number; uom: string; discountPercent: number }
interface CalcResult {
  lines: { taxableAmount: number; cgstAmount: number; sgstAmount: number; igstAmount: number; cessRate: number; cessAmount: number; lineTotal: number; gstRate: number; hsnCode: string }[];
  subtotal: number; discountAmount: number; lineDiscountAmount: number; billDiscountAmount: number; tdPercent: number; tdAmount: number; taxableAmount: number; cgstAmount: number; sgstAmount: number; igstAmount: number; cessAmount: number; grandTotal: number; roundOff: number; isInterstate: boolean;
}
interface UnpaidInvoice { id: string; invoice_number: string; invoice_date: string; grand_total: number; amount_paid: number; amount_outstanding: number; aging_bucket: string; aging_days: number; payment_status: string; due_date: string | null }
interface PartyDues { outstanding: number; total_billed: number; total_paid: number; td_balance: number; cd_balance: number; security_balance: number; wallet_balance: number; opening_balance: number; aging_breakdown: Record<string, number>; unpaid_invoices: UnpaidInvoice[] }
interface CreditScoreSummary {
  score: number | null;
  band: string | null;
  avg_monthly_invoiced: number;
  payment_rate: number;
  avg_outstanding_days: number;
  source?: "history" | "wallet";
}
interface Order {
  id: string; order_number: string; created_at: string; grand_total: number; payment_status: string; status: string; order_type: string;
    order_status?: string | null;
    subtotal?: number | null;
    discount_amount?: number | null;
    notes: string | null;
    approved_by: string | null;
    buyer: { id: string; name: string; party_code: string; party_types: { name: string } | null } | null;
    order_items: { id: string; product_id: string; quantity: number; unit_price: number; line_total: number; discount_percent?: number | null; discount_amount?: number | null; products: { name: string; sku: string; technical_specs?: { net_weight_with_packaging?: number; net_weight_unit?: string } | null } | null }[];
    salesman: { id: string; name: string } | null;
    created_by: string | null;
}

// Total amount saved on an order = gross line value (qty × unit_price, before any
// discount) minus the net grand_total (which now reflects line + bill discounts).
// Derived this way so it works even when optional discount columns are absent.
function orderDiscountSaved(order: Order): number {
  const gross = (order.order_items || []).reduce(
    (sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.unit_price) || 0),
    0,
  );
  const saved = gross - (Number(order.grand_total) || 0);
  return saved > 0.01 ? Math.round(saved * 100) / 100 : 0;
}

// ── Party dual-approval (WhatsApp share) ────────────────────────────────────
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
  whatsapp_delivery: { status: "sent"; to: string; message_id: string | null };
  message: string;
  company_name: string;
  party: { id: string | null; name: string; phone: string; whatsapp_number: string };
}

interface WhatsAppDeliveryPopup {
  orderNumber: string;
  status: "sending" | "sent" | "send_failed" | "approval_failed";
  detail: string;
  partyName?: string;
  to?: string;
  messageId?: string | null;
}

function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
    </svg>
  );
}


const css: React.CSSProperties = { transform: "none", filter: "none", WebkitTextStroke: "0", background: "none", boxShadow: "none", display: "block", padding: 0 };
const ORDER_STATUS_OPTIONS = ["PENDING", "APPROVED", "CANCELLED"] as const;
const ORDER_STATUS_PILLS = ["PENDING", "APPROVED", "CANCELLED"] as const;
const DEFAULT_TAX_TEMPLATE_STORAGE_KEY = "default_tax_template_id";

function getDefaultTaxTemplateStorageKey(companyId: string | null) {
  return companyId ? `${DEFAULT_TAX_TEMPLATE_STORAGE_KEY}:${companyId}` : DEFAULT_TAX_TEMPLATE_STORAGE_KEY;
}

function inferPartyTypeFromCode(code: string | undefined): string | null {
  const c = (code || "").toUpperCase();
  if (c.includes("CNF")) return "CNF";
  if (c.includes("SD")) return "SUPER_DEALER";
  if (c.includes("RT")) return "RETAILER";
  if (c.startsWith("C")) return "COMPANY";
  return null;
}

function normalizePartyType(p: Party): { id?: string; name: string } | null {
  const raw = p.party_types as unknown;
  if (Array.isArray(raw)) {
    const first = raw[0] as { id?: string; name?: string } | undefined;
    if (first?.name) return { id: first.id, name: first.name };
  } else if (raw && typeof raw === "object" && "name" in (raw as Record<string, unknown>)) {
    const obj = raw as { id?: string; name?: string };
    if (obj.name) return { id: obj.id, name: obj.name };
  }
  const inferred = inferPartyTypeFromCode(p.party_code);
  return inferred ? { name: inferred } : null;
}

function getOrderStatus(order: Order) {
  return (order.status || order.order_status || "PENDING").toUpperCase();
}

function dedupeOrders(orderList: Order[]): Order[] {
  return [...new Map(orderList.map((order) => [order.id, order])).values()];
}

// Human-readable stage pill for an order's live status. The "Approved Orders"
// bucket mixes everything past approval (procurement → dispatched → delivered),
// so this badge tells each row's true position in the fulfilment pipeline.
// Note: confirming an invoice walks the order to DELIVERED (see
// invoice-confirm-effects.ts), so DELIVERED is the effective "invoiced" state.
const ORDER_STAGE_META: Record<string, { label: string; className: string }> = {
  PENDING: { label: "Pending", className: "bg-amber-100 text-amber-700 border-amber-200" },
  APPROVED: { label: "Approved", className: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  PROCUREMENT: { label: "In Procurement", className: "bg-blue-100 text-blue-700 border-blue-200" },
  IN_PROCUREMENT: { label: "In Procurement", className: "bg-blue-100 text-blue-700 border-blue-200" },
  DISPATCHED: { label: "Dispatched", className: "bg-violet-100 text-violet-700 border-violet-200" },
  DELIVERED: { label: "Delivered · Invoiced", className: "bg-teal-100 text-teal-700 border-teal-200" },
  INVOICED: { label: "Invoiced", className: "bg-indigo-100 text-indigo-700 border-indigo-200" },
  CANCELLED: { label: "Cancelled", className: "bg-red-100 text-red-700 border-red-200" },
};

function orderStageMeta(order: Order): { label: string; className: string } {
  const status = getOrderStatus(order);
  return ORDER_STAGE_META[status] || { label: status, className: "bg-zinc-100 text-zinc-600 border-zinc-200" };
}

export default function NewInvoicePage() {
  const [step, setStep] = useState(1);
  const [parties, setParties] = useState<Party[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  // Salesman ownership of parties (direct + group-folded), used to show which
  // salesman each group belongs to even when the group's own salesman_id is unset.
  const [groupSalesmen, setGroupSalesmen] = useState<{ id: string; name: string }[]>([]);
  const [salesmanToParties, setSalesmanToParties] = useState<Record<string, string[]>>({});
  // null = show the group list; a group id (or ALL_PARTIES sentinel) = show that
  // group's parties. Lets Step 1 drill from groups → parties within a group.
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [expandedSalesmen, setExpandedSalesmen] = useState<Set<string>>(new Set());
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedParty, setSelectedParty] = useState<Party | null>(null);
  const [partySearch, setPartySearch] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [lines, setLines] = useState<LineItem[]>([]);
  const [calcResult, setCalcResult] = useState<CalcResult | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [pendingOrders, setPendingOrders] = useState<Order[]>([]);
  const [pendingOrdersLoading, setPendingOrdersLoading] = useState(true);
  const [approvedOrders, setApprovedOrders] = useState<Order[]>([]);
  const [approvedOrdersLoading, setApprovedOrdersLoading] = useState(true);
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);
  const [updatingOrderId, setUpdatingOrderId] = useState<string | null>(null);
  // Salesmen may place/track orders but cannot approve them (enforced server-side too).
  const [isSalesman, setIsSalesman] = useState(false);
  // The logged-in user's own id/name, needed to scope the group picker for salesmen.
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUserName, setCurrentUserName] = useState("");
  // Keep role-gated controls hidden until local auth state has been resolved. This
  // prevents the admin-only "All Parties" action flashing for salesmen on load.
  const [isRoleResolved, setIsRoleResolved] = useState(false);
  const today = new Date().toISOString().split("T")[0];
  const [templates, setTemplates] = useState<GSTTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<GSTTemplate | null>(null);
  const [activeCompanyId, setActiveCompanyId] = useState<string | null>(null);
  const [partyDues, setPartyDues] = useState<PartyDues | null>(null);
  const [partyDuesLoading, setPartyDuesLoading] = useState(false);
    const [billDiscountPercent, setBillDiscountPercent] = useState(0);
    const [skipTd, setSkipTd] = useState(false);
    const [orderNotes, setOrderNotes] = useState("");
  const calcRequestIdRef = useRef(0);
    const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
    const [editItems, setEditItems] = useState<{ product_id: string; name: string; sku: string; quantity: number; unit_price: number; discount_percent: number }[]>([]);
    const [editSaving, setEditSaving] = useState(false);
    const [editProductSearch, setEditProductSearch] = useState("");
    const [editProductOpen, setEditProductOpen] = useState(false);
    const [editProducts, setEditProducts] = useState<Product[]>([]);
	  const [creditScoresMap, setCreditScoresMap] = useState<Record<string, CreditScoreSummary>>({});
  const [creditErrorMap, setCreditErrorMap] = useState<Record<string, boolean>>({});
    const fetchedCreditRef = useRef<Set<string>>(new Set());
    const [creatorNames, setCreatorNames] = useState<Record<string, string>>({});
    // created_by -> the creator's own party_id; lets us flag orders a party
    // placed for itself (creator's party === the order's billed party).
    const [creatorPartyIds, setCreatorPartyIds] = useState<Record<string, string>>({});
    const [selectedCreator, setSelectedCreator] = useState<string | null>(null);
    const [creatorPickerOpen, setCreatorPickerOpen] = useState(false);
    const creatorPickerRef = useRef<HTMLDivElement | null>(null);
    const [allUsers, setAllUsers] = useState<{ id: string; name: string; role?: string; parent_user_id?: string | null }[]>([]);

    // Close the staff picker when clicking/tapping outside it.
    useEffect(() => {
      if (!creatorPickerOpen) return;
      const handlePointerDown = (e: MouseEvent | TouchEvent) => {
        if (creatorPickerRef.current && !creatorPickerRef.current.contains(e.target as Node)) {
          setCreatorPickerOpen(false);
        }
      };
      document.addEventListener("mousedown", handlePointerDown);
      document.addEventListener("touchstart", handlePointerDown);
      return () => {
        document.removeEventListener("mousedown", handlePointerDown);
        document.removeEventListener("touchstart", handlePointerDown);
      };
    }, [creatorPickerOpen]);

    // Approved Orders panel filters: free-text (order no. / party), created_at date
    // range, and salesman → all parties in that salesman's group/downline.
    const [approvedSearch, setApprovedSearch] = useState("");
    const [approvedDateFrom, setApprovedDateFrom] = useState("");
    const [approvedDateTo, setApprovedDateTo] = useState("");
    const [approvedSalesmanId, setApprovedSalesmanId] = useState("");
    // Collapsible order sections — Approved & Cancelled fold away by default so the
    // list stays short; users expand what they need. Pending stays open (main action).
    const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set(["APPROVED", "CANCELLED"]));
    const toggleSection = (status: string) =>
      setCollapsedSections(prev => {
        const next = new Set(prev);
        next.has(status) ? next.delete(status) : next.add(status);
        return next;
      });
    // Party dual-approval: order_id -> confirmation summary.
    const [approvals, setApprovals] = useState<Record<string, ApprovalSummary>>({});
    const [whatsAppDeliveryPopup, setWhatsAppDeliveryPopup] = useState<WhatsAppDeliveryPopup | null>(null);

  const fetchApprovals = useCallback(() => {
    api<{ success: boolean; data: Record<string, ApprovalSummary> }>("/api/v1/orders/approval-status", { noCache: true })
      .then((r) => setApprovals(r.data || {}))
      .catch(() => {});
  }, []);

  function fetchOrders() {
    setOrdersLoading(true);
    const storedCompanyId = typeof window !== "undefined" ? localStorage.getItem("activeCompanyId") : null;
    const storedUser = typeof window !== "undefined" ? localStorage.getItem("user") : null;
    let parsedUser: { role?: string; party_id?: string | null } | null = null;
    if (storedUser) {
      try {
        parsedUser = JSON.parse(storedUser);
      } catch {
        parsedUser = null;
      }
    }
    const fallbackCompanyId = parsedUser?.role === "ADMIN" ? (parsedUser.party_id || null) : null;
    const effectiveCompanyId = storedCompanyId || fallbackCompanyId;

    api<{ success: boolean; data: Order[] }>("/api/v1/orders?limit=1000")
      .then(async (r) => {
        const data = r.data || [];
        if (data.length === 0 && effectiveCompanyId) {
          const retry = await api<{ success: boolean; data: Order[] }>("/api/v1/orders?limit=1000", {
            headers: { "x-company-id": effectiveCompanyId },
          });
          const retryData = retry.data || [];
          setOrders(retryData);
          console.log("Fetched orders (retry scoped):", retryData.length, "status breakdown:", retryData.reduce((acc, o) => { const status = getOrderStatus(o); acc[status] = (acc[status] || 0) + 1; return acc; }, {} as Record<string, number>));
          return;
        }
        setOrders(data);
        console.log("Fetched orders:", data.length, "status breakdown:", data.reduce((acc, o) => { const status = getOrderStatus(o); acc[status] = (acc[status] || 0) + 1; return acc; }, {} as Record<string, number>));
        // Resolve creator names
          const ids = [...new Set([...data.map(o => o.created_by), ...data.map(o => o.approved_by)].filter(Boolean))] as string[];
        const missing = ids.filter(id => !creatorNames[id]);
        if (missing.length > 0) {
          api<{ success: boolean; data: { id: string; name: string; party_id?: string | null }[] }>(`/api/v1/users?ids=${missing.join(",")}`)
            .then(ur => {
              const nameMap: Record<string, string> = {};
              const partyMap: Record<string, string> = {};
              (ur.data || []).forEach(u => { nameMap[u.id] = u.name; if (u.party_id) partyMap[u.id] = u.party_id; });
              setCreatorNames(prev => ({ ...prev, ...nameMap }));
              setCreatorPartyIds(prev => ({ ...prev, ...partyMap }));
            })
            .catch(() => {});
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load orders");
      })
      .finally(() => setOrdersLoading(false));
  }

  function fetchApprovedOrders() {
    setApprovedOrdersLoading(true);
    const storedCompanyId = typeof window !== "undefined" ? localStorage.getItem("activeCompanyId") : null;
    const storedUser = typeof window !== "undefined" ? localStorage.getItem("user") : null;
    let parsedUser: { role?: string; party_id?: string | null } | null = null;
    if (storedUser) {
      try { parsedUser = JSON.parse(storedUser); } catch { parsedUser = null; }
    }
    const fallbackCompanyId = parsedUser?.role === "ADMIN" ? (parsedUser.party_id || null) : null;
    const effectiveCompanyId = storedCompanyId || fallbackCompanyId;

    const url = "/api/v1/orders?status=APPROVED&limit=10000";
    api<{ success: boolean; data: Order[] }>(url)
      .then(async (r) => {
        let data = r.data || [];
        if (data.length === 0 && effectiveCompanyId) {
          const retry = await api<{ success: boolean; data: Order[] }>(url, {
            headers: { "x-company-id": effectiveCompanyId },
          });
          data = retry.data || [];
        }
	        setApprovedOrders(data.filter(order => getOrderStatus(order) === "APPROVED"));
        // Resolve creator / approver names
        const ids = [...new Set([...data.map(o => o.created_by), ...data.map(o => o.approved_by)].filter(Boolean))] as string[];
        const missing = ids.filter(id => !creatorNames[id]);
        if (missing.length > 0) {
          api<{ success: boolean; data: { id: string; name: string; party_id?: string | null }[] }>(`/api/v1/users?ids=${missing.join(",")}`)
            .then(ur => {
              const nameMap: Record<string, string> = {};
              const partyMap: Record<string, string> = {};
              (ur.data || []).forEach(u => { nameMap[u.id] = u.name; if (u.party_id) partyMap[u.id] = u.party_id; });
              setCreatorNames(prev => ({ ...prev, ...nameMap }));
              setCreatorPartyIds(prev => ({ ...prev, ...partyMap }));
            })
            .catch(() => {});
        }
      })
      .catch(() => {})
      .finally(() => setApprovedOrdersLoading(false));
  }

  // Pending orders must not be derived from the limited, mixed-status history
  // request above. Fetch every page for this status so both the badge and list
  // remain exact even when the company has more than 10,000 pending orders.
  function fetchPendingOrders() {
    setPendingOrdersLoading(true);
    const storedCompanyId = typeof window !== "undefined" ? localStorage.getItem("activeCompanyId") : null;
    const storedUser = typeof window !== "undefined" ? localStorage.getItem("user") : null;
    let parsedUser: { role?: string; party_id?: string | null } | null = null;
    if (storedUser) {
      try { parsedUser = JSON.parse(storedUser); } catch { parsedUser = null; }
    }
    const fallbackCompanyId = parsedUser?.role === "ADMIN" ? (parsedUser.party_id || null) : null;
    const effectiveCompanyId = storedCompanyId || fallbackCompanyId;
    const pageSize = 500;

    type OrdersPage = {
      success: boolean;
      data: Order[];
      pagination?: { page: number; limit: number; total: number; pages: number };
    };

    const loadAllPages = async (headers?: Record<string, string>) => {
      const getPage = (page: number) => api<OrdersPage>(
        `/api/v1/orders?status=PENDING&page=${page}&limit=${pageSize}`,
        { noCache: true, ...(headers ? { headers } : {}) },
      );
      const first = await getPage(1);
      const all = [...(first.data || [])];
      const pageCount = Math.max(1, first.pagination?.pages || Math.ceil((first.pagination?.total || all.length) / pageSize));

      // Keep a small concurrency window: fast for large histories without
      // flooding the API when the pending count is very high.
      for (let page = 2; page <= pageCount; page += 4) {
        const pageNumbers = Array.from(
          { length: Math.min(4, pageCount - page + 1) },
          (_, index) => page + index,
        );
        const responses = await Promise.all(pageNumbers.map(getPage));
        responses.forEach((response) => all.push(...(response.data || [])));
      }
      return all;
    };

    loadAllPages()
      .then(async (data) => {
        if (data.length === 0 && effectiveCompanyId) {
          data = await loadAllPages({ "x-company-id": effectiveCompanyId });
        }
        const uniquePending = dedupeOrders(
          data.filter((order) => getOrderStatus(order) === "PENDING"),
        );
        setPendingOrders(uniquePending);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load pending orders"))
      .finally(() => setPendingOrdersLoading(false));
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    const user = localStorage.getItem("user");
    const parsedUser = user ? JSON.parse(user) : null;
    const isSuperAdmin = parsedUser?.role === "SUPER_ADMIN";

    if (isSuperAdmin && !activeCompanyId) return;
    fetchOrders();
    fetchPendingOrders();
    fetchApprovedOrders();
    fetchApprovals();
  }, [activeCompanyId]);

  // Detect the logged-in user's role once so we can hide approve-only controls.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const parsed = JSON.parse(localStorage.getItem("user") || "null");
      const role = (parsed?.role || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
      setIsSalesman(role === "SALESMAN");
      setCurrentUserId(parsed?.id ? String(parsed.id) : null);
      setCurrentUserName(typeof parsed?.name === "string" ? parsed.name : "");
    } catch {
      setIsSalesman(false);
      setCurrentUserId(null);
      setCurrentUserName("");
    } finally {
      setIsRoleResolved(true);
    }
  }, []);

  // Fetch all company staff for the creator dropdown
  useEffect(() => {
    api<{ success: boolean; data: { id: string; name: string; role?: string; parent_user_id?: string | null }[]; meta?: { total: number } }>("/api/v1/users?limit=100&exclude_roles=CNF_USER,SUPER_DEALER_USER,RETAILER_USER")
      .then(r => {
        const users = r.data || [];
        setAllUsers(users);
        const map: Record<string, string> = {};
        users.forEach(u => { map[u.id] = u.name; });
        setCreatorNames(prev => ({ ...prev, ...map }));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const syncActiveCompany = () => {
      setActiveCompanyId(localStorage.getItem("activeCompanyId"));
    };

    syncActiveCompany();

    const handleStorage = (event: StorageEvent) => {
      if (event.key === "activeCompanyId") {
        setActiveCompanyId(event.newValue);
      }
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener("focus", syncActiveCompany);
    document.addEventListener("visibilitychange", syncActiveCompany);

    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("focus", syncActiveCompany);
      document.removeEventListener("visibilitychange", syncActiveCompany);
    };
  }, []);

  useEffect(() => {
    api<{ success: boolean; data: GSTTemplate[] }>("/api/v1/gst-templates")
      .then(r => {
        const stored = r.data || [];
        setTemplates(stored);
        const savedTemplateId = typeof window !== "undefined"
          ? localStorage.getItem(getDefaultTaxTemplateStorageKey(activeCompanyId)) || localStorage.getItem(DEFAULT_TAX_TEMPLATE_STORAGE_KEY)
          : null;
        setSelectedTemplate(current => {
          if (current?.id) return stored.find((t: GSTTemplate) => t.id === current.id) || stored[0] || null;
          if (savedTemplateId) {
            const saved = stored.find((t: GSTTemplate) => t.id === savedTemplateId);
            if (saved) return saved;
          }
          // Fall back to the first template so the order can be approved without
          // forcing the user to manually pick one. Templates only drive the GST
          // preview; the order API computes tax server-side.
          return stored[0] || null;
        });
      })
      .catch(() => {
        setTemplates([]);
        setSelectedTemplate(null);
      });
  }, [activeCompanyId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const storageKey = getDefaultTaxTemplateStorageKey(activeCompanyId);

    if (selectedTemplate?.id) {
      localStorage.setItem(storageKey, selectedTemplate.id);
    } else {
      localStorage.removeItem(storageKey);
    }
  }, [selectedTemplate, activeCompanyId]);

  // Load the active company's full party list and filter client-side. Searching server-side
  // per keystroke raced (a slow broad response could overwrite a fast narrow one,
  // making search appear broken) and broke on un-encoded query characters.
  useEffect(() => {
    let cancelled = false;

    const loadAllParties = async () => {
      const pageSize = 1000;
      const allParties: Party[] = [];
      const fetchedIds = new Set<string>();
      let page = 1;

      do {
        const response = await api<{
          success: boolean;
          data: Party[];
          pagination?: { pages?: number };
        }>(`/api/v1/parties?page=${page}&limit=${pageSize}&is_verified=all`);
        const rows = response.data || [];
        let newRows = 0;
        for (const party of rows) {
          if (fetchedIds.has(party.id)) continue;
          fetchedIds.add(party.id);
          allParties.push(party);
          newRows += 1;
        }
        const reportedPageCount = Number(response.pagination?.pages) || 0;

        // The pagination metadata is authoritative. The short-page check also
        // keeps this safe against older API deployments that omit that metadata.
        if (
          (reportedPageCount > 0 && page >= reportedPageCount) ||
          (reportedPageCount === 0 && rows.length < pageSize) ||
          newRows === 0
        ) break;
        page += 1;
      } while (true);

      if (cancelled) return;
      setParties(allParties.map((p) => ({
        ...p,
        party_types: normalizePartyType(p),
      })));
    };

    loadAllParties().catch(() => {});
    return () => { cancelled = true; };
  }, [activeCompanyId]);

  // Load the company's groups so Step 1 can present a group-first picker. Each
  // group carries member_ids, which we intersect with the loaded parties.
  //
  // The group LIST comes from /api/v1/groups (light: groups + member counts +
  // price lists). The salesman names shown on each card come from
  // /api/v1/salesman-downline, which is far heavier (full party-tree BFS,
  // listUsers(1000), balance derivation over every party). Do NOT block the
  // group list on that enrichment — otherwise "Loading groups…" hangs behind
  // work that has nothing to do with showing groups. Render groups as soon as
  // the light call returns; let salesman names fill in a moment later.
  useEffect(() => {
    setGroupsLoading(true);
    api<{ success: boolean; data: Group[] }>("/api/v1/groups")
      .then((g) => setGroups(g.data || []))
      .catch(() => setGroups([]))
      .finally(() => setGroupsLoading(false));

    // Fire-and-forget enrichment: populates salesman names on group cards once
    // it lands. Failure here leaves the groups usable, just without names.
    api<{ data: { salesmen: { id: string; name: string }[]; salesmanToParties?: Record<string, string[]> } }>(
      "/api/v1/salesman-downline",
    )
      .then((sd) => {
        setGroupSalesmen(sd.data?.salesmen || []);
        setSalesmanToParties(sd.data?.salesmanToParties || {});
      })
      .catch(() => {});
  }, [activeCompanyId]);

  // Background-fetch credit scores for all loaded parties
  useEffect(() => {
    if (parties.length === 0) return;
    parties.forEach(p => {
      if (fetchedCreditRef.current.has(p.id)) return;
      fetchedCreditRef.current.add(p.id);
      api<{ success: boolean; data: { score: number | null; band: string | null; metrics: { avg_monthly_invoiced: number; payment_rate: number; avg_outstanding_days: number } | null } }>(`/api/v1/credit-analysis?party_id=${p.id}`)
        .then(r => {
          if (r?.data) {
            setCreditScoresMap(prev => ({
              ...prev,
              [p.id]: {
                score: r.data.score,
                band: r.data.band,
                avg_monthly_invoiced: r.data.metrics?.avg_monthly_invoiced ?? 0,
                payment_rate: r.data.metrics?.payment_rate ?? 0,
                avg_outstanding_days: r.data.metrics?.avg_outstanding_days ?? 0,
              },
            }));
            setCreditErrorMap(prev => ({ ...prev, [p.id]: false }));
          } else {
            fetchedCreditRef.current.delete(p.id);
            setCreditErrorMap(prev => ({ ...prev, [p.id]: true }));
          }
        })
        .catch(() => {
          fetchedCreditRef.current.delete(p.id);
          setCreditErrorMap(prev => ({ ...prev, [p.id]: true }));
        });
    });
  }, [parties]);

  useEffect(() => {
    if (!selectedParty?.id) return;
    if (creditScoresMap[selectedParty.id]) return;

    api<{ success: boolean; data: { score: number | null; band: string | null; metrics: { avg_monthly_invoiced: number; payment_rate: number; avg_outstanding_days: number } | null } }>(`/api/v1/credit-analysis?party_id=${selectedParty.id}`)
      .then(r => {
        if (!r?.data) return;
        setCreditScoresMap(prev => ({
          ...prev,
          [selectedParty.id]: {
            score: r.data.score,
            band: r.data.band,
            avg_monthly_invoiced: r.data.metrics?.avg_monthly_invoiced ?? 0,
            payment_rate: r.data.metrics?.payment_rate ?? 0,
            avg_outstanding_days: r.data.metrics?.avg_outstanding_days ?? 0,
          },
        }));
        setCreditErrorMap(prev => ({ ...prev, [selectedParty.id]: false }));
      })
      .catch(() => {
        setCreditErrorMap(prev => ({ ...prev, [selectedParty.id]: true }));
      });
  }, [selectedParty?.id, creditScoresMap]);

  useEffect(() => {
    api<{ success: boolean; data: Product[] }>(selectedParty
      ? `/api/v1/products/orderable?partyId=${encodeURIComponent(selectedParty.id)}&search=${encodeURIComponent(productSearch || "")}`
      : `/api/v1/products?limit=100${productSearch ? `&search=${productSearch}` : ""}`)
      .then(r => setProducts(r.data || []))
      .catch(() => {});
  }, [productSearch, selectedParty]);

  // A new party means a new catalog — drop back to the category grid.
  useEffect(() => {
    setSelectedCategoryId(null);
  }, [selectedParty?.id]);

  const calculate = useCallback(async () => {
    if (!selectedParty || lines.length === 0) {
      calcRequestIdRef.current += 1;
      setCalcResult(null);
      setCalculating(false);
      return;
    }

    const requestId = ++calcRequestIdRef.current;
    setCalculating(true);

    try {
      const res = await api<{ success: boolean; data: CalcResult }>("/api/v1/invoices/calculate", {
        method: "POST",
          body: {
            billingPartyId: selectedParty.id,
            lines: lines.map(l => ({
              productId: l.productId, quantity: l.quantity, ...(l.unitPrice !== undefined ? { unitPrice: l.unitPrice } : {}), discountPercent: l.discountPercent,
              ...(selectedTemplate ? { gstRateOverride: selectedTemplate.gst_rate, cessRateOverride: selectedTemplate.cess_rate } : {}),
            })),
            ...(selectedTemplate ? { isInterstateOverride: false } : {}),
            billDiscountPercent: billDiscountPercent > 0 ? billDiscountPercent : undefined,
            skipTd: skipTd || undefined,
          },
      });

      if (requestId !== calcRequestIdRef.current) return;
      setCalcResult(res.data);
      setError(prev => prev.startsWith("Live calculation") ? "" : prev); // Clear if it succeeds
    } catch (err) {
      if (requestId !== calcRequestIdRef.current) return;
      setCalcResult(null);
      setError(err instanceof Error ? err.message : "Live calculation failed");
    } finally {
      if (requestId === calcRequestIdRef.current) {
        setCalculating(false);
      }
    }
  }, [selectedParty, lines, selectedTemplate, billDiscountPercent, skipTd]);

  useEffect(() => {
    const timer = setTimeout(calculate, 120);
    return () => clearTimeout(timer);
  }, [calculate]);

  function handleSelectParty(party: Party) {
    const isDifferentParty = selectedParty?.id !== party.id;

    setSelectedParty(party);
    setStep(2);

    if (isDifferentParty) {
      setCalcResult(null);
      setSkipTd(false);

      if (party.default_tax_template_id && templates.length > 0) {
        const partyTemplate = templates.find(t => t.id === party.default_tax_template_id);
        if (partyTemplate) setSelectedTemplate(partyTemplate);
      }

      // Fetch party dues/outstanding
      setPartyDues(null);
      setPartyDuesLoading(true);
      api<{ success: boolean; data: PartyDues }>(`/api/v1/parties/${party.id}`)
        .then(r => {
          if (r.data) {
              setPartyDues({
                outstanding: Number(r.data.outstanding) || 0,
                total_billed: Number(r.data.total_billed) || 0,
                total_paid: Number(r.data.total_paid) || 0,
                td_balance: Number(r.data.td_balance) || 0,
                cd_balance: Number(r.data.cd_balance) || 0,
                security_balance: Number(r.data.security_balance) || 0,
                wallet_balance: Number(r.data.wallet_balance) || 0,
                opening_balance: Number(r.data.opening_balance) || 0,
                aging_breakdown: r.data.aging_breakdown || {},
                unpaid_invoices: r.data.unpaid_invoices || [],
              });
          }
        })
        .catch(() => {})
        .finally(() => setPartyDuesLoading(false));
    }
  }

  function addLine(product: Product) {
    if (lines.find(l => l.productId === product.id)) return;
    const resolvedUnitPrice = Number(product.effective_price ?? product.base_price ?? 0);
    setLines([...lines, {
      productId: product.id,
      name: product.name,
      sku: product.sku,
      quantity: 1,
      unitPrice: Number.isFinite(resolvedUnitPrice) ? resolvedUnitPrice : 0,
      uom: product.unit_of_measure,
      discountPercent: 0,
    }]);
  }

  function updateLine(idx: number, field: string, value: number) {
    if (Number.isNaN(value)) return;
    setLines(prev => prev.map((line, i) => i === idx ? { ...line, [field]: value } : line));
  }

  function removeLine(idx: number) {
    setLines(lines.filter((_, i) => i !== idx));
  }

  async function submitOrder() {
    if (!selectedParty || lines.length === 0) return;
    setSubmitting(true);
    setError("");
    try {
        await api("/api/v1/orders", {
          method: "POST",
          body: {
            buyer_id: selectedParty.id,
            items: lines.map(l => ({
              product_id: l.productId,
              quantity: l.quantity,
              unit_price: l.unitPrice ?? 0,
              discount_percent: l.discountPercent || 0,
            })),
            bill_discount_percent: billDiscountPercent > 0 ? billDiscountPercent : undefined,
            notes: orderNotes || undefined,
          },
        });
        setSuccess("Order created successfully!");
        setLines([]);
        setCalcResult(null);
        setSelectedParty(null);
        setPartyDues(null);
        setBillDiscountPercent(0);
        setSkipTd(false);
        setOrderNotes("");
        setStep(1);
      fetchOrders();
      fetchPendingOrders();
      fetchApprovedOrders();
      // Scroll to order history section
      setTimeout(() => {
        document.getElementById("order-history")?.scrollIntoView({ behavior: "smooth" });
      }, 300);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create order");
    } finally {
      setSubmitting(false);
    }
  }

    async function updateOrderStatus(order: Order, nextStatus: typeof ORDER_STATUS_OPTIONS[number]) {
      const isApproving = nextStatus === "APPROVED";
      let approvalCompleted = false;
      setUpdatingOrderId(order.id);
      setError("");
      setSuccess("");
      if (isApproving) {
        setWhatsAppDeliveryPopup({
          orderNumber: order.order_number,
          status: "sending",
          detail: "Approving the order and sending its secure confirmation link automatically…",
          partyName: order.buyer?.name || undefined,
        });
      }
      try {
        if (isApproving) {
          await api<{ success: boolean; data: Order }>(`/api/v1/orders/${order.id}/approve`, {
            method: "POST",
            body: {},
          });
          approvalCompleted = true;

          const share = await api<{ success: boolean; data: ShareApprovalData }>(
            `/api/v1/orders/${order.id}/share-approval`,
            { method: "POST", body: {} },
          );
          const delivery = share?.data?.whatsapp_delivery;
          if (delivery?.status !== "sent") {
            throw new Error("WhatsApp did not confirm the automatic send.");
          }

          setWhatsAppDeliveryPopup({
            orderNumber: order.order_number,
            status: "sent",
            detail: "The secure order-confirmation link was sent automatically.",
            partyName: share.data.party?.name || order.buyer?.name || undefined,
            to: delivery.to,
            messageId: delivery.message_id,
          });
          setSuccess(`${order.order_number} approved · WhatsApp sent automatically.`);
          fetchApprovals();
        } else {
          await api<{ success: boolean; data: Order }>(`/api/v1/orders/${order.id}`, {
            method: "PUT",
            body: { status: nextStatus },
          });
          setSuccess(`Order status updated to ${nextStatus}.`);
        }
        fetchOrders();
        fetchPendingOrders();
        fetchApprovedOrders();
      } catch (err) {
        const detail = err instanceof Error ? err.message : "Failed to update order status";
        if (isApproving) {
          setWhatsAppDeliveryPopup({
            orderNumber: order.order_number,
            status: approvalCompleted ? "send_failed" : "approval_failed",
            detail: approvalCompleted
              ? `The order is approved, but WhatsApp could not send the link: ${detail}`
              : `The order was not approved: ${detail}`,
            partyName: order.buyer?.name || undefined,
          });
          setError(approvalCompleted ? `WhatsApp delivery failed: ${detail}` : detail);
          if (approvalCompleted) {
            fetchOrders();
            fetchPendingOrders();
            fetchApprovedOrders();
          }
        } else {
          setError(detail);
        }
      } finally {
        setUpdatingOrderId(null);
      }
    }

    async function revertOrderApproval(order: Order) {
      if (getOrderStatus(order) !== "APPROVED") return;
      const confirmed = window.confirm(
        `Revert approval for ${order.order_number}?\n\nThe order will return to Pending and the complete approval process must be started again.`,
      );
      if (!confirmed) return;

      setUpdatingOrderId(order.id);
      setError("");
      setSuccess("");
      try {
        const response = await api<{ success: boolean; data: Partial<Order> }>(`/api/v1/orders/${order.id}/revert-approval`, {
          method: "POST",
          body: {},
        });
        // Move the row between sections immediately after the server confirms the
        // reversal. The follow-up fetches remain the source-of-truth refresh, but
        // the UI must not leave the reverted order in Approved while they run.
        const pendingOrder: Order = {
          ...order,
          ...(response.data || {}),
          status: "PENDING",
          order_status: "PENDING",
          approved_by: null,
        };
        setApprovedOrders((current) => current.filter((item) => item.id !== order.id));
        setPendingOrders((current) => dedupeOrders([pendingOrder, ...current]));
        setOrders((current) => {
          const exists = current.some((item) => item.id === order.id);
          return exists
            ? current.map((item) => item.id === order.id ? pendingOrder : item)
            : current;
        });
        setCollapsedSections((current) => {
          if (!current.has("PENDING")) return current;
          const next = new Set(current);
          next.delete("PENDING");
          return next;
        });
        setApprovals((current) => {
          const next = { ...current };
          delete next[order.id];
          return next;
        });
        setSuccess(`${order.order_number} returned to Pending. Approve it again to restart the process.`);
        fetchOrders();
        fetchPendingOrders();
        fetchApprovedOrders();
        fetchApprovals();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to revert order approval");
      } finally {
        setUpdatingOrderId(null);
      }
    }

    function startEditOrder(order: Order) {
      setEditingOrderId(order.id);
      setEditItems(
        (order.order_items || []).map(item => ({
          product_id: item.product_id,
          name: item.products?.name || "—",
          sku: item.products?.sku || "",
          quantity: item.quantity,
          unit_price: Number(item.unit_price),
          discount_percent: Number(item.discount_percent) || 0,
        }))
      );
      setEditProductSearch("");
      // Fetch products for the add-product picker
      api<{ success: boolean; data: Product[] }>("/api/v1/products?limit=100")
        .then(r => setEditProducts(r.data || []))
        .catch(() => {});
      setExpandedOrder(order.id);
    }

    function cancelEdit() {
      setEditingOrderId(null);
      setEditItems([]);
      setEditProductSearch("");
    }

    async function saveEditOrder(orderId: string) {
      if (editItems.length === 0) {
        setError("Order must have at least one item");
        return;
      }
      setEditSaving(true);
      setError("");
      try {
        await api(`/api/v1/orders/${orderId}`, {
          method: "PUT",
          body: {
            items: editItems.map(item => ({
              product_id: item.product_id,
              quantity: item.quantity,
              unit_price: item.unit_price,
              discount_percent: item.discount_percent || 0,
            })),
          },
        });
        setSuccess("Order updated successfully!");
        setEditingOrderId(null);
        setEditItems([]);
        fetchOrders();
        fetchPendingOrders();
        fetchApprovedOrders();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to update order");
      } finally {
        setEditSaving(false);
      }
    }

	    const fmt = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n);
	    const effectiveWalletBalance = (dues: PartyDues) =>
	      Number(dues.opening_balance || 0) + Number(dues.wallet_balance || 0);
	    const buildWalletBasedCreditOpinion = (dues: PartyDues): CreditScoreSummary => {
	      const walletBalance = effectiveWalletBalance(dues);
	      const exposure = Math.max(0, Math.abs(Math.min(walletBalance, 0)) + Number(dues.outstanding || 0));
	      const paymentRate = dues.total_billed > 0
	        ? Math.min(100, Math.round((Number(dues.total_paid || 0) / Number(dues.total_billed || 1)) * 1000) / 10)
	        : walletBalance > 0 ? 100 : 0;

	      let score = 720;
	      let band = "GOOD";
	      if (exposure >= 100000) {
	        score = 420;
	        band = "VERY_POOR";
	      } else if (exposure >= 50000) {
	        score = 510;
	        band = "POOR";
	      } else if (exposure > 0) {
	        score = 590;
	        band = "FAIR";
	      } else if (walletBalance > 0) {
	        score = 760;
	        band = "EXCELLENT";
	      }

	      return {
	        score,
	        band,
	        avg_monthly_invoiced: Math.round(Math.max(Number(dues.total_billed || 0), Math.abs(walletBalance))),
	        payment_rate: paymentRate,
	        avg_outstanding_days: Math.max(...(dues.unpaid_invoices || []).map(inv => Number(inv.aging_days || 0)), 0),
	        source: "wallet",
	      };
	    };
	    const orderNetWeight = (order: Order) => (order.order_items || []).reduce((sum, item) => {
	      const w = item.products?.technical_specs?.net_weight_with_packaging;
	      return sum + (w ? w * item.quantity : 0);
    }, 0);
  // Get all downline user IDs for a given user (recursive)
  const getDownlineIds = useCallback((userId: string): string[] => {
    const ids: string[] = [userId];
    const children = allUsers.filter(u => u.parent_user_id === userId);
    for (const child of children) {
      ids.push(...getDownlineIds(child.id));
    }
    return ids;
  }, [allUsers]);

  // Filtered orders based on selected creator + downline
  const filteredByCreator = useCallback((ordersList: Order[]) => {
    if (!selectedCreator) return ordersList;
    const allowedIds = new Set(getDownlineIds(selectedCreator));
    return ordersList.filter(o => o.created_by && allowedIds.has(o.created_by));
  }, [selectedCreator, getDownlineIds]);

  const getOrderStatusColor = (status: string) =>
    status === "APPROVED" ? "text-emerald-700 bg-emerald-50 border-emerald-200" :
    status === "CANCELLED" ? "text-red-700 bg-red-50 border-red-200" :
    "text-amber-700 bg-amber-50 border-amber-200";

  // Sentinel for the "All Parties" pseudo-group, so parties that belong to no
  // group stay reachable from the billing picker.
  const ALL_PARTIES = "__ALL__";

  // A salesman must only ever see groups assigned to them — directly via
  // groups.salesman_id, or via downline ownership of the group's member parties
  // (salesmanToParties is already self-scoped server-side for salesmen). The API
  // scopes too, but this guard also holds against older deployments that return
  // the whole company's groups. Fail-closed: unresolved user id → no groups.
  const visibleGroups = useMemo(() => {
    if (!isSalesman) return groups;
    if (!currentUserId) return [];
    const myPartyIds = new Set(salesmanToParties[currentUserId] || []);
    return groups.filter(
      (g) =>
        g.salesman_id === currentUserId ||
        (g.member_ids || []).some((pid) => myPartyIds.has(pid)),
    );
  }, [groups, isSalesman, currentUserId, salesmanToParties]);

  const selectedGroup =
    selectedGroupId && selectedGroupId !== ALL_PARTIES
      ? visibleGroups.find((g) => g.id === selectedGroupId) || null
      : null;

  function openGroup(id: string) {
    // UI guard plus a defensive state guard: salesmen must choose from their
    // assigned groups and cannot enter the cross-group All Parties view.
    if (id === ALL_PARTIES && isSalesman) return;
    setSelectedGroupId(id);
    setPartySearch("");
  }
  function backToGroups() {
    setSelectedGroupId(null);
    setPartySearch("");
  }

  // Parties scoped to the chosen group (or all of them for the All Parties view).
  const groupScopedParties = (() => {
    if (selectedGroupId === ALL_PARTIES) return parties;
    if (!selectedGroup) return [];
    const memberSet = new Set(selectedGroup.member_ids);
    return parties.filter((p) => memberSet.has(p.id));
  })();

  const partyQuery = partySearch.trim().toLowerCase();
  const filteredParties = partyQuery
    ? groupScopedParties.filter((p) =>
        p.name?.toLowerCase().includes(partyQuery) ||
        p.party_code?.toLowerCase().includes(partyQuery) ||
        (p.gstin || "").toLowerCase().includes(partyQuery)
      )
    : groupScopedParties;

  // When viewing the group list, the search box filters groups by name/code.
  const filteredGroups = partyQuery
    ? visibleGroups.filter((g) =>
        g.name?.toLowerCase().includes(partyQuery) ||
        (g.code || "").toLowerCase().includes(partyQuery)
      )
    : visibleGroups;

  // party_id -> the group(s) it belongs to. Used in the All Parties view to
  // surface each party's group membership at a glance.
  const groupsByPartyId: Record<string, Group[]> = {};
  for (const g of visibleGroups) {
    for (const pid of g.member_ids) {
      (groupsByPartyId[pid] ||= []).push(g);
    }
  }

  // Which salesman each group belongs to. Derived from downline ownership of the
  // group's member parties (salesmanToParties, inverted) so it stays correct even
  // when a group's own salesman_id was never set. Falls back to the group's
  // resolved salesman_name when it's a real name (never a raw UUID).
  const salesmanNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of groupSalesmen) m.set(s.id, s.name);
    return m;
  }, [groupSalesmen]);

  const partyToSalesmanIds = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const [salesmanId, partyIds] of Object.entries(salesmanToParties)) {
      for (const pid of partyIds) (m[pid] ||= []).push(salesmanId);
    }
    return m;
  }, [salesmanToParties]);

  const salesmanNamesByGroup = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const g of groups) {
      const ids = new Set<string>();
      for (const pid of g.member_ids || []) {
        for (const sid of partyToSalesmanIds[pid] || []) ids.add(sid);
      }
      let names = [...ids]
        .map((id) => salesmanNameById.get(id))
        .filter((n): n is string => Boolean(n));
      if (names.length === 0 && g.salesman_name && !looksLikeUuid(g.salesman_name)) {
        names = [g.salesman_name];
      }
      result[g.id] = [...new Set(names)].sort((a, b) => a.localeCompare(b));
    }
    return result;
  }, [groups, partyToSalesmanIds, salesmanNameById]);

  // Fold the (possibly 60+) groups under their primary salesman so the picker
  // collapses to a handful of accordion rows instead of one giant scroll.
  const UNASSIGNED_SALESMAN = "Unassigned";
  const salesmanSections = useMemo(() => {
    const map = new Map<string, Group[]>();
    for (const g of filteredGroups) {
      // Salesmen never get an "Unassigned" bucket: visibleGroups already
      // guarantees every group here is theirs, so an unresolved salesman name
      // (0-party group, name lookup still in flight) folds under their own name.
      const fallbackKey = isSalesman
        ? (currentUserName || "My Groups")
        : UNASSIGNED_SALESMAN;
      const key = salesmanNamesByGroup[g.id]?.[0] || fallbackKey;
      const bucket = map.get(key);
      if (bucket) bucket.push(g);
      else map.set(key, [g]);
    }
    const sections = [...map.entries()].map(([salesman, gs]) => ({
      salesman,
      groups: gs,
      groupCount: gs.length,
      partyCount: gs.reduce((n, g) => n + (g.member_count || 0), 0),
    }));
    sections.sort((a, b) =>
      a.salesman === UNASSIGNED_SALESMAN ? 1
      : b.salesman === UNASSIGNED_SALESMAN ? -1
      : a.salesman.localeCompare(b.salesman),
    );
    return sections;
  }, [filteredGroups, salesmanNamesByGroup, isSalesman, currentUserName]);

  function toggleSalesman(name: string) {
    setExpandedSalesmen((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  // ---- Approved Orders panel filtering ------------------------------------
  // Statuses that count as "approved or beyond" (mirror of the section config).
  const APPROVED_MATCH_STATUSES = useMemo(
    () => ["APPROVED", "PROCUREMENT", "IN_PROCUREMENT", "DISPATCHED", "DELIVERED"],
    [],
  );

  // Base approved list (deduped union of the dedicated fetch + main list),
  // creator-filtered so salesman counts match what the staff dropdown shows.
  const approvedBaseOrders = useMemo(() => {
    const union = [...approvedOrders, ...orders]
      .filter((o) => APPROVED_MATCH_STATUSES.includes(getOrderStatus(o)))
      .filter((o, i, arr) => arr.findIndex((x) => x.id === o.id) === i);
    return filteredByCreator(union);
  }, [approvedOrders, orders, APPROVED_MATCH_STATUSES, filteredByCreator]);

  // salesmanId -> count of approved orders whose billed party the salesman owns.
  const salesmanApprovedCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const [sid, pids] of Object.entries(salesmanToParties)) {
      const pset = new Set(pids);
      counts[sid] = approvedBaseOrders.filter((o) => o.buyer?.id && pset.has(o.buyer.id)).length;
    }
    return counts;
  }, [salesmanToParties, approvedBaseOrders]);

  // The party set for the currently-selected salesman (null = no salesman filter).
  const approvedSalesmanPartySet = useMemo(() => {
    if (!approvedSalesmanId) return null;
    return new Set(salesmanToParties[approvedSalesmanId] || []);
  }, [approvedSalesmanId, salesmanToParties]);

  const approvedFiltersActive =
    !!approvedSearch.trim() || !!approvedDateFrom || !!approvedDateTo || !!approvedSalesmanId;

  // Applies search + date range + salesman-group filters to the approved list.
  const applyApprovedFilters = useCallback(
    (list: Order[]): Order[] => {
      let out = list;
      const q = approvedSearch.trim().toLowerCase();
      if (q) {
        out = out.filter(
          (o) =>
            o.order_number?.toLowerCase().includes(q) ||
            o.buyer?.name?.toLowerCase().includes(q) ||
            o.buyer?.party_code?.toLowerCase().includes(q),
        );
      }
      if (approvedDateFrom) {
        const from = new Date(`${approvedDateFrom}T00:00:00`).getTime();
        out = out.filter((o) => new Date(o.created_at).getTime() >= from);
      }
      if (approvedDateTo) {
        const to = new Date(`${approvedDateTo}T23:59:59.999`).getTime();
        out = out.filter((o) => new Date(o.created_at).getTime() <= to);
      }
      if (approvedSalesmanPartySet) {
        out = out.filter((o) => o.buyer?.id && approvedSalesmanPartySet.has(o.buyer.id));
      }
      return out;
    },
    [approvedSearch, approvedDateFrom, approvedDateTo, approvedSalesmanPartySet],
  );

  const clearApprovedFilters = useCallback(() => {
    setApprovedSearch("");
    setApprovedDateFrom("");
    setApprovedDateTo("");
    setApprovedSalesmanId("");
  }, []);

  const loadedOrderCount = useMemo(
    () => dedupeOrders([...orders, ...pendingOrders, ...approvedOrders]).length,
    [orders, pendingOrders, approvedOrders],
  );

  // Keep the staff dropdown's counters on the exact same source as the Pending
  // section. `orders` is a limited, mixed-status history request, so counting it
  // made the dropdown show total/partial history instead of pending orders.
  const pendingOrdersForCounts = useMemo(
    () => dedupeOrders([
      ...pendingOrders,
      ...orders.filter((order) => getOrderStatus(order) === "PENDING"),
    ]),
    [orders, pendingOrders],
  );

  const cardClass = "rounded-2xl border border-zinc-200 bg-white shadow-sm";
  const inputClass = "w-full rounded-xl border border-zinc-200 bg-white px-3.5 py-2.5 text-sm text-zinc-900 font-medium outline-none transition focus:border-amber-400 focus:ring-2 focus:ring-amber-100";

  // --- Product picker: category -> product drill-down -----------------------
  // Only offer products not already added as lines.
  const availableProducts = useMemo(
    () => products.filter((p) => !lines.some((l) => l.productId === p.id)),
    [products, lines]
  );
  const productCategories = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number }>();
    for (const p of availableProducts) {
      const id = p.category_id || UNCATEGORIZED;
      const name = p.category_name || p.product_categories?.name || "Uncategorized";
      const cur = map.get(id);
      if (cur) cur.count += 1;
      else map.set(id, { id, name, count: 1 });
    }
    return [...map.values()].sort((a, b) => {
      if (a.id === UNCATEGORIZED) return 1;
      if (b.id === UNCATEGORIZED) return -1;
      return a.name.localeCompare(b.name);
    });
  }, [availableProducts]);
  const productSearching = productSearch.trim().length > 0;
  const showCategoryGrid = !productSearching && selectedCategoryId === null;
  const shownProducts = productSearching
    ? availableProducts
    : selectedCategoryId
      ? availableProducts.filter((p) => (p.category_id || UNCATEGORIZED) === selectedCategoryId)
      : [];
  const activeCategoryName =
    productCategories.find((c) => c.id === selectedCategoryId)?.name ??
    (selectedCategoryId === UNCATEGORIZED ? "Uncategorized" : "Products");

  return (
    <div className="space-y-6" style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      {whatsAppDeliveryPopup && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="whatsapp-delivery-title">
          <div className="w-full max-w-md overflow-hidden rounded-3xl border border-white/70 bg-white shadow-2xl">
            <div className={`px-6 py-5 ${whatsAppDeliveryPopup.status === "sent"
              ? "bg-emerald-50"
              : whatsAppDeliveryPopup.status === "sending"
                ? "bg-amber-50"
                : "bg-rose-50"
            }`}>
              <div className="flex items-start gap-3">
                <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-white ${whatsAppDeliveryPopup.status === "sent"
                  ? "bg-[#25D366]"
                  : whatsAppDeliveryPopup.status === "sending"
                    ? "bg-amber-500"
                    : "bg-rose-500"
                }`}>
                  {whatsAppDeliveryPopup.status === "sending"
                    ? <Loader2 className="h-5 w-5 animate-spin" />
                    : whatsAppDeliveryPopup.status === "sent"
                      ? <WhatsAppIcon className="h-5 w-5" />
                      : <AlertTriangle className="h-5 w-5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <h2 id="whatsapp-delivery-title" className="text-lg font-bold text-zinc-900">
                    {whatsAppDeliveryPopup.status === "sending"
                      ? "Sending automatically"
                      : whatsAppDeliveryPopup.status === "sent"
                        ? "Order approved & WhatsApp sent"
                        : whatsAppDeliveryPopup.status === "send_failed"
                          ? "Order approved · WhatsApp failed"
                          : "Approval failed"}
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-zinc-600">{whatsAppDeliveryPopup.detail}</p>
                </div>
              </div>
            </div>

            <div className="space-y-3 px-6 py-5 text-sm">
              <div className="flex items-center justify-between gap-4">
                <span className="text-zinc-500">Order</span>
                <span className="font-semibold text-zinc-900">{whatsAppDeliveryPopup.orderNumber}</span>
              </div>
              {whatsAppDeliveryPopup.partyName && (
                <div className="flex items-center justify-between gap-4">
                  <span className="text-zinc-500">Party</span>
                  <span className="truncate font-semibold text-zinc-900">{whatsAppDeliveryPopup.partyName}</span>
                </div>
              )}
              <div className="flex items-center justify-between gap-4">
                <span className="text-zinc-500">WhatsApp delivery</span>
                <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${whatsAppDeliveryPopup.status === "sent"
                  ? "bg-emerald-100 text-emerald-700"
                  : whatsAppDeliveryPopup.status === "sending"
                    ? "bg-amber-100 text-amber-700"
                    : "bg-rose-100 text-rose-700"
                }`}>
                  {whatsAppDeliveryPopup.status === "sent" ? "SENT" : whatsAppDeliveryPopup.status === "sending" ? "SENDING" : "FAILED"}
                </span>
              </div>
              {whatsAppDeliveryPopup.to && (
                <div className="flex items-center justify-between gap-4">
                  <span className="text-zinc-500">Sent to</span>
                  <span className="font-mono font-semibold text-zinc-900">+{whatsAppDeliveryPopup.to}</span>
                </div>
              )}
              {whatsAppDeliveryPopup.messageId && (
                <div className="flex items-center justify-between gap-4">
                  <span className="text-zinc-500">Message reference</span>
                  <span className="max-w-[220px] truncate font-mono text-xs font-semibold text-zinc-700">{whatsAppDeliveryPopup.messageId}</span>
                </div>
              )}
            </div>

            {whatsAppDeliveryPopup.status !== "sending" && (
              <div className="border-t border-zinc-100 px-6 py-4">
                <button
                  type="button"
                  onClick={() => setWhatsAppDeliveryPopup(null)}
                  className={`w-full rounded-xl px-4 py-2.5 text-sm font-bold text-white transition ${whatsAppDeliveryPopup.status === "sent" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-zinc-900 hover:bg-zinc-800"}`}
                >
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-zinc-200 bg-gradient-to-r from-white to-amber-50/40 p-6 shadow-sm">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900">Create Order</h1>
        <p className="mt-1 text-sm text-zinc-600">GST-compliant order workflow with smart TD/CD and dues visibility</p>
      </div>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</div>}
      {success && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">{success}</div>}

      <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          {[{ n: 1, label: "Select Party" }, { n: 2, label: "Add Products" }, { n: 3, label: "Review & Submit" }].map((s, i) => (
            <div key={s.n} className="flex items-center gap-2">
              {i > 0 && <ChevronRight className="h-4 w-4 text-zinc-400" />}
              <button
                onClick={() => { if (s.n <= step) setStep(s.n); }}
                className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-medium transition ${step >= s.n
                  ? "border-amber-300 bg-amber-50 text-amber-700"
                  : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300 hover:text-zinc-700"
                  }`}
              >
                {step > s.n ? <Check className="h-3.5 w-3.5" /> : <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-zinc-100 text-xs">{s.n}</span>}
                {s.label}
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">

        {/* Main area */}
        <div className="lg:col-span-2 space-y-4">

          {/* Step 1: Select Party */}
            {step === 1 && selectedGroupId === null && (
              <section className={`${cardClass} p-5 md:p-6`}>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-sm">
                      <Users className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="truncate text-base font-semibold text-zinc-900">Select a Group</h3>
                      <p className="text-[11px] text-zinc-500">{salesmanSections.length} salesmen · {visibleGroups.length} routes</p>
                    </div>
                  </div>
                  {salesmanSections.length > 0 && !partyQuery && (
                    <button
                      onClick={() =>
                        setExpandedSalesmen((prev) =>
                          prev.size >= salesmanSections.length
                            ? new Set()
                            : new Set(salesmanSections.map((s) => s.salesman)),
                        )
                      }
                      className="shrink-0 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:border-amber-300 hover:text-amber-700"
                    >
                      {expandedSalesmen.size >= salesmanSections.length ? "Collapse all" : "Expand all"}
                    </button>
                  )}
                </div>
                <div className="relative mb-4">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                  <input
                    type="text"
                    placeholder="Search groups by name or code"
                    value={partySearch}
                    onChange={(e) => setPartySearch(e.target.value)}
                    className={`${inputClass} pl-10`}
                  />
                </div>
                <div className="max-h-[28rem] space-y-2 overflow-y-auto pr-1">
                  {/* All Parties escape hatch — keeps ungrouped parties reachable. */}
                  {!partyQuery && isRoleResolved && !isSalesman && (
                    <button
                      onClick={() => openGroup(ALL_PARTIES)}
                      className="group flex w-full items-center justify-between gap-3 rounded-xl border border-amber-200 bg-gradient-to-r from-amber-50 to-orange-50/40 p-3 text-left transition hover:border-amber-300 hover:shadow-sm"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-sm">
                          <Users className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-zinc-900">All Parties</p>
                          <p className="mt-0.5 text-xs text-zinc-500">Browse every party, grouped or not</p>
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 shrink-0 text-amber-500 transition group-hover:translate-x-0.5" />
                    </button>
                  )}

                  {groupsLoading && (
                    <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-500">
                      <Loader2 className="h-4 w-4 animate-spin text-amber-600" /> Loading groups…
                    </div>
                  )}

                  {!groupsLoading && filteredGroups.length === 0 && (
                    <p className="px-1 py-6 text-center text-sm text-zinc-500">
                      {partyQuery
                        ? `No groups match "${partySearch.trim()}"`
                        : isSalesman
                          ? "No assigned groups available."
                          : "No groups configured yet — use All Parties above."}
                    </p>
                  )}

                  {/* Folding accordion: groups tucked under their salesman. */}
                  {!groupsLoading && salesmanSections.map((section) => {
                    const theme = salesmanTheme(section.salesman);
                    const open = expandedSalesmen.has(section.salesman) || !!partyQuery;
                    return (
                      <div key={section.salesman} className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
                        <button
                          onClick={() => toggleSalesman(section.salesman)}
                          aria-expanded={open}
                          className={`flex w-full items-center justify-between gap-3 p-3 text-left transition ${open ? theme.soft : "hover:bg-zinc-50"}`}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br ${theme.grad} text-[11px] font-bold text-white shadow-sm ring-2 ${theme.ring}`}>
                              {initialsOf(section.salesman)}
                            </div>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-zinc-900">{section.salesman}</p>
                              <p className="mt-0.5 text-xs text-zinc-500">
                                {section.groupCount} {section.groupCount === 1 ? "group" : "groups"} · {section.partyCount} parties
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${theme.soft} ${theme.softText}`}>
                              {section.groupCount}
                            </span>
                            <ChevronDown className={`h-4 w-4 text-zinc-400 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
                          </div>
                        </button>

                        {open && (
                          <div className="space-y-1 border-t border-zinc-100 bg-zinc-50/40 p-2">
                            {section.groups.map((g) => (
                              <button
                                key={g.id}
                                onClick={() => openGroup(g.id)}
                                className="group flex w-full items-center justify-between gap-3 rounded-lg border border-transparent bg-white px-3 py-2 text-left transition hover:border-amber-300 hover:shadow-sm"
                              >
                                <div className="flex items-center gap-2.5 min-w-0">
                                  <Layers className="h-4 w-4 shrink-0 text-zinc-400" />
                                  <div className="min-w-0">
                                    <p className="truncate text-sm font-medium text-zinc-800">{g.name}</p>
                                    {(g.code || (g.price_list && !looksLikeUuid(g.price_list.name))) && (
                                      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-zinc-400">
                                        {g.code && <span className="font-mono">{g.code}</span>}
                                        {g.price_list && !looksLikeUuid(g.price_list.name) && <span>· {g.price_list.name}</span>}
                                      </p>
                                    )}
                                  </div>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600">
                                    {g.member_count}
                                  </span>
                                  <ChevronRight className="h-3.5 w-3.5 text-zinc-300 transition group-hover:translate-x-0.5 group-hover:text-amber-500" />
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {step === 1 && selectedGroupId !== null && (
              <section className={`${cardClass} p-5 md:p-6`}>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <button
                      onClick={backToGroups}
                      className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-900"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" /> Groups
                    </button>
                    <h3 className="flex items-center gap-1.5 truncate text-base font-semibold text-zinc-900">
                      <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
                      <span className="truncate">{selectedGroupId === ALL_PARTIES ? "All Parties" : selectedGroup?.name || "Group"}</span>
                    </h3>
                  </div>
                  <span className="shrink-0 rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-600">{filteredParties.length} found</span>
                </div>
                <div className="relative mb-4">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                  <input
                    type="text"
                    placeholder="Search by party name or code"
                    value={partySearch}
                    onChange={(e) => setPartySearch(e.target.value)}
                    className={`${inputClass} pl-10`}
                  />
                </div>
                <div className="max-h-[24rem] space-y-2 overflow-y-auto pr-1">
                  {filteredParties.length === 0 && (
                    <p className="px-1 py-6 text-center text-sm text-zinc-500">
                      {partyQuery
                        ? `No parties match "${partySearch.trim()}"`
                        : selectedGroupId === ALL_PARTIES
                          ? "No parties available"
                          : "This group has no parties yet"}
                    </p>
                  )}
                  {filteredParties.map((p) => {
                    const BAND_C: Record<string, { bg: string; border: string; dot: string; text: string }> = {
                      EXCELLENT: { bg: "rgba(16,185,129,0.07)", border: "rgba(16,185,129,0.35)", dot: "#10b981", text: "#059669" },
                      GOOD:      { bg: "rgba(34,197,94,0.07)",  border: "rgba(34,197,94,0.35)",  dot: "#22c55e", text: "#16a34a" },
                      FAIR:      { bg: "rgba(245,158,11,0.07)", border: "rgba(245,158,11,0.35)", dot: "#f59e0b", text: "#d97706" },
                      POOR:      { bg: "rgba(249,115,22,0.07)", border: "rgba(249,115,22,0.35)", dot: "#f97316", text: "#ea580c" },
                      VERY_POOR: { bg: "rgba(239,68,68,0.07)",  border: "rgba(239,68,68,0.35)",  dot: "#ef4444", text: "#dc2626" },
                    };
                    const si = creditScoresMap[p.id];
                    const sc = si?.band ? BAND_C[si.band] : null;
                    const isSelected = selectedParty?.id === p.id;
                    const borderColor = isSelected ? "#f6b91a" : sc ? sc.border : "rgba(228,228,231,1)";
                    const bgColor = isSelected ? "rgba(251,191,36,0.07)" : sc ? sc.bg : "#ffffff";
                    return (
                      <button
                        key={p.id}
                        onClick={() => handleSelectParty(p)}
                        className="w-full rounded-xl border p-3 text-left transition"
                        style={{ borderColor, background: bgColor }}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-zinc-900">{p.name}</p>
                            <p className="mt-0.5 font-mono text-xs text-zinc-500">{p.party_code}</p>
                            {selectedGroupId === ALL_PARTIES && (groupsByPartyId[p.id]?.length ?? 0) > 0 && (
                              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                                {groupsByPartyId[p.id].map((g) => (
                                  <span
                                    key={g.id}
                                    className="inline-flex items-center gap-1 rounded-md bg-gradient-to-r from-violet-500 to-indigo-500 px-2 py-0.5 text-[11px] font-semibold text-white shadow-sm ring-1 ring-violet-300"
                                  >
                                    <Layers className="h-3 w-3" />
                                    {g.name}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {si?.score !== null && si?.score !== undefined && si.band && sc && (
                              <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold"
                                style={{ background: sc.bg, border: `1px solid ${sc.border}`, color: sc.text, fontSize: "0.58rem" }}>
                                <span className="w-1.5 h-1.5 rounded-full inline-block shrink-0" style={{ background: sc.dot }} />
                                {si.score}
                              </span>
                            )}
                            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-zinc-600">
                              {p.party_types?.name?.replace(/_/g, " ") || "N/A"}
                            </span>
                          </div>
                        </div>
                        <p className="mt-2 text-xs text-zinc-500">GSTIN: {p.gstin || "Not available"}</p>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Step 2: Products */}
            {step === 2 && (
              <>
                <section className={`${cardClass} p-5 md:p-6`}>
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      {selectedCategoryId && !productSearching && (
                        <button
                          onClick={() => setSelectedCategoryId(null)}
                          className="flex shrink-0 items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-900"
                        >
                          <ChevronLeft className="h-3.5 w-3.5" /> Categories
                        </button>
                      )}
                      <h3 className="truncate text-base font-semibold text-zinc-900">
                        {productSearching ? "Search results" : selectedCategoryId ? activeCategoryName : "Add Products"}
                      </h3>
                    </div>
                    <span className="shrink-0 rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-600">
                      {showCategoryGrid
                        ? `${productCategories.length} ${productCategories.length === 1 ? "category" : "categories"}`
                        : `${shownProducts.length} ${shownProducts.length === 1 ? "product" : "products"}`}
                    </span>
                  </div>
                  <div className="relative mb-4">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                    <input
                      type="text"
                      placeholder="Search products by name or SKU"
                      value={productSearch}
                      onChange={(e) => setProductSearch(e.target.value)}
                      className={`${inputClass} pl-10`}
                    />
                  </div>
                  {showCategoryGrid ? (
                    productCategories.length === 0 ? (
                      <p className="px-1 py-6 text-center text-sm text-zinc-500">No products available</p>
                    ) : (
                      <div className="grid max-h-56 grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                        {productCategories.map((c) => (
                          <button
                            key={c.id}
                            onClick={() => setSelectedCategoryId(c.id)}
                            className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3 text-left transition hover:border-amber-300 hover:bg-amber-50/50"
                          >
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-amber-200 bg-amber-50">
                              <FolderOpen className="h-4 w-4 text-amber-600" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium text-zinc-900">{c.name}</p>
                              <p className="mt-0.5 truncate text-xs text-zinc-500">{c.count} {c.count === 1 ? "product" : "products"}</p>
                            </div>
                            <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" />
                          </button>
                        ))}
                      </div>
                    )
                  ) : shownProducts.length === 0 ? (
                    <p className="px-1 py-6 text-center text-sm text-zinc-500">
                      {productSearching ? `No products match "${productSearch.trim()}"` : "No products in this category"}
                    </p>
                  ) : (
                    <div className="grid max-h-56 grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                      {shownProducts.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => addLine(p)}
                          className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3 text-left transition hover:border-zinc-300 hover:bg-zinc-50"
                        >
                          {(p.image_url || p.technical_specs?.image_url) ? (
                            <img src={(p.image_url || p.technical_specs?.image_url)!} alt={p.name} className="h-9 w-9 shrink-0 rounded-lg object-cover border border-zinc-200" />
                          ) : (
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 border border-zinc-200">
                              <Plus className="h-4 w-4 text-amber-600" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-zinc-900">{p.name}</p>
                            <p className="mt-0.5 truncate text-xs text-zinc-500">{p.sku} | {fmt(Number(p.effective_price ?? p.base_price))}/{p.unit_of_measure}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </section>

                  {lines.length > 0 && (
                    <section className={`${cardClass} p-5 md:p-6`}>
                      <div className="mb-4 flex items-center justify-between gap-2">
                        <h3 className="text-base font-semibold text-zinc-900">Order Lines ({lines.length})</h3>
	                        {partyDues && effectiveWalletBalance(partyDues) !== 0 && (() => {
	                          const walletBalance = effectiveWalletBalance(partyDues);
	                          return (
	                            <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold ${walletBalance > 0 ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"}`}>
	                              <IndianRupee className="h-3 w-3" />
	                              Wallet: {walletBalance > 0 ? `+${fmt(walletBalance)}` : fmt(walletBalance)}
	                            </span>
	                          );
	                        })()}
                      </div>
                    <div className="space-y-3">
                      {lines.map((line, idx) => (
                        <div key={line.productId} className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3">
                          <div className="mb-3 flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-zinc-900">{line.name}</p>
                              <p className="text-xs text-zinc-500">{line.sku} | {line.uom}{calcResult?.lines[idx] && <span className="ml-2 text-amber-600">GST: {calcResult.lines[idx].gstRate}%</span>}</p>
                            </div>
                            <button onClick={() => removeLine(idx)} className="rounded-lg border border-zinc-200 bg-white p-1.5 text-zinc-500 transition hover:border-red-200 hover:text-red-600">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                          <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
                            <div>
                              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Quantity</p>
                              <div className="flex items-center gap-1">
                                <button onClick={() => updateLine(idx, "quantity", Math.max(1, line.quantity - 1))} className="rounded-lg border border-zinc-200 bg-white p-1.5 text-zinc-600 hover:text-zinc-900"><Minus className="h-3 w-3" /></button>
                                <input type="number" min={1} value={line.quantity} onChange={(e) => updateLine(idx, "quantity", Math.max(1, parseInt(e.target.value) || 1))} className={`${inputClass} px-2 py-1.5 text-center`} />
                                <button onClick={() => updateLine(idx, "quantity", line.quantity + 1)} className="rounded-lg border border-zinc-200 bg-white p-1.5 text-zinc-600 hover:text-zinc-900"><Plus className="h-3 w-3" /></button>
                              </div>
                            </div>
                            <div>
                              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Unit Price</p>
                              <input type="number" step="0.01" value={line.unitPrice ?? ""} onChange={(e) => updateLine(idx, "unitPrice", parseFloat(e.target.value) || 0)} className={`${inputClass} px-2 py-1.5 text-center`} />
                            </div>
                            <div>
                              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Discount %</p>
                              <input type="number" min={0} max={100} step="0.5" value={line.discountPercent} onChange={(e) => { const v = e.target.value; updateLine(idx, "discountPercent", v === "" ? 0 : parseFloat(v)); }} className={`${inputClass} px-2 py-1.5 text-center`} />
                            </div>
                            <div className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-right">
                              <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Line Total</p>
                              <p className="mt-1 text-sm font-semibold text-zinc-900">{calcResult?.lines[idx] ? fmt(calcResult.lines[idx].lineTotal) : fmt(line.quantity * (line.unitPrice ?? 0))}</p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 space-y-3">
                      <div className="flex items-center gap-4 p-3 rounded-xl border border-amber-200 bg-gradient-to-r from-amber-50/80 to-white">
                        <div className="flex items-center gap-2">
                          <IndianRupee className="h-4 w-4 text-amber-600" />
                          <label className="text-sm font-medium text-zinc-700 whitespace-nowrap">Bill Discount</label>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step="0.5"
                            value={billDiscountPercent}
                            onChange={(e) => setBillDiscountPercent(parseFloat(e.target.value) || 0)}
                            className="w-20 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-bold text-zinc-900 text-center outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
                            placeholder="0"
                          />
                          <span className="text-sm text-zinc-600">%</span>
                        </div>
                        {billDiscountPercent > 0 && calcResult && (
                          <span className="text-sm text-red-600 font-medium">
                            -{fmt(calcResult.billDiscountAmount)} on total incl. tax
                          </span>
                        )}
                      </div>
                    </div>
                      {/* Order Notes */}
                      <div className="mt-4">
                        <div className="flex items-center gap-4 p-3 rounded-xl border border-zinc-200 bg-zinc-50/60">
                          <div className="flex items-center gap-2 self-start pt-0.5">
                            <FileText className="h-4 w-4 text-zinc-500" />
                            <label className="text-sm font-medium text-zinc-700 whitespace-nowrap">Order Note</label>
                          </div>
                          <textarea
                            value={orderNotes}
                            onChange={(e) => setOrderNotes(e.target.value)}
                            placeholder="Add a note for this order (e.g. delivery instructions, special requests...)"
                            rows={2}
                            className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none transition focus:border-amber-400 focus:ring-2 focus:ring-amber-100 resize-none placeholder:text-zinc-400"
                          />
                        </div>
                      </div>
                      <div className="mt-4 flex justify-end">
                        <button onClick={() => setStep(3)} disabled={lines.length === 0} className="inline-flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-5 py-2.5 text-sm font-semibold text-amber-700 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60">
                          Continue to Review <ChevronRight className="h-4 w-4" />
                        </button>
                      </div>
                  </section>
                )}
              </>
            )}

            {/* Step 3: Review */}
            {step === 3 && (
              <section className={`${cardClass} p-5 md:p-6`}>
                <h3 className="mb-4 text-base font-semibold text-zinc-900">Review Order</h3>

                {selectedParty && (
                  <div className="mb-4 rounded-xl border border-zinc-200 bg-zinc-50/70 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-zinc-900">{selectedParty.name}</p>
                        <p className="text-xs text-zinc-500">{selectedParty.party_code} | {selectedParty.party_types?.name}</p>
                      </div>
                      {selectedParty.gstin && <p className="font-mono text-xs text-zinc-600">GSTIN: {selectedParty.gstin}</p>}
                    </div>
                  </div>
                )}

                <div className="mb-4 overflow-x-auto rounded-xl border border-zinc-200">
                  <table className="w-full min-w-[700px]">
                    <thead className="bg-zinc-50">
                      <tr className="border-b border-zinc-200">
                        {["Product", "Qty", "Rate", "Taxable", "GST", "Total"].map((h) => (
                          <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line, idx) => (
                        <tr key={line.productId} className="border-b border-zinc-100 last:border-b-0">
                          <td className="px-3 py-2 text-sm text-zinc-900">{line.name}</td>
                          <td className="px-3 py-2 text-sm text-zinc-700">{line.quantity}</td>
                          <td className="px-3 py-2 text-sm text-zinc-700">{fmt(Number(line.unitPrice || 0))}</td>
                          <td className="px-3 py-2 text-sm text-zinc-700">{calcResult?.lines[idx] ? fmt(calcResult.lines[idx].taxableAmount) : "-"}</td>
                          <td className="px-3 py-2 text-xs text-zinc-600">
                            {calcResult?.lines[idx] && (
                              <>
                                {calcResult.isInterstate ? `IGST ${fmt(calcResult.lines[idx].igstAmount)}` : `CGST ${fmt(calcResult.lines[idx].cgstAmount)} + SGST ${fmt(calcResult.lines[idx].sgstAmount)}`}
                                {calcResult.lines[idx].cessAmount > 0 && ` + Cess ${fmt(calcResult.lines[idx].cessAmount)}`}
                              </>
                            )}
                          </td>
                          <td className="px-3 py-2 text-sm font-semibold text-zinc-900">{calcResult?.lines[idx] ? fmt(calcResult.lines[idx].lineTotal) : "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>

                  {orderNotes && (
                    <div className="mb-4 rounded-xl border border-zinc-200 bg-zinc-50/60 p-3">
                      <div className="flex items-start gap-2">
                        <FileText className="h-4 w-4 text-zinc-400 mt-0.5 shrink-0" />
                        <div>
                          <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 mb-1">Order Note</p>
                          <p className="text-sm text-zinc-700 whitespace-pre-wrap">{orderNotes}</p>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="flex justify-end">
                    <button onClick={submitOrder} disabled={submitting || lines.length === 0} className="inline-flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-6 py-2.5 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60">
                    {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    Approve & Create Order
                  </button>
                </div>
              </section>
            )}
        </div>

        {/* Right panel - Live calculation */}
        <div className="lg:col-span-1">
          <div className={`${cardClass} sticky top-20 p-5`}>
            <div className="mb-4 flex items-center gap-2">
              <Calculator className="h-4 w-4 text-amber-600" />
              <h3 className="text-sm font-semibold text-zinc-900">Live Calculation</h3>
              {calculating && <Loader2 className="h-3 w-3 animate-spin text-amber-600" />}
            </div>

            {selectedParty && (
              <div className="mb-4 rounded-xl border border-zinc-200 bg-zinc-50/70 p-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Billing To</p>
                <p className="mt-1 text-sm font-semibold text-zinc-900">{selectedParty.name}</p>
                <p className="text-xs text-zinc-500">{selectedParty.party_types?.name} | {selectedParty.gstin || "No GSTIN"}</p>
              </div>
            )}

              {/* Wallet Balance / Due Invoices */}
              {selectedParty && (
                <div className="mb-4">
                  {partyDuesLoading ? (
                    <div className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-600" />
                      <span className="text-sm text-zinc-500">Loading party history...</span>
                    </div>
	                  ) : partyDues ? (() => {
	                    const walletBalance = effectiveWalletBalance(partyDues);
	                    const isPositive = walletBalance > 0;
	                    const isNegative = walletBalance < 0;
	                    const hasDues = partyDues.outstanding > 0;
	                    const isWarning = isNegative || hasDues;

	                    return (
	                      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
	                        {/* Wallet Balance Header */}
	                        <div className={`flex items-center justify-between gap-2 px-3 py-2.5 ${isWarning ? "border-b border-red-100 bg-red-50" : "border-b border-emerald-100 bg-emerald-50"}`}>
	                          <div className="flex items-center gap-2">
	                            {isPositive ? (
	                              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
	                            ) : isWarning ? (
	                              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-600" />
	                            ) : (
	                              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
	                            )}
	                            <span className={`text-xs font-medium uppercase tracking-wide ${isWarning ? "text-red-600" : "text-emerald-600"}`}>
	                              Wallet Balance
	                            </span>
	                          </div>
	                          <span className={`text-base font-bold ${isWarning ? "text-red-700" : "text-emerald-700"}`}>
	                            {walletBalance > 0 ? `+${fmt(walletBalance)}` : fmt(walletBalance)}
	                          </span>
	                        </div>

                        {/* If positive balance - show advance/credit info */}
	                        {isPositive && (
	                          <div className="p-3">
	                            <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2.5">
	                              <p className="text-xs font-medium text-emerald-700">Advance / Credit Available</p>
	                              <p className="mt-0.5 text-[11px] text-emerald-600/80">
	                                Effective wallet balance includes opening balance and wallet transactions.
	                              </p>
	                            </div>
	                          </div>
	                        )}

	                        {isNegative && (
	                          <div className="p-3">
	                            <div className="rounded-lg border border-red-200 bg-red-50/60 px-3 py-2.5">
	                              <p className="text-xs font-medium text-red-700">Wallet receivable</p>
	                              <p className="mt-0.5 text-[11px] text-red-600/80">
	                                Effective wallet balance includes opening balance and wallet transactions.
	                              </p>
	                            </div>
	                          </div>
	                        )}

                        {/* If negative / has dues - show unpaid invoices */}
                        {hasDues && partyDues.unpaid_invoices.length > 0 && (
                          <div>
                            <div className="flex items-center justify-between bg-red-50/50 px-3 py-2 border-b border-red-100">
                              <div className="flex items-center gap-1.5">
                                <IndianRupee className="h-3 w-3 text-red-500" />
                                <span className="text-xs font-semibold text-red-700">Due Invoices ({partyDues.unpaid_invoices.length})</span>
                              </div>
                              <span className="text-xs font-bold text-red-700">{fmt(partyDues.outstanding)}</span>
                            </div>
                            <div className="max-h-48 overflow-y-auto divide-y divide-zinc-100">
                              {partyDues.unpaid_invoices.map((inv) => (
                                <div key={inv.id} className="flex items-center justify-between px-3 py-2 hover:bg-zinc-50/50 transition">
                                  <div>
                                    <p className="text-xs font-semibold text-zinc-800">{inv.invoice_number}</p>
                                    <p className="text-[11px] text-zinc-500">
                                      {new Date(inv.invoice_date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                                      {inv.aging_days > 0 && <span className="ml-1 font-medium text-red-600">({inv.aging_days}d overdue)</span>}
                                    </p>
                                  </div>
                                  <div className="text-right">
                                    <p className="text-xs font-bold text-red-700">{fmt(Number(inv.amount_outstanding))}</p>
                                    {Number(inv.amount_paid) > 0 && <p className="text-[11px] text-zinc-500">Paid: {fmt(Number(inv.amount_paid))}</p>}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* If no dues and no positive balance - clear */}
	                        {!isPositive && !isNegative && !hasDues && (
                          <div className="p-3">
                            <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2.5">
                              <p className="text-xs font-medium text-emerald-700">All clear - no outstanding dues</p>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })() : null}
                </div>
              )}

	            {/* Credit Opinion */}
	            {selectedParty && (() => {
	              const apiCredit = creditScoresMap[selectedParty.id];
	              const fallbackCredit = partyDues ? buildWalletBasedCreditOpinion(partyDues) : null;
	              const ci = apiCredit?.score && apiCredit.band ? apiCredit : fallbackCredit;
	              const hasCreditFetchError = creditErrorMap[selectedParty.id] === true;
	              if (!ci?.score || !ci.band) {
	                return (
                  <div className="mb-4 rounded-xl border border-zinc-200 bg-white p-4">
                    <div className="flex items-center gap-2 mb-2">
                       <span style={{ fontSize: "0.6rem", textTransform: "uppercase", letterSpacing: "0.07em", color: "#a1a1aa" }}>Credit Opinion</span>
                    </div>
	                    <div className="text-zinc-500" style={{ fontSize: "0.8rem" }}>
	                      {hasCreditFetchError
	                        ? "Credit analysis is currently unavailable. Please retry in a moment."
	                        : "Select a party to load wallet and dues based credit opinion."}
	                    </div>
	                  </div>
	                );
              }

              const BAND_C: Record<string, { bg: string; border: string; dot: string }> = {
                EXCELLENT: { bg: "rgba(16,185,129,0.08)",  border: "rgba(16,185,129,0.3)",  dot: "#10b981" },
                GOOD:      { bg: "rgba(34,197,94,0.08)",   border: "rgba(34,197,94,0.3)",   dot: "#22c55e" },
                FAIR:      { bg: "rgba(245,158,11,0.08)",  border: "rgba(245,158,11,0.3)",  dot: "#f59e0b" },
                POOR:      { bg: "rgba(249,115,22,0.08)",  border: "rgba(249,115,22,0.3)",  dot: "#f97316" },
                VERY_POOR: { bg: "rgba(239,68,68,0.08)",   border: "rgba(239,68,68,0.3)",   dot: "#ef4444" },
              };
              const bc = BAND_C[ci.band] || BAND_C.FAIR;

              // Credit decision logic
              const isApprove   = ci.band === "EXCELLENT" || ci.band === "GOOD";
              const isCaution   = ci.band === "POOR";
              const isDecline   = ci.band === "VERY_POOR";
              const decisionKey = isApprove ? "APPROVE" : isCaution ? "CAUTION" : isDecline ? "DECLINE" : "CONDITIONAL";

              const DS: Record<string, { bg: string; border: string; text: string; label: string; icon: string }> = {
                APPROVE:     { bg: "rgba(16,185,129,0.1)",  border: "rgba(16,185,129,0.3)",  text: "#059669", label: "APPROVE",      icon: "✓" },
                CONDITIONAL: { bg: "rgba(245,158,11,0.1)",  border: "rgba(245,158,11,0.3)",  text: "#d97706", label: "CONDITIONAL",  icon: "⚠" },
                CAUTION:     { bg: "rgba(249,115,22,0.1)",  border: "rgba(249,115,22,0.3)",  text: "#ea580c", label: "CAUTION",      icon: "⚠" },
                DECLINE:     { bg: "rgba(239,68,68,0.1)",   border: "rgba(239,68,68,0.3)",   text: "#dc2626", label: "DECLINE",      icon: "✗" },
              };
              const ds = DS[decisionKey];

	              const opinionText: Record<string, string> = ci.source === "wallet"
	                ? {
	                    APPROVE:     "Wallet position is healthy. Standard credit terms can be considered.",
	                    CONDITIONAL: "Limited invoice history. Use a controlled credit window or partial advance.",
	                    CAUTION:     "Wallet receivable exposure is high. Limit credit and prefer advance payment.",
	                    DECLINE:     "Very high wallet exposure. Do not extend credit without full advance.",
	                  }
	                : {
	                    APPROVE:     "Strong payment track record. Standard credit terms can be extended safely.",
	                    CONDITIONAL: "Moderate risk — consider 15–30 day credit window or partial advance payment.",
	                    CAUTION:     "High risk detected. Limit credit exposure; advance payment is recommended.",
	                    DECLINE:     "Very poor payment history. Do not extend credit without full advance.",
	                  };

              // Suggested credit limit: avg monthly invoiced × band multiplier × payment rate
              const mult: Record<string, number> = { EXCELLENT: 3, GOOD: 2, FAIR: 1, POOR: 0.5, VERY_POOR: 0 };
              const baseLimit = ci.avg_monthly_invoiced * (mult[ci.band] || 0);
              const suggestedLimit = Math.round(baseLimit * (ci.payment_rate / 100) / 1000) * 1000;

              // Reasoning bullets
	              const walletBalance = partyDues ? effectiveWalletBalance(partyDues) : 0;
	              const walletExposure = partyDues ? Math.max(0, Math.abs(Math.min(walletBalance, 0)) + Number(partyDues.outstanding || 0)) : 0;
	              const bullets: { text: string; positive: boolean }[] = ci.source === "wallet"
	                ? [
	                    { text: `Credit score ${ci.score}/900 — ${ci.band.replace("_", " ")}`, positive: ci.score >= 650 },
	                    { text: `Effective wallet balance: ${walletBalance > 0 ? "+" : ""}${fmt(walletBalance)}`, positive: walletBalance >= 0 },
	                    { text: `Current credit exposure: ${fmt(walletExposure)}`, positive: walletExposure <= 50000 },
	                    { text: "Opinion based on wallet balance and dues until invoice history is available", positive: true },
	                  ]
	                : [
	                    { text: `Credit score ${ci.score}/900 — ${ci.band.replace("_", " ")}`, positive: ci.score >= 650 },
	                    { text: `${ci.payment_rate}% payment rate on invoices`, positive: ci.payment_rate >= 80 },
	                    { text: `Avg ${ci.avg_outstanding_days} days to settle invoices`, positive: ci.avg_outstanding_days <= 45 },
	                    { text: `Monthly avg order: ${fmt(ci.avg_monthly_invoiced)}`, positive: true },
	                  ];

              return (
                <div className="mb-4 rounded-xl overflow-hidden" style={{ border: `1px solid ${ds.border}` }}>
                  {/* Decision header */}
                  <div className="flex items-center justify-between px-3 py-2" style={{ background: ds.bg }}>
                    <span style={{ fontSize: "0.6rem", textTransform: "uppercase", letterSpacing: "0.07em", color: "#a1a1aa" }}>Credit Opinion</span>
                    <span className="flex items-center gap-1 rounded-md px-2 py-0.5 font-bold"
                      style={{ fontSize: "0.65rem", background: "rgba(255,255,255,0.75)", color: ds.text, border: `1px solid ${ds.border}` }}>
                      {ds.icon} {ds.label}
                    </span>
                  </div>

                  <div className="px-3 pt-2.5 pb-3" style={{ background: "white" }}>
                    {/* Score + band row */}
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-bold" style={{ fontSize: "1.25rem", color: bc.dot, lineHeight: 1 }}>{ci.score}</span>
                      <div>
                        <span className="rounded px-1.5 py-0.5 font-semibold"
                          style={{ fontSize: "0.58rem", background: bc.bg, color: bc.dot, border: `1px solid ${bc.border}` }}>
                          {ci.band.replace("_", " ")}
                        </span>
                        <span style={{ fontSize: "0.6rem", color: "#a1a1aa", marginLeft: "4px" }}>/ 900</span>
                      </div>
                    </div>

                    {/* Score bar */}
                    <div className="h-1.5 rounded-full overflow-hidden mb-2.5" style={{ background: "#f4f4f5" }}>
                      <div className="h-1.5 rounded-full" style={{
                        width: `${Math.min(100, ((ci.score - 300) / 600) * 100)}%`,
                        background: bc.dot, transition: "width 0.5s",
                      }} />
                    </div>

                    {/* Opinion text */}
                    <p style={{ fontSize: "0.7rem", color: "#52525b", lineHeight: 1.45, marginBottom: "10px" }}>
                      {opinionText[decisionKey]}
                    </p>

                    {/* Reasoning bullets */}
                    <div className="space-y-1 mb-2.5">
                      {bullets.map((b, i) => (
                        <div key={i} className="flex items-start gap-1.5">
                          <span style={{ fontSize: "0.6rem", marginTop: "1px", color: b.positive ? "#10b981" : "#f97316", flexShrink: 0 }}>
                            {b.positive ? "●" : "●"}
                          </span>
                          <span style={{ fontSize: "0.68rem", color: "#71717a", lineHeight: 1.4 }}>{b.text}</span>
                        </div>
                      ))}
                    </div>

                    {/* Suggested credit limit */}
                    <div className="rounded-lg px-3 py-2" style={{ background: ds.bg, border: `1px solid ${ds.border}` }}>
                      <div className="flex items-center justify-between">
                        <span style={{ fontSize: "0.62rem", color: "#71717a" }}>Suggested Credit Limit</span>
                        {suggestedLimit > 0
                          ? <span className="font-bold font-mono" style={{ fontSize: "0.88rem", color: ds.text }}>{fmt(suggestedLimit)}</span>
                          : <span className="font-semibold" style={{ fontSize: "0.72rem", color: "#ef4444" }}>Not Recommended</span>}
                      </div>
                      <p style={{ fontSize: "0.6rem", color: "#a1a1aa", marginTop: "2px" }}>
                        Based on avg monthly orders × payment behaviour
                      </p>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Tax Template picker */}
            <div className="mb-4">
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Tax Template</div>
              <select
                value={selectedTemplate?.id || ""}
                onChange={(e) => {
                  const nextTemplate = templates.find((t) => t.id === e.target.value) || null;
                  setSelectedTemplate(nextTemplate);
                }}
                className={inputClass}
              >
                <option value="">— Select Tax Template —</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.product_name} — {t.gst_rate}%</option>
                ))}
              </select>
              {templates.length === 0 && (
                <div className="mt-1 text-xs text-zinc-500">
                  No templates - create one in Tax Settings
                </div>
              )}
            </div>

            {!selectedTemplate && lines.length > 0 && (
              <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-xs text-amber-700">
                Select a tax template above to see calculations
              </div>
            )}

            {calculating && calcResult ? (
              <div className="space-y-2 animate-pulse">
                <div className="h-4 rounded bg-zinc-100" />
                <div className="h-4 w-5/6 rounded bg-zinc-100" />
                <div className="h-20 rounded bg-zinc-100" />
                <div className="h-10 rounded bg-amber-100" />
              </div>
            ) : calcResult ? (
              <div className="space-y-2 text-sm">
                {(() => {
                  // When a template is selected, always show CGST+SGST (intra-state); otherwise use server result
                  const isInter = selectedTemplate ? selectedTemplate.transaction_type === "inter" : calcResult.isInterstate;
                  return (
                    <>
                    <div className="flex justify-between"><span className="text-zinc-600">Subtotal</span><span className="font-medium text-zinc-900">{fmt(calcResult.subtotal)}</span></div>
                      {calcResult.lineDiscountAmount > 0 && (
                        <div className="flex justify-between"><span className="text-zinc-600">Line Discounts</span><span className="font-medium text-red-600">-{fmt(calcResult.lineDiscountAmount)}</span></div>
                      )}
                    {/* Trade Discount - auto-applied with remove/re-apply toggle */}
                    {skipTd ? (
                      <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-2.5 py-1.5 my-1">
                        <div className="flex justify-between items-center">
                          <span className="text-amber-700 font-medium" style={{ fontSize: "0.75rem" }}>Trade Discount</span>
                          <span className="text-zinc-400 line-through font-medium" style={{ fontSize: "0.8rem" }}>Removed</span>
                        </div>
                        <div className="flex items-center justify-between mt-1">
                          <span className="text-amber-600" style={{ fontSize: "0.6rem" }}>TD removed for this order</span>
                          <button
                            onClick={() => setSkipTd(false)}
                            className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-emerald-700 transition hover:bg-emerald-100"
                            style={{ fontSize: "0.6rem", fontWeight: 600 }}
                          >
                            <Plus className="h-2.5 w-2.5" /> Re-apply TD
                          </button>
                        </div>
                      </div>
                    ) : calcResult.tdPercent > 0 ? (
                      <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-2.5 py-1.5 my-1">
                        <div className="flex justify-between items-center">
                          <span className="text-emerald-700 font-medium" style={{ fontSize: "0.75rem" }}>Trade Discount ({calcResult.tdPercent}%)</span>
                          <span className="font-semibold text-red-600" style={{ fontSize: "0.8rem" }}>-{fmt(calcResult.tdAmount)}</span>
                        </div>
                        <div className="flex items-center justify-between mt-1">
                          <span className="text-emerald-600" style={{ fontSize: "0.6rem" }}>Auto-applied from pricing config</span>
                          <button
                            onClick={() => setSkipTd(true)}
                            className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-red-50 px-2 py-0.5 text-red-600 transition hover:bg-red-100"
                            style={{ fontSize: "0.6rem", fontWeight: 600 }}
                          >
                            <X className="h-2.5 w-2.5" /> Remove TD
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 px-2.5 py-1.5 my-1">
                        <div className="flex justify-between items-center">
                          <span className="text-zinc-500" style={{ fontSize: "0.72rem" }}>Trade Discount</span>
                          <span className="text-zinc-400 font-medium" style={{ fontSize: "0.72rem" }}>Not configured</span>
                        </div>
                        <span className="text-zinc-400" style={{ fontSize: "0.58rem" }}>Set TD in Pricing & Discounts page to auto-apply</span>
                      </div>
                    )}
                      {calcResult.billDiscountAmount > 0 && (
                        <div className="flex justify-between"><span className="text-zinc-600">Bill Discount ({billDiscountPercent}%)</span><span className="font-medium text-red-600">-{fmt(calcResult.billDiscountAmount)}</span></div>
                      )}
                    <div className="flex justify-between"><span className="text-zinc-600">Taxable Amount</span><span className="font-medium text-zinc-900">{fmt(calcResult.taxableAmount)}</span></div>
                  <div className="mt-2 border-t border-zinc-200 pt-2">
                    <div className="mb-2 flex items-center gap-1.5">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${isInter ? "border-purple-200 bg-purple-50 text-purple-700" : "border-blue-200 bg-blue-50 text-blue-700"}`}>
                        {isInter ? "Inter-State" : "Intra-State"}
                      </span>
                      <span className="text-xs text-zinc-500">{isInter ? "IGST applies" : "CGST + SGST applies"}</span>
                    </div>
                  {/* Per-slab GST breakdown */}
                  {selectedTemplate?.gst_rate === 0 ? (
                    <div className="pl-2 border-l-2 border-black/[0.06]">
                      <div className="text-zinc-500 mb-0.5" style={{ fontSize: "0.68rem" }}>0% template selected</div>
                      <div className="flex justify-between">
                        <span className="text-zinc-500 font-medium" style={{ fontSize: "0.72rem" }}>GST</span>
                        <span className="text-zinc-900" style={{ fontSize: "0.72rem" }}>{fmt(0)}</span>
                      </div>
                      {calcResult.cessAmount > 0 && (
                        <div className="flex justify-between">
                          <span className="text-zinc-500 font-medium" style={{ fontSize: "0.72rem" }}>Cess</span>
                          <span className="text-zinc-900" style={{ fontSize: "0.72rem" }}>{fmt(calcResult.cessAmount)}</span>
                        </div>
                      )}
                    </div>
                  ) : (() => {
                    const slabs = new Map<number, { taxable: number; cgst: number; sgst: number; igst: number; cess: number }>();
                    calcResult.lines.forEach(l => {
                      const r = l.gstRate;
                      const existing = slabs.get(r) || { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 };
                      slabs.set(r, {
                        taxable: existing.taxable + l.taxableAmount,
                        cgst: existing.cgst + l.cgstAmount,
                        sgst: existing.sgst + l.sgstAmount,
                        igst: existing.igst + l.igstAmount,
                        cess: existing.cess + l.cessAmount,
                      });
                    });
                    return [...slabs.entries()].map(([rate, s]) => (
                      <div key={rate} className="mb-1.5 pl-2 border-l-2 border-black/[0.06]">
                        <div className="text-zinc-400 mb-0.5" style={{ fontSize: "0.6rem" }}>
                          @{rate}% on {fmt(s.taxable)}
                        </div>
                        {isInter ? (
                          <div className="flex justify-between">
                            <span className="text-purple-500 font-medium" style={{ fontSize: "0.72rem" }}>IGST {rate}%</span>
                            <span className="text-zinc-900" style={{ fontSize: "0.72rem" }}>{fmt(s.igst || s.cgst + s.sgst)}</span>
                          </div>
                        ) : (
                          <>
                            <div className="flex justify-between">
                              <span className="text-blue-500 font-medium" style={{ fontSize: "0.72rem" }}>CGST {rate / 2}%</span>
                              <span className="text-zinc-900" style={{ fontSize: "0.72rem" }}>{fmt(s.cgst)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-emerald-500 font-medium" style={{ fontSize: "0.72rem" }}>SGST {rate / 2}%</span>
                              <span className="text-zinc-900" style={{ fontSize: "0.72rem" }}>{fmt(s.sgst)}</span>
                            </div>
                          </>
                        )}
                        {s.cess > 0 && (
                          <div className="flex justify-between">
                            <span className="text-zinc-500 font-medium" style={{ fontSize: "0.72rem" }}>Cess</span>
                            <span className="text-zinc-900" style={{ fontSize: "0.72rem" }}>{fmt(s.cess)}</span>
                          </div>
                        )}
                      </div>
                    ));
                  })()}
                  {/* Total tax line if multiple slabs */}
                  {calcResult.lines.length > 0 && new Set(calcResult.lines.map(l => l.gstRate)).size > 1 && (
                    <div className="flex justify-between pt-1 border-t border-black/[0.04]">
                      <span className="text-zinc-500 font-medium" style={{ fontSize: "0.72rem" }}>Total Tax</span>
                      <span className="text-zinc-900 font-semibold" style={{ fontSize: "0.72rem" }}>
                        {fmt(isInter ? calcResult.igstAmount : calcResult.cgstAmount + calcResult.sgstAmount)}
                      </span>
                    </div>
                  )}
                </div>
                {calcResult.roundOff !== 0 && (
                  <div className="flex justify-between"><span className="text-zinc-600" style={{ fontSize: "0.75rem" }}>Round Off</span><span className="text-zinc-600" style={{ fontSize: "0.75rem" }}>{fmt(calcResult.roundOff)}</span></div>
                )}
                <div className="border-t border-black/[0.06] pt-2 mt-2">
                  <div className="flex justify-between">
                    <span className="text-amber-400 font-medium" style={{ fontSize: "0.9rem" }}>Grand Total</span>
                    <span className="text-amber-400 font-bold" style={{ fontSize: "1.1rem" }}>{fmt(calcResult.grandTotal)}</span>
                  </div>
                </div>
                    </>
                  );
                })()}
              </div>
            ) : (
              <div className="text-center py-8 text-zinc-500" style={{ fontSize: "0.8rem" }}>
                Select a party and add products to see live calculation
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Order History */}
      <div className="mt-10" id="order-history">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <ClipboardList className="h-5 w-5 text-amber-600" />
            <h2 className="text-xl font-semibold text-zinc-900">Order History</h2>
            <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-600">
              {loadedOrderCount} orders
            </span>
          </div>

            {(ordersLoading || pendingOrdersLoading || approvedOrdersLoading) ? (
              <div className="flex items-center justify-center py-12 text-sm text-zinc-500">
                <Loader2 className="mr-2 h-5 w-5 animate-spin text-amber-600" /> Loading orders...
              </div>
            ) : orders.length === 0 && pendingOrders.length === 0 && approvedOrders.length === 0 ? (
              <div className={`${cardClass} p-10 text-center text-sm text-zinc-500`}>
                No orders yet. Create your first order above.
              </div>
            ) : (
              <div className="space-y-3">
                {/* Staff dropdown filter */}
                {allUsers.length > 0 && (
                  <div className="flex items-center gap-3">
                    <Users className="h-4 w-4 text-zinc-400 shrink-0" />
                    <div ref={creatorPickerRef} className="relative flex-1 max-w-xs">
                      {(() => {
                        // Native <select> popups can't be capped at "5 rows then
                        // scroll" (esp. in Android WebView, where they become an OS
                        // dialog). This custom dropdown shows exactly 5 rows and
                        // scrolls the full list to the very end.
                        const staffOptions = [
                          { id: "", label: `All Staff (${pendingOrdersForCounts.length} pending)` },
                          ...allUsers.map(user => {
                            const downlineIds = new Set(getDownlineIds(user.id));
                            const count = pendingOrdersForCounts.filter(
                              o => o.created_by && downlineIds.has(o.created_by),
                            ).length;
                            return {
                              id: user.id,
                              label: `${user.name}${user.role ? ` (${user.role})` : ""} — ${count} pending order${count !== 1 ? "s" : ""}`,
                            };
                          }),
                        ];
                        const activeLabel = staffOptions.find(o => o.id === (selectedCreator || ""))?.label ?? staffOptions[0].label;
                        return (
                          <>
                            <button
                              type="button"
                              onClick={() => setCreatorPickerOpen(o => !o)}
                              className={`${inputClass} appearance-none pr-9 flex items-center text-left`}
                            >
                              <span className="truncate">{activeLabel}</span>
                            </button>
                            <ChevronDown className={`pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400 transition-transform ${creatorPickerOpen ? "rotate-180" : ""}`} />
                            {creatorPickerOpen && (
                              <div
                                className="absolute left-0 right-0 top-full z-50 mt-1 max-h-[220px] overflow-y-auto overscroll-contain rounded-xl border border-zinc-200 bg-white shadow-lg"
                                style={{ WebkitOverflowScrolling: "touch" }}
                              >
                                {staffOptions.map(opt => {
                                  const isActive = (selectedCreator || "") === opt.id;
                                  return (
                                    <button
                                      key={opt.id || "__all__"}
                                      type="button"
                                      onClick={() => {
                                        setSelectedCreator(opt.id || null);
                                        setCreatorPickerOpen(false);
                                      }}
                                      className={`flex h-11 w-full items-center justify-between gap-2 px-3.5 text-left text-sm transition ${isActive ? "bg-amber-50 font-semibold text-amber-700" : "text-zinc-700 hover:bg-zinc-50"}`}
                                    >
                                      <span className="truncate">{opt.label}</span>
                                      {isActive && <Check className="h-4 w-4 shrink-0 text-amber-600" />}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </div>
                    {selectedCreator && (
                      <button
                        onClick={() => setSelectedCreator(null)}
                        className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-zinc-500 transition hover:border-zinc-300 hover:text-zinc-700"
                        style={{ fontSize: "0.75rem" }}
                      >
                        <X className="h-3 w-3" /> Clear
                      </button>
                    )}
                  </div>
                )}

              {/* Three sections: PENDING, APPROVED, CANCELLED. An order is "approved"
                  once it passes approval — that includes everything in the fulfillment
                  pipeline (procurement → dispatched → delivered), so those all live
                  under the Approved bucket rather than getting their own sections. */}
              {([
                { status: "PENDING", matchStatuses: ["PENDING"], label: "Pending Orders", borderColor: "border-amber-200", accentBar: "border-l-amber-400", headerBg: "bg-amber-50", headerText: "text-amber-700", dotColor: "bg-amber-400", emptyText: "No pending orders" },
                { status: "APPROVED", matchStatuses: ["APPROVED", "PROCUREMENT", "IN_PROCUREMENT", "DISPATCHED", "DELIVERED"], label: "Approved Orders", borderColor: "border-emerald-200", accentBar: "border-l-emerald-400", headerBg: "bg-emerald-50", headerText: "text-emerald-700", dotColor: "bg-emerald-400", emptyText: "No approved orders" },
                { status: "CANCELLED", matchStatuses: ["CANCELLED"], label: "Cancelled Orders", borderColor: "border-red-200", accentBar: "border-l-red-300", headerBg: "bg-red-50", headerText: "text-red-700", dotColor: "bg-red-400", emptyText: "No cancelled orders" },
              ] as const).map(section => {
	                // APPROVED unions the dedicated approvedOrders fetch with any
	                // approved-or-beyond orders from the main list (deduped by id).
	                const sourceList = section.status === "APPROVED"
	                  ? dedupeOrders([...approvedOrders, ...orders]
	                      .filter(o => (section.matchStatuses as readonly string[]).includes(getOrderStatus(o))))
	                  : section.status === "PENDING"
	                    ? pendingOrdersForCounts
	                    : orders.filter(o => (section.matchStatuses as readonly string[]).includes(getOrderStatus(o)));
                const sectionOrders = filteredByCreator(sourceList);
                // The Approved bucket gets its own search / date / salesman filters.
                const isApprovedSection = section.status === "APPROVED";
                const isCollapsed = collapsedSections.has(section.status);
                const displayOrders = isApprovedSection ? applyApprovedFilters(sectionOrders) : sectionOrders;
              return (
                <div key={section.status} className={`rounded-xl border border-l-4 ${section.borderColor} ${section.accentBar} bg-white shadow-sm overflow-hidden`}>
                  {/* Section header — click anywhere to collapse/expand */}
                  <button
                    type="button"
                    onClick={() => toggleSection(section.status)}
                    aria-expanded={!isCollapsed}
                    className={`flex w-full items-center justify-between px-4 py-2 ${section.headerBg} border-b ${section.borderColor} ${isCollapsed ? "border-b-0" : ""} transition hover:brightness-[0.98]`}
                  >
                    <div className="flex items-center gap-2">
                      <ChevronRight className={`h-4 w-4 ${section.headerText} transition-transform duration-200 ${isCollapsed ? "" : "rotate-90"}`} />
                      <span className={`h-1.5 w-1.5 rounded-full ${section.dotColor} ring-[3px] ring-white/70`} />
                      <h3 className={`text-[0.82rem] font-bold tracking-tight uppercase ${section.headerText}`}>{section.label}</h3>
                    </div>
                    <span className={`inline-flex items-center justify-center min-w-[1.6rem] rounded-full bg-white/70 border ${section.borderColor} px-2 py-0.5 text-xs font-bold ${section.headerText}`}>
                      {isApprovedSection && approvedFiltersActive
                        ? `${displayOrders.length} / ${sectionOrders.length}`
                        : displayOrders.length}
                    </span>
                  </button>

                  {/* Approved Orders filter bar: search + date range + salesman group */}
                  {isApprovedSection && !isCollapsed && (
                    <div className="border-b border-emerald-100 bg-emerald-50/40 px-4 py-3 space-y-2.5">
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                        <input
                          type="text"
                          value={approvedSearch}
                          onChange={(e) => setApprovedSearch(e.target.value)}
                          placeholder="Search by order no. or party name…"
                          className="w-full rounded-lg border border-emerald-200 bg-white pl-9 pr-3 py-2 text-xs text-zinc-900 placeholder:text-zinc-400 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
                        />
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[0.62rem] font-semibold uppercase tracking-wide text-zinc-400">From</span>
                          <input
                            type="date"
                            value={approvedDateFrom}
                            max={approvedDateTo || undefined}
                            onChange={(e) => setApprovedDateFrom(e.target.value)}
                            className="rounded-lg border border-emerald-200 bg-white px-2 py-1.5 text-xs text-zinc-900 outline-none focus:border-emerald-400"
                          />
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[0.62rem] font-semibold uppercase tracking-wide text-zinc-400">To</span>
                          <input
                            type="date"
                            value={approvedDateTo}
                            min={approvedDateFrom || undefined}
                            onChange={(e) => setApprovedDateTo(e.target.value)}
                            className="rounded-lg border border-emerald-200 bg-white px-2 py-1.5 text-xs text-zinc-900 outline-none focus:border-emerald-400"
                          />
                        </div>
                        {groupSalesmen.length > 0 && (
                          <div className="relative">
                            <select
                              value={approvedSalesmanId}
                              onChange={(e) => setApprovedSalesmanId(e.target.value)}
                              className="appearance-none rounded-lg border border-emerald-200 bg-white pl-3 pr-8 py-1.5 text-xs text-zinc-900 outline-none focus:border-emerald-400"
                            >
                              <option value="">All salesmen</option>
                              {[...groupSalesmen]
                                .sort((a, b) => a.name.localeCompare(b.name))
                                .map((sm) => (
                                  <option key={sm.id} value={sm.id}>
                                    {sm.name} — {salesmanApprovedCounts[sm.id] || 0}
                                  </option>
                                ))}
                            </select>
                            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                          </div>
                        )}
                        {approvedFiltersActive && (
                          <button
                            onClick={clearApprovedFilters}
                            className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-[0.7rem] text-zinc-500 transition hover:border-zinc-300 hover:text-zinc-700"
                          >
                            <X className="h-3 w-3" /> Clear
                          </button>
                        )}
                      </div>
                      {approvedSalesmanId && (
                        <p className="text-[0.68rem] text-emerald-700">
                          Showing only parties handled by{" "}
                          <span className="font-semibold">
                            {groupSalesmen.find((s) => s.id === approvedSalesmanId)?.name || "this salesman"}
                          </span>
                        </p>
                      )}
                    </div>
                  )}

                  {!isCollapsed && (displayOrders.length === 0 ? (
                    <div className="px-4 py-5 text-center text-xs text-zinc-400">
                      {isApprovedSection && approvedFiltersActive
                        ? "No approved orders match your filters"
                        : section.emptyText}
                    </div>
                  ) : (
                        <div className="divide-y divide-zinc-100 max-h-[440px] overflow-y-auto">
                        {displayOrders.map(order => {
                        const isExpanded = expandedOrder === order.id;
                        const isEditing = editingOrderId === order.id;
                        const isPending = section.status === "PENDING";
                        // Self-placed = the creator belongs to the same party the order is billed to.
                        const isSelfPlaced = !!order.created_by && !!order.buyer?.id && creatorPartyIds[order.created_by] === order.buyer.id;
                        // Discounted orders get a distinct emerald treatment so they're easy to spot.
                        const grossTotal = (order.order_items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.unit_price) || 0), 0);
                        const discountSaved = orderDiscountSaved(order);
                        const hasDiscount = discountSaved > 0;
                        const discountPct = hasDiscount && grossTotal > 0 ? Math.round((discountSaved / grossTotal) * 100) : 0;
                        return (
                          <div key={order.id}>
                            <div className={`flex items-center gap-3 px-4 py-2.5 transition ${hasDiscount ? "bg-emerald-50/60 border-l-2 border-emerald-400 hover:bg-emerald-50" : isSelfPlaced ? "bg-violet-50/60 border-l-2 border-violet-400 hover:bg-violet-50" : "hover:bg-zinc-50/60"}`}>
                              {/* Clickable expand area */}
                              <div
                                className="flex-1 min-w-0 space-y-1 cursor-pointer"
                                onClick={(e) => { e.stopPropagation(); setExpandedOrder(isExpanded ? null : order.id); }}
                              >
                                {/* Top line: order-number pill + date + status badges */}
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="inline-flex items-center rounded-md bg-zinc-100 px-2 py-0.5 font-mono font-semibold tracking-tight text-zinc-600" style={{ fontSize: "0.76rem" }}>{order.order_number}</span>
                                  <span className="text-zinc-400" style={{ fontSize: "0.78rem" }}>{new Date(order.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</span>
                                  {section.status === "APPROVED" && (() => {
                                    const stage = orderStageMeta(order);
                                    return (
                                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full border ${stage.className}`} style={{ fontSize: "0.7rem", fontWeight: 700 }}>
                                        {stage.label}
                                      </span>
                                    );
                                  })()}
                                  {isSelfPlaced && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 border border-violet-200" style={{ fontSize: "0.7rem", fontWeight: 700 }}>
                                      <Users className="w-3 h-3" />
                                      Self-ordered
                                    </span>
                                  )}
                                </div>
                                {/* Headline: party / buyer name */}
                                <div className="text-zinc-900 font-semibold truncate leading-snug" style={{ fontSize: "0.9rem" }}>{order.buyer?.name || "—"}</div>
                                {/* Meta: item count · net weight · placed by */}
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-zinc-500" style={{ fontSize: "0.74rem" }}>
                                  <span className="inline-flex items-center gap-1"><Package className="w-3.5 h-3.5 text-zinc-400" />{(order.order_items || []).length} item{(order.order_items || []).length !== 1 ? "s" : ""}</span>
                                  {(() => { const w = orderNetWeight(order); return w > 0 ? (<><span className="text-zinc-300">·</span><span>{w.toFixed(1)} kg</span></>) : null; })()}
                                  {order.created_by && creatorNames[order.created_by] && (<><span className="text-zinc-300">·</span><span className="inline-flex items-center gap-1"><Users className="w-3.5 h-3.5 text-zinc-400" />{creatorNames[order.created_by]}</span></>)}
                                </div>
                    {hasDiscount && (
                                      <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-200" style={{ fontSize: "0.78rem", fontWeight: 700 }}>
                                        <Percent className="w-3 h-3" />
                                        Saved {fmt(discountSaved)}{discountPct > 0 ? ` · ${discountPct}% off` : ""}
                                      </div>
                                    )}
                    {order.notes && (
                                      <div className="text-amber-600/80 truncate flex items-center gap-1" style={{ fontSize: "0.82rem" }}>
                                        <FileText className="w-3.5 h-3.5 shrink-0" />
                                        <span className="truncate">{order.notes}</span>
                                      </div>
                                    )}
                                    {order.status === "APPROVED" && order.approved_by && creatorNames[order.approved_by] && (
                                      <div className="text-emerald-600/80 truncate flex items-center gap-1" style={{ fontSize: "0.82rem" }}>
                                        <Check className="w-3.5 h-3.5 shrink-0" />
                                        <span className="truncate">Approved by {creatorNames[order.approved_by]}</span>
                                      </div>
                                    )}
                                    {section.status === "APPROVED" && (() => {
                                      const summary = approvals[order.id];
                                      if (summary?.status === "APPROVED") {
                                        return (
                                          <div className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200 px-2.5 py-1 mt-0.5" style={{ fontSize: "0.75rem", fontWeight: 700 }}>
                                            <Check className="w-3 h-3" />Confirmed by {summary.approved_name || "party"}
                                          </div>
                                        );
                                      }
                                      if (summary?.has_active_link) {
                                        return (
                                          <div className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 border border-amber-200 px-2.5 py-1 mt-0.5" style={{ fontSize: "0.75rem", fontWeight: 700 }}>
                                            <Clock className="w-3 h-3" />Awaiting party · link sent
                                          </div>
                                        );
                                      }
                                      return (
                                        <div className="inline-flex items-center gap-1 rounded-full bg-zinc-100 text-zinc-500 border border-zinc-200 px-2.5 py-1 mt-0.5" style={{ fontSize: "0.75rem", fontWeight: 700 }}>
                                          Not sent to party
                                        </div>
                                      );
                                    })()}
                                  </div>

                              {/* Amount — the number people scan for */}
                              <div className="text-right shrink-0">
                                {hasDiscount && (
                                  <div className="text-zinc-400 line-through leading-none mb-0.5" style={{ fontSize: "0.7rem" }}>{fmt(grossTotal)}</div>
                                )}
                                <div className="font-bold tabular-nums text-zinc-900 leading-tight" style={{ fontSize: "1.05rem" }}>{fmt(Number(order.grand_total))}</div>
                              </div>

                              {/* Edit button - only for PENDING orders */}
                              {isPending && !isEditing && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); startEditOrder(order); }}
                                  className="flex items-center gap-1 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-amber-700 transition hover:bg-amber-100 shrink-0"
                                  style={{ fontSize: "0.8rem", fontWeight: 600 }}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                  Edit
                                </button>
                              )}
                              {isEditing && (
                                <div className="flex items-center gap-1 shrink-0">
                                  <button
                                    onClick={(e) => { e.stopPropagation(); saveEditOrder(order.id); }}
                                    disabled={editSaving || editItems.length === 0}
                                    className="flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-50"
                                    style={{ fontSize: "0.8rem", fontWeight: 600 }}
                                  >
                                    {editSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                                    Save
                                  </button>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); cancelEdit(); }}
                                    className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-zinc-600 transition hover:bg-zinc-50"
                                    style={{ fontSize: "0.8rem", fontWeight: 600 }}
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              )}

                              {/* Reversal is intentionally available only at the
                                  exact APPROVED stage, never after fulfilment starts. */}
                              {isRoleResolved && !isSalesman && getOrderStatus(order) === "APPROVED" && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); revertOrderApproval(order); }}
                                  disabled={updatingOrderId === order.id}
                                  title="Return this approved order to Pending"
                                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 font-semibold text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                                  style={{ fontSize: "0.8rem" }}
                                >
                                  {updatingOrderId === order.id
                                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    : <RotateCcw className="h-3.5 w-3.5" />}
                                  <span>Revert</span>
                                </button>
                              )}

                              {/* Status action buttons */}
                              <div className="flex items-center gap-1 shrink-0">
                                {updatingOrderId === order.id
                                  ? <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                                  : ORDER_STATUS_PILLS
                                    .filter((s) => {
                                      const currentStatus = order.status || "PENDING";
                                      // Don't show the button for the current status
                                      if (currentStatus === s) return false;
                                      // Only PENDING orders can be cancelled — once approved
                                      // (or in procurement/dispatched/delivered), no Cancel.
                                      if (s === "CANCELLED" && currentStatus !== "PENDING") return false;
                                      // Only PENDING orders can be approved — hide Approve once past PENDING.
                                      if (s === "APPROVED" && currentStatus !== "PENDING") return false;
                                      // Salesmen cannot approve orders (also enforced server-side).
                                      if (s === "APPROVED" && isSalesman) return false;
                                      // Hide PENDING for non-pending (no going back)
                                      if (s === "PENDING" && currentStatus !== "PENDING") return false;
                                      return true;
                                    })
                                    .map((s) => {
                                      const color =
                                        s === "APPROVED" ? "border-emerald-600 bg-emerald-600 text-white shadow-sm hover:bg-emerald-700 hover:border-emerald-700" :
                                        s === "CANCELLED" ? "border-red-200 text-red-600 hover:bg-red-50 hover:border-red-300" :
                                        "border-amber-300 text-amber-600 hover:bg-amber-50 hover:border-amber-400";
                                      return (
                                        <button
                                          key={s}
                                          onClick={(e) => { e.stopPropagation(); updateOrderStatus(order, s); }}
                                          disabled={updatingOrderId === order.id}
                                          className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border font-semibold transition-all cursor-pointer disabled:opacity-50 ${color}`}
                                          style={{ fontSize: "0.8rem" }}
                                        >
                                          {s === "APPROVED" ? <Check className="w-3.5 h-3.5" /> : s === "CANCELLED" ? <X className="w-3.5 h-3.5" /> : null}
                                          {s === "APPROVED" ? "Approve" : s === "CANCELLED" ? "Cancel" : s}
                                        </button>
                                      );
                                    })
                                }
                              </div>
                              <ChevronRight
                                className={`w-4 h-4 text-zinc-500 shrink-0 transition-transform cursor-pointer ${isExpanded ? "rotate-90" : ""}`}
                                onClick={(e) => { e.stopPropagation(); setExpandedOrder(isExpanded ? null : order.id); }}
                              />
                            </div>

                            {isExpanded && (
                              <div className="border-t border-black/[0.06] px-5 py-4 bg-black/[0.01]">
                                {/* Order meta: created by + when */}
                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3" style={{ fontSize: "0.72rem" }}>
                                  {order.created_by && creatorNames[order.created_by] && (
                                    <div className="flex items-center gap-1.5 text-zinc-600">
                                      <span className="text-zinc-400">Taken by:</span>
                                      <span className="text-zinc-900 font-medium">{creatorNames[order.created_by]}</span>
                                    </div>
                                  )}
                                  <div className="flex items-center gap-1.5 text-zinc-600">
                                    <span className="text-zinc-400">On:</span>
                                    <span className="text-zinc-900 font-medium">
                                      {new Date(order.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                                      {" "}
                                      {new Date(order.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true })}
                                    </span>
                                  </div>
                                </div>

                                {/* Order notes */}
                                {order.notes && (
                                  <div className="mb-3 rounded-lg border border-amber-100 bg-amber-50/40 px-3 py-2" style={{ fontSize: "0.72rem" }}>
                                    <span className="text-zinc-400 font-medium">Note: </span>
                                    <span className="text-zinc-700">{order.notes}</span>
                                  </div>
                                )}

                                {/* EDIT MODE */}
                                {isEditing ? (
                                  <div className="space-y-3">
                                    {editItems.map((item, idx) => (
                                      <div key={`${item.product_id}-${idx}`} className="flex items-center gap-3 p-2.5 rounded-lg border border-amber-200 bg-amber-50/30">
                                        <Package className="w-4 h-4 text-amber-500 shrink-0" />
                                        <div className="flex-1 min-w-0">
                                          <div className="text-zinc-900 font-medium" style={{ fontSize: "0.78rem" }}>{item.name}</div>
                                          <div className="text-zinc-500 font-mono" style={{ fontSize: "0.6rem" }}>{item.sku}</div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                          <div className="flex items-center gap-1">
                                            <button
                                              onClick={() => setEditItems(prev => prev.map((it, i) => i === idx ? { ...it, quantity: Math.max(1, it.quantity - 1) } : it))}
                                              className="rounded border border-zinc-200 bg-white p-1 text-zinc-600 hover:text-zinc-900"
                                            >
                                              <Minus className="h-3 w-3" />
                                            </button>
                                            <input
                                              type="number"
                                              min={1}
                                              value={item.quantity}
                                              onChange={(e) => setEditItems(prev => prev.map((it, i) => i === idx ? { ...it, quantity: Math.max(1, parseInt(e.target.value) || 1) } : it))}
                                              className="w-14 rounded border border-zinc-200 bg-white px-2 py-1 text-center text-sm font-medium text-zinc-900 outline-none focus:border-amber-400"
                                            />
                                            <button
                                              onClick={() => setEditItems(prev => prev.map((it, i) => i === idx ? { ...it, quantity: it.quantity + 1 } : it))}
                                              className="rounded border border-zinc-200 bg-white p-1 text-zinc-600 hover:text-zinc-900"
                                            >
                                              <Plus className="h-3 w-3" />
                                            </button>
                                          </div>
                                          <div className="flex items-center gap-1">
                                            <input
                                              type="number"
                                              min={0}
                                              max={100}
                                              step="0.5"
                                              value={item.discount_percent || 0}
                                              onChange={(e) => { const v = e.target.value; setEditItems(prev => prev.map((it, i) => i === idx ? { ...it, discount_percent: v === "" ? 0 : Math.min(Math.max(parseFloat(v) || 0, 0), 100) } : it)); }}
                                              className="w-14 rounded border border-zinc-200 bg-white px-2 py-1 text-center text-sm font-medium text-zinc-900 outline-none focus:border-amber-400"
                                              title="Discount %"
                                            />
                                            <Percent className="h-3 w-3 text-zinc-400 shrink-0" />
                                          </div>
                                          <div className="text-right" style={{ minWidth: 70 }}>
                                            <div className="text-zinc-700 font-medium" style={{ fontSize: "0.75rem" }}>{fmt(item.unit_price * item.quantity * (1 - (item.discount_percent || 0) / 100))}</div>
                                            <div className="text-zinc-400" style={{ fontSize: "0.6rem" }}>
                                              {fmt(item.unit_price)}/ea{item.discount_percent ? ` · -${item.discount_percent}%` : ""}
                                            </div>
                                          </div>
                                          <button
                                            onClick={() => setEditItems(prev => prev.filter((_, i) => i !== idx))}
                                            className="rounded border border-red-200 bg-white p-1.5 text-red-400 transition hover:bg-red-50 hover:text-red-600"
                                          >
                                            <Trash2 className="h-3.5 w-3.5" />
                                          </button>
                                        </div>
                                      </div>
                                    ))}

                                    {/* Add product dropdown — shows all company products */}
                                    <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50/60 p-3">
                                      <div className="relative">
                                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                                        <input
                                          type="text"
                                          placeholder="Select or search a product to add..."
                                          value={editProductSearch}
                                          onChange={(e) => { setEditProductSearch(e.target.value); setEditProductOpen(true); }}
                                          onFocus={() => setEditProductOpen(true)}
                                          onBlur={() => setTimeout(() => setEditProductOpen(false), 150)}
                                          className="w-full rounded-lg border border-zinc-200 bg-white pl-8 pr-8 py-2 text-sm text-zinc-900 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
                                        />
                                        <ChevronDown className={`pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400 transition-transform ${editProductOpen ? "rotate-180" : ""}`} />
                                      </div>
                                      {editProductOpen && (() => {
                                        // Prefer the freshly-fetched edit list, but fall back to the
                                        // main company products (loaded on mount) so the dropdown always
                                        // reflects the company's catalog even if the edit fetch is empty.
                                        const sourceProducts = editProducts.length > 0 ? editProducts : products;
                                        const available = sourceProducts.filter(p => !editItems.some(ei => ei.product_id === p.id));
                                        const q = editProductSearch.trim().toLowerCase();
                                        const matches = q
                                          ? available.filter(p => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q))
                                          : available;
                                        return (
                                          <div className="mt-2 max-h-56 overflow-y-auto space-y-1">
                                            {matches.map(p => (
                                              <button
                                                key={p.id}
                                                onMouseDown={(e) => e.preventDefault()}
                                                onClick={() => {
                                                  const price = Number(p.effective_price ?? p.base_price ?? 0);
                                                  setEditItems(prev => [...prev, {
                                                    product_id: p.id,
                                                    name: p.name,
                                                    sku: p.sku,
                                                    quantity: 1,
                                                    unit_price: Number.isFinite(price) ? price : 0,
                                                    discount_percent: 0,
                                                  }]);
                                                  setEditProductSearch("");
                                                }}
                                                className="flex items-center gap-2 w-full rounded-lg border border-zinc-200 bg-white p-2 text-left transition hover:border-amber-300 hover:bg-amber-50/50"
                                              >
                                                <Plus className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                                                <div className="min-w-0 flex-1">
                                                  <div className="text-zinc-900 truncate" style={{ fontSize: "0.75rem" }}>{p.name}</div>
                                                  <div className="text-zinc-500" style={{ fontSize: "0.6rem" }}>{p.sku} | {fmt(Number(p.effective_price ?? p.base_price))}/{p.unit_of_measure}</div>
                                                </div>
                                              </button>
                                            ))}
                                            {matches.length === 0 && (
                                              <p className="text-center text-zinc-400 py-2" style={{ fontSize: "0.72rem" }}>
                                                {sourceProducts.length === 0
                                                  ? "Loading products…"
                                                  : available.length === 0
                                                    ? "All products already added"
                                                    : "No products found"}
                                              </p>
                                            )}
                                          </div>
                                        );
                                      })()}
                                    </div>

                                    {/* Edit total */}
                                    <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2">
                                      <span className="text-zinc-600 font-medium" style={{ fontSize: "0.75rem" }}>New Total ({editItems.length} items)</span>
                                      <span className="text-amber-700 font-bold" style={{ fontSize: "0.9rem" }}>{fmt(editItems.reduce((s, i) => s + i.quantity * i.unit_price * (1 - (i.discount_percent || 0) / 100), 0))}</span>
                                    </div>
                                  </div>
                                ) : (
                                  /* VIEW MODE */
                                  <div className="space-y-2">
                                    {(order.order_items || []).map(item => {
                                      const gross = Number(item.unit_price) * item.quantity;
                                      const net = Number(item.line_total ?? gross);
                                      const hasDiscount = net < gross - 0.001;
                                      return (
                                      <div key={item.id} className="flex items-center gap-3 p-2.5 rounded-lg border border-black/[0.04] bg-black/[0.02]">
                                        <Package className="w-4 h-4 text-amber-400/60 shrink-0" />
                                        <div className="flex-1 min-w-0">
                                          <div className="text-zinc-900" style={{ fontSize: "0.78rem" }}>{item.products?.name || "—"}</div>
                                          <div className="text-zinc-500 font-mono" style={{ fontSize: "0.6rem" }}>{item.products?.sku}</div>
                                        </div>
                                        <div className="text-right">
                                          <div className="text-zinc-700" style={{ fontSize: "0.78rem" }}>Qty: {item.quantity}</div>
                                          <div className="text-zinc-500" style={{ fontSize: "0.65rem" }}>{fmt(Number(item.unit_price))} each</div>
                                          {hasDiscount && (
                                            <div className="text-emerald-600" style={{ fontSize: "0.6rem" }}>
                                              Disc -{fmt(gross - net)} → {fmt(net)}
                                            </div>
                                          )}
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
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

    </div>
  );
}
