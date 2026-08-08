"use client";
/* eslint-disable @next/next/no-img-element -- the QR code is a short-lived data URI from our authenticated API */

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import {
  AlertTriangle,
  CheckCheck,
  CheckCircle2,
  Clock3,
  Eye,
  Loader2,
  MessageCircle,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Smartphone,
  XCircle,
} from "lucide-react";

type Connection = {
  configured: boolean;
  connected: boolean;
  state: string;
  instance_name: string;
  provider: "evolution";
  qr_code: string | null;
  message: string;
};

type MessageStatus = "QUEUED" | "SENDING" | "SENT" | "DELIVERED" | "READ" | "FAILED";
type MessageLog = {
  id: string;
  party_name: string;
  recipient_name: string | null;
  recipient_number: string;
  message_type: "ORDER_APPROVAL" | "INVOICE_REVIEW" | "PAYMENT_APPROVAL" | "SUPPORT_NOTIFICATION";
  reference_type: "ORDER" | "INVOICE" | "PAYMENT" | "SUPPORT";
  reference_number: string | null;
  provider_message_id: string | null;
  status: MessageStatus;
  error_message: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  created_at: string;
};

type MessageSummary = { total: number; today: number; delivered: number; read: number; failed: number };

const STATUS_META: Record<MessageStatus, { label: string; className: string }> = {
  QUEUED: { label: "Queued", className: "border-amber-200 bg-amber-50 text-amber-700" },
  SENDING: { label: "Sending", className: "border-amber-200 bg-amber-50 text-amber-700" },
  SENT: { label: "Sent", className: "border-sky-200 bg-sky-50 text-sky-700" },
  DELIVERED: { label: "Delivered", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  READ: { label: "Read", className: "border-violet-200 bg-violet-50 text-violet-700" },
  FAILED: { label: "Failed", className: "border-rose-200 bg-rose-50 text-rose-700" },
};

const MESSAGE_TYPE_LABEL: Record<MessageLog["message_type"], string> = {
  ORDER_APPROVAL: "Order approval",
  INVOICE_REVIEW: "Invoice review",
  PAYMENT_APPROVAL: "Payment approval",
  SUPPORT_NOTIFICATION: "Support notification",
};

function StatusIcon({ status }: { status: MessageStatus }) {
  if (status === "READ") return <Eye className="h-3.5 w-3.5" />;
  if (status === "DELIVERED") return <CheckCheck className="h-3.5 w-3.5" />;
  if (status === "SENT") return <Send className="h-3.5 w-3.5" />;
  if (status === "FAILED") return <XCircle className="h-3.5 w-3.5" />;
  return <Clock3 className={`h-3.5 w-3.5 ${status === "SENDING" ? "animate-pulse" : ""}`} />;
}

function displayTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export default function WhatsAppAutomationPage() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<MessageLog[]>([]);
  const [summary, setSummary] = useState<MessageSummary>({ total: 0, today: 0, delivered: 0, read: 0, failed: 0 });
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | MessageStatus>("ALL");
  const [search, setSearch] = useState("");

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const result = await api<{ success: boolean; data: Connection }>("/api/v1/whatsapp/connection", { noCache: true });
      setConnection(result.data);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "WhatsApp connection could not be checked.");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  const refreshHistory = useCallback(async (quiet = false) => {
    if (!quiet) setHistoryLoading(true);
    try {
      const result = await api<{ success: boolean; data: MessageLog[]; summary: MessageSummary }>("/api/v1/whatsapp/messages", { noCache: true });
      setMessages(result.data || []);
      setSummary(result.summary || { total: 0, today: 0, delivered: 0, read: 0, failed: 0 });
      setHistoryError("");
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : "Automatic message history could not be loaded.");
    } finally {
      if (!quiet) setHistoryLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); refreshHistory(); }, [refresh, refreshHistory]);
  useEffect(() => {
    if (!connection || connection.connected) return;
    const timer = window.setInterval(() => refresh(true), 5000);
    return () => window.clearInterval(timer);
  }, [connection, refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => refreshHistory(true), 10000);
    return () => window.clearInterval(timer);
  }, [refreshHistory]);

  async function startConnection() {
    setStarting(true);
    setError("");
    try {
      const result = await api<{ success: boolean; data: Connection }>("/api/v1/whatsapp/connection", { method: "POST" });
      setConnection(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "WhatsApp pairing could not be started.");
    } finally {
      setStarting(false);
    }
  }

  const query = search.trim().toLowerCase();
  const filteredMessages = messages.filter((message) => {
    const statusMatches = statusFilter === "ALL" || message.status === statusFilter;
    const searchMatches = !query || [message.party_name, message.recipient_number, message.reference_number, MESSAGE_TYPE_LABEL[message.message_type]]
      .some((value) => String(value || "").toLowerCase().includes(query));
    return statusMatches && searchMatches;
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6" style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      <div>
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-emerald-600"><MessageCircle className="h-4 w-4" /> Automated delivery</div>
        <h1 className="mt-2 text-2xl font-black text-zinc-950">WhatsApp Automation</h1>
        <p className="mt-1 text-sm text-zinc-500">One connection powers payment approvals, order confirmations, invoice requests, and support notifications.</p>
      </div>

      {error && <div className="flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}

      <div className="grid gap-5 lg:grid-cols-[1.25fr_0.75fr]">
        <section className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
          {loading ? (
            <div className="flex min-h-72 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-amber-500" /></div>
          ) : (
            <div className="space-y-5">
              <div className="flex items-center gap-4">
                <div className={`flex h-14 w-14 items-center justify-center rounded-2xl ${connection?.connected ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                  {connection?.connected ? <CheckCircle2 className="h-7 w-7" /> : <Smartphone className="h-7 w-7" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-lg font-black text-zinc-900">{connection?.connected ? "Connected" : "Pair the business number"}</div>
                  <div className="mt-0.5 text-xs text-zinc-500">Instance: <span className="font-mono font-bold text-zinc-700">{connection?.instance_name || "hometech"}</span></div>
                </div>
                <button onClick={() => refresh()} title="Refresh" className="rounded-xl border border-zinc-200 p-2.5 text-zinc-500 hover:bg-zinc-50"><RefreshCw className="h-4 w-4" /></button>
              </div>

              <div className={`rounded-2xl border px-4 py-3 text-sm ${connection?.connected ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
                {connection?.message}
              </div>

              {connection?.qr_code && !connection.connected && (
                <div className="flex flex-col items-center rounded-2xl border border-zinc-200 bg-zinc-50 p-5 text-center">
                  <img src={connection.qr_code} alt="WhatsApp linked-device QR code" className="h-64 w-64 rounded-xl bg-white object-contain p-2 shadow-sm" />
                  <div className="mt-4 text-sm font-bold text-zinc-800">WhatsApp → Linked devices → Link a device</div>
                  <div className="mt-1 text-xs text-zinc-500">Scan once. The session is retained across restarts.</div>
                </div>
              )}

              {!connection?.connected && (
                <button onClick={startConnection} disabled={starting || !connection?.configured} className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-500 to-emerald-600 text-sm font-black text-white shadow-lg shadow-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50">
                  {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Smartphone className="h-4 w-4" />}
                  {connection?.qr_code ? "Refresh pairing code" : "Connect business WhatsApp"}
                </button>
              )}
            </div>
          )}
        </section>

        <aside className="space-y-4">
          <div className="rounded-3xl border border-zinc-200 bg-[#111118] p-5 text-white shadow-sm">
            <div className="flex items-center gap-2 text-sm font-black"><ShieldCheck className="h-4 w-4 text-emerald-400" /> What becomes automatic</div>
            <div className="mt-4 space-y-3 text-xs text-zinc-300">
              {["Payment approval links", "Order confirmation links", "Invoice review links", "Support chat notifications"].map((item) => <div key={item} className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />{item}</div>)}
            </div>
          </div>
        </aside>
      </div>

      <section className="overflow-hidden rounded-3xl border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-100 p-5 sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700"><MessageCircle className="h-4 w-4" /></div>
                <div>
                  <h2 className="text-lg font-black text-zinc-950">Automatic message history</h2>
                  <p className="mt-0.5 text-xs text-zinc-500">Delivery acknowledgements refresh automatically every 10 seconds.</p>
                </div>
              </div>
            </div>
            <button onClick={() => refreshHistory()} disabled={historyLoading} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-zinc-200 px-4 text-xs font-black text-zinc-700 transition hover:bg-zinc-50 disabled:opacity-50">
              <RefreshCw className={`h-3.5 w-3.5 ${historyLoading ? "animate-spin" : ""}`} /> Refresh status
            </button>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
            {[
              { label: "Recent", value: summary.total, tone: "text-zinc-950", bg: "bg-zinc-50" },
              { label: "Sent today", value: summary.today, tone: "text-sky-700", bg: "bg-sky-50" },
              { label: "Delivered", value: summary.delivered, tone: "text-emerald-700", bg: "bg-emerald-50" },
              { label: "Read", value: summary.read, tone: "text-violet-700", bg: "bg-violet-50" },
              { label: "Failed", value: summary.failed, tone: "text-rose-700", bg: "bg-rose-50" },
            ].map((item) => (
              <div key={item.label} className={`rounded-2xl border border-black/5 px-4 py-3 ${item.bg}`}>
                <div className={`text-xl font-black ${item.tone}`}>{item.value}</div>
                <div className="mt-0.5 text-[11px] font-bold text-zinc-500">{item.label}</div>
              </div>
            ))}
          </div>

          <div className="mt-5 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex flex-wrap gap-2">
              {(["ALL", "SENT", "DELIVERED", "READ", "FAILED"] as const).map((status) => (
                <button key={status} onClick={() => setStatusFilter(status)} className={`rounded-full border px-3 py-1.5 text-[11px] font-black transition ${statusFilter === status ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50"}`}>
                  {status === "ALL" ? "All messages" : STATUS_META[status].label}
                </button>
              ))}
            </div>
            <label className="relative block w-full xl:w-72">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search party, phone or reference" className="h-10 w-full rounded-xl border border-zinc-200 bg-zinc-50 pl-9 pr-3 text-xs font-medium text-zinc-800 outline-none transition focus:border-emerald-400 focus:bg-white focus:ring-2 focus:ring-emerald-100" />
            </label>
          </div>
        </div>

        {historyError && <div className="m-5 flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{historyError}</div>}

        {historyLoading ? (
          <div className="flex min-h-56 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-emerald-500" /></div>
        ) : filteredMessages.length === 0 ? (
          <div className="flex min-h-56 flex-col items-center justify-center px-6 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-400"><MessageCircle className="h-6 w-6" /></div>
            <div className="mt-4 text-sm font-black text-zinc-800">{messages.length ? "No messages match this filter" : "No automatic messages yet"}</div>
            <div className="mt-1 max-w-sm text-xs leading-5 text-zinc-500">{messages.length ? "Try another status or search term." : "The next automatic order, invoice, payment, or support message will appear here with its delivery status."}</div>
          </div>
        ) : (
          <div className="divide-y divide-zinc-100">
            {filteredMessages.map((message) => {
              const status = STATUS_META[message.status];
              const statusTime = message.read_at || message.delivered_at || message.sent_at || message.created_at;
              return (
                <article key={message.id} className="grid gap-4 px-5 py-4 transition hover:bg-zinc-50/70 sm:px-6 lg:grid-cols-[1.4fr_1fr_0.85fr] lg:items-center">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="truncate text-sm font-black text-zinc-900">{message.party_name}</div>
                      <span className="shrink-0 rounded-md bg-zinc-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-zinc-500">{MESSAGE_TYPE_LABEL[message.message_type]}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
                      <span className="font-mono font-bold text-zinc-700">+{message.recipient_number}</span>
                      {message.reference_number && <><span>·</span><span>{message.reference_type}: <b className="text-zinc-700">{message.reference_number}</b></span></>}
                    </div>
                  </div>
                  <div className="text-xs text-zinc-500">
                    <div className="font-bold text-zinc-700">{displayTime(statusTime)}</div>
                    <div className="mt-1">Sent automatically</div>
                  </div>
                  <div className="flex items-center justify-between gap-3 lg:justify-end">
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-black ${status.className}`}><StatusIcon status={message.status} />{status.label}</span>
                    {message.error_message && <span title={message.error_message} className="max-w-32 truncate text-[11px] font-semibold text-rose-600">{message.error_message}</span>}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
