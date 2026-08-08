"use client";

import React, { useEffect, useState, useCallback, useRef, useDeferredValue } from "react";
import { api, getUser } from "@/lib/api";
import {
    AlertCircle, Building2, ChevronDown, ChevronUp,
    Clock3, CreditCard, FileText, Loader2, MinusCircle, Plus, Search, Trash2, TrendingUp, Users, Wallet, X,
  } from "lucide-react";

  interface Party { id: string; name: string; party_code: string; opening_balance: number; wallet_balance: number }
interface OutstandingInvoice {
  id: string; invoice_number: string; invoice_date: string; grand_total: number;
  amount_paid: number; amount_outstanding: number; payment_status: string;
}
interface OutstandingParty {
  party_id: string; party_name: string; party_code: string; party_type: string | null;
  total_outstanding: number; invoice_count: number; oldest_invoice_date: string;
  invoices: OutstandingInvoice[];
}
interface Invoice { id: string; invoice_number: string; grand_total: number; amount_outstanding: number; billing_party_id: string; invoice_date: string; amount_paid?: number; payment_status?: string }

// Oldest invoice first (FIFO): earliest date on top, invoice_number as tiebreaker.
// Used for both the displayed list and payment allocation so they always agree.
function sortInvoicesOldestFirst(list: Invoice[]): Invoice[] {
  return [...list].sort((a, b) => {
    const da = new Date(a.invoice_date).getTime();
    const db = new Date(b.invoice_date).getTime();
    if (da !== db) return da - db;
    return a.invoice_number.localeCompare(b.invoice_number);
  });
}
interface Payment { id: string; payment_number: string; amount: number; parties?: { name: string } }
interface PendingPayment {
  request_number: string;
  party_id: string;
  amount: number;
  collector_name: string;
  collector_id: string | null;
  initiated_at: string;
  expires_at: string;
  status: "ACTIVE" | "PROCESSING";
}
interface WalletTransaction {
  id: string;
  party_id: string;
  type: string;
  amount: number;
  created_at: string;
  description?: string;
}
interface StatementTransaction {
  id: string;
  date: string;
  type: string;
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number | null;
}
interface StatementSummary {
  currentBalance: number;
  openingBalance: number;
}
interface AppUser { id: string; name: string; role: string; isActive: boolean; }
interface UserWallet { id: string; owner_id: string; wallet_type: string; balance: number; }
interface CreditData {
  party_id: string
  score: number | null
  band: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'VERY_POOR' | null
  recommendation: string
  score_components: Record<string, { score: number; max: number; label: string }> | null
    metrics: {
      total_invoices: number; total_invoiced: number; total_paid: number; total_outstanding: number
      payment_rate: number; avg_outstanding_days: number; payment_frequency: number
      avg_monthly_invoiced: number; avg_monthly_payment: number; avg_monthly_repayment_yearly: number
      avg_monthly_invoice_count: number; avg_monthly_payment_count: number
      active_months: number; unpaid_invoice_count: number
    } | null
    yearly_breakdown: Array<{
      year: number; invoiced: number; paid: number; payment_amount: number
      invoice_count: number; payment_count: number; payment_rate: number; avg_monthly_repayment: number
    }>
  }

interface ActiveScheme {
  id: string;
  name: string;
  description?: string | null;
  scheme_type: string;
  reward_type?: string | null;
  reward_description?: string | null;
  target_value: number;
  end_date: string;
  progress: { current_value: number; target_value: number; progress_percent: number; is_achieved: boolean };
}

function buildFallbackCreditDataFromOutstanding(party: OutstandingParty): CreditData | null {
  const invoices = (party.invoices || []).filter((invoice) => Number(invoice.grand_total || 0) > 0);
  if (invoices.length === 0) return null;

  const totalInvoiced = invoices.reduce((sum, invoice) => sum + Number(invoice.grand_total || 0), 0);
  const totalPaid = invoices.reduce((sum, invoice) => sum + Number(invoice.amount_paid || 0), 0);
  const totalOutstanding = invoices.reduce((sum, invoice) => sum + Number(invoice.amount_outstanding || 0), 0);
  const paymentRate = totalInvoiced > 0 ? (totalPaid / totalInvoiced) * 100 : 0;

  let rawScore = 0;
  if (paymentRate >= 90) rawScore = 80;
  else if (paymentRate >= 70) rawScore = 60;
  else if (paymentRate >= 40) rawScore = 40;
  else if (paymentRate >= 20) rawScore = 25;
  else rawScore = 15;

  const score = Math.round(300 + (rawScore / 100) * 600);

  let band: CreditData["band"] = "VERY_POOR";
  if (score >= 750) band = "EXCELLENT";
  else if (score >= 650) band = "GOOD";
  else if (score >= 550) band = "FAIR";
  else if (score >= 450) band = "POOR";

  const recommendation =
    band === "EXCELLENT"
      ? "Highly trustworthy. Safe to extend significant credit with standard terms."
      : band === "GOOD"
      ? "Good payment history. Credit can be extended with normal terms."
      : band === "FAIR"
      ? "Moderate risk. Consider shorter credit periods or partial advance."
      : band === "POOR"
      ? "High risk. Limit credit exposure and monitor closely."
      : "Very high risk. Avoid extending credit or require full advance payment.";

  return {
    party_id: party.party_id,
    score,
    band,
    recommendation,
    score_components: {
      payment_rate: { score: Math.round(rawScore), max: 100, label: "Payment Rate (fallback)" },
    },
    metrics: {
      total_invoices: invoices.length,
      total_invoiced: Math.round(totalInvoiced),
      total_paid: Math.round(totalPaid),
      total_outstanding: Math.round(totalOutstanding),
      payment_rate: Math.round(paymentRate * 10) / 10,
      avg_outstanding_days: 0,
      payment_frequency: 0,
      avg_monthly_invoiced: Math.round(totalInvoiced / Math.max(1, invoices.length)),
      avg_monthly_payment: Math.round(totalPaid / Math.max(1, invoices.length)),
      avg_monthly_repayment_yearly: Math.round(totalPaid / 12),
      avg_monthly_invoice_count: Math.round((invoices.length / 12) * 10) / 10,
      avg_monthly_payment_count: 0,
      active_months: Math.max(1, invoices.length),
      unpaid_invoice_count: invoices.filter((invoice) => Number(invoice.amount_outstanding || 0) > 0).length,
    },
    yearly_breakdown: [],
  };
}

  const css: React.CSSProperties = { transform: "none", filter: "none", WebkitTextStroke: "0", background: "none", boxShadow: "none", display: "block", padding: 0 };
const fmt = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

export default function PaymentsPage() {
  const [tab, setTab] = useState<"outstanding" | "wallets" | "parties">("outstanding");
  const [walletSearch, setWalletSearch] = useState("");
  const [partySearch, setPartySearch] = useState("");

  // --- Outstanding state ---
  const [outstanding, setOutstanding] = useState<OutstandingParty[]>([]);
  const [outstandingLoading, setOutstandingLoading] = useState(true);
  const [expandedParty, setExpandedParty] = useState<string | null>(null);
  const [outstandingSearch, setOutstandingSearch] = useState("");

    // --- User wallets state ---
  const [appUsers, setAppUsers] = useState<AppUser[]>([]);
  const [userWallets, setUserWallets] = useState<UserWallet[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [walletTransactions, setWalletTransactions] = useState<WalletTransaction[]>([]);
  const [walletTxnLoading, setWalletTxnLoading] = useState(false);

  // --- Collect payment modal state ---
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState("");
  const [automationNotice, setAutomationNotice] = useState("");
  const [parties, setParties] = useState<Party[]>([]);
  const [pendingPayments, setPendingPayments] = useState<PendingPayment[]>([]);
  const [pendingDeleteTarget, setPendingDeleteTarget] = useState<PendingPayment | null>(null);
  const [pendingDeleting, setPendingDeleting] = useState(false);
  const [pendingDeleteError, setPendingDeleteError] = useState("");
  const [outstandingInvoices, setOutstandingInvoices] = useState<Invoice[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [selectedAdj, setSelectedAdj] = useState<Record<string, number>>({});
  const [partyDue, setPartyDue] = useState<number | null>(null);
  const [lockedPartyId, setLockedPartyId] = useState<string | null>(null);
  const [form, setForm] = useState({
    party_id: "", amount: "", payment_mode: "CASH", reference_number: "", bank_name: "", proof_url: "", is_advance: false, notes: "",
  });
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [proofPreview, setProofPreview] = useState<string | null>(null);
  const [proofUploading, setProofUploading] = useState(false);
  const [proofError, setProofError] = useState("");

	  // --- Scheme popup state (check before recording payment) ---
	  const [schemePopupSchemes, setSchemePopupSchemes] = useState<ActiveScheme[] | null>(null);
	  const [selectedSchemeIds, setSelectedSchemeIds] = useState<string[]>([]);
	  const [schemeCheckLoading, setSchemeCheckLoading] = useState(false);

  // --- Delete state ---
  const [deleteTarget, setDeleteTarget] = useState<Payment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  // --- Topup state ---
  const [topupParty, setTopupParty] = useState<Party | null>(null);
  const [topupAmount, setTopupAmount] = useState("");
  const [topupNote, setTopupNote] = useState("");
  const [topupLoading, setTopupLoading] = useState(false);
  const [topupError, setTopupError] = useState("");

  // --- Deduct state (mirror of top-up, subtracts; balance may go negative) ---
  const [deductParty, setDeductParty] = useState<Party | null>(null);
  const [deductAmount, setDeductAmount] = useState("");
  const [deductNote, setDeductNote] = useState("");
  const [deductLoading, setDeductLoading] = useState(false);
  const [deductError, setDeductError] = useState("");

  // --- Wallet statement modal state ---
  const [statementParty, setStatementParty] = useState<Party | null>(null);
  const [statementTransactions, setStatementTransactions] = useState<StatementTransaction[]>([]);
  const [statementSummary, setStatementSummary] = useState<StatementSummary | null>(null);
  const [statementLoading, setStatementLoading] = useState(false);
  const [statementError, setStatementError] = useState("");
  // Reversible payments for the open statement, keyed by payment_number → the
  // underlying payment row. Lets a statement payment line surface a Cancel button
  // that reverses the actual payment record (wallet + invoice allocations).
  const [statementPayments, setStatementPayments] = useState<Record<string, Payment>>({});

  // Only ADMIN / SUPER_ADMIN may reverse (cancel) a recorded payment. The DELETE
  // endpoint enforces this server-side too; here we just hide the button.
  const [isAdmin] = useState(() => {
    const u = getUser();
    return u?.role === "ADMIN" || u?.role === "SUPER_ADMIN";
  });

  // --- Credit analysis state ---
  const [creditPartyId, setCreditPartyId] = useState<string | null>(null);
  const [creditPartyName, setCreditPartyName] = useState("");
  const [creditData, setCreditData] = useState<CreditData | null>(null);
  const [creditLoading, setCreditLoading] = useState(false);
  const [creditError, setCreditError] = useState("");
  const [creditScoresMap, setCreditScoresMap] = useState<Record<string, { score: number | null; band: string | null; data: CreditData | null }>>({});
  const fetchedScores = useRef<Set<string>>(new Set());

  const validOutstanding = React.useMemo(() => {
    if (parties.length === 0) return outstanding;
    const validIds = new Set(parties.map((party) => party.id));
    return outstanding.filter((party) => validIds.has(party.party_id));
  }, [outstanding, parties]);

  // Parties with negative wallet balance (party owes you) not already in invoice outstanding
  const walletDueParties = React.useMemo(() => {
    const outstandingIds = new Set(validOutstanding.map(p => p.party_id));
    return parties.filter(p => {
      const eff = (Number(p.opening_balance) || 0) + (Number(p.wallet_balance) || 0);
      return eff < 0 && !outstandingIds.has(p.id);
    });
  }, [parties, validOutstanding]);

  // "Collect from party" tab list — filter + sort.
  // Deferred so the search input stays responsive while the (potentially large)
  // list re-renders, and null-safe so a party with a missing name/code can't
  // crash the whole search with `.toLowerCase()` on undefined.
  const deferredPartySearch = useDeferredValue(partySearch);
  const collectParties = React.useMemo(() => {
    const q = deferredPartySearch.trim().toLowerCase();
    const filtered = q
      ? parties.filter(p =>
          (p.name || "").toLowerCase().includes(q) ||
          (p.party_code || "").toLowerCase().includes(q)
        )
      : parties;
    // Sort: parties with negative balance (owe you) first, then zero, then positive
    return [...filtered].sort((a, b) => {
      const ea = Number(a.opening_balance || 0) + Number(a.wallet_balance || 0);
      const eb = Number(b.opening_balance || 0) + Number(b.wallet_balance || 0);
      if (ea < 0 && eb >= 0) return -1;
      if (eb < 0 && ea >= 0) return 1;
      return (a.name || "").localeCompare(b.name || "");
    });
  }, [parties, deferredPartySearch]);

	  const CREDIT_BAND_COLORS: Record<string, { bg: string; border: string; text: string }> = {
	    EXCELLENT: { bg: 'rgba(16,185,129,0.1)', border: 'rgba(16,185,129,0.25)', text: '#10b981' },
	    GOOD: { bg: 'rgba(34,197,94,0.1)', border: 'rgba(34,197,94,0.25)', text: '#22c55e' },
	    FAIR: { bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.25)', text: '#f59e0b' },
	    POOR: { bg: 'rgba(249,115,22,0.1)', border: 'rgba(249,115,22,0.25)', text: '#f97316' },
	    VERY_POOR: { bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.25)', text: '#ef4444' },
	  };

	  function getWalletCreditFallback(party: Party) {
	    const effectiveBalance = Number(party.opening_balance || 0) + Number(party.wallet_balance || 0);
	    const exposure = Math.abs(Math.min(effectiveBalance, 0));
	    if (exposure >= 100000) return { score: 420, band: "VERY_POOR" };
	    if (exposure >= 50000) return { score: 510, band: "POOR" };
	    if (exposure > 0) return { score: 590, band: "FAIR" };
	    if (effectiveBalance > 0) return { score: 760, band: "EXCELLENT" };
	    return { score: 700, band: "GOOD" };
	  }

  // Fetch outstanding
  const fetchOutstanding = useCallback(() => {
    setOutstandingLoading(true);
    api<{ success: boolean; data: OutstandingParty[] }>("/api/v1/payments/outstanding")
      .then(r => setOutstanding(r.data || []))
      .catch(() => setOutstanding([]))
      .finally(() => setOutstandingLoading(false));
  }, []);

    // Fetch parties — load EVERY party, not just the first page.
    // This list backs all three tabs (validOutstanding filters by it), so a fixed
    // cap here silently hides parties. We pull a generous first page, read the true
    // total from the API's pagination, and fetch the remaining pages in parallel so
    // the count scales to thousands of parties instead of stopping at a hard limit.
    const fetchParties = useCallback(async () => {
      const PAGE_SIZE = 5000;
      try {
        const first = await api<{ success: boolean; data: Party[]; pagination?: { total?: number } }>(
          `/api/v1/parties?limit=${PAGE_SIZE}&page=1&is_verified=all`
        );
        const firstRows = first.data || [];
        const total = first.pagination?.total ?? firstRows.length;
        if (firstRows.length >= total) {
          setParties(firstRows);
          return;
        }
        const totalPages = Math.ceil(total / PAGE_SIZE);
        const restPages = await Promise.all(
          Array.from({ length: totalPages - 1 }, (_, i) =>
            api<{ success: boolean; data: Party[] }>(
              `/api/v1/parties?limit=${PAGE_SIZE}&page=${i + 2}&is_verified=all`
            ).then(r => r.data || []).catch(() => [] as Party[])
          )
        );
        setParties([...firstRows, ...restPages.flat()]);
      } catch {
        /* keep prior silent-failure behavior — leave existing parties untouched */
      }
    }, []);

    // Initiated collections are not real payments until the party approves the
    // acknowledgement link, so they need their own feed. This lets every party
    // card show the pending amount and the salesman who initiated it.
    const fetchPendingPayments = useCallback(async () => {
      try {
        const response = await api<{ success: boolean; data: PendingPayment[] }>("/api/v1/payments/pending");
        setPendingPayments(response.data || []);
      } catch {
        setPendingPayments([]);
      }
    }, []);

    // Fetch app users and their wallets
    const fetchAppUsersAndWallets = useCallback(async () => {
      setUsersLoading(true);
      try {
        const [usersRes, walletsRes] = await Promise.all([
          api<{ data: AppUser[] }>('/api/v1/users?limit=200'),
          api<{ success: boolean; data: UserWallet[] }>('/api/v1/wallets'),
        ]);
        setAppUsers(usersRes.data || []);
        setUserWallets(walletsRes.data || []);
      } catch { setAppUsers([]); setUserWallets([]); }
      finally { setUsersLoading(false); }
    }, []);

  // Fetch wallet transactions for Wallet Balances table
  const fetchWalletTransactions = useCallback(async () => {
    setWalletTxnLoading(true);
    try {
      const res = await api<{ success: boolean; data: WalletTransaction[] }>("/api/v1/wallet-transactions?limit=5000");
      setWalletTransactions(res.data || []);
    } catch {
      setWalletTransactions([]);
    } finally {
      setWalletTxnLoading(false);
    }
  }, []);

      useEffect(() => { fetchOutstanding(); }, [fetchOutstanding]);
      useEffect(() => { fetchParties(); }, [fetchParties]);
      useEffect(() => { fetchPendingPayments(); }, [fetchPendingPayments]);
      useEffect(() => { fetchAppUsersAndWallets(); }, [fetchAppUsersAndWallets]);
      useEffect(() => { fetchWalletTransactions(); }, [fetchWalletTransactions]);

  // Auto-fetch credit scores for all outstanding parties (background, lazy)
  useEffect(() => {
    if (validOutstanding.length === 0) return;
    validOutstanding.forEach(party => {
        if (fetchedScores.current.has(party.party_id)) return;
        fetchedScores.current.add(party.party_id);
        api<{ success: boolean; data: CreditData }>(`/api/v1/credit-analysis?party_id=${party.party_id}`)
          .then(r => {
            if (r?.data) {
              setCreditScoresMap(prev => ({
                ...prev,
                [party.party_id]: { score: r.data.score, band: r.data.band, data: r.data },
              }));
            } else {
              setCreditScoresMap(prev => ({ ...prev, [party.party_id]: { score: null, band: null, data: null } }));
            }
          })
          .catch(() => {
            setCreditScoresMap(prev => ({ ...prev, [party.party_id]: { score: null, band: null, data: null } }));
          });
      });
  }, [validOutstanding]);

  // Also fetch credit scores for all parties (for All Parties tab cards)
  useEffect(() => {
    if (parties.length === 0) return;
    parties.forEach(party => {
        if (fetchedScores.current.has(party.id)) return;
        fetchedScores.current.add(party.id);
        api<{ success: boolean; data: CreditData }>(`/api/v1/credit-analysis?party_id=${party.id}`)
          .then(r => {
            if (r?.data) {
              setCreditScoresMap(prev => ({
                ...prev,
                [party.id]: { score: r.data.score, band: r.data.band, data: r.data },
              }));
            } else {
              setCreditScoresMap(prev => ({ ...prev, [party.id]: { score: null, band: null, data: null } }));
            }
          })
          .catch(() => {
            setCreditScoresMap(prev => ({ ...prev, [party.id]: { score: null, band: null, data: null } }));
          });
      });
  }, [parties]);

  // Load invoices whenever the selected party changes
  // Merges both standalone invoices (/api/v1/invoices) and confirmed invoice-requests
  useEffect(() => {
    if (!form.party_id) { setOutstandingInvoices([]); setPartyDue(null); return; }
    const selectedParty = parties.find(p => p.id === form.party_id);
    const openingBal = selectedParty ? Number(selectedParty.opening_balance) + Number(selectedParty.wallet_balance || 0) : 0;

    // Instant seed: the /payments/outstanding payload (already loaded on page mount)
    // carries a full invoices[] per party — both standalone invoices and confirmed
    // invoice-requests. Render them synchronously so the modal shows invoices in <1s
    // instead of blocking on the two network calls below. The fetch still runs to
    // reconcile any very-recent changes, but it no longer gates first paint.
    const cachedParty = outstanding.find(p => p.party_id === form.party_id);
    const cachedInvoices: Invoice[] = (cachedParty?.invoices || [])
      .filter(inv => Number(inv.grand_total || 0) > 0)
      .map(inv => ({
        id: inv.id,
        invoice_number: inv.invoice_number,
        grand_total: Number(inv.grand_total),
        amount_outstanding: Number(inv.amount_outstanding),
        amount_paid: Number(inv.amount_paid),
        payment_status: inv.payment_status,
        billing_party_id: form.party_id,
        invoice_date: inv.invoice_date,
      }));
    if (cachedInvoices.length > 0) {
      setOutstandingInvoices(sortInvoicesOldestFirst(cachedInvoices));
    }
    // Only show the spinner when there's nothing cached to show.
    setInvoicesLoading(cachedInvoices.length === 0);

    Promise.all([
      api<{ success: boolean; data: Invoice[] }>(`/api/v1/invoices?party_id=${form.party_id}&limit=200`).catch(() => ({ data: [] as Invoice[] })),
      api<{ success: boolean; data: any[] }>(`/api/v1/invoice-requests?party_id=${form.party_id}&status=CONFIRMED&limit=200`).catch(() => ({ data: [] as any[] })),
    ]).then(([invoicesRes, reqRes]) => {
      const standalone = invoicesRes.data || [];
      const standaloneIds = new Set(standalone.map((inv: Invoice) => inv.invoice_number));
      const fromRequests: Invoice[] = (reqRes.data || [])
        .filter((ir: any) => ir.invoice_number && !standaloneIds.has(ir.invoice_number))
        .map((ir: any) => {
          const grandTotal = Number(ir.orders?.grand_total || 0);
          // Prior partial payments are tracked in their own ledger and hydrated by
          // the API — fall back to "fully outstanding" only when nothing is recorded.
          const amountPaid = Number(ir.amount_paid ?? ir.orders?.amount_paid ?? 0);
          const amountOutstanding = ir.amount_outstanding != null
            ? Number(ir.amount_outstanding)
            : Math.max(0, grandTotal - amountPaid);
          return {
            id: ir.id,
            invoice_number: ir.invoice_number,
            grand_total: grandTotal,
            amount_outstanding: amountOutstanding,
            amount_paid: amountPaid,
            payment_status: ir.payment_status
              || (amountPaid <= 0 ? "UNPAID" : amountOutstanding <= 0 ? "PAID" : "PARTIAL"),
            billing_party_id: ir.party_id,
            invoice_date: ir.confirmed_at || ir.created_at,
          };
        });
      const merged = [...standalone, ...fromRequests];
      setOutstandingInvoices(sortInvoicesOldestFirst(merged));
      // openingBal (opening_balance + wallet_balance) is the party's TRUE net balance:
      // opening + payments − invoices. Open invoices are already folded into it, so the
      // amount owed is simply its negative — adding invoice outstanding back on top would
      // double-count those same invoices. Negative net balance → party owes us.
      setPartyDue(-openingBal);
    }).finally(() => setInvoicesLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.party_id, parties, outstanding]);

  function openCollect(partyId?: string) {
    const locked = partyId || null;
    setLockedPartyId(locked);
    setForm({ party_id: partyId || "", amount: "", payment_mode: "CASH", reference_number: "", bank_name: "", proof_url: "", is_advance: false, notes: "" });
    setSelectedAdj({});
    setFormError("");
    setProofFile(null);
    setProofPreview(null);
    setProofError("");

    if (partyId) {
      const outParty = validOutstanding.find(p => p.party_id === partyId);
      setPartyDue(outParty ? outParty.total_outstanding : null);

      // Step 1: Immediately populate from cached outstanding data (no wait)
      if (outParty && outParty.invoices.length > 0) {
        const cached: Invoice[] = outParty.invoices.map(inv => ({
          id: inv.id,
          invoice_number: inv.invoice_number,
          grand_total: inv.grand_total,
          amount_outstanding: inv.amount_outstanding,
          amount_paid: inv.amount_paid,
          payment_status: inv.payment_status,
          billing_party_id: partyId,
          invoice_date: inv.invoice_date,
        }));
        setOutstandingInvoices(sortInvoicesOldestFirst(cached));
        setInvoicesLoading(false);
      } else {
        setOutstandingInvoices([]);
        setInvoicesLoading(true);
      }

      // Fresh invoice data is loaded by the useEffect watching form.party_id
    } else {
      setOutstandingInvoices([]);
      setPartyDue(null);
      setInvoicesLoading(false);
    }

    setShowCreate(true);
  }

    async function handleProofSelect(file: File) {
      setProofFile(file);
      setProofPreview(URL.createObjectURL(file));
      setProofError("");
      setProofUploading(true);
      try {
        const fd = new FormData();
        fd.append("image", file);
        const token = typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;
        const res = await fetch("/api/v1/upload/payment-proof", {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: fd,
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.message || "Upload failed");
        setForm(f => ({ ...f, proof_url: json.data.url }));
      } catch (err) {
        setProofError(err instanceof Error ? err.message : "Upload failed");
        setProofFile(null);
        setProofPreview(null);
      } finally {
        setProofUploading(false);
      }
    }

	    async function doSubmitPayment(skipPartyScheme: boolean, appliedSchemeIds: string[] = selectedSchemeIds) {
	      const schemeSnapshots = schemePopupSchemes || [];
	      setSchemePopupSchemes(null);
	      setCreating(true);
	      try {
	        const adjustments = Object.entries(selectedAdj).filter(([, amt]) => amt > 0).map(([invoiceId, amount]) => ({ invoiceId, amount }));
	        const result = await api<{ success: boolean; data: { whatsapp_delivery: { status: "sent" }; request_number: string } }>("/api/v1/payments/initiate", {
	          method: "POST",
	          body: {
	            ...form,
	            amount: parseFloat(form.amount),
	            adjustments,
	            skip_party_scheme: skipPartyScheme,
	            applied_scheme_ids: skipPartyScheme ? [] : appliedSchemeIds,
	            invoice_snapshots: outstandingInvoices
	              .filter(invoice => Number(selectedAdj[invoice.id] || 0) > 0)
	              .map(invoice => ({
	                id: invoice.id,
	                invoice_number: invoice.invoice_number,
	                invoice_date: invoice.invoice_date,
	                grand_total: invoice.grand_total,
	                amount_outstanding: invoice.amount_outstanding,
	              })),
	            scheme_snapshots: schemeSnapshots,
	          },
	        });
	        setShowCreate(false);
	        setProofFile(null);
	        setProofPreview(null);
	        setSelectedSchemeIds([]);
	        setAutomationNotice(`${result.data.request_number} was sent automatically on WhatsApp.`);
	        window.setTimeout(() => setAutomationNotice(""), 6000);
	      } catch (err) { setFormError(err instanceof Error ? err.message : "Failed to initiate payment approval"); }
	      finally { setCreating(false); }
	    }

    async function handleCreate(e: React.FormEvent) {
      e.preventDefault();
      setFormError("");
      // Photo upload is optional for both bank and coupon payments.
      // The reference/coupon number is mandatory for non-cash payments.
      if (form.payment_mode !== "CASH" && !form.reference_number.trim()) {
        setFormError(form.payment_mode === "COUPON"
          ? "Please enter the coupon number before submitting."
          : "Please enter the UTR / reference number before submitting.");
        return;
      }
      if (proofUploading) { setFormError("Please wait for the photo to finish uploading."); return; }

      // Check if the selected party has any active schemes before recording
      if (form.party_id) {
        setSchemeCheckLoading(true);
        try {
	          const res = await api<{ success: boolean; data: ActiveScheme[] }>(`/api/v1/payments/scheme-check?party_id=${form.party_id}`);
	          if (res.data && res.data.length > 0) {
	            const firstSelectableId = res.data.find(scheme => !scheme.progress.is_achieved)?.id;
	            setSelectedSchemeIds(firstSelectableId ? [firstSelectableId] : []);
	            setSchemePopupSchemes(res.data);
	            return; // wait for user decision in popup
	          }
        } catch {
          // scheme check failed silently — proceed without popup
        } finally {
          setSchemeCheckLoading(false);
        }
      }

      await doSubmitPayment(false);
    }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true); setDeleteError("");
    try {
      await api(`/api/v1/payments?id=${deleteTarget.id}`, { method: "DELETE" });
      setDeleteTarget(null);
            fetchOutstanding();
            fetchParties();
            fetchWalletTransactions();
            // If the wallet statement is open, reload it so the cancelled payment
            // disappears and balances reflect the reversal immediately.
            if (statementParty) loadStatementData(statementParty);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete payment");
    } finally { setDeleting(false); }
  }

  async function handlePendingDelete() {
    if (!pendingDeleteTarget) return;
    setPendingDeleting(true);
    setPendingDeleteError("");
    try {
      await api(`/api/v1/payments/pending?request_number=${encodeURIComponent(pendingDeleteTarget.request_number)}`, { method: "DELETE" });
      setPendingPayments(current => current.filter(payment => payment.request_number !== pendingDeleteTarget.request_number));
      setPendingDeleteTarget(null);
    } catch (err) {
      setPendingDeleteError(err instanceof Error ? err.message : "Failed to delete initiated payment");
      fetchPendingPayments();
    } finally {
      setPendingDeleting(false);
    }
  }

      async function handleTopup(e: React.FormEvent) {
          e.preventDefault();
          if (!topupParty) return;
          setTopupError(""); setTopupLoading(true);
          try {
            const amt = parseFloat(topupAmount);
            if (!amt || amt <= 0) throw new Error("Enter a valid amount");
            await api("/api/v1/wallet-topup", {
              method: "POST",
              body: { party_id: topupParty.id, amount: amt, note: topupNote || undefined },
            });
            setTopupParty(null); setTopupAmount(""); setTopupNote("");
            fetchParties();
            fetchWalletTransactions();
          } catch (err) {
            setTopupError(err instanceof Error ? err.message : "Top-up failed");
          } finally { setTopupLoading(false); }
        }

  async function handleDeduct(e: React.FormEvent) {
          e.preventDefault();
          if (!deductParty) return;
          setDeductError(""); setDeductLoading(true);
          try {
            const amt = parseFloat(deductAmount);
            if (!amt || amt <= 0) throw new Error("Enter a valid amount");
            await api("/api/v1/wallet-deduct", {
              method: "POST",
              body: { party_id: deductParty.id, amount: amt, note: deductNote || undefined },
            });
            setDeductParty(null); setDeductAmount(""); setDeductNote("");
            fetchParties();
            fetchWalletTransactions();
          } catch (err) {
            setDeductError(err instanceof Error ? err.message : "Deduction failed");
          } finally { setDeductLoading(false); }
        }

  const pendingPaymentsByParty = React.useMemo(() => {
    const grouped = new Map<string, PendingPayment[]>();
    for (const payment of pendingPayments) {
      const current = grouped.get(payment.party_id) || [];
      current.push(payment);
      grouped.set(payment.party_id, current);
    }
    return grouped;
  }, [pendingPayments]);

  const walletTxnStatsByParty = React.useMemo(() => {
    const stats = new Map<string, {
      count: number;
      net: number;
      credit: number;
      debit: number;
      latestAt: string | null;
      latestType: string | null;
      latestAmount: number;
      latestDescription: string | null;
    }>();
    for (const txn of walletTransactions) {
      if (!txn.party_id) continue;
      const amount = Number(txn.amount || 0);
      const current = stats.get(txn.party_id) || {
        count: 0,
        net: 0,
        credit: 0,
        debit: 0,
        latestAt: null,
        latestType: null,
        latestAmount: 0,
        latestDescription: null,
      };
      current.count += 1;
      current.net += amount;
      if (amount >= 0) current.credit += amount;
      else current.debit += Math.abs(amount);
      if (!current.latestAt || new Date(txn.created_at).getTime() > new Date(current.latestAt).getTime()) {
        current.latestAt = txn.created_at;
        current.latestType = txn.type || null;
        current.latestAmount = amount;
        current.latestDescription = txn.description || null;
      }
      stats.set(txn.party_id, current);
    }
    return stats;
  }, [walletTransactions]);

  // Load (or reload) the wallet statement + the party's reversible payment records.
  // Kept separate from openWalletStatement so it can be re-run after a cancellation
  // to refresh the rows in place.
  const loadStatementData = useCallback(async (party: Party) => {
    const openingBalance = Number(party.opening_balance || 0);
    const walletBalance = Number(party.wallet_balance || 0);
    setStatementError("");
    setStatementLoading(true);

    try {
      const [txnRes, payRes] = await Promise.all([
        api<{ success: boolean; data: { transactions: StatementTransaction[]; summary: StatementSummary } }>(
          `/api/v1/parties/${party.id}/transactions`,
        ),
        api<{ success: boolean; data: Payment[] }>(
          `/api/v1/payments?party=${party.id}&limit=500`,
        ).catch(() => ({ success: false, data: [] as Payment[] })),
      ]);

      setStatementTransactions(txnRes.data?.transactions || []);
      setStatementSummary(txnRes.data?.summary || { currentBalance: openingBalance + walletBalance, openingBalance });

      // Index payments by their human-readable number so a statement line
      // (whose reference is the payment_number) can resolve back to the row id.
      const byNumber: Record<string, Payment> = {};
      for (const p of payRes.data || []) {
        if (p?.payment_number) byNumber[String(p.payment_number)] = { ...p, parties: { name: party.name } };
      }
      setStatementPayments(byNumber);
    } catch {
      setStatementError("Showing available wallet balance because detailed transaction records could not be loaded.");
    } finally {
      setStatementLoading(false);
    }
  }, []);

  const openWalletStatement = useCallback(async (party: Party) => {
    const openingBalance = Number(party.opening_balance || 0);
    const walletBalance = Number(party.wallet_balance || 0);
    setStatementParty(party);
    setStatementTransactions([]);
    setStatementPayments({});
    setStatementSummary({
      currentBalance: openingBalance + walletBalance,
      openingBalance,
    });
    await loadStatementData(party);
  }, [loadStatementData]);

  const statementRows = React.useMemo(() => {
    if (!statementParty) return [];
    const openingBalance = Number(statementParty.opening_balance || 0);
    const walletBalance = Number(statementParty.wallet_balance || 0);

    // The API returns transactions oldest-first (sorted ascending by created_at).
    // Reverse so the latest transaction sits on top and the oldest at the bottom,
    // preserving exact intra-day sequencing rather than sorting by day-granular date.
    const rows: StatementTransaction[] = [...statementTransactions].reverse();

    // The API already synthesizes an opening-balance entry when opening_balance > 0.
    // Only add a client-side opening row when it's missing (e.g. negative opening
    // balances, which the API does not synthesize) to avoid a duplicate row.
    const hasOpeningRow = statementTransactions.some(
      (t) => t.reference === "OPENING_BALANCE" || /^opening/i.test(t.description || ""),
    );

    if (openingBalance !== 0 && !hasOpeningRow) {
      // Opening balance is the oldest entry → pin it to the bottom.
      rows.push({
        id: "opening-balance",
        date: new Date().toISOString(),
        type: "OPENING",
        reference: statementParty.party_code,
        description: "Opening wallet balance",
        debit: openingBalance < 0 ? Math.abs(openingBalance) : 0,
        credit: openingBalance > 0 ? openingBalance : 0,
        balance: openingBalance,
      });
    }

    if (statementTransactions.length === 0 && walletBalance !== 0) {
      rows.unshift({
        id: "current-wallet-balance",
        date: new Date().toISOString(),
        type: "WALLET",
        reference: statementParty.party_code,
        description: "Current wallet balance",
        debit: walletBalance < 0 ? Math.abs(walletBalance) : 0,
        credit: walletBalance > 0 ? walletBalance : 0,
        balance: openingBalance + walletBalance,
      });
    }

    return rows;
  }, [statementParty, statementTransactions]);

  function openCreditAnalysis(partyId: string, partyName: string) {
    setCreditPartyId(partyId);
    setCreditPartyName(partyName);
    const party = validOutstanding.find((entry) => entry.party_id === partyId);
    const fallback = party ? buildFallbackCreditDataFromOutstanding(party) : null;
    const cached = creditScoresMap[partyId]?.data || fallback || null;
    setCreditData(cached);
    setCreditError("");
    setCreditLoading(!cached);
    api<{ success: boolean; data: CreditData }>(`/api/v1/credit-analysis?party_id=${partyId}`)
      .then(r => {
          setCreditData(prev => {
            if (prev?.score !== null && prev?.score !== undefined && (r?.data?.score === null || r?.data?.score === undefined)) {
              return prev;
            }
            return r.data || prev;
          });
          if (r?.data) {
            setCreditScoresMap(prev => ({
              ...prev,
              [partyId]: { score: r.data.score, band: r.data.band, data: r.data },
            }));
          } else if (fallback) {
            setCreditScoresMap(prev => ({
              ...prev,
              [partyId]: { score: (fallback as { score: number }).score, band: (fallback as { band: string }).band, data: fallback },
            }));
          }
      })
      .catch(err => {
        if (!cached && fallback) {
          setCreditData(fallback);
          setCreditScoresMap(prev => ({
            ...prev,
            [partyId]: { score: fallback.score, band: fallback.band, data: fallback },
          }));
        } else {
          setCreditError(err instanceof Error ? err.message : "Analysis failed");
        }
      })
      .finally(() => setCreditLoading(false));
  }

  const totalOutstanding = validOutstanding.reduce((s, p) => s + p.total_outstanding, 0);

  // Reconcile list should only surface invoices that still owe money. Fully-paid
  // invoices (outstanding <= 0) have nothing to apply against, so they are hidden
  // from the Collect-payment modal.
  const pendingInvoices = outstandingInvoices.filter(inv => Number(inv.amount_outstanding) > 0);

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900" style={{ ...css, fontSize: "1.5rem", marginBottom: "0.25rem" }}>Payments</h1>
            <p className="text-zinc-500" style={{ fontSize: "0.8rem", margin: 0 }}>
            {tab === "outstanding"
                  ? outstandingSearch
                    ? `${validOutstanding.filter(p => p.party_name.toLowerCase().includes(outstandingSearch.toLowerCase()) || p.party_code.toLowerCase().includes(outstandingSearch.toLowerCase())).length + walletDueParties.filter(p => p.name.toLowerCase().includes(outstandingSearch.toLowerCase()) || p.party_code.toLowerCase().includes(outstandingSearch.toLowerCase())).length} of ${validOutstanding.length + walletDueParties.length} parties`
                    : `${validOutstanding.length + walletDueParties.length} parties with outstanding dues`
                  : tab === "wallets"
                    ? `${parties.length} parties — wallet balances`
                    : `${parties.length} total parties`}
            </p>
        </div>
      </div>

      {automationNotice && (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-700" style={{ fontSize: "0.8rem" }}>
          {automationNotice}
        </div>
      )}

      {/* Summary card (outstanding only) */}
      {tab === "outstanding" && !outstandingLoading && validOutstanding.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-6">
          <div className="rounded-xl border border-black/[0.06] bg-white p-4">
            <div className="text-zinc-500 mb-1" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Total Receivable</div>
            <div className="text-red-500 font-bold" style={{ fontSize: "1.4rem" }}>{fmt(totalOutstanding)}</div>
          </div>
          <div className="rounded-xl border border-black/[0.06] bg-white p-4">
            <div className="text-zinc-500 mb-1" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Parties</div>
            <div className="text-zinc-900 font-bold" style={{ fontSize: "1.4rem" }}>{validOutstanding.length}</div>
          </div>
          <div className="rounded-xl border border-black/[0.06] bg-white p-4">
            <div className="text-zinc-500 mb-1" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Total Invoices</div>
            <div className="text-zinc-900 font-bold" style={{ fontSize: "1.4rem" }}>{validOutstanding.reduce((s, p) => s + p.invoice_count, 0)}</div>
          </div>
        </div>
      )}

        {/* Tabs */}
          <div className="flex gap-1 mb-4 border-b border-black/[0.06]">
            <button onClick={() => setTab("outstanding")}
              className={`px-4 py-2.5 text-sm font-medium transition-all border-b-2 -mb-px ${tab === "outstanding" ? "border-amber-500 text-amber-500" : "border-transparent text-zinc-500 hover:text-zinc-900"}`}
              style={{ background: "none", fontFamily: "inherit", cursor: "pointer" }}>
              Outstanding
            </button>
            <button onClick={() => setTab("wallets")}
              className={`px-4 py-2.5 text-sm font-medium transition-all border-b-2 -mb-px ${tab === "wallets" ? "border-emerald-500 text-emerald-500" : "border-transparent text-zinc-500 hover:text-zinc-900"}`}
              style={{ background: "none", fontFamily: "inherit", cursor: "pointer" }}>
              Wallet Balances
            </button>
            <button onClick={() => setTab("parties")}
              className={`px-4 py-2.5 text-sm font-medium transition-all border-b-2 -mb-px ${tab === "parties" ? "border-violet-500 text-violet-500" : "border-transparent text-zinc-500 hover:text-zinc-900"}`}
              style={{ background: "none", fontFamily: "inherit", cursor: "pointer" }}>
              Collect from Party
            </button>
          </div>

      {/* ── WALLET BALANCES TAB ── */}
      {tab === "wallets" && (() => {
        const filtered = parties.filter(p =>
          !walletSearch ||
          p.name.toLowerCase().includes(walletSearch.toLowerCase()) ||
          p.party_code.toLowerCase().includes(walletSearch.toLowerCase())
        );
        const withBal = filtered.map(p => ({ ...p, effective: Number(p.opening_balance || 0) + Number(p.wallet_balance || 0) }));
        const payable    = withBal.filter(p => p.effective > 0); // positive = you owe party
        const receivable = withBal.filter(p => p.effective < 0); // negative = party owes you
        const zero       = withBal.filter(p => p.effective === 0);
        const totalPayable    = payable.reduce((s, p) => s + p.effective, 0);
        const totalReceivable = receivable.reduce((s, p) => s + p.effective, 0);
        const net = totalPayable + totalReceivable;
        return (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-3 gap-3 mb-5">
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-4">
                <div className="text-zinc-500 mb-1" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Payable (You owe party)</div>
                <div className="text-emerald-500 font-bold" style={{ fontSize: "1.25rem" }}>{fmt(Math.abs(totalPayable))}</div>
                <div className="text-zinc-400 mt-0.5" style={{ fontSize: "0.65rem" }}>{payable.length} {payable.length === 1 ? "party" : "parties"}</div>
              </div>
              <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] p-4">
                <div className="text-zinc-500 mb-1" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Receivable (Party owes you)</div>
                <div className="text-red-500 font-bold" style={{ fontSize: "1.25rem" }}>{fmt(Math.abs(totalReceivable))}</div>
                <div className="text-zinc-400 mt-0.5" style={{ fontSize: "0.65rem" }}>{receivable.length} {receivable.length === 1 ? "party" : "parties"}</div>
              </div>
              <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-4">
                <div className="text-zinc-500 mb-1" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Net Balance</div>
                <div className={`font-bold ${net < 0 ? "text-red-500" : net > 0 ? "text-emerald-500" : "text-zinc-500"}`} style={{ fontSize: "1.25rem" }}>{fmt(Math.abs(net))}</div>
                <div className="text-zinc-400 mt-0.5" style={{ fontSize: "0.65rem" }}>{filtered.length} total parties</div>
              </div>
            </div>

            {/* Search */}
            <div className="relative mb-4">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400 pointer-events-none" />
              <input
                type="text"
                placeholder="Search parties by name or code…"
                value={walletSearch}
                onChange={e => setWalletSearch(e.target.value)}
                className="w-full pl-9 pr-8 py-2 rounded-lg border border-black/[0.08] bg-white text-zinc-900 outline-none focus:border-emerald-400 transition-colors"
                style={{ fontSize: "0.85rem", fontFamily: "inherit" }}
              />
              {walletSearch && (
                <button onClick={() => setWalletSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600" style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {filtered.length === 0 ? (
              <div className="text-center py-20 text-zinc-500">
                <Wallet className="w-12 h-12 mx-auto mb-4 opacity-30" />
                <p style={{ fontSize: "0.875rem" }}>No parties found</p>
              </div>
            ) : (
              <div className="rounded-xl border border-black/[0.06] overflow-y-auto bg-white" style={{ maxHeight: "30rem" }}>
                <table className="w-full" style={{ borderCollapse: "collapse" }}>
                  <thead>
                    <tr className="border-b border-black/[0.06] bg-black/[0.02]">
                      {["Party", "Code", "Wallet Transactions", "Effective Balance", ""].map(h => (
                        <th key={h} className="text-left px-4 py-3 text-xs font-medium text-zinc-500"
                          style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {withBal
                      .sort((a, b) => Math.abs(b.effective) - Math.abs(a.effective))
	                      .map(p => {
	                        const eff = p.effective;
	                        const txn = walletTxnStatsByParty.get(p.id);
	                        const scoreInfo = creditScoresMap[p.id];
	                        const credit = scoreInfo?.score && scoreInfo.band
	                          ? { score: scoreInfo.score, band: scoreInfo.band }
	                          : getWalletCreditFallback(p);
	                        const creditColor = CREDIT_BAND_COLORS[credit.band] || CREDIT_BAND_COLORS.GOOD;
	                        const openingBalance = Number(p.opening_balance || 0);
	                        const walletBalance = Number(p.wallet_balance || 0);
	                        const latestFallbackBalance = openingBalance + walletBalance;
	                        const fallbackLabel = openingBalance !== 0 && walletBalance === 0
	                          ? "Opening balance"
	                          : "Current wallet balance";
	                        return (
                          <tr key={p.id} className="border-b border-black/[0.04] hover:bg-black/[0.01] transition-colors">
                            <td className="px-4 py-3">
                              <div className="font-medium text-zinc-900" style={{ fontSize: "0.82rem" }}>{p.name}</div>
                            </td>
                            <td className="px-4 py-3">
                              <span className="font-mono text-zinc-500" style={{ fontSize: "0.72rem" }}>{p.party_code}</span>
                            </td>
                            <td className="px-4 py-3">
                              {walletTxnLoading ? (
                                <div className="text-zinc-400 flex items-center gap-1.5" style={{ fontSize: "0.72rem" }}>
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading...
                                </div>
	                              ) : !txn && latestFallbackBalance === 0 ? (
	                                <div className="flex items-center justify-between gap-2">
	                                  <span className="text-zinc-400" style={{ fontSize: "0.75rem" }}>No transactions</span>
	                                  <button
                                    type="button"
                                    onClick={() => openWalletStatement(p)}
                                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-black/10 text-zinc-600 hover:bg-black/[0.04]"
                                    style={{ fontSize: "0.62rem", fontFamily: "inherit", cursor: "pointer" }}
                                  >
                                    <FileText className="w-3 h-3" />
	                                    View
	                                  </button>
	                                </div>
	                              ) : !txn ? (
	                                <div className="flex items-center justify-between gap-2">
	                                  <div>
	                                    <div className={`font-mono font-semibold ${latestFallbackBalance > 0 ? "text-emerald-500" : "text-red-500"}`} style={{ fontSize: "0.8rem" }}>
	                                      {latestFallbackBalance > 0 ? "+" : ""}{fmt(latestFallbackBalance)}
	                                    </div>
	                                    <div className="text-zinc-500" style={{ fontSize: "0.63rem" }}>
	                                      Last: {fallbackLabel}
	                                    </div>
	                                  </div>
	                                  <button
	                                    type="button"
	                                    onClick={() => openWalletStatement(p)}
	                                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-black/10 text-zinc-600 hover:bg-black/[0.04]"
	                                    style={{ fontSize: "0.62rem", fontFamily: "inherit", cursor: "pointer" }}
	                                  >
	                                    <FileText className="w-3 h-3" />
	                                    View
	                                  </button>
	                                </div>
	                              ) : (
	                                <div>
	                                  <div className={`font-mono font-semibold ${txn.latestAmount > 0 ? "text-emerald-500" : txn.latestAmount < 0 ? "text-red-500" : "text-zinc-400"}`} style={{ fontSize: "0.8rem" }}>
	                                    {txn.latestAmount === 0 ? "₹0" : `${txn.latestAmount > 0 ? "+" : ""}${fmt(txn.latestAmount)}`}
	                                  </div>
                                  <div className="text-zinc-500" style={{ fontSize: "0.63rem" }}>
                                    {txn.count} txn · In {fmt(txn.credit)} · Out {fmt(txn.debit)}
                                  </div>
                                  {txn.latestType && (
                                    <div className="text-zinc-400 uppercase" style={{ fontSize: "0.58rem", letterSpacing: "0.04em" }}>
                                      Last: {txn.latestType.replaceAll("_", " ")}
                                    </div>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => openWalletStatement(p)}
                                    className="mt-1 inline-flex items-center gap-1 px-2 py-1 rounded-md border border-black/10 text-zinc-600 hover:bg-black/[0.04]"
                                    style={{ fontSize: "0.62rem", fontFamily: "inherit", cursor: "pointer" }}
                                  >
                                    <FileText className="w-3 h-3" />
                                    View Full Record
                                  </button>
                                </div>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <span className={`font-mono font-semibold ${eff > 0 ? "text-emerald-500" : eff < 0 ? "text-red-500" : "text-zinc-400"}`} style={{ fontSize: "0.82rem" }}>
                                  {eff === 0 ? "—" : `${eff > 0 ? "+" : ""}${fmt(eff)}`}
                                </span>
	                              </div>
	                            </td>
	                            <td className="px-4 py-3">
	                              <div className="flex flex-col items-end gap-1.5">
	                                <button
	                                  type="button"
	                                  onClick={() => openCreditAnalysis(p.id, p.name)}
	                                  className="inline-flex items-center gap-1 rounded-md border px-2 py-1 font-semibold"
	                                  style={{
	                                    fontSize: "0.62rem",
	                                    background: creditColor.bg,
	                                    borderColor: creditColor.border,
	                                    color: creditColor.text,
	                                    cursor: "pointer",
	                                  }}
	                                >
	                                  Score {credit.score}
	                                </button>
	                                {isAdmin && (
	                                  <>
	                                    <button
	                                      onClick={() => { setTopupParty(p); setTopupAmount(""); setTopupNote(""); setTopupError(""); }}
	                                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 hover:bg-emerald-500/20 transition-all"
	                                      style={{ fontSize: "0.72rem", fontFamily: "inherit", cursor: "pointer" }}>
	                                      <Wallet className="w-3.5 h-3.5" /> Top Up
	                                    </button>
	                                    <button
	                                      onClick={() => { setDeductParty(p); setDeductAmount(""); setDeductNote(""); setDeductError(""); }}
	                                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-600 hover:bg-red-500/20 transition-all"
	                                      style={{ fontSize: "0.72rem", fontFamily: "inherit", cursor: "pointer" }}>
	                                      <MinusCircle className="w-3.5 h-3.5" /> Deduct
	                                    </button>
	                                  </>
	                                )}
	                              </div>
	                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        );
      })()}

      {/* ── OUTSTANDING TAB ── */}
      {tab === "outstanding" && (
        outstandingLoading ? (
          <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-amber-500 animate-spin" /></div>
        ) : validOutstanding.length === 0 && walletDueParties.length === 0 ? (
          <div className="text-center py-20 text-zinc-500">
            <Wallet className="w-12 h-12 mx-auto mb-4 opacity-30" />
            <p style={{ fontSize: "0.875rem" }}>No outstanding dues</p>
          </div>
        ) : (
          <>
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search parties..."
              value={outstandingSearch}
              onChange={e => setOutstandingSearch(e.target.value)}
              className="w-full pl-9 pr-8 py-2 rounded-lg border border-black/[0.08] bg-white text-zinc-900 outline-none focus:border-amber-400 transition-colors"
              style={{ fontSize: "0.85rem", fontFamily: "inherit" }}
            />
            {outstandingSearch && (
              <button onClick={() => setOutstandingSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600" style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <div
            className="space-y-3 overflow-y-auto pr-1"
            style={{ maxHeight: "26rem" }}
          >
            {validOutstanding.filter(p =>
              !outstandingSearch ||
              p.party_name.toLowerCase().includes(outstandingSearch.toLowerCase()) ||
              p.party_code.toLowerCase().includes(outstandingSearch.toLowerCase())
            ).map(party => {
              const isOpen = expandedParty === party.party_id;
              const scoreInfo = creditScoresMap[party.party_id];
              const isFetching = fetchedScores.current.has(party.party_id) && !scoreInfo;
              const BAND_COLORS: Record<string, { bg: string; border: string; text: string; dot: string }> = {
                EXCELLENT: { bg: "rgba(16,185,129,0.1)", border: "rgba(16,185,129,0.25)", text: "#10b981", dot: "#10b981" },
                GOOD:      { bg: "rgba(34,197,94,0.1)",  border: "rgba(34,197,94,0.25)",  text: "#22c55e", dot: "#22c55e" },
                FAIR:      { bg: "rgba(245,158,11,0.1)", border: "rgba(245,158,11,0.25)", text: "#f59e0b", dot: "#f59e0b" },
                POOR:      { bg: "rgba(249,115,22,0.1)", border: "rgba(249,115,22,0.25)", text: "#f97316", dot: "#f97316" },
                VERY_POOR: { bg: "rgba(239,68,68,0.1)",  border: "rgba(239,68,68,0.25)",  text: "#ef4444", dot: "#ef4444" },
              };
              const DEFAULT_C = { bg: "rgba(245,158,11,0.1)", border: "rgba(245,158,11,0.2)", text: "#f59e0b", dot: "#f59e0b" };
              const iconC = scoreInfo?.band ? (BAND_COLORS[scoreInfo.band] || DEFAULT_C) : DEFAULT_C;
              return (
                <div key={party.party_id} className="rounded-xl overflow-hidden"
                  style={{ border: `1px solid ${scoreInfo?.band ? iconC.border : "rgba(0,0,0,0.06)"}`, background: "white", transition: "border-color 0.4s" }}>
                  {/* Party row */}
                  <div className="flex items-center gap-4 px-5 py-4">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 relative"
                      style={{ background: iconC.bg, border: `1px solid ${iconC.border}`, transition: "all 0.4s" }}>
                      {isFetching
                        ? <Loader2 className="w-4 h-4 animate-spin" style={{ color: iconC.text }} />
                        : <Building2 className="w-5 h-5" style={{ color: iconC.text }} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-zinc-900 font-semibold" style={{ fontSize: "0.9rem" }}>{party.party_name}</span>
                        <span className="text-zinc-500 font-mono" style={{ fontSize: "0.7rem" }}>{party.party_code}</span>
                        {party.party_type && (
                          <span className="px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500" style={{ fontSize: "0.6rem" }}>{party.party_type}</span>
                        )}
                        {scoreInfo?.score !== null && scoreInfo?.score !== undefined && scoreInfo.band && (
                          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-md font-semibold"
                            style={{ background: iconC.bg, color: iconC.dot, fontSize: "0.58rem", border: `1px solid ${iconC.border}` }}>
                            <span className="w-1.5 h-1.5 rounded-full inline-block shrink-0" style={{ background: iconC.dot }} />
                            {scoreInfo.score}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5">
                        <span className="text-zinc-500" style={{ fontSize: "0.72rem" }}>
                          {party.invoice_count} invoice{party.invoice_count !== 1 ? "s" : ""}
                        </span>
                        <span className="text-zinc-300">·</span>
                        <span className="text-zinc-500" style={{ fontSize: "0.72rem" }}>
                          Since {new Date(party.oldest_invoice_date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                        </span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-red-500 font-bold" style={{ fontSize: "1.05rem" }}>{fmt(party.total_outstanding)}</div>
                      <div className="text-zinc-400" style={{ fontSize: "0.65rem" }}>outstanding</div>
                    </div>
                    <button
                      onClick={() => openCreditAnalysis(party.party_id, party.party_name)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all shrink-0"
                      style={{
                        fontSize: "0.75rem",
                        fontFamily: "inherit",
                        cursor: "pointer",
                        background: scoreInfo?.band ? iconC.bg : "none",
                        color: scoreInfo?.band ? iconC.text : "#6366f1",
                        border: `1px solid ${scoreInfo?.band ? iconC.border : "rgba(99,102,241,0.25)"}`,
                      }}>
                      <TrendingUp className="w-3.5 h-3.5" />
                      {scoreInfo?.score !== null && scoreInfo?.score !== undefined
                        ? `${scoreInfo.score} ${String(scoreInfo.band || '').replace('_', ' ')}`
                        : 'Credit'}
                    </button>
                    <button
                      onClick={() => openCollect(party.party_id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-600 transition-all shrink-0"
                      style={{ fontSize: "0.75rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}>
                      <CreditCard className="w-3.5 h-3.5" /> Collect
                    </button>
                    <button
                      onClick={() => setExpandedParty(isOpen ? null : party.party_id)}
                      className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/5 transition-all shrink-0"
                      style={{ background: "none", border: "none", cursor: "pointer" }}>
                      {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>
                    </div>

                    {/* Invoice breakdown - directly under party row */}
                    {isOpen && (
                      <div className="border-t border-black/[0.04] bg-black/[0.015] px-5 py-3">
                       <div className="overflow-x-auto -mx-1 px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        <div className="min-w-[440px]">
                        <div className="grid grid-cols-4 gap-2 mb-2 px-1">
                          {["Invoice #", "Date", "Total", "Outstanding"].map(h => (
                            <span key={h} className="text-zinc-400" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</span>
                          ))}
                        </div>
                        <div className="space-y-1.5">
                          {party.invoices.map(inv => (
                            <div key={inv.id} className="grid grid-cols-4 gap-2 px-1 py-1.5 rounded-lg hover:bg-black/[0.03] transition-colors">
                              <span className="text-zinc-900 font-mono" style={{ fontSize: "0.78rem" }}>{inv.invoice_number}</span>
                              <span className="text-zinc-500" style={{ fontSize: "0.78rem" }}>
                                {new Date(inv.invoice_date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                              </span>
                              <span className="text-zinc-700 font-mono" style={{ fontSize: "0.78rem" }}>{fmt(inv.grand_total)}</span>
                              <div className="flex items-center gap-2">
                                <span className="text-red-500 font-mono font-medium" style={{ fontSize: "0.78rem" }}>{fmt(inv.amount_outstanding)}</span>
                                <span className={`px-1.5 py-0.5 rounded text-[0.55rem] font-medium ${inv.payment_status === "PARTIAL" ? "bg-amber-500/15 text-amber-500" : "bg-red-500/15 text-red-500"}`}>
                                  {inv.payment_status}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                        </div>
                       </div>
                      </div>
                    )}

                      {/* Credit Opinion — always visible under party row */}
                        {scoreInfo?.data?.score !== null && scoreInfo?.data?.score !== undefined && scoreInfo.data.metrics && (() => {
                      const cd = scoreInfo.data;
                      const m = cd.metrics!;
                      const score = cd.score!;
                      const bandKey = cd.band!;

                      // Verdict logic
                      const verdictConfig: Record<string, { verdict: string; verdictColor: string; verdictBg: string; icon: string }> = {
                        EXCELLENT: { verdict: "APPROVE", verdictColor: "#10b981", verdictBg: "rgba(16,185,129,0.08)", icon: "checkCircle" },
                        GOOD:      { verdict: "APPROVE", verdictColor: "#22c55e", verdictBg: "rgba(34,197,94,0.08)", icon: "checkCircle" },
                        FAIR:      { verdict: "CONDITIONAL", verdictColor: "#f59e0b", verdictBg: "rgba(245,158,11,0.08)", icon: "alertTriangle" },
                        POOR:      { verdict: "CAUTION", verdictColor: "#f97316", verdictBg: "rgba(249,115,22,0.08)", icon: "alertTriangle" },
                        VERY_POOR: { verdict: "DECLINE", verdictColor: "#ef4444", verdictBg: "rgba(239,68,68,0.08)", icon: "xCircle" },
                      };
                      const v = verdictConfig[bandKey] || verdictConfig.VERY_POOR;

                      // Credit limit: avgMonthlyInvoiced * multiplier * paymentRate
                      const multipliers: Record<string, number> = { EXCELLENT: 3, GOOD: 2, FAIR: 1, POOR: 0.5, VERY_POOR: 0 };
                      const mult = multipliers[bandKey] ?? 0;
                      const suggestedLimit = Math.round(m.avg_monthly_invoiced * mult * (m.payment_rate / 100));

                      // Risk level
                      const riskConfig: Record<string, { level: string; color: string }> = {
                        EXCELLENT: { level: "Low", color: "#10b981" },
                        GOOD: { level: "Low", color: "#22c55e" },
                        FAIR: { level: "Medium", color: "#f59e0b" },
                        POOR: { level: "High", color: "#f97316" },
                        VERY_POOR: { level: "Very High", color: "#ef4444" },
                      };
                      const risk = riskConfig[bandKey] || riskConfig.VERY_POOR;

                      // Opinion text
                      const opinionLines: string[] = [];
                      if (bandKey === "EXCELLENT" || bandKey === "GOOD") {
                        opinionLines.push(`This party has a strong track record with ${m.payment_rate}% payment rate.`);
                        opinionLines.push(`Average invoice settlement within ${m.avg_outstanding_days} days. Safe to extend credit up to ${fmt(suggestedLimit)}.`);
                      } else if (bandKey === "FAIR") {
                        opinionLines.push(`Moderate reliability — ${m.payment_rate}% invoices paid, avg ${m.avg_outstanding_days} days pending.`);
                        opinionLines.push(`Credit may be given with shorter terms. Limit: ${fmt(suggestedLimit)}. Monitor closely.`);
                      } else if (bandKey === "POOR") {
                        opinionLines.push(`Weak payment behavior — only ${m.payment_rate}% paid, avg ${m.avg_outstanding_days} days overdue.`);
                        opinionLines.push(`Require partial advance. Max exposure: ${fmt(suggestedLimit)}.`);
                      } else {
                        opinionLines.push(`Very poor payment history — ${m.payment_rate}% rate, ${m.avg_outstanding_days} days avg overdue.`);
                        opinionLines.push("Do NOT extend credit. Require full advance payment before dispatch.");
                      }

                      // Conditions
                      const conditions: string[] = [];
                      if (bandKey === "FAIR") {
                        conditions.push("Net 15 terms maximum (no Net 30)");
                        conditions.push("Collect partial advance on orders above " + fmt(m.avg_monthly_invoiced));
                      } else if (bandKey === "POOR") {
                        conditions.push("50% advance payment required");
                        conditions.push("Weekly payment follow-up mandatory");
                        conditions.push("No credit beyond " + fmt(suggestedLimit));
                      } else if (bandKey === "VERY_POOR") {
                        conditions.push("100% advance payment required");
                        conditions.push("No credit extension under any circumstance");
                      }

                      return (
                        <div className="border-t px-5 py-4" style={{ borderColor: iconC.border, background: v.verdictBg }}>
                          <div className="flex items-start gap-4">
                            {/* Left: Score gauge mini */}
                            <div className="shrink-0 text-center" style={{ width: "80px" }}>
                              <div className="relative w-16 h-16 mx-auto">
                                <svg viewBox="0 0 100 60" style={{ width: "100%", display: "block" }}>
                                  <circle cx="50" cy="55" r="40" fill="none" stroke="#e4e4e7" strokeWidth="8"
                                    strokeDasharray={`${Math.PI * 40 / 2} ${Math.PI * 40 / 2}`}
                                    transform="rotate(180 50 55)" strokeLinecap="round" />
                                  <circle cx="50" cy="55" r="40" fill="none" stroke={iconC.text} strokeWidth="8"
                                    strokeDasharray={`${((score - 300) / 600) * Math.PI * 40 / 2} ${Math.PI * 40}`}
                                    transform="rotate(180 50 55)" strokeLinecap="round" />
                                  <text x="50" y="50" textAnchor="middle"
                                    style={{ fontSize: "18px", fontWeight: 800, fill: iconC.text, fontFamily: "Inter,system-ui,sans-serif" }}>
                                    {score}
                                  </text>
                                </svg>
                              </div>
                              <div className="font-bold mt-0.5" style={{ fontSize: "0.55rem", color: iconC.text, letterSpacing: "0.06em" }}>
                                {bandKey.replace("_", " ")}
                              </div>
                            </div>

                            {/* Right: Opinion content */}
                            <div className="flex-1 min-w-0">
                              {/* Verdict + Risk row */}
                              <div className="flex items-center gap-2 mb-2 flex-wrap">
                                <span className="px-2.5 py-1 rounded-lg font-bold" style={{
                                  fontSize: "0.68rem", color: v.verdictColor,
                                  background: v.verdictBg, border: `1px solid ${v.verdictColor}30`,
                                  letterSpacing: "0.06em",
                                }}>
                                  {v.verdict === "APPROVE" ? "APPROVE CREDIT" : v.verdict === "CONDITIONAL" ? "CONDITIONAL CREDIT" : v.verdict === "CAUTION" ? "CAUTION — LIMITED" : "DECLINE CREDIT"}
                                </span>
                                <span className="px-2 py-0.5 rounded font-semibold" style={{
                                  fontSize: "0.6rem", color: risk.color,
                                  background: `${risk.color}15`, border: `1px solid ${risk.color}25`,
                                }}>
                                  {risk.level} Risk
                                </span>
                                {suggestedLimit > 0 && (
                                  <span className="px-2 py-0.5 rounded font-mono font-bold" style={{
                                    fontSize: "0.68rem", color: "#3b82f6",
                                    background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.2)",
                                  }}>
                                    Limit: {fmt(suggestedLimit)}
                                  </span>
                                )}
                              </div>

                              {/* Opinion text */}
                              <p className="text-zinc-600 leading-relaxed mb-2" style={{ fontSize: "0.76rem" }}>
                                {opinionLines.join(" ")}
                              </p>

                                {/* Key stats row */}
                                <div className="flex items-center gap-4 flex-wrap mb-2">
                                  {[
                                    { label: "Payment Rate", value: `${m.payment_rate}%` },
                                    { label: "Avg Days Pending", value: `${m.avg_outstanding_days}d` },
                                    { label: "Avg Monthly Order", value: fmt(m.avg_monthly_invoiced) },
                                    { label: "Avg Monthly Repayment (Yearly)", value: fmt(m.avg_monthly_repayment_yearly) },
                                    { label: "Total Invoiced", value: fmt(m.total_invoiced) },
                                    { label: "Total Paid", value: fmt(m.total_paid) },
                                  ].map(stat => (
                                  <div key={stat.label} className="flex items-center gap-1.5">
                                    <span className="text-zinc-400" style={{ fontSize: "0.6rem" }}>{stat.label}:</span>
                                    <span className="text-zinc-800 font-semibold font-mono" style={{ fontSize: "0.68rem" }}>{stat.value}</span>
                                  </div>
                                ))}
                              </div>

                              {/* Conditions */}
                              {conditions.length > 0 && (
                                <div className="rounded-lg px-3 py-2" style={{ background: `${v.verdictColor}08`, border: `1px solid ${v.verdictColor}18` }}>
                                  <div className="text-zinc-500 mb-1" style={{ fontSize: "0.58rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                                    Conditions
                                  </div>
                                  <ul style={{ margin: 0, paddingLeft: "14px" }}>
                                    {conditions.map((c, i) => (
                                      <li key={i} className="text-zinc-600" style={{ fontSize: "0.7rem", marginBottom: "2px" }}>{c}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    </div>
              );
            })}
          </div>

          {/* ── Wallet Receivables ── */}
          {walletDueParties.length > 0 && (() => {
            const filteredWalletDue = outstandingSearch
              ? walletDueParties.filter(p =>
                  p.name.toLowerCase().includes(outstandingSearch.toLowerCase()) ||
                  p.party_code.toLowerCase().includes(outstandingSearch.toLowerCase())
                )
              : walletDueParties;
            if (filteredWalletDue.length === 0) return null;
            return (
            <div className="mt-5">
              <p className="text-zinc-500 mb-3 flex items-center gap-2" style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                <Wallet className="w-3.5 h-3.5" />
                Wallet Receivables
                <span className="px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20 font-medium normal-case tracking-normal" style={{ fontSize: "0.6rem" }}>
                  {filteredWalletDue.length} {filteredWalletDue.length === 1 ? "party" : "parties"}
                </span>
              </p>
              <div className="space-y-2">
                {filteredWalletDue.map(p => {
                  const eff = (Number(p.opening_balance) || 0) + (Number(p.wallet_balance) || 0);
                  return (
                    <div key={p.id} className="flex items-center gap-4 px-5 py-3.5 rounded-xl border border-red-500/15 bg-red-500/[0.02]">
                      <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 bg-red-500/10 border border-red-500/20">
                        <Building2 className="w-4 h-4 text-red-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-zinc-900 font-semibold" style={{ fontSize: "0.88rem" }}>{p.name}</span>
                          <span className="text-zinc-500 font-mono" style={{ fontSize: "0.7rem" }}>{p.party_code}</span>
                        </div>
                        <div className="text-zinc-400 mt-0.5" style={{ fontSize: "0.68rem" }}>Wallet balance due</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-red-500 font-bold font-mono" style={{ fontSize: "1rem" }}>{fmt(Math.abs(eff))}</div>
                        <div className="text-zinc-400" style={{ fontSize: "0.62rem" }}>party owes you</div>
                      </div>
                      <button
                        onClick={() => openCollect(p.id)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-600 transition-all shrink-0"
                        style={{ fontSize: "0.75rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}>
                        <CreditCard className="w-3.5 h-3.5" /> Collect
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
            );
          })()}
          </>
        )
      )}

        {/* ── COLLECT FROM PARTY TAB ── */}
        {tab === "parties" && (() => {
          const sorted = collectParties;
          return (
            <>
              {/* Search */}
              <div className="relative mb-4">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search by name or party code…"
                  value={partySearch}
                  onChange={e => setPartySearch(e.target.value)}
                  className="w-full pl-9 pr-8 py-2 rounded-lg border border-black/[0.08] bg-white text-zinc-900 outline-none focus:border-violet-400 transition-colors"
                  style={{ fontSize: "0.85rem", fontFamily: "inherit" }}
                />
                {partySearch && (
                  <button onClick={() => setPartySearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600" style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {sorted.length === 0 ? (
                <div className="text-center py-20 text-zinc-500">
                  <Users className="w-12 h-12 mx-auto mb-4 opacity-30" />
                  <p style={{ fontSize: "0.875rem" }}>No parties found</p>
                </div>
              ) : (
                <div className="space-y-2 overflow-y-auto pr-1" style={{ maxHeight: "30rem" }}>
                  {sorted.map(p => {
                    const eff = Number(p.opening_balance || 0) + Number(p.wallet_balance || 0);
                    const partyPendingPayments = pendingPaymentsByParty.get(p.id) || [];
                    const scoreInfo = creditScoresMap[p.id];
                    const isFetching = fetchedScores.current.has(p.id) && !scoreInfo;
                    const band = scoreInfo?.band;
                    const score = scoreInfo?.score;
                    const initials = p.name.split(/\s+/).map((w: string) => w[0]).slice(0, 2).join("").toUpperCase();

                    // Avatar / border color: red if they owe you, emerald if you owe them, zinc neutral
                    const balanceColor = eff < 0 ? { ring: "#ef4444", bg: "rgba(239,68,68,0.08)", text: "#ef4444", label: "Owes you" }
                      : eff > 0 ? { ring: "#10b981", bg: "rgba(16,185,129,0.08)", text: "#10b981", label: "You owe" }
                      : { ring: "#d4d4d8", bg: "rgba(0,0,0,0.03)", text: "#71717a", label: "Settled" };

                    const BAND_COLORS: Record<string, string> = {
                      EXCELLENT: "#10b981", GOOD: "#22c55e", FAIR: "#f59e0b", POOR: "#f97316", VERY_POOR: "#ef4444",
                    };
                    // Use real score when available, otherwise fall back to wallet-based estimate
                    const fallbackCredit = (!score || !band) ? getWalletCreditFallback(p) : null;
                    const displayScore = score ?? fallbackCredit?.score;
                    const displayBand = band ?? fallbackCredit?.band;
                    const isFallback = !score && !!fallbackCredit;
                    const scoreColor = displayBand ? (BAND_COLORS[displayBand] || "#71717a") : "#d4d4d8";

                    return (
                      <div key={p.id}
                        className="flex items-center gap-4 px-5 py-3.5 rounded-xl bg-white transition-shadow hover:shadow-sm"
                        style={{ border: "1px solid rgba(0,0,0,0.07)" }}>
                        {/* Avatar */}
                        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 font-bold select-none"
                          style={{ background: balanceColor.bg, color: balanceColor.text, border: `1px solid ${balanceColor.ring}30`, fontSize: "0.75rem", letterSpacing: "0.04em" }}>
                          {initials || <Building2 className="w-4 h-4" />}
                        </div>

                        {/* Name + code */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-zinc-900 font-semibold leading-tight whitespace-normal break-words sm:truncate sm:whitespace-nowrap" style={{ fontSize: "0.88rem" }}>{p.name}</span>
                            <span className="text-zinc-400 font-mono shrink-0" style={{ fontSize: "0.68rem" }}>{p.party_code}</span>
                          </div>
                          {/* Balance chip */}
                          {eff !== 0 && (
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <span className="font-mono font-semibold" style={{ fontSize: "0.78rem", color: balanceColor.text }}>
                                {eff < 0 ? "" : "+"}{fmt(eff)}
                              </span>
                              <span className="px-1.5 py-0.5 rounded font-medium" style={{
                                fontSize: "0.58rem",
                                background: balanceColor.bg,
                                color: balanceColor.text,
                                border: `1px solid ${balanceColor.ring}25`,
                              }}>
                                {balanceColor.label}
                              </span>
                            </div>
                          )}
                          {eff === 0 && (
                            <div className="text-zinc-400 mt-0.5" style={{ fontSize: "0.72rem" }}>No outstanding balance</div>
                          )}
                          {partyPendingPayments.slice(0, 2).map((payment) => (
                            <div key={payment.request_number} className="flex items-center gap-1.5 mt-1 min-w-0" title={`${payment.request_number} · initiated by ${payment.collector_name}`}>
                              <button type="button" onClick={() => { setPendingDeleteError(""); setPendingDeleteTarget(payment); }}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-semibold shrink-0 hover:bg-red-500/10 hover:text-red-600 transition-colors"
                                title="Click to delete this initiated payment and expire its shared link"
                                style={{ fontSize: "0.61rem", color: "#d97706", background: "rgba(245,158,11,0.09)", border: "1px solid rgba(245,158,11,0.2)", cursor: "pointer", fontFamily: "inherit" }}>
                                <Clock3 className="w-3 h-3" /> Payment initiated
                              </button>
                              <span className="font-mono font-semibold text-amber-700 shrink-0" style={{ fontSize: "0.7rem" }}>
                                {fmt(Number(payment.amount) || 0)}
                              </span>
                              <span className="text-zinc-500 truncate" style={{ fontSize: "0.67rem" }}>
                                by {payment.collector_name}
                              </span>
                            </div>
                          ))}
                          {partyPendingPayments.length > 2 && (
                            <div className="text-amber-700 mt-0.5" style={{ fontSize: "0.62rem" }}>
                              +{partyPendingPayments.length - 2} more pending payment{partyPendingPayments.length - 2 === 1 ? "" : "s"}
                            </div>
                          )}
                        </div>

                        {/* Credit score pill */}
                        <div className="shrink-0 text-right" style={{ minWidth: "72px" }}>
                          {isFetching ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin inline" style={{ color: "#d4d4d8" }} />
                          ) : displayScore !== undefined && displayBand ? (
                            <div className="flex flex-col items-end gap-0.5">
                              <span className="px-2 py-0.5 rounded-md font-bold font-mono"
                                style={{ fontSize: "0.7rem", background: `${scoreColor}15`, color: scoreColor, border: `1px solid ${scoreColor}30` }}>
                                {isFallback ? "~" : ""}{displayScore}
                              </span>
                              <span className="font-medium" style={{ fontSize: "0.55rem", color: scoreColor, letterSpacing: "0.04em" }}>
                                {String(displayBand).replace("_", " ")}
                              </span>
                            </div>
                          ) : (
                            <span className="text-zinc-300" style={{ fontSize: "0.7rem" }}>—</span>
                          )}
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => openCollect(p.id)}
                            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-600 transition-all font-medium"
                            style={{ fontSize: "0.78rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}>
                            <CreditCard className="w-3.5 h-3.5" /> Collect
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          );
        })()}


      {/* ── WALLET STATEMENT MODAL ── */}
      {statementParty && (() => {
        const partyOpeningBalance = Number(statementParty.opening_balance || 0);
        const partyWalletBalance = Number(statementParty.wallet_balance || 0);
        const fallbackBalance = partyOpeningBalance + partyWalletBalance;
        // Rows are newest-first, so the current balance is the first finite balance.
        const lastKnownStatementBalance = statementRows
          .find(row => row.balance !== null && Number.isFinite(row.balance))?.balance;
        const currentBalance = lastKnownStatementBalance ?? statementSummary?.currentBalance ?? fallbackBalance;
        const openingBalance = partyOpeningBalance !== 0
          ? partyOpeningBalance
          : (statementSummary?.openingBalance ?? partyOpeningBalance);

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setStatementParty(null)}>
            <div className="bg-white border border-black/10 rounded-2xl w-full max-w-5xl max-h-[88vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-black/[0.06]">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0">
                    <FileText className="w-5 h-5 text-emerald-500" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-zinc-900 font-semibold truncate" style={{ fontSize: "1rem" }}>Wallet Statement</h3>
                    <p className="text-zinc-500 truncate" style={{ fontSize: "0.75rem", margin: 0 }}>
                      {statementParty.name} · {statementParty.party_code}
                    </p>
                  </div>
                </div>
                <button onClick={() => setStatementParty(null)} style={{ background: "none", border: "none", cursor: "pointer" }}>
                  <X className="w-5 h-5 text-zinc-400 hover:text-zinc-900" />
                </button>
              </div>

              <div className="p-5 overflow-y-auto">
                <div className="grid grid-cols-3 gap-3 mb-4">
                  <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-4">
                    <div className="text-zinc-500 mb-1" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Effective Balance</div>
                    <div className={`font-bold font-mono ${currentBalance < 0 ? "text-red-500" : currentBalance > 0 ? "text-emerald-500" : "text-zinc-500"}`} style={{ fontSize: "1.2rem" }}>
                      {currentBalance === 0 ? "₹0" : `${currentBalance > 0 ? "+" : ""}${fmt(currentBalance)}`}
                    </div>
                    <div className="text-zinc-400 mt-0.5" style={{ fontSize: "0.65rem" }}>{currentBalance < 0 ? "Party owes you" : currentBalance > 0 ? "You owe party" : "Settled"}</div>
                  </div>
                  <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-4">
                    <div className="text-zinc-500 mb-1" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Opening Balance</div>
                    <div className={`font-bold font-mono ${openingBalance < 0 ? "text-red-500" : openingBalance > 0 ? "text-emerald-500" : "text-zinc-500"}`} style={{ fontSize: "1.2rem" }}>
                      {openingBalance === 0 ? "₹0" : `${openingBalance > 0 ? "+" : ""}${fmt(openingBalance)}`}
                    </div>
                  </div>
                  <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-4">
                    <div className="text-zinc-500 mb-1" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Statement Records</div>
                    <div className="text-zinc-900 font-bold font-mono" style={{ fontSize: "1.2rem" }}>{statementRows.length}</div>
                    {statementLoading && <div className="text-zinc-400 mt-0.5 flex items-center gap-1" style={{ fontSize: "0.65rem" }}><Loader2 className="w-3 h-3 animate-spin" /> Loading details</div>}
                  </div>
                </div>

                {statementError && (
                  <div className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-amber-700" style={{ fontSize: "0.74rem" }}>
                    {statementError}
                  </div>
                )}

                <div className="rounded-xl border border-black/[0.06] overflow-hidden">
                  <table className="w-full" style={{ borderCollapse: "collapse" }}>
                    <thead>
                      <tr className="border-b border-black/[0.06] bg-black/[0.02]">
                        {["Date", "Type", "Reference", "Description", "Debit", "Credit", "Balance"].map(h => (
                          <th key={h} className="text-left px-4 py-3 text-xs font-medium text-zinc-500"
                            style={{ fontSize: "0.66rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                        ))}
                        {isAdmin && <th className="px-4 py-3" />}
                      </tr>
                    </thead>
                    <tbody>
                      {statementRows.length === 0 ? (
                        <tr>
                          <td colSpan={isAdmin ? 8 : 7} className="text-center py-14 text-zinc-500" style={{ fontSize: "0.82rem" }}>
                            No wallet statement records found.
                          </td>
                        </tr>
                      ) : statementRows.map(tx => {
                        // A row is cancellable only when it maps to a real payment
                        // record (matched by payment_number) and the user is an admin.
                        const reversible = tx.reference ? statementPayments[tx.reference] : undefined;
                        return (
                        <tr key={tx.id} className="border-b border-black/[0.04] hover:bg-black/[0.01]">
                          <td className="px-4 py-3 text-zinc-600" style={{ fontSize: "0.76rem" }}>
                            {new Date(tx.date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                          </td>
                          <td className="px-4 py-3">
                            <span className="px-2 py-0.5 rounded bg-zinc-100 text-zinc-600" style={{ fontSize: "0.66rem" }}>{tx.type}</span>
                          </td>
                          <td className="px-4 py-3 text-zinc-500 font-mono" style={{ fontSize: "0.72rem" }}>{tx.reference || "—"}</td>
                          <td className="px-4 py-3 text-zinc-700" style={{ fontSize: "0.76rem" }}>{tx.description || "—"}</td>
                          <td className="px-4 py-3 text-red-500 font-mono" style={{ fontSize: "0.76rem" }}>{tx.debit > 0 ? fmt(tx.debit) : "—"}</td>
                          <td className="px-4 py-3 text-emerald-500 font-mono" style={{ fontSize: "0.76rem" }}>{tx.credit > 0 ? fmt(tx.credit) : "—"}</td>
                          <td className={`px-4 py-3 font-mono ${tx.balance === null ? "text-zinc-400" : tx.balance < 0 ? "text-red-500" : tx.balance > 0 ? "text-emerald-500" : "text-zinc-500"}`} style={{ fontSize: "0.76rem" }}>
                            {tx.balance === null ? "—" : fmt(tx.balance)}
                          </td>
                          {isAdmin && (
                            <td className="px-4 py-3 text-right whitespace-nowrap">
                              {reversible && (
                                <button
                                  type="button"
                                  onClick={() => setDeleteTarget(reversible)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-red-600 hover:bg-red-500/10 transition-all"
                                  style={{ fontSize: "0.7rem", fontFamily: "inherit", background: "none", border: "1px solid rgba(239,68,68,0.25)", cursor: "pointer" }}
                                  title="Cancel this payment and reverse its wallet/invoice effects"
                                >
                                  <Trash2 className="w-3 h-3" /> Cancel
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        );
      })()}


      {/* ── DELETE CONFIRM ── */}
      {pendingDeleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => !pendingDeleting && setPendingDeleteTarget(null)}>
          <div className="bg-white border border-black/10 rounded-2xl w-full max-w-sm mx-4 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5 text-red-500" />
              </div>
              <div>
                <h3 className="text-zinc-900 font-semibold" style={{ fontSize: "1rem" }}>Delete Initiated Payment?</h3>
                <p className="text-zinc-500" style={{ fontSize: "0.75rem" }}>The shared links will expire immediately</p>
              </div>
            </div>
            <p className="text-zinc-600 mb-1" style={{ fontSize: "0.8rem" }}>
              Delete request <span className="text-zinc-900 font-mono">{pendingDeleteTarget.request_number}</span> for <span className="font-semibold text-amber-600">{fmt(Number(pendingDeleteTarget.amount))}</span>?
            </p>
            <p className="text-zinc-500 mb-5" style={{ fontSize: "0.75rem" }}>
              The party will no longer be able to open the approval or PDF link you shared. No payment has been posted yet.
            </p>
            {pendingDeleteError && (
              <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500" style={{ fontSize: "0.75rem" }}>{pendingDeleteError}</div>
            )}
            <div className="flex gap-3 justify-end">
              <button onClick={() => setPendingDeleteTarget(null)} disabled={pendingDeleting}
                className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5 disabled:opacity-50"
                style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", boxShadow: "none", cursor: "pointer" }}>Keep</button>
              <button onClick={handlePendingDelete} disabled={pendingDeleting}
                className="px-4 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 flex items-center gap-2"
                style={{ fontSize: "0.8rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}>
                {pendingDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} Delete &amp; Expire Link
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setDeleteTarget(null)}>
          <div className="bg-white border border-black/10 rounded-2xl w-full max-w-sm mx-4 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-zinc-900 font-semibold" style={{ fontSize: "1rem" }}>Cancel Payment</h3>
                <p className="text-zinc-500" style={{ fontSize: "0.75rem" }}>This cannot be undone</p>
              </div>
            </div>
            <p className="text-zinc-600 mb-1" style={{ fontSize: "0.8rem" }}>
              Cancel receipt <span className="text-zinc-900 font-mono">{deleteTarget.payment_number}</span>? The amount
              will be reversed from the party&apos;s wallet and any invoice allocations undone.
            </p>
            <p className="text-zinc-500 mb-5" style={{ fontSize: "0.75rem" }}>
              Amount: <span className="text-amber-500">{fmt(Number(deleteTarget.amount))}</span> · {deleteTarget.parties?.name || "Unknown"}
            </p>
            {deleteError && (
              <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400" style={{ fontSize: "0.75rem" }}>{deleteError}</div>
            )}
            <div className="flex gap-3 justify-end">
              <button onClick={() => setDeleteTarget(null)}
                className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5"
                style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", boxShadow: "none", cursor: "pointer" }}>Keep</button>
              <button onClick={handleDelete} disabled={deleting}
                className="px-4 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 flex items-center gap-2"
                style={{ fontSize: "0.8rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}>
                {deleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Cancel Payment
              </button>
            </div>
          </div>
        </div>
      )}

        {/* ── TOPUP WALLET MODAL ── */}
        {topupParty && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setTopupParty(null)}>
            <div className="bg-white border border-black/10 rounded-2xl w-full max-w-sm mx-4 p-6" onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0">
                  <Wallet className="w-5 h-5 text-emerald-500" />
                </div>
                <div>
                  <h3 className="text-zinc-900 font-semibold" style={{ fontSize: "1rem" }}>Top Up Wallet</h3>
                  <p className="text-zinc-500" style={{ fontSize: "0.75rem", margin: 0 }}>{topupParty.name}</p>
                </div>
                <button onClick={() => setTopupParty(null)} className="ml-auto" style={{ background: "none", border: "none", cursor: "pointer" }}>
                  <X className="w-4 h-4 text-zinc-400 hover:text-zinc-900" />
                </button>
              </div>

              {/* Current balance */}
              {(() => {
                const bal = Number(topupParty.wallet_balance || 0) + Number(topupParty.opening_balance || 0);
                return (
                  <div className="rounded-lg p-3 mb-4" style={{ background: bal > 0 ? "rgba(16,185,129,0.06)" : bal < 0 ? "rgba(239,68,68,0.06)" : "rgba(113,113,122,0.06)", border: `1px solid ${bal > 0 ? "rgba(16,185,129,0.15)" : bal < 0 ? "rgba(239,68,68,0.15)" : "rgba(113,113,122,0.15)"}` }}>
                    <div className="text-zinc-500 mb-0.5" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Current Balance</div>
                    <div className="font-mono font-bold" style={{ fontSize: "1.1rem", color: bal > 0 ? "#10b981" : bal < 0 ? "#ef4444" : "#71717a" }}>
                      {bal === 0 ? "₹0" : `${bal > 0 ? "+" : ""}${fmt(bal)}`}
                    </div>
                  </div>
                );
              })()}

              <form onSubmit={handleTopup}>
                <label className="block mb-3">
                  <span className="text-zinc-600 block mb-1" style={{ fontSize: "0.72rem" }}>Top-Up Amount</span>
                  <input
                    type="number"
                    min="1"
                    step="any"
                    required
                    value={topupAmount}
                    onChange={e => setTopupAmount(e.target.value)}
                    placeholder="Enter amount"
                    className="w-full px-3 py-2 rounded-lg border border-black/10 text-zinc-900 font-mono focus:outline-none focus:border-emerald-500/40"
                    style={{ fontSize: "0.85rem", fontFamily: "inherit" }}
                  />
                </label>
                <label className="block mb-4">
                  <span className="text-zinc-600 block mb-1" style={{ fontSize: "0.72rem" }}>Note (optional)</span>
                  <input
                    type="text"
                    value={topupNote}
                    onChange={e => setTopupNote(e.target.value)}
                    placeholder="e.g. Advance payment, refund..."
                    className="w-full px-3 py-2 rounded-lg border border-black/10 text-zinc-900 focus:outline-none focus:border-emerald-500/40"
                    style={{ fontSize: "0.82rem", fontFamily: "inherit" }}
                  />
                </label>

                {/* Preview */}
                {topupAmount && parseFloat(topupAmount) > 0 && (() => {
                  const cur = Number(topupParty.wallet_balance || 0) + Number(topupParty.opening_balance || 0);
                  const after = cur + parseFloat(topupAmount);
                  return (
                    <div className="flex items-center justify-between rounded-lg px-3 py-2 mb-4 bg-black/[0.02] border border-black/[0.04]">
                      <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>After top-up:</span>
                      <span className="font-mono font-bold" style={{ fontSize: "0.85rem", color: after > 0 ? "#10b981" : after < 0 ? "#ef4444" : "#71717a" }}>
                        {after > 0 ? "+" : ""}{fmt(after)}
                      </span>
                    </div>
                  );
                })()}

                {topupError && (
                  <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400" style={{ fontSize: "0.75rem" }}>{topupError}</div>
                )}

                <div className="flex gap-3 justify-end">
                  <button type="button" onClick={() => setTopupParty(null)}
                    className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5"
                    style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", boxShadow: "none", cursor: "pointer" }}>Cancel</button>
                  <button type="submit" disabled={topupLoading}
                    className="px-4 py-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50 flex items-center gap-2"
                    style={{ fontSize: "0.8rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}>
                    {topupLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Top Up
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ── DEDUCT WALLET MODAL ── */}
        {deductParty && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setDeductParty(null)}>
            <div className="bg-white border border-black/10 rounded-2xl w-full max-w-sm mx-4 p-6" onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center shrink-0">
                  <MinusCircle className="w-5 h-5 text-red-500" />
                </div>
                <div>
                  <h3 className="text-zinc-900 font-semibold" style={{ fontSize: "1rem" }}>Deduct from Wallet</h3>
                  <p className="text-zinc-500" style={{ fontSize: "0.75rem", margin: 0 }}>{deductParty.name}</p>
                </div>
                <button onClick={() => setDeductParty(null)} className="ml-auto" style={{ background: "none", border: "none", cursor: "pointer" }}>
                  <X className="w-4 h-4 text-zinc-400 hover:text-zinc-900" />
                </button>
              </div>

              {/* Current balance */}
              {(() => {
                const bal = Number(deductParty.wallet_balance || 0) + Number(deductParty.opening_balance || 0);
                return (
                  <div className="rounded-lg p-3 mb-4" style={{ background: bal > 0 ? "rgba(16,185,129,0.06)" : bal < 0 ? "rgba(239,68,68,0.06)" : "rgba(113,113,122,0.06)", border: `1px solid ${bal > 0 ? "rgba(16,185,129,0.15)" : bal < 0 ? "rgba(239,68,68,0.15)" : "rgba(113,113,122,0.15)"}` }}>
                    <div className="text-zinc-500 mb-0.5" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Current Balance</div>
                    <div className="font-mono font-bold" style={{ fontSize: "1.1rem", color: bal > 0 ? "#10b981" : bal < 0 ? "#ef4444" : "#71717a" }}>
                      {bal === 0 ? "₹0" : `${bal > 0 ? "+" : ""}${fmt(bal)}`}
                    </div>
                  </div>
                );
              })()}

              <form onSubmit={handleDeduct}>
                <label className="block mb-3">
                  <span className="text-zinc-600 block mb-1" style={{ fontSize: "0.72rem" }}>Deduct Amount</span>
                  <input
                    type="number"
                    min="1"
                    step="any"
                    required
                    value={deductAmount}
                    onChange={e => setDeductAmount(e.target.value)}
                    placeholder="Enter amount"
                    className="w-full px-3 py-2 rounded-lg border border-black/10 text-zinc-900 font-mono focus:outline-none focus:border-red-500/40"
                    style={{ fontSize: "0.85rem", fontFamily: "inherit" }}
                  />
                </label>
                <label className="block mb-4">
                  <span className="text-zinc-600 block mb-1" style={{ fontSize: "0.72rem" }}>Note (optional)</span>
                  <input
                    type="text"
                    value={deductNote}
                    onChange={e => setDeductNote(e.target.value)}
                    placeholder="e.g. Adjustment, penalty, correction..."
                    className="w-full px-3 py-2 rounded-lg border border-black/10 text-zinc-900 focus:outline-none focus:border-red-500/40"
                    style={{ fontSize: "0.82rem", fontFamily: "inherit" }}
                  />
                </label>

                {/* Preview */}
                {deductAmount && parseFloat(deductAmount) > 0 && (() => {
                  const cur = Number(deductParty.wallet_balance || 0) + Number(deductParty.opening_balance || 0);
                  const after = cur - parseFloat(deductAmount);
                  return (
                    <div className="flex items-center justify-between rounded-lg px-3 py-2 mb-4 bg-black/[0.02] border border-black/[0.04]">
                      <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>After deduction:</span>
                      <span className="font-mono font-bold" style={{ fontSize: "0.85rem", color: after > 0 ? "#10b981" : after < 0 ? "#ef4444" : "#71717a" }}>
                        {after > 0 ? "+" : ""}{fmt(after)}
                      </span>
                    </div>
                  );
                })()}

                {deductError && (
                  <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400" style={{ fontSize: "0.75rem" }}>{deductError}</div>
                )}

                <div className="flex gap-3 justify-end">
                  <button type="button" onClick={() => setDeductParty(null)}
                    className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5"
                    style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", boxShadow: "none", cursor: "pointer" }}>Cancel</button>
                  <button type="submit" disabled={deductLoading}
                    className="px-4 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 flex items-center gap-2"
                    style={{ fontSize: "0.8rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}>
                    {deductLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Deduct
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ── CREDIT ANALYSIS MODAL ── */}
      {creditPartyId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => { setCreditPartyId(null); setCreditData(null); }}>
          <div className="bg-white border border-black/10 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-black/[0.05]">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center shrink-0">
                  <TrendingUp className="w-5 h-5 text-indigo-500" />
                </div>
                <div>
                  <h2 className="text-zinc-900 font-bold" style={{ fontSize: "1.05rem" }}>Credit Analysis</h2>
                  <p className="text-zinc-400" style={{ fontSize: "0.72rem", margin: 0 }}>{creditPartyName}</p>
                </div>
              </div>
              <button onClick={() => { setCreditPartyId(null); setCreditData(null); }}
                style={{ background: "none", border: "none", cursor: "pointer" }}>
                <X className="w-5 h-5 text-zinc-400 hover:text-zinc-900" />
              </button>
            </div>

            {/* Body */}
            <div className="p-6">
              {creditLoading && (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
                  <p className="text-zinc-500" style={{ fontSize: "0.82rem" }}>Analysing payment history…</p>
                </div>
              )}

              {creditError && !creditLoading && (
                <div className="py-10 text-center text-red-400" style={{ fontSize: "0.82rem" }}>
                  <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-60" />
                  {creditError}
                </div>
              )}

              {!creditLoading && !creditError && creditData && (() => {
                const d = creditData;

                if (d.score === null) {
                  return (
                    <div className="space-y-5">
                      <div className="flex flex-col sm:flex-row items-center gap-6 p-5 rounded-2xl border border-black/[0.06] bg-black/[0.01]">
                        {/* Unscored gauge placeholder */}
                        <div style={{ width: "180px", flexShrink: 0 }}>
                          <svg viewBox="0 0 200 118" style={{ width: "100%", display: "block" }}>
                            <circle cx="100" cy="100" r={78} fill="none" stroke="#f4f4f5" strokeWidth="14"
                              strokeDasharray={`${Math.PI * 78} ${Math.PI * 78}`}
                              transform="rotate(180 100 100)" strokeLinecap="round" />
                            <text x="100" y="92" textAnchor="middle" fill="#a1a1aa" fontSize="13" fontWeight="600">N/A</text>
                            <text x="100" y="108" textAnchor="middle" fill="#d4d4d8" fontSize="9">UNSCORED</text>
                          </svg>
                        </div>
                        {/* Opinion text */}
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 mb-2">
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-zinc-100 border border-zinc-200 text-zinc-500">
                              UNSCORED
                            </span>
                            <span className="text-zinc-400" style={{ fontSize: "0.7rem" }}>
                              Score: <span className="font-semibold text-zinc-500">— / 900</span>
                            </span>
                          </div>
                          <p className="text-zinc-600 leading-relaxed" style={{ fontSize: "0.8rem" }}>
                            {d.recommendation || "No invoice history found for this party. Credit score cannot be calculated yet. Establish a transaction record before extending significant credit."}
                          </p>
                          {/* Scale bar (all inactive) */}
                          <div className="mt-3">
                            <div className="flex h-2 rounded-full overflow-hidden gap-0.5">
                              {["#ef4444","#f97316","#f59e0b","#22c55e","#10b981"].map(c => (
                                <div key={c} className="flex-1 rounded-sm opacity-10" style={{ background: c }} />
                              ))}
                            </div>
                            <div className="flex justify-between mt-0.5">
                              {["V.Poor", "Poor", "Fair", "Good", "Excellent"].map(l => (
                                <span key={l} className="text-zinc-400" style={{ fontSize: "0.55rem" }}>{l}</span>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                }

                // Gauge config
                const r = 78;
                const circumference = 2 * Math.PI * r;
                const halfCirc = circumference / 2;
                const pct = (d.score - 300) / 600;
                const filledLen = Math.max(0, Math.min(pct * halfCirc, halfCirc));

                const bandConfig: Record<string, { color: string; bg: string; border: string; label: string }> = {
                  EXCELLENT: { color: "#10b981", bg: "bg-emerald-500/10", border: "border-emerald-500/20", label: "Excellent" },
                  GOOD: { color: "#22c55e", bg: "bg-green-500/10", border: "border-green-500/20", label: "Good" },
                  FAIR: { color: "#f59e0b", bg: "bg-amber-500/10", border: "border-amber-500/20", label: "Fair" },
                  POOR: { color: "#f97316", bg: "bg-orange-500/10", border: "border-orange-500/20", label: "Poor" },
                  VERY_POOR: { color: "#ef4444", bg: "bg-red-500/10", border: "border-red-500/20", label: "Very Poor" },
                };
                const band = d.band ? bandConfig[d.band] : bandConfig.VERY_POOR;
                const scoreColor = band.color;

                const compBarColor = (frac: number) =>
                  frac >= 0.75 ? "#10b981" : frac >= 0.5 ? "#f59e0b" : "#ef4444";

                return (
                  <div className="space-y-5">
                    {/* Score + gauge */}
                    <div className="flex flex-col sm:flex-row items-center gap-6 p-5 rounded-2xl border border-black/[0.06] bg-black/[0.01]">
                      {/* SVG Gauge */}
                      <div style={{ width: "180px", flexShrink: 0 }}>
                        <svg viewBox="0 0 200 118" style={{ width: "100%", display: "block" }}>
                          {/* Track */}
                          <circle cx="100" cy="100" r={r} fill="none" stroke="#f4f4f5" strokeWidth="14"
                            strokeDasharray={`${halfCirc} ${halfCirc}`}
                            transform="rotate(180 100 100)" strokeLinecap="round" />
                          {/* Score arc */}
                          <circle cx="100" cy="100" r={r} fill="none" stroke={scoreColor} strokeWidth="14"
                            strokeDasharray={`${filledLen} ${circumference - filledLen}`}
                            transform="rotate(180 100 100)" strokeLinecap="round" />
                          {/* Score number */}
                          <text x="100" y="88" textAnchor="middle"
                            style={{ fontSize: "30px", fontWeight: 700, fill: scoreColor, fontFamily: "Inter,system-ui,sans-serif" }}>
                            {d.score}
                          </text>
                          <text x="100" y="108" textAnchor="middle"
                            style={{ fontSize: "10px", fill: "#a1a1aa", fontFamily: "Inter,system-ui,sans-serif" }}>
                            {band.label.toUpperCase()}
                          </text>
                          <text x="12" y="114" textAnchor="middle" style={{ fontSize: "8px", fill: "#d4d4d8" }}>300</text>
                          <text x="188" y="114" textAnchor="middle" style={{ fontSize: "8px", fill: "#d4d4d8" }}>900</text>
                        </svg>
                      </div>

                      {/* Right side: band + recommendation */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2">
                          <span className={`px-2.5 py-1 rounded-lg text-xs font-bold border ${band.bg} ${band.border}`}
                            style={{ color: scoreColor, fontSize: "0.72rem" }}>
                            {band.label.toUpperCase()}
                          </span>
                          <span className="text-zinc-400" style={{ fontSize: "0.7rem" }}>
                            Score: <span className="font-semibold text-zinc-700">{d.score} / 900</span>
                          </span>
                        </div>
                        <p className="text-zinc-600 leading-relaxed" style={{ fontSize: "0.8rem" }}>
                          {d.recommendation}
                        </p>

                        {/* Scale bar */}
                        <div className="mt-3">
                          <div className="flex h-2 rounded-full overflow-hidden gap-0.5">
                            {[
                              { from: 300, to: 450, color: "#ef4444" },
                              { from: 450, to: 550, color: "#f97316" },
                              { from: 550, to: 650, color: "#f59e0b" },
                              { from: 650, to: 750, color: "#22c55e" },
                              { from: 750, to: 900, color: "#10b981" },
                            ].map(seg => (
                              <div key={seg.from} className="flex-1 rounded-sm opacity-30" style={{ background: seg.color }} />
                            ))}
                          </div>
                          <div className="flex justify-between mt-0.5">
                            {["V.Poor", "Poor", "Fair", "Good", "Excellent"].map(l => (
                              <span key={l} className="text-zinc-400" style={{ fontSize: "0.55rem" }}>{l}</span>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Score components */}
                    {d.score_components && (
                      <div className="rounded-2xl border border-black/[0.06] bg-white p-5">
                        <div className="text-zinc-500 mb-3" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                          Score Breakdown
                        </div>
                        <div className="space-y-3">
                          {Object.values(d.score_components).map(comp => {
                            const frac = comp.max > 0 ? comp.score / comp.max : 0;
                            return (
                              <div key={comp.label}>
                                <div className="flex items-center justify-between mb-1.5">
                                  <span className="text-zinc-700 font-medium" style={{ fontSize: "0.78rem" }}>{comp.label}</span>
                                  <span className="font-mono font-semibold text-zinc-600" style={{ fontSize: "0.72rem" }}>
                                    {comp.score} <span className="text-zinc-400">/ {comp.max}</span>
                                  </span>
                                </div>
                                <div className="h-2 rounded-full bg-black/[0.05] overflow-hidden">
                                  <div className="h-2 rounded-full transition-all" style={{
                                    width: `${frac * 100}%`,
                                    background: compBarColor(frac),
                                  }} />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Key metrics */}
                    {d.metrics && (
                      <div className="rounded-2xl border border-black/[0.06] bg-white p-5">
                        <div className="text-zinc-500 mb-3" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                          Key Metrics
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                            {[
                              { label: "Total Invoiced", value: fmt(d.metrics.total_invoiced), sub: `${d.metrics.total_invoices} invoices` },
                              { label: "Total Paid", value: fmt(d.metrics.total_paid), sub: `${d.metrics.payment_rate}% rate` },
                              { label: "Outstanding", value: fmt(d.metrics.total_outstanding), sub: `${d.metrics.unpaid_invoice_count} unpaid` },
                              { label: "Avg Days Pending", value: `${d.metrics.avg_outstanding_days} days`, sub: "from invoice date" },
                              { label: "Monthly Avg Order", value: fmt(d.metrics.avg_monthly_invoiced), sub: `${d.metrics.avg_monthly_invoice_count}/mo count` },
                              { label: "Avg Monthly Repayment", value: fmt(d.metrics.avg_monthly_repayment_yearly), sub: "yearly total / 12" },
                            ].map(m => (
                            <div key={m.label} className="rounded-xl border border-black/[0.05] bg-black/[0.015] p-3">
                              <div className="text-zinc-400 mb-1" style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>{m.label}</div>
                              <div className="text-zinc-900 font-bold" style={{ fontSize: "0.9rem" }}>{m.value}</div>
                              <div className="text-zinc-400 mt-0.5" style={{ fontSize: "0.62rem" }}>{m.sub}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Yearly breakdown */}
                    {d.yearly_breakdown.length > 0 && (
                      <div className="rounded-2xl border border-black/[0.06] bg-white overflow-hidden">
                        <div className="px-5 py-3 border-b border-black/[0.05]">
                          <span className="text-zinc-500" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                            Yearly Breakdown
                          </span>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full" style={{ borderCollapse: "collapse" }}>
                              <thead>
                                <tr className="border-b border-black/[0.04]">
                                  {["Year", "Invoiced", "Paid Amt", "Payment Rate", "Avg Mo. Repayment", "Invoices", "Payments"].map(h => (
                                    <th key={h} className="text-left px-4 py-2.5 bg-black/[0.02] text-zinc-500"
                                      style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {d.yearly_breakdown.map((row, i) => (
                                  <tr key={row.year} className={`border-b border-black/[0.03] hover:bg-black/[0.015] ${i === d.yearly_breakdown.length - 1 ? "border-b-0" : ""}`}>
                                    <td className="px-4 py-2.5 font-semibold text-zinc-800" style={{ fontSize: "0.8rem" }}>{row.year}</td>
                                    <td className="px-4 py-2.5 text-zinc-700 font-mono" style={{ fontSize: "0.78rem" }}>{fmt(row.invoiced)}</td>
                                    <td className="px-4 py-2.5 text-zinc-700 font-mono" style={{ fontSize: "0.78rem" }}>{fmt(row.payment_amount)}</td>
                                    <td className="px-4 py-2.5">
                                      <div className="flex items-center gap-2">
                                        <div className="flex-1 max-w-16 h-1.5 rounded-full bg-black/[0.06] overflow-hidden">
                                          <div className="h-1.5 rounded-full" style={{
                                            width: `${Math.min(100, row.payment_rate)}%`,
                                            background: row.payment_rate >= 80 ? "#10b981" : row.payment_rate >= 50 ? "#f59e0b" : "#ef4444",
                                          }} />
                                        </div>
                                        <span className="text-zinc-600 font-semibold" style={{ fontSize: "0.72rem" }}>{row.payment_rate}%</span>
                                      </div>
                                    </td>
                                    <td className="px-4 py-2.5 text-indigo-600 font-mono font-semibold" style={{ fontSize: "0.78rem" }}>{fmt(row.avg_monthly_repayment)}</td>
                                    <td className="px-4 py-2.5 text-zinc-600 text-center" style={{ fontSize: "0.78rem" }}>{row.invoice_count}</td>
                                    <td className="px-4 py-2.5 text-zinc-600 text-center" style={{ fontSize: "0.78rem" }}>{row.payment_count}</td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ── COLLECT PAYMENT MODAL ── */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => { setShowCreate(false); setPartyDue(null); setLockedPartyId(null); }}>
          <div className="bg-white border border-black/10 rounded-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto p-6"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                  <CreditCard className="w-4.5 h-4.5 text-amber-500" />
                </div>
                <div>
                  <h2 className="text-zinc-900 font-bold" style={{ ...css, fontSize: "1.05rem" }}>Collect Payment</h2>
                  <p className="text-zinc-500" style={{ fontSize: "0.72rem", margin: 0 }}>Create a secure approval request and send it automatically on WhatsApp</p>
                </div>
              </div>
              <button onClick={() => { setShowCreate(false); setLockedPartyId(null); }} className="text-zinc-400 hover:text-zinc-900 p-1"
                style={{ background: "none", border: "none", cursor: "pointer" }}><X className="w-5 h-5" /></button>
            </div>

            {formError && (
              <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center gap-2 text-red-400" style={{ fontSize: "0.8rem" }}>
                <AlertCircle className="w-4 h-4 shrink-0" />{formError}
              </div>
            )}

            <form onSubmit={handleCreate} className="space-y-4">
              {/* Party + Due */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-zinc-600 mb-1" style={{ fontSize: "0.75rem" }}>Party *</label>
                  {lockedPartyId ? (() => {
                    const outParty = validOutstanding.find(p => p.party_id === lockedPartyId);
                    const partyInfo = parties.find(p => p.id === lockedPartyId);
                    const name = outParty?.party_name || partyInfo?.name || lockedPartyId;
                    const code = outParty?.party_code || partyInfo?.party_code || "";
                    return (
                      <div className="w-full px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/5 flex items-center gap-2">
                        <Building2 className="w-4 h-4 text-amber-500 shrink-0" />
                        <div>
                          <div className="text-zinc-900 font-medium" style={{ fontSize: "0.82rem" }}>{name}</div>
                          {code && <div className="text-zinc-400 font-mono" style={{ fontSize: "0.65rem" }}>{code}</div>}
                        </div>
                      </div>
                    );
                  })() : (
                    <select required value={form.party_id} onChange={e => setForm({ ...form, party_id: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg border border-black/10 bg-white text-zinc-900 outline-none focus:border-amber-500/50"
                      style={{ fontSize: "0.8rem", fontFamily: "inherit" }}>
                      <option value="">Select party</option>
                      {parties.map(p => <option key={p.id} value={p.id}>{p.name} ({p.party_code})</option>)}
                    </select>
                  )}

                  {/* Outstanding summary */}
                  {form.party_id && partyDue !== null && (() => {
                    const sel = parties.find(p => p.id === form.party_id);
                    // currentBal = opening_balance + wallet_balance = true net balance
                    // (opening + payments − invoices). It already includes open invoices.
                    const currentBal = sel ? Number(sel.opening_balance) + Number(sel.wallet_balance || 0) : 0;
                    // Sum of open invoices, shown only as an informational breakdown of the
                    // total — NOT added to it (it is already reflected in currentBal).
                    const invoiceOutstanding = outstandingInvoices
                      .filter(inv => Number(inv.amount_outstanding) > 0)
                      .reduce((sum, inv) => sum + Number(inv.amount_outstanding), 0);
                    // currentBal < 0 → party owes us → red; currentBal >= 0 → settled/advance → green
                    const hasCredit = currentBal >= 0;
                    return (
                      <div className={`mt-2 px-3 py-2 rounded-lg border ${hasCredit ? "bg-emerald-500/8 border-emerald-500/20" : "bg-red-500/8 border-red-500/20"}`}>
                        <div className="flex items-center justify-between">
                          <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>
                            {hasCredit ? "Advance Balance" : "Total Due"}
                          </span>
                          <span className={`font-bold font-mono ${hasCredit ? "text-emerald-500" : "text-red-500"}`} style={{ fontSize: "0.9rem" }}>
                            {fmt(Math.abs(currentBal))}
                          </span>
                        </div>
                        {invoiceOutstanding > 0 && (
                          <div className="flex justify-between mt-1 pt-1 border-t border-black/[0.06]">
                            <span className="text-zinc-400" style={{ fontSize: "0.65rem" }}>Invoice outstanding</span>
                            <span className="text-zinc-600 font-mono" style={{ fontSize: "0.7rem" }}>{fmt(invoiceOutstanding)}</span>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>

                <div>
                  <label className="block text-zinc-600 mb-1" style={{ fontSize: "0.75rem" }}>Amount (INR) *</label>
                  <input required type="number" step="0.01" min="0.01" value={form.amount}
                    onChange={e => {
                      const val = e.target.value;
                      setForm({ ...form, amount: val });
                      // Auto-distribute across invoices sequentially
                      const totalAmount = parseFloat(val) || 0;
                      if (outstandingInvoices.length > 0) {
                        const newAdj: Record<string, number> = {};
                        let remaining = totalAmount;
                        // outstandingInvoices is already sorted oldest-first, so this
                        // allocates FIFO: clear the earliest invoice before newer ones.
                        for (const inv of outstandingInvoices) {
                          const outstanding = Number(inv.amount_outstanding);
                          const applied = parseFloat(Math.min(remaining, outstanding).toFixed(2));
                          newAdj[inv.id] = applied > 0 ? applied : 0;
                          remaining = parseFloat((remaining - applied).toFixed(2));
                        }
                        setSelectedAdj(newAdj);
                      }
                    }}
                    className="w-full px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-amber-500/50"
                    style={{ fontSize: "0.85rem", fontFamily: "inherit" }}
                    placeholder="0.00" />
                  {partyDue !== null && partyDue > 0 && (
                    <button type="button"
                      onClick={() => setForm({ ...form, amount: partyDue.toFixed(2) })}
                      className="mt-1 text-amber-500 hover:text-amber-600 transition-colors"
                      style={{ fontSize: "0.65rem", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                      Fill full due amount →
                    </button>
                  )}
                </div>
              </div>

              {/* Mode / Reference / Proof */}
              <div className={`grid gap-4 ${form.payment_mode === "CASH" ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-3"}`}>
                <div>
                  <label className="block text-zinc-600 mb-1" style={{ fontSize: "0.75rem" }}>Mode *</label>
                  <select required value={form.payment_mode}
                    onChange={e => {
                      setForm({ ...form, payment_mode: e.target.value, reference_number: "", proof_url: "" });
                      setProofFile(null); setProofPreview(null); setProofError("");
                    }}
                    className="w-full px-3 py-2 rounded-lg border border-black/10 bg-white text-zinc-900 outline-none focus:border-amber-500/50"
                    style={{ fontSize: "0.8rem", fontFamily: "inherit" }}>
                    <option value="CASH">Cash</option>
                    <option value="BANK">Bank</option>
                    <option value="COUPON">Coupon</option>
                  </select>
                </div>
                {form.payment_mode !== "CASH" && (
                  <>
                    <div>
                      <label className="block text-zinc-600 mb-1" style={{ fontSize: "0.75rem" }}>
                        {form.payment_mode === "COUPON" ? "Coupon Number *" : "Reference Number *"}
                      </label>
                      <input value={form.reference_number} onChange={e => setForm({ ...form, reference_number: e.target.value })}
                        required={form.payment_mode !== "CASH"}
                        className="w-full px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-amber-500/50"
                        style={{ fontSize: "0.8rem", fontFamily: "inherit" }}
                        placeholder={form.payment_mode === "COUPON" ? "Enter coupon number" : "Enter UTR / reference number"} />
                    </div>
                    <div>
                      <label className="block text-zinc-600 mb-1" style={{ fontSize: "0.75rem" }}>
                        {form.payment_mode === "COUPON" ? "Coupon Photo" : "Payment Proof"}
                      </label>
                      {proofPreview ? (
                        <div className="relative rounded-lg overflow-hidden border border-black/10" style={{ height: 80 }}>
                          <img src={proofPreview} alt="proof" className="w-full h-full object-cover" />
                          {proofUploading && (
                            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                              <span className="text-white" style={{ fontSize: "0.7rem" }}>Uploading…</span>
                            </div>
                          )}
                          {!proofUploading && (
                            <button
                              type="button"
                              onClick={() => { setProofFile(null); setProofPreview(null); setForm(f => ({ ...f, proof_url: "" })); setProofError(""); }}
                              className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white flex items-center justify-center"
                              style={{ fontSize: "0.65rem", border: "none", cursor: "pointer" }}
                            >✕</button>
                          )}
                        </div>
                      ) : (
                        <label
                          className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-black/15 bg-black/[0.02] cursor-pointer hover:border-amber-500/50 hover:bg-amber-500/[0.02] transition-colors"
                          style={{ height: 80 }}
                        >
                          <span className="text-zinc-400" style={{ fontSize: "0.72rem" }}>
                            {form.payment_mode === "COUPON" ? "Upload coupon photo" : "Upload payment screenshot"}
                          </span>
                          <span className="text-zinc-400/80" style={{ fontSize: "0.62rem" }}>
                            Optional · JPG, PNG, WebP · max 10MB
                          </span>
                          <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
                            onChange={e => { const f = e.target.files?.[0]; if (f) handleProofSelect(f); }} />
                        </label>
                      )}
                      {proofError && <p className="text-red-500 mt-1" style={{ fontSize: "0.7rem" }}>{proofError}</p>}
                    </div>
                  </>
                )}
              </div>

              {/* Reconcile invoices */}
              {invoicesLoading && outstandingInvoices.length === 0 && (
                <div className="flex items-center gap-2 py-3 px-1 text-zinc-400" style={{ fontSize: "0.8rem" }}>
                  <Loader2 className="w-4 h-4 animate-spin text-amber-500" />
                  Loading invoices…
                </div>
              )}
              {!invoicesLoading && form.party_id && pendingInvoices.length === 0 && (
                <div className="rounded-xl border border-black/[0.06] overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2.5 bg-black/[0.02] border-b border-black/[0.04]">
                    <FileText className="w-3.5 h-3.5 text-zinc-400" />
                    <span className="text-zinc-500" style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>Invoice History</span>
                  </div>
                  <div className="flex flex-col items-center justify-center py-6 gap-1.5 text-center">
                    <FileText className="w-7 h-7 text-zinc-200" />
                    <div className="text-zinc-500 font-medium" style={{ fontSize: "0.8rem" }}>
                      {outstandingInvoices.length > 0 ? "All invoices are fully paid" : "No invoices found for this party"}
                    </div>
                    <div className="text-zinc-400" style={{ fontSize: "0.7rem" }}>Payment will be recorded as an advance balance.</div>
                  </div>
                </div>
              )}
              {pendingInvoices.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-zinc-600" style={{ fontSize: "0.75rem" }}>
                      Invoice-wise Payment
                      <span className="ml-1 text-zinc-400" style={{ fontSize: "0.65rem" }}>({pendingInvoices.length} pending)</span>
                    </label>
                    <button type="button"
                      onClick={() => {
                        const newAdj: Record<string, number> = {};
                        pendingInvoices.forEach(inv => {
                          const amt = Number(inv.amount_outstanding);
                          if (amt > 0) newAdj[inv.id] = amt;
                        });
                        setSelectedAdj(newAdj);
                        const total = Object.values(newAdj).reduce((s, v) => s + v, 0);
                        setForm(f => ({ ...f, amount: total.toFixed(2) }));
                      }}
                      className="text-amber-500 hover:text-amber-600 transition-colors"
                      style={{ fontSize: "0.65rem", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                      Pay All →
                    </button>
                  </div>
                  <div className="rounded-xl border border-black/[0.06] overflow-hidden">
                    <div className="grid px-3 py-2 bg-black/[0.02] border-b border-black/[0.04]"
                      style={{ gridTemplateColumns: "1fr 5rem 6rem 5rem 5rem" }}>
                      {["Invoice #", "Date", "Outstanding", "Status", "Apply (₹)"].map(h => (
                        <span key={h} className="text-zinc-400" style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>{h}</span>
                      ))}
                    </div>
                    <div className="divide-y divide-black/[0.04]" style={{ maxHeight: "320px", overflowY: "auto" }}>
                      {pendingInvoices.map(inv => {
                        const applied = selectedAdj[inv.id] || 0;
                        const outstanding = Number(inv.amount_outstanding);
                        const priorPaid = Number(inv.amount_paid || 0);
                        const alreadyPaid = outstanding <= 0;
                        const isFullyApplied = !alreadyPaid && applied > 0 && applied >= outstanding;
                        // An invoice already carrying a partial payment must read PARTIAL
                        // even before any new amount is entered this session.
                        const hasPriorPartial = !alreadyPaid && priorPaid > 0;
                        const showsPartial = !isFullyApplied && (applied > 0 || hasPriorPartial);
                        return (
                          <div key={inv.id} className="grid px-3 py-2.5 items-center gap-2"
                            style={{ gridTemplateColumns: "1fr 5rem 6rem 5rem 5rem", background: alreadyPaid ? "rgba(113,113,122,0.03)" : isFullyApplied ? "rgba(16,185,129,0.03)" : "transparent", opacity: alreadyPaid ? 0.6 : 1 }}>
                            <span className="font-mono truncate" style={{ fontSize: "0.75rem", color: alreadyPaid ? "#71717a" : "#18181b" }}>{inv.invoice_number}</span>
                            <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>
                              {new Date(inv.invoice_date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" })}
                            </span>
                            <span className="font-mono flex flex-col leading-tight" style={{ fontSize: "0.78rem", color: alreadyPaid ? "#71717a" : "#ef4444" }}>
                              {fmt(outstanding)}
                              {hasPriorPartial && (
                                <span className="text-zinc-400" style={{ fontSize: "0.6rem" }}>of {fmt(Number(inv.grand_total))}</span>
                              )}
                            </span>
                            <span className={`px-1.5 py-0.5 rounded text-center font-medium ${alreadyPaid ? "bg-zinc-100 text-zinc-400" : isFullyApplied ? "bg-emerald-500/10 text-emerald-600" : showsPartial ? "bg-amber-500/10 text-amber-600" : "bg-red-500/10 text-red-500"}`}
                              style={{ fontSize: "0.55rem" }}>
                              {alreadyPaid ? "PAID" : isFullyApplied ? "PAID" : showsPartial ? "PARTIAL" : "UNPAID"}
                            </span>
                            <div className="flex items-center gap-1">
                              {alreadyPaid ? (
                                <span className="w-full text-center text-zinc-300" style={{ fontSize: "0.7rem" }}>—</span>
                              ) : (
                                <>
                                  <input type="number" step="0.01" min="0" max={outstanding}
                                    placeholder="0"
                                    value={selectedAdj[inv.id] || ""}
                                    onChange={e => {
                                      const newAdj = { ...selectedAdj, [inv.id]: parseFloat(e.target.value) || 0 };
                                      setSelectedAdj(newAdj);
                                      const total = Object.values(newAdj).reduce((s, v) => s + v, 0);
                                      setForm(f => ({ ...f, amount: total > 0 ? total.toFixed(2) : "" }));
                                    }}
                                    className="w-full px-2 py-1 rounded-lg bg-black/[0.03] border border-black/10 text-zinc-900 text-right outline-none focus:border-amber-500/50"
                                    style={{ fontSize: "0.75rem" }} />
                                  <button type="button"
                                    title="Pay full"
                                    onClick={() => {
                                      const newAdj = { ...selectedAdj, [inv.id]: outstanding };
                                      setSelectedAdj(newAdj);
                                      const total = Object.values(newAdj).reduce((s, v) => s + v, 0);
                                      setForm(f => ({ ...f, amount: total.toFixed(2) }));
                                    }}
                                    className="shrink-0 text-amber-500 hover:text-amber-600"
                                    style={{ background: "none", border: "none", cursor: "pointer", fontSize: "0.7rem", padding: "2px 0" }}>
                                    ✓
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {/* Applied total footer */}
                    {(() => {
                      const totalApplied = Object.values(selectedAdj).reduce((s, v) => s + v, 0);
                      const totalDue = pendingInvoices.reduce((s, inv) => s + Number(inv.amount_outstanding), 0);
                      if (totalApplied <= 0) return null;
                      return (
                        <div className="flex items-center justify-between px-3 py-2 bg-black/[0.02] border-t border-black/[0.04]">
                          <span className="text-zinc-500" style={{ fontSize: "0.68rem" }}>
                            Applied to {Object.values(selectedAdj).filter(v => v > 0).length} invoice{Object.values(selectedAdj).filter(v => v > 0).length !== 1 ? "s" : ""}
                          </span>
                          <span className="font-mono font-semibold text-amber-600" style={{ fontSize: "0.8rem" }}>
                            {fmt(totalApplied)} <span className="text-zinc-400 font-normal" style={{ fontSize: "0.65rem" }}>of {fmt(totalDue)}</span>
                          </span>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              )}

              {/* Notes */}
              <div>
                <label className="block text-zinc-600 mb-1" style={{ fontSize: "0.75rem" }}>Notes</label>
                <input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-amber-500/50"
                  style={{ fontSize: "0.8rem", fontFamily: "inherit" }} placeholder="Optional notes" />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowCreate(false)}
                  className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5"
                  style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", boxShadow: "none", cursor: "pointer" }}>Cancel</button>
                <button type="submit" disabled={creating || schemeCheckLoading}
                  className="px-6 py-2 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-600 disabled:opacity-50 flex items-center gap-2"
                  style={{ fontSize: "0.8rem", fontFamily: "inherit", border: "none", boxShadow: "none", cursor: "pointer" }}>
                  {(creating || schemeCheckLoading) && <Loader2 className="w-4 h-4 animate-spin" />}
                  {schemeCheckLoading ? "Checking schemes…" : creating ? "Creating & sending…" : "Initiate & Send Automatically"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Scheme Popup — shown when the party being paid has active schemes */}
      {schemePopupSchemes && schemePopupSchemes.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => { if (!creating) setSchemePopupSchemes(null); }}>
          <div className="bg-white border border-black/10 rounded-2xl w-full max-w-lg mx-4 p-6 shadow-2xl flex flex-col max-h-[90vh]"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4 shrink-0">
              <div className="w-9 h-9 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0">
                <TrendingUp className="w-4.5 h-4.5 text-violet-500" />
              </div>
              <div>
	                <h2 className="text-zinc-900 font-bold" style={{ fontSize: "1rem" }}>Active Scheme Detected</h2>
	                <p className="text-zinc-500" style={{ fontSize: "0.72rem", margin: 0 }}>
	                  This party has {schemePopupSchemes.length} active scheme{schemePopupSchemes.length > 1 ? "s" : ""}. Choose which scheme should receive this payment.
	                </p>
	              </div>
	              <div className="ml-auto flex items-center gap-2 shrink-0">
	                <div className="w-7 h-7 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-600 flex items-center justify-center font-bold" style={{ fontSize: "0.8rem" }}>?</div>
	                <button
	                  type="button"
	                  onClick={() => setSchemePopupSchemes(null)}
	                  disabled={creating}
	                  aria-label="Cancel"
	                  className="w-7 h-7 rounded-full text-zinc-400 hover:text-zinc-900 hover:bg-black/5 flex items-center justify-center disabled:opacity-50"
	                  style={{ background: "none", border: "none", cursor: "pointer" }}>
	                  <X className="w-4 h-4" />
	                </button>
	              </div>
	            </div>

            <div className="space-y-3 mb-5 overflow-y-auto flex-1 min-h-0 -mx-1 px-1">
	              {schemePopupSchemes.map(scheme => {
	                const pct = Math.min(100, scheme.progress.progress_percent || 0);
	                const remaining = Math.max(0, scheme.progress.target_value - scheme.progress.current_value);
	                const amount = parseFloat(form.amount) || 0;
	                const isSelected = selectedSchemeIds.includes(scheme.id);
	                const isAchieved = scheme.progress.is_achieved;
	                const projectedPct = scheme.progress.target_value > 0
	                  ? Math.min(100, ((scheme.progress.current_value + (isSelected ? amount : 0)) / scheme.progress.target_value) * 100)
	                  : 0;
	                return (
	                  <label
	                    key={scheme.id}
	                    className={`block rounded-xl border p-4 transition-colors ${isSelected ? "border-violet-500/35 bg-violet-500/[0.06]" : "border-violet-500/20 bg-violet-500/[0.03]"} ${isAchieved ? "opacity-75" : "cursor-pointer"}`}
	                  >
	                    <div className="flex items-start justify-between gap-2 mb-2">
	                      <div className="flex items-start gap-3 min-w-0">
	                        <input
	                          type="radio"
	                          name="party-scheme-select"
	                          checked={isSelected}
	                          disabled={isAchieved}
	                          onChange={() => setSelectedSchemeIds([scheme.id])}
	                          className="mt-1 h-4 w-4 border-zinc-300 text-violet-500 focus:ring-violet-500"
	                        />
	                        <div className="min-w-0">
	                        <div className="text-zinc-900 font-semibold" style={{ fontSize: "0.88rem" }}>{scheme.name}</div>
	                        {scheme.description && (
	                          <div className="text-zinc-500 mt-0.5" style={{ fontSize: "0.72rem" }}>{scheme.description}</div>
	                        )}
	                        </div>
	                      </div>
	                      <div className="text-right shrink-0">
                        <div className="text-zinc-500 font-mono" style={{ fontSize: "0.65rem" }}>
                          Ends {new Date(scheme.end_date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                        </div>
                        {scheme.progress.is_achieved && (
                          <span className="inline-block mt-0.5 px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-600 border border-emerald-500/20"
                            style={{ fontSize: "0.6rem", fontWeight: 600 }}>Achieved</span>
                        )}
	                      </div>
	                    </div>

                    {/* Progress bar */}
                    <div className="mb-1.5">
                      <div className="flex justify-between mb-1">
                        <span className="text-zinc-500" style={{ fontSize: "0.65rem" }}>Current progress</span>
                        <span className="text-zinc-700 font-mono font-semibold" style={{ fontSize: "0.65rem" }}>
                          {fmt(scheme.progress.current_value)} / {fmt(scheme.progress.target_value)}
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-zinc-100 overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{ width: `${pct}%`, background: pct >= 100 ? "#10b981" : "#8b5cf6" }}
                        />
                      </div>
                    </div>

                    {/* Projected after this payment */}
	                    {amount > 0 && !isAchieved && (
	                      <div className="mt-2 p-2 rounded-lg bg-amber-500/8 border border-amber-500/15">
	                        <div className="flex justify-between mb-0.5">
	                          <span className="text-amber-700" style={{ fontSize: "0.65rem" }}>{isSelected ? `After this payment (${fmt(amount)})` : "Not applied to this payment"}</span>
	                          <span className="text-amber-700 font-mono font-semibold" style={{ fontSize: "0.65rem" }}>
	                            {projectedPct.toFixed(1)}%
                          </span>
                        </div>
                        <div className="h-1.5 rounded-full bg-amber-100 overflow-hidden">
                          <div className="h-full rounded-full bg-amber-500" style={{ width: `${projectedPct}%` }} />
                        </div>
                        {remaining > 0 && (
                          <div className="text-amber-600 mt-1" style={{ fontSize: "0.6rem" }}>
                            {fmt(remaining - amount > 0 ? remaining - amount : 0)} remaining to achieve target
                          </div>
                        )}
                      </div>
                    )}

	                    {scheme.reward_description && (
	                      <div className="mt-2 text-zinc-500" style={{ fontSize: "0.65rem" }}>
	                        Reward: {scheme.reward_description}
	                      </div>
	                    )}
	                  </label>
	                );
	              })}
	            </div>

            <div className="flex flex-wrap gap-3 shrink-0">
              <button
                type="button"
                disabled={creating}
                onClick={() => setSchemePopupSchemes(null)}
                className="px-4 py-2.5 rounded-xl border border-red-500/25 text-red-600 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                style={{ fontSize: "0.82rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}>
                Cancel
              </button>
              <button
                type="button"
                disabled={creating}
	                onClick={() => doSubmitPayment(true)}
                className="flex-1 px-4 py-2.5 rounded-xl border border-black/10 text-zinc-600 hover:bg-black/5 transition-colors"
                style={{ fontSize: "0.82rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}>
	                Initiate without party scheme
	              </button>
	              <button
	                type="button"
	                disabled={creating || selectedSchemeIds.length === 0}
	                onClick={() => doSubmitPayment(false, selectedSchemeIds)}
	                className="flex-1 px-4 py-2.5 rounded-xl bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50 flex items-center justify-center gap-2 transition-colors"
	                style={{ fontSize: "0.82rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}>
	                {creating && <Loader2 className="w-4 h-4 animate-spin" />}
	                Apply scheme & initiate
	              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
