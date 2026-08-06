"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2, UserCheck, X } from "lucide-react";
import { createDriver, deleteDriver, Driver, loadDrivers, updateDriver } from "@/lib/drivers-store";

export default function DriversPage() {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ name: "", phone: "", vehicle_no: "" });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    setDrivers(loadDrivers());
    setLoading(false);
  }, []);

  function refresh() {
    setDrivers(loadDrivers());
  }

  function handleCreate() {
    if (!form.name.trim()) { setError("Driver name is required"); return; }
    createDriver(form);
    setForm({ name: "", phone: "", vehicle_no: "" });
    setError("");
    setSuccess("Driver added");
    refresh();
  }

  function handleToggleStatus(id: string, current: "ACTIVE" | "INACTIVE") {
    updateDriver(id, { status: current === "ACTIVE" ? "INACTIVE" : "ACTIVE" });
    refresh();
  }

  function handleDelete(id: string) {
    deleteDriver(id);
    setSuccess("Driver removed");
    refresh();
  }

  const active = drivers.filter((d) => d.status === "ACTIVE");
  const inactive = drivers.filter((d) => d.status === "INACTIVE");

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-9 h-9 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center">
          <UserCheck className="w-5 h-5 text-sky-400" />
        </div>
        <div>
          <h1 className="text-zinc-900 font-bold" style={{ fontSize: "1.3rem" }}>Drivers</h1>
          <p className="text-zinc-500" style={{ fontSize: "0.75rem" }}>Manage delivery drivers assigned to lots</p>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 flex items-center justify-between" style={{ fontSize: "0.8rem" }}>
          {error}
          <button onClick={() => setError("")} style={{ background: "none", border: "none", cursor: "pointer" }}><X className="w-4 h-4" /></button>
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-between" style={{ fontSize: "0.8rem" }}>
          {success}
          <button onClick={() => setSuccess("")} style={{ background: "none", border: "none", cursor: "pointer" }}><X className="w-4 h-4" /></button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        {/* Create form */}
        <div className="rounded-2xl border border-black/[0.06] bg-white p-5 shadow-sm space-y-4">
          <div className="flex items-center gap-2">
            <Plus className="w-4 h-4 text-sky-500" />
            <h2 className="font-semibold text-zinc-900" style={{ fontSize: "0.95rem" }}>Add Driver</h2>
          </div>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-zinc-500" style={{ fontSize: "0.7rem" }}>Full name <span className="text-red-400">*</span></label>
              <input
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="Ravi Kumar"
                className="w-full rounded-xl border border-black/10 bg-black/[0.02] px-3 py-2 text-zinc-900 outline-none focus:border-sky-500/40"
                style={{ fontSize: "0.82rem" }}
              />
            </div>
            <div>
              <label className="mb-1 block text-zinc-500" style={{ fontSize: "0.7rem" }}>Phone</label>
              <input
                value={form.phone}
                onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
                placeholder="+91 98765 43210"
                className="w-full rounded-xl border border-black/10 bg-black/[0.02] px-3 py-2 text-zinc-900 outline-none focus:border-sky-500/40"
                style={{ fontSize: "0.82rem" }}
              />
            </div>
            <div>
              <label className="mb-1 block text-zinc-500" style={{ fontSize: "0.7rem" }}>Vehicle no.</label>
              <input
                value={form.vehicle_no}
                onChange={(e) => setForm((p) => ({ ...p, vehicle_no: e.target.value }))}
                placeholder="WB-12-AB-1024"
                className="w-full rounded-xl border border-black/10 bg-black/[0.02] px-3 py-2 text-zinc-900 outline-none focus:border-sky-500/40"
                style={{ fontSize: "0.82rem" }}
              />
            </div>
            <button
              onClick={handleCreate}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-sky-500 px-4 py-2.5 font-medium text-white hover:bg-sky-600"
              style={{ fontSize: "0.82rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}
            >
              <Plus className="w-4 h-4" /> Add driver
            </button>
          </div>
        </div>

        {/* Driver list */}
        <div className="space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-zinc-500" style={{ fontSize: "0.85rem" }}>
              <Loader2 className="w-5 h-5 animate-spin mr-2 text-sky-400" /> Loading…
            </div>
          ) : drivers.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-black/10 bg-black/[0.01] p-12 text-center">
              <UserCheck className="w-10 h-10 text-zinc-400 mx-auto mb-3" />
              <p className="text-zinc-600 font-medium" style={{ fontSize: "0.9rem" }}>No drivers yet</p>
              <p className="text-zinc-500 mt-1" style={{ fontSize: "0.75rem" }}>Add drivers here to assign them to delivery lots.</p>
            </div>
          ) : (
            <>
              {active.length > 0 && (
                <div>
                  <div className="text-zinc-500 mb-2 font-medium" style={{ fontSize: "0.68rem", letterSpacing: "0.05em" }}>ACTIVE ({active.length})</div>
                  <div className="space-y-2">
                    {active.map((d) => <DriverRow key={d.id} driver={d} onToggle={handleToggleStatus} onDelete={handleDelete} />)}
                  </div>
                </div>
              )}
              {inactive.length > 0 && (
                <div>
                  <div className="text-zinc-500 mb-2 font-medium mt-4" style={{ fontSize: "0.68rem", letterSpacing: "0.05em" }}>INACTIVE ({inactive.length})</div>
                  <div className="space-y-2">
                    {inactive.map((d) => <DriverRow key={d.id} driver={d} onToggle={handleToggleStatus} onDelete={handleDelete} />)}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DriverRow({ driver, onToggle, onDelete }: {
  driver: Driver;
  onToggle: (id: string, status: "ACTIVE" | "INACTIVE") => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-4 px-4 py-3 rounded-xl border border-black/[0.06] bg-white hover:bg-black/[0.01] transition-all">
      <div className="w-9 h-9 rounded-full bg-sky-500/10 border border-sky-500/20 flex items-center justify-center shrink-0">
        <span className="text-sky-500 font-bold" style={{ fontSize: "0.75rem" }}>
          {driver.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-zinc-900 font-medium" style={{ fontSize: "0.85rem" }}>{driver.name}</div>
        <div className="text-zinc-500 flex gap-3" style={{ fontSize: "0.7rem" }}>
          {driver.phone && <span>{driver.phone}</span>}
          {driver.vehicle_no && <span className="font-mono">{driver.vehicle_no}</span>}
        </div>
      </div>
      <span className={`px-2 py-0.5 rounded-full border text-[0.6rem] font-bold ${
        driver.status === "ACTIVE"
          ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
          : "text-zinc-400 bg-black/[0.03] border-black/10"
      }`}>
        {driver.status}
      </span>
      <button
        onClick={() => onToggle(driver.id, driver.status)}
        className="px-2.5 py-1 rounded-lg border border-black/10 text-zinc-500 hover:border-sky-500/30 hover:text-sky-500 transition-all"
        style={{ fontSize: "0.65rem", background: "none", fontFamily: "inherit", cursor: "pointer" }}
      >
        {driver.status === "ACTIVE" ? "Deactivate" : "Activate"}
      </button>
      <button
        onClick={() => onDelete(driver.id)}
        className="p-1.5 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-all"
        style={{ background: "none", border: "none", cursor: "pointer" }}
        title="Remove driver"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
