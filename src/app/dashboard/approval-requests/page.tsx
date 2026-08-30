"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CalendarDays,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Loader2,
  MapPin,
  RefreshCw,
  Route,
  ShieldCheck,
  UserRound,
  X,
  XCircle,
} from "lucide-react";
import { api } from "@/lib/api";
import { useVisibleInterval } from "@/lib/hooks/use-visible-interval";

type ApprovalStatus = "pending" | "approved" | "rejected";

type DutyApproval = {
  run_id: string;
  salesman_id: string;
  salesman_name: string;
  route_id: string;
  route_name: string;
  work_date: string;
  total_stops: number;
  visited_stops: number;
  remaining_stops: number;
  remaining_parties: Array<{ stop_id: string; party_id: string; name: string }>;
  request: {
    id: string;
    status: ApprovalStatus;
    reason: string;
    requested_at: string;
    decided_at: string | null;
    decided_by_name: string | null;
    decision_note: string | null;
  };
};

type ApprovalResponse = {
  data?: DutyApproval[];
  meta?: { can_approve?: boolean };
};

const dateTime = (value: string | null) => value
  ? new Date(value).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  : "—";

const workDate = (value: string) => new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const statusMeta: Record<ApprovalStatus, { label: string; className: string; icon: typeof Clock3 }> = {
  pending: { label: "Pending", className: "border-amber-200 bg-amber-50 text-amber-700", icon: Clock3 },
  approved: { label: "Approved", className: "border-emerald-200 bg-emerald-50 text-emerald-700", icon: CheckCircle2 },
  rejected: { label: "Rejected", className: "border-rose-200 bg-rose-50 text-rose-700", icon: XCircle },
};

function SummaryCard({ label, value, helper, tone }: { label: string; value: number; helper: string; tone: string }) {
  return (
    <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_8px_30px_rgba(0,0,0,0.035)]">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-bold text-zinc-500">{label}</span>
        <span className={`h-2.5 w-2.5 rounded-full ${tone}`} />
      </div>
      <div className="mt-3 text-2xl font-black tabular-nums text-zinc-900">{value}</div>
      <p className="mt-1 text-[0.68rem] text-zinc-400">{helper}</p>
    </div>
  );
}

function ApprovalCard({ item, canApprove, busy, onDecision }: {
  item: DutyApproval;
  canApprove: boolean;
  busy: boolean;
  onDecision: (item: DutyApproval, action: "approve" | "reject", note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const status = statusMeta[item.request.status];
  const StatusIcon = status.icon;
  const progress = item.total_stops > 0 ? Math.round((item.visited_stops / item.total_stops) * 100) : 0;

  return (
    <article className="overflow-hidden rounded-2xl border border-black/[0.07] bg-white shadow-[0_14px_45px_rgba(0,0,0,0.045)]">
      <div className={`h-1 ${item.request.status === "pending" ? "bg-gradient-to-r from-amber-400 via-orange-400 to-rose-400" : item.request.status === "approved" ? "bg-emerald-500" : "bg-rose-500"}`} />
      <div className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-bold text-zinc-900">{item.salesman_name}</h2>
              <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.65rem] font-bold ${status.className}`}>
                <StatusIcon className="h-3 w-3" /> {status.label}
              </span>
            </div>
            <p className="mt-1 text-xs text-zinc-400">Duty-off request · {dateTime(item.request.requested_at)}</p>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-right">
            <div className="text-[0.62rem] font-bold uppercase tracking-wider text-zinc-400">Route progress</div>
            <div className="mt-0.5 text-sm font-black text-zinc-900">{item.visited_stops} / {item.total_stops} visited</div>
          </div>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <div className="flex items-center gap-2 rounded-xl bg-zinc-50 px-3 py-2.5 text-xs text-zinc-600">
            <Route className="h-4 w-4 shrink-0 text-amber-500" />
            <span className="min-w-0 truncate font-semibold">{item.route_name}</span>
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-zinc-50 px-3 py-2.5 text-xs text-zinc-600">
            <CalendarDays className="h-4 w-4 shrink-0 text-blue-500" />
            <span className="font-semibold">{workDate(item.work_date)}</span>
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-zinc-50 px-3 py-2.5 text-xs text-zinc-600">
            <MapPin className="h-4 w-4 shrink-0 text-rose-500" />
            <span className="font-semibold">{item.remaining_stops} remaining</span>
          </div>
        </div>

        <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-100">
          <div className="h-full rounded-full bg-gradient-to-r from-amber-400 to-emerald-500" style={{ width: `${progress}%` }} />
        </div>

        <div className="mt-4 rounded-xl border border-amber-100 bg-amber-50/60 p-3">
          <div className="text-[0.65rem] font-bold uppercase tracking-wider text-amber-700">Salesman&apos;s reason</div>
          <p className="mt-1 text-sm leading-relaxed text-zinc-700">{item.request.reason}</p>
        </div>

        {item.remaining_parties.length > 0 && (
          <div className="mt-4">
            <div className="text-[0.65rem] font-bold uppercase tracking-wider text-zinc-400">Parties not visited</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {item.remaining_parties.map((party) => (
                <span key={party.stop_id} className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-[0.68rem] font-semibold text-zinc-600">
                  <MapPin className="h-3 w-3 text-zinc-400" /> {party.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {item.request.status !== "pending" && (
          <div className={`mt-4 rounded-xl border px-3 py-2.5 text-xs ${status.className}`}>
            <div className="font-bold">{status.label} by {item.request.decided_by_name || "Approver"} · {dateTime(item.request.decided_at)}</div>
            {item.request.decision_note && <p className="mt-1 leading-relaxed">{item.request.decision_note}</p>}
          </div>
        )}

        {item.request.status === "pending" && canApprove && (
          <div className="mt-4 border-t border-zinc-100 pt-4">
            <label className="block">
              <span className="mb-1.5 block text-[0.7rem] font-bold text-zinc-600">Decision note {rejecting ? "(required)" : "(optional)"}</span>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={rejecting ? "Explain why this duty-off request is rejected" : "Add instructions or context for the salesman"}
                rows={2}
                className="w-full resize-none rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm text-zinc-900 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-500/10"
              />
            </label>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setRejecting((value) => !value)}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 bg-white px-3 py-2 text-xs font-bold text-rose-600 hover:bg-rose-50 disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" /> {rejecting ? "Cancel rejection" : "Reject"}
              </button>
              {rejecting ? (
                <button
                  type="button"
                  onClick={() => onDecision(item, "reject", note)}
                  disabled={busy || !note.trim()}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-4 py-2 text-xs font-bold text-white hover:bg-rose-700 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />} Confirm rejection
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onDecision(item, "approve", note)}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Approve duty off
                </button>
              )}
            </div>
          </div>
        )}

        {item.request.status === "pending" && !canApprove && (
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 text-xs font-medium text-blue-700">
            <ShieldCheck className="h-4 w-4 shrink-0" /> You have view access. A role with Approve permission must make the decision.
          </div>
        )}
      </div>
    </article>
  );
}

export default function ApprovalRequestsPage() {
  const [items, setItems] = useState<DutyApproval[]>([]);
  const [canApprove, setCanApprove] = useState(false);
  const [tab, setTab] = useState<"pending" | "history">("pending");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const result = await api<ApprovalResponse>("/api/v1/duty/signoff?status=all", { noCache: true });
      setItems(result.data || []);
      setCanApprove(Boolean(result.meta?.can_approve));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load approval requests");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useVisibleInterval(() => { void load(true); }, 30_000);

  const summary = useMemo(() => ({
    pending: items.filter((item) => item.request.status === "pending").length,
    approved: items.filter((item) => item.request.status === "approved").length,
    rejected: items.filter((item) => item.request.status === "rejected").length,
  }), [items]);

  const visible = items.filter((item) => tab === "pending"
    ? item.request.status === "pending"
    : item.request.status !== "pending");

  const decide = async (item: DutyApproval, action: "approve" | "reject", note: string) => {
    setBusyId(item.run_id);
    setError("");
    try {
      await api("/api/v1/duty/signoff", {
        method: "PATCH",
        body: { run_id: item.run_id, action, decision_note: note },
      });
      window.dispatchEvent(new Event("approvalRequestsChanged"));
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update approval request");
    } finally {
      setBusyId("");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-amber-200 bg-amber-50">
            <ClipboardCheck className="h-5 w-5 text-amber-600" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-zinc-900">Approval Requests</h1>
            <p className="text-xs text-zinc-500">Review duty-off requests and other operational exceptions</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs font-bold text-zinc-600 shadow-sm hover:bg-zinc-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard label="Waiting for decision" value={summary.pending} helper="Duty-off requests needing review" tone="bg-amber-400" />
        <SummaryCard label="Approved" value={summary.approved} helper="Requests approved in this queue" tone="bg-emerald-500" />
        <SummaryCard label="Rejected" value={summary.rejected} helper="Requests returned to salesmen" tone="bg-rose-500" />
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      <div className="flex items-center gap-1 rounded-xl border border-black/[0.06] bg-white p-1 shadow-sm sm:w-fit">
        <button
          type="button"
          onClick={() => setTab("pending")}
          className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 text-xs font-bold transition-colors sm:flex-none ${tab === "pending" ? "bg-amber-500 text-zinc-950" : "text-zinc-500 hover:bg-zinc-50"}`}
        >
          <Clock3 className="h-3.5 w-3.5" /> Pending <span className="rounded-full bg-black/10 px-1.5 py-0.5 text-[0.6rem]">{summary.pending}</span>
        </button>
        <button
          type="button"
          onClick={() => setTab("history")}
          className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 text-xs font-bold transition-colors sm:flex-none ${tab === "history" ? "bg-zinc-900 text-white" : "text-zinc-500 hover:bg-zinc-50"}`}
        >
          <ClipboardCheck className="h-3.5 w-3.5" /> Decision history
        </button>
      </div>

      {loading ? (
        <div className="flex min-h-52 items-center justify-center rounded-2xl border border-black/[0.06] bg-white">
          <Loader2 className="h-6 w-6 animate-spin text-amber-500" />
        </div>
      ) : visible.length > 0 ? (
        <div className="space-y-4">
          {visible.map((item) => (
            <ApprovalCard
              key={item.run_id}
              item={item}
              canApprove={canApprove}
              busy={busyId === item.run_id}
              onDecision={decide}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-zinc-200 bg-white px-6 py-14 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-100">
            {tab === "pending" ? <CheckCircle2 className="h-6 w-6 text-emerald-500" /> : <UserRound className="h-6 w-6 text-zinc-400" />}
          </div>
          <h2 className="mt-4 font-bold text-zinc-900">{tab === "pending" ? "All caught up" : "No decision history yet"}</h2>
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-zinc-500">
            {tab === "pending"
              ? "New duty-off requests will appear here automatically when a salesman cannot finish the assigned route."
              : "Approved and rejected requests will remain here for review."}
          </p>
        </div>
      )}
    </div>
  );
}
