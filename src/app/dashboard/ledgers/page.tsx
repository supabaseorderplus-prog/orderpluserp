"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, getUser } from "@/lib/api";
import { formatIstDate, formatIstTime } from "@/lib/datetime";
import { AlertTriangle, BookOpen, ChevronDown, FileText, Filter, Loader2, Search, Trash2, Users, X } from "lucide-react";
import { useSearchParams } from "next/navigation";

interface Party {
  id: string;
  name: string;
  party_code: string;
  party_types: { name: string } | null;
  opening_balance: number;
  wallet_balance: number;
  salesman?: { id: string; name: string } | null;
  salesman_id?: string | null;
  phone?: string | null;
  portal_phone?: string | null;
  address?: string | null;
  address_line1?: string | null;
  city?: string | null;
  pin_code?: string | null;
}
interface Transaction {
  id: string;
  date: string;
  created_at?: string;
  type: "INVOICE" | "PAYMENT" | "TD" | "CD" | "SECURITY" | "OPENING" | "WALLET" | string;
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number | null;
}
interface CombinedTransaction extends Transaction {
  partyId: string;
  partyName: string;
  partyCode: string;
  partyType: string;
  createdAt: string;
}
interface Salesman { id: string; name: string; email?: string; partyCount: number }
interface PaymentAllocation {
  invoice_id: string;
  invoice_number: string;
  amount: number;
  source: "INVOICE" | "INVOICE_REQUEST";
}
interface PaymentAllocationDetail {
  payment_id: string;
  payment_number: string;
  payment_amount: number;
  allocated_amount: number;
  unallocated_amount: number;
  allocations: PaymentAllocation[];
}

export default function LedgersPage() {
  const searchParams = useSearchParams();
  const requestedPartyId = searchParams.get("party_id")?.trim() || null;
  const [parties, setParties] = useState<Party[]>([]);
  const [salesmenData, setSalesmenData] = useState<Omit<Salesman, 'partyCount'>[]>([]);
  const [transactions, setTransactions] = useState<CombinedTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search] = useState("");
  const [selectedParty, setSelectedParty] = useState(() => requestedPartyId || "all");
  const [selectedSalesman, setSelectedSalesman] = useState("all");

  // Delete a payment transaction. Deleting the payment row reverses the party's
  // balance AND the collector's wallet automatically — wallets are *derived*
  // from collected payments (opening + payments − invoices), so removing the
  // payment removes its contribution everywhere it was counted.
  const [deleteTarget, setDeleteTarget] = useState<CombinedTransaction | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [paymentDetailTarget, setPaymentDetailTarget] = useState<CombinedTransaction | null>(null);
  const [paymentDetail, setPaymentDetail] = useState<PaymentAllocationDetail | null>(null);
  const [paymentDetailLoading, setPaymentDetailLoading] = useState(false);
  const [paymentDetailError, setPaymentDetailError] = useState("");

  // Only ADMIN / SUPER_ADMIN may delete (reverse) a payment from the ledger.
  // Read once on mount — getUser() touches localStorage, unavailable during SSR.
  const [canDelete, setCanDelete] = useState(false);
  useEffect(() => {
    const role = getUser()?.role;
    setCanDelete(role === "ADMIN" || role === "SUPER_ADMIN");
  }, []);

  // Party picker
  const [partyDropdownOpen, setPartyDropdownOpen] = useState(false);
  const [partySearch, setPartySearch] = useState("");
  const partyDropdownRef = useRef<HTMLDivElement>(null);

  // Salesman picker
  const [salesmanDropdownOpen, setSalesmanDropdownOpen] = useState(false);
  const [salesmanSearch, setSalesmanSearch] = useState("");
  const salesmanDropdownRef = useRef<HTMLDivElement>(null);

  const fmt = (n: number) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n);

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (partyDropdownRef.current && !partyDropdownRef.current.contains(e.target as Node)) setPartyDropdownOpen(false);
      if (salesmanDropdownRef.current && !salesmanDropdownRef.current.contains(e.target as Node)) setSalesmanDropdownOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  useEffect(() => {
    setSelectedParty(requestedPartyId || "all");
  }, [requestedPartyId]);

  // Reusable loader so a delete (or any mutation) can refresh balances without
  // a full page reload. `cancelledRef` guards the initial mount unmount race.
  async function loadCombinedLedger(showSpinner = true) {
    if (showSpinner) setLoading(true);
    setError("");

    // Parties + salesmen only feed the filter dropdowns — the table doesn't
    // need them. Load them in the background so the transactions render the
    // moment the (server-cached) ledger returns, instead of waiting on the
    // much heavier 2000-party fetch.
    api<{ success: boolean; data: Party[] }>("/api/v1/parties?limit=2000&is_verified=all")
      .then((res) => setParties(res.data || []))
      .catch(() => {});
    api<{ data: { id: string; name: string; email: string }[] }>("/api/v1/parties/salesmen?limit=500")
      .then((res) => setSalesmenData(res.data || []))
      .catch(() => {});

    try {
      // One bulk, read-only combined-ledger request instead of N per-party
      // calls. The old code fired `/parties/{id}/transactions` once per party
      // (1000+ heavy, write-capable requests); over US-latency links that
      // exhausted the connection pool and — with no per-request timeout — a
      // single hung call left the page stuck on "Loading combined ledger…".
      const ledgerRes = await api<{ success: boolean; data: { transactions: CombinedTransaction[] } }>(
        requestedPartyId
          ? `/api/v1/ledger/combined?party_id=${encodeURIComponent(requestedPartyId)}`
          : "/api/v1/ledger/combined",
      );
      setTransactions(ledgerRes.data?.transactions || []);
    } catch (err) {
      setTransactions([]);
      setError(err instanceof Error ? err.message : "Failed to load combined ledger");
    } finally {
      if (showSpinner) setLoading(false);
    }
  }

  useEffect(() => {
    loadCombinedLedger();
    // Intentionally run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDeleteTransaction() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError("");
    try {
      // Payments have their own reversal route (it unwinds invoice allocations);
      // every other ledger row goes through the unified transaction endpoint.
      const tx = deleteTarget;
      const endpoint =
        tx.type === "PAYMENT"
          ? `/api/v1/payments?id=${encodeURIComponent(tx.id)}`
          : `/api/v1/ledger/transaction?type=${encodeURIComponent(tx.type)}` +
            `&id=${encodeURIComponent(tx.id)}` +
            `&partyId=${encodeURIComponent(tx.partyId)}` +
            `&reference=${encodeURIComponent(tx.reference || "")}`;
      await api(endpoint, { method: "DELETE" });
      setDeleteTarget(null);
      // Refresh in the background so reversed balances/wallets show immediately.
      await loadCombinedLedger(false);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete transaction");
    } finally {
      setDeleting(false);
    }
  }

  async function openPaymentDetail(tx: CombinedTransaction) {
    if (tx.type !== "PAYMENT") return;
    setPaymentDetailTarget(tx);
    setPaymentDetail(null);
    setPaymentDetailError("");
    setPaymentDetailLoading(true);
    try {
      const response = await api<{ success: boolean; data: PaymentAllocationDetail }>(
        `/api/v1/payments/${encodeURIComponent(tx.id)}/allocations`,
      );
      setPaymentDetail(response.data);
    } catch (err) {
      setPaymentDetailError(err instanceof Error ? err.message : "Failed to load payment allocations");
    } finally {
      setPaymentDetailLoading(false);
    }
  }

  // Per-type wording for the confirm dialog — explains exactly what reverses.
  function deleteEffectText(type: string): string {
    switch (type) {
      case "PAYMENT":
        return "removes the payment and reverses the collected amount — the party's balance and the collector's wallet are both restored.";
      case "OPENING":
        return "resets this party's opening balance to ₹0.";
      case "WALLET":
        return "removes this wallet adjustment and restores the balance to what it was before.";
      case "INVOICE":
        return "cancels this invoice and removes its amount from the party's balance.";
      case "TD":
      case "CD":
        return `removes this ${type} ledger entry and recomputes the running balance.`;
      case "SECURITY":
        return "removes this security ledger entry and recomputes the running balance.";
      default:
        return "removes this transaction and reverses its effect on the balance.";
    }
  }

  // Salesmen from dedicated endpoint, with party count from parties data
  const salesmen = useMemo<Salesman[]>(() => {
    const countMap = new Map<string, number>();
    for (const p of parties) {
      const sid = p.salesman_id || p.salesman?.id;
      if (sid) countMap.set(sid, (countMap.get(sid) || 0) + 1);
    }
    return salesmenData
      .map(s => ({ ...s, partyCount: countMap.get(s.id) || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [salesmenData, parties]);

  // Parties belonging to the selected salesman
  const partiesForSalesman = useMemo(() => {
    if (selectedSalesman === "all") return parties;
    return parties.filter(p => (p.salesman_id || p.salesman?.id) === selectedSalesman);
  }, [parties, selectedSalesman]);

  // Filtered parties for the party dropdown (search applied on top of salesman filter)
  const filteredParties = useMemo(() => {
    const q = partySearch.trim().toLowerCase();
    if (!q) return partiesForSalesman;
    return partiesForSalesman.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.party_code.toLowerCase().includes(q) ||
      (p.phone && p.phone.toLowerCase().includes(q)) ||
      (p.portal_phone && p.portal_phone.toLowerCase().includes(q)) ||
      (p.address && p.address.toLowerCase().includes(q)) ||
      (p.address_line1 && p.address_line1.toLowerCase().includes(q)) ||
      (p.city && p.city.toLowerCase().includes(q)) ||
      (p.pin_code && p.pin_code.toLowerCase().includes(q))
    );
  }, [partiesForSalesman, partySearch]);

  // Filtered salesmen for salesman dropdown search
  const filteredSalesmen = useMemo(() => {
    const q = salesmanSearch.trim().toLowerCase();
    if (!q) return salesmen;
    return salesmen.filter(s => s.name.toLowerCase().includes(q));
  }, [salesmen, salesmanSearch]);

  const selectedPartyName = useMemo(() =>
    selectedParty === "all"
      ? null
      : parties.find(p => p.id === selectedParty)?.name
        || transactions.find(tx => tx.partyId === selectedParty)?.partyName
        || null,
    [parties, transactions, selectedParty]
  );
  const selectedSalesmanName = useMemo(() =>
    selectedSalesman === "all" ? null : salesmen.find(s => s.id === selectedSalesman)?.name || null,
    [salesmen, selectedSalesman]
  );

  // Set of party IDs under the selected salesman (for transaction filter)
  const salesmanPartyIds = useMemo(() =>
    selectedSalesman === "all" ? null : new Set(partiesForSalesman.map(p => p.id)),
    [selectedSalesman, partiesForSalesman]
  );

  const filteredTransactions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return transactions.filter(tx => {
      const salesmanMatches = !salesmanPartyIds || salesmanPartyIds.has(tx.partyId);
      const partyMatches = selectedParty === "all" || tx.partyId === selectedParty;
      const searchMatches = !q || [tx.partyName, tx.partyCode, tx.type, tx.reference, tx.description]
        .some(v => String(v || "").toLowerCase().includes(q));
      return salesmanMatches && partyMatches && searchMatches;
    });
  }, [transactions, salesmanPartyIds, selectedParty, search]);

  // Once a single party is selected, every visible row is that party — drop the
  // Party column so the table doesn't repeat the same name on every line.
  const hidePartyColumn = selectedParty !== "all";

  const summary = useMemo(() => filteredTransactions.reduce(
    (acc, tx) => { acc.debit += Number(tx.debit || 0); acc.credit += Number(tx.credit || 0); acc.records++; return acc; },
    { debit: 0, credit: 0, records: 0 }
  ), [filteredTransactions]);


  const getTransactionColor = (type: string) => {
    switch (type) {
      case "INVOICE": return "bg-blue-500/10 text-blue-600 border-blue-500/20";
      case "PAYMENT": return "bg-emerald-500/10 text-emerald-600 border-emerald-500/20";
      case "TD": return "bg-amber-500/10 text-amber-600 border-amber-500/20";
      case "CD": return "bg-purple-500/10 text-purple-600 border-purple-500/20";
      case "SECURITY": return "bg-cyan-500/10 text-cyan-600 border-cyan-500/20";
      case "OPENING": return "bg-zinc-500/10 text-zinc-600 border-zinc-500/20";
      case "WALLET": return "bg-indigo-500/10 text-indigo-600 border-indigo-500/20";
      default: return "bg-zinc-500/10 text-zinc-600 border-zinc-500/20";
    }
  };

  // Reusable custom dropdown renderer
  function CustomDropdown({
    open, setOpen, label, icon, selectedLabel, onClear,
    search, setSearch, searchPlaceholder, total, children,
    dropdownRef,
  }: {
    open: boolean; setOpen: (v: boolean) => void; label: string; icon?: React.ReactNode;
    selectedLabel: string | null; onClear: () => void;
    search: string; setSearch: (v: string) => void; searchPlaceholder: string;
    total: number; children: React.ReactNode; dropdownRef: React.RefObject<HTMLDivElement>;
  }) {
    return (
      <div className="relative" ref={dropdownRef}>
        <button
          type="button"
          onClick={() => { setOpen(!open); setSearch(""); }}
          className="w-full flex items-center justify-between gap-2 rounded-lg border border-black/10 bg-white px-3 py-2.5 text-sm text-zinc-900 outline-none hover:border-black/20 focus:border-amber-500/40"
        >
          <div className="flex items-center gap-2 min-w-0">
            {icon}
            <span className="truncate text-left">
              {selectedLabel ?? <span className="text-zinc-400">{label}</span>}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {selectedLabel && (
              <span
                role="button"
                onClick={(e) => { e.stopPropagation(); onClear(); setOpen(false); }}
                className="p-0.5 rounded text-zinc-400 hover:text-zinc-700 hover:bg-black/[0.05] cursor-pointer"
              >
                <X className="w-3 h-3" />
              </span>
            )}
            <ChevronDown className={`w-4 h-4 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`} />
          </div>
        </button>

        {open && (
          <div className="absolute z-50 mt-1 w-full min-w-[300px] rounded-xl border border-black/10 bg-white shadow-xl overflow-hidden">
            <div className="p-2 border-b border-black/[0.06]">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
                <input
                  autoFocus
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={searchPlaceholder}
                  className="w-full pl-8 pr-8 py-1.5 text-sm rounded-lg border border-black/10 bg-black/[0.02] text-zinc-900 placeholder:text-zinc-400 outline-none focus:border-amber-500/40"
                />
                {search && (
                  <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700">
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
            <div style={{ maxHeight: "220px", overflowY: "auto" }}>{children}</div>
            <div className="px-3 py-1.5 border-t border-black/[0.06] bg-black/[0.01] text-xs text-zinc-400">
              {total} result{total !== 1 ? "s" : ""}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 mb-1">
            {requestedPartyId ? `${selectedPartyName || "Party"} Ledger` : "Ledgers"}
          </h1>
          <p className="text-sm text-zinc-500">
            {requestedPartyId
              ? `Transaction history for ${selectedPartyName || "this party"} only`
              : "Combined transaction history of the whole application"}
          </p>
        </div>
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-2 text-sm font-semibold text-amber-600">
          {filteredTransactions.length} records
        </div>
      </div>

      <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-4">
        <div className="rounded-xl border border-black/[0.06] bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-zinc-500">Total Debit</p>
          <p className="mt-1 font-bold text-red-500">{fmt(summary.debit)}</p>
        </div>
        <div className="rounded-xl border border-black/[0.06] bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-zinc-500">Total Credit</p>
          <p className="mt-1 font-bold text-emerald-500">{fmt(summary.credit)}</p>
        </div>
        <div className="rounded-xl border border-black/[0.06] bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-zinc-500">Net Movement</p>
          <p className={`mt-1 font-bold ${summary.credit - summary.debit >= 0 ? "text-emerald-500" : "text-red-500"}`}>{fmt(summary.credit - summary.debit)}</p>
        </div>
        <div className="rounded-xl border border-black/[0.06] bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-zinc-500">Parties Covered</p>
          <p className="mt-1 font-bold text-zinc-900">{requestedPartyId ? 1 : selectedSalesman === "all" ? parties.length : partiesForSalesman.length}</p>
        </div>
      </div>

      {requestedPartyId ? (
        <div className="mb-5 flex items-center gap-3 rounded-xl border border-blue-500/20 bg-blue-500/5 px-4 py-3">
          <BookOpen className="h-4 w-4 shrink-0 text-blue-600" />
          <div>
            <p className="text-sm font-semibold text-blue-800">{selectedPartyName || "Selected party"}</p>
            <p className="text-xs text-blue-700/70">Showing this party&apos;s ledger only</p>
          </div>
        </div>
      ) : (
      <div className="mb-5 rounded-xl border border-black/[0.06] bg-white p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">

          {/* Salesman picker */}
          <CustomDropdown
            open={salesmanDropdownOpen} setOpen={setSalesmanDropdownOpen}
            label="All salesmen" icon={<Users className="w-3.5 h-3.5 text-zinc-400 shrink-0" />}
            selectedLabel={selectedSalesmanName}
            onClear={() => setSelectedSalesman("all")}
            search={salesmanSearch} setSearch={setSalesmanSearch}
            searchPlaceholder="Search salesman…"
            total={filteredSalesmen.length}
            dropdownRef={salesmanDropdownRef as React.RefObject<HTMLDivElement>}
          >
            <button
              type="button"
              onClick={() => { setSelectedSalesman("all"); setSalesmanDropdownOpen(false); }}
              className={`w-full text-left px-3 py-2.5 text-sm transition-colors ${selectedSalesman === "all" ? "bg-amber-500/10 text-amber-700 font-medium" : "text-zinc-700 hover:bg-black/[0.03]"}`}
            >
              All salesmen
            </button>
            {filteredSalesmen.map(s => (
              <button
                key={s.id} type="button"
                onClick={() => { setSelectedSalesman(s.id); setSalesmanDropdownOpen(false); }}
                className={`w-full text-left px-3 py-2.5 border-t border-black/[0.04] transition-colors ${selectedSalesman === s.id ? "bg-amber-500/10" : "hover:bg-black/[0.03]"}`}
              >
                <div className={`text-sm font-medium ${selectedSalesman === s.id ? "text-amber-700" : "text-zinc-900"}`}>{s.name}</div>
                <div className="text-xs text-zinc-400 mt-0.5">{s.partyCount} {s.partyCount === 1 ? "party" : "parties"} in downline</div>
              </button>
            ))}
            {filteredSalesmen.length === 0 && <div className="px-3 py-6 text-sm text-zinc-400 text-center">No salesmen found</div>}
          </CustomDropdown>

          {/* Party picker — scoped to salesman's downline when a salesman is selected */}
          <CustomDropdown
            open={partyDropdownOpen} setOpen={setPartyDropdownOpen}
            label={selectedSalesman === "all" ? "All parties" : `All parties (${partiesForSalesman.length})`}
            selectedLabel={selectedPartyName}
            onClear={() => setSelectedParty("all")}
            search={partySearch} setSearch={setPartySearch}
            searchPlaceholder="Search name, phone, address, pin code…"
            total={filteredParties.length}
            dropdownRef={partyDropdownRef as React.RefObject<HTMLDivElement>}
          >
            <button
              type="button"
              onClick={() => { setSelectedParty("all"); setPartyDropdownOpen(false); }}
              className={`w-full text-left px-3 py-2.5 text-sm transition-colors ${selectedParty === "all" ? "bg-amber-500/10 text-amber-700 font-medium" : "text-zinc-700 hover:bg-black/[0.03]"}`}
            >
              {selectedSalesman === "all" ? "All parties" : `All parties in downline (${partiesForSalesman.length})`}
            </button>
            {filteredParties.map(party => {
              const phone = party.phone || party.portal_phone;
              const address = party.address_line1 || party.address;
              const isSelected = selectedParty === party.id;
              return (
                <button
                  key={party.id} type="button"
                  onClick={() => { setSelectedParty(party.id); setPartyDropdownOpen(false); }}
                  className={`w-full text-left px-3 py-2.5 border-t border-black/[0.04] transition-colors ${isSelected ? "bg-amber-500/10" : "hover:bg-black/[0.03]"}`}
                >
                  <div className={`text-sm font-medium truncate ${isSelected ? "text-amber-700" : "text-zinc-900"}`}>{party.name}</div>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    <span className="text-xs font-mono text-zinc-400">{party.party_code}</span>
                    {phone && <span className="text-xs text-zinc-400">{phone}</span>}
                    {(address || party.pin_code) && (
                      <span className="text-xs text-zinc-400 truncate">{[address, party.pin_code].filter(Boolean).join(" · ")}</span>
                    )}
                  </div>
                </button>
              );
            })}
            {filteredParties.length === 0 && <div className="px-3 py-6 text-sm text-zinc-400 text-center">No parties found</div>}
          </CustomDropdown>
        </div>

        {/* Active filter pills */}
        {(selectedSalesman !== "all" || selectedParty !== "all") && (
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            {selectedSalesman !== "all" && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-xs font-medium text-amber-700">
                <Users className="w-3 h-3" /> {selectedSalesmanName}
                <button onClick={() => setSelectedSalesman("all")} className="ml-0.5 hover:text-amber-900"><X className="w-2.5 h-2.5" /></button>
              </span>
            )}
            {selectedParty !== "all" && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-xs font-medium text-blue-700">
                {selectedPartyName}
                <button onClick={() => setSelectedParty("all")} className="ml-0.5 hover:text-blue-900"><X className="w-2.5 h-2.5" /></button>
              </span>
            )}
          </div>
        )}
      </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20 text-zinc-500">
          <Loader2 className="mr-2 h-6 w-6 animate-spin text-amber-500" /> Loading combined ledger...
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">{error}</div>
      ) : filteredTransactions.length === 0 ? (
        <div className="text-center py-20 text-zinc-500">
          <BookOpen className="w-12 h-12 mx-auto mb-4 opacity-30" />
          <p>No transactions found</p>
        </div>
      ) : (
        <div className="rounded-xl border border-black/[0.06] bg-white overflow-hidden">
          <div className="flex items-center gap-2 border-b border-black/[0.06] bg-black/[0.02] px-4 py-3 text-xs font-medium uppercase tracking-wide text-zinc-500">
            <Filter className="h-3.5 w-3.5" /> {requestedPartyId ? `${selectedPartyName || "Party"} Transaction History` : "Combined Transaction History"}
          </div>
          <div className="overflow-x-auto" style={{ maxHeight: "calc(100vh - 340px)", overflowY: "auto" }}>
            <table className="no-mobile-scroll w-full" style={{ borderCollapse: "collapse" }}>
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-black/[0.06]">
                  {/* Party column is redundant once a single party is filtered — every row is that party */}
                  {["Date", ...(hidePartyColumn ? [] : ["Party"]), "Type", "Note", "Debit", "Credit", "Balance"].map(h => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-medium text-zinc-500 bg-white uppercase tracking-wider">{h}</th>
                  ))}
                  {canDelete && (
                    <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 bg-white uppercase tracking-wider">Action</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {filteredTransactions.map((tx: CombinedTransaction) => (
                  <tr
                    key={`${tx.partyId}-${tx.id}`}
                    onClick={() => openPaymentDetail(tx)}
                    onKeyDown={(event) => {
                      if (tx.type === "PAYMENT" && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault();
                        openPaymentDetail(tx);
                      }
                    }}
                    tabIndex={tx.type === "PAYMENT" ? 0 : undefined}
                    title={tx.type === "PAYMENT" ? "View invoice allocation" : undefined}
                    className={`border-b border-black/[0.04] hover:bg-black/[0.015] ${tx.type === "PAYMENT" ? "cursor-pointer focus:bg-emerald-500/[0.04] focus:outline-none" : ""}`}
                  >
                    <td className="px-4 py-3 text-sm text-zinc-600 whitespace-nowrap">
                      <div>{formatIstDate(tx.date)}</div>
                      <div className="text-xs text-zinc-400 mt-0.5">{formatIstTime(tx.date)}</div>
                    </td>
                    {!hidePartyColumn && (
                      <td className="px-4 py-3">
                        <div className="text-sm font-medium text-zinc-900">{tx.partyName}</div>
                        <div className="text-xs font-mono text-zinc-400">{tx.partyCode} · {tx.partyType}</div>
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <span className={`inline-block rounded border px-2 py-0.5 text-xs ${getTransactionColor(tx.type)}`}>{tx.type}</span>
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-700">
                      <div className="flex items-center gap-2">
                        <span>{tx.description || "-"}</span>
                        {tx.type === "PAYMENT" && <FileText className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-label="View invoice allocation" />}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-red-500">{tx.debit > 0 ? fmt(tx.debit) : "-"}</td>
                    <td className="px-4 py-3 text-sm font-medium text-emerald-500">{tx.credit > 0 ? fmt(tx.credit) : "-"}</td>
                    <td className={`px-4 py-3 text-sm font-medium ${tx.balance === null ? "text-zinc-400" : tx.balance < 0 ? "text-red-500" : tx.balance > 0 ? "text-emerald-500" : "text-zinc-500"}`}>
                      {tx.balance === null ? "-" : fmt(tx.balance)}
                    </td>
                    {canDelete && (
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={(event) => { event.stopPropagation(); setDeleteTarget(tx); setDeleteError(""); }}
                          title="Delete this transaction & reverse its effect"
                          className="inline-flex items-center justify-center rounded-md p-1.5 text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-600"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-black/[0.06] px-4 py-2 bg-black/[0.01] text-xs text-zinc-400 text-right">
            {filteredTransactions.length} records
          </div>
        </div>
      )}

      {/* Payment → invoice allocation detail */}
      {paymentDetailTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setPaymentDetailTarget(null); }}
        >
          <div className="w-full max-w-lg rounded-2xl border border-black/[0.06] bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
                    <FileText className="h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-zinc-900">Payment invoice allocation</h3>
                    <p className="text-xs font-mono text-zinc-400">{paymentDetailTarget.reference}</p>
                  </div>
                </div>
                <p className="mt-3 text-sm text-zinc-500">
                  {paymentDetailTarget.partyName} · {fmt(paymentDetailTarget.credit)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPaymentDetailTarget(null)}
                className="rounded-md p-1.5 text-zinc-400 hover:bg-black/[0.05] hover:text-zinc-700"
                aria-label="Close payment detail"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-5">
              {paymentDetailLoading ? (
                <div className="flex items-center justify-center py-10 text-sm text-zinc-500">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin text-emerald-500" /> Loading invoice allocation…
                </div>
              ) : paymentDetailError ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-600">{paymentDetailError}</div>
              ) : paymentDetail ? (
                <div className="space-y-3">
                  {paymentDetail.allocations.length > 0 ? (
                    <div className="overflow-hidden rounded-xl border border-black/[0.06]">
                      {paymentDetail.allocations.map((allocation, index) => (
                        <div key={`${allocation.source}-${allocation.invoice_id}-${index}`} className="flex items-center justify-between gap-4 border-b border-black/[0.05] px-4 py-3 last:border-b-0">
                          <div className="min-w-0">
                            <div className="text-xs uppercase tracking-wide text-zinc-400">Invoice</div>
                            <div className="truncate font-mono text-sm font-semibold text-zinc-900">{allocation.invoice_number}</div>
                          </div>
                          <div className="text-right">
                            <div className="text-xs text-zinc-400">Payment taken</div>
                            <div className="text-sm font-semibold text-emerald-600">{fmt(allocation.amount)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-700">
                      This payment was not assigned to a specific invoice. It was recorded as an advance/unallocated payment.
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-lg bg-black/[0.025] px-3 py-2.5">
                      <div className="text-xs text-zinc-400">Allocated</div>
                      <div className="mt-0.5 text-sm font-semibold text-zinc-900">{fmt(paymentDetail.allocated_amount)}</div>
                    </div>
                    <div className="rounded-lg bg-black/[0.025] px-3 py-2.5">
                      <div className="text-xs text-zinc-400">Advance / unallocated</div>
                      <div className="mt-0.5 text-sm font-semibold text-zinc-900">{fmt(paymentDetail.unallocated_amount)}</div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* Delete-transaction confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-black/[0.06] bg-white p-6 shadow-xl">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-red-500/10 text-red-500">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-zinc-900">Delete this {deleteTarget.type.toLowerCase()} transaction?</h3>
                <p className="mt-1 text-sm text-zinc-500">
                  This permanently {deleteEffectText(deleteTarget.type)} This cannot be undone.
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-black/[0.06] bg-black/[0.015] px-4 py-3 text-sm">
              <div className="font-medium text-zinc-900">{deleteTarget.partyName}</div>
              <div className="text-xs font-mono text-zinc-400">{deleteTarget.partyCode} · {deleteTarget.reference || "—"}</div>
              <div className="mt-2 font-semibold text-zinc-900">{fmt(deleteTarget.credit || deleteTarget.debit)}</div>
            </div>

            {deleteError && (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{deleteError}</div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setDeleteTarget(null); setDeleteError(""); }}
                disabled={deleting}
                className="rounded-lg border border-black/[0.08] px-4 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-black/[0.03] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteTransaction}
                disabled={deleting}
                className="inline-flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
              >
                {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                {deleting ? "Deleting…" : "Delete & reverse"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
