"use client";

import { useState } from "react";
import { Download, FileCode, FileJson, FileSpreadsheet, FileText, Loader2, Shield } from "lucide-react";

interface ExportOption {
  key: string;
  label: string;
  description: string;
  icon: typeof FileSpreadsheet;
  color: string;
  format: string;
  url: string;
  method: "GET" | "POST";
  hasDateRange?: boolean;
}

const exportOptions: ExportOption[] = [
  { key: "tally", label: "Tally Export", description: "Sales vouchers in Tally XML format", icon: FileCode, color: "text-purple-400 bg-purple-500/10", format: "XML", url: "/api/v1/export/tally", method: "GET", hasDateRange: true },
  { key: "gstr1", label: "GSTR-1 Report", description: "B2B invoices, HSN summary for GST filing", icon: Shield, color: "text-emerald-400 bg-emerald-500/10", format: "JSON", url: "/api/v1/export/gstr1", method: "GET", hasDateRange: true },
  { key: "td-cd", label: "TD/CD Report", description: "Trade & Cash Discount ledger summary", icon: FileText, color: "text-amber-400 bg-amber-500/10", format: "JSON", url: "/api/v1/export/td-cd-report", method: "GET" },
  { key: "collection", label: "Collection Report", description: "Payment collection summary by party", icon: FileJson, color: "text-blue-400 bg-blue-500/10", format: "JSON", url: "/api/v1/export/collection-report", method: "GET", hasDateRange: true },
  { key: "orders", label: "Orders Export", description: "All orders with items and status", icon: FileSpreadsheet, color: "text-cyan-400 bg-cyan-500/10", format: "CSV", url: "/api/v1/analytics/export/orders", method: "POST" },
  { key: "products", label: "Products Export", description: "Product catalog with HSN and pricing", icon: FileSpreadsheet, color: "text-orange-400 bg-orange-500/10", format: "CSV", url: "/api/v1/analytics/export/products", method: "POST" },
  { key: "payments", label: "Payments Export", description: "Payment transactions and reconciliation", icon: FileSpreadsheet, color: "text-pink-400 bg-pink-500/10", format: "CSV", url: "/api/v1/analytics/export/payments", method: "POST" },
];

const s: React.CSSProperties = { transform: "none", filter: "none", WebkitTextStroke: "0", background: "none", boxShadow: "none", display: "block", padding: 0 };

export default function ExportsPage() {
  const [exporting, setExporting] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const handleExport = async (opt: ExportOption) => {
    setExporting(opt.key);
    try {
      const token = localStorage.getItem("accessToken") || "";
      const params = new URLSearchParams();
      if (dateFrom) params.set("from", dateFrom);
      if (dateTo) params.set("to", dateTo);
      const urlWithParams = `${opt.url}${params.toString() ? `?${params}` : ""}`;

      const res = await fetch(urlWithParams, {
        method: opt.method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });

      if (res.ok) {
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("xml") || contentType.includes("csv") || contentType.includes("octet")) {
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          const ext = opt.format === "XML" ? "xml" : opt.format === "CSV" ? "csv" : "json";
          a.download = `${opt.key}-${dateFrom || "all"}-${new Date().toISOString().split("T")[0]}.${ext}`;
          a.click();
          URL.revokeObjectURL(url);
        } else {
          const json = await res.json();
          const blob = new Blob([JSON.stringify(json.data || json, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${opt.key}-${dateFrom || "all"}-${new Date().toISOString().split("T")[0]}.json`;
          a.click();
          URL.revokeObjectURL(url);
        }
        setDone(prev => [...prev, opt.key]);
      }
    } catch { /* empty */ }
    setExporting(null);
  };

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      <h1 className="text-2xl font-bold text-zinc-900 mb-1" style={{ ...s, fontSize: "1.5rem", marginBottom: "0.25rem" }}>Exports & Reports</h1>
      <p className="text-zinc-600 mb-6" style={{ fontSize: "0.8rem" }}>
        Download Tally XML, GSTR-1, TD/CD reports, and data exports
      </p>

      {/* Date range filter */}
      <div className="flex items-center gap-4 mb-6 p-4 rounded-xl border border-black/[0.06] bg-black/[0.02]">
        <span className="text-zinc-600" style={{ fontSize: "0.8rem" }}>Date Range:</span>
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
          className="px-3 py-1.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-amber-500/40"
          style={{ fontSize: "0.8rem", fontFamily: "inherit" }} />
        <span className="text-zinc-500">to</span>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
          className="px-3 py-1.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-amber-500/40"
          style={{ fontSize: "0.8rem", fontFamily: "inherit" }} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {exportOptions.map(opt => {
          const Icon = opt.icon;
          const [iconColor, iconBg] = opt.color.split(" ");
          return (
            <div key={opt.key} className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-5 hover:bg-black/[0.04] transition-all">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-xl ${iconBg} flex items-center justify-center`}>
                    <Icon className={`w-5 h-5 ${iconColor}`} />
                  </div>
                  <div>
                    <h3 className="text-zinc-900 font-medium" style={{ fontSize: "0.85rem" }}>{opt.label}</h3>
                    <p className="text-zinc-500" style={{ fontSize: "0.65rem" }}>{opt.description}</p>
                  </div>
                </div>
                <span className="px-2 py-0.5 rounded text-xs bg-black/5 text-zinc-500" style={{ fontSize: "0.55rem" }}>{opt.format}</span>
              </div>
              <button onClick={() => handleExport(opt)} disabled={exporting === opt.key}
                className="w-full mt-2 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-black/10 text-zinc-700 hover:bg-black/5 hover:text-zinc-900 disabled:opacity-50 transition-all"
                style={{ fontSize: "0.8rem", fontFamily: "inherit", textTransform: "none", background: "none", boxShadow: "none", cursor: "pointer" }}>
                {exporting === opt.key ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {done.includes(opt.key) ? "Download Again" : "Download"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
