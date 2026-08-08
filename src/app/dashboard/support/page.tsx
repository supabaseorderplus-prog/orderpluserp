"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, getUser } from "@/lib/api";
import {
  ArrowLeft, BadgeCheck, Check, CheckCheck, ChevronDown, CircleAlert,
  Clock3, Copy, Headphones, Inbox, Loader2, LockKeyhole, MessageCircle,
  Plus, RefreshCw, Search, Send, ShieldCheck, Sparkles,
  UserCheck, X, Zap,
} from "lucide-react";

type TicketStatus = "OPEN" | "WAITING" | "RESOLVED" | "CLOSED";
type Priority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
type Category = "ORDER" | "PAYMENT" | "PRODUCT" | "TECHNICAL" | "GENERAL";

interface SupportMessage {
  id: string;
  sender_user_id: string | null;
  sender_name: string;
  sender_role: string;
  sender_type: "PARTY" | "ADMIN" | "SYSTEM";
  body: string;
  message_type: "TEXT" | "SYSTEM" | "WHATSAPP";
  created_at: string;
}

interface Conversation {
  id: string;
  ticket_number: string;
  subject: string;
  category: Category;
  priority: Priority;
  status: TicketStatus;
  created_by_name: string;
  created_by_role: string;
  assigned_to_user_id: string | null;
  assigned_to_name: string | null;
  party_unread_count: number;
  admin_unread_count: number;
  last_message_preview: string | null;
  last_message_at: string;
  created_at: string;
  party: { id: string; name: string; code: string | null; phone: string | null };
  whatsapp_automation_enabled: boolean;
  messages?: SupportMessage[];
}

interface ListResponse {
  success: boolean;
  message?: string;
  data: Conversation[];
  summary: { open: number; waiting: number; resolved: number; unread: number };
  viewer?: { is_admin: boolean; company_id: string };
}

const categoryMeta: Record<Category, { label: string; prefix: string; color: string }> = {
  ORDER: { label: "Order", prefix: "A", color: "bg-blue-50 text-blue-700 border-blue-200" },
  PAYMENT: { label: "Payment", prefix: "B", color: "bg-violet-50 text-violet-700 border-violet-200" },
  PRODUCT: { label: "Product", prefix: "C", color: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  TECHNICAL: { label: "Technical", prefix: "D", color: "bg-orange-50 text-orange-700 border-orange-200" },
  GENERAL: { label: "General", prefix: "E", color: "bg-zinc-100 text-zinc-600 border-zinc-200" },
};

const priorityMeta: Record<Priority, { label: string; dot: string; color: string }> = {
  LOW: { label: "Low", dot: "bg-zinc-400", color: "text-zinc-500" },
  NORMAL: { label: "Normal", dot: "bg-sky-500", color: "text-sky-600" },
  HIGH: { label: "High", dot: "bg-amber-500", color: "text-amber-600" },
  URGENT: { label: "Urgent", dot: "bg-rose-500", color: "text-rose-600" },
};

function timeAgo(value: string) {
  const delta = Date.now() - new Date(value).getTime();
  const mins = Math.max(0, Math.floor(delta / 60000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function messageTime(value: string) {
  return new Date(value).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

function StatusPill({ status }: { status: TicketStatus }) {
  const styles: Record<TicketStatus, string> = {
    OPEN: "bg-emerald-50 text-emerald-700 border-emerald-200",
    WAITING: "bg-amber-50 text-amber-700 border-amber-200",
    RESOLVED: "bg-blue-50 text-blue-700 border-blue-200",
    CLOSED: "bg-zinc-100 text-zinc-600 border-zinc-200",
  };
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide ${styles[status]}`}>{status}</span>;
}

export default function SupportPage() {
  const currentUser = getUser();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [summary, setSummary] = useState({ open: 0, waiting: 0, resolved: 0, unread: 0 });
  const [isAdmin, setIsAdmin] = useState(currentUser?.role === "ADMIN" || currentUser?.role === "SUPER_ADMIN");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [active, setActive] = useState<Conversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"ALL" | TicketStatus>("ALL");
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<string | null>(null);

  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);

  const loadList = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const result = await api<ListResponse>("/api/v1/support/conversations", { noCache: true });
      setConversations(result.data || []);
      setSummary(result.summary || { open: 0, waiting: 0, resolved: 0, unread: 0 });
      if (result.viewer) setIsAdmin(result.viewer.is_admin);
      const requested = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("ticket") : null;
      const nextId = selectedRef.current
        || (requested ? result.data.find((item) => item.ticket_number === requested)?.id : null)
        || result.data[0]?.id
        || null;
      if (nextId && !selectedRef.current) setSelectedId(nextId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Support inbox could not be loaded");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string, quiet = false) => {
    if (!quiet) setDetailLoading(true);
    try {
      const result = await api<{ success: boolean; data: Conversation }>(`/api/v1/support/conversations/${id}`, { noCache: true });
      setActive(result.data);
      setConversations((items) => items.map((item) => item.id === id
        ? { ...item, [isAdmin ? "admin_unread_count" : "party_unread_count"]: 0 }
        : item));
      requestAnimationFrame(() => messagesEnd.current?.scrollIntoView({ behavior: quiet ? "auto" : "smooth" }));
    } catch (err) {
      if (!quiet) setError(err instanceof Error ? err.message : "Conversation could not be loaded");
    } finally {
      if (!quiet) setDetailLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => {
    if (!selectedId) { setActive(null); return; }
    const listItem = conversations.find((item) => item.id === selectedId);
    if (listItem) setActive((previous) => previous?.id === selectedId ? { ...listItem, messages: previous.messages } : listItem);
    loadDetail(selectedId);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      loadList(true);
      if (selectedRef.current) loadDetail(selectedRef.current, true);
    }, 10000);
    return () => window.clearInterval(timer);
  }, [loadList, loadDetail]);

  const filtered = useMemo(() => conversations.filter((item) => {
    if (filter !== "ALL" && item.status !== filter) return false;
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return [item.ticket_number, item.subject, item.party?.name, item.party?.code]
      .some((value) => String(value || "").toLowerCase().includes(term));
  }), [conversations, filter, search]);

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();
    if (!text || !selectedId || sending) return;
    setSending(true);
    setMessage("");
    try {
      const result = await api<{ success: boolean; whatsapp_warning?: string | null }>(`/api/v1/support/conversations/${selectedId}/messages`, { method: "POST", body: { message: text } });
      if (result.whatsapp_warning) setError(`Chat message saved, but WhatsApp automation needs attention: ${result.whatsapp_warning}`);
      await Promise.all([loadDetail(selectedId, true), loadList(true)]);
    } catch (err) {
      setMessage(text);
      setError(err instanceof Error ? err.message : "Message could not be sent");
    } finally {
      setSending(false);
    }
  }

  async function updateConversation(changes: Record<string, unknown>) {
    if (!selectedId) return;
    try {
      await api(`/api/v1/support/conversations/${selectedId}`, { method: "PATCH", body: changes });
      await Promise.all([loadDetail(selectedId, true), loadList(true)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chat could not be updated");
    }
  }

  async function copyToken() {
    if (!active) return;
    try { await navigator.clipboard.writeText(active.ticket_number); } catch { /* embedded browser */ }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  const unreadFor = (item: Conversation) => isAdmin ? item.admin_unread_count : item.party_unread_count;
  const chatClosed = active?.status === "CLOSED" || active?.status === "RESOLVED";

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4">
      <div className="relative overflow-hidden rounded-[28px] border border-zinc-200/80 bg-[#111118] px-5 py-5 text-white shadow-[0_22px_70px_rgba(20,20,30,0.14)] sm:px-7 sm:py-6">
        <div className="pointer-events-none absolute -right-20 -top-28 h-64 w-64 rounded-full bg-amber-400/20 blur-3xl" />
        <div className="pointer-events-none absolute bottom-0 left-1/3 h-28 w-56 rounded-full bg-emerald-400/10 blur-3xl" />
        <div className="relative flex flex-col justify-between gap-5 lg:flex-row lg:items-center">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-gradient-to-br from-amber-300 to-amber-500 shadow-[0_10px_30px_rgba(245,158,11,0.25)]">
              <Headphones className="h-6 w-6 text-zinc-950" />
            </div>
            <div>
              <div className="mb-1 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-amber-300"><Sparkles className="h-3.5 w-3.5" /> Live support desk</div>
              <div className="text-2xl font-black tracking-tight sm:text-3xl">{isAdmin ? "Customer conversations" : "We’re here to help"}</div>
              <p className="mt-1 max-w-xl text-sm leading-relaxed text-zinc-400">{isAdmin ? "A focused, company-only inbox for every CNF, super dealer and retailer." : "Start a private conversation with your company administrator and track every update by token."}</p>
            </div>
          </div>
          {!isAdmin && <button onClick={() => setShowNew(true)} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-white px-5 text-sm font-bold text-zinc-950 shadow-lg transition hover:-translate-y-0.5"><Plus className="h-4 w-4" /> Start a new chat</button>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Open now", value: summary.open, icon: Inbox, tint: "text-emerald-600", bg: "bg-emerald-50" },
          { label: isAdmin ? "Waiting on party" : "Admin replied", value: summary.waiting, icon: Clock3, tint: "text-amber-600", bg: "bg-amber-50" },
          { label: "Resolved", value: summary.resolved, icon: BadgeCheck, tint: "text-blue-600", bg: "bg-blue-50" },
          { label: "Unread messages", value: summary.unread, icon: MessageCircle, tint: "text-violet-600", bg: "bg-violet-50" },
        ].map(({ label, value, icon: Icon, tint, bg }) => (
          <div key={label} className="flex items-center gap-3 rounded-2xl border border-zinc-200/80 bg-white p-3.5 shadow-sm sm:p-4">
            <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${bg} ${tint}`}><Icon className="h-5 w-5" /></div>
            <div><div className="text-xl font-black leading-none text-zinc-900">{value}</div><div className="mt-1 text-[11px] font-semibold text-zinc-500 sm:text-xs">{label}</div></div>
          </div>
        ))}
      </div>

      {error && <div className="flex items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"><span className="flex items-center gap-2"><CircleAlert className="h-4 w-4" />{error}</span><button onClick={() => setError(null)}><X className="h-4 w-4" /></button></div>}

      <div className="grid min-h-[650px] overflow-hidden rounded-[24px] border border-zinc-200/80 bg-white shadow-[0_16px_50px_rgba(20,20,30,0.08)] lg:grid-cols-[390px_minmax(0,1fr)]">
        <section className={`${selectedId ? "hidden lg:flex" : "flex"} min-h-0 flex-col border-r border-zinc-200 bg-zinc-50/70`}>
          <div className="border-b border-zinc-200 bg-white p-4">
            <div className="flex items-center justify-between"><div><div className="text-base font-black text-zinc-900">{isAdmin ? "Company inbox" : "My support chats"}</div><div className="text-xs text-zinc-500">{conversations.length} total conversations</div></div><button onClick={() => loadList()} title="Refresh" className="rounded-xl border border-zinc-200 bg-white p-2 text-zinc-500 hover:text-zinc-900"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /></button></div>
            <div className="relative mt-3"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search token, party or subject" className="h-10 w-full rounded-xl border border-zinc-200 bg-zinc-50 pl-9 pr-3 text-sm text-zinc-900 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100" /></div>
            <div className="mt-3 flex gap-1.5 overflow-x-auto pb-0.5">{(["ALL", "OPEN", "WAITING", "RESOLVED"] as const).map((value) => <button key={value} onClick={() => setFilter(value)} className={`shrink-0 rounded-lg px-2.5 py-1.5 text-[10px] font-bold tracking-wide ${filter === value ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"}`}>{value}</button>)}</div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? <div className="flex h-52 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-amber-500" /></div> : filtered.length === 0 ? (
              <div className="flex h-80 flex-col items-center justify-center px-8 text-center"><div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-100"><MessageCircle className="h-6 w-6 text-zinc-400" /></div><div className="font-bold text-zinc-800">No conversations here</div><p className="mt-1 text-xs text-zinc-500">{search ? "Try a different search." : isAdmin ? "New party requests will appear here." : "Start your first private support chat."}</p>{!isAdmin && !search && <button onClick={() => setShowNew(true)} className="mt-4 rounded-xl bg-zinc-900 px-4 py-2 text-xs font-bold text-white">Start chat</button>}</div>
            ) : filtered.map((item) => {
              const unread = unreadFor(item);
              const selected = item.id === selectedId;
              return <button key={item.id} onClick={() => setSelectedId(item.id)} className={`relative w-full border-b border-zinc-200/80 p-4 text-left transition ${selected ? "bg-white shadow-[inset_3px_0_0_#f59e0b]" : "hover:bg-white"}`}>
                <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex items-center gap-2"><span className="font-mono text-[11px] font-black tracking-wide text-amber-700">#{item.ticket_number}</span>{unread > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-zinc-900 px-1.5 text-[10px] font-bold text-white">{unread}</span>}</div><div className={`mt-1 truncate text-sm ${unread ? "font-black text-zinc-950" : "font-bold text-zinc-800"}`}>{item.subject}</div></div><span className="shrink-0 text-[10px] font-medium text-zinc-400">{timeAgo(item.last_message_at)}</span></div>
                <div className="mt-1 truncate text-xs text-zinc-500">{isAdmin && <span className="font-semibold text-zinc-700">{item.party?.name} · </span>}{item.last_message_preview || "Conversation started"}</div>
                <div className="mt-3 flex items-center justify-between gap-2"><div className="flex min-w-0 items-center gap-1.5"><StatusPill status={item.status} /><span className={`h-1.5 w-1.5 rounded-full ${priorityMeta[item.priority].dot}`} /><span className="text-[10px] font-semibold text-zinc-500">{priorityMeta[item.priority].label}</span></div>{item.assigned_to_name && <span className="max-w-[110px] truncate text-[10px] font-semibold text-zinc-500">{item.assigned_to_name}</span>}</div>
              </button>;
            })}
          </div>
          {!isAdmin && <div className="border-t border-zinc-200 bg-white p-3"><button onClick={() => setShowNew(true)} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 text-sm font-bold text-white hover:bg-zinc-800"><Plus className="h-4 w-4" /> Start new chat</button></div>}
        </section>

        <section className={`${selectedId ? "flex" : "hidden lg:flex"} min-h-0 flex-col bg-white`}>
          {!active ? <div className="flex flex-1 flex-col items-center justify-center p-8 text-center"><div className="mb-5 flex h-20 w-20 items-center justify-center rounded-[26px] border border-amber-100 bg-amber-50"><Headphones className="h-9 w-9 text-amber-500" /></div><div className="text-xl font-black text-zinc-900">Select a conversation</div><p className="mt-2 max-w-sm text-sm text-zinc-500">Messages, ticket status and WhatsApp handoff will appear here.</p></div> : <>
            <header className="border-b border-zinc-200 px-3 py-3 sm:px-5">
              <div className="flex items-center gap-3"><button onClick={() => setSelectedId(null)} className="rounded-xl p-2 text-zinc-500 hover:bg-zinc-100 lg:hidden"><ArrowLeft className="h-5 w-5" /></button><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-zinc-800 to-zinc-950 text-sm font-black text-white">{(isAdmin ? active.party?.name : "Admin").split(" ").map((word) => word[0]).join("").slice(0, 2)}</div><div className="min-w-0 flex-1"><div className="truncate text-sm font-black text-zinc-900 sm:text-base">{active.subject}</div><div className="flex items-center gap-1.5 text-[11px] text-zinc-500"><span className="truncate">{isAdmin ? `${active.party?.name}${active.party?.code ? ` · ${active.party.code}` : ""}` : "Company support team"}</span><span>·</span><button onClick={copyToken} className="inline-flex items-center gap-1 font-mono font-bold text-amber-700">#{active.ticket_number}{copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}</button></div></div><div className="hidden items-center gap-2 sm:flex"><StatusPill status={active.status} />{active.whatsapp_automation_enabled && <span className="inline-flex h-9 items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 text-xs font-black text-emerald-700"><MessageCircle className="h-4 w-4" /> Auto WhatsApp</span>}</div></div>
              {isAdmin && <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3">
                <button onClick={() => updateConversation({ assign_to_me: !active.assigned_to_user_id })} className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[11px] font-bold ${active.assigned_to_user_id ? "border-blue-200 bg-blue-50 text-blue-700" : "border-zinc-200 text-zinc-600"}`}><UserCheck className="h-3.5 w-3.5" />{active.assigned_to_name || "Assign to me"}</button>
                <label className="relative inline-flex items-center"><Zap className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-zinc-400" /><select value={active.priority} onChange={(e) => updateConversation({ priority: e.target.value })} className="h-8 appearance-none rounded-lg border border-zinc-200 bg-white pl-8 pr-7 text-[11px] font-bold text-zinc-600 outline-none"><option value="LOW">Low priority</option><option value="NORMAL">Normal priority</option><option value="HIGH">High priority</option><option value="URGENT">Urgent</option></select><ChevronDown className="pointer-events-none absolute right-2 h-3 w-3 text-zinc-400" /></label>
                <div className="flex-1" />
                {chatClosed ? <button onClick={() => updateConversation({ status: "OPEN" })} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 text-[11px] font-bold text-emerald-700"><RefreshCw className="h-3.5 w-3.5" /> Reopen chat</button> : <button onClick={() => updateConversation({ status: "CLOSED" })} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 text-[11px] font-bold text-rose-700"><LockKeyhole className="h-3.5 w-3.5" /> Stop chat</button>}
              </div>}
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(circle_at_top_right,rgba(245,158,11,0.06),transparent_30%),linear-gradient(#fafafa,#f7f7f8)] p-4 sm:p-6">
              <div className="mx-auto max-w-3xl">
                <div className="mb-6 flex items-center gap-3"><div className="h-px flex-1 bg-zinc-200" /><span className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-400">Opened {new Date(active.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}</span><div className="h-px flex-1 bg-zinc-200" /></div>
                {detailLoading && !active.messages ? <div className="flex h-52 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-amber-500" /></div> : active.messages?.map((item, index) => {
                  if (item.sender_type === "SYSTEM") return <div key={item.id} className="my-5 flex justify-center"><span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white/80 px-3 py-1.5 text-[10px] font-semibold text-zinc-500 shadow-sm"><ShieldCheck className="h-3 w-3" />{item.body}</span></div>;
                  const mine = isAdmin ? item.sender_type === "ADMIN" : item.sender_type === "PARTY";
                  const previous = active.messages?.[index - 1];
                  const grouped = previous?.sender_type === item.sender_type;
                  return <div key={item.id} className={`flex ${mine ? "justify-end" : "justify-start"} ${grouped ? "mt-1.5" : "mt-5"}`}><div className={`max-w-[86%] sm:max-w-[72%] ${mine ? "items-end" : "items-start"} flex flex-col`}>{!grouped && <span className="mb-1 px-1 text-[10px] font-bold text-zinc-500">{mine ? "You" : item.sender_name}</span>}<div className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed shadow-sm ${mine ? "rounded-br-md bg-zinc-900 text-white" : "rounded-bl-md border border-zinc-200 bg-white text-zinc-800"}`}>{item.body}<div className={`mt-1 flex items-center justify-end gap-1 text-[9px] ${mine ? "text-zinc-400" : "text-zinc-400"}`}>{messageTime(item.created_at)}{mine && <CheckCheck className="h-3 w-3 text-emerald-400" />}</div></div></div></div>;
                })}
                <div ref={messagesEnd} />
              </div>
            </div>

            {chatClosed ? <div className="border-t border-zinc-200 bg-white p-4"><div className="mx-auto flex max-w-3xl items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-xs font-semibold text-zinc-500"><LockKeyhole className="h-4 w-4" />This conversation is {active.status.toLowerCase()}. {isAdmin ? "Reopen it to send another message." : "Start a new chat if you need more help."}</div></div> : <form onSubmit={sendMessage} className="border-t border-zinc-200 bg-white p-3 sm:p-4"><div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-zinc-200 bg-zinc-50 p-2 focus-within:border-amber-400 focus-within:ring-4 focus-within:ring-amber-100/70"><textarea value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} rows={1} placeholder={isAdmin ? "Reply to this party…" : "Message your administrator…"} className="max-h-32 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-zinc-900 outline-none placeholder:text-zinc-400" /><button disabled={!message.trim() || sending} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-amber-500 text-zinc-950 shadow-md disabled:opacity-40">{sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button></div><div className="mx-auto mt-1.5 flex max-w-3xl items-center justify-between px-1 text-[10px] text-zinc-400"><span>Enter to send · Shift + Enter for a new line</span><span>{message.length}/4000</span></div></form>}
          </>}
        </section>
      </div>

      {showNew && <NewChatModal onClose={() => setShowNew(false)} onCreated={async (id) => { setShowNew(false); await loadList(true); setSelectedId(id); }} />}
    </div>
  );
}

function NewChatModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [category, setCategory] = useState<Category>("ORDER");
  const [priority, setPriority] = useState<Priority>("NORMAL");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const result = await api<{ success: boolean; data: Conversation }>("/api/v1/support/conversations", { method: "POST", body: { subject, message, category, priority } });
      onCreated(result.data.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chat could not be started");
      setSaving(false);
    }
  }

  return <div className="fixed inset-0 z-[100] flex items-end justify-center bg-zinc-950/65 p-0 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><form onSubmit={submit} className="max-h-[94dvh] w-full overflow-y-auto rounded-t-[28px] border border-white/20 bg-white shadow-2xl sm:max-w-xl sm:rounded-[28px]">
    <div className="relative overflow-hidden bg-[#111118] px-5 py-5 text-white sm:px-6"><div className="absolute -right-10 -top-12 h-36 w-36 rounded-full bg-amber-400/20 blur-2xl" /><div className="relative flex items-start justify-between"><div><div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-amber-300"><MessageCircle className="h-3.5 w-3.5" /> Private company chat</div><div className="mt-1 text-xl font-black">How can we help?</div><p className="mt-1 text-xs text-zinc-400">A unique serial token will be created automatically.</p></div><button type="button" onClick={onClose} className="rounded-xl border border-white/10 bg-white/5 p-2 text-zinc-300 hover:bg-white/10"><X className="h-4 w-4" /></button></div></div>
    <div className="space-y-5 p-5 sm:p-6">
      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>}
      <div><label className="mb-2 block text-xs font-black text-zinc-800">What is this about?</label><div className="grid grid-cols-2 gap-2 sm:grid-cols-5">{(Object.keys(categoryMeta) as Category[]).map((value) => <button type="button" key={value} onClick={() => setCategory(value)} className={`rounded-xl border p-2.5 text-left transition ${category === value ? "border-amber-400 bg-amber-50 ring-2 ring-amber-100" : "border-zinc-200 bg-white hover:bg-zinc-50"}`}><div className="font-mono text-[10px] font-black text-amber-700">{categoryMeta[value].prefix}#</div><div className="mt-1 truncate text-[10px] font-bold text-zinc-700">{categoryMeta[value].label}</div></button>)}</div></div>
      <div><label className="mb-1.5 block text-xs font-black text-zinc-800">Subject</label><input autoFocus value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={120} placeholder="e.g. Need help with order HT-2048" className="h-11 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3.5 text-sm text-zinc-900 outline-none focus:border-amber-400 focus:ring-4 focus:ring-amber-100/60" /></div>
      <div><label className="mb-1.5 block text-xs font-black text-zinc-800">Describe the issue</label><textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={4000} rows={5} placeholder="Share the details your administrator will need…" className="w-full resize-none rounded-xl border border-zinc-200 bg-zinc-50 px-3.5 py-3 text-sm text-zinc-900 outline-none focus:border-amber-400 focus:ring-4 focus:ring-amber-100/60" /></div>
      <div><label className="mb-2 block text-xs font-black text-zinc-800">Priority</label><div className="flex flex-wrap gap-2">{(Object.keys(priorityMeta) as Priority[]).map((value) => <button type="button" key={value} onClick={() => setPriority(value)} className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold ${priority === value ? "border-zinc-800 bg-zinc-900 text-white" : "border-zinc-200 text-zinc-600"}`}><span className={`h-2 w-2 rounded-full ${priorityMeta[value].dot}`} />{priorityMeta[value].label}</button>)}</div></div>
      <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2.5 text-[11px] font-semibold text-emerald-700"><ShieldCheck className="h-4 w-4 shrink-0" />Visible only to your party and this company&apos;s administrators.</div>
      <div className="flex gap-2"><button type="button" onClick={onClose} className="h-11 flex-1 rounded-xl border border-zinc-200 text-sm font-bold text-zinc-600">Cancel</button><button disabled={saving || subject.trim().length < 4 || message.trim().length < 2} className="flex h-11 flex-[1.5] items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-400 to-amber-500 text-sm font-black text-zinc-950 shadow-md disabled:opacity-50">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Create token & start</button></div>
    </div>
  </form></div>;
}
