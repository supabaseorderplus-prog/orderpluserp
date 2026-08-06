"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { BadgeCheck, CheckCircle2, Clock, Download, FileText, Loader2, ShieldCheck, WalletCards, XCircle } from "lucide-react";

interface InvoiceImpact {
  id: string; invoice_number: string; invoice_date: string | null; invoice_total: number;
  outstanding_before: number; allocation: number; outstanding_after: number; status_after: string;
}
interface SchemeImpact {
  id: string; name: string; target_value: number; current_value: number; payment_credit: number;
  projected_value: number; progress_before: number; progress_after: number; status_after: string; end_date: string | null;
}
interface ApprovalView {
  request_number: string; company_name: string; party_name: string; party_code: string; collector_name: string;
  created_at: string; expires_at: string; balance_before: number; balance_after: number; unallocated_amount: number;
  invoices: InvoiceImpact[]; schemes: SchemeImpact[];
  payment: { amount: number; payment_mode: string; reference_number: string | null; bank_name: string | null; notes: string | null; proof_url: string | null };
}

const money = (n: number) => "₹" + new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);
const date = (v: string | null) => v ? new Date(v).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

export default function PaymentApprovalPage() {
  const params = useParams<{ token: string }>();
  const token = Array.isArray(params?.token) ? params.token[0] : params?.token;
  const [view, setView] = useState<ApprovalView | null>(null);
  const [loading, setLoading] = useState(true);
  const [closed, setClosed] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState<{ payment_number?: string } | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch(`/api/v1/public/payment-approval/${token}`, { cache: "no-store" });
      const json = await response.json();
      if (!response.ok || !json.success) {
        setClosed(json.status || "NOT_FOUND");
        setView(null);
      } else {
        setView(json.data);
        setName(json.data.party_name || "");
      }
    } catch { setClosed("NOT_FOUND"); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const approve = async () => {
    if (!token || submitting) return;
    setSubmitting(true); setError("");
    try {
      const response = await fetch("/api/v1/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approval_token: token, approver_name: name.trim() }),
      });
      const json = await response.json();
      if (!response.ok || !json.success) throw new Error(json.message || "Payment could not be approved.");
      setCompleted({ payment_number: json.data?.payment_number });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Payment could not be approved.");
    } finally { setSubmitting(false); }
  };

  if (loading) return <main className="min-h-screen grid place-items-center bg-zinc-100"><Loader2 className="h-8 w-8 animate-spin text-amber-500" /></main>;

  if (completed) return (
    <main className="min-h-screen grid place-items-center bg-zinc-100 p-4 text-zinc-900">
      <section className="w-full max-w-lg rounded-3xl border border-emerald-200 bg-white p-8 text-center shadow-xl">
        <CheckCircle2 className="mx-auto h-14 w-14 text-emerald-500" />
        <h1 className="mt-4 text-2xl font-bold">Payment approved</h1>
        <p className="mt-2 text-sm text-zinc-500">The transaction has been posted successfully{completed.payment_number ? ` as ${completed.payment_number}` : ""}. Invoice balances, wallet and scheme progress are now updated.</p>
        <div className="mt-5 rounded-xl bg-zinc-100 px-4 py-3 text-xs text-zinc-500">For security, this approval link and its PDF expired immediately after confirmation.</div>
      </section>
    </main>
  );

  if (!view || closed) return (
    <main className="min-h-screen grid place-items-center bg-zinc-100 p-4 text-zinc-900">
      <section className="w-full max-w-lg rounded-3xl border border-black/[0.06] bg-white p-8 text-center shadow-lg">
        {closed === "APPROVED" ? <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" /> : <XCircle className="mx-auto h-12 w-12 text-zinc-300" />}
        <h1 className="mt-3 text-xl font-bold">{closed === "APPROVED" ? "Payment already approved" : closed === "PROCESSING" ? "Payment is processing" : "Link unavailable"}</h1>
        <p className="mt-2 text-sm text-zinc-500">{closed === "APPROVED" ? "This single-use link expired immediately after approval." : "This link is invalid, expired, or temporarily unavailable. Contact your supplier if you need a fresh request."}</p>
      </section>
    </main>
  );

  return (
    <main className="min-h-screen bg-zinc-100 px-4 py-6 text-zinc-900 sm:py-10">
      <div className="mx-auto max-w-3xl">
        <header className="mb-5 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-zinc-900"><WalletCards className="h-5 w-5 text-amber-400" /></div>
          <div><div className="font-bold">{view.company_name}</div><div className="text-xs text-zinc-500">Secure payment acknowledgement</div></div>
        </header>
        <section className="overflow-hidden rounded-3xl border border-black/[0.06] bg-white shadow-xl">
          <div className="flex gap-3 bg-amber-50 px-5 py-4 text-amber-900"><ShieldCheck className="h-6 w-6 shrink-0" /><div><div className="font-bold">Your approval is required</div><p className="text-xs text-amber-800/70">Review every detail below. Nothing is posted until you approve.</p></div></div>
          <div className="grid gap-4 border-b border-zinc-100 p-5 sm:grid-cols-2">
            <div><div className="text-xs uppercase tracking-wider text-zinc-400">Payment request</div><h1 className="mt-1 text-xl font-bold">{view.request_number}</h1><div className="mt-1 text-xs text-zinc-500">Initiated {date(view.created_at)}</div></div>
            <div className="sm:text-right"><div className="text-xs uppercase tracking-wider text-zinc-400">Amount</div><div className="mt-1 text-3xl font-black text-amber-600">{money(view.payment.amount)}</div><div className="text-xs text-zinc-500">{view.payment.payment_mode}{view.payment.reference_number ? ` · ${view.payment.reference_number}` : ""}</div></div>
          </div>
          <div className="grid grid-cols-2 gap-px bg-zinc-100 sm:grid-cols-4">
            {[["Party", view.party_name], ["Party code", view.party_code || "—"], ["Collected by", view.collector_name], ["Balance after", money(view.balance_after)]].map(([label, value]) => <div key={label} className="bg-white p-4"><div className="text-[0.65rem] uppercase text-zinc-400">{label}</div><div className="mt-1 text-sm font-semibold">{value}</div></div>)}
          </div>

          <div className="border-t border-zinc-100 p-5">
            <div className="mb-3 flex items-center justify-between"><h2 className="flex items-center gap-2 text-sm font-bold"><FileText className="h-4 w-4 text-amber-500" />Invoice allocation</h2><a href={`/api/v1/public/payment-approval/${token}/pdf`} target="_blank" className="flex items-center gap-1 text-xs font-semibold text-amber-600"><Download className="h-3.5 w-3.5" />Detailed PDF</a></div>
            {view.invoices.length ? <div className="overflow-x-auto rounded-xl border border-zinc-200"><table className="w-full min-w-[600px] text-left text-xs"><thead className="bg-zinc-900 text-white"><tr>{["Invoice", "Before", "Applied", "After", "Status"].map(h => <th key={h} className="px-3 py-2">{h}</th>)}</tr></thead><tbody>{view.invoices.map(inv => <tr key={inv.id} className="border-t border-zinc-100"><td className="px-3 py-3 font-semibold">{inv.invoice_number}</td><td className="px-3 py-3">{money(inv.outstanding_before)}</td><td className="px-3 py-3 text-amber-600">{money(inv.allocation)}</td><td className="px-3 py-3">{money(inv.outstanding_after)}</td><td className="px-3 py-3 font-semibold text-emerald-600">{inv.status_after}</td></tr>)}</tbody></table></div> : <div className="rounded-xl bg-zinc-50 p-4 text-sm text-zinc-500">Advance / unallocated payment. No invoice is attached.</div>}
          </div>

          <div className="border-t border-zinc-100 p-5">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-bold"><BadgeCheck className="h-4 w-4 text-violet-500" />Scheme impact</h2>
            {view.schemes.length ? <div className="space-y-3">{view.schemes.map(scheme => <div key={scheme.id} className="rounded-xl border border-zinc-200 p-4"><div className="flex justify-between gap-4"><div className="font-semibold">{scheme.name}</div><div className="text-xs font-bold text-violet-600">{scheme.status_after}</div></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-100"><div className="h-full rounded-full bg-violet-500" style={{ width: `${Math.min(100, scheme.progress_after)}%` }} /></div><div className="mt-2 flex justify-between text-xs text-zinc-500"><span>{scheme.progress_before.toFixed(1)}% before</span><span>{money(scheme.projected_value)} / {money(scheme.target_value)} · {scheme.progress_after.toFixed(1)}% after</span></div></div>)}</div> : <div className="rounded-xl bg-zinc-50 p-4 text-sm text-zinc-500">No party scheme is attached to this payment.</div>}
          </div>

          <div className="border-t border-zinc-100 bg-zinc-50 p-5">
            <label className="text-xs font-semibold text-zinc-600">Name of approving person</label>
            <input value={name} onChange={event => setName(event.target.value)} maxLength={120} className="mt-1 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-amber-500" placeholder="Enter your name" />
            {error && <div className="mt-3 rounded-lg bg-red-50 p-3 text-xs text-red-600">{error}</div>}
            <button onClick={approve} disabled={submitting || !name.trim()} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 py-3 font-bold text-zinc-950 hover:bg-amber-400 disabled:opacity-50">
              {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />}{submitting ? "Posting payment securely…" : `Approve payment of ${money(view.payment.amount)}`}
            </button>
            <p className="mt-3 flex items-center justify-center gap-1 text-center text-[0.68rem] text-zinc-400"><Clock className="h-3 w-3" />Link expires {date(view.expires_at)} or immediately after approval.</p>
          </div>
        </section>
      </div>
    </main>
  );
}
