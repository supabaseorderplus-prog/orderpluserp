"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { api, getUser, getModulePermission, setActiveCompany, getActiveCompany } from "@/lib/api";
import { validateRequiredCoordinates } from "@/lib/location-coordinates";
import {
  Building2, ChevronRight, Filter, Loader2, Plus, Search, X,
  Eye, EyeOff, CreditCard, Tag, Check, KeyRound, Smartphone,
  MapPin, Navigation, Map as MapIcon, Ruler, ExternalLink, Trash2, Wallet,
  ShieldCheck, Shield, ClipboardList, CheckCircle, MessageSquare, Upload, FileText, Pencil,
  Receipt, Layers3, Zap, Users, Truck,
} from "lucide-react";
import VendorsPanel from "./VendorsPanel";

interface Party {
  id: string;
  party_code: string;
  name: string;
  trade_name: string | null;
  gstin: string | null;
  city: string;
  credit_limit: number;
  contact_person: string | null;
  phone: string | null;
  portal_phone?: string | null;
  contact_email: string | null;
  contact_aadhaar_url: string | null;
  party_types: { name: string } | null;
  opening_balance: number;
  wallet_balance: number;
  current_balance?: number;

  address_line1: string | null;
  pin_code: string | null;
  salesman: { id: string; name: string } | null;
  salesman_id: string | null;
  party_type_id: string | null;
  price_list_id: string | null;
  default_tax_template_id: string | null;
  latitude: number | null;
  longitude: number | null;
  is_verified: boolean | null;
  verified_at: string | null;
  verified_by: string | null;
  verifier: { id: string; name: string } | null;
}

interface Group { id: string; name: string; code: string | null; salesman_id: string | null; salesman_name: string | null; member_count: number; member_ids?: string[]; }
interface PriceList { id: string; name: string; code: string; applicable_party_type: string | null; is_current: boolean; }
interface Pagination { page: number; limit: number; total: number; pages: number; }

// Per-page fetch size for the progressive list loader. Keep well under ~150 —
// the API passes the page's party IDs into a PostgREST .in() filter and large
// batches would overflow the request URL (see src/lib/supabase-in-chunks.ts).
const PAGE_SIZE = 50;

const partyTypeColors: Record<string, string> = {
  COMPANY: "bg-amber-500/20 text-amber-400",
  MANUFACTURER: "bg-red-500/20 text-red-400",
  CNF: "bg-blue-500/20 text-blue-400",
  SUPER_DEALER: "bg-purple-500/20 text-purple-400",
  RETAILER: "bg-emerald-500/20 text-emerald-400",
};

const inp = "w-full px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-amber-500/40";
const sel = "w-full px-3 py-2 rounded-lg border border-black/10 bg-[#ffffff] text-zinc-900 outline-none focus:border-amber-500/40";
const is: React.CSSProperties = { fontSize: "0.8rem", fontFamily: "inherit" };
const lbl: React.CSSProperties = { fontSize: "0.75rem", display: "block", marginBottom: "0.25rem", color: "#a1a1aa" };

const emptyForm = {
  name: "", trade_name: "", party_type_id: "", gstin: "", pan: "",
  address_line1: "", city: "", pin_code: "",
  contact_person: "", contact_phone: "", contact_email: "",
  credit_limit: "0", payment_terms_days: "21",
  group_id: "", portal_phone: "", portal_password: "",
  parent_party_id: "", latitude: "", longitude: "",
  contact_aadhaar_url: "",
  opening_balance: "0",
};

export default function PartiesPage() {
  const router = useRouter();

  const [parties, setParties] = useState<Party[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: PAGE_SIZE, total: 0, pages: 0 });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const fetchGenRef = useRef(0);
  const [noCompanyScope, setNoCompanyScope] = useState(false);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  // Group filter — narrows the loaded list to one group's member parties.
  // Membership comes from the company-scoped /groups/[id] endpoint (works in
  // both the real-schema and company_notes fallback storage modes), so it is
  // applied client-side on top of the server-side search/type/verification filters.
  const [groupFilter, setGroupFilter] = useState("");
  const [groupMemberIds, setGroupMemberIds] = useState<Set<string>>(new Set());
  const [groupFilterLoading, setGroupFilterLoading] = useState(false);

  // Create modal
  // Parties vs Vendors toggle. Vendors (creditors/debtors) are a separate module
  // rendered by <VendorsPanel/> — see VendorsPanel.tsx.
  const [viewMode, setViewMode] = useState<"parties" | "vendors">("parties");
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [showPortalPassword, setShowPortalPassword] = useState(false);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsError, setGpsError] = useState("");
  const [submitAttempted, setSubmitAttempted] = useState(false);

  // Mobile-number duplicate lookup — a mobile number uniquely identifies one party
  // within the company, so as the user types we search this company's parties for an
  // existing registration and block creation if one is found.
  const [phoneChecking, setPhoneChecking] = useState(false);
  const [phoneMatch, setPhoneMatch] = useState<Party | null>(null);
  // Remembers the digits we last hit the API for, so re-runs caused only by the
  // parties list growing during paging don't fire a redundant network round-trip.
  const phoneCheckedRef = useRef("");

  // View modal
  const [viewParty, setViewParty] = useState<Party | null>(null);

  // Edit modal
  const [editParty, setEditParty] = useState<Party | null>(null);
  const [editForm, setEditForm] = useState({ name: "", trade_name: "", gstin: "", address_line1: "", city: "", pin_code: "", contact_person: "", contact_phone: "", contact_email: "", credit_limit: "0", group_id: "" });
  const [editGroupOpen, setEditGroupOpen] = useState(false);
  const [editGroupSearch, setEditGroupSearch] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState("");

  // Party password modal
  const [passwordParty, setPasswordParty] = useState<Party | null>(null);
  const [passwordForm, setPasswordForm] = useState({ phone: "", new_password: "", confirm_password: "" });
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);

  // Meta lists
  const [partyTypes, setPartyTypes] = useState<{ id: string; name: string }[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupSearch, setGroupSearch] = useState("");
  const [groupOpen, setGroupOpen] = useState(false);
  const [parentParties, setParentParties] = useState<{ id: string; name: string; party_code: string }[]>([]);
  const [parentLoading, setParentLoading] = useState(false);
  const [retailerParentType, setRetailerParentType] = useState<"SUPER_DEALER" | "CNF" | "COMPANY">("SUPER_DEALER");
  const [sdParentType, setSdParentType] = useState<"CNF" | "COMPANY">("CNF");

  // Pricing modal
  const [pricingParty, setPricingParty] = useState<Party | null>(null);
  const [priceLists, setPriceLists] = useState<PriceList[]>([]);
  const [priceListsLoading, setPriceListsLoading] = useState(false);
  const [savingPrice, setSavingPrice] = useState(false);
  const [selectedPriceListId, setSelectedPriceListId] = useState<string | null>(null);

  // Tax template modal
  const [taxParty, setTaxParty] = useState<Party | null>(null);
  const [taxTemplates, setTaxTemplates] = useState<{ id: string; product_name: string; gst_rate: number }[]>([]);
  const [taxTemplatesLoading, setTaxTemplatesLoading] = useState(false);
  const [selectedTaxTemplateId, setSelectedTaxTemplateId] = useState<string | null>(null);
  const [savingTax, setSavingTax] = useState(false);
  const [taxError, setTaxError] = useState("");
  const [migrationSql, setMigrationSql] = useState("");

  // Map modal
  const [mapParty, setMapParty] = useState<Party | null>(null);
  const [myLocation, setMyLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [myLocLoading, setMyLocLoading] = useState(false);
  const [distance, setDistance] = useState<string | null>(null);
  const [mapSaveLoading, setMapSaveLoading] = useState(false);
  const [mapSaveError, setMapSaveError] = useState("");
  const [manualLat, setManualLat] = useState("");
  const [manualLng, setManualLng] = useState("");

  // Aadhaar upload
  const [aadhaarFile, setAadhaarFile] = useState<File | null>(null);
  const [aadhaarUploading, setAadhaarUploading] = useState(false);
  const [aadhaarError, setAadhaarError] = useState("");

  // Delete
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Verification
  const [verificationTab, setVerificationTab] = useState<"unverified" | "verified">("verified");
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [visitModalParty, setVisitModalParty] = useState<Party | null>(null);
  const [visitLogs, setVisitLogs] = useState<{ id: string; visitor_name: string; visit_date: string; notes: string | null }[]>([]);
  const [visitLogsLoading, setVisitLogsLoading] = useState(false);
  const [addingVisitId, setAddingVisitId] = useState<string | null>(null);
  const [visitNote, setVisitNote] = useState("");
  const currentUser = getUser();
  const isSuperAdmin = currentUser?.role === "SUPER_ADMIN";
  const isAdminUser = currentUser?.role === "ADMIN";
  const canManagePartyPasswords = isSuperAdmin || isAdminUser;
  const isSalesman = currentUser?.role === "SALESMAN";

  // Per-party invoice-approval kill switch. We only track which parties have
  // approval DISABLED (auto-generate) — approval is the default for everyone else.
  const [autoInvoiceParties, setAutoInvoiceParties] = useState<Set<string>>(new Set());
  const [togglingApprovalId, setTogglingApprovalId] = useState<string | null>(null);

  // Opening balance modal
  const [obParty, setObParty] = useState<Party | null>(null);
  const [obValue, setObValue] = useState("0");
  const [obSaving, setObSaving] = useState(false);
  const [obError, setObError] = useState("");

  // Company picker (for Super Admin when no company is selected)
  const [companies, setCompanies] = useState<{ id: string; name: string; party_code: string; city: string }[]>([]);
  const [companiesLoading, setCompaniesLoading] = useState(false);

  // Permissions
  const [perms, setPerms] = useState({ can_view: true, can_create: false, can_edit: false, can_delete: false });
  const [vendorPerms, setVendorPerms] = useState({ can_view: false, can_create: false, can_edit: false, can_delete: false, can_approve: false });
  useEffect(() => { getModulePermission("parties").then(setPerms); }, []);
  useEffect(() => { getModulePermission("vendors").then(setVendorPerms); }, []);

  // Load companies list when super admin has no company selected
  useEffect(() => {
    if (!noCompanyScope) return;
    setCompaniesLoading(true);
    // First get the COMPANY type ID, then fetch parties of that type
    api<{ success: boolean; data: { id: string; name: string }[] }>("/api/v1/party-types")
      .then((res) => {
        const companyTypeId = (res.data || []).find(pt => pt.name === "COMPANY")?.id;
        if (!companyTypeId) { setCompanies([]); setCompaniesLoading(false); return; }
        return api<{ success: boolean; data: { id: string; name: string; party_code: string; city: string }[] }>(`/api/v1/parties?party_type=${companyTypeId}&limit=100`);
      })
      .then((res) => res && setCompanies(res.data || []))
      .catch(() => setCompanies([]))
      .finally(() => setCompaniesLoading(false));
  }, [noCompanyScope]);

  // ── helpers ────────────────────────────────────────────────────────────────
  const fmt = (n: number) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

  function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function openMapModal(party: Party) {
    setMapParty(party);
    setDistance(null);
    setMyLocation(null);
    setMapSaveError("");
    setManualLat(party.latitude != null ? String(party.latitude) : "");
    setManualLng(party.longitude != null ? String(party.longitude) : "");
  }

  function measureDistance() {
    if (!mapParty?.latitude || !mapParty?.longitude) return;
    setMyLocLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: mlat, longitude: mlng } = pos.coords;
        setMyLocation({ lat: mlat, lng: mlng });
        const km = haversineKm(mlat, mlng, mapParty.latitude!, mapParty.longitude!);
        setDistance(km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);
        setMyLocLoading(false);
      },
      () => setMyLocLoading(false),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  function captureMyLocationForParty() {
    if (!mapParty) return;
    setMapSaveError("");
    setMyLocLoading(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = Number(pos.coords.latitude.toFixed(6));
        const lng = Number(pos.coords.longitude.toFixed(6));
        setMyLocation({ lat, lng });
        setMyLocLoading(false);
        setMapSaveLoading(true);
        try {
          await api(`/api/v1/parties/${mapParty.id}`, { method: "PUT", body: { latitude: lat, longitude: lng } });
          setParties(prev => prev.map(p => p.id === mapParty.id ? { ...p, latitude: lat, longitude: lng } : p));
          setMapParty(prev => prev ? { ...prev, latitude: lat, longitude: lng } : prev);
        } catch (err) {
          setMapSaveError(err instanceof Error ? err.message : "Failed to save location");
        } finally {
          setMapSaveLoading(false);
        }
      },
      () => {
        setMyLocLoading(false);
        setMapSaveError("Unable to get your location. Allow location permission or enter coordinates manually below.");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  async function saveManualLocation() {
    if (!mapParty) return;
    const lat = Number(manualLat);
    const lng = Number(manualLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setMapSaveError("Enter valid numeric latitude and longitude.");
      return;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      setMapSaveError("Latitude must be -90..90 and longitude must be -180..180.");
      return;
    }

    setMapSaveError("");
    setMapSaveLoading(true);
    try {
      await api(`/api/v1/parties/${mapParty.id}`, { method: "PUT", body: { latitude: Number(lat.toFixed(6)), longitude: Number(lng.toFixed(6)) } });
      const normalizedLat = Number(lat.toFixed(6));
      const normalizedLng = Number(lng.toFixed(6));
      setParties(prev => prev.map(p => p.id === mapParty.id ? { ...p, latitude: normalizedLat, longitude: normalizedLng } : p));
      setMapParty(prev => prev ? { ...prev, latitude: normalizedLat, longitude: normalizedLng } : prev);
      setMyLocation({ lat: normalizedLat, lng: normalizedLng });
    } catch (err) {
      setMapSaveError(err instanceof Error ? err.message : "Failed to save location");
    } finally {
      setMapSaveLoading(false);
    }
  }

  async function handleAadhaarUpload(file: File) {
    setAadhaarError("");
    if (!file) return;

    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (!allowedTypes.includes(file.type)) {
      setAadhaarError("Only JPEG, PNG, WebP, or PDF files allowed.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setAadhaarError("File too large. Max 5MB.");
      return;
    }

    setAadhaarUploading(true);
    try {
      const formData = new FormData();
      formData.append("aadhaar", file);

      const token = typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;
      const companyId = typeof window !== "undefined" ? localStorage.getItem("activeCompanyId") : null;

      const res = await fetch("/api/v1/upload/aadhaar", {
        method: "POST",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(companyId ? { "x-company-id": companyId } : {}),
        },
        body: formData,
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setAadhaarError(json.message || "Upload failed");
        return;
      }
      setForm(f => ({ ...f, contact_aadhaar_url: json.data.url }));
      setAadhaarFile(file);
    } catch {
      setAadhaarError("Upload failed. Try again.");
    } finally {
      setAadhaarUploading(false);
    }
  }

  function removeAadhaar() {
    setForm(f => ({ ...f, contact_aadhaar_url: "" }));
    setAadhaarFile(null);
    setAadhaarError("");
  }

  function getCurrentLocation() {
    setGpsError("");
    if (!navigator.geolocation) { 
      setGpsError("Geolocation not supported by your browser."); 
      return; 
    }
    
    // Check if we're on a secure context (HTTPS or localhost)
    if (!window.isSecureContext && window.location.hostname !== 'localhost') {
      setGpsError("Location requires HTTPS. Please use a secure connection or enter coordinates manually.");
      return;
    }
    
    setGpsLoading(true);
    
    // Set a backup timeout in case the browser doesn't call the error callback
    const backupTimeout = setTimeout(() => {
      setGpsLoading(false);
      setGpsError("Location request timed out. Please enter coordinates manually or check browser permissions.");
    }, 16000);
    
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(backupTimeout);
        setForm(f => ({ ...f, latitude: pos.coords.latitude.toFixed(6), longitude: pos.coords.longitude.toFixed(6) }));
        setGpsLoading(false);
        setGpsError(""); // Clear any previous errors
      },
      (err) => {
        clearTimeout(backupTimeout);
        let errorMessage = "Unable to get location. Please enter coordinates manually.";
        
        // Handle different error codes
        if (err && err.code === 1) {
          errorMessage = "Location access denied. Enable location in browser settings (click the lock icon in address bar) or enter coordinates manually.";
        } else if (err && err.code === 2) {
          errorMessage = "Location unavailable. Check device location settings or enter coordinates manually.";
        } else if (err && err.code === 3) {
          errorMessage = "Location request timed out. Try again or enter coordinates manually.";
        } else {
          // Empty error object or unknown error - likely a security/permission issue
          errorMessage = "Location blocked by browser. Click the lock icon in the address bar to allow location access, or enter coordinates manually.";
        }
        
        setGpsError(errorMessage);
        setGpsLoading(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  // ── data fetching ──────────────────────────────────────────────────────────
  // append=true loads the next page into the existing list (progressive loading);
  // append=false replaces the list (initial load, filter change, refresh).
  // fetchGenRef invalidates in-flight appends when a replace fetch starts, so a
  // slow page-N response from the previous filter state can't pollute the new list.
  const fetchParties = useCallback(async (page = 1, append = false) => {
    // Wait until user is loaded from localStorage
    const currentUser = getUser();
    const activeCompanyId = typeof window !== "undefined" ? localStorage.getItem("activeCompanyId") : null;
    // Super admin must be scoped to a company — refuse to load all companies' data
    if (currentUser?.role === "SUPER_ADMIN" && !activeCompanyId) {
      setNoCompanyScope(true);
      setLoading(false);
      setLoadingMore(false);
      return;
    }
    setNoCompanyScope(false);
    const gen = append ? fetchGenRef.current : ++fetchGenRef.current;
    if (append) setLoadingMore(true); else setLoading(true);
    const buildParams = (minimal: boolean) => {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (search) params.set("search", search);
      if (typeFilter) params.set("party_type", typeFilter);
      // The API scopes salesmen to their assigned parties; the selected tab
      // then separates those assigned rows by verification status.
      params.set("is_verified", verificationTab === "verified" ? "true" : "false");
      // Minimal skips per-party balance derivation server-side — used for the
      // instant first paint; balances are then enriched in the background.
      if (minimal) params.set("minimal", "1");
      return params;
    };
    try {
      if (!append) {
        // Phase 1 — fast paint: render names/codes/types with no balance latency.
        const fast = await api<{ success: boolean; data: Party[]; pagination: Pagination }>(`/api/v1/parties?${buildParams(true)}`);
        if (gen !== fetchGenRef.current) return; // stale — a newer replace fetch took over
        setParties(fast.data || []);
        if (fast.pagination) setPagination(fast.pagination);
        setLoading(false);
        // Phase 2 — enrich with derived balances in the background, merge by id.
        api<{ success: boolean; data: Party[] }>(`/api/v1/parties?${buildParams(false)}`)
          .then((full) => {
            if (gen !== fetchGenRef.current) return; // a newer fetch superseded us
            const byId: Map<string, Party> = new Map((full.data || []).map((p) => [p.id, p]));
            setParties((prev) => prev.map((p) => {
              const b = byId.get(p.id);
              if (!b) return p;
              return {
                ...p,
                opening_balance: b.opening_balance,
                wallet_balance: b.wallet_balance,
                current_balance: b.current_balance,
                default_tax_template_id: b.default_tax_template_id ?? p.default_tax_template_id,
              };
            }));
          })
          .catch(() => { /* keep the fast-painted rows; balances stay at defaults */ });
        return;
      }
      // Append path (progressive pagination) — full rows with balances directly.
      const res = await api<{ success: boolean; data: Party[]; pagination: Pagination }>(`/api/v1/parties?${buildParams(false)}`);
      if (gen !== fetchGenRef.current) return; // stale response — a newer replace fetch took over
      // Dedupe by id in case rows shift between page requests
      setParties((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...(res.data || []).filter((p) => !seen.has(p.id))];
      });
      if (res.pagination) setPagination(res.pagination);
    } catch { if (!append && gen === fetchGenRef.current) setParties([]); }
    finally { if (append) setLoadingMore(false); else setLoading(false); }
  }, [search, typeFilter, verificationTab]);

  useEffect(() => { fetchParties(); }, [fetchParties]);

  // Load which parties have invoice approval disabled (admins only).
  useEffect(() => {
    if (!isSuperAdmin && !isAdminUser) return;
    api<{ success: boolean; data: { disabled_party_ids?: string[] } }>("/api/v1/settings/invoice-approval")
      .then((r) => setAutoInvoiceParties(new Set(r.data?.disabled_party_ids || [])))
      .catch(() => {});
  }, [isSuperAdmin, isAdminUser]);

  async function toggleInvoiceApproval(party: Party) {
    if (togglingApprovalId) return;
    const currentlyDisabled = autoInvoiceParties.has(party.id);
    // approval_required is the inverse of "auto-generate (disabled)"
    const nextApprovalRequired = currentlyDisabled;
    setTogglingApprovalId(party.id);
    // Optimistic update with rollback on failure.
    setAutoInvoiceParties((prev) => {
      const next = new Set(prev);
      if (nextApprovalRequired) next.delete(party.id);
      else next.add(party.id);
      return next;
    });
    try {
      await api("/api/v1/settings/invoice-approval", {
        method: "PUT",
        body: { party_id: party.id, approval_required: nextApprovalRequired },
      });
    } catch {
      setAutoInvoiceParties((prev) => {
        const next = new Set(prev);
        if (currentlyDisabled) next.add(party.id);
        else next.delete(party.id);
        return next;
      });
    } finally {
      setTogglingApprovalId(null);
    }
  }

  // Select a group to filter by, loading its member party IDs. Passing "" clears it.
  const applyGroupFilter = useCallback(async (groupId: string) => {
    setGroupFilter(groupId);
    if (!groupId) { setGroupMemberIds(new Set()); return; }
    setGroupFilterLoading(true);
    try {
      const res = await api<{ success: boolean; data: { members?: { id: string }[] } }>(`/api/v1/groups/${groupId}`);
      const ids = (res.data?.members || []).map((m) => m.id).filter(Boolean);
      setGroupMemberIds(new Set(ids));
    } catch {
      setGroupMemberIds(new Set());
    } finally {
      setGroupFilterLoading(false);
    }
  }, []);

  // Progressively load every remaining page after the first one paints, so the
  // list always scrolls through to the very end. Deliberately not scroll-driven:
  // scroll events and IntersectionObserver are render-throttled (and may never
  // fire) inside WebViews and embedded previews.
  useEffect(() => {
    if (loading || loadingMore) return;
    if (parties.length === 0) return;
    if (pagination.page >= pagination.pages) return;
    fetchParties(pagination.page + 1, true);
  }, [fetchParties, loading, loadingMore, pagination.page, pagination.pages, parties.length]);

  // Re-fetch whenever company scope changes (e.g. Super Admin selects/clears a company from another tab or the dashboard)
  useEffect(() => {
    const onCompanyChanged = () => fetchParties();
    window.addEventListener("activeCompanyChanged", onCompanyChanged);
    return () => window.removeEventListener("activeCompanyChanged", onCompanyChanged);
  }, [fetchParties]);

  // Debounced mobile-number lookup for the create form. The parties API search is
  // already company-scoped and matches on phone/portal_phone, so we query by the
  // typed digits and keep only an exact normalized-digit match. portal_phone is
  // stored digits-only, so an existing form-created party is always found here.
  useEffect(() => {
    if (!showCreate) { setPhoneMatch(null); setPhoneChecking(false); phoneCheckedRef.current = ""; return; }
    const digits = form.contact_phone.replace(/[^0-9]/g, "");
    if (digits.length < 6) { setPhoneMatch(null); setPhoneChecking(false); return; }

    const matches = (p: Party) => {
      const cp = String(p.phone || "").replace(/[^0-9]/g, "");
      const pp = String(p.portal_phone || "").replace(/[^0-9]/g, "");
      return cp === digits || pp === digits;
    };

    // 1) Instant, zero-latency check against the parties already in memory. The
    //    list progressively loads every page, so any existing registration the
    //    user is likely to hit is matched the moment they finish typing.
    const localMatch = parties.find(matches) || null;
    if (localMatch) { setPhoneMatch(localMatch); setPhoneChecking(false); return; }

    // Skip the network call if we already queried these exact digits (the effect
    // re-ran only because the parties list grew while paging).
    if (phoneCheckedRef.current === digits) return;

    // 2) Confirm against the company-scoped API — covers parties not yet paged in
    //    or sitting on the other verification tab. Fire immediately once the
    //    number looks complete; debounce only while the user is still typing.
    setPhoneMatch(null);
    setPhoneChecking(true);
    const delay = digits.length >= 10 ? 0 : 200;
    const timer = setTimeout(async () => {
      try {
        const res = await api<{ success: boolean; data: Party[] }>(
          `/api/v1/parties?search=${encodeURIComponent(digits)}&is_verified=all&limit=10`
        );
        phoneCheckedRef.current = digits;
        setPhoneMatch((res.data || []).find(matches) || null);
      } catch {
        setPhoneMatch(null);
      } finally {
        setPhoneChecking(false);
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [form.contact_phone, showCreate, parties]);

  useEffect(() => {
    async function loadMeta() {
      // Load party types and groups independently so one failure doesn't block the other.
      const [ptRes, grpRes] = await Promise.allSettled([
        api<{ success: boolean; data: { id: string; name: string }[] }>("/api/v1/party-types"),
        api<{ data: Group[] }>("/api/v1/groups"),
      ]);

      if (ptRes.status === "fulfilled") {
        setPartyTypes(ptRes.value.data || []);
      } else {
        console.error('Failed to load party types:', ptRes.reason);
        setPartyTypes([
          { id: "CNF", name: "CNF" },
          { id: "SUPER_DEALER", name: "SUPER_DEALER" },
          { id: "RETAILER", name: "RETAILER" },
        ]);
      }

      if (grpRes.status === "fulfilled") {
        setGroups(grpRes.value.data || []);
      } else {
        console.error('Failed to load groups:', grpRes.reason);
        setGroups([]);
      }
    }
    loadMeta();
  }, []);

    async function fetchParentParties(typeName: string, overrideParentType?: "SUPER_DEALER" | "CNF" | "COMPANY") {
      setParentLoading(true);
      setParentParties([]);
      
      try {
        const effectiveParentType =
          typeName === "CNF" ? "COMPANY"
          : typeName === "SUPER_DEALER" ? (overrideParentType ?? sdParentType)
          : (overrideParentType ?? retailerParentType);

        console.log("fetchParentParties:", { typeName, effectiveParentType });

        if (effectiveParentType === "COMPANY") {
          // The only valid parent is the currently active company — read from localStorage
          const activeCompany = getActiveCompany();
          // getActiveCompany() returns null if either id or name is missing; read directly as fallback
          let activeCompanyId = activeCompany?.id || localStorage.getItem('activeCompanyId') || null;
          let activeCompanyName = activeCompany?.name || localStorage.getItem('activeCompanyName') || null;

          // If still no company, fall back to the user's own party_id (works for ADMIN whose party IS the company)
          if (!activeCompanyId) {
            const currentUser = getUser();
            if (currentUser?.party_id) {
              activeCompanyId = currentUser.party_id;
              activeCompanyName = currentUser.party_name || currentUser.name || currentUser.party_id;
            }
          }

          if (!activeCompanyId) {
            setParentParties([]);
            setForm(f => ({ ...f, parent_party_id: "" }));
            setParentLoading(false);
            return;
          }

          const companyData = [{ id: activeCompanyId, name: activeCompanyName || activeCompanyId, party_code: "" }];
          setParentParties(companyData);
          setForm(f => ({ ...f, parent_party_id: activeCompanyId! }));
        } else {
          // CNF or SUPER_DEALER — fetch scoped list (API already scopes by active company via x-company-id header)
          // Clear parent_party_id since user needs to select from multiple options
          console.log("Fetching parent list for type:", effectiveParentType);
          setForm(f => ({ ...f, parent_party_id: "" }));
          const typeId = partyTypes.find(pt => pt.name === effectiveParentType)?.id || "";
          const url = typeId ? `/api/v1/parties?limit=200&party_type=${typeId}` : `/api/v1/parties?limit=200`;
          const allPartiesRes = await api<{ success: boolean; data: { id: string; name: string; party_code: string; party_types: { name: string } }[] }>(url);
          const filtered = (allPartiesRes.data || []).filter(p => p.party_types?.name === effectiveParentType);
          console.log("Filtered parent parties:", filtered);
          setParentParties(filtered.map(p => ({ id: p.id, name: p.name, party_code: p.party_code })));
        }
      } catch (err) { 
        console.error("Error in fetchParentParties:", err);
        setParentParties([]);
        setForm(f => ({ ...f, parent_party_id: "" }));
      }
      finally { 
        setParentLoading(false); 
      }
    }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    setSubmitAttempted(true);

    // A mobile number can register only one party per company.
    if (!form.contact_phone.replace(/[^0-9]/g, "")) {
      setFormError("Mobile number is required.");
      return;
    }
    if (phoneMatch) {
      setFormError(`This mobile number is already registered to ${phoneMatch.name} (${phoneMatch.party_code}) in this company. Each party must have a unique mobile number.`);
      return;
    }

    const locationResult = validateRequiredCoordinates(form.latitude, form.longitude);
    if (!locationResult.success) {
      setFormError(locationResult.message);
      setGpsError(locationResult.message);
      return;
    }
    setGpsError("");

    const typeName = partyTypes.find(pt => pt.id === form.party_type_id)?.name || "";
    
    // Only require a group for RETAILER and SUPER_DEALER types. The group carries the
    // salesman, so assigning a group also routes the party into that salesman's downline.
    if (!isSalesman && !form.group_id && (typeName === "RETAILER" || typeName === "SUPER_DEALER")) {
      setFormError("Please assign a group before creating this party.");
      return;
    }
    
    if ((typeName === "CNF") && !form.parent_party_id) {
      setFormError("Please select a parent Company for this CNF.");
      return;
    }
    
    if ((typeName === "RETAILER" || typeName === "SUPER_DEALER") && !form.parent_party_id) {
      setFormError(typeName === "RETAILER" ? "Please select a parent party for this Retailer." : `Please select a parent ${sdParentType === "COMPANY" ? "Company" : "CNF"} for this Super Dealer.`);
      return;
    }
    if (typeName === "COMPANY" && !form.portal_phone?.trim()) {
      setFormError("Portal Phone is required for Company login.");
      return;
    }
    if (typeName === "COMPANY" && !form.portal_password?.trim()) {
      setFormError("Portal Password is required for Company login.");
      return;
    }
    if (typeName === "COMPANY" && form.portal_password && form.portal_password.length < 8) {
      setFormError("Password must be at least 8 characters.");
      return;
    }
    setCreating(true);
    try {
      const response = await api("/api/v1/parties", {
          method: "POST",
          body: {
            ...form,
            credit_limit: parseFloat(form.credit_limit) || 0,
            payment_terms_days: parseInt(form.payment_terms_days) || 21,
            opening_balance: parseFloat(form.opening_balance) || 0,
            group_id: form.group_id || null,
            portal_phone: form.portal_phone || null,
            portal_password: form.portal_password || null,
            parent_party_id: form.parent_party_id || null,
            latitude: locationResult.coordinates.latitude,
            longitude: locationResult.coordinates.longitude,
            provision_auth_user: !!form.portal_phone && !!form.portal_password,
          },
        });
      console.log('Party created successfully:', response);
      setShowCreate(false);
      setForm(emptyForm);
      setGroupOpen(false);
      setGroupSearch("");
      setShowPortalPassword(false);
      setGpsError("");
      setSubmitAttempted(false);
      setAadhaarFile(null);
      setAadhaarError("");
      setSearch("");
      setTypeFilter("");
      setVerificationTab("unverified");
      if (verificationTab === "unverified" && !search && !typeFilter) fetchParties();
    } catch (err) {
      console.error('Party creation error:', err);
      const errorMessage = err instanceof Error ? err.message : "Failed to create party";
      console.error('Error message:', errorMessage);
      setFormError(errorMessage);
    } finally { setCreating(false); }
  }

  async function openPricingModal(party: Party) {
    setPricingParty(party);
    setSelectedPriceListId(party.price_list_id);
    setPriceListsLoading(true);
    try {
      const res = await api<{ success: boolean; data: PriceList[] }>("/api/v1/price-lists");
      setPriceLists(res.data || []);
    } catch { setPriceLists([]); }
    finally { setPriceListsLoading(false); }
  }

  async function savePriceList() {
    if (!pricingParty) return;
    setSavingPrice(true);
    try {
      await api(`/api/v1/parties/${pricingParty.id}`, { method: "PUT", body: { price_list_id: selectedPriceListId || null } });
      setParties(prev => prev.map(p => p.id === pricingParty.id ? { ...p, price_list_id: selectedPriceListId } : p));
      setPricingParty(null);
    } catch { /* ignore */ }
    finally { setSavingPrice(false); }
  }

  async function openTaxModal(party: Party) {
    setTaxParty(party);
    setSelectedTaxTemplateId((party as unknown as Record<string, string | null>).default_tax_template_id ?? null);
    setTaxError("");
    setMigrationSql("");
    setTaxTemplatesLoading(true);
    try {
      const res = await api<{ success: boolean; data: { id: string; product_name: string; gst_rate: number }[] }>("/api/v1/gst-templates");
      setTaxTemplates(res.data || []);
    } catch { setTaxTemplates([]); }
    finally { setTaxTemplatesLoading(false); }
  }

  async function saveTaxTemplate() {
    if (!taxParty) return;
    setSavingTax(true);
    setTaxError("");
    setMigrationSql("");
    try {
      await api(`/api/v1/parties/${taxParty.id}`, { method: "PUT", body: { default_tax_template_id: selectedTaxTemplateId || null } });
      setParties(prev => prev.map(p => p.id === taxParty.id ? { ...p, default_tax_template_id: selectedTaxTemplateId } : p));
      setTaxParty(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save tax template.";
      if (msg.toLowerCase().includes("migration") || msg.toLowerCase().includes("column") || msg.toLowerCase().includes("setup")) {
        setMigrationSql("ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS default_tax_template_id UUID;");
      } else {
        setTaxError(msg);
      }
    } finally { setSavingTax(false); }
  }

  const selectedTypeName = partyTypes.find(pt => pt.id === form.party_type_id)?.name || "";
  const filteredGroups = groups.filter(g => g.name.toLowerCase().includes(groupSearch.toLowerCase()) || (g.code || "").toLowerCase().includes(groupSearch.toLowerCase()));
  const selectedGroup = groups.find(g => g.id === form.group_id);

  function openEdit(p: Party) {
    const currentGroup = groups.find((group) => group.member_ids?.includes(p.id));
    setEditParty(p);
    setEditForm({
      name: p.name || "",
      trade_name: p.trade_name || "",
      gstin: p.gstin || "",
      address_line1: p.address_line1 || "",
      city: p.city || "",
      pin_code: p.pin_code || "",
      contact_person: p.contact_person || "",
      contact_phone: p.phone || (p as unknown as Record<string, string>).contact_phone || "",
      contact_email: p.contact_email || "",
      credit_limit: String(p.credit_limit ?? 0),
      group_id: currentGroup?.id || "",
    });
    setEditError("");
    setEditGroupOpen(false);
    setEditGroupSearch("");
  }

  function openPasswordModal(p: Party) {
    setPasswordParty(p);
    setPasswordForm({
      phone: p.portal_phone || p.phone || "",
      new_password: "",
      confirm_password: "",
    });
    setPasswordError("");
    setPasswordSuccess("");
    setShowNewPassword(false);
  }

  async function handlePasswordSave(e: React.FormEvent) {
    e.preventDefault();
    if (!passwordParty) return;

    const phone = passwordForm.phone.replace(/[^0-9]/g, "");
    if (phone.length < 10) {
      setPasswordError("Enter a valid mobile number for party login.");
      return;
    }
    if (passwordForm.new_password.length < 6) {
      setPasswordError("Password must be at least 6 characters.");
      return;
    }
    if (passwordForm.new_password !== passwordForm.confirm_password) {
      setPasswordError("Passwords do not match.");
      return;
    }

    setSavingPassword(true);
    setPasswordError("");
    setPasswordSuccess("");
    try {
      const res = await api<{ success: boolean; message?: string; data?: { phone?: string } }>(`/api/v1/parties/${passwordParty.id}/password`, {
        method: "POST",
        body: { phone, new_password: passwordForm.new_password },
      });

      const savedPhone = res.data?.phone || phone;
      setParties(prev => prev.map(p => p.id === passwordParty.id ? { ...p, portal_phone: savedPhone } : p));
      setPasswordParty(prev => prev ? { ...prev, portal_phone: savedPhone } : prev);
      setPasswordForm(f => ({ ...f, phone: savedPhone, new_password: "", confirm_password: "" }));
      setPasswordSuccess(res.message || "Password updated. The party can now log in with this mobile number.");
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : "Failed to update party password");
    } finally {
      setSavingPassword(false);
    }
  }

  async function handleEditSave(e: React.FormEvent) {
    e.preventDefault();
    if (!editParty) return;
    if (!editForm.name.trim()) { setEditError("Party name is required."); return; }
    setSavingEdit(true);
    setEditError("");
    try {
      await api(`/api/v1/parties/${editParty.id}`, {
        method: "PUT",
        body: {
          name: editForm.name.trim(),
          trade_name: editForm.trade_name.trim() || null,
          gstin: editForm.gstin.trim() || null,
          address_line1: editForm.address_line1.trim() || null,
          city: editForm.city.trim() || null,
          pin_code: editForm.pin_code.trim() || null,
          contact_person: editForm.contact_person.trim() || null,
          phone: editForm.contact_phone.trim() || null,
          contact_email: editForm.contact_email.trim() || null,
          credit_limit: parseFloat(editForm.credit_limit) || 0,
          group_id: editForm.group_id || null,
        },
      });
      setParties(prev => prev.map(p => p.id === editParty.id ? {
        ...p,
        name: editForm.name.trim(),
        trade_name: editForm.trade_name.trim() || null,
        gstin: editForm.gstin.trim() || null,
        address_line1: editForm.address_line1.trim() || null,
        city: editForm.city.trim() || "",
        pin_code: editForm.pin_code.trim() || null,
        contact_person: editForm.contact_person.trim() || null,
        phone: editForm.contact_phone.trim() || null,
        contact_email: editForm.contact_email.trim() || null,
        credit_limit: parseFloat(editForm.credit_limit) || 0,
        salesman_id: null,
        salesman: null,
      } : p));
      setGroups(prev => prev.map(group => {
        const memberIds = (group.member_ids || []).filter(id => id !== editParty.id);
        if (group.id === editForm.group_id) memberIds.push(editParty.id);
        return { ...group, member_ids: memberIds, member_count: memberIds.length };
      }));
      setEditParty(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to save changes");
    } finally { setSavingEdit(false); }
  }

  async function saveOpeningBalance() {
    if (!obParty) return;
    setObSaving(true);
    setObError("");
    try {
      const val = parseFloat(obValue);
      if (isNaN(val)) { setObError("Enter a valid number."); setObSaving(false); return; }
      await api(`/api/v1/parties/${obParty.id}`, { method: "PUT", body: { opening_balance: val } });
      setParties(prev => prev.map(p => p.id === obParty.id ? { ...p, opening_balance: val } : p));
      setObParty(null);
    } catch (err) {
      setObError(err instanceof Error ? err.message : "Failed to save");
    } finally { setObSaving(false); }
  }

  async function handleDelete(party: Party) {
    if (!confirm(`Delete "${party.name}"? This action cannot be undone.`)) return;
    setDeletingId(party.id);
    try {
      await api(`/api/v1/parties/${party.id}`, { method: "DELETE" });
      setParties(prev => prev.filter(p => p.id !== party.id));
      setPagination(prev => ({ ...prev, total: prev.total - 1 }));
    } catch { /* ignore */ }
    finally { setDeletingId(null); }
  }

  async function handleVerify(party: Party) {
    if (!confirm(`Verify "${party.name}"? This party will become active across all modules.`)) return;
    setVerifyingId(party.id);
    try {
      await api(`/api/v1/parties/${party.id}/verify`, { method: "PUT" });
      setParties(prev => prev.filter(p => p.id !== party.id));
      setPagination(prev => ({ ...prev, total: prev.total - 1 }));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to verify party");
    } finally { setVerifyingId(null); }
  }

  async function openVisitModal(party: Party) {
    setVisitModalParty(party);
    setVisitLogsLoading(true);
    try {
      const res = await api<{ success: boolean; data: { id: string; visitor_name: string; visit_date: string; notes: string | null }[] }>(`/api/v1/parties/${party.id}/visit-logs`);
      setVisitLogs(res.data || []);
    } catch { setVisitLogs([]); }
    finally { setVisitLogsLoading(false); }
  }

  async function handleAddVisit(partyId: string) {
    setAddingVisitId(partyId);
    try {
      await api(`/api/v1/parties/${partyId}/visit-logs`, { method: "POST", body: { notes: visitNote || null } });
      setVisitNote("");
      const res = await api<{ success: boolean; data: { id: string; visitor_name: string; visit_date: string; notes: string | null }[] }>(`/api/v1/parties/${partyId}/visit-logs`);
      setVisitLogs(res.data || []);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to add visit log");
    } finally { setAddingVisitId(null); }
  }

  // Apply the active group filter to the loaded list (client-side). The
  // progressive loader pulls every page, so once loading settles this reflects
  // the full set of the group's members within the current verification view.
  const displayedParties = groupFilter ? parties.filter((p) => groupMemberIds.has(p.id)) : parties;
  const activeGroupName = groupFilter ? (groups.find((g) => g.id === groupFilter)?.name ?? "group") : "";

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>

      {/* ── Header ── */}
      <div className="flex items-center justify-between mb-3 lg:mb-4">
        <div>
          <h1 className="text-xl lg:text-2xl font-bold text-zinc-900" style={{ marginBottom: "0.25rem" }}>
            {viewMode === "vendors" ? "Vendors" : "Parties"}
          </h1>
          <p className="text-zinc-600" style={{ fontSize: "0.8rem", margin: 0 }}>
            {viewMode === "vendors"
              ? "Creditors & debtors — suppliers you transact with"
              : groupFilter
              ? `${displayedParties.length} ${displayedParties.length === 1 ? "party" : "parties"} in ${activeGroupName}`
              : `${pagination.total} ${verificationTab === "verified" ? "verified " : "unverified "}parties`}
          </p>
        </div>
        {viewMode === "parties" && (
          <div className="flex gap-2">
            <button
              onClick={() => setShowFilters(!showFilters)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-black/10 text-zinc-700 hover:bg-black/5 transition-all"
              style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", boxShadow: "none", cursor: "pointer" }}
            >
              <Filter className="w-4 h-4" />
              <span className="hidden sm:inline">Filters</span>
            </button>
            {perms.can_create && !noCompanyScope && (
              <button
                onClick={() => setShowCreate(true)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-600 transition-all"
                style={{ fontSize: "0.8rem", fontFamily: "inherit", boxShadow: "none", cursor: "pointer", border: "none" }}
              >
                <Plus className="w-4 h-4" />
                <span className="hidden sm:inline">Add Party</span>
                <span className="sm:hidden">Add</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Parties / Vendors toggle ── */}
      {!noCompanyScope && vendorPerms.can_view && (
        <div className="flex gap-1 mb-4 lg:mb-6 p-1 rounded-lg bg-black/[0.04] border border-black/[0.06]" style={{ width: "fit-content" }}>
          <button
            onClick={() => setViewMode("parties")}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-md transition-all ${viewMode === "parties" ? "bg-white text-zinc-900 font-medium shadow-sm" : "text-zinc-500 hover:text-zinc-700"}`}
            style={{ fontSize: "0.78rem", fontFamily: "inherit", border: "none", cursor: "pointer", background: viewMode === "parties" ? undefined : "transparent" }}
          >
            <Users className="w-3.5 h-3.5" /> Parties
          </button>
          <button
            onClick={() => setViewMode("vendors")}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-md transition-all ${viewMode === "vendors" ? "bg-white text-zinc-900 font-medium shadow-sm" : "text-zinc-500 hover:text-zinc-700"}`}
            style={{ fontSize: "0.78rem", fontFamily: "inherit", border: "none", cursor: "pointer", background: viewMode === "vendors" ? undefined : "transparent" }}
          >
            <Truck className="w-3.5 h-3.5" /> Vendors
          </button>
        </div>
      )}

      {/* ── Vendors module ── */}
      {!noCompanyScope && vendorPerms.can_view && viewMode === "vendors" && (
        <VendorsPanel
          permissions={vendorPerms}
          companyId={typeof window !== "undefined" ? localStorage.getItem("activeCompanyId") : null}
        />
      )}

      {/* ── No company scope guard (Super Admin only) ── */}
      {noCompanyScope && (
        <div className="max-w-lg mx-auto py-12">
          <div className="flex flex-col items-center text-center mb-8">
            <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mb-4">
              <Building2 className="w-7 h-7 text-amber-400 opacity-70" />
            </div>
            <h2 className="text-zinc-900 font-semibold mb-1" style={{ fontSize: "1rem" }}>Select a Company</h2>
            <p className="text-zinc-500" style={{ fontSize: "0.8rem" }}>Choose which company&apos;s parties you want to view.</p>
          </div>
          {companiesLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 text-amber-500 animate-spin" /></div>
          ) : companies.length === 0 ? (
            <p className="text-center text-zinc-500" style={{ fontSize: "0.8rem" }}>No companies found.</p>
          ) : (
            <div className="space-y-2">
              {companies.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    setActiveCompany(c.id, c.name);
                    window.dispatchEvent(new Event("storage"));
                    setNoCompanyScope(false);
                    fetchParties();
                  }}
                  className="w-full flex items-center justify-between px-4 py-3.5 rounded-xl border border-black/[0.06] bg-black/[0.02] hover:bg-amber-500/10 hover:border-amber-500/30 transition-all text-left"
                  style={{ fontFamily: "inherit", cursor: "pointer" }}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0">
                      <Building2 className="w-4 h-4 text-amber-400" />
                    </div>
                    <div>
                      <div className="text-zinc-900 font-medium" style={{ fontSize: "0.85rem" }}>{c.name}</div>
                      <div className="text-zinc-500 font-mono" style={{ fontSize: "0.65rem" }}>{c.party_code}{c.city ? ` • ${c.city}` : ""}</div>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-zinc-600" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {!noCompanyScope && viewMode === "parties" && (
        <div>

        {/* ── Verification Tabs ── */}
          <div className="flex gap-1 mb-4 p-1 rounded-lg bg-black/[0.04] border border-black/[0.06]" style={{ width: "fit-content" }}>
            <button
              onClick={() => setVerificationTab("unverified")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-all ${verificationTab === "unverified" ? "bg-amber-500/15 text-amber-500 font-medium" : "text-zinc-500 hover:text-zinc-700"}`}
              style={{ fontSize: "0.75rem", fontFamily: "inherit", border: "none", cursor: "pointer", background: verificationTab === "unverified" ? undefined : "transparent" }}
            >
              <Shield className="w-3.5 h-3.5" /> Unverified
            </button>
            <button
              onClick={() => setVerificationTab("verified")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-all ${verificationTab === "verified" ? "bg-emerald-500/15 text-emerald-500 font-medium" : "text-zinc-500 hover:text-zinc-700"}`}
              style={{ fontSize: "0.75rem", fontFamily: "inherit", border: "none", cursor: "pointer", background: verificationTab === "verified" ? undefined : "transparent" }}
            >
              <ShieldCheck className="w-3.5 h-3.5" /> Verified
            </button>
          </div>

        {/* ── Search + Filters ── */}
      <div className="flex flex-col gap-3 mb-6">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type="text"
            placeholder="Search by name, code, GSTIN, phone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-amber-500/40"
            style={{ fontSize: "0.8rem", fontFamily: "inherit" }}
          />
        </div>
        {showFilters && (
          <div className="flex flex-wrap items-center gap-2">
              {["CNF", "SUPER_DEALER", "RETAILER"].map((pt) => (
              <button
                key={pt}
                onClick={() => setTypeFilter(typeFilter === pt ? "" : pt)}
                className={`px-3 py-1.5 rounded-lg text-xs border transition-all ${typeFilter === pt ? "border-amber-500/40 bg-amber-500/10 text-amber-400" : "border-black/10 bg-black/[0.03] text-zinc-600 hover:bg-black/5"}`}
                style={{ fontSize: "0.7rem", fontFamily: "inherit", boxShadow: "none", cursor: "pointer" }}
              >
                {pt.replace(/_/g, " ")}
              </button>
            ))}
            {typeFilter && (
              <button onClick={() => setTypeFilter("")} className="px-2 py-1.5 text-zinc-500 hover:text-zinc-900" style={{ fontSize: "0.7rem", fontFamily: "inherit", background: "none", border: "none", boxShadow: "none", cursor: "pointer" }}>
                <X className="w-3 h-3" />
              </button>
            )}

            {/* Group filter — narrow to a single group's member parties */}
            {groups.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="hidden sm:flex items-center gap-1 text-zinc-400" style={{ fontSize: "0.68rem" }}>
                  <Layers3 className="w-3.5 h-3.5" /> Group
                </span>
                <div className="relative">
                  <select
                    value={groupFilter}
                    onChange={(e) => applyGroupFilter(e.target.value)}
                    className={`pl-3 pr-7 py-1.5 rounded-lg border appearance-none outline-none transition-all cursor-pointer ${groupFilter ? "border-amber-500/40 bg-amber-500/10 text-amber-400" : "border-black/10 bg-[#ffffff] text-zinc-600 hover:bg-black/5"}`}
                    style={{ fontSize: "0.7rem", fontFamily: "inherit", boxShadow: "none" }}
                  >
                    <option value="">All groups</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}{g.member_count ? ` (${g.member_count})` : ""}
                      </option>
                    ))}
                  </select>
                  <ChevronRight className="w-3 h-3 absolute right-2 top-1/2 -translate-y-1/2 rotate-90 pointer-events-none text-zinc-400" />
                </div>
                {groupFilterLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" />}
                {groupFilter && !groupFilterLoading && (
                  <button onClick={() => applyGroupFilter("")} className="px-1.5 py-1.5 text-zinc-500 hover:text-zinc-900" style={{ fontSize: "0.7rem", fontFamily: "inherit", background: "none", border: "none", boxShadow: "none", cursor: "pointer" }}>
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Party list ── */}
      {loading || groupFilterLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
        </div>
      ) : displayedParties.length === 0 ? (
        <div className="text-center py-20 text-zinc-500">
          {groupFilter ? <Layers3 className="w-12 h-12 mx-auto mb-4 opacity-30" /> : <Building2 className="w-12 h-12 mx-auto mb-4 opacity-30" />}
          <p style={{ fontSize: "0.875rem" }}>
            {groupFilter
              ? `No parties from ${activeGroupName} in the current view.`
              : verificationTab === "verified"
                ? isSalesman
                  ? "No verified parties are assigned to you yet."
                  : "No verified parties yet. Verify parties from the Unverified tab."
                : isSalesman
                  ? "No unverified parties are assigned to you."
                  : "No unverified parties. All parties are verified!"}
          </p>
        </div>
      ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 overflow-y-auto pr-1" style={{ maxHeight: "calc(100vh - 280px)" }}>
              {displayedParties.map((p) => (
              <div key={p.id} className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-4 lg:p-5 hover:bg-black/[0.04] transition-all">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-black/5 flex items-center justify-center shrink-0">
                      <Building2 className="w-5 h-5 text-zinc-600" />
                    </div>
                    <div>
                      <h3 className="text-zinc-900 font-medium" style={{ fontSize: "0.85rem" }}>{p.name}</h3>
                      <span className="text-zinc-500 font-mono" style={{ fontSize: "0.65rem" }}>{p.party_code}</span>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs shrink-0 ${partyTypeColors[p.party_types?.name || ""] || "bg-zinc-500/20 text-zinc-600"}`} style={{ fontSize: "0.6rem" }}>
                      {p.party_types?.name?.replace(/_/g, " ") || "N/A"}
                    </span>
                    {p.is_verified ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-500 font-medium" style={{ fontSize: "0.6rem" }}>
                        <ShieldCheck className="w-3 h-3" /> Verified
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/15 text-amber-500 font-medium" style={{ fontSize: "0.6rem" }}>
                        <Shield className="w-3 h-3" /> Unverified
                      </span>
                    )}
                  </div>
                </div>

                <div className="space-y-1.5 mb-3">
                  {p.gstin && (
                    <div className="flex justify-between">
                      <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>GSTIN</span>
                      <span className="text-zinc-700 font-mono" style={{ fontSize: "0.7rem" }}>{p.gstin}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>Location</span>
                    <span className="text-zinc-700" style={{ fontSize: "0.7rem" }}>{p.city}</span>
                  </div>
                  {groups.find(group => group.member_ids?.includes(p.id)) && (
                    <div className="flex justify-between">
                      <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>Group</span>
                      <span className="text-amber-400 flex items-center gap-1" style={{ fontSize: "0.7rem" }}>
                        <Users className="w-3 h-3" />{groups.find(group => group.member_ids?.includes(p.id))?.name}
                      </span>
                    </div>
                  )}
                  {p.contact_person && (
                    <div className="flex justify-between">
                      <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>Contact</span>
                      <span className="text-zinc-700" style={{ fontSize: "0.7rem" }}>{p.contact_person}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>Admin Mobile</span>
                    <span className="text-zinc-700" style={{ fontSize: "0.7rem" }}>{p.portal_phone || p.phone || "—"}</span>
                  </div>
                    <div className="flex justify-between">
                      <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>Credit Limit</span>
                      <span className="text-amber-400 font-medium" style={{ fontSize: "0.7rem" }}>{fmt(Number(p.credit_limit))}</span>
                    </div>
                      {(() => {
                        const effective = Number(p.wallet_balance || 0) + Number(p.opening_balance || 0);
                        return (
                          <div className="flex justify-between">
                            <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>Wallet Balance</span>
                            <span
                              className={`font-medium ${effective < 0 ? "text-red-400" : effective > 0 ? "text-green-400" : "text-zinc-500"}`}
                              style={{ fontSize: "0.7rem" }}
                              title={effective < 0 ? "Party owes you" : effective > 0 ? "You owe the party" : ""}
                            >
                              {effective === 0
                                ? "—"
                                : `${effective < 0 ? "▼ " : "▲ "}${fmt(Math.abs(effective))}`}
                            </span>
                          </div>
                        );
                      })()}
                  {/* GPS indicator */}
                  {p.latitude && p.longitude && (
                    <div className="flex justify-between">
                      <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>GPS</span>
                      <span className="text-emerald-400 flex items-center gap-1" style={{ fontSize: "0.7rem" }}>
                        <MapPin className="w-3 h-3" />{p.latitude.toFixed(4)}, {p.longitude.toFixed(4)}
                      </span>
                    </div>
                  )}
                  {/* Verification info for verified parties */}
                  {p.is_verified && p.verifier && (
                    <div className="flex justify-between">
                      <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>Verified by</span>
                      <span className="text-emerald-400 flex items-center gap-1" style={{ fontSize: "0.7rem" }}>
                        <CheckCircle className="w-3 h-3" />{p.verifier.name}
                      </span>
                    </div>
                  )}
                  {p.is_verified && p.verified_at && (
                    <div className="flex justify-between">
                      <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>Verified on</span>
                      <span className="text-zinc-700" style={{ fontSize: "0.7rem" }}>
                        {new Date(p.verified_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                      </span>
                    </div>
                  )}
                </div>

                {/* Unverified: Visit Log + Verify actions */}
                {!p.is_verified && (
                  <div className="flex gap-2 mb-3">
                    <button
                      onClick={() => openVisitModal(p)}
                      className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-zinc-600 hover:text-blue-400 hover:bg-blue-500/10 transition-all"
                      style={{ background: "none", border: "1px solid rgba(0,0,0,0.06)", fontSize: "0.7rem", cursor: "pointer", fontFamily: "inherit" }}
                    >
                      <ClipboardList className="w-3.5 h-3.5" /> Visit Log
                    </button>
                    {(isSuperAdmin || (!isSalesman && perms.can_edit)) && (
                      <button
                        onClick={() => handleVerify(p)}
                        disabled={verifyingId === p.id}
                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20 transition-all"
                        style={{ border: "1px solid rgba(16,185,129,0.2)", fontSize: "0.7rem", cursor: "pointer", fontFamily: "inherit", fontWeight: 500 }}
                      >
                        {verifyingId === p.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />} Verify
                      </button>
                    )}
                  </div>
                )}

                    <div className="flex flex-wrap gap-2 pt-3 border-t border-black/[0.06]">
                      {/* Map button */}
                      <button
                        onClick={() => openMapModal(p)}
                        title={p.latitude && p.longitude ? "View on map" : "No GPS location set — click to set"}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg transition-all ${
                          p.latitude && p.longitude
                            ? "text-emerald-400 hover:bg-emerald-500/10 cursor-pointer"
                            : "text-amber-400 hover:bg-amber-500/10 cursor-pointer animate-pulse"
                        }`}
                        style={{
                          background: p.latitude && p.longitude ? "none" : "rgba(245,158,11,0.08)",
                          border: p.latitude && p.longitude ? "none" : "1px solid rgba(245,158,11,0.25)",
                          fontSize: "0.7rem",
                          fontFamily: "inherit",
                        }}
                      >
                        <MapIcon className="w-3.5 h-3.5" />
                        {p.latitude && p.longitude ? "Map" : "Set GPS"}
                      </button>
                      <button
                        onClick={() => setViewParty(p)}
                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-zinc-600 hover:text-amber-400 hover:bg-amber-500/10 transition-all"
                        style={{ background: "none", border: "none", fontSize: "0.7rem", cursor: "pointer", fontFamily: "inherit" }}
                      >
                        <Eye className="w-3.5 h-3.5" /> View
                      </button>
                        <button
                          onClick={() => router.push(`/dashboard/ledgers?party_id=${p.id}`)}
                          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-zinc-600 hover:text-blue-400 hover:bg-blue-500/10 transition-all" style={{ background: "none", border: "none", fontSize: "0.7rem", cursor: "pointer", fontFamily: "inherit" }}>
                          <CreditCard className="w-3.5 h-3.5" /> Ledger
                        </button>

                      {perms.can_edit && (
                        <button
                          onClick={() => openEdit(p)}
                          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-zinc-600 hover:text-orange-400 hover:bg-orange-500/10 transition-all" style={{ background: "none", border: "none", fontSize: "0.7rem", cursor: "pointer", fontFamily: "inherit" }}>
                          <Pencil className="w-3.5 h-3.5" /> Edit
                        </button>
                      )}

                      {canManagePartyPasswords && (
                        <button
                          onClick={() => openPasswordModal(p)}
                          title="Change party login password"
                          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-zinc-600 hover:text-emerald-400 hover:bg-emerald-500/10 transition-all"
                          style={{ background: "none", border: "none", fontSize: "0.7rem", cursor: "pointer", fontFamily: "inherit" }}
                        >
                          <KeyRound className="w-3.5 h-3.5" /> Password
                        </button>
                      )}

                      {perms.can_edit && (
                      <button
                        onClick={() => openPricingModal(p)}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg transition-all ${p.price_list_id ? "text-emerald-400 hover:bg-emerald-500/20" : "text-zinc-600 hover:text-purple-400 hover:bg-purple-500/10"}`}
                        style={{ border: "none", fontSize: "0.7rem", cursor: "pointer", fontFamily: "inherit", background: p.price_list_id ? "rgba(16,185,129,0.1)" : "none" }}
                      >
                        <Tag className="w-3.5 h-3.5" /> Pricing
                      </button>
                      )}
                      {(isSuperAdmin || perms.can_edit) && (
                        <button
                          onClick={() => openTaxModal(p)}
                          title="Set default tax template for this party"
                          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg transition-all ${p.default_tax_template_id ? "text-blue-400 hover:bg-blue-500/20" : "text-zinc-600 hover:text-blue-400 hover:bg-blue-500/10"}`}
                          style={{ border: "none", fontSize: "0.7rem", cursor: "pointer", fontFamily: "inherit", background: p.default_tax_template_id ? "rgba(59,130,246,0.1)" : "none" }}
                        >
                          <Receipt className="w-3.5 h-3.5" /> Tax
                        </button>
                      )}
                      {(isSuperAdmin || isAdminUser) && (() => {
                        const approvalOff = autoInvoiceParties.has(p.id);
                        const busy = togglingApprovalId === p.id;
                        return (
                          <button
                            onClick={() => toggleInvoiceApproval(p)}
                            disabled={busy}
                            title={approvalOff
                              ? "Invoices auto-generate for this party (no approval). Click to require approval."
                              : "This party must approve invoice requests. Click to auto-generate without approval."}
                            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg transition-all disabled:opacity-50 ${approvalOff ? "text-amber-500 hover:bg-amber-500/20" : "text-emerald-500 hover:bg-emerald-500/10"}`}
                            style={{ border: "none", fontSize: "0.7rem", cursor: busy ? "default" : "pointer", fontFamily: "inherit", background: approvalOff ? "rgba(245,158,11,0.12)" : "none" }}
                          >
                            {busy
                              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              : approvalOff ? <Zap className="w-3.5 h-3.5" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                            {approvalOff ? "Auto-Bill" : "Approval"}
                          </button>
                        );
                      })()}
                      {(isSuperAdmin || perms.can_delete) && (
                        <button
                          onClick={() => handleDelete(p)}
                          disabled={deletingId === p.id}
                          title="Delete party"
                          className="flex items-center justify-center px-2 py-1.5 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-all disabled:opacity-40"
                          style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}
                        >
                          {deletingId === p.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                        </button>
                      )}
                    </div>
              </div>
            ))}

            {/* Infinite scroll status row lives inside the scroll container so it
                appears at the end of the list while more pages load. */}
            {(loadingMore || pagination.page < pagination.pages) ? (
              <div className="col-span-full flex items-center justify-center gap-2 py-4 text-zinc-500">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span style={{ fontSize: "0.7rem" }}>Loading more parties…</span>
              </div>
            ) : groupFilter ? (
              <div className="col-span-full text-center py-4 text-zinc-500" style={{ fontSize: "0.7rem" }}>
                Showing {displayedParties.length} {displayedParties.length === 1 ? "party" : "parties"} in {activeGroupName}
              </div>
            ) : pagination.total > parties.length || pagination.pages > 1 ? (
              <div className="col-span-full text-center py-4 text-zinc-500" style={{ fontSize: "0.7rem" }}>
                Showing all {parties.length} parties
              </div>
            ) : null}
          </div>
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          CREATE PARTY MODAL
      ══════════════════════════════════════════════════════════════════════ */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setShowCreate(false)}>
          <div className="bg-[#ffffff] border border-black/10 rounded-2xl w-full max-w-2xl mx-4 overflow-hidden" style={{ maxHeight: "90vh" }} onClick={(e) => e.stopPropagation()}>
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-black/[0.06]">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center">
                  <Building2 className="w-4 h-4 text-amber-400" />
                </div>
                <h2 className="text-zinc-900 font-semibold" style={{ fontSize: "0.9rem" }}>Create New Party</h2>
              </div>
              <button onClick={() => setShowCreate(false)} className="text-zinc-600 hover:text-zinc-900" style={{ background: "none", border: "none", cursor: "pointer" }}>
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Form */}
            <form onSubmit={handleCreate} className="overflow-y-auto p-5 space-y-4" style={{ maxHeight: "calc(90vh - 65px)" }}>

              {/* Row 0: Mobile Number — entered first. Doubles as the portal Login ID and
                  must be unique per company; we look it up live as the user types. */}
              <div>
                <label style={lbl} className="flex items-center gap-1">
                  <Smartphone className="w-3 h-3" /> Mobile Number <span className="text-amber-500/70">(Login ID)</span> <span className="text-red-400">*</span>
                </label>
                <input
                  inputMode="tel"
                  autoFocus
                  value={form.contact_phone}
                  onChange={(e) => setForm({ ...form, contact_phone: e.target.value, portal_phone: e.target.value })}
                  className={`${inp} ${phoneMatch ? "border-red-500/60 bg-red-500/[0.05]" : ""}`}
                  style={is}
                  placeholder="+91 98765 43210"
                />
                {phoneChecking && (
                  <p className="mt-1 flex items-center gap-1 text-zinc-500" style={{ fontSize: "0.7rem" }}>
                    <Loader2 className="w-3 h-3 animate-spin" /> Checking this number…
                  </p>
                )}
                {!phoneChecking && phoneMatch && (
                  <div className="mt-1 px-2.5 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400" style={{ fontSize: "0.7rem" }}>
                    Already registered: <span className="font-semibold">{phoneMatch.name}</span>
                    <span className="font-mono text-red-400/80"> ({phoneMatch.party_code})</span>
                    {phoneMatch.party_types?.name && <span className="text-red-400/70"> · {phoneMatch.party_types.name.replace(/_/g, " ")}</span>}
                    . A mobile number can belong to only one party.
                  </div>
                )}
                {!phoneChecking && !phoneMatch && form.contact_phone.replace(/[^0-9]/g, "").length >= 6 && (
                  <p className="mt-1 flex items-center gap-1 text-emerald-500" style={{ fontSize: "0.7rem" }}>
                    <Check className="w-3 h-3" /> Available — no party uses this number.
                  </p>
                )}
              </div>

              {/* Row 1: Name + Trade Name */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label style={lbl}>Party Name *</label>
                  <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inp} style={is} />
                </div>
                <div>
                  <label style={lbl}>Trade / Display Name</label>
                  <input value={form.trade_name} onChange={(e) => setForm({ ...form, trade_name: e.target.value })} className={inp} style={is} />
                </div>
              </div>

              {/* Row 2: Party Type */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label style={lbl}>Party Type *</label>
                  <select
                    required
                    value={form.party_type_id}
                      onChange={(e) => {
                        const newType = partyTypes.find(pt => pt.id === e.target.value)?.name || "";
                            // Don't clear parent_party_id yet - let fetchParentParties handle it
                            setForm({ ...form, party_type_id: e.target.value });
                            if (newType === "RETAILER") { setRetailerParentType("SUPER_DEALER"); fetchParentParties("RETAILER", "SUPER_DEALER"); }
                            else if (newType === "SUPER_DEALER") { setSdParentType("CNF"); fetchParentParties("SUPER_DEALER", "CNF"); }
                            else if (newType === "CNF") fetchParentParties(newType);
                          else { setParentParties([]); setForm(f => ({ ...f, parent_party_id: "" })); }
                      }}
                    className={sel}
                    style={is}
                  >
                    <option value="">Select type…</option>
                      {partyTypes.filter(pt => pt.name !== "COMPANY").map(pt => <option key={pt.id} value={pt.id}>{pt.name.replace(/_/g, " ")}</option>)}
                  </select>
                </div>
                  {/* Parent party — show for CNF, SUPER_DEALER, RETAILER */}
                    {(selectedTypeName === "SUPER_DEALER" || selectedTypeName === "RETAILER" || selectedTypeName === "CNF") && (
                      <div>
                          {/* For SUPER_DEALER: let user pick which level it reports to */}
                          {selectedTypeName === "SUPER_DEALER" && (
                            <div className="flex gap-1 mb-2">
                              {(["CNF", "COMPANY"] as const).map(opt => (
                                <button
                                  key={opt}
                                  type="button"
                                  onClick={() => {
                                    setSdParentType(opt);
                                    setForm(f => ({ ...f, parent_party_id: "" }));
                                    fetchParentParties("SUPER_DEALER", opt);
                                  }}
                                  style={{
                                    fontSize: "0.7rem",
                                    padding: "2px 8px",
                                    borderRadius: "6px",
                                    border: "1px solid",
                                    cursor: "pointer",
                                    borderColor: sdParentType === opt ? "#f59e0b" : "#3f3f46",
                                    background: sdParentType === opt ? "rgba(245,158,11,0.15)" : "transparent",
                                    color: sdParentType === opt ? "#f59e0b" : "#a1a1aa",
                                  }}
                                >
                                  {opt === "CNF" ? "CNF" : "Company"}
                                </button>
                              ))}
                            </div>
                          )}
                          {/* For RETAILER: let user pick which level it reports to */}
                        {selectedTypeName === "RETAILER" && (
                          <div className="flex gap-1 mb-2">
                            {(["SUPER_DEALER", "CNF", "COMPANY"] as const).map(opt => (
                              <button
                                key={opt}
                                type="button"
                                onClick={() => {
                                  setRetailerParentType(opt);
                                  setForm(f => ({ ...f, parent_party_id: "" }));
                                  fetchParentParties("RETAILER", opt);
                                }}
                                style={{
                                  fontSize: "0.7rem",
                                  padding: "2px 8px",
                                  borderRadius: "6px",
                                  border: "1px solid",
                                  cursor: "pointer",
                                  borderColor: retailerParentType === opt ? "#f59e0b" : "#3f3f46",
                                  background: retailerParentType === opt ? "rgba(245,158,11,0.15)" : "transparent",
                                  color: retailerParentType === opt ? "#f59e0b" : "#a1a1aa",
                                }}
                              >
                                {opt === "SUPER_DEALER" ? "Super Dealer" : opt === "CNF" ? "CNF" : "Company"}
                              </button>
                            ))}
                          </div>
                        )}
                            <label style={lbl}>
                              {selectedTypeName === "CNF"
                                ? "Parent Company *"
                                : selectedTypeName === "SUPER_DEALER"
                                ? sdParentType === "COMPANY" ? "Parent Company *" : "Parent CNF *"
                                : retailerParentType === "SUPER_DEALER"
                                ? "Parent Super Dealer *"
                                : retailerParentType === "CNF"
                                ? "Parent CNF *"
                                : "Parent Company *"}
                            </label>
                        {parentLoading ? (
                          <div className="flex items-center gap-2 px-3 py-2 text-zinc-500" style={{ fontSize: "0.8rem" }}><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</div>
                        ) : (
                          /* If parent is auto-selected (only one option = current company), show read-only pill */
                          parentParties.length === 1 && (
                            selectedTypeName === "CNF" ||
                            (selectedTypeName === "SUPER_DEALER" && sdParentType === "COMPANY") ||
                            (selectedTypeName === "RETAILER" && retailerParentType === "COMPANY")
                          ) ? (
                            <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10" style={{ fontSize: "0.8rem" }}>
                              <Building2 className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                              <span className="text-amber-300 font-medium">{parentParties[0].name}</span>
                                <span className="text-zinc-500 font-mono" style={{ fontSize: "0.7rem" }}>{parentParties[0].party_code}</span>
                            </div>
                          ) : (
                            <select required value={form.parent_party_id} onChange={(e) => setForm({ ...form, parent_party_id: e.target.value })} className={sel} style={is}>
                              <option value="">Select…</option>
                              {parentParties.map(pp => <option key={pp.id} value={pp.id}>{pp.name}</option>)}
                            </select>
                          )
                        )}
                    </div>
                  )}
              </div>

              {/* Row 3: GSTIN + PAN */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label style={lbl}>GSTIN</label>
                  <input value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value })} className={inp} style={is} placeholder="22AAAAA0000A1Z5" />
                </div>
                <div>
                  <label style={lbl}>PAN</label>
                  <input value={form.pan} onChange={(e) => setForm({ ...form, pan: e.target.value })} className={inp} style={is} placeholder="AAAAA0000A" />
                </div>
              </div>

              {/* Row 4: Address */}
              <div>
                <label style={lbl}>Address</label>
                <input value={form.address_line1} onChange={(e) => setForm({ ...form, address_line1: e.target.value })} className={inp} style={is} placeholder="Street, area, landmark" />
              </div>

              {/* Row 5: City + Pin */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label style={lbl}>City</label>
                    <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className={inp} style={is} placeholder="Kolkata" />
                  </div>
                  <div>
                    <label style={lbl}>PIN Code</label>
                    <input value={form.pin_code} onChange={(e) => setForm({ ...form, pin_code: e.target.value })} className={inp} style={is} placeholder="700001" />
                </div>
              </div>

               {/* Row 7: Group searchable dropdown — assigns the party to a group.
                   The group is the assignment source of truth; its salesman is never
                   copied onto the party itself.
                   Salesmen see this too, but the /groups API only returns the groups they
                   are assigned to, so they can only file a party into one of their own
                   groups. It stays optional for them — with no group picked, the party is
                   still auto-assigned to the creating salesman. */}
               <div>
                 <label style={lbl}>Assign Group{!isSalesman ? " *" : ""}</label>
                <div className="relative">
                    <button
                      type="button"
                      onClick={() => setGroupOpen(!groupOpen)}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border text-left ${!isSalesman && submitAttempted && !form.group_id ? "border-red-500/60 bg-red-500/[0.05]" : "border-black/10 bg-black/[0.03]"}`}
                      style={{ fontSize: "0.8rem", fontFamily: "inherit", cursor: "pointer" }}
                    >
                      <span className={selectedGroup ? "text-zinc-900" : "text-zinc-500"}>
                        {selectedGroup ? selectedGroup.name : "Select group…"}
                      </span>
                      <Tag className="w-3.5 h-3.5 text-zinc-500" />
                    </button>
                    {!isSalesman && submitAttempted && !form.group_id && (
                      <p className="mt-1 text-red-400" style={{ fontSize: "0.7rem" }}>Group is required.</p>
                    )}
                  {groupOpen && (
                    <div className="absolute z-10 w-full mt-1 bg-white border border-black/10 rounded-lg overflow-hidden shadow-xl">
                      <div className="p-2 border-b border-black/[0.06]">
                        <input
                          autoFocus
                          type="text"
                          placeholder="Search group…"
                          value={groupSearch}
                          onChange={(e) => setGroupSearch(e.target.value)}
                          className="w-full px-2 py-1.5 rounded bg-black/[0.05] text-zinc-900 placeholder:text-zinc-400 outline-none"
                          style={{ fontSize: "0.75rem", fontFamily: "inherit" }}
                        />
                      </div>
                        <div style={{ maxHeight: "180px", overflowY: "auto" }}>
                          {filteredGroups.map(g => (
                          <button
                            key={g.id}
                            type="button"
                            onClick={() => { setForm({ ...form, group_id: g.id }); setGroupOpen(false); setGroupSearch(""); }}
                            className="w-full text-left px-3 py-2 hover:bg-zinc-50 flex items-center justify-between"
                            style={{ fontSize: "0.75rem", fontFamily: "inherit", background: "none", border: "none", cursor: "pointer" }}
                          >
                            <div>
                              <span className="text-zinc-900">{g.name}</span>
                              {g.salesman_name && <span className="text-zinc-500 ml-2" style={{ fontSize: "0.65rem" }}>{g.salesman_name}</span>}
                            </div>
                            {form.group_id === g.id && <Check className="w-3 h-3 text-amber-400" />}
                          </button>
                        ))}
                        {filteredGroups.length === 0 && (
                          <div className="px-3 py-2 text-zinc-500" style={{ fontSize: "0.75rem" }}>{isSalesman ? "No groups assigned to you yet." : "No groups found. Create one in the Groups page."}</div>
                        )}
                      </div>
                    </div>
                  )}
                  </div>
                </div>

                {/* Row 8: Contact — mobile number is captured at the top of the form */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label style={lbl}>Contact Person</label>
                  <input value={form.contact_person} onChange={(e) => setForm({ ...form, contact_person: e.target.value })} className={inp} style={is} />
                </div>
                <div>
                  <label style={lbl}>Email</label>
                  <input type="email" value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} className={inp} style={is} />
                </div>
              </div>

              {/* ── Aadhaar Card Upload section ── */}
              <div className="rounded-xl border border-blue-500/20 bg-blue-500/[0.04] p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <FileText className="w-3.5 h-3.5 text-blue-400" />
                  <span className="text-blue-400 font-semibold" style={{ fontSize: "0.75rem" }}>Contact Person&apos;s Aadhaar Card</span>
                  <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>(optional)</span>
                </div>
                {aadhaarError && <div className="text-red-400 px-1" style={{ fontSize: "0.72rem" }}>{aadhaarError}</div>}
                <div className="flex items-center gap-3">
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleAadhaarUpload(file);
                    }}
                    className="hidden"
                    id="aadhaar-upload"
                    disabled={aadhaarUploading}
                  />
                  <label
                    htmlFor="aadhaar-upload"
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg cursor-pointer transition-all ${
                      aadhaarUploading 
                        ? "bg-blue-500/10 text-blue-400/50 cursor-not-allowed" 
                        : "bg-blue-500/20 text-blue-400 hover:bg-blue-500/30"
                    }`}
                    style={{ fontSize: "0.75rem", fontFamily: "inherit", border: "none" }}
                  >
                    {aadhaarUploading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Uploading...
                      </>
                    ) : (
                      <>
                        <Upload className="w-4 h-4" />
                        Upload Aadhaar
                      </>
                    )}
                  </label>
                  {form.contact_aadhaar_url && (
                    <div className="flex items-center gap-2">
                      <a
                        href={form.contact_aadhaar_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30"
                        style={{ fontSize: "0.72rem" }}
                      >
                        <ExternalLink className="w-3 h-3" />
                        View File
                      </a>
                      <button
                        type="button"
                        onClick={removeAadhaar}
                        className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        style={{ background: "none", border: "none", cursor: "pointer" }}
                        title="Remove"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
                {aadhaarFile && !form.contact_aadhaar_url && (
                  <div className="text-zinc-500" style={{ fontSize: "0.7rem" }}>
                    Selected: {aadhaarFile.name}
                  </div>
                )}
              </div>

              {/* Row 9: Credit + Payment terms */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label style={lbl}>Credit Limit (INR)</label>
                  <input type="number" value={form.credit_limit} onChange={(e) => setForm({ ...form, credit_limit: e.target.value })} className={inp} style={is} />
                </div>
                <div>
                  <label style={lbl}>Payment Terms (days)</label>
                  <input type="number" value={form.payment_terms_days} onChange={(e) => setForm({ ...form, payment_terms_days: e.target.value })} className={inp} style={is} />
                </div>
              </div>

              {/* ── GPS Location section ── */}
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <MapPin className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-emerald-400 font-semibold" style={{ fontSize: "0.75rem" }}>
                      GPS Location <span className="text-red-500">*</span>
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={getCurrentLocation}
                    disabled={gpsLoading}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 shadow-sm shadow-red-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 disabled:opacity-50 transition-all"
                    style={{ fontSize: "0.72rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}
                  >
                    {gpsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Navigation className="w-3.5 h-3.5" />}
                    {gpsLoading ? "Getting location…" : "Use Current Location"}
                  </button>
                </div>
                {gpsError && <div className="text-red-400 px-1" style={{ fontSize: "0.72rem" }}>{gpsError}</div>}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label style={lbl}>Latitude <span className="text-red-500">*</span></label>
                    <input type="number" step="any" min="-90" max="90" required aria-required="true" placeholder="e.g. 22.5726" value={form.latitude} onChange={(e) => { setForm({ ...form, latitude: e.target.value }); setGpsError(""); }} className={inp} style={is} />
                  </div>
                  <div>
                    <label style={lbl}>Longitude <span className="text-red-500">*</span></label>
                    <input type="number" step="any" min="-180" max="180" required aria-required="true" placeholder="e.g. 88.363892" value={form.longitude} onChange={(e) => { setForm({ ...form, longitude: e.target.value }); setGpsError(""); }} className={inp} style={is} />
                  </div>
                </div>
                {form.latitude && form.longitude && (
                  <a
                    href={`https://www.google.com/maps?q=${form.latitude},${form.longitude}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-emerald-400 hover:text-emerald-300 transition-colors"
                    style={{ fontSize: "0.7rem" }}
                  >
                    <ExternalLink className="w-3 h-3" /> Preview on Google Maps
                  </a>
                )}
              </div>

              {/* ── Portal Access section ── */}
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4 space-y-3">
                  <div className="flex items-center gap-2 mb-1">
                    <KeyRound className="w-3.5 h-3.5 text-amber-400" />
                    <span className="text-amber-400 font-semibold" style={{ fontSize: "0.75rem" }}>Portal Access</span>
                    <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>
                      {selectedTypeName === "COMPANY"
                        ? <><span className="text-red-400">*</span> — admin login credentials</>
                        : "— party can log in with these credentials"}
                    </span>
                  </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label style={lbl} className="flex items-center gap-1">
                        <Smartphone className="w-3 h-3" /> Portal Phone (Login ID)
                        {selectedTypeName === "COMPANY" && <span className="text-red-400">*</span>}
                      </label>
                      <div className={`${inp} flex items-center justify-between opacity-70`} style={is}>
                        <span className={form.portal_phone ? "text-zinc-900" : "text-zinc-500"}>
                          {form.portal_phone || "Auto-filled from Phone"}
                        </span>
                        <span className="text-amber-500/60 text-xs ml-2">auto</span>
                      </div>
                    </div>
                  <div>
                    <label style={lbl} className="flex items-center gap-1">
                      <KeyRound className="w-3 h-3" /> Portal Password
                      {selectedTypeName === "COMPANY" && <span className="text-red-400">*</span>}
                    </label>
                    <div className="relative">
                      <input
                        type={showPortalPassword ? "text" : "password"}
                        value={form.portal_password}
                        onChange={(e) => setForm({ ...form, portal_password: e.target.value })}
                        placeholder="Set a password"
                        className={inp}
                        style={{ ...is, paddingRight: "2.5rem" }}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPortalPassword(!showPortalPassword)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-700"
                        style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
                      >
                        {showPortalPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Error */}
              {formError && (
                <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400" style={{ fontSize: "0.8rem" }}>
                  {formError}
                </div>
              )}

              {/* Actions */}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                    onClick={() => { setShowCreate(false); setForm(emptyForm); setGpsError(""); setSubmitAttempted(false); setAadhaarFile(null); setAadhaarError(""); }}
                  className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5"
                  style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", boxShadow: "none", cursor: "pointer" }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating || !!phoneMatch || phoneChecking}
                  className="px-6 py-2 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-600 disabled:opacity-50 flex items-center gap-2"
                  style={{ fontSize: "0.8rem", fontFamily: "inherit", boxShadow: "none", cursor: "pointer", border: "none" }}
                >
                  {creating && <Loader2 className="w-4 h-4 animate-spin" />}
                  Create Party
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          PRICING MODAL
      ══════════════════════════════════════════════════════════════════════ */}
      {pricingParty && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setPricingParty(null)}>
          <div className="bg-[#ffffff] border border-black/10 rounded-2xl w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-black/[0.06]">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center">
                  <Tag className="w-4 h-4 text-purple-400" />
                </div>
                <div>
                  <h2 className="text-zinc-900 font-semibold" style={{ fontSize: "0.9rem" }}>Assign Price List</h2>
                  <p className="text-zinc-500" style={{ fontSize: "0.7rem" }}>{pricingParty.name}</p>
                </div>
              </div>
              <button onClick={() => setPricingParty(null)} className="text-zinc-600 hover:text-zinc-900" style={{ background: "none", border: "none", cursor: "pointer" }}>
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              {priceListsLoading ? (
                <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 text-amber-500 animate-spin" /></div>
              ) : priceLists.length === 0 ? (
                <p className="text-zinc-500 text-center py-8" style={{ fontSize: "0.8rem" }}>No price lists found.</p>
              ) : (
                priceLists.map((pl) => (
                  <button
                    key={pl.id}
                    onClick={() => setSelectedPriceListId(pl.id)}
                    className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all ${selectedPriceListId === pl.id ? "border-amber-500/40 bg-amber-500/10" : "border-black/[0.06] bg-black/[0.02] hover:bg-black/[0.04]"}`}
                    style={{ fontFamily: "inherit", cursor: "pointer" }}
                  >
                    <div className="text-left">
                      <div className="text-zinc-900 font-medium" style={{ fontSize: "0.8rem" }}>{pl.name}</div>
                      <div className="text-zinc-500" style={{ fontSize: "0.7rem" }}>{pl.code}{pl.applicable_party_type ? ` • ${pl.applicable_party_type.replace(/_/g, " ")}` : ""}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {pl.is_current && <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400" style={{ fontSize: "0.6rem" }}>CURRENT</span>}
                      {selectedPriceListId === pl.id && <Check className="w-4 h-4 text-amber-400" />}
                    </div>
                  </button>
                ))
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button onClick={() => setPricingParty(null)} className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5" style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}>Cancel</button>
                <button onClick={savePriceList} disabled={savingPrice} className="px-6 py-2 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-600 disabled:opacity-50 flex items-center gap-2" style={{ fontSize: "0.8rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}>
                  {savingPrice && <Loader2 className="w-4 h-4 animate-spin" />}
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          TAX TEMPLATE MODAL
      ══════════════════════════════════════════════════════════════════════ */}
      {taxParty && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setTaxParty(null)}>
          <div className="bg-[#ffffff] border border-black/10 rounded-2xl w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-black/[0.06]">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center">
                  <Receipt className="w-4 h-4 text-blue-400" />
                </div>
                <div>
                  <h2 className="text-zinc-900 font-semibold" style={{ fontSize: "0.9rem" }}>Default Tax Template</h2>
                  <p className="text-zinc-500" style={{ fontSize: "0.7rem" }}>{taxParty.name}</p>
                </div>
              </div>
              <button onClick={() => setTaxParty(null)} className="text-zinc-600 hover:text-zinc-900" style={{ background: "none", border: "none", cursor: "pointer" }}>
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-zinc-500" style={{ fontSize: "0.72rem" }}>
                The selected template will be automatically applied when creating invoices for this party.
              </p>
              {taxTemplatesLoading ? (
                <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 text-amber-500 animate-spin" /></div>
              ) : taxTemplates.length === 0 ? (
                <p className="text-zinc-500 text-center py-8" style={{ fontSize: "0.8rem" }}>No tax templates found. Create one in Tax Settings.</p>
              ) : (
                <>
                  <button
                    onClick={() => setSelectedTaxTemplateId(null)}
                    className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all ${!selectedTaxTemplateId ? "border-zinc-400/40 bg-zinc-500/10" : "border-black/[0.06] bg-black/[0.02] hover:bg-black/[0.04]"}`}
                    style={{ fontFamily: "inherit", cursor: "pointer" }}
                  >
                    <span className="text-zinc-500 italic" style={{ fontSize: "0.8rem" }}>— No default (use company default) —</span>
                    {!selectedTaxTemplateId && <Check className="w-4 h-4 text-zinc-400" />}
                  </button>
                  {taxTemplates.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setSelectedTaxTemplateId(t.id)}
                      className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all ${selectedTaxTemplateId === t.id ? "border-blue-500/40 bg-blue-500/10" : "border-black/[0.06] bg-black/[0.02] hover:bg-black/[0.04]"}`}
                      style={{ fontFamily: "inherit", cursor: "pointer" }}
                    >
                      <div className="text-left">
                        <div className="text-zinc-900 font-medium" style={{ fontSize: "0.8rem" }}>{t.product_name}</div>
                        <div className="text-zinc-500" style={{ fontSize: "0.7rem" }}>{t.gst_rate}% GST</div>
                      </div>
                      {selectedTaxTemplateId === t.id && <Check className="w-4 h-4 text-blue-400" />}
                    </button>
                  ))}
                </>
              )}
              {/* Migration required banner */}
              {migrationSql && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
                  <p className="text-amber-400 font-medium" style={{ fontSize: "0.75rem" }}>One-time database setup required</p>
                  <p className="text-zinc-500" style={{ fontSize: "0.7rem" }}>Run this SQL once in your Supabase SQL Editor, then save again:</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-2 py-1.5 rounded bg-black/10 text-zinc-800 font-mono break-all" style={{ fontSize: "0.65rem" }}>{migrationSql}</code>
                    <button
                      onClick={() => { navigator.clipboard.writeText(migrationSql); }}
                      className="shrink-0 px-2 py-1.5 rounded-lg border border-amber-500/30 text-amber-400 hover:bg-amber-500/20 transition-all"
                      style={{ fontSize: "0.65rem", fontFamily: "inherit", cursor: "pointer" }}
                      title="Copy SQL"
                    >Copy</button>
                  </div>
                </div>
              )}

              {/* Generic error */}
              {taxError && !migrationSql && (
                <p className="text-red-400" style={{ fontSize: "0.75rem" }}>{taxError}</p>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <button onClick={() => { setTaxParty(null); setTaxError(""); setMigrationSql(""); }} className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5" style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}>Cancel</button>
                <button onClick={saveTaxTemplate} disabled={savingTax} className="px-6 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 flex items-center gap-2" style={{ fontSize: "0.8rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}>
                  {savingTax && <Loader2 className="w-4 h-4 animate-spin" />}
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          MAP MODAL
      ══════════════════════════════════════════════════════════════════════ */}
      {mapParty && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setMapParty(null)}>
          <div className="bg-[#ffffff] border border-black/10 rounded-2xl w-full max-w-2xl mx-4 overflow-hidden" onClick={(e) => e.stopPropagation()}>

            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-black/[0.06]">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center">
                  <MapIcon className="w-4 h-4 text-emerald-400" />
                </div>
                <div>
                  <h2 className="text-zinc-900 font-semibold" style={{ fontSize: "0.9rem" }}>{mapParty.name}</h2>
                  <p className="text-zinc-500" style={{ fontSize: "0.7rem" }}>
                    {mapParty.party_types?.name?.replace(/_/g, " ")} &bull; {mapParty.city}
                  </p>
                </div>
              </div>
              <button onClick={() => setMapParty(null)} className="text-zinc-600 hover:text-zinc-900" style={{ background: "none", border: "none", cursor: "pointer" }}>
                <X className="w-5 h-5" />
              </button>
            </div>

            {mapParty.latitude && mapParty.longitude ? (
              <>
                {/* Google Maps embed */}
                <div className="relative w-full" style={{ height: "320px" }}>
                  <iframe
                    title="Party Location"
                    width="100%"
                    height="100%"
                    style={{ border: 0, display: "block" }}
                    loading="lazy"
                    allowFullScreen
                    src={`https://maps.google.com/maps?q=${mapParty.latitude},${mapParty.longitude}&z=15&output=embed`}
                  />
                </div>

                {/* Action bar */}
                <div className="px-5 py-4 space-y-3">
                  {/* Coordinates pill */}
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/[0.03] border border-black/[0.06]">
                    <MapPin className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                    <span className="text-zinc-600 font-mono" style={{ fontSize: "0.72rem" }}>
                      {mapParty.latitude.toFixed(6)}, {mapParty.longitude.toFixed(6)}
                    </span>
                  </div>

                  {/* Distance result banner */}
                  {distance && (
                    <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                      <Ruler className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span className="text-emerald-300" style={{ fontSize: "0.8rem" }}>
                        Distance from your location: <strong>{distance}</strong>
                      </span>
                    </div>
                  )}

                  {/* 3 action buttons */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {/* Measure distance */}
                    <button
                      onClick={measureDistance}
                      disabled={myLocLoading}
                      className="flex flex-col items-center justify-center gap-1.5 py-3 rounded-xl bg-black/[0.04] border border-black/[0.08] text-zinc-700 hover:bg-emerald-500/10 hover:border-emerald-500/30 hover:text-emerald-400 disabled:opacity-50 transition-all"
                      style={{ fontSize: "0.72rem", fontFamily: "inherit", cursor: "pointer" }}
                    >
                      {myLocLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ruler className="w-4 h-4" />}
                      {myLocLoading ? "Locating…" : "Measure Distance"}
                    </button>

                    {/* Directions — uses current location if already fetched */}
                    <a
                      href={
                        myLocation
                          ? `https://www.google.com/maps/dir/${myLocation.lat},${myLocation.lng}/${mapParty.latitude},${mapParty.longitude}`
                          : `https://www.google.com/maps/dir//${mapParty.latitude},${mapParty.longitude}`
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex flex-col items-center justify-center gap-1.5 py-3 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400 hover:bg-blue-500/20 hover:border-blue-500/40 transition-all"
                      style={{ fontSize: "0.72rem", fontFamily: "inherit", textDecoration: "none" }}
                    >
                      <Navigation className="w-4 h-4" />
                      Get Directions
                    </a>

                    {/* Open in Google Maps */}
                    <a
                      href={`https://www.google.com/maps?q=${mapParty.latitude},${mapParty.longitude}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex flex-col items-center justify-center gap-1.5 py-3 rounded-xl bg-black/[0.04] border border-black/[0.08] text-zinc-700 hover:bg-black/[0.08] hover:border-black/20 transition-all"
                      style={{ fontSize: "0.72rem", fontFamily: "inherit", textDecoration: "none" }}
                    >
                      <ExternalLink className="w-4 h-4" />
                      Open in Maps
                    </a>

                    {/* Save my location to this party */}
                    <button
                      onClick={captureMyLocationForParty}
                      disabled={myLocLoading || mapSaveLoading}
                      className="flex flex-col items-center justify-center gap-1.5 py-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-500 hover:bg-amber-500/20 hover:border-amber-500/40 disabled:opacity-50 transition-all"
                      style={{ fontSize: "0.72rem", fontFamily: "inherit", cursor: "pointer" }}
                    >
                      {(myLocLoading || mapSaveLoading) ? <Loader2 className="w-4 h-4 animate-spin" /> : <MapPin className="w-4 h-4" />}
                      {mapSaveLoading ? "Saving…" : "Add Location"}
                    </button>
                  </div>
                  {mapSaveError && (
                    <p className="text-red-500" style={{ fontSize: "0.72rem" }}>{mapSaveError}</p>
                  )}
                </div>
              </>
            ) : (
              /* No GPS data state */
              <div className="flex flex-col items-center justify-center py-16 text-zinc-500">
                <MapPin className="w-12 h-12 mb-3 opacity-20" />
                <p style={{ fontSize: "0.85rem" }}>No GPS location saved for this party.</p>
                <p className="mt-1 text-zinc-600" style={{ fontSize: "0.75rem" }}>Add location directly from here.</p>
                <button
                  onClick={captureMyLocationForParty}
                  disabled={myLocLoading || mapSaveLoading}
                  className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-600 disabled:opacity-50 transition-all"
                  style={{ fontSize: "0.8rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}
                >
                  {(myLocLoading || mapSaveLoading) ? <Loader2 className="w-4 h-4 animate-spin" /> : <MapPin className="w-4 h-4" />}
                  {mapSaveLoading ? "Saving…" : "Add My Location"}
                </button>
                <div className="mt-4 grid grid-cols-2 gap-2 w-full max-w-sm">
                  <input
                    type="number"
                    step="0.000001"
                    placeholder="Latitude"
                    value={manualLat}
                    onChange={(e) => setManualLat(e.target.value)}
                    className="px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-amber-500/40"
                    style={{ fontSize: "0.75rem", fontFamily: "inherit" }}
                  />
                  <input
                    type="number"
                    step="0.000001"
                    placeholder="Longitude"
                    value={manualLng}
                    onChange={(e) => setManualLng(e.target.value)}
                    className="px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-amber-500/40"
                    style={{ fontSize: "0.75rem", fontFamily: "inherit" }}
                  />
                </div>
                <button
                  onClick={saveManualLocation}
                  disabled={mapSaveLoading}
                  className="mt-2 inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-black/10 text-zinc-700 hover:bg-black/5 disabled:opacity-50 transition-all"
                  style={{ fontSize: "0.75rem", fontFamily: "inherit", cursor: "pointer", background: "none" }}
                >
                  {mapSaveLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  Save Manual Coordinates
                </button>
                {mapSaveError && (
                  <p className="mt-2 text-red-500" style={{ fontSize: "0.72rem" }}>{mapSaveError}</p>
                )}
              </div>
            )}
          </div>
        </div>
          )}

        </div>)}

      {/* ══════════════════════════════════════════════════════════════════════
          OPENING BALANCE MODAL
      ══════════════════════════════════════════════════════════════════════ */}
      {obParty && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setObParty(null)}>
          <div className="bg-[#ffffff] border border-black/10 rounded-2xl w-full max-w-sm mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-black/[0.06]">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-orange-500/20 flex items-center justify-center">
                  <Wallet className="w-4 h-4 text-orange-400" />
                </div>
                <div>
                  <h2 className="text-zinc-900 font-semibold" style={{ fontSize: "0.9rem" }}>Opening Balance</h2>
                  <p className="text-zinc-500" style={{ fontSize: "0.7rem" }}>{obParty.name}</p>
                </div>
              </div>
              <button onClick={() => setObParty(null)} className="text-zinc-600 hover:text-zinc-900" style={{ background: "none", border: "none", cursor: "pointer" }}>
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              {/* Info box */}
              <div className="rounded-lg bg-black/[0.03] border border-black/[0.06] p-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                      <span className="text-zinc-600" style={{ fontSize: "0.72rem" }}>Positive (e.g. <span className="font-mono text-green-400">+5000</span>)</span>
                      <span className="text-green-400" style={{ fontSize: "0.72rem" }}>You owe the party money</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-600" style={{ fontSize: "0.72rem" }}>Negative (e.g. <span className="font-mono text-red-400">-5000</span>)</span>
                      <span className="text-red-400" style={{ fontSize: "0.72rem" }}>Party owes you money</span>
                  </div>
                <div className="flex items-center justify-between">
                  <span className="text-zinc-600" style={{ fontSize: "0.72rem" }}>Zero</span>
                  <span className="text-zinc-500" style={{ fontSize: "0.72rem" }}>No balance</span>
                </div>
              </div>

              <div>
                <label style={{ fontSize: "0.75rem", display: "block", marginBottom: "0.25rem", color: "#a1a1aa" }}>
                  Opening Balance (INR)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={obValue}
                  onChange={(e) => setObValue(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-orange-500/40"
                  style={{ fontSize: "0.9rem", fontFamily: "inherit" }}
                  autoFocus
                />
                  {obValue !== "" && !isNaN(parseFloat(obValue)) && parseFloat(obValue) !== 0 && (
                    <p className={`mt-1.5 ${parseFloat(obValue) > 0 ? "text-green-400" : "text-red-400"}`} style={{ fontSize: "0.72rem" }}>
                      {parseFloat(obValue) > 0
                        ? `You owe the party ${fmt(Math.abs(parseFloat(obValue)))}`
                        : `Party owes you ${fmt(Math.abs(parseFloat(obValue)))}`}
                  </p>
                )}
              </div>

              {obError && (
                <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400" style={{ fontSize: "0.8rem" }}>
                  {obError}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-1">
                <button onClick={() => setObParty(null)} className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5" style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}>
                  Cancel
                </button>
                <button onClick={saveOpeningBalance} disabled={obSaving} className="px-6 py-2 rounded-lg bg-orange-500 text-zinc-900 hover:bg-orange-600 disabled:opacity-50 flex items-center gap-2" style={{ fontSize: "0.8rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}>
                  {obSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                  Save Balance
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          VISIT LOG MODAL
      ══════════════════════════════════════════════════════════════════════ */}
      {visitModalParty && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => { setVisitModalParty(null); setVisitNote(""); }}>
          <div className="bg-[#ffffff] border border-black/10 rounded-2xl w-full max-w-lg mx-4" style={{ maxHeight: "85vh" }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-black/[0.06]">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center">
                  <ClipboardList className="w-4 h-4 text-blue-400" />
                </div>
                <div>
                  <h2 className="text-zinc-900 font-semibold" style={{ fontSize: "0.9rem" }}>Visit Log</h2>
                  <p className="text-zinc-500" style={{ fontSize: "0.7rem" }}>{visitModalParty.name} — {visitLogs.length} visit{visitLogs.length !== 1 ? "s" : ""}</p>
                </div>
              </div>
              <button onClick={() => { setVisitModalParty(null); setVisitNote(""); }} className="text-zinc-600 hover:text-zinc-900" style={{ background: "none", border: "none", cursor: "pointer" }}>
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4 overflow-y-auto" style={{ maxHeight: "calc(85vh - 130px)" }}>
              {/* Add new visit */}
              <div className="flex gap-2">
                <input
                  value={visitNote}
                  onChange={(e) => setVisitNote(e.target.value)}
                  placeholder="Add a visit note (optional)…"
                  className="flex-1 px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-blue-500/40"
                  style={{ fontSize: "0.8rem", fontFamily: "inherit" }}
                  onKeyDown={(e) => { if (e.key === "Enter") handleAddVisit(visitModalParty.id); }}
                />
                <button
                  onClick={() => handleAddVisit(visitModalParty.id)}
                  disabled={addingVisitId === visitModalParty.id}
                  className="px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 flex items-center gap-1.5"
                  style={{ fontSize: "0.8rem", fontFamily: "inherit", border: "none", cursor: "pointer", whiteSpace: "nowrap" }}
                >
                  {addingVisitId === visitModalParty.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                  Log Visit
                </button>
              </div>

              {/* Visit logs list */}
              {visitLogsLoading ? (
                <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 text-blue-500 animate-spin" /></div>
              ) : visitLogs.length === 0 ? (
                <div className="text-center py-10 text-zinc-500">
                  <MessageSquare className="w-10 h-10 mx-auto mb-3 opacity-20" />
                  <p style={{ fontSize: "0.8rem" }}>No visits logged yet.</p>
                  <p className="mt-1 text-zinc-600" style={{ fontSize: "0.7rem" }}>Log a visit to start tracking this party.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {visitLogs.map((log) => (
                    <div key={log.id} className="flex items-start gap-3 px-3 py-2.5 rounded-lg bg-black/[0.02] border border-black/[0.04]">
                      <div className="w-7 h-7 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0 mt-0.5">
                        <span className="text-blue-400 font-medium" style={{ fontSize: "0.65rem" }}>{log.visitor_name.charAt(0).toUpperCase()}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-zinc-800 font-medium truncate" style={{ fontSize: "0.75rem" }}>{log.visitor_name}</span>
                          <span className="text-zinc-500 shrink-0" style={{ fontSize: "0.65rem" }}>
                            {new Date(log.visit_date).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })} {new Date(log.visit_date).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                        {log.notes && (
                          <p className="text-zinc-600 mt-0.5" style={{ fontSize: "0.72rem" }}>{log.notes}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* View Party Modal */}
      {viewParty && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setViewParty(null)}>
          <div className="bg-white rounded-2xl w-full max-w-lg mx-4 overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-black/[0.06]">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
                  <Building2 className="w-5 h-5 text-amber-500" />
                </div>
                <div>
                  <h2 className="text-zinc-900 font-semibold" style={{ fontSize: "0.95rem" }}>{viewParty.name}</h2>
                  <span className="text-zinc-500 font-mono" style={{ fontSize: "0.65rem" }}>{viewParty.party_code}</span>
                </div>
              </div>
              <button onClick={() => setViewParty(null)} className="p-2 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/5 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}>
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-black/[0.02] rounded-lg p-3">
                  <span className="text-zinc-500 block mb-1" style={{ fontSize: "0.7rem" }}>Type</span>
                  <span className="text-zinc-800 font-medium" style={{ fontSize: "0.8rem" }}>{viewParty.party_types?.name || "—"}</span>
                </div>
                <div className="bg-black/[0.02] rounded-lg p-3">
                  <span className="text-zinc-500 block mb-1" style={{ fontSize: "0.7rem" }}>Status</span>
                  <span className={`font-medium ${viewParty.is_verified ? "text-emerald-400" : "text-amber-400"}`} style={{ fontSize: "0.8rem" }}>
                    {viewParty.is_verified ? "Verified" : "Unverified"}
                  </span>
                </div>
              </div>
              {viewParty.trade_name && (
                <div className="bg-black/[0.02] rounded-lg p-3">
                  <span className="text-zinc-500 block mb-1" style={{ fontSize: "0.7rem" }}>Trade Name</span>
                  <span className="text-zinc-800" style={{ fontSize: "0.8rem" }}>{viewParty.trade_name}</span>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-black/[0.02] rounded-lg p-3">
                  <span className="text-zinc-500 block mb-1" style={{ fontSize: "0.7rem" }}>City</span>
                  <span className="text-zinc-800" style={{ fontSize: "0.8rem" }}>{viewParty.city || "—"}</span>
                </div>
                <div className="bg-black/[0.02] rounded-lg p-3">
                  <span className="text-zinc-500 block mb-1" style={{ fontSize: "0.7rem" }}>GSTIN</span>
                  <span className="text-zinc-800 font-mono" style={{ fontSize: "0.8rem" }}>{viewParty.gstin || "—"}</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-black/[0.02] rounded-lg p-3">
                  <span className="text-zinc-500 block mb-1" style={{ fontSize: "0.7rem" }}>Contact Person</span>
                  <span className="text-zinc-800" style={{ fontSize: "0.8rem" }}>{viewParty.contact_person || "—"}</span>
                </div>
                <div className="bg-black/[0.02] rounded-lg p-3">
                  <span className="text-zinc-500 block mb-1" style={{ fontSize: "0.7rem" }}>Admin Mobile</span>
                  <span className="text-zinc-800" style={{ fontSize: "0.8rem" }}>{viewParty.portal_phone || viewParty.phone || "—"}</span>
                </div>
              </div>
              {viewParty.contact_email && (
                <div className="bg-black/[0.02] rounded-lg p-3">
                  <span className="text-zinc-500 block mb-1" style={{ fontSize: "0.7rem" }}>Email</span>
                  <span className="text-zinc-800" style={{ fontSize: "0.8rem" }}>{viewParty.contact_email}</span>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-black/[0.02] rounded-lg p-3">
                  <span className="text-zinc-500 block mb-1" style={{ fontSize: "0.7rem" }}>Credit Limit</span>
                  <span className="text-amber-400 font-medium" style={{ fontSize: "0.8rem" }}>{fmt(Number(viewParty.credit_limit || 0))}</span>
                </div>
                <div className="bg-black/[0.02] rounded-lg p-3">
                  <span className="text-zinc-500 block mb-1" style={{ fontSize: "0.7rem" }}>Wallet Balance</span>
                  <span className={`font-medium ${(viewParty.wallet_balance || 0) + (viewParty.opening_balance || 0) < 0 ? "text-red-400" : (viewParty.wallet_balance || 0) + (viewParty.opening_balance || 0) > 0 ? "text-green-400" : "text-zinc-500"}`} style={{ fontSize: "0.8rem" }}>
                    {(() => {
                      const bal = (viewParty.wallet_balance || 0) + (viewParty.opening_balance || 0);
                      return bal === 0 ? "—" : `${bal < 0 ? "▼ " : "▲ "}${fmt(Math.abs(bal))}`;
                    })()}
                  </span>
                </div>
              </div>
              {groups.find(group => group.member_ids?.includes(viewParty.id)) && (
                <div className="bg-black/[0.02] rounded-lg p-3">
                  <span className="text-zinc-500 block mb-1" style={{ fontSize: "0.7rem" }}>Group</span>
                  <span className="text-amber-400" style={{ fontSize: "0.8rem" }}>{groups.find(group => group.member_ids?.includes(viewParty.id))?.name}</span>
                </div>
              )}
              {viewParty.latitude && viewParty.longitude && (
                <div className="bg-black/[0.02] rounded-lg p-3">
                  <span className="text-zinc-500 block mb-1" style={{ fontSize: "0.7rem" }}>GPS Location</span>
                  <a
                    href={`https://www.google.com/maps?q=${viewParty.latitude},${viewParty.longitude}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                    style={{ fontSize: "0.8rem" }}
                  >
                    <MapPin className="w-3.5 h-3.5" />
                    {viewParty.latitude.toFixed(4)}, {viewParty.longitude.toFixed(4)}
                    <ExternalLink className="w-3 h-3 ml-1" />
                  </a>
                </div>
              )}
            </div>
            <div className="px-5 py-4 border-t border-black/[0.06] flex items-center justify-between gap-3">
              <button
                onClick={() => { setViewParty(null); router.push(`/dashboard/ledgers?party_id=${viewParty.id}`); }}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-600 hover:bg-blue-500/20 transition-colors"
                style={{ fontSize: "0.8rem", fontFamily: "inherit", cursor: "pointer" }}
              >
                <CreditCard className="w-3.5 h-3.5" /> View Ledger
              </button>
              <button
                onClick={() => setViewParty(null)}
                className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5"
                style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Change Party Password Modal */}
      {passwordParty && canManagePartyPasswords && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setPasswordParty(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-black/[0.06]">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center">
                  <KeyRound className="w-5 h-5 text-emerald-500" />
                </div>
                <div>
                  <h2 className="text-zinc-900 font-semibold" style={{ fontSize: "0.95rem" }}>Change Password</h2>
                  <span className="text-zinc-500 font-mono" style={{ fontSize: "0.65rem" }}>{passwordParty.party_code}</span>
                </div>
              </div>
              <button onClick={() => setPasswordParty(null)} className="p-2 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/5 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}>
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handlePasswordSave}>
              <div className="p-5 space-y-4">
                <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-3">
                  <div className="text-zinc-900 font-medium" style={{ fontSize: "0.85rem" }}>{passwordParty.name}</div>
                  <div className="text-zinc-500" style={{ fontSize: "0.72rem" }}>{passwordParty.party_types?.name?.replace(/_/g, " ") || "Party"}</div>
                </div>

                <div>
                  <label style={lbl} className="flex items-center gap-1">
                    <Smartphone className="w-3 h-3" /> Login Mobile
                  </label>
                  <input
                    value={passwordForm.phone}
                    onChange={e => setPasswordForm(f => ({ ...f, phone: e.target.value }))}
                    className={inp}
                    style={is}
                    placeholder="Mobile number"
                    inputMode="tel"
                  />
                </div>

                <div>
                  <label style={lbl}>New Password</label>
                  <div className="relative">
                    <input
                      type={showNewPassword ? "text" : "password"}
                      value={passwordForm.new_password}
                      onChange={e => setPasswordForm(f => ({ ...f, new_password: e.target.value }))}
                      className={inp}
                      style={{ ...is, paddingRight: "2.5rem" }}
                      placeholder="New password"
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPassword(v => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-700"
                      style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
                    >
                      {showNewPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label style={lbl}>Confirm Password</label>
                  <input
                    type={showNewPassword ? "text" : "password"}
                    value={passwordForm.confirm_password}
                    onChange={e => setPasswordForm(f => ({ ...f, confirm_password: e.target.value }))}
                    className={inp}
                    style={is}
                    placeholder="Confirm password"
                    autoComplete="new-password"
                  />
                </div>

                {passwordError && (
                  <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400" style={{ fontSize: "0.8rem" }}>
                    {passwordError}
                  </div>
                )}
                {passwordSuccess && (
                  <div className="px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-500" style={{ fontSize: "0.8rem" }}>
                    {passwordSuccess}
                  </div>
                )}
              </div>

              <div className="px-5 py-4 border-t border-black/[0.06] flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setPasswordParty(null)}
                  className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5"
                  style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={savingPassword}
                  className="px-4 py-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50 flex items-center gap-1.5"
                  style={{ fontSize: "0.8rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}
                >
                  {savingPassword ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                  Save Password
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Party Modal */}
      {editParty && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setEditParty(null)}>
          <div className="bg-white rounded-2xl w-full max-w-lg mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-black/[0.06]">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-orange-500/10 flex items-center justify-center">
                  <Pencil className="w-5 h-5 text-orange-500" />
                </div>
                <div>
                  <h2 className="text-zinc-900 font-semibold" style={{ fontSize: "0.95rem" }}>Edit Party</h2>
                  <span className="text-zinc-500 font-mono" style={{ fontSize: "0.65rem" }}>{editParty.party_code}</span>
                </div>
              </div>
              <button onClick={() => setEditParty(null)} className="p-2 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/5 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}>
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleEditSave}>
              <div className="p-5 space-y-3 max-h-[65vh] overflow-y-auto">
                {/* Name */}
                <div>
                  <label style={lbl}>Party Name *</label>
                  <input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} className={inp} style={is} placeholder="Party name" />
                </div>
                {/* Trade Name */}
                <div>
                  <label style={lbl}>Trade Name</label>
                  <input value={editForm.trade_name} onChange={e => setEditForm(f => ({ ...f, trade_name: e.target.value }))} className={inp} style={is} placeholder="Trade name (optional)" />
                </div>
                {/* GSTIN */}
                <div>
                  <label style={lbl}>GSTIN</label>
                  <input value={editForm.gstin} onChange={e => setEditForm(f => ({ ...f, gstin: e.target.value.toUpperCase() }))} className={inp} style={{ ...is, fontFamily: "monospace" }} placeholder="15-char GSTIN" maxLength={15} />
                </div>
                {/* Address */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label style={lbl}>Address</label>
                    <input value={editForm.address_line1} onChange={e => setEditForm(f => ({ ...f, address_line1: e.target.value }))} className={inp} style={is} placeholder="Street / area" />
                  </div>
                  <div>
                    <label style={lbl}>City</label>
                    <input value={editForm.city} onChange={e => setEditForm(f => ({ ...f, city: e.target.value }))} className={inp} style={is} placeholder="City" />
                  </div>
                  <div>
                    <label style={lbl}>Pin Code</label>
                    <input value={editForm.pin_code} onChange={e => setEditForm(f => ({ ...f, pin_code: e.target.value }))} className={inp} style={is} placeholder="6-digit pin" maxLength={6} />
                  </div>
                </div>
                {/* Contact */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label style={lbl}>Contact Person</label>
                    <input value={editForm.contact_person} onChange={e => setEditForm(f => ({ ...f, contact_person: e.target.value }))} className={inp} style={is} placeholder="Name" />
                  </div>
                  <div>
                    <label style={lbl}>Phone</label>
                    <input value={editForm.contact_phone} onChange={e => setEditForm(f => ({ ...f, contact_phone: e.target.value }))} className={inp} style={is} placeholder="Mobile number" />
                  </div>
                </div>
                <div>
                  <label style={lbl}>Email</label>
                  <input value={editForm.contact_email} onChange={e => setEditForm(f => ({ ...f, contact_email: e.target.value }))} className={inp} style={is} placeholder="email@example.com" type="email" />
                </div>
                {/* Credit Limit */}
                <div>
                  <label style={lbl}>Credit Limit (₹)</label>
                  <input value={editForm.credit_limit} onChange={e => setEditForm(f => ({ ...f, credit_limit: e.target.value }))} className={inp} style={is} placeholder="0" type="number" min="0" />
                </div>
                {/* Group assignment — salesman access is inherited from this group. */}
                {groups.length > 0 && (
                  <div className="relative">
                    <label style={lbl}>Assign Group</label>
                    <button type="button" onClick={() => setEditGroupOpen(o => !o)}
                      className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-left"
                      style={is}>
                      <span className={groups.find(g => g.id === editForm.group_id) ? "text-zinc-900" : "text-zinc-400"}>
                        {groups.find(g => g.id === editForm.group_id)?.name || "Select group…"}
                      </span>
                      <ChevronRight className={`w-4 h-4 text-zinc-400 transition-transform ${editGroupOpen ? "rotate-90" : ""}`} />
                    </button>
                    {editGroupOpen && (
                      <div className="absolute z-20 mt-1 w-full rounded-xl border border-black/10 bg-white shadow-xl overflow-hidden">
                        <div className="p-2 border-b border-black/[0.06]">
                          <input autoFocus value={editGroupSearch} onChange={e => setEditGroupSearch(e.target.value)}
                            placeholder="Search group…" className={inp} style={{ ...is, paddingTop: "0.35rem", paddingBottom: "0.35rem" }} />
                        </div>
                        <div style={{ maxHeight: "180px", overflowY: "auto" }}>
                          <button type="button" onClick={() => { setEditForm(f => ({ ...f, group_id: "" })); setEditGroupOpen(false); }}
                            className="w-full text-left px-3 py-2 text-zinc-400 hover:bg-black/[0.03]" style={is}>
                            No group
                          </button>
                          {groups.filter(g => g.name.toLowerCase().includes(editGroupSearch.toLowerCase()) || (g.code || "").toLowerCase().includes(editGroupSearch.toLowerCase())).map(g => (
                            <button key={g.id} type="button"
                              onClick={() => { setEditForm(f => ({ ...f, group_id: g.id })); setEditGroupOpen(false); setEditGroupSearch(""); }}
                              className={`w-full text-left px-3 py-2 border-t border-black/[0.04] hover:bg-black/[0.03] ${editForm.group_id === g.id ? "bg-amber-500/10 text-amber-700 font-medium" : "text-zinc-900"}`}
                              style={is}>
                              <span className="flex items-center justify-between gap-2">
                                <span>{g.name}</span>
                                {g.salesman_name && <span className="text-zinc-400" style={{ fontSize: "0.68rem" }}>Managed by {g.salesman_name}</span>}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {editError && <p className="text-xs text-red-500">{editError}</p>}
              </div>

              <div className="px-5 py-4 border-t border-black/[0.06] flex items-center justify-end gap-3">
                <button type="button" onClick={() => setEditParty(null)}
                  className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5"
                  style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}>
                  Cancel
                </button>
                <button type="submit" disabled={savingEdit}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50 transition-colors"
                  style={{ fontSize: "0.8rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}>
                  {savingEdit ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}
