"use client";
/* eslint-disable @next/next/no-img-element -- the QR code is a short-lived data URI from our authenticated API */

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AlertTriangle, CheckCircle2, Loader2, MessageCircle, RefreshCw, ShieldCheck, Smartphone } from "lucide-react";

type Connection = {
  configured: boolean;
  connected: boolean;
  state: string;
  instance_name: string;
  provider: "evolution";
  qr_code: string | null;
  message: string;
};

export default function WhatsAppAutomationPage() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

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

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!connection || connection.connected) return;
    const timer = window.setInterval(() => refresh(true), 5000);
    return () => window.clearInterval(timer);
  }, [connection, refresh]);

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
    </div>
  );
}
