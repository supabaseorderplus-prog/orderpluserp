"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { api, getUser, setActiveCompany, clearActiveCompany, logout } from "@/lib/api";
import Link from "next/link";
import { fetchDeliveryLots } from "@/lib/delivery-lots";
import { useVisibleInterval } from "@/lib/hooks/use-visible-interval";
import InvoiceRequestsSection from "@/components/invoice-requests-section";
import {
  ArrowRight, BarChart3, BookOpen, Box, Building2, ChevronRight,
  CreditCard, FileText, Gift, IndianRupee, Loader2, LogOut, Plus,
  Receipt, Shield, ShoppingCart, Trash2, TrendingUp, Trophy, Users,
  AlertTriangle, CheckCircle2, Banknote, XCircle, ArrowLeft, X,
  Search, Bell, StickyNote, Lock, Unlock, Edit2, Download, ClipboardList,
  Key, Activity, LayoutGrid, List, ArrowUpDown, Filter, SortAsc, Eye,
  PauseCircle, PlayCircle, RefreshCw, ChevronDown, Send, Calendar,
  Star, Zap, TrendingDown, Clock, Globe, Hash, Percent, MoreHorizontal,
  ChevronUp, Info, Crown, Package, Sparkles, AlertCircle, HeartPulse, Camera,
  History, ArrowDownLeft, ArrowUpRight, Truck, MapPin,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Company {
  id: string;
  name: string;
  party_code: string;
  contact_phone: string | null;
  contact_email: string | null;
  city: string | null;
  status: string;
  gstin?: string | null;
  totalUsers: number;
  activeUsers?: number;
  outstanding: number;
  overdue?: number;
  lastLogin?: string | null;
  lastInvoiceDate?: string | null;
  logo_url?: string | null;
}

interface Subscription {
  id: string;
  company_id: string;
  plan_name: string;
  plan_tier: string;
  started_at: string;
  expires_at: string | null;
  amount_monthly: number;
  status: string;
  notes: string | null;
}

interface PlanTemplate {
  id: string;
  name: string;
  plan_tier: string;
  amount_monthly: number;
  duration_days: number;
  description: string | null;
  features: string[];
  is_active: boolean;
}

interface SubscriptionPayment {
  id: string;
  subscription_id: string;
  company_id: string;
  amount: number;
  payment_date: string;
  payment_method: string;
  reference_no: string | null;
  notes: string | null;
  recorded_by: string | null;
  created_at: string;
}

interface AgingData {
  CURRENT: number;
  BUCKET_1: number;
  BUCKET_2: number;
  BUCKET_3: number;
  BUCKET_4: number;
}

interface RecentInvoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  grand_total: number;
  payment_status: string;
  aging_bucket: string;
  party_name: string;
}

interface TopParty {
  id: string;
  name: string;
  party_code: string;
  outstanding: number;
}

interface DashboardData {
  todaySales: number;
  mtdSales: number;
  ytdSales: number;
  activeOrders: number;
  outstanding: number;
  activeSalesmen: number;
  totalParties: number;
  tdEarned: number;
  cdEarned: number;
  todayCollection: number;
  mtdCollection: number;
  activeSchemes: number;
  aging: AgingData;
  recentInvoices: RecentInvoice[];
  topOutstandingParties: TopParty[];
}

interface CompanyNote {
  id: string;
  note: string;
  created_at: string;
}

interface AuditLog {
  id: string;
  user_id: string;
  user_name: string;
  action: string;
  module: string;
  record_id: string | null;
  timestamp: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatINR(amount: number): string {
  if (amount >= 10000000) return `${(amount / 10000000).toFixed(2)} Cr`;
  if (amount >= 100000) return `${(amount / 100000).toFixed(2)} L`;
  if (amount >= 1000) return `${(amount / 1000).toFixed(1)}K`;
  return amount.toLocaleString("en-IN");
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
}

function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return "Never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor(diff / 60000);
  if (days > 365) return `${Math.floor(days / 365)}y ago`;
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "Just now";
}

function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const now = new Date();
  const target = new Date(dateStr);
  // Compare date-only (strip time) so "today" = 0, tomorrow = 1, etc.
  const nowDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetDate = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  return Math.round((targetDate.getTime() - nowDate.getTime()) / 86400000);
}

function getHealthScore(company: Company): { score: number; label: string; color: string; bg: string; dot: string; border: string } {
  let score = 100;
  const overdueRatio = company.outstanding > 0 ? ((company.overdue || 0) / company.outstanding) : 0;
  if (overdueRatio > 0.5) score -= 40;
  else if (overdueRatio > 0.2) score -= 20;
  if (company.status === "SUSPENDED") score -= 60;
  const daysSinceInvoice = company.lastInvoiceDate
    ? Math.floor((Date.now() - new Date(company.lastInvoiceDate).getTime()) / 86400000) : 999;
  if (daysSinceInvoice > 60) score -= 30;
  else if (daysSinceInvoice > 30) score -= 15;
  const daysSinceLogin = company.lastLogin
    ? Math.floor((Date.now() - new Date(company.lastLogin).getTime()) / 86400000) : 999;
  if (daysSinceLogin > 45) score -= 20;
  else if (daysSinceLogin > 14) score -= 10;
  score = Math.max(0, score);
  if (score >= 75) return { score, label: "Healthy", color: "text-emerald-400", bg: "bg-emerald-500/10", dot: "bg-emerald-500", border: "border-emerald-500/20" };
  if (score >= 45) return { score, label: "Attention", color: "text-amber-400", bg: "bg-amber-500/10", dot: "bg-amber-500", border: "border-amber-500/20" };
  return { score, label: "At Risk", color: "text-red-400", bg: "bg-red-500/10", dot: "bg-red-500", border: "border-red-500/20" };
}

function generateAlerts(companies: Company[], subs: Subscription[]): { companyName: string; message: string; severity: "red" | "amber"; type: string }[] {
  const alerts: { companyName: string; message: string; severity: "red" | "amber"; type: string }[] = [];
  const subMap = new Map(subs.map(s => [s.company_id, s]));

  companies.forEach(c => {
    if (c.status === "SUSPENDED") {
      alerts.push({ companyName: c.name, message: `${c.name} is currently suspended`, severity: "red", type: "suspended" });
    }
    const overdue = c.overdue || 0;
    if (overdue > 100000) {
      alerts.push({ companyName: c.name, message: `${c.name} has ₹${formatINR(overdue)} overdue (60d+)`, severity: "red", type: "overdue" });
    }
    const daysSinceInvoice = c.lastInvoiceDate
      ? Math.floor((Date.now() - new Date(c.lastInvoiceDate).getTime()) / 86400000) : 999;
    if (daysSinceInvoice > 30) {
      alerts.push({ companyName: c.name, message: `${c.name} has no invoices for ${daysSinceInvoice === 999 ? "ever" : `${daysSinceInvoice}+ days`}`, severity: "amber", type: "inactive" });
    }
    const daysSinceLogin = c.lastLogin
      ? Math.floor((Date.now() - new Date(c.lastLogin).getTime()) / 86400000) : 999;
    if (daysSinceLogin > 45) {
      alerts.push({ companyName: c.name, message: `${c.name} admin hasn't logged in for ${daysSinceLogin === 999 ? "a very long time" : `${daysSinceLogin}+ days`}`, severity: "amber", type: "login" });
    }
    // Subscription expiry alerts
    const sub = subMap.get(c.id);
    if (sub?.expires_at) {
      const days = daysUntil(sub.expires_at);
      if (days !== null && days <= 0) {
        alerts.push({ companyName: c.name, message: `${c.name}'s ${sub.plan_name} plan has expired`, severity: "red", type: "expired" });
      } else if (days !== null && days <= 30) {
        alerts.push({ companyName: c.name, message: `${c.name}'s ${sub.plan_name} plan expires in ${days} days`, severity: "amber", type: "expiring" });
      }
    }
  });
  return alerts.sort((a, b) => (a.severity === "red" ? -1 : 1));
}

const statusConfig: Record<string, { label: string; color: string; bg: string }> = {
  PAID: { label: "Paid", color: "text-emerald-400", bg: "bg-emerald-500/10" },
  PARTIAL: { label: "Partial", color: "text-amber-400", bg: "bg-amber-500/10" },
  UNPAID: { label: "Unpaid", color: "text-red-400", bg: "bg-red-500/10" },
  ADVANCE_ADJUSTED: { label: "Adjusted", color: "text-blue-400", bg: "bg-blue-500/10" },
};

const agingLabels: Record<string, { label: string; color: string; barColor: string }> = {
  CURRENT: { label: "0-30d", color: "text-emerald-400", barColor: "bg-emerald-500" },
  BUCKET_1: { label: "31-60d", color: "text-blue-400", barColor: "bg-blue-500" },
  BUCKET_2: { label: "61-90d", color: "text-amber-400", barColor: "bg-amber-500" },
  BUCKET_3: { label: "91-120d", color: "text-orange-400", barColor: "bg-orange-500" },
  BUCKET_4: { label: "120d+", color: "text-red-400", barColor: "bg-red-500" },
};

const PLAN_TIERS: { value: string; label: string; color: string; bg: string; border: string; gradient: string; icon: typeof Crown }[] = [
  { value: "BASIC", label: "Basic", color: "text-zinc-600", bg: "bg-zinc-500/10", border: "border-zinc-500/20", gradient: "from-zinc-500/20 to-zinc-500/5", icon: Package },
  { value: "STANDARD", label: "Standard", color: "text-blue-400", bg: "bg-blue-500/10", border: "border-blue-500/20", gradient: "from-blue-500/20 to-blue-500/5", icon: Star },
  { value: "PRO", label: "Pro", color: "text-violet-400", bg: "bg-violet-500/10", border: "border-violet-500/20", gradient: "from-violet-500/20 to-violet-500/5", icon: Zap },
  { value: "ENTERPRISE", label: "Enterprise", color: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/20", gradient: "from-amber-500/20 to-amber-500/5", icon: Crown },
];

const COMPANY_TYPE_ID = "fdcc59d3-fdc1-4700-94eb-3c2cf7e28c03";

const emptyForm = {
  name: "", party_code: "", address_line1: "", city: "",
  contact_phone: "", contact_email: "", contact_person: "",
  gstin: "", pan: "", portal_password: "",
};

const inputStyle = {
  background: "rgba(17, 17, 24,0.04)",
  border: "1px solid rgba(17, 17, 24,0.08)",
  fontFamily: "inherit",
};

// ─── Modal Backdrop ────────────────────────────────────────────────────────────

function ModalBackdrop({ onClose, children, maxWidth = "max-w-md" }: { onClose: () => void; children: React.ReactNode; maxWidth?: string }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.8)", backdropFilter: "blur(6px)" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={`w-full ${maxWidth} rounded-2xl overflow-hidden`} style={{ background: "#fffbeb", border: "1px solid rgba(234,179,8,0.15)", maxHeight: "90vh", overflowY: "auto" }}>
        {children}
      </div>
    </div>
  );
}

function ModalHeader({ title, subtitle, icon: Icon, iconColor, iconBg, onClose }: { title: string; subtitle?: string; icon: any; iconColor: string; iconBg: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between px-5 py-4 border-b border-black/[0.06]">
      <div className="flex items-center gap-2.5">
        <div className={`w-8 h-8 rounded-lg ${iconBg} flex items-center justify-center`}><Icon className={`w-4 h-4 ${iconColor}`} /></div>
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
          {subtitle && <p className="text-[0.65rem] text-zinc-500">{subtitle}</p>}
        </div>
      </div>
      <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-900 hover:bg-black/[0.06] transition-all" style={{ background: "transparent", border: "none", cursor: "pointer" }}>
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

// ─── Notes Modal ──────────────────────────────────────────────────────────────

function NotesModal({ company, onClose }: { company: Company; onClose: () => void }) {
  const [notes, setNotes] = useState<CompanyNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [newNote, setNewNote] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api<{ success: boolean; data: CompanyNote[] }>(`/api/v1/companies/notes?company_id=${company.id}`)
      .then(r => setNotes(r.data)).catch(() => {}).finally(() => setLoading(false));
  }, [company.id]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!newNote.trim()) return;
    setSaving(true);
    try {
      await api("/api/v1/companies/notes", { method: "POST", body: { company_id: company.id, note: newNote.trim() } });
      setNewNote(""); load();
    } catch {}
    setSaving(false);
  };

  const handleDelete = async (noteId: string) => {
    try {
      await api(`/api/v1/companies/notes/${noteId}`, { method: "DELETE" });
      setNotes(n => n.filter(x => x.id !== noteId));
    } catch {}
  };

  return (
    <ModalBackdrop onClose={onClose}>
      <ModalHeader title="Internal Notes" subtitle={company.name} icon={StickyNote} iconColor="text-amber-400" iconBg="bg-amber-500/10" onClose={onClose} />
      <div className="p-5 space-y-2.5 max-h-64 overflow-y-auto">
        {loading ? <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 text-amber-500 animate-spin" /></div>
          : notes.length === 0 ? <p className="text-zinc-500 text-xs text-center py-6">No notes yet. Add one below.</p>
          : notes.map(n => (
            <div key={n.id} className="rounded-lg bg-black/[0.03] border border-black/[0.06] p-3 flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-zinc-700 leading-relaxed">{n.note}</p>
                <p className="text-[0.6rem] text-zinc-600 mt-1">{formatDate(n.created_at)}</p>
              </div>
              <button onClick={() => handleDelete(n.id)} className="text-zinc-600 hover:text-red-400 transition-colors shrink-0" style={{ background: "transparent", border: "none", cursor: "pointer" }}>
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
      </div>
      <div className="px-5 pb-5 border-t border-black/[0.06] pt-4">
        <div className="flex gap-2">
          <textarea value={newNote} onChange={e => setNewNote(e.target.value)} placeholder="Write an internal note…" rows={2} className="flex-1 rounded-lg px-3 py-2 text-xs text-zinc-900 placeholder-zinc-600 outline-none resize-none" style={inputStyle} />
          <button onClick={handleAdd} disabled={saving || !newNote.trim()} className="px-3 py-2 rounded-lg text-xs font-medium text-amber-300 disabled:opacity-40 transition-all self-end" style={{ background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.3)", cursor: "pointer" }}>
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}

// ─── Audit Modal ──────────────────────────────────────────────────────────────

function AuditModal({ company, onClose }: { company: Company; onClose: () => void }) {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    api<{ success: boolean; data: AuditLog[] }>(`/api/v1/companies/audit?company_id=${company.id}&limit=100`)
      .then(r => setLogs(r.data)).catch(() => {}).finally(() => setLoading(false));
  }, [company.id]);

  const filtered = logs.filter(l => !search ||
    l.action.toLowerCase().includes(search.toLowerCase()) ||
    l.module.toLowerCase().includes(search.toLowerCase()) ||
    l.user_name.toLowerCase().includes(search.toLowerCase())
  );

  const actionColors: Record<string, string> = {
    CREATE: "text-emerald-400", UPDATE: "text-blue-400", DELETE: "text-red-400",
    LOGIN: "text-amber-400", LOGOUT: "text-zinc-600",
  };

  return (
    <ModalBackdrop onClose={onClose} maxWidth="max-w-2xl">
      <ModalHeader title="Audit Log" subtitle={`${company.name} — last 100 actions`} icon={ClipboardList} iconColor="text-violet-400" iconBg="bg-violet-500/10" onClose={onClose} />
      <div className="px-5 py-3 border-b border-black/[0.06]">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter by action, module, user…" className="w-full rounded-lg pl-8 pr-3 py-2 text-xs text-zinc-900 placeholder-zinc-600 outline-none" style={inputStyle} />
        </div>
      </div>
      <div className="overflow-y-auto" style={{ maxHeight: "55vh" }}>
        {loading ? <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 text-amber-500 animate-spin" /></div>
          : filtered.length === 0 ? <p className="text-zinc-500 text-xs text-center py-10">No audit logs found</p>
          : <div className="divide-y divide-black/[0.04]">
            {filtered.map(log => (
              <div key={log.id} className="flex items-center gap-3 px-5 py-2.5 hover:bg-black/[0.02]">
                <span className={`text-[0.65rem] font-bold w-14 shrink-0 ${actionColors[log.action] || "text-zinc-600"}`}>{log.action}</span>
                <span className="text-[0.65rem] text-zinc-500 w-20 shrink-0">{log.module}</span>
                <span className="text-[0.65rem] text-zinc-900 flex-1 truncate">{log.user_name}</span>
                <span className="text-[0.6rem] text-zinc-600 shrink-0">{timeAgo(log.timestamp)}</span>
              </div>
            ))}
          </div>}
      </div>
    </ModalBackdrop>
  );
}

// ─── Reset Password Modal ──────────────────────────────────────────────────────

function ResetPasswordModal({ company, onClose }: { company: Company; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  const handleReset = async () => {
    if (password.length < 6) { setError("Minimum 6 characters"); return; }
    if (password !== confirm) { setError("Passwords do not match"); return; }
    setError(""); setSaving(true);
    try {
      await api("/api/v1/companies/reset-password", { method: "POST", body: { company_id: company.id, new_password: password } });
      setSuccess(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed"); }
    setSaving(false);
  };

  return (
    <ModalBackdrop onClose={onClose} maxWidth="max-w-sm">
      <ModalHeader title="Reset Password" subtitle={company.name} icon={Key} iconColor="text-orange-400" iconBg="bg-orange-500/10" onClose={onClose} />
      {success ? (
        <div className="p-6 text-center">
          <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto mb-3" />
          <p className="text-sm font-semibold text-zinc-900 mb-1">Password updated</p>
          <p className="text-xs text-zinc-500 mb-4">Portal password reset successfully.</p>
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-xs font-medium text-zinc-900" style={{ background: "rgba(245,158,11,0.2)", border: "1px solid rgba(245,158,11,0.3)", cursor: "pointer" }}>Done</button>
        </div>
      ) : (
        <div className="p-5 space-y-3">
          <div>
            <label className="block text-xs text-zinc-600 mb-1">New Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Min 6 characters" className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder-zinc-600 outline-none" style={inputStyle} />
          </div>
          <div>
            <label className="block text-xs text-zinc-600 mb-1">Confirm Password</label>
            <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Repeat password" className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder-zinc-600 outline-none" style={inputStyle} />
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-2 pt-2">
            <button onClick={onClose} className="flex-1 py-2 rounded-lg text-xs text-zinc-600" style={{ background: "transparent", border: "1px solid rgba(17, 17, 24,0.08)", cursor: "pointer" }}>Cancel</button>
            <button onClick={handleReset} disabled={saving} className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium text-orange-300" style={{ background: "rgba(249,115,22,0.15)", border: "1px solid rgba(249,115,22,0.3)", cursor: "pointer" }}>
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Key className="w-3.5 h-3.5" />}
              {saving ? "Saving…" : "Reset Password"}
            </button>
          </div>
        </div>
      )}
    </ModalBackdrop>
  );
}

// ─── Edit Company Modal ────────────────────────────────────────────────────────

function EditCompanyModal({ company, onClose, onSaved }: { company: Company; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: company.name || "", contact_phone: company.contact_phone || "", contact_email: company.contact_email || "", city: company.city || "", gstin: company.gstin || "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    if (!form.name.trim()) { setError("Name is required"); return; }
    setError(""); setSaving(true);
    try {
      await api(`/api/v1/companies/${company.id}`, { method: "PUT", body: form });
      onSaved(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to save"); }
    setSaving(false);
  };

  return (
    <ModalBackdrop onClose={onClose}>
      <ModalHeader title="Edit Company" subtitle={company.party_code} icon={Edit2} iconColor="text-blue-400" iconBg="bg-blue-500/10" onClose={onClose} />
      <div className="p-5 space-y-3">
        {[
          { label: "Company Name", key: "name", placeholder: "Full company name" },
          { label: "City", key: "city", placeholder: "City" },
          { label: "Phone", key: "contact_phone", placeholder: "10-digit number" },
          { label: "Email", key: "contact_email", placeholder: "company@example.com" },
          { label: "GSTIN", key: "gstin", placeholder: "22AAAAA0000A1Z5" },
        ].map(field => (
          <div key={field.key}>
            <label className="block text-xs text-zinc-600 mb-1">{field.label}</label>
            <input value={form[field.key as keyof typeof form]} onChange={e => setForm(f => ({ ...f, [field.key]: e.target.value }))} placeholder={field.placeholder} className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder-zinc-600 outline-none" style={inputStyle} />
          </div>
        ))}
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
      <div className="flex gap-2 px-5 pb-5">
        <button onClick={onClose} className="flex-1 py-2 rounded-lg text-xs text-zinc-600" style={{ background: "transparent", border: "1px solid rgba(17, 17, 24,0.08)", cursor: "pointer" }}>Cancel</button>
        <button onClick={handleSave} disabled={saving} className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium text-blue-300" style={{ background: "rgba(59,130,246,0.15)", border: "1px solid rgba(59,130,246,0.3)", cursor: "pointer" }}>
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Edit2 className="w-3.5 h-3.5" />}
          {saving ? "Saving…" : "Save Changes"}
        </button>
      </div>
    </ModalBackdrop>
  );
}

// ─── Subscription Modal ───────────────────────────────────────────────────────

function SubscriptionModal({ company, existing, onClose, onSaved }: { company: Company; existing: Subscription | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    plan_name: existing?.plan_name || "",
    plan_tier: existing?.plan_tier || "BASIC",
    started_at: existing?.started_at || new Date().toISOString().split("T")[0],
    expires_at: existing?.expires_at || "",
    amount_monthly: existing?.amount_monthly?.toString() || "0",
    status: existing?.status || "ACTIVE",
    notes: existing?.notes || "",
  });
  const [templates, setTemplates] = useState<PlanTemplate[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ success: boolean; data: PlanTemplate[] }>("/api/v1/companies/plan-templates")
      .then(r => setTemplates(r.data)).catch(() => {});
  }, []);

  const applyTemplate = (tpl: PlanTemplate) => {
    const startDate = new Date().toISOString().split("T")[0];
    const expiry = new Date(Date.now() + tpl.duration_days * 86400000).toISOString().split("T")[0];
    setForm(f => ({
      ...f,
      plan_name: tpl.name,
      plan_tier: tpl.plan_tier,
      amount_monthly: tpl.amount_monthly.toString(),
      started_at: startDate,
      expires_at: expiry,
    }));
  };

  const handleSave = async () => {
    setError(""); setSaving(true);
    try {
      const res = await fetch("/api/v1/companies/subscriptions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("accessToken")}`,
        },
        body: JSON.stringify({ company_id: company.id, ...form, amount_monthly: parseFloat(form.amount_monthly) || 0, expires_at: form.expires_at || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || data.message || "Failed to save subscription");
        setSaving(false);
        return;
      }
      onSaved(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to save"); }
    setSaving(false);
  };

  return (
    <ModalBackdrop onClose={onClose} maxWidth="max-w-lg">
      <ModalHeader title={existing ? "Edit Subscription" : "Assign Subscription"} subtitle={company.name} icon={Crown} iconColor="text-amber-400" iconBg="bg-amber-500/10" onClose={onClose} />
      <div className="p-5 space-y-4">
        {/* Template Picker */}
        {templates.length > 0 && (
          <div>
            <label className="block text-xs font-semibold text-zinc-600 mb-2 flex items-center gap-1.5">
              <Sparkles className="w-3 h-3 text-amber-400" /> Use a Plan Template <span className="text-zinc-600 font-normal">(auto-fills all fields)</span>
            </label>
            <div className="grid grid-cols-2 gap-2">
              {templates.map(tpl => {
                const tierCfg = PLAN_TIERS.find(t => t.value === tpl.plan_tier) || PLAN_TIERS[0];
                const TierIcon = tierCfg.icon;
                const isSelected = form.plan_name === tpl.name && form.amount_monthly === tpl.amount_monthly.toString();
                return (
                  <button
                    key={tpl.id}
                    onClick={() => applyTemplate(tpl)}
                    className="flex flex-col gap-1 p-3 rounded-xl text-left transition-all"
                    style={{
                      background: isSelected ? "rgba(245,158,11,0.12)" : "rgba(17, 17, 24,0.03)",
                      border: isSelected ? "1px solid rgba(245,158,11,0.4)" : "1px solid rgba(17, 17, 24,0.07)",
                      cursor: "pointer",
                    }}
                  >
                    <div className="flex items-center gap-1.5">
                      <TierIcon className={`w-3.5 h-3.5 ${isSelected ? "text-amber-400" : tierCfg.color}`} />
                      <span className={`text-xs font-semibold ${isSelected ? "text-amber-300" : "text-zinc-900"}`}>{tpl.name}</span>
                    </div>
                    <div className={`text-[0.65rem] font-bold ${isSelected ? "text-amber-400" : "text-zinc-600"}`}>₹{formatINR(tpl.amount_monthly)}/mo</div>
                    {tpl.description && <div className="text-[0.6rem] text-zinc-600 leading-tight">{tpl.description}</div>}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 border-t border-black/[0.06]" />
          </div>
        )}

        {/* Plan Tier Picker */}
        <div>
          <label className="block text-xs text-zinc-600 mb-2">Plan Tier</label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {PLAN_TIERS.map(tier => {
              const Icon = tier.icon;
              const selected = form.plan_tier === tier.value;
              return (
                <button key={tier.value} onClick={() => setForm(f => ({ ...f, plan_tier: tier.value }))}
                  className="flex flex-col items-center gap-1.5 p-2.5 rounded-lg text-center transition-all"
                  style={{ background: selected ? "rgba(245,158,11,0.12)" : "rgba(17, 17, 24,0.03)", border: selected ? "1px solid rgba(245,158,11,0.4)" : "1px solid rgba(17, 17, 24,0.07)", cursor: "pointer" }}>
                  <Icon className={`w-4 h-4 ${selected ? "text-amber-400" : tier.color}`} />
                  <span className={`text-[0.65rem] font-medium ${selected ? "text-amber-300" : "text-zinc-600"}`}>{tier.label}</span>
                </button>
              );
            })}
          </div>
        </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
            <label className="block text-xs text-zinc-600 mb-1">Started On</label>
            <input type="date" value={form.started_at} onChange={e => setForm(f => ({ ...f, started_at: e.target.value }))} className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 outline-none" style={{ ...inputStyle,  }} />
          </div>
          <div>
            <label className="block text-xs text-zinc-600 mb-1">Expires On</label>
            <input type="date" value={form.expires_at} onChange={e => setForm(f => ({ ...f, expires_at: e.target.value }))} className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 outline-none" style={{ ...inputStyle,  }} />
          </div>
        </div>
        <div>
          <label className="block text-xs text-zinc-600 mb-1">Status</label>
          <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 outline-none" style={inputStyle}>
            <option value="ACTIVE">Active</option>
            <option value="TRIAL">Trial</option>
            <option value="EXPIRED">Expired</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-zinc-600 mb-1">Internal Notes</label>
          <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional remarks…" rows={2} className="w-full rounded-lg px-3 py-2 text-xs text-zinc-900 placeholder-zinc-600 outline-none resize-none" style={inputStyle} />
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
      <div className="flex gap-2 px-5 pb-5">
        <button onClick={onClose} className="flex-1 py-2 rounded-lg text-xs text-zinc-600" style={{ background: "transparent", border: "1px solid rgba(17, 17, 24,0.08)", cursor: "pointer" }}>Cancel</button>
        <button onClick={handleSave} disabled={saving} className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium text-amber-300" style={{ background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.3)", cursor: "pointer" }}>
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Crown className="w-3.5 h-3.5" />}
          {saving ? "Saving…" : "Save Subscription"}
        </button>
      </div>
    </ModalBackdrop>
  );
}

// ─── Company Card ─────────────────────────────────────────────────────────────

function CompanyCard({ company, sub, onSelect, onSuspendToggle, onEdit, onNotes, onAudit, onResetPassword, onDelete, onSubscription }: {
  company: Company; sub?: Subscription;
  onSelect: () => void; onSuspendToggle: () => void; onEdit: () => void;
  onNotes: () => void; onAudit: () => void; onResetPassword: () => void; onDelete: () => void; onSubscription: () => void;
}) {
  const health = getHealthScore(company);
  const isSuspended = company.status === "SUSPENDED";
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const daysSinceInvoice = company.lastInvoiceDate
    ? Math.floor((Date.now() - new Date(company.lastInvoiceDate).getTime()) / 86400000) : 999;
  const isDead = daysSinceInvoice > 30 && !isSuspended;

  const subDaysLeft = sub?.expires_at ? daysUntil(sub.expires_at) : null;
  const subExpiring = subDaysLeft !== null && subDaysLeft <= 30 && subDaysLeft >= 0;
  const subExpired = subDaysLeft !== null && subDaysLeft < 0;

  // Plan tier config
  const tierCfg = PLAN_TIERS.find(t => t.value === sub?.plan_tier) || PLAN_TIERS[0];
  const TierIcon = tierCfg.icon;

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div className={`rounded-xl border p-4 transition-all group relative flex flex-col gap-3 ${isSuspended ? "opacity-75" : ""}`}
      style={{
        background: isSuspended ? "rgba(239,68,68,0.03)" : isDead ? "rgba(245,158,11,0.02)" : "rgba(17, 17, 24,0.02)",
        border: isSuspended ? "1px solid rgba(239,68,68,0.15)" : isDead ? "1px solid rgba(245,158,11,0.12)" : "1px solid rgba(17, 17, 24,0.06)",
        fontFamily: "inherit",
      }}>

      {/* Top row */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer" onClick={isSuspended ? undefined : onSelect}>
          <div className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${isSuspended ? "bg-red-500/10 border-red-500/20" : "bg-gradient-to-br from-amber-500/20 to-amber-600/10 border-amber-500/20"}`}>
            {isSuspended ? <Lock className="w-4 h-4 text-red-400" /> : <span className="text-amber-400 font-black text-sm">{company.name.slice(0, 2).toUpperCase()}</span>}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-zinc-900 leading-tight truncate">{company.name}</div>
            <div className="text-[0.65rem] text-zinc-500 mt-0.5 flex items-center gap-1.5">
              <span>{company.party_code}</span>
              {company.city && <><span className="text-zinc-700">·</span><span>{company.city}</span></>}
            </div>
          </div>
        </div>
        <div className="relative shrink-0" ref={menuRef}>
          <button onClick={e => { e.stopPropagation(); setMenuOpen(v => !v); }} className="w-7 h-7 rounded-lg flex items-center justify-center text-zinc-600 hover:text-zinc-900 hover:bg-black/[0.06] transition-all" style={{ background: "transparent", border: "none", cursor: "pointer" }}>
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-8 z-30 w-48 rounded-xl overflow-hidden py-1" style={{ background: "#ffffff", border: "1px solid rgba(17, 17, 24,0.1)", boxShadow: "0 20px 50px rgba(0,0,0,0.6)" }}>
              {!isSuspended && <button onClick={() => { onSelect(); setMenuOpen(false); }} className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-zinc-700 hover:bg-black/[0.06] hover:text-zinc-900" style={{ background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}><Eye className="w-3.5 h-3.5 text-amber-400" /> Enter Dashboard</button>}
              <button onClick={() => { onEdit(); setMenuOpen(false); }} className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-zinc-700 hover:bg-black/[0.06] hover:text-zinc-900" style={{ background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}><Edit2 className="w-3.5 h-3.5 text-blue-400" /> Edit Details</button>
              <button onClick={() => { onSuspendToggle(); setMenuOpen(false); }} className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-zinc-700 hover:bg-black/[0.06] hover:text-zinc-900" style={{ background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}>
                {isSuspended ? <><PlayCircle className="w-3.5 h-3.5 text-emerald-400" />Activate</> : <><PauseCircle className="w-3.5 h-3.5 text-amber-400" />Suspend</>}
              </button>
              <button onClick={() => { onSubscription(); setMenuOpen(false); }} className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-zinc-700 hover:bg-black/[0.06] hover:text-zinc-900" style={{ background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}><Crown className="w-3.5 h-3.5 text-amber-400" /> Subscription</button>
              <button onClick={() => { onNotes(); setMenuOpen(false); }} className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-zinc-700 hover:bg-black/[0.06] hover:text-zinc-900" style={{ background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}><StickyNote className="w-3.5 h-3.5 text-yellow-400" /> Notes</button>
              <button onClick={() => { onAudit(); setMenuOpen(false); }} className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-zinc-700 hover:bg-black/[0.06] hover:text-zinc-900" style={{ background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}><ClipboardList className="w-3.5 h-3.5 text-violet-400" /> Audit Log</button>
              <div className="border-t border-black/[0.06] my-1" />
              <button onClick={() => { onDelete(); setMenuOpen(false); }} className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-red-400 hover:bg-red-500/10" style={{ background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}><Trash2 className="w-3.5 h-3.5" /> Delete</button>
            </div>
          )}
        </div>
      </div>

      {/* Badges row */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={`text-[0.6rem] px-1.5 py-0.5 rounded font-semibold ${isSuspended ? "bg-red-500/10 text-red-400" : "bg-emerald-500/10 text-emerald-400"}`}>{company.status}</span>
        <span className={`flex items-center gap-1 text-[0.6rem] px-1.5 py-0.5 rounded font-semibold ${health.bg} ${health.color}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${health.dot}`} />{health.label}
        </span>
        {isDead && <span className="text-[0.6rem] px-1.5 py-0.5 rounded font-semibold bg-zinc-50 text-zinc-500 flex items-center gap-1"><Clock className="w-2.5 h-2.5" />Inactive</span>}
        {sub && (
          <span className={`flex items-center gap-1 text-[0.6rem] px-1.5 py-0.5 rounded font-semibold ${subExpired ? "bg-red-500/10 text-red-400" : subExpiring ? "bg-amber-500/10 text-amber-400" : `${tierCfg.bg} ${tierCfg.color}`}`}>
            <TierIcon className="w-2.5 h-2.5" />
            {sub.plan_name}
            {subExpired && " (expired)"}
            {subExpiring && ` (${subDaysLeft}d)`}
          </span>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-black/[0.03] p-2.5">
          <div className="text-[0.6rem] text-zinc-500 mb-0.5">Outstanding</div>
          <div className={`text-sm font-bold ${company.outstanding > 0 ? "text-red-400" : "text-emerald-400"}`}>₹{formatINR(company.outstanding)}</div>
          {(company.overdue || 0) > 0 && <div className="text-[0.55rem] text-red-500 mt-0.5">{formatINR(company.overdue || 0)} overdue</div>}
        </div>
        <div className="rounded-lg bg-black/[0.03] p-2.5">
          <div className="text-[0.6rem] text-zinc-500 mb-0.5">Users</div>
          <div className="text-sm font-bold text-zinc-900">{company.totalUsers}</div>
          {company.activeUsers !== undefined && company.activeUsers !== company.totalUsers && <div className="text-[0.55rem] text-zinc-500 mt-0.5">{company.activeUsers} active</div>}
        </div>
      </div>

      {/* Activity row */}
      <div className="flex items-center justify-between text-[0.6rem] text-zinc-600 border-t border-black/[0.04] pt-2.5">
        <span className="flex items-center gap-1"><Activity className="w-2.5 h-2.5" />Login: {timeAgo(company.lastLogin)}</span>
        <span className="flex items-center gap-1"><FileText className="w-2.5 h-2.5" />Invoice: {timeAgo(company.lastInvoiceDate)}</span>
        {!isSuspended && <ChevronRight className="w-3 h-3 text-zinc-700 group-hover:text-amber-400 transition-colors cursor-pointer" onClick={onSelect} />}
      </div>
    </div>
  );
}

// ─── Health Monitor Panel ─────────────────────────────────────────────────────

function HealthMonitorPanel({ companies }: { companies: Company[] }) {
  const sorted = [...companies].sort((a, b) => getHealthScore(a).score - getHealthScore(b).score);
  return (
    <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] overflow-hidden">
      <div className="px-5 py-3.5 border-b border-black/[0.06] flex items-center gap-2">
        <HeartPulse className="w-4 h-4 text-red-400" />
        <h3 className="text-sm font-semibold text-zinc-900">Company Health Monitor</h3>
        <span className="text-[0.65rem] text-zinc-500 ml-auto">{sorted.length} companies ranked by risk</span>
      </div>
      <div className="divide-y divide-black/[0.04]">
        {sorted.map((company, idx) => {
          const health = getHealthScore(company);
          const isSuspended = company.status === "SUSPENDED";
          const daysSinceLogin = company.lastLogin ? Math.floor((Date.now() - new Date(company.lastLogin).getTime()) / 86400000) : 999;
          const daysSinceInvoice = company.lastInvoiceDate ? Math.floor((Date.now() - new Date(company.lastInvoiceDate).getTime()) / 86400000) : 999;
          const overdueRatio = company.outstanding > 0 ? Math.round(((company.overdue || 0) / company.outstanding) * 100) : 0;
          return (
            <div key={company.id} className="flex items-center gap-4 px-5 py-3 hover:bg-black/[0.02] transition-colors">
              <span className="text-[0.6rem] text-zinc-600 w-5 shrink-0">{idx + 1}</span>
              <div className={`w-2 h-8 rounded-full shrink-0 ${health.dot}`} style={{ opacity: 0.8 }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-semibold text-zinc-900 truncate">{company.name}</span>
                  {isSuspended && <span className="text-[0.55rem] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 font-semibold shrink-0">SUSPENDED</span>}
                </div>
                {/* Health bar */}
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 rounded-full bg-black/[0.06] overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${health.dot}`} style={{ width: `${health.score}%` }} />
                  </div>
                  <span className={`text-[0.6rem] font-bold w-8 text-right ${health.color}`}>{health.score}</span>
                </div>
              </div>
              <div className="hidden sm:flex items-center gap-3 shrink-0">
                <div className="text-center">
                  <div className="text-[0.6rem] text-zinc-600">Login</div>
                  <div className={`text-[0.65rem] font-medium ${daysSinceLogin > 45 ? "text-red-400" : daysSinceLogin > 14 ? "text-amber-400" : "text-emerald-400"}`}>{timeAgo(company.lastLogin)}</div>
                </div>
                <div className="text-center">
                  <div className="text-[0.6rem] text-zinc-600">Invoice</div>
                  <div className={`text-[0.65rem] font-medium ${daysSinceInvoice > 60 ? "text-red-400" : daysSinceInvoice > 30 ? "text-amber-400" : "text-emerald-400"}`}>{timeAgo(company.lastInvoiceDate)}</div>
                </div>
                <div className="text-center">
                  <div className="text-[0.6rem] text-zinc-600">Overdue %</div>
                  <div className={`text-[0.65rem] font-medium ${overdueRatio > 50 ? "text-red-400" : overdueRatio > 20 ? "text-amber-400" : "text-zinc-600"}`}>{overdueRatio}%</div>
                </div>
              </div>
              <span className={`text-[0.65rem] font-semibold px-2 py-1 rounded-lg shrink-0 ${health.bg} ${health.color}`}>{health.label}</span>
            </div>
          );
        })}
        {companies.length === 0 && <div className="text-zinc-500 text-xs text-center py-10">No companies to display</div>}
      </div>
    </div>
  );
}

// ─── Outstanding Leaderboard ──────────────────────────────────────────────────

function OutstandingLeaderboard({ companies }: { companies: Company[] }) {
  const sorted = [...companies].filter(c => c.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding);
  const maxOutstanding = sorted[0]?.outstanding || 1;
  const totalOutstanding = companies.reduce((s, c) => s + c.outstanding, 0);
  const totalOverdue = companies.reduce((s, c) => s + (c.overdue || 0), 0);

  return (
    <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] overflow-hidden">
      <div className="px-5 py-3.5 border-b border-black/[0.06]">
        <div className="flex items-center gap-2 mb-1">
          <TrendingDown className="w-4 h-4 text-red-400" />
          <h3 className="text-sm font-semibold text-zinc-900">Outstanding Leaderboard</h3>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-[0.65rem] text-zinc-500">Total: <span className="text-red-400 font-semibold">₹{formatINR(totalOutstanding)}</span></span>
          {totalOverdue > 0 && <span className="text-[0.65rem] text-zinc-500">Overdue 60d+: <span className="text-red-500 font-semibold">₹{formatINR(totalOverdue)}</span></span>}
          <span className="text-[0.65rem] text-zinc-500">{sorted.length} companies with dues</span>
        </div>
      </div>
      <div className="divide-y divide-black/[0.04]">
        {sorted.length === 0 ? (
          <div className="text-center py-10">
            <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
            <p className="text-xs text-zinc-500">All companies have zero outstanding</p>
          </div>
        ) : sorted.map((company, idx) => {
          const pct = (company.outstanding / maxOutstanding) * 100;
          const overduePct = company.outstanding > 0 ? ((company.overdue || 0) / company.outstanding) * 100 : 0;
          return (
            <div key={company.id} className="px-5 py-3 hover:bg-black/[0.02] transition-colors">
              <div className="flex items-center gap-3 mb-2">
                <span className={`text-xs font-black w-5 ${idx === 0 ? "text-amber-400" : idx === 1 ? "text-zinc-600" : idx === 2 ? "text-orange-700" : "text-zinc-600"}`}>#{idx + 1}</span>
                <span className="text-xs font-semibold text-zinc-900 flex-1 truncate">{company.name}</span>
                <span className="text-sm font-bold text-red-400 tabular-nums">₹{formatINR(company.outstanding)}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 rounded-full bg-black/[0.06] overflow-hidden relative">
                  <div className="h-full rounded-full bg-red-500/60 transition-all" style={{ width: `${pct}%` }} />
                  {overduePct > 0 && (
                    <div className="absolute top-0 right-0 h-full rounded-full bg-red-600 transition-all" style={{ width: `${overduePct * pct / 100}%` }} />
                  )}
                </div>
                {(company.overdue || 0) > 0 && (
                  <span className="text-[0.6rem] text-red-500 shrink-0 tabular-nums">₹{formatINR(company.overdue || 0)} overdue</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Plan Templates Manager Modal ────────────────────────────────────────────

function PlanTemplatesModal({ onClose }: { onClose: () => void }) {
  const [templates, setTemplates] = useState<PlanTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<PlanTemplate | null>(null);
  const [showForm, setShowForm] = useState(false);
  const emptyTpl = { id: "", name: "", plan_tier: "BASIC", amount_monthly: 0, duration_days: 365, description: "", features: [] as string[], is_active: true };
  const [form, setForm] = useState(emptyTpl);
  const [featInput, setFeatInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    api<{ success: boolean; data: PlanTemplate[] }>("/api/v1/companies/plan-templates")
      .then(r => setTemplates(r.data)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const openNew = () => {
    setEditing(null);
    setForm(emptyTpl);
    setFeatInput("");
    setFormError("");
    setShowForm(true);
  };

  const openEdit = (tpl: PlanTemplate) => {
    setEditing(tpl);
    setForm({ id: tpl.id, name: tpl.name, plan_tier: tpl.plan_tier, amount_monthly: tpl.amount_monthly, duration_days: tpl.duration_days, description: tpl.description || "", features: [...(tpl.features || [])], is_active: tpl.is_active });
    setFeatInput("");
    setFormError("");
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) { setFormError("Plan name is required"); return; }
    setFormError(""); setSaving(true);
    try {
      await api("/api/v1/companies/plan-templates", {
        method: "POST",
        body: { id: editing?.id || undefined, name: form.name.trim(), plan_tier: form.plan_tier, amount_monthly: Number(form.amount_monthly) || 0, duration_days: Number(form.duration_days) || 365, description: form.description || null, features: form.features },
      });
      setShowForm(false); load();
    } catch (e) { setFormError(e instanceof Error ? e.message : "Failed to save"); }
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    try {
      await api(`/api/v1/companies/plan-templates?id=${id}`, { method: "DELETE" });
      load();
    } catch {}
  };

  const addFeature = () => {
    const f = featInput.trim();
    if (!f) return;
    setForm(prev => ({ ...prev, features: [...prev.features, f] }));
    setFeatInput("");
  };

  const removeFeature = (i: number) => setForm(prev => ({ ...prev, features: prev.features.filter((_, idx) => idx !== i) }));

  return (
    <ModalBackdrop onClose={onClose} maxWidth="max-w-2xl">
      <ModalHeader title="Manage Plan Templates" subtitle="Create reusable plans to apply to any company" icon={Sparkles} iconColor="text-amber-400" iconBg="bg-amber-500/10" onClose={onClose} />

      {!showForm ? (
        <>
          <div className="px-5 py-3 border-b border-black/[0.06] flex items-center justify-between">
            <span className="text-xs text-zinc-500">{templates.length} active templates</span>
            <button onClick={openNew} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-amber-300 transition-all" style={{ background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.3)", cursor: "pointer" }}>
              <Plus className="w-3 h-3" />New Template
            </button>
          </div>
          <div className="overflow-y-auto" style={{ maxHeight: "60vh" }}>
            {loading ? (
              <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 text-amber-500 animate-spin" /></div>
            ) : templates.length === 0 ? (
              <div className="text-center py-12">
                <Sparkles className="w-8 h-8 text-amber-400/30 mx-auto mb-3" />
                <p className="text-zinc-500 text-sm font-medium mb-1">No templates yet</p>
                <p className="text-zinc-600 text-xs mb-4">Create reusable subscription plans to assign to companies</p>
                <button onClick={openNew} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium text-amber-300" style={{ background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.3)", cursor: "pointer" }}>
                  <Plus className="w-3.5 h-3.5" />Create First Template
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4">
                {templates.map(tpl => {
                  const tierCfg = PLAN_TIERS.find(t => t.value === tpl.plan_tier) || PLAN_TIERS[0];
                  const TierIcon = tierCfg.icon;
                  return (
                    <div key={tpl.id} className="rounded-xl p-4 flex flex-col gap-2.5" style={{ background: "rgba(17, 17, 24,0.03)", border: "1px solid rgba(17, 17, 24,0.07)" }}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className={`w-8 h-8 rounded-lg ${tierCfg.bg} flex items-center justify-center shrink-0`}><TierIcon className={`w-4 h-4 ${tierCfg.color}`} /></div>
                          <div className="min-w-0">
                            <div className="text-sm font-bold text-zinc-900 truncate">{tpl.name}</div>
                            <div className={`text-[0.6rem] font-semibold ${tierCfg.color}`}>{tierCfg.label}</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button onClick={() => openEdit(tpl)} className="w-6 h-6 rounded flex items-center justify-center text-zinc-500 hover:text-blue-400 transition-colors" style={{ background: "transparent", border: "none", cursor: "pointer" }}><Edit2 className="w-3.5 h-3.5" /></button>
                          <button onClick={() => handleDelete(tpl.id)} className="w-6 h-6 rounded flex items-center justify-center text-zinc-500 hover:text-red-400 transition-colors" style={{ background: "transparent", border: "none", cursor: "pointer" }}><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div>
                          <div className="text-[0.6rem] text-zinc-600">Monthly</div>
                          <div className="text-sm font-black text-amber-400">₹{formatINR(tpl.amount_monthly)}</div>
                        </div>
                        <div>
                          <div className="text-[0.6rem] text-zinc-600">Duration</div>
                          <div className="text-xs font-semibold text-zinc-700">{tpl.duration_days}d</div>
                        </div>
                        {tpl.description && (
                          <div className="flex-1 min-w-0">
                            <div className="text-[0.6rem] text-zinc-600 truncate">{tpl.description}</div>
                          </div>
                        )}
                      </div>
                      {tpl.features && tpl.features.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {tpl.features.slice(0, 3).map((f, i) => (
                            <span key={i} className="text-[0.55rem] px-1.5 py-0.5 rounded bg-black/[0.05] text-zinc-600 border border-black/[0.06]">{f}</span>
                          ))}
                          {tpl.features.length > 3 && <span className="text-[0.55rem] px-1.5 py-0.5 rounded bg-black/[0.05] text-zinc-600">+{tpl.features.length - 3} more</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="px-5 py-3 border-b border-black/[0.06] flex items-center gap-2">
            <button onClick={() => setShowForm(false)} className="w-6 h-6 rounded flex items-center justify-center text-zinc-500 hover:text-zinc-900 transition-colors" style={{ background: "transparent", border: "none", cursor: "pointer" }}><ArrowLeft className="w-3.5 h-3.5" /></button>
            <span className="text-xs font-semibold text-zinc-900">{editing ? "Edit Template" : "New Template"}</span>
          </div>
          <div className="p-5 space-y-4 overflow-y-auto" style={{ maxHeight: "65vh" }}>
            {/* Tier picker */}
            <div>
              <label className="block text-xs text-zinc-600 mb-2">Tier</label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {PLAN_TIERS.map(tier => {
                  const Icon = tier.icon;
                  const sel = form.plan_tier === tier.value;
                  return (
                    <button key={tier.value} onClick={() => setForm(f => ({ ...f, plan_tier: tier.value }))}
                      className="flex flex-col items-center gap-1.5 p-2.5 rounded-lg text-center transition-all"
                      style={{ background: sel ? "rgba(245,158,11,0.12)" : "rgba(17, 17, 24,0.03)", border: sel ? "1px solid rgba(245,158,11,0.4)" : "1px solid rgba(17, 17, 24,0.07)", cursor: "pointer" }}>
                      <Icon className={`w-4 h-4 ${sel ? "text-amber-400" : tier.color}`} />
                      <span className={`text-[0.65rem] font-medium ${sel ? "text-amber-300" : "text-zinc-600"}`}>{tier.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="block text-xs text-zinc-600 mb-1">Plan Name <span className="text-red-400">*</span></label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Starter, Growth, Pro Annual" className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder-zinc-600 outline-none" style={inputStyle} />
              </div>
              <div>
                <label className="block text-xs text-zinc-600 mb-1">Monthly Amount (₹)</label>
                <input type="number" value={form.amount_monthly} onChange={e => setForm(f => ({ ...f, amount_monthly: Number(e.target.value) }))} placeholder="0" className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder-zinc-600 outline-none" style={inputStyle} />
              </div>
              <div>
                <label className="block text-xs text-zinc-600 mb-1">Duration (days)</label>
                <input type="number" value={form.duration_days} onChange={e => setForm(f => ({ ...f, duration_days: Number(e.target.value) }))} placeholder="365" className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder-zinc-600 outline-none" style={inputStyle} />
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-zinc-600 mb-1">Description</label>
                <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Short description of this plan" className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder-zinc-600 outline-none" style={inputStyle} />
              </div>
            </div>
            <div>
              <label className="block text-xs text-zinc-600 mb-2">Features <span className="text-zinc-600">(shown as tags)</span></label>
              <div className="flex gap-2 mb-2">
                <input value={featInput} onChange={e => setFeatInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addFeature(); } }} placeholder="e.g. Up to 20 users" className="flex-1 rounded-lg px-3 py-2 text-xs text-zinc-900 placeholder-zinc-600 outline-none" style={inputStyle} />
                <button onClick={addFeature} className="px-3 py-2 rounded-lg text-xs font-medium text-amber-300" style={{ background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.3)", cursor: "pointer" }}>Add</button>
              </div>
              {form.features.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {form.features.map((f, i) => (
                    <span key={i} className="flex items-center gap-1 text-[0.65rem] px-2 py-1 rounded-lg bg-black/[0.05] text-zinc-700 border border-black/[0.08]">
                      {f}
                      <button onClick={() => removeFeature(i)} className="text-zinc-600 hover:text-red-400 transition-colors" style={{ background: "transparent", border: "none", cursor: "pointer" }}><X className="w-3 h-3" /></button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            {formError && <p className="text-xs text-red-400">{formError}</p>}
          </div>
          <div className="flex gap-2 px-5 pb-5">
            <button onClick={() => setShowForm(false)} className="flex-1 py-2 rounded-lg text-xs text-zinc-600" style={{ background: "transparent", border: "1px solid rgba(17, 17, 24,0.08)", cursor: "pointer" }}>Back</button>
            <button onClick={handleSave} disabled={saving} className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium text-amber-300" style={{ background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.3)", cursor: "pointer" }}>
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {saving ? "Saving…" : editing ? "Update Template" : "Create Template"}
            </button>
          </div>
        </>
      )}
    </ModalBackdrop>
  );
}

// ─── Subscription Tracker + New Plan Picker Modal ────────────────────────────

function NewPlanPickerModal({ companies, subs, onClose, onPick }: {
  companies: Company[];
  subs: Subscription[];
  onClose: () => void;
  onPick: (company: Company) => void;
}) {
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const subSet = new Set(subs.map(s => s.company_id));

  const withoutPlan = companies.filter(c => !subSet.has(c.id));
  const withPlan = companies.filter(c => subSet.has(c.id));

  const filterFn = (c: Company) =>
    !search ||
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.party_code.toLowerCase().includes(search.toLowerCase());

  const noPlanFiltered = withoutPlan.filter(filterFn);
  const withPlanFiltered = withPlan.filter(filterFn);

  return (
    <ModalBackdrop onClose={onClose} maxWidth="max-w-sm">
      <ModalHeader title="Select Company" subtitle="Choose a company to assign a subscription plan" icon={Crown} iconColor="text-amber-400" iconBg="bg-amber-500/10" onClose={onClose} />
      <div className="px-4 py-3 border-b border-black/[0.06]">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
          <input
            autoFocus
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search companies…"
            className="w-full rounded-lg pl-8 pr-3 py-2 text-xs text-zinc-900 placeholder-zinc-600 outline-none"
            style={inputStyle}
          />
        </div>
      </div>
      <div className="overflow-y-auto" style={{ maxHeight: "55vh" }}>
        {noPlanFiltered.length > 0 && (
          <>
            <div className="px-4 pt-3 pb-1">
              <span className="text-[0.6rem] font-bold text-zinc-500 uppercase tracking-wider">No Plan Yet ({noPlanFiltered.length})</span>
            </div>
            {noPlanFiltered.map(c => (
              <button
                key={c.id}
                onClick={() => onPick(c)}
                className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-black/[0.05] transition-colors text-left"
                style={{ background: "transparent", border: "none", cursor: "pointer" }}
              >
                <div className="w-7 h-7 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0">
                  <span className="text-amber-400 font-black text-[0.6rem]">{c.name.slice(0, 2).toUpperCase()}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-zinc-900 truncate">{c.name}</div>
                  <div className="text-[0.6rem] text-zinc-500">{c.party_code}{c.city ? ` · ${c.city}` : ""}</div>
                </div>
                <Plus className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              </button>
            ))}
          </>
        )}
        {noPlanFiltered.length === 0 && !search && (
          <div className="px-4 py-3">
            <p className="text-[0.65rem] text-zinc-500 text-center">All companies already have plans</p>
          </div>
        )}
        {withPlanFiltered.length > 0 && (
          <>
            <div className="px-4 pt-3 pb-1 flex items-center gap-2">
              <span className="text-[0.6rem] font-bold text-zinc-500 uppercase tracking-wider">Has Plan ({withPlanFiltered.length})</span>
              {!showAll && !search && (
                <button onClick={() => setShowAll(true)} className="text-[0.6rem] text-amber-400 underline" style={{ background: "transparent", border: "none", cursor: "pointer" }}>Show all</button>
              )}
            </div>
            {(showAll || !!search) && withPlanFiltered.map(c => {
              const sub = subs.find(s => s.company_id === c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => onPick(c)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-black/[0.05] transition-colors text-left"
                  style={{ background: "transparent", border: "none", cursor: "pointer" }}
                >
                  <div className="w-7 h-7 rounded-lg bg-zinc-500/10 border border-zinc-500/20 flex items-center justify-center shrink-0">
                    <span className="text-zinc-600 font-black text-[0.6rem]">{c.name.slice(0, 2).toUpperCase()}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-zinc-900 truncate">{c.name}</div>
                    <div className="text-[0.6rem] text-zinc-500">{sub?.plan_name || "—"}</div>
                  </div>
                  <Edit2 className="w-3 h-3 text-zinc-500 shrink-0" />
                </button>
              );
            })}
          </>
        )}
        {noPlanFiltered.length === 0 && withPlanFiltered.length === 0 && search && (
          <p className="text-xs text-zinc-500 text-center py-8">No companies match</p>
        )}
      </div>
    </ModalBackdrop>
  );
}

function CollectPaymentModal({ company, sub, onClose, onSaved }: { company: Company; sub: Subscription; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState(String(sub.amount_monthly || ""));
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split("T")[0]);
  const [method, setMethod] = useState("CASH");
  const [referenceNo, setReferenceNo] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const METHODS = ["CASH", "UPI", "BANK_TRANSFER", "CHEQUE", "CARD", "OTHER"];

  const handleSave = async () => {
    if (!amount || Number(amount) <= 0) { setError("Enter a valid amount"); return; }
    setSaving(true); setError("");
    try {
      await api("/api/v1/companies/subscription-payments", {
        method: "POST",
        body: { subscription_id: sub.id, company_id: company.id, amount: Number(amount), payment_date: paymentDate, payment_method: method, reference_no: referenceNo || null, notes: notes || null },
      });
      onSaved(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to record payment"); }
    setSaving(false);
  };

  return (
    <ModalBackdrop onClose={onClose} maxWidth="max-w-md">
      <ModalHeader title="Collect Subscription Payment" subtitle={company.name} icon={IndianRupee} iconColor="text-emerald-400" iconBg="bg-emerald-500/10" onClose={onClose} />
      <div className="px-6 py-5 space-y-4">
        {/* Plan info strip */}
        <div className="rounded-lg px-3 py-2.5 flex items-center gap-3" style={{ background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.15)" }}>
          <Crown className="w-4 h-4 text-emerald-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-zinc-900">{sub.plan_name}</p>
            <p className="text-[0.6rem] text-zinc-500">Monthly: ₹{formatINR(sub.amount_monthly)} · Expires: {sub.expires_at ? formatDate(sub.expires_at) : "No expiry"}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-zinc-600 mb-1">Amount (₹) <span className="text-red-400">*</span></label>
            <input value={amount} onChange={e => setAmount(e.target.value)} type="number" min="0" placeholder="0.00" className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder-zinc-600 outline-none" style={inputStyle} />
          </div>
          <div>
            <label className="block text-xs text-zinc-600 mb-1">Payment Date</label>
            <input value={paymentDate} onChange={e => setPaymentDate(e.target.value)} type="date" className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 outline-none" style={inputStyle} />
          </div>
        </div>

        <div>
          <label className="block text-xs text-zinc-600 mb-1.5">Payment Method</label>
          <div className="flex flex-wrap gap-1.5">
            {METHODS.map(m => (
              <button key={m} onClick={() => setMethod(m)} className="px-2.5 py-1 rounded-lg text-[0.65rem] font-semibold transition-all" style={{ cursor: "pointer", background: method === m ? "rgba(16,185,129,0.2)" : "rgba(17, 17, 24,0.04)", border: method === m ? "1px solid rgba(16,185,129,0.4)" : "1px solid rgba(17, 17, 24,0.08)", color: method === m ? "rgb(52,211,153)" : "rgb(161,161,170)" }}>
                  {(m ?? "").replace("_", " ")}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs text-zinc-600 mb-1">Reference / Transaction No.</label>
          <input value={referenceNo} onChange={e => setReferenceNo(e.target.value)} placeholder="UTR / Cheque no. / Transaction ID" className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder-zinc-600 outline-none" style={inputStyle} />
        </div>

        <div>
          <label className="block text-xs text-zinc-600 mb-1">Notes</label>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional remark" className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder-zinc-600 outline-none" style={inputStyle} />
        </div>

        {error && <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2"><p className="text-xs text-red-400">{error}</p></div>}
      </div>
      <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-black/[0.06]">
        <button onClick={onClose} className="px-4 py-2 rounded-lg text-xs text-zinc-600" style={{ background: "transparent", border: "1px solid rgba(17, 17, 24,0.08)", cursor: "pointer" }}>Cancel</button>
        <button onClick={handleSave} disabled={saving} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium text-emerald-300" style={{ background: "rgba(16,185,129,0.2)", border: "1px solid rgba(16,185,129,0.3)", cursor: "pointer" }}>
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <IndianRupee className="w-3.5 h-3.5" />}
          {saving ? "Saving…" : "Record Payment"}
        </button>
      </div>
    </ModalBackdrop>
  );
}

function PaymentHistoryModal({ company, sub, onClose }: { company: Company; sub: Subscription; onClose: () => void }) {
  const [payments, setPayments] = useState<SubscriptionPayment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ success: boolean; data: SubscriptionPayment[] }>(`/api/v1/companies/subscription-payments?company_id=${company.id}`)
      .then(res => setPayments(res.data.filter(p => p.subscription_id === sub.id)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [company.id, sub.id]);

  const total = payments.reduce((s, p) => s + Number(p.amount), 0);

  const methodColor: Record<string, string> = {
    CASH: "text-emerald-400", UPI: "text-blue-400", BANK_TRANSFER: "text-violet-400",
    CHEQUE: "text-amber-400", CARD: "text-pink-400", OTHER: "text-zinc-600",
  };

  return (
    <ModalBackdrop onClose={onClose} maxWidth="max-w-lg">
      <ModalHeader title="Payment History" subtitle={`${company.name} · ${sub.plan_name}`} icon={Receipt} iconColor="text-blue-400" iconBg="bg-blue-500/10" onClose={onClose} />
      <div className="px-6 py-4">
        {/* Summary strip */}
        <div className="rounded-lg px-4 py-3 mb-4 flex items-center justify-between" style={{ background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.15)" }}>
          <div>
            <p className="text-[0.6rem] text-zinc-500 uppercase tracking-wider">Total Collected</p>
            <p className="text-lg font-black text-zinc-900">₹{formatINR(total)}</p>
          </div>
          <div className="text-right">
            <p className="text-[0.6rem] text-zinc-500 uppercase tracking-wider">Payments</p>
            <p className="text-lg font-black text-blue-400">{payments.length}</p>
          </div>
          <div className="text-right">
            <p className="text-[0.6rem] text-zinc-500 uppercase tracking-wider">Plan Monthly</p>
            <p className="text-sm font-bold text-zinc-700">₹{formatINR(sub.amount_monthly)}</p>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 text-blue-400 animate-spin" /></div>
        ) : payments.length === 0 ? (
          <div className="text-center py-10">
            <Receipt className="w-8 h-8 text-zinc-600 mx-auto mb-2" />
            <p className="text-sm text-zinc-500">No payments recorded yet</p>
            <p className="text-xs text-zinc-600 mt-1">Use "Collect" to record a payment</p>
          </div>
        ) : (
          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {payments.map(p => (
              <div key={p.id} className="rounded-lg px-3 py-2.5 flex items-center gap-3" style={{ background: "rgba(17, 17, 24,0.02)", border: "1px solid rgba(17, 17, 24,0.06)" }}>
                <div className="w-8 h-8 rounded-lg bg-zinc-50 border border-black/[0.06] flex items-center justify-center shrink-0">
                  <IndianRupee className="w-3.5 h-3.5 text-emerald-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-zinc-900">₹{formatINR(Number(p.amount))}</span>
                      <span className={`text-[0.6rem] font-semibold ${methodColor[p.payment_method] || "text-zinc-600"}`}>{(p.payment_method ?? "").replace("_", " ")}</span>
                    {p.reference_no && <span className="text-[0.6rem] text-zinc-500 truncate">#{p.reference_no}</span>}
                  </div>
                  {p.notes && <p className="text-[0.6rem] text-zinc-500 truncate mt-0.5">{p.notes}</p>}
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[0.65rem] font-medium text-zinc-700">{formatDate(p.payment_date)}</div>
                  {p.recorded_by && <div className="text-[0.55rem] text-zinc-600 truncate max-w-[80px]">{p.recorded_by}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center justify-end px-6 py-4 border-t border-black/[0.06]">
        <button onClick={onClose} className="px-4 py-2 rounded-lg text-xs text-zinc-600" style={{ background: "transparent", border: "1px solid rgba(17, 17, 24,0.08)", cursor: "pointer" }}>Close</button>
      </div>
    </ModalBackdrop>
  );
}

function SubscriptionTracker({ companies, subs, onEdit, onNew, onManageTemplates, onCollect, onHistory }: {
  companies: Company[];
  subs: Subscription[];
  onEdit: (company: Company, sub: Subscription | null) => void;
  onNew: () => void;
  onManageTemplates: () => void;
  onCollect: (company: Company, sub: Subscription) => void;
  onHistory: (company: Company, sub: Subscription) => void;
}) {
  const subMap = new Map(subs.map(s => [s.company_id, s]));

  const rows = companies.map(c => {
    const sub = subMap.get(c.id) || null;
    const daysLeft = sub?.expires_at ? daysUntil(sub.expires_at) : null;
    return { company: c, sub, daysLeft };
  }).sort((a, b) => {
    if (a.daysLeft === null) return 1;
    if (b.daysLeft === null) return -1;
    return a.daysLeft - b.daysLeft;
  });

  return (
    <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] overflow-hidden">
      <div className="px-5 py-3.5 border-b border-black/[0.06] flex items-center gap-2">
        <Crown className="w-4 h-4 text-amber-400" />
          <h3 className="text-sm font-semibold text-zinc-900">Subscription & Plan Tracker</h3>
          <span className="text-[0.65rem] text-zinc-500 ml-auto">{subs.length}/{companies.length} companies have plans</span>
          <button
            onClick={onManageTemplates}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-violet-300 transition-all ml-2"
            style={{ background: "rgba(139,92,246,0.15)", border: "1px solid rgba(139,92,246,0.3)", cursor: "pointer" }}
          >
            <Sparkles className="w-3 h-3 text-violet-400" />Manage Plans
          </button>

      </div>
      <div className="overflow-x-auto">
        <table className="w-full" style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(17, 17, 24,0.06)" }}>
                {["Company", "Plan", "Tier", "Monthly (₹)", "Expires", "Status", "Actions"].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left text-[0.6rem] font-semibold text-zinc-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ company, sub, daysLeft }) => {
              const tierCfg = PLAN_TIERS.find(t => t.value === sub?.plan_tier) || PLAN_TIERS[0];
              const TierIcon = tierCfg.icon;
              const expired = daysLeft !== null && daysLeft < 0;
              const expiring = daysLeft !== null && daysLeft >= 0 && daysLeft <= 30;
              return (
                <tr key={company.id} className="hover:bg-black/[0.02] transition-colors" style={{ borderBottom: "1px solid rgba(17, 17, 24,0.04)" }}>
                  <td className="px-4 py-2.5">
                    <div className="text-xs font-semibold text-zinc-900 whitespace-nowrap">{company.name}</div>
                    <div className="text-[0.6rem] text-zinc-600">{company.party_code}</div>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-zinc-600">{sub?.plan_name || <span className="text-zinc-600 italic">No plan</span>}</td>
                  <td className="px-4 py-2.5">
                    {sub ? (
                      <span className={`flex items-center gap-1 text-[0.6rem] font-semibold px-1.5 py-0.5 rounded w-fit ${tierCfg.bg} ${tierCfg.color}`}>
                        <TierIcon className="w-2.5 h-2.5" />{tierCfg.label}
                      </span>
                    ) : <span className="text-zinc-600 text-[0.65rem]">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-zinc-600 tabular-nums">{sub ? `₹${formatINR(sub.amount_monthly)}` : "—"}</td>
                  <td className="px-4 py-2.5">
                    {sub?.expires_at ? (
                      <div>
                        <div className={`text-xs font-medium ${expired ? "text-red-400" : expiring ? "text-amber-400" : "text-zinc-700"}`}>{formatDate(sub.expires_at)}</div>
                        <div className={`text-[0.6rem] ${expired ? "text-red-500" : expiring ? "text-amber-500" : "text-zinc-600"}`}>
                          {expired ? `Expired ${Math.abs(daysLeft!)}d ago` : expiring ? `${daysLeft}d left` : `${daysLeft}d left`}
                        </div>
                      </div>
                    ) : <span className="text-zinc-600 text-[0.65rem]">No expiry</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    {sub ? (
                      <span className={`text-[0.6rem] font-semibold px-1.5 py-0.5 rounded ${sub.status === "ACTIVE" ? "bg-emerald-500/10 text-emerald-400" : sub.status === "TRIAL" ? "bg-blue-500/10 text-blue-400" : sub.status === "EXPIRED" ? "bg-red-500/10 text-red-400" : "bg-zinc-500/10 text-zinc-600"}`}>{sub.status}</span>
                    ) : <span className="text-[0.6rem] text-zinc-600 italic">Unset</span>}
                  </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <button onClick={() => onEdit(company, sub)} className="flex items-center gap-1 text-[0.65rem] font-medium text-amber-400 hover:text-amber-300 transition-colors" style={{ background: "transparent", border: "none", cursor: "pointer" }}>
                          <Edit2 className="w-3 h-3" />{sub ? "Edit" : "Set Plan"}
                        </button>
                        {sub && (
                          <>
                            <span className="text-zinc-700 text-[0.6rem]">·</span>
                            <button onClick={() => onCollect(company, sub)} className="flex items-center gap-1 text-[0.65rem] font-medium text-emerald-400 hover:text-emerald-300 transition-colors" style={{ background: "transparent", border: "none", cursor: "pointer" }}>
                              <IndianRupee className="w-3 h-3" />Collect
                            </button>
                            <span className="text-zinc-700 text-[0.6rem]">·</span>
                            <button onClick={() => onHistory(company, sub)} className="flex items-center gap-1 text-[0.65rem] font-medium text-blue-400 hover:text-blue-300 transition-colors" style={{ background: "transparent", border: "none", cursor: "pointer" }}>
                              <Receipt className="w-3 h-3" />History
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
    </div>
  );
}

// ─── Company List Screen ───────────────────────────────────────────────────────

function CompanyListScreen({ onSelect }: { onSelect: (company: Company) => void }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Company | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  // Modal targets
  const [notesTarget, setNotesTarget] = useState<Company | null>(null);
  const [auditTarget, setAuditTarget] = useState<Company | null>(null);
  const [resetTarget, setResetTarget] = useState<Company | null>(null);
  const [editTarget, setEditTarget] = useState<Company | null>(null);
  const [subTarget, setSubTarget] = useState<{ company: Company; sub: Subscription | null } | null>(null);
  const [showNewPlanPicker, setShowNewPlanPicker] = useState(false);
  const [showPlanTemplates, setShowPlanTemplates] = useState(false);
  const [collectTarget, setCollectTarget] = useState<{ company: Company; sub: Subscription } | null>(null);
  const [historyTarget, setHistoryTarget] = useState<{ company: Company; sub: Subscription } | null>(null);

  // UI
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");
  const [activeTab, setActiveTab] = useState<"companies" | "health" | "leaderboard" | "subscriptions">("companies");
  const [filterStatus, setFilterStatus] = useState<"ALL" | "ACTIVE" | "SUSPENDED">("ALL");
  const [sortBy, setSortBy] = useState<"name" | "outstanding" | "health">("name");
  const [showAlerts, setShowAlerts] = useState(false);

  const user = getUser();
  const subMap = new Map(subs.map(s => [s.company_id, s]));

  const loadAll = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<{ success: boolean; data: Company[] }>("/api/v1/companies"),
      api<{ success: boolean; data: Subscription[] }>("/api/v1/companies/subscriptions").catch(() => ({ success: true, data: [] })),
    ]).then(([companiesRes, subsRes]) => {
      setCompanies(companiesRes.data);
      setSubs(subsRes.data);
    }).catch(e => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const handleCreate = async () => {
    if (!form.name.trim()) { setFormError("Company name is required."); return; }
    if (!form.address_line1.trim()) { setFormError("Address is required."); return; }
    if (!form.city.trim()) { setFormError("City is required."); return; }
    if (!form.contact_person.trim()) { setFormError("Contact person name is required."); return; }
    if (!form.contact_phone.trim()) { setFormError("Contact phone is required."); return; }
    if (!form.portal_password.trim()) { setFormError("Password is required."); return; }
    if (form.portal_password.length < 8) { setFormError("Password must be at least 8 characters."); return; }
    setFormError(""); setSaving(true);
    try {
      const payload = {
        ...form,
        party_code: form.party_code.trim() || "", // Leave empty for auto-generation
        party_type_id: COMPANY_TYPE_ID,
        status: "ACTIVE",
        portal_phone: form.contact_phone.replace(/[^0-9]/g, ''), // Use contact phone as login phone
        provision_auth_user: !!(form.contact_phone && form.portal_password),
        // Ensure empty strings are converted to null for UUID fields
        state_id: null,
        district_id: null,
        territory_id: null,
        salesman_id: null,
        parent_party_id: null,
        price_list_id: null,
      };
      console.log("Creating company with payload:", payload);
      const response = await fetch("/api/v1/parties", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("accessToken")}`,
        },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      console.log("Backend response:", data);
      if (!response.ok) {
        throw new Error(data.message || "Failed to create company");
      }
      setShowCreate(false); setForm(emptyForm); loadAll();
    } catch (e) {
      console.error("Company creation error:", e);
      setFormError(e instanceof Error ? e.message : "Failed to create company.");
    }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true); setDeleteError("");
    try {
      await api(`/api/v1/parties/${deleteTarget.id}`, { method: "DELETE" });
      setDeleteTarget(null); loadAll();
    } catch (e) { setDeleteError(e instanceof Error ? e.message : "Failed to delete company."); }
    setDeleting(false);
  };

  const handleSuspendToggle = async (company: Company) => {
    const action = company.status === "SUSPENDED" ? "activate" : "suspend";
    try { await api(`/api/v1/companies/${company.id}/suspend`, { method: "POST", body: { action } }); loadAll(); } catch {}
  };

  const handleExportCSV = () => {
    const token = localStorage.getItem("accessToken");
    fetch("/api/v1/companies/export", { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.blob()).then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "companies.csv"; a.click();
        URL.revokeObjectURL(url);
      });
  };

  // Derived
  const activeCount = companies.filter(c => c.status === "ACTIVE").length;
  const suspendedCount = companies.filter(c => c.status === "SUSPENDED").length;
  const totalOutstanding = companies.reduce((s, c) => s + c.outstanding, 0);
  const totalOverdue = companies.reduce((s, c) => s + (c.overdue || 0), 0);
  const totalUsers = companies.reduce((s, c) => s + c.totalUsers, 0);
  const totalMRR = subs.reduce((s, sub) => s + (sub.amount_monthly || 0), 0);
  const alerts = generateAlerts(companies, subs);
  const atRiskCount = companies.filter(c => getHealthScore(c).label === "At Risk").length;
  const expiringCount = subs.filter(s => { const d = daysUntil(s.expires_at); return d !== null && d >= 0 && d <= 30; }).length;

  const filtered = companies
    .filter(c => {
      if (filterStatus !== "ALL" && c.status !== filterStatus) return false;
      if (search && !c.name.toLowerCase().includes(search.toLowerCase()) && !c.party_code.toLowerCase().includes(search.toLowerCase()) && !(c.city || "").toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === "outstanding") return b.outstanding - a.outstanding;
      if (sortBy === "health") return getHealthScore(a).score - getHealthScore(b).score;
      return a.name.localeCompare(b.name);
    });

  if (loading) return <div className="flex items-center justify-center py-32"><Loader2 className="w-8 h-8 text-amber-500 animate-spin" /></div>;
  if (error) return <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-6 text-center"><p className="text-red-400 text-sm">{error}</p></div>;

  const tabs = [
    { id: "companies" as const, label: "Companies", icon: Building2, badge: companies.length },
    { id: "health" as const, label: "Health Monitor", icon: HeartPulse, badge: atRiskCount > 0 ? atRiskCount : undefined, badgeColor: "bg-red-500" },
    { id: "leaderboard" as const, label: "Outstanding", icon: TrendingDown, badge: undefined },
    { id: "subscriptions" as const, label: "Subscriptions", icon: Crown, badge: expiringCount > 0 ? expiringCount : undefined, badgeColor: "bg-amber-500" },
  ];

  return (
    <div style={{ fontFamily: "'Inter', 'system-ui', sans-serif" }}>

      {/* ── Header ── */}
      <div className="flex items-start justify-between mb-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Shield className="w-4 h-4 text-amber-400" />
            <h1 className="text-lg font-black text-zinc-900 tracking-tight">Super Admin</h1>
            <span className="text-[0.6rem] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400 font-bold border border-red-500/20">CONTROL CENTER</span>
          </div>
          <p className="text-zinc-500 text-xs">Welcome back, {user?.name?.split(" ")[0] || "Admin"} · Platform-wide oversight</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {/* Alert bell */}
          <button onClick={() => setShowAlerts(v => !v)}
            className={`relative flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-all ${showAlerts ? "text-amber-300" : "text-zinc-600 hover:text-zinc-900"}`}
            style={{ background: showAlerts ? "rgba(245,158,11,0.15)" : "rgba(17, 17, 24,0.04)", border: showAlerts ? "1px solid rgba(245,158,11,0.3)" : "1px solid rgba(17, 17, 24,0.08)", cursor: "pointer" }}>
            <Bell className="w-3.5 h-3.5" />
            {alerts.length > 0 && <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 flex items-center justify-center text-[0.5rem] text-zinc-900 font-bold">{Math.min(alerts.length, 9)}</span>}
          </button>
          <button onClick={handleExportCSV} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-zinc-600 hover:text-zinc-900 transition-all" style={{ background: "rgba(17, 17, 24,0.04)", border: "1px solid rgba(17, 17, 24,0.08)", cursor: "pointer" }}>
            <Download className="w-3.5 h-3.5" /><span className="hidden sm:inline">Export CSV</span>
          </button>
          <button onClick={() => setShowCreate(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-amber-300 transition-all" style={{ background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.3)", cursor: "pointer" }}>
            <Plus className="w-3.5 h-3.5 text-amber-400" />New Company
          </button>
          <button onClick={logout} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-zinc-600 hover:text-zinc-900" style={{ background: "rgba(17, 17, 24,0.04)", border: "1px solid rgba(17, 17, 24,0.08)", cursor: "pointer" }}>
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Alert Feed ── */}
      {showAlerts && (
        <div className="mb-5 rounded-xl border border-amber-500/20 overflow-hidden" style={{ background: "rgba(245,158,11,0.04)" }}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-amber-500/10">
            <div className="flex items-center gap-2">
              <Bell className="w-3.5 h-3.5 text-amber-400" />
              <span className="text-xs font-semibold text-amber-400">Platform Alerts</span>
              <span className="text-[0.6rem] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400">{alerts.length}</span>
            </div>
            <button onClick={() => setShowAlerts(false)} className="text-zinc-500 hover:text-zinc-900" style={{ background: "transparent", border: "none", cursor: "pointer" }}><X className="w-3.5 h-3.5" /></button>
          </div>
          {alerts.length === 0 ? <p className="text-xs text-zinc-500 text-center py-6">All companies are healthy</p> : (
            <div className="divide-y divide-black/[0.04] max-h-52 overflow-y-auto">
              {alerts.map((alert, i) => (
                <div key={i} className="flex items-start gap-3 px-4 py-2.5">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${alert.severity === "red" ? "bg-red-500" : "bg-amber-500"}`} />
                  <div>
                    <span className="text-xs text-zinc-700">{alert.message}</span>
                    <span className={`ml-2 text-[0.55rem] uppercase font-bold ${alert.severity === "red" ? "text-red-500" : "text-amber-500"}`}>{alert.type}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Platform KPI Strip ── */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2.5 mb-5">
        {[
          { label: "Companies", value: companies.length, icon: Building2, color: "text-amber-400", bg: "bg-amber-500/10" },
          { label: "Active", value: activeCount, icon: CheckCircle2, color: "text-emerald-400", bg: "bg-emerald-500/10" },
          { label: "Suspended", value: suspendedCount, icon: Lock, color: "text-red-400", bg: "bg-red-500/10" },
          { label: "At Risk", value: atRiskCount, icon: AlertTriangle, color: "text-orange-400", bg: "bg-orange-500/10" },
          { label: "Total Users", value: totalUsers, icon: Users, color: "text-blue-400", bg: "bg-blue-500/10" },
          { label: "Platform MRR", value: `₹${formatINR(totalMRR)}`, icon: IndianRupee, color: "text-violet-400", bg: "bg-violet-500/10", isText: true },
        ].map(kpi => {
          const Icon = kpi.icon;
          return (
            <div key={kpi.label} className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-3">
              <div className="flex items-center gap-1.5 mb-1.5">
                <div className={`w-5 h-5 rounded-md ${kpi.bg} flex items-center justify-center`}><Icon className={`w-3 h-3 ${kpi.color}`} /></div>
              </div>
              <div className={`text-lg font-black ${kpi.color}`}>{(kpi as any).isText ? kpi.value : kpi.value}</div>
              <div className="text-[0.6rem] text-zinc-500 mt-0.5">{kpi.label}</div>
            </div>
          );
        })}
      </div>

      {/* ── Second KPI row - outstanding + overdue ── */}
      <div className="grid grid-cols-2 gap-2.5 mb-5">
        <div className="rounded-xl border border-red-500/10 bg-red-500/[0.03] p-4 flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/15 flex items-center justify-center shrink-0"><CreditCard className="w-5 h-5 text-red-400" /></div>
          <div>
            <div className="text-[0.65rem] text-zinc-500 mb-0.5">Total Outstanding (All Companies)</div>
            <div className="text-2xl font-black text-red-400 tabular-nums">₹{formatINR(totalOutstanding)}</div>
          </div>
        </div>
        <div className="rounded-xl border border-orange-500/10 bg-orange-500/[0.03] p-4 flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-orange-500/10 border border-orange-500/15 flex items-center justify-center shrink-0"><AlertTriangle className="w-5 h-5 text-orange-400" /></div>
          <div>
            <div className="text-[0.65rem] text-zinc-500 mb-0.5">Total Overdue 60d+ (All Companies)</div>
            <div className="text-2xl font-black text-orange-400 tabular-nums">₹{formatINR(totalOverdue)}</div>
          </div>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="flex items-center gap-1 mb-4 border-b border-black/[0.06] pb-0">
        {tabs.map(tab => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`relative flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium transition-all border-b-2 -mb-px ${active ? "text-amber-400 border-amber-400" : "text-zinc-500 border-transparent hover:text-zinc-700"}`}
              style={{ background: "transparent", cursor: "pointer" }}>
              <Icon className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{tab.label}</span>
              {tab.badge !== undefined && (
                <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[0.5rem] font-black text-zinc-900 ${tab.badgeColor || "bg-zinc-600"}`}>{tab.badge}</span>
              )}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-1.5 pb-2">
          <button onClick={loadAll} className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900" style={{ background: "rgba(17, 17, 24,0.04)", border: "1px solid rgba(17, 17, 24,0.08)", cursor: "pointer" }}>
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Tab Content ── */}
      {activeTab === "companies" && (
        <>
          {/* Toolbar */}
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <div className="relative flex-1 min-w-40">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search companies…" className="w-full rounded-lg pl-8 pr-3 py-2 text-xs text-zinc-900 placeholder-zinc-600 outline-none" style={inputStyle} />
            </div>
            <div className="flex items-center gap-0 rounded-lg overflow-hidden" style={{ border: "1px solid rgba(17, 17, 24,0.08)" }}>
              {(["ALL", "ACTIVE", "SUSPENDED"] as const).map(s => (
                <button key={s} onClick={() => setFilterStatus(s)} className={`px-2.5 py-1.5 text-xs transition-colors ${filterStatus === s ? "bg-black/[0.08] text-zinc-900" : "text-zinc-500 hover:text-zinc-900"}`} style={{ background: filterStatus === s ? "rgba(17, 17, 24,0.08)" : "transparent", border: "none", cursor: "pointer" }}>
                  {s === "ALL" ? `All (${companies.length})` : s === "ACTIVE" ? `Active (${activeCount})` : `Suspended (${suspendedCount})`}
                </button>
              ))}
            </div>
            <select value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)} className="rounded-lg px-2.5 py-1.5 text-xs text-zinc-700 outline-none" style={{ background: "rgba(17, 17, 24,0.04)", border: "1px solid rgba(17, 17, 24,0.08)" }}>
              <option value="name">Sort: Name</option>
              <option value="outstanding">Sort: Outstanding</option>
              <option value="health">Sort: Health Risk</option>
            </select>
            <div className="flex items-center gap-0 rounded-lg overflow-hidden" style={{ border: "1px solid rgba(17, 17, 24,0.08)" }}>
              <button onClick={() => setViewMode("grid")} className={`p-1.5 transition-colors ${viewMode === "grid" ? "bg-black/[0.08] text-zinc-900" : "text-zinc-500"}`} style={{ background: viewMode === "grid" ? "rgba(17, 17, 24,0.08)" : "transparent", border: "none", cursor: "pointer" }}><LayoutGrid className="w-3.5 h-3.5" /></button>
              <button onClick={() => setViewMode("table")} className={`p-1.5 transition-colors ${viewMode === "table" ? "bg-black/[0.08] text-zinc-900" : "text-zinc-500"}`} style={{ background: viewMode === "table" ? "rgba(17, 17, 24,0.08)" : "transparent", border: "none", cursor: "pointer" }}><List className="w-3.5 h-3.5" /></button>
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-12 text-center">
              <Building2 className="w-10 h-10 text-amber-400/40 mx-auto mb-3" />
              <p className="text-zinc-600 text-sm font-medium mb-1">{search ? "No companies match" : "No companies yet"}</p>
              {!search && <button onClick={() => setShowCreate(true)} className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium text-amber-300" style={{ background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.2)", cursor: "pointer" }}><Plus className="w-3.5 h-3.5" />Create Company</button>}
            </div>
          ) : viewMode === "grid" ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filtered.map(company => (
                <CompanyCard key={company.id} company={company} sub={subMap.get(company.id)}
                  onSelect={() => onSelect(company)} onSuspendToggle={() => handleSuspendToggle(company)}
                  onEdit={() => setEditTarget(company)} onNotes={() => setNotesTarget(company)}
                  onAudit={() => setAuditTarget(company)} onResetPassword={() => setResetTarget(company)}
                  onDelete={() => { setDeleteTarget(company); setDeleteError(""); }}
                  onSubscription={() => setSubTarget({ company, sub: subMap.get(company.id) || null })}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-black/[0.06] overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full" style={{ borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid rgba(17, 17, 24,0.06)" }}>
                      {["#", "Company", "Status / Health", "Outstanding", "Overdue", "Plan", "Users", "Last Login", "Actions"].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-[0.6rem] font-semibold text-zinc-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((company, idx) => {
                      const health = getHealthScore(company);
                      const isSuspended = company.status === "SUSPENDED";
                      const sub = subMap.get(company.id);
                      const tierCfg = PLAN_TIERS.find(t => t.value === sub?.plan_tier) || PLAN_TIERS[0];
                      const TierIcon = tierCfg.icon;
                      return (
                        <tr key={company.id} className="hover:bg-black/[0.02] transition-colors" style={{ borderBottom: "1px solid rgba(17, 17, 24,0.04)" }}>
                          <td className="px-4 py-3 text-[0.6rem] text-zinc-600">{idx + 1}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2.5">
                              <div className={`w-7 h-7 rounded-lg border flex items-center justify-center shrink-0 ${isSuspended ? "bg-red-500/10 border-red-500/20" : "bg-amber-500/10 border-amber-500/20"}`}>
                                {isSuspended ? <Lock className="w-3 h-3 text-red-400" /> : <span className="text-amber-400 font-black text-[0.6rem]">{company.name.slice(0, 2).toUpperCase()}</span>}
                              </div>
                              <div>
                                <div className="text-xs font-semibold text-zinc-900 whitespace-nowrap">{company.name}</div>
                                <div className="text-[0.6rem] text-zinc-600">{company.party_code}{company.city ? ` · ${company.city}` : ""}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-col gap-1">
                              <span className={`text-[0.6rem] font-semibold px-1.5 py-0.5 rounded w-fit ${isSuspended ? "bg-red-500/10 text-red-400" : "bg-emerald-500/10 text-emerald-400"}`}>{company.status}</span>
                              <span className={`flex items-center gap-1 text-[0.6rem] w-fit ${health.color}`}><span className={`w-1.5 h-1.5 rounded-full ${health.dot}`} />{health.label}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3"><span className={`text-xs font-bold tabular-nums ${company.outstanding > 0 ? "text-red-400" : "text-emerald-400"}`}>₹{formatINR(company.outstanding)}</span></td>
                          <td className="px-4 py-3"><span className={`text-xs tabular-nums ${(company.overdue || 0) > 0 ? "text-orange-400 font-semibold" : "text-zinc-600"}`}>{(company.overdue || 0) > 0 ? `₹${formatINR(company.overdue || 0)}` : "—"}</span></td>
                          <td className="px-4 py-3">
                            {sub ? <span className={`flex items-center gap-1 text-[0.6rem] font-semibold px-1.5 py-0.5 rounded w-fit ${tierCfg.bg} ${tierCfg.color}`}><TierIcon className="w-2.5 h-2.5" />{sub.plan_name}</span>
                              : <span className="text-zinc-600 text-[0.65rem]">—</span>}
                          </td>
                          <td className="px-4 py-3 text-xs text-zinc-600">{company.totalUsers}</td>
                          <td className="px-4 py-3 text-xs text-zinc-500 whitespace-nowrap">{timeAgo(company.lastLogin)}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1">
                              {!isSuspended && <button onClick={() => onSelect(company)} title="Enter" className="w-6 h-6 rounded flex items-center justify-center text-zinc-500 hover:text-amber-400" style={{ background: "transparent", border: "none", cursor: "pointer" }}><Eye className="w-3.5 h-3.5" /></button>}
                              <button onClick={() => setEditTarget(company)} title="Edit" className="w-6 h-6 rounded flex items-center justify-center text-zinc-500 hover:text-blue-400" style={{ background: "transparent", border: "none", cursor: "pointer" }}><Edit2 className="w-3.5 h-3.5" /></button>
                              <button onClick={() => handleSuspendToggle(company)} className="w-6 h-6 rounded flex items-center justify-center text-zinc-500 hover:text-amber-400" style={{ background: "transparent", border: "none", cursor: "pointer" }}>
                                {isSuspended ? <PlayCircle className="w-3.5 h-3.5" /> : <PauseCircle className="w-3.5 h-3.5" />}
                              </button>
                              <button onClick={() => setSubTarget({ company, sub: subMap.get(company.id) || null })} className="w-6 h-6 rounded flex items-center justify-center text-zinc-500 hover:text-amber-400" style={{ background: "transparent", border: "none", cursor: "pointer" }}><Crown className="w-3.5 h-3.5" /></button>
                              <button onClick={() => setNotesTarget(company)} className="w-6 h-6 rounded flex items-center justify-center text-zinc-500 hover:text-yellow-400" style={{ background: "transparent", border: "none", cursor: "pointer" }}><StickyNote className="w-3.5 h-3.5" /></button>
                              <button onClick={() => { setDeleteTarget(company); setDeleteError(""); }} className="w-6 h-6 rounded flex items-center justify-center text-zinc-500 hover:text-red-400" style={{ background: "transparent", border: "none", cursor: "pointer" }}><Trash2 className="w-3.5 h-3.5" /></button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {activeTab === "health" && <HealthMonitorPanel companies={companies} />}
      {activeTab === "leaderboard" && <OutstandingLeaderboard companies={companies} />}
          {activeTab === "subscriptions" && (
            <SubscriptionTracker
              companies={companies}
              subs={subs}
              onEdit={(company, sub) => setSubTarget({ company, sub })}
              onNew={() => setShowNewPlanPicker(true)}
              onManageTemplates={() => setShowPlanTemplates(true)}
              onCollect={(company, sub) => setCollectTarget({ company, sub })}
              onHistory={(company, sub) => setHistoryTarget({ company, sub })}
            />
          )}

      {/* ── Create Company Modal ── */}
      {showCreate && (
        <ModalBackdrop onClose={() => { setShowCreate(false); setFormError(""); }} maxWidth="max-w-lg">
          <ModalHeader title="Create New Company" subtitle="Registers as a COMPANY party type" icon={Building2} iconColor="text-yellow-500" iconBg="bg-yellow-100" onClose={() => { setShowCreate(false); setFormError(""); }} />
          <div className="px-6 py-5 space-y-4">
            <div>
              <p className="text-[0.6rem] font-bold text-yellow-600 uppercase tracking-wider mb-3">Basic Info</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2"><label className="block text-xs text-zinc-600 mb-1">Company Name <span className="text-red-400">*</span></label><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Acme Distributors Pvt Ltd" className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder-zinc-600 outline-none" style={inputStyle} /></div>
                <div><label className="block text-xs text-zinc-600 mb-1">City <span className="text-red-400">*</span></label><input value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} placeholder="Mumbai" className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder-zinc-600 outline-none" style={inputStyle} /></div>
                <div className="col-span-2"><label className="block text-xs text-zinc-600 mb-1">Address <span className="text-red-400">*</span></label><input value={form.address_line1} onChange={e => setForm(f => ({ ...f, address_line1: e.target.value }))} placeholder="Street address" className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder-zinc-600 outline-none" style={inputStyle} /></div>
              </div>
            </div>
            <div>
              <p className="text-[0.6rem] font-bold text-yellow-600 uppercase tracking-wider mb-3">Contact</p>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block text-xs text-zinc-600 mb-1">Contact Person <span className="text-red-400">*</span></label><input value={form.contact_person} onChange={e => setForm(f => ({ ...f, contact_person: e.target.value }))} placeholder="Admin's full name" className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder-zinc-600 outline-none" style={inputStyle} /></div>
                <div><label className="block text-xs text-zinc-600 mb-1">Phone <span className="text-red-400">*</span></label><input value={form.contact_phone} onChange={e => setForm(f => ({ ...f, contact_phone: e.target.value }))} placeholder="Login ID (10-digit)" className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder-zinc-600 outline-none" style={inputStyle} /></div>
                <div><label className="block text-xs text-zinc-600 mb-1">Password <span className="text-red-400">*</span></label><input type="password" value={form.portal_password} onChange={e => setForm(f => ({ ...f, portal_password: e.target.value }))} placeholder="Min 8 characters" className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder-zinc-600 outline-none" style={inputStyle} /></div>
                <div><label className="block text-xs text-zinc-600 mb-1">Email</label><input value={form.contact_email} onChange={e => setForm(f => ({ ...f, contact_email: e.target.value }))} placeholder="company@example.com" className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder-zinc-600 outline-none" style={inputStyle} /></div>
              </div>
              <p className="text-[0.65rem] text-zinc-500 mt-2">Contact Person becomes the company admin. Phone + Password = login credentials.</p>
</div>
            <div>
              <p className="text-[0.6rem] font-bold text-yellow-600 uppercase tracking-wider mb-3">Tax Info <span className="text-zinc-600 normal-case font-normal">(optional)</span></p>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block text-xs text-zinc-600 mb-1">GSTIN</label><input value={form.gstin} onChange={e => setForm(f => ({ ...f, gstin: e.target.value.toUpperCase() }))} placeholder="22AAAAA0000A1Z5" className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder-zinc-600 outline-none" style={inputStyle} /></div>
                <div><label className="block text-xs text-zinc-600 mb-1">PAN</label><input value={form.pan} onChange={e => setForm(f => ({ ...f, pan: e.target.value.toUpperCase() }))} placeholder="AAAAA0000A" className="w-full rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder-zinc-600 outline-none" style={inputStyle} /></div>
              </div>
            </div>
            {formError && <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2"><p className="text-xs text-red-400">{formError}</p></div>}
          </div>
          <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-black/[0.06]">
            <button onClick={() => { setShowCreate(false); setFormError(""); setForm(emptyForm); }} className="px-4 py-2 rounded-lg text-xs text-zinc-600" style={{ background: "transparent", border: "1px solid rgba(17, 17, 24,0.08)", cursor: "pointer" }}>Cancel</button>
            <button onClick={handleCreate} disabled={saving} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium text-yellow-600" style={{ background: "rgba(254,252,232,0.8)", border: "1px solid rgba(234,179,8,0.3)", cursor: "pointer" }}>
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Building2 className="w-3.5 h-3.5 text-yellow-500" />}
              {saving ? "Creating…" : "Create Company"}
            </button>
          </div>
        </ModalBackdrop>
      )}

      {/* ── Delete Modal ── */}
      {deleteTarget && (
        <ModalBackdrop onClose={() => { setDeleteTarget(null); setDeleteError(""); }} maxWidth="max-w-sm">
          <div className="px-6 py-5">
            <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mb-4"><Trash2 className="w-5 h-5 text-red-400" /></div>
            <h2 className="text-sm font-semibold text-zinc-900 mb-1">Delete Company</h2>
            <p className="text-xs text-zinc-600 leading-relaxed">Are you sure you want to delete <span className="text-zinc-900 font-medium">{deleteTarget.name}</span>? This will permanently remove the company and cannot be undone.</p>
            {deleteError && <div className="mt-3 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2"><p className="text-xs text-red-400">{deleteError}</p></div>}
          </div>
          <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-black/[0.06]">
            <button onClick={() => { setDeleteTarget(null); setDeleteError(""); }} className="px-4 py-2 rounded-lg text-xs text-zinc-600" style={{ background: "transparent", border: "1px solid rgba(17, 17, 24,0.08)", cursor: "pointer" }}>Cancel</button>
            <button onClick={handleDelete} disabled={deleting} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium text-red-300" style={{ background: "rgba(239,68,68,0.2)", border: "1px solid rgba(239,68,68,0.3)", cursor: "pointer" }}>
              {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5 text-red-400" />}
              {deleting ? "Deleting…" : "Delete Company"}
            </button>
          </div>
        </ModalBackdrop>
      )}

        {/* ── Feature Modals ── */}
        {notesTarget && <NotesModal company={notesTarget} onClose={() => setNotesTarget(null)} />}
        {auditTarget && <AuditModal company={auditTarget} onClose={() => setAuditTarget(null)} />}
        {resetTarget && <ResetPasswordModal company={resetTarget} onClose={() => setResetTarget(null)} />}
        {editTarget && <EditCompanyModal company={editTarget} onClose={() => setEditTarget(null)} onSaved={loadAll} />}
          {subTarget && <SubscriptionModal company={subTarget.company} existing={subTarget.sub} onClose={() => setSubTarget(null)} onSaved={loadAll} />}
          {showPlanTemplates && <PlanTemplatesModal onClose={() => setShowPlanTemplates(false)} />}
          {collectTarget && <CollectPaymentModal company={collectTarget.company} sub={collectTarget.sub} onClose={() => setCollectTarget(null)} onSaved={loadAll} />}
          {historyTarget && <PaymentHistoryModal company={historyTarget.company} sub={historyTarget.sub} onClose={() => setHistoryTarget(null)} />}
          {showNewPlanPicker && (
          <NewPlanPickerModal
            companies={companies}
            subs={subs}
            onClose={() => setShowNewPlanPicker(false)}
            onPick={company => {
              setShowNewPlanPicker(false);
              setSubTarget({ company, sub: subs.find(s => s.company_id === company.id) || null });
            }}
          />
        )}
    </div>
  );
}

// ─── Company Dashboard Screen ─────────────────────────────────────────────────

function CompanyDashboardScreen({ company, onBack }: { company: Company; onBack?: () => void }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sub, setSub] = useState<Subscription | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(company.logo_url || null);
  const [uploading, setUploading] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("logo", file);
      const res = await fetch(`/api/v1/companies/${company.id}/logo`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("accessToken")}` },
        body: formData,
      });
      const json = await res.json();
      if (json.success) {
        setLogoUrl(json.data.logo_url + "?t=" + Date.now());
      }
    } catch {}
    setUploading(false);
    if (logoInputRef.current) logoInputRef.current.value = "";
  };

  useEffect(() => {
    Promise.all([
      api<{ success: boolean; data: DashboardData }>(`/api/v1/analytics/dashboard?company_id=${company.id}`),
      api<{ success: boolean; data: Subscription[] }>(`/api/v1/companies/subscriptions?company_id=${company.id}`).catch(() => ({ success: false, data: [] })),
    ])
      .then(([dashRes, subRes]) => {
        setData(dashRes.data);
        const activeSub = subRes.data?.find((s: Subscription) => s.status === "ACTIVE") || subRes.data?.[0] || null;
        setSub(activeSub);
      })
      .catch(e => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [company.id]);

  if (loading) return <div className="flex items-center justify-center py-32"><Loader2 className="w-8 h-8 text-amber-500 animate-spin" /></div>;
  if (error) return <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-6 text-center"><p className="text-red-400 text-sm">{error}</p></div>;
  if (!data) return null;

  const agingTotal = Object.values(data.aging).reduce((s, v) => s + v, 0);
  const overdueAmount = data.aging.BUCKET_2 + data.aging.BUCKET_3 + data.aging.BUCKET_4;

  return (
    <div style={{ fontFamily: "'Inter', 'system-ui', sans-serif" }}>
      {/* Company context banner */}
      <div className="rounded-2xl mb-6 overflow-hidden" style={{ background: "linear-gradient(135deg, rgba(245,158,11,0.12) 0%, rgba(245,158,11,0.04) 50%, rgba(0,0,0,0) 100%)", border: "1px solid rgba(245,158,11,0.3)" }}>
          <div className="px-5 py-4 flex items-center gap-4">
            <input ref={logoInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" onChange={handleLogoUpload} />
            <button
              onClick={() => logoInputRef.current?.click()}
              disabled={uploading}
              className="w-14 h-14 rounded-xl bg-gradient-to-br from-amber-500/30 to-amber-600/10 border border-amber-500/30 flex items-center justify-center shrink-0 relative overflow-hidden group/logo cursor-pointer"
              title="Click to upload company logo"
            >
              {uploading ? (
                <Loader2 className="w-5 h-5 text-amber-400 animate-spin" />
              ) : logoUrl ? (
                <>
                  <img src={logoUrl} alt={company.name} className="w-full h-full object-cover rounded-xl" />
                  <div className="absolute inset-0 bg-black/50 opacity-0 group-hover/logo:opacity-100 transition-opacity flex items-center justify-center rounded-xl">
                    <Camera className="w-4 h-4 text-white" />
                  </div>
                </>
              ) : (
                <>
                  <span className="text-amber-400 font-black text-lg group-hover/logo:hidden">{company.name.slice(0, 2).toUpperCase()}</span>
                  <Camera className="w-5 h-5 text-amber-400 hidden group-hover/logo:block" />
                </>
              )}
            </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5 flex-wrap">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[0.6rem] font-semibold uppercase tracking-wider bg-amber-500/20 text-amber-400 border border-amber-500/30">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />Active Company
              </span>
            </div>
            <h1 className="text-xl sm:text-2xl font-black text-zinc-900 leading-tight truncate">{company.name}</h1>
            <p className="text-amber-500/70 text-xs mt-0.5">{company.party_code} · FY 2025-26</p>
          </div>
          <div className="hidden sm:flex flex-col items-end gap-1.5 shrink-0">
            {onBack && (
              <button onClick={onBack} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-zinc-600 hover:text-zinc-900 transition-all" style={{ background: "rgba(17, 17, 24,0.04)", border: "1px solid rgba(17, 17, 24,0.08)", cursor: "pointer" }}>
                <ArrowLeft className="w-3.5 h-3.5" />All Companies
              </button>
            )}
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <Shield className="w-3.5 h-3.5 text-emerald-400" /><span className="text-emerald-400 text-xs font-semibold">Data Isolated</span>
              </div>
            </div>
          </div>
        </div>

      {/* Subscription Plan Card */}
      {(() => {
        if (!sub) {
          return (
            <div className="rounded-xl mb-6 flex items-center gap-3 px-4 py-3" style={{ background: "rgba(17, 17, 24,0.02)", border: "1px solid rgba(17, 17, 24,0.06)" }}>
              <div className="w-8 h-8 rounded-lg bg-zinc-50 border border-black/[0.06] flex items-center justify-center shrink-0">
                <Crown className="w-4 h-4 text-zinc-500" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-zinc-600">No Subscription Plan</p>
                <p className="text-[0.65rem] text-zinc-600">Contact your administrator to assign a plan</p>
              </div>
              <span className="text-[0.6rem] font-semibold px-2 py-1 rounded-lg bg-zinc-50 text-zinc-500 border border-black/[0.06]">UNASSIGNED</span>
            </div>
          );
        }
        const tierCfg = PLAN_TIERS.find(t => t.value === sub.plan_tier) || PLAN_TIERS[0];
        const TierIcon = tierCfg.icon;
        const daysLeft = daysUntil(sub.expires_at);
        const isExpired = daysLeft !== null && daysLeft <= 0;
        const isExpiring = daysLeft !== null && daysLeft > 0 && daysLeft <= 30;
        const expiryColor = isExpired ? "text-red-400" : isExpiring ? "text-amber-400" : "text-emerald-400";
        const expiryBg = isExpired ? "bg-red-500/10 border-red-500/20" : isExpiring ? "bg-amber-500/10 border-amber-500/20" : "bg-emerald-500/10 border-emerald-500/20";
        return (
            <div className="rounded-xl mb-6 overflow-hidden" style={{ background: "rgba(17, 17, 24,0.03)", border: "1px solid rgba(17, 17, 24,0.08)" }}>
            <div className="flex items-center gap-4 px-4 py-3.5">
              {/* Plan icon */}
              <div className={`w-10 h-10 rounded-xl ${tierCfg.bg} border ${tierCfg.border} flex items-center justify-center shrink-0`}>
                <TierIcon className={`w-5 h-5 ${tierCfg.color}`} />
              </div>
              {/* Plan details */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                  <span className={`text-[0.6rem] font-bold uppercase tracking-wider ${tierCfg.color}`}>{sub.plan_tier} PLAN</span>
                  <span className={`text-[0.6rem] font-semibold px-1.5 py-0.5 rounded border ${expiryBg} ${expiryColor}`}>
                    {isExpired ? "EXPIRED" : isExpiring ? `${daysLeft}d left` : "ACTIVE"}
                  </span>
                </div>
                <p className="text-sm font-bold text-zinc-900 truncate">{sub.plan_name}</p>
                {sub.notes && <p className="text-[0.65rem] text-zinc-500 truncate mt-0.5">{sub.notes}</p>}
              </div>
              {/* Plan meta */}
              <div className="hidden sm:flex items-center gap-4 shrink-0">
                {sub.amount_monthly > 0 && (
                  <div className="text-right">
                    <div className="text-[0.6rem] text-zinc-500">Monthly</div>
                    <div className="text-sm font-bold text-zinc-900">₹{formatINR(sub.amount_monthly)}</div>
                  </div>
                )}
                <div className="text-right">
                  <div className="text-[0.6rem] text-zinc-500">Started</div>
                  <div className="text-xs font-medium text-zinc-700">{formatDate(sub.started_at)}</div>
                </div>
                  {sub.expires_at && (
                    <div className="text-right">
                      <div className="text-[0.6rem] text-zinc-500">Expires</div>
                      <div className={`text-xs font-medium ${expiryColor}`}>{formatDate(sub.expires_at)}</div>
                      <div className={`text-[0.6rem] font-semibold ${isExpired ? "text-red-400" : isExpiring ? "text-amber-400" : "text-zinc-600"}`}>
                        {isExpired
                          ? `${Math.abs(daysLeft!)}d overdue`
                          : daysLeft === 0
                          ? "Expires today"
                          : `${daysLeft}d left`}
                      </div>
                    </div>
                  )}
              </div>
            </div>
            {/* Mobile expiry row */}
            <div className="sm:hidden flex items-center justify-between px-4 pb-3 gap-3">
              {sub.amount_monthly > 0 && <span className="text-[0.65rem] text-zinc-600">₹{formatINR(sub.amount_monthly)}/mo</span>}
              <span className="text-[0.65rem] text-zinc-500">Started: {formatDate(sub.started_at)}</span>
                {sub.expires_at && <span className={`text-[0.65rem] font-medium ${expiryColor}`}>Exp: {formatDate(sub.expires_at)} · {isExpired ? `${Math.abs(daysLeft!)}d overdue` : daysLeft === 0 ? "Today" : `${daysLeft}d left`}</span>}
            </div>
            {/* Expiry warning bar */}
            {isExpiring && (
              <div className="bg-amber-500/10 border-t border-amber-500/20 px-4 py-2 flex items-center gap-2">
                <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
                <span className="text-[0.65rem] text-amber-400">Plan expires in {daysLeft} day{daysLeft === 1 ? "" : "s"} — contact your admin to renew</span>
              </div>
            )}
            {isExpired && (
              <div className="bg-red-500/10 border-t border-red-500/20 px-4 py-2 flex items-center gap-2">
                <XCircle className="w-3 h-3 text-red-400 shrink-0" />
                <span className="text-[0.65rem] text-red-400">This plan has expired — contact your administrator</span>
              </div>
            )}
          </div>
        );
      })()}

      {/* Primary KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        {[
          { label: "Today's Billing", value: data.todaySales, icon: IndianRupee, gradient: "from-emerald-500/20 to-emerald-500/5", iconColor: "text-emerald-400", sub: `MTD: ₹${formatINR(data.mtdSales)}` },
          { label: "Today Collected", value: data.todayCollection, icon: CreditCard, gradient: "from-emerald-500/20 to-emerald-500/5", iconColor: "text-emerald-400", sub: "Collected from parties today" },
          { label: "MTD Collection", value: data.mtdCollection, icon: Banknote, gradient: "from-blue-500/20 to-blue-500/5", iconColor: "text-blue-400", sub: `Today: ₹${formatINR(data.todayCollection)}` },
        ].map(kpi => {
          const Icon = kpi.icon;
          return (
            <div key={kpi.label} className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-4">
              <div className="flex items-center gap-2.5 mb-3"><div className={`w-8 h-8 rounded-lg bg-gradient-to-br ${kpi.gradient} flex items-center justify-center`}><Icon className={`w-4 h-4 ${kpi.iconColor}`} /></div><span className="text-xs text-zinc-500">{kpi.label}</span></div>
              <div className="text-lg font-bold text-zinc-900 mb-1">₹{formatINR(kpi.value)}</div>
              <div className="text-[0.65rem] text-zinc-500">{kpi.sub}</div>
            </div>
          );
        })}
      </div>

      {/* Secondary KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {[
          { label: "TD Earned", value: data.tdEarned, icon: Receipt, color: "text-violet-400", href: "/dashboard/ledgers" },
          { label: "CD Earned", value: data.cdEarned, icon: FileText, color: "text-cyan-400", href: "/dashboard/ledgers" },
          { label: "Active Schemes", value: data.activeSchemes, icon: Gift, color: "text-pink-400", href: "/dashboard/schemes", isCurrency: false },
          { label: "Network Size", value: data.totalParties, icon: Building2, color: "text-orange-400", href: "/dashboard/parties", isCurrency: false },
        ].map(item => {
          const Icon = item.icon;
          const isCurrency = item.isCurrency !== false;
          return (
            <Link key={item.label} href={item.href} className="group rounded-xl border border-black/[0.06] bg-black/[0.02] p-3.5 hover:bg-black/[0.04] transition-all" style={{ textDecoration: "none" }}>
              <div className="flex items-center justify-between mb-2"><Icon className={`w-4 h-4 ${item.color}`} /><ArrowRight className="w-3 h-3 text-zinc-600 group-hover:text-zinc-600" /></div>
              <div className="text-sm font-semibold text-zinc-900">{isCurrency ? `₹${formatINR(item.value)}` : item.value}</div>
              <div className="text-[0.65rem] text-zinc-500 mt-0.5">{item.label}</div>
            </Link>
          );
        })}
      </div>

      {/* Main content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className="lg:col-span-2 rounded-xl border border-black/[0.06] bg-black/[0.02] overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-black/[0.06]">
            <h3 className="text-sm font-semibold text-zinc-900">Recent Invoices</h3>
            <Link href="/dashboard/orders" className="text-xs text-amber-400 hover:text-amber-300" style={{ textDecoration: "none" }}>View All</Link>
          </div>
          <div className="divide-y divide-black/[0.04]">
            {data.recentInvoices.length === 0 ? <div className="p-8 text-center text-zinc-500 text-sm">No invoices yet</div>
              : data.recentInvoices.slice(0, 6).map(inv => {
                const st = statusConfig[inv.payment_status] || statusConfig.UNPAID;
                return (
                  <div key={inv.id} className="flex items-center justify-between px-5 py-3 hover:bg-black/[0.02]">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-black/[0.04] flex items-center justify-center shrink-0"><FileText className="w-3.5 h-3.5 text-zinc-500" /></div>
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-zinc-900 truncate">{inv.invoice_number || "Draft"}</div>
                        <div className="text-[0.65rem] text-zinc-500 truncate">{inv.party_name} · {formatDate(inv.invoice_date)}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className={`px-2 py-0.5 rounded text-[0.6rem] font-medium ${st.bg} ${st.color}`}>{st.label}</span>
                      <span className="text-xs font-medium text-zinc-900 tabular-nums">₹{Number(inv.grand_total || 0).toLocaleString("en-IN")}</span>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
        <div className="rounded-xl border border-black/[0.06] bg-black/[0.02]">
          <div className="px-5 py-3.5 border-b border-black/[0.06]">
            <h3 className="text-sm font-semibold text-zinc-900">Aging Breakdown</h3>
            <p className="text-[0.65rem] text-zinc-500 mt-0.5">Total: ₹{formatINR(agingTotal)}</p>
          </div>
          <div className="p-5 space-y-3">
            {Object.entries(agingLabels).map(([key, cfg]) => {
              const amount = data.aging[key as keyof AgingData] || 0;
              const pct = agingTotal > 0 ? (amount / agingTotal) * 100 : 0;
              return (
                <div key={key}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className={`text-xs ${cfg.color}`}>{cfg.label}</span>
                    <span className="text-xs text-zinc-600 tabular-nums">₹{formatINR(amount)}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-black/[0.04] overflow-hidden">
                    <div className={`h-full rounded-full ${cfg.barColor} transition-all`} style={{ width: `${Math.max(pct, 0.5)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
          {overdueAmount > 0 && (
            <div className="mx-5 mb-4 p-3 rounded-lg bg-red-500/5 border border-red-500/10">
              <div className="flex items-center gap-2"><AlertTriangle className="w-3.5 h-3.5 text-red-400" /><span className="text-[0.65rem] text-red-400 font-medium">₹{formatINR(overdueAmount)} overdue (60+ days)</span></div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl border border-black/[0.06] bg-black/[0.02]">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-black/[0.06]">
            <h3 className="text-sm font-semibold text-zinc-900">Top Outstanding Parties</h3>
            <Link href="/dashboard/parties" className="text-xs text-amber-400" style={{ textDecoration: "none" }}>View All</Link>
          </div>
          <div className="divide-y divide-black/[0.04]">
            {data.topOutstandingParties.length === 0 ? <div className="p-8 text-center text-zinc-500 text-sm">No outstanding</div>
              : data.topOutstandingParties.map((party, idx) => (
                <div key={party.id} className="flex items-center justify-between px-5 py-3 hover:bg-black/[0.02]">
                  <div className="flex items-center gap-3">
                    <span className="w-6 h-6 rounded-full bg-black/[0.06] flex items-center justify-center text-[0.6rem] text-zinc-500 font-medium">{idx + 1}</span>
                    <div>
                      <div className="text-xs font-medium text-zinc-900">{party.name}</div>
                      <div className="text-[0.6rem] text-zinc-500">{party.party_code}</div>
                    </div>
                  </div>
                  <span className="text-xs font-semibold text-red-400 tabular-nums">₹{Number(party.outstanding).toLocaleString("en-IN")}</span>
                </div>
              ))}
          </div>
        </div>
        <div className="rounded-xl border border-black/[0.06] bg-black/[0.02]">
          <div className="px-5 py-3.5 border-b border-black/[0.06]"><h3 className="text-sm font-semibold text-zinc-900">Quick Actions</h3></div>
          <div className="p-4 grid grid-cols-3 gap-2">
            {[
              { label: "New Invoice", icon: FileText, href: "/dashboard/invoices/new", color: "text-emerald-400" },
              { label: "Record Payment", icon: Banknote, href: "/dashboard/payments", color: "text-blue-400" },
              { label: "Reconcile", icon: CheckCircle2, href: "/dashboard/payments/reconcile", color: "text-cyan-400" },
              { label: "View Ledgers", icon: BookOpen, href: "/dashboard/ledgers", color: "text-violet-400" },
              { label: "Schemes", icon: Gift, href: "/dashboard/schemes", color: "text-pink-400" },
              { label: "Rankings", icon: Trophy, href: "/dashboard/rankings", color: "text-amber-400" },
              { label: "Security", icon: Shield, href: "/dashboard/security", color: "text-orange-400" },
              { label: "Analytics", icon: BarChart3, href: "/dashboard/analytics", color: "text-teal-400" },
              { label: "Exports", icon: Box, href: "/dashboard/exports", color: "text-indigo-400" },
            ].map(action => {
              const Icon = action.icon;
              return (
                <Link key={action.label} href={action.href} className="flex flex-col items-center gap-1.5 p-3 rounded-lg border border-black/[0.04] bg-black/[0.01] hover:bg-black/[0.04] transition-all text-center group" style={{ textDecoration: "none" }}>
                  <Icon className={`w-4 h-4 ${action.color} group-hover:scale-110 transition-transform`} />
                  <span className="text-[0.65rem] text-zinc-600 group-hover:text-zinc-700 leading-tight">{action.label}</span>
                </Link>
              );
            })}
          </div>
          <div className="px-5 pb-4">
            <div className="rounded-lg bg-gradient-to-r from-amber-500/5 to-transparent border border-amber-500/10 p-3">
              <div className="flex items-center gap-2 mb-2"><TrendingUp className="w-3.5 h-3.5 text-amber-400" /><span className="text-[0.7rem] font-medium text-amber-400">DMS Performance</span></div>
              <div className="grid grid-cols-3 gap-3">
                <div><div className="text-xs font-semibold text-zinc-900">{data.activeSalesmen}</div><div className="text-[0.6rem] text-zinc-500">Active Users</div></div>
                <div><div className="text-xs font-semibold text-zinc-900">{data.totalParties}</div><div className="text-[0.6rem] text-zinc-500">Parties</div></div>
                <div><div className="text-xs font-semibold text-zinc-900">{data.activeSchemes}</div><div className="text-[0.6rem] text-zinc-500">Schemes</div></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Root Page ─────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const user = getUser();
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const isCompanyUser = user?.role === "ADMIN";

  const [selectedCompany, setSelectedCompany] = useState<Company | null>(null);
  const [ready, setReady] = useState(false);

  // Redirect to login if no session at all
  useEffect(() => {
    if (typeof window !== "undefined" && !localStorage.getItem("accessToken")) {
      window.location.href = "/login";
    }
  }, []);

    useEffect(() => {
      const id = localStorage.getItem("activeCompanyId");
      const name = localStorage.getItem("activeCompanyName");
      if (id && name) {
        const stub: Company = { id, name, party_code: "", contact_phone: null, contact_email: null, city: null, status: "ACTIVE", totalUsers: 0, outstanding: 0 };
        if (isSuperAdmin) {
          // Super admin can enrich the company object from the list API
          api<{ success: boolean; data: Company[] }>("/api/v1/companies")
            .then(res => {
              const found = res.data.find(c => c.id === id);
              setSelectedCompany(found ?? stub);
            })
            .catch(() => { setSelectedCompany(stub); })
            .finally(() => setReady(true));
        } else {
          // Non-admin users: use stored values directly, no API call needed
          setSelectedCompany(stub);
          setReady(true);
        }
        } else {
          // isCompanyUser with no stored company — auto-set from their user record
          if (isCompanyUser) {
            const partyId = user?.party_id || user?.companyId || user?.id || "";
            const partyName = user?.companyName || user?.name || "My Company";
            setActiveCompany(partyId, partyName);
            window.dispatchEvent(new Event("activeCompanyChanged"));
            setSelectedCompany({ id: partyId, name: partyName, party_code: "", contact_phone: null, contact_email: null, city: null, status: "ACTIVE", totalUsers: 0, outstanding: 0 });
          }
          setReady(true);
        }

    const onCompanyChanged = () => {
      const stored = localStorage.getItem("activeCompanyId");
      const n = localStorage.getItem("activeCompanyName") || "";
      if (!stored) { setSelectedCompany(null); }
      else { setSelectedCompany({ id: stored, name: n, party_code: "", contact_phone: null, contact_email: null, city: null, status: "ACTIVE", totalUsers: 0, outstanding: 0 }); }
    };
    window.addEventListener("activeCompanyChanged", onCompanyChanged);
    return () => window.removeEventListener("activeCompanyChanged", onCompanyChanged);
  }, []);

  const handleSelectCompany = (company: Company) => {
    setActiveCompany(company.id, company.name);
    setSelectedCompany(company);
    window.dispatchEvent(new Event("activeCompanyChanged"));
  };

  const handleBack = () => {
    clearActiveCompany();
    setSelectedCompany(null);
    window.dispatchEvent(new Event("activeCompanyChanged"));
  };

  if (!isSuperAdmin && !isCompanyUser) return <RegularDashboard />;
  if (!ready) return <div className="flex items-center justify-center py-32"><Loader2 className="w-8 h-8 text-amber-500 animate-spin" /></div>;
  if (selectedCompany) return <CompanyDashboardScreen company={selectedCompany} onBack={isSuperAdmin ? handleBack : undefined} />;
  return <CompanyListScreen onSelect={handleSelectCompany} />;
}

// ─── Wallet Balance Card (visible to party users) ─────────────────────────────

interface WalletTxn {
  id: string;
  type: string;
  amount: number;
  balance_after: number;
  reference_type: string | null;
  description: string | null;
  created_at: string;
  debit?: number;
  credit?: number;
}

function WalletBalanceCard({ partyId }: { partyId: string }) {
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [txns, setTxns] = useState<WalletTxn[]>([]);
  const [showAll, setShowAll] = useState(false);

  const fmtAmt = (n: number) => "₹" + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const fmtDate = (s: string) => new Date(s).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });

  const fetchData = useCallback(() => {
    api<{ success: boolean; data: { summary: { currentBalance: number; totalPayments?: number; totalInvoices?: number }; transactions: WalletTxn[] } }>(`/api/v1/parties/${partyId}/transactions`)
      .then(res => {
        setBalance(res.data?.summary?.currentBalance ?? 0);
        const all = (res.data?.transactions || []) as WalletTxn[];
        setTxns(all.slice().reverse());
      })
      .catch(() => setBalance(null))
      .finally(() => setLoading(false));
  }, [partyId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    const handler = () => fetchData();
    window.addEventListener("walletBalanceChanged", handler);
    return () => window.removeEventListener("walletBalanceChanged", handler);
  }, [fetchData]);

  if (loading) {
    return (
      <div className="rounded-2xl border border-black/[0.06] bg-white p-5 mb-6 animate-pulse">
        <div className="h-4 w-28 bg-black/[0.05] rounded mb-3" />
        <div className="h-9 w-40 bg-black/[0.05] rounded mb-4" />
        <div className="grid grid-cols-3 gap-3">
          {[1,2,3].map(i => <div key={i} className="h-14 bg-black/[0.04] rounded-xl" />)}
        </div>
      </div>
    );
  }

  if (balance === null) return null;

  const isCredit = (txn: WalletTxn) =>
    (txn.credit != null && txn.credit > 0) ||
    txn.type?.includes("CREDIT") || txn.type === "TOPUP" || txn.type === "REFUND" || txn.type === "PAYMENT" || txn.type === "OPENING";
  const totalCredits = txns.reduce((s, t) => s + (isCredit(t) ? (t.credit ?? t.amount ?? 0) : 0), 0);
  const totalDebits  = txns.reduce((s, t) => s + (!isCredit(t) ? (t.debit ?? Math.abs(t.amount ?? 0)) : 0), 0);
  // txns is already newest-first (reversed above), so take the first 5 for the
  // most-recent activity — slice(-5) would show the 5 OLDEST.
  const recent = showAll ? txns : txns.slice(0, 5);

  return (
    <div className="rounded-2xl border border-black/[0.06] bg-white shadow-sm overflow-hidden mb-6">
      {/* ── Header strip ── */}
      <div className="bg-gradient-to-r from-emerald-500/[0.07] via-teal-500/[0.04] to-transparent px-5 pt-5 pb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center shrink-0">
              <Banknote className="w-5 h-5 text-emerald-600" />
            </div>
            <div className="min-w-0">
              <p className="text-[0.68rem] font-semibold text-zinc-400 uppercase tracking-widest mb-0.5">Available Balance</p>
              <p className={`text-2xl sm:text-3xl font-bold tabular-nums leading-none break-words ${balance > 0 ? "text-emerald-600" : balance < 0 ? "text-red-500" : "text-zinc-800"}`}>
                {balance < 0 ? "−" : ""}{fmtAmt(balance)}
              </p>
              <p className="text-[0.65rem] text-zinc-400 mt-1">
                {balance > 0 ? "Distributor owes you this amount" : balance < 0 ? "You owe this amount" : "Account settled"}
              </p>
            </div>
          </div>
          <span className={`shrink-0 mt-1 px-2.5 py-1 rounded-full text-[0.62rem] font-bold border ${
            balance > 0 ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
            : balance < 0 ? "bg-red-500/10 text-red-600 border-red-500/20"
            : "bg-zinc-500/10 text-zinc-500 border-zinc-500/20"
          }`}>
            {balance > 0 ? "In Credit" : balance < 0 ? "Outstanding" : "Settled"}
          </span>
        </div>
      </div>

      {/* ── Stats row ── */}
      <div className="grid grid-cols-3 gap-px bg-black/[0.04] border-t border-b border-black/[0.05]">
        {[
          { label: "Total Payments", value: fmtAmt(totalCredits), color: "text-emerald-600", icon: <ArrowDownLeft className="w-3.5 h-3.5" /> },
          { label: "Total Invoiced", value: fmtAmt(totalDebits),  color: "text-red-500",     icon: <ArrowUpRight className="w-3.5 h-3.5" /> },
          { label: "Transactions",   value: String(txns.length),   color: "text-zinc-700",    icon: <History className="w-3.5 h-3.5" /> },
        ].map(({ label, value, color, icon }) => (
          <div key={label} className="bg-white px-4 py-3">
            <div className={`flex items-center gap-1 mb-1 ${color}`} style={{ fontSize: "0.6rem" }}>{icon}<span className="font-semibold uppercase tracking-wider">{label}</span></div>
            <p className={`font-bold tabular-nums ${color}`} style={{ fontSize: "0.9rem" }}>{value}</p>
          </div>
        ))}
      </div>

      {/* ── Recent transactions ── */}
      <div className="px-5 py-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[0.62rem] font-semibold text-zinc-400 uppercase tracking-widest">Recent Activity</span>
          {txns.length > 5 && (
            <button onClick={() => setShowAll(v => !v)} className="text-[0.65rem] font-medium text-amber-500 hover:text-amber-600 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}>
              {showAll ? "Show less" : `View all ${txns.length}`}
            </button>
          )}
        </div>

        {txns.length === 0 ? (
          <div className="text-center py-6">
            <History className="w-7 h-7 text-zinc-200 mx-auto mb-2" />
            <p className="text-[0.75rem] text-zinc-400">No transactions yet</p>
          </div>
        ) : (
          <div className="space-y-1">
            {recent.map((txn) => {
              const credit = isCredit(txn);
              const amt = credit ? (txn.credit ?? txn.amount ?? 0) : (txn.debit ?? Math.abs(txn.amount ?? 0));
              return (
                <div key={txn.id} className="flex items-center gap-3 py-2.5 border-b border-black/[0.04] last:border-0">
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${credit ? "bg-emerald-500/10" : "bg-red-500/8"}`}>
                    {credit
                      ? <ArrowDownLeft className="w-3.5 h-3.5 text-emerald-600" />
                      : <ArrowUpRight className="w-3.5 h-3.5 text-red-500" />
                    }
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-zinc-800 font-medium truncate" style={{ fontSize: "0.75rem" }}>
                      {txn.description || (txn.type || "").replace(/_/g, " ")}
                    </p>
                    <p className="text-zinc-400 mt-0.5" style={{ fontSize: "0.62rem" }}>
                      {fmtDate(txn.created_at)}
                      {txn.reference_type && txn.reference_type !== txn.type ? ` · ${txn.reference_type}` : ""}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={`font-semibold tabular-nums ${credit ? "text-emerald-600" : "text-red-500"}`} style={{ fontSize: "0.8rem" }}>
                      {credit ? "+" : "−"}{fmtAmt(amt)}
                    </p>
                    {txn.balance_after != null && (
                      <p className="text-zinc-400 tabular-nums" style={{ fontSize: "0.58rem" }}>Bal {fmtAmt(txn.balance_after)}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Invoice Requests Section — imported from @/components/invoice-requests-section

// ─── My Orders (Live Status Tracking) ──────────────────────────────────────────

interface OrderData {
  id: string;
  order_number: string;
  status: string;
  grand_total: number;
  subtotal: number;
  discount_amount: number;
  gst_amount: number;
  created_at: string;
  delivery_date: string | null;
  notes: string | null;
  order_items: { id: string; quantity: number; unit_price: number; line_total: number; products: { name: string; sku: string; unit_of_measure?: string } | null }[];
  buyer?: { id: string; name: string; party_code: string } | null;
}

const ORDER_STEPS = [
  { key: "APPROVED", label: "Approved", icon: CheckCircle2, color: "text-emerald-500", bg: "bg-emerald-500", ring: "ring-emerald-500/30" },
  { key: "PROCUREMENT", label: "Procurement", icon: Package, color: "text-blue-500", bg: "bg-blue-500", ring: "ring-blue-500/30" },
  { key: "DISPATCHED", label: "Dispatched", icon: Truck, color: "text-violet-500", bg: "bg-violet-500", ring: "ring-violet-500/30" },
  { key: "DELIVERED", label: "Delivered", icon: MapPin, color: "text-amber-500", bg: "bg-amber-500", ring: "ring-amber-500/30" },
] as const;

function getStepIndex(status: string): number {
  // Map order status to step index
  if (status === "APPROVED") return 0;
  if (status === "PROCUREMENT" || status === "IN_PROCUREMENT") return 1;
  if (status === "DISPATCHED") return 2;
  if (status === "DELIVERED") return 3;
  return -1; // PENDING, CANCELLED etc
}

function MyOrdersSection({ partyId }: { partyId: string }) {
    const [orders, setOrders] = useState<OrderData[]>([]);
    const [loading, setLoading] = useState(true);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [tab, setTab] = useState<"in_progress" | "delivered">("in_progress");

    // Build order → lot number mapping from DB delivery lots
    const [orderLotMap, setOrderLotMap] = useState<Record<string, string>>({});
    useEffect(() => {
      fetchDeliveryLots().then(lots => {
        const map: Record<string, string> = {};
        lots.forEach(lot => {
          lot.order_ids.forEach(oid => { map[oid] = lot.lot_number; });
        });
        setOrderLotMap(map);
      }).catch(() => {});
    }, [orders]);

    const load = useCallback(() => {
      setLoading(true);
      api<{ success: boolean; data: OrderData[] }>(`/api/v1/orders?party_id=${partyId}&limit=1000`)
          .then(res => {
            setOrders(res.data || []);
          })
        .catch(() => {})
        .finally(() => setLoading(false));
    }, [partyId]);

    useEffect(() => { load(); }, [load]);

    // Poll for status updates only while the page is visible, so backgrounded
    // tabs/app don't keep loading the server. This is the landing page every user
    // leaves open all day, so the interval is deliberately slow; the invoice
    // confirmation / dispatch listeners below cover anything that needs to be
    // immediate.
    useVisibleInterval(load, 60000);

    // Listen for invoice confirmation / dispatch events to refresh orders
    useEffect(() => {
      const handler = () => load();
      window.addEventListener("orderStatusChanged", handler);
      return () => window.removeEventListener("orderStatusChanged", handler);
    }, [load]);

      const inProgressOrders = orders.filter(o => ["APPROVED", "PROCUREMENT", "IN_PROCUREMENT", "DISPATCHED"].includes(o.status));
      const deliveredOrders = orders.filter(o => o.status === "DELIVERED");
      const displayOrders = tab === "in_progress" ? inProgressOrders : deliveredOrders;

      const approvedCount = inProgressOrders.filter(o => o.status === "APPROVED").length;
      const procurementCount = inProgressOrders.filter(o => ["PROCUREMENT", "IN_PROCUREMENT"].includes(o.status)).length;
      const dispatchedCount = inProgressOrders.filter(o => o.status === "DISPATCHED").length;

    return (
      <div className="rounded-xl border border-blue-500/15 overflow-hidden mb-6" style={{ background: "linear-gradient(135deg, rgba(59,130,246,0.03) 0%, rgba(17,17,24,0.02) 100%)" }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-blue-500/10">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-500/20 to-indigo-500/10 border border-blue-500/20 flex items-center justify-center">
              <ShoppingCart className="w-4.5 h-4.5 text-blue-400" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-zinc-900">My Orders</h3>
                <p className="text-[0.65rem] text-zinc-500">Track in-progress & delivered orders</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {inProgressOrders.length > 0 && (
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-500/10 border border-blue-500/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                  <span className="text-xs font-bold text-blue-500">{inProgressOrders.length} active</span>
                </span>
              )}
              {deliveredOrders.length > 0 && (
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                  <span className="text-xs font-bold text-emerald-500">{deliveredOrders.length} delivered</span>
                </span>
              )}
            <button onClick={load} className="w-7 h-7 rounded-lg flex items-center justify-center text-zinc-500 hover:text-blue-400 hover:bg-blue-500/10 transition-all" style={{ background: "transparent", border: "none", cursor: "pointer" }}>
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

          {/* Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 border-b border-black/[0.06]">
            <div className="px-3 sm:px-4 py-3 text-center border-r border-black/[0.06]">
              <div className="text-lg font-bold text-emerald-500 tabular-nums">{approvedCount}</div>
              <div className="text-[0.6rem] text-zinc-500">Approved</div>
            </div>
            <div className="px-4 py-3 text-center border-r border-black/[0.06]">
              <div className="text-lg font-bold text-blue-500 tabular-nums">{procurementCount}</div>
              <div className="text-[0.6rem] text-zinc-500">In Procurement</div>
            </div>
            <div className="px-4 py-3 text-center border-r border-black/[0.06]">
              <div className="text-lg font-bold text-violet-500 tabular-nums">{dispatchedCount}</div>
              <div className="text-[0.6rem] text-zinc-500">Dispatched</div>
            </div>
            <div className="px-4 py-3 text-center">
              <div className="text-lg font-bold text-emerald-500 tabular-nums">{deliveredOrders.length}</div>
              <div className="text-[0.6rem] text-zinc-500">Delivered</div>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-black/[0.06]">
            <button
              onClick={() => setTab("in_progress")}
              className={`flex-1 py-2.5 text-xs font-semibold text-center transition-all ${tab === "in_progress" ? "text-blue-500" : "text-zinc-500 hover:text-zinc-700"}`}
              style={{ background: tab === "in_progress" ? "rgba(59,130,246,0.04)" : "transparent", border: "none", borderBottom: tab === "in_progress" ? "2px solid rgb(59,130,246)" : "2px solid transparent", cursor: "pointer" }}
            >
              In Progress ({inProgressOrders.length})
            </button>
            <button
              onClick={() => setTab("delivered")}
              className={`flex-1 py-2.5 text-xs font-semibold text-center transition-all ${tab === "delivered" ? "text-emerald-600" : "text-zinc-500 hover:text-zinc-700"}`}
              style={{ background: tab === "delivered" ? "rgba(16,185,129,0.04)" : "transparent", border: "none", borderBottom: tab === "delivered" ? "2px solid rgb(16,185,129)" : "2px solid transparent", cursor: "pointer" }}
            >
              Delivered ({deliveredOrders.length})
            </button>
          </div>

      {/* Content */}
      {loading ? (
        <div className="p-8 flex items-center justify-center gap-2">
          <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
          <span className="text-xs text-zinc-500">Loading orders...</span>
        </div>
        ) : displayOrders.length === 0 ? (
          <div className="p-10 text-center">
            <ShoppingCart className="w-8 h-8 text-zinc-300 mx-auto mb-2" />
              <p className="text-sm font-medium text-zinc-500 mb-1">
                {tab === "in_progress" ? "No orders under process" : "No delivered orders yet"}
              </p>
              <p className="text-[0.65rem] text-zinc-400">
                {tab === "in_progress"
                  ? "Orders that are approved, in procurement, or dispatched will appear here with live status tracking."
                  : "Orders confirmed as delivered will appear here."}
              </p>
          </div>
        ) : (
          <div className="divide-y divide-black/[0.04]">
            {displayOrders.map(order => {
            const stepIdx = getStepIndex(order.status);
            const isExpanded = expandedId === order.id;
            const isDelivered = order.status === "DELIVERED";

            return (
              <div key={order.id} className="px-5 py-4">
                {/* Order header */}
                <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-zinc-900">{order.order_number}</span>
                        {orderLotMap[order.id] && (
                          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.6rem] font-semibold bg-amber-500/10 text-amber-600 border border-amber-500/20">
                            <Truck className="w-2.5 h-2.5" />
                            {orderLotMap[order.id]}
                          </span>
                        )}
                        <span className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.6rem] font-semibold ${
                        isDelivered ? "bg-emerald-500/10 text-emerald-500" :
                        stepIdx === 0 ? "bg-emerald-500/10 text-emerald-500" :
                        stepIdx === 1 ? "bg-blue-500/10 text-blue-500" :
                        stepIdx === 2 ? "bg-violet-500/10 text-violet-500" :
                        "bg-amber-500/10 text-amber-500"
                      }`}>
                        {isDelivered ? <CheckCircle2 className="w-2.5 h-2.5" /> :
                          <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
                        {ORDER_STEPS[stepIdx]?.label || order.status}
                      </span>
                    </div>
                    <div className="text-xs text-zinc-600 mt-1">
                      ₹{Number(order.grand_total || 0).toLocaleString("en-IN")}
                      <span className="text-zinc-400 mx-1">·</span>
                      {order.order_items?.length || 0} item{(order.order_items?.length || 0) !== 1 ? "s" : ""}
                      <span className="text-zinc-400 mx-1">·</span>
                      {formatDate(order.created_at)}
                    </div>
                  </div>
                </div>

                {/* Live status stepper */}
                <div className="flex items-center gap-0 mb-2">
                  {ORDER_STEPS.map((step, idx) => {
                    const StepIcon = step.icon;
                    const isActive = idx === stepIdx;
                    const isCompleted = idx < stepIdx || (isDelivered && idx <= stepIdx);
                    const isPast = idx <= stepIdx;

                    return (
                      <div key={step.key} className="flex items-center flex-1 last:flex-none">
                        {/* Step circle */}
                        <div className="flex flex-col items-center">
                          <div className={`w-7 h-7 rounded-full flex items-center justify-center transition-all ${
                            isCompleted ? `${step.bg} ring-4 ${step.ring}` :
                            isActive ? `${step.bg} ring-4 ${step.ring} animate-pulse` :
                            "bg-zinc-200"
                          }`}>
                            <StepIcon className={`w-3.5 h-3.5 ${isPast ? "text-white" : "text-zinc-400"}`} />
                          </div>
                          <span className={`text-[0.55rem] mt-1 font-medium ${isPast ? step.color : "text-zinc-400"}`}>
                            {step.label}
                          </span>
                        </div>
                        {/* Connector line */}
                        {idx < ORDER_STEPS.length - 1 && (
                          <div className={`flex-1 h-0.5 mx-1 rounded-full transition-all mt-[-14px] ${
                            idx < stepIdx ? step.bg : "bg-zinc-200"
                          }`} />
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Status message */}
                <div className={`text-[0.65rem] font-medium px-2.5 py-1.5 rounded-lg mb-1 ${
                  isDelivered ? "bg-emerald-500/10 text-emerald-600" :
                  stepIdx === 0 ? "bg-emerald-500/10 text-emerald-600" :
                  stepIdx === 1 ? "bg-blue-500/10 text-blue-600" :
                  stepIdx === 2 ? "bg-violet-500/10 text-violet-600" :
                  "bg-amber-500/10 text-amber-600"
                }`}>
                  {isDelivered ? "Order delivered successfully" :
                   stepIdx === 0 ? "Order approved — waiting for procurement" :
                   stepIdx === 1 ? "Order is being procured — items are being prepared" :
                   stepIdx === 2 ? "Order dispatched — on the way to you" :
                   `Current status: ${order.status}`}
                </div>

                {/* Expandable items */}
                {order.order_items && order.order_items.length > 0 && (
                  <>
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : order.id)}
                      className="flex items-center gap-1 mt-2 text-[0.65rem] text-blue-400 hover:text-blue-300 transition-colors"
                      style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0 }}
                    >
                      <ChevronDown className={`w-3 h-3 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                      {isExpanded ? "Hide" : "View"} {order.order_items.length} item{order.order_items.length > 1 ? "s" : ""}
                    </button>
                    {isExpanded && (
                      <div className="mt-2 rounded-lg bg-black/[0.03] border border-black/[0.06] overflow-hidden">
                        <div className="divide-y divide-black/[0.04]">
                          {order.order_items.map((item, idx) => (
                            <div key={item.id || idx} className="flex items-center justify-between px-3 py-2">
                              <div className="flex-1 min-w-0">
                                <div className="text-xs font-medium text-zinc-800 truncate">{item.products?.name || "Product"}</div>
                                <div className="text-[0.6rem] text-zinc-500">{item.products?.sku} · {item.quantity} {item.products?.unit_of_measure || "pcs"}</div>
                              </div>
                              <span className="text-xs font-semibold text-zinc-700 shrink-0 tabular-nums">₹{Number(item.line_total || 0).toLocaleString("en-IN")}</span>
                            </div>
                          ))}
                        </div>
                        <div className="flex items-center justify-between px-3 py-2 border-t border-black/[0.08] bg-black/[0.02]">
                          <span className="text-[0.65rem] text-zinc-500">Subtotal: ₹{Number(order.subtotal || 0).toLocaleString("en-IN")}{order.discount_amount > 0 ? ` · Discount: -₹${Number(order.discount_amount).toLocaleString("en-IN")}` : ""}{order.gst_amount > 0 ? ` · GST: ₹${Number(order.gst_amount).toLocaleString("en-IN")}` : ""}</span>
                          <span className="text-xs font-bold text-zinc-900">₹{Number(order.grand_total || 0).toLocaleString("en-IN")}</span>
                        </div>
                        {(order.delivery_date || order.notes) && (
                          <div className="px-3 py-2 border-t border-black/[0.06] flex flex-wrap gap-3">
                            {order.delivery_date && (
                              <span className="text-[0.6rem] text-zinc-500 flex items-center gap-1">
                                <span className="font-medium text-zinc-600">Delivery:</span>
                                {new Date(order.delivery_date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                              </span>
                            )}
                            {order.notes && (
                              <span className="text-[0.6rem] text-zinc-500 flex items-center gap-1">
                                <span className="font-medium text-zinc-600">Note:</span>{order.notes}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Regular Dashboard ─────────────────────────────────────────────────────────

const COMPANY_ROLES = new Set(["SALESMAN", "ADMIN", "SUPER_ADMIN"]);

function RegularDashboard() {
  const user = getUser();
  const isCompanyRole = COMPANY_ROLES.has(user?.role || "");

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(isCompanyRole);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isCompanyRole) return;
    api<{ success: boolean; data: DashboardData }>("/api/v1/analytics/dashboard")
      .then(res => setData(res.data))
      .catch(e => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [isCompanyRole]);

  // Retailer / party users: show their own wallet, orders, and invoices
  if (!isCompanyRole) {
    return (
      <div style={{ fontFamily: "'Inter', 'system-ui', sans-serif" }}>
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-zinc-900 mb-1">My Dashboard</h1>
            <p className="text-zinc-500 text-xs">Welcome back, {user?.name?.split(" ")[0] || "User"}</p>
          </div>
        </div>
        {user?.party_id && <WalletBalanceCard partyId={user.party_id} />}
        {!user?.party_id && (
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-8 text-center">
            <p className="text-zinc-500 text-sm">Your account is not linked to a party yet. Please contact your distributor.</p>
          </div>
        )}
      </div>
    );
  }

  if (loading) return <div className="flex items-center justify-center py-32"><Loader2 className="w-8 h-8 text-amber-500 animate-spin" /></div>;
  if (error) return <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-6 text-center"><p className="text-red-400 text-sm">{error}</p></div>;
  if (!data) return null;

  const agingTotal = Object.values(data.aging).reduce((s, v) => s + v, 0);
  const overdueAmount = data.aging.BUCKET_2 + data.aging.BUCKET_3 + data.aging.BUCKET_4;

    return (
      <div style={{ fontFamily: "'Inter', 'system-ui', sans-serif" }}>
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-zinc-900 mb-1">Distribution Command Center</h1>
            <p className="text-zinc-500 text-xs">Welcome back, {user?.name?.split(" ")[0] || "User"} · FY 2025-26</p>
          </div>
          <div className="hidden sm:flex items-center gap-2">
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />System Online</span>
          </div>
        </div>

          {/* Wallet Balance — visible to party users */}
          {user?.party_id && <WalletBalanceCard partyId={user.party_id} />}

          {/* Invoice Requests — visible to party users (CNF/Distributor etc.) */}
          {user?.party_id && <InvoiceRequestsSection partyId={user.party_id} />}

          {/* My Orders — approved orders with live status tracking */}
          {user?.party_id && <MyOrdersSection partyId={user.party_id} />}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        {[
          { label: "Today's Billing", value: data.todaySales, icon: IndianRupee, gradient: "from-emerald-500/20 to-emerald-500/5", iconColor: "text-emerald-400", sub: `MTD: ₹${formatINR(data.mtdSales)}` },
          { label: "Today Collected", value: data.todayCollection, icon: CreditCard, gradient: "from-emerald-500/20 to-emerald-500/5", iconColor: "text-emerald-400", sub: "Collected from parties today" },
          { label: "MTD Collection", value: data.mtdCollection, icon: Banknote, gradient: "from-blue-500/20 to-blue-500/5", iconColor: "text-blue-400", sub: `Today: ₹${formatINR(data.todayCollection)}` },
        ].map(kpi => {
          const Icon = kpi.icon;
          return (
            <div key={kpi.label} className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-4">
              <div className="flex items-center gap-2.5 mb-3"><div className={`w-8 h-8 rounded-lg bg-gradient-to-br ${kpi.gradient} flex items-center justify-center`}><Icon className={`w-4 h-4 ${kpi.iconColor}`} /></div><span className="text-xs text-zinc-500">{kpi.label}</span></div>
              <div className="text-lg font-bold text-zinc-900 mb-1">₹{formatINR(kpi.value)}</div>
              <div className="text-[0.65rem] text-zinc-500">{kpi.sub}</div>
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {[
          { label: "TD Earned", value: data.tdEarned, icon: Receipt, color: "text-violet-400", href: "/dashboard/ledgers" },
          { label: "CD Earned", value: data.cdEarned, icon: FileText, color: "text-cyan-400", href: "/dashboard/ledgers" },
          { label: "Active Schemes", value: data.activeSchemes, icon: Gift, color: "text-pink-400", href: "/dashboard/schemes", isCurrency: false },
          { label: "Network Size", value: data.totalParties, icon: Building2, color: "text-orange-400", href: "/dashboard/parties", isCurrency: false },
        ].map(item => {
          const Icon = item.icon;
          const isCurrency = item.isCurrency !== false;
          return (
            <Link key={item.label} href={item.href} className="group rounded-xl border border-black/[0.06] bg-black/[0.02] p-3.5 hover:bg-black/[0.04] transition-all" style={{ textDecoration: "none" }}>
              <div className="flex items-center justify-between mb-2"><Icon className={`w-4 h-4 ${item.color}`} /><ArrowRight className="w-3 h-3 text-zinc-600 group-hover:text-zinc-600" /></div>
              <div className="text-sm font-semibold text-zinc-900">{isCurrency ? `₹${formatINR(item.value)}` : item.value}</div>
              <div className="text-[0.65rem] text-zinc-500 mt-0.5">{item.label}</div>
            </Link>
          );
        })}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className="lg:col-span-2 rounded-xl border border-black/[0.06] bg-black/[0.02] overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-black/[0.06]">
            <h3 className="text-sm font-semibold text-zinc-900">Recent Invoices</h3>
            <Link href="/dashboard/orders" className="text-xs text-amber-400" style={{ textDecoration: "none" }}>View All</Link>
          </div>
          <div className="divide-y divide-black/[0.04]">
            {data.recentInvoices.length === 0 ? <div className="p-8 text-center text-zinc-500 text-sm">No invoices yet</div>
              : data.recentInvoices.slice(0, 6).map(inv => {
                const st = statusConfig[inv.payment_status] || statusConfig.UNPAID;
                return (
                  <div key={inv.id} className="flex items-center justify-between px-5 py-3 hover:bg-black/[0.02]">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-black/[0.04] flex items-center justify-center shrink-0"><FileText className="w-3.5 h-3.5 text-zinc-500" /></div>
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-zinc-900 truncate">{inv.invoice_number || "Draft"}</div>
                        <div className="text-[0.65rem] text-zinc-500 truncate">{inv.party_name} · {formatDate(inv.invoice_date)}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className={`px-2 py-0.5 rounded text-[0.6rem] font-medium ${st.bg} ${st.color}`}>{st.label}</span>
                      <span className="text-xs font-medium text-zinc-900 tabular-nums">₹{Number(inv.grand_total || 0).toLocaleString("en-IN")}</span>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
        <div className="rounded-xl border border-black/[0.06] bg-black/[0.02]">
          <div className="px-5 py-3.5 border-b border-black/[0.06]"><h3 className="text-sm font-semibold text-zinc-900">Aging Breakdown</h3><p className="text-[0.65rem] text-zinc-500 mt-0.5">Total: ₹{formatINR(agingTotal)}</p></div>
          <div className="p-5 space-y-3">
            {Object.entries(agingLabels).map(([key, cfg]) => {
              const amount = data.aging[key as keyof AgingData] || 0;
              const pct = agingTotal > 0 ? (amount / agingTotal) * 100 : 0;
              return (
                <div key={key}>
                  <div className="flex items-center justify-between mb-1.5"><span className={`text-xs ${cfg.color}`}>{cfg.label}</span><span className="text-xs text-zinc-600 tabular-nums">₹{formatINR(amount)}</span></div>
                  <div className="h-1.5 rounded-full bg-black/[0.04] overflow-hidden"><div className={`h-full rounded-full ${cfg.barColor}`} style={{ width: `${Math.max(pct, 0.5)}%` }} /></div>
                </div>
              );
            })}
          </div>
          {overdueAmount > 0 && <div className="mx-5 mb-4 p-3 rounded-lg bg-red-500/5 border border-red-500/10"><div className="flex items-center gap-2"><AlertTriangle className="w-3.5 h-3.5 text-red-400" /><span className="text-[0.65rem] text-red-400 font-medium">₹{formatINR(overdueAmount)} overdue (60+ days)</span></div></div>}
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl border border-black/[0.06] bg-black/[0.02]">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-black/[0.06]"><h3 className="text-sm font-semibold text-zinc-900">Top Outstanding Parties</h3><Link href="/dashboard/parties" className="text-xs text-amber-400" style={{ textDecoration: "none" }}>View All</Link></div>
          <div className="divide-y divide-black/[0.04]">
            {data.topOutstandingParties.length === 0 ? <div className="p-8 text-center text-zinc-500 text-sm">No outstanding</div>
              : data.topOutstandingParties.map((party, idx) => (
                <div key={party.id} className="flex items-center justify-between px-5 py-3 hover:bg-black/[0.02]">
                  <div className="flex items-center gap-3">
                    <span className="w-6 h-6 rounded-full bg-black/[0.06] flex items-center justify-center text-[0.6rem] text-zinc-500 font-medium">{idx + 1}</span>
                    <div><div className="text-xs font-medium text-zinc-900">{party.name}</div><div className="text-[0.6rem] text-zinc-500">{party.party_code}</div></div>
                  </div>
                  <span className="text-xs font-semibold text-red-400 tabular-nums">₹{Number(party.outstanding).toLocaleString("en-IN")}</span>
                </div>
              ))}
          </div>
        </div>
        <div className="rounded-xl border border-black/[0.06] bg-black/[0.02]">
          <div className="px-5 py-3.5 border-b border-black/[0.06]"><h3 className="text-sm font-semibold text-zinc-900">Quick Actions</h3></div>
          <div className="p-4 grid grid-cols-3 gap-2">
            {[
              { label: "New Invoice", icon: FileText, href: "/dashboard/invoices/new", color: "text-emerald-400" },
              { label: "Record Payment", icon: Banknote, href: "/dashboard/payments", color: "text-blue-400" },
              { label: "Reconcile", icon: CheckCircle2, href: "/dashboard/payments/reconcile", color: "text-cyan-400" },
              { label: "View Ledgers", icon: BookOpen, href: "/dashboard/ledgers", color: "text-violet-400" },
              { label: "Schemes", icon: Gift, href: "/dashboard/schemes", color: "text-pink-400" },
              { label: "Rankings", icon: Trophy, href: "/dashboard/rankings", color: "text-amber-400" },
              { label: "Security", icon: Shield, href: "/dashboard/security", color: "text-orange-400" },
              { label: "Analytics", icon: BarChart3, href: "/dashboard/analytics", color: "text-teal-400" },
              { label: "Exports", icon: Box, href: "/dashboard/exports", color: "text-indigo-400" },
            ].map(action => {
              const Icon = action.icon;
              return (
                <Link key={action.label} href={action.href} className="flex flex-col items-center gap-1.5 p-3 rounded-lg border border-black/[0.04] bg-black/[0.01] hover:bg-black/[0.04] transition-all text-center group" style={{ textDecoration: "none" }}>
                  <Icon className={`w-4 h-4 ${action.color} group-hover:scale-110 transition-transform`} />
                  <span className="text-[0.65rem] text-zinc-600 group-hover:text-zinc-700 leading-tight">{action.label}</span>
                </Link>
              );
            })}
          </div>
          <div className="px-5 pb-4">
            <div className="rounded-lg bg-gradient-to-r from-amber-500/5 to-transparent border border-amber-500/10 p-3">
              <div className="flex items-center gap-2 mb-2"><TrendingUp className="w-3.5 h-3.5 text-amber-400" /><span className="text-[0.7rem] font-medium text-amber-400">DMS Performance</span></div>
              <div className="grid grid-cols-3 gap-3">
                <div><div className="text-xs font-semibold text-zinc-900">{data.activeSalesmen}</div><div className="text-[0.6rem] text-zinc-500">Active Users</div></div>
                <div><div className="text-xs font-semibold text-zinc-900">{data.totalParties}</div><div className="text-[0.6rem] text-zinc-500">Parties</div></div>
                <div><div className="text-xs font-semibold text-zinc-900">{data.activeSchemes}</div><div className="text-[0.6rem] text-zinc-500">Schemes</div></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
