"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import {
  Shield,
  Eye,
  Plus,
  Pencil,
  Trash2,
  CheckCircle,
  ChevronDown,
  Loader2,
  Check,
    X,
    LayoutDashboard,
  Building2,
  ClipboardList,
  CreditCard,
  Navigation,
  Package,
  Tag,
  BookOpen,
  Lock,
  Gift,
  Trophy,
  Network,
  Layers,
  MapPin,
  Radar,
  Truck,
  FlaskConical,
  Percent,
  BarChart3,
  Users,
  Settings,
  Box,
  ShoppingCart,
  PackageCheck,
} from "lucide-react";

const MODULE_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  dashboard:      { label: "Dashboard",      icon: LayoutDashboard, color: "text-blue-400" },
  parties:        { label: "Parties",        icon: Building2,       color: "text-amber-400" },
  invoices:       { label: "Invoices",       icon: ClipboardList,   color: "text-green-400" },
  procurement:    { label: "Procurement",    icon: ShoppingCart,    color: "text-lime-400" },
  delivery_lots:  { label: "Delivery Lots",  icon: PackageCheck,    color: "text-cyan-400" },
  payments:       { label: "Financials",     icon: CreditCard,     color: "text-purple-400" },
  reconcile:      { label: "Reconcile",      icon: Navigation,      color: "text-cyan-400" },
  products:       { label: "Products",       icon: Package,         color: "text-orange-400" },
  pricing:        { label: "Pricing",        icon: Tag,             color: "text-yellow-400" },
  ledgers:        { label: "Ledgers",        icon: BookOpen,        color: "text-indigo-400" },
  security:       { label: "Security",       icon: Lock,            color: "text-red-400" },
  schemes:        { label: "Schemes",        icon: Gift,            color: "text-pink-400" },
  rankings:       { label: "Rankings",      icon: Trophy,          color: "text-yellow-300" },
  downline:       { label: "Downline",       icon: Network,         color: "text-teal-400" },
  groups:         { label: "Groups",         icon: Layers,          color: "text-amber-400" },
  routes:         { label: "Routes",         icon: MapPin,          color: "text-emerald-400" },
  tracking:       { label: "Tracking",      icon: Radar,           color: "text-sky-400" },
  van_tracking:   { label: "Van Tracking",  icon: Truck,           color: "text-teal-300" },
  analytics:      { label: "Analytics",     icon: BarChart3,       color: "text-rose-400" },
  users:          { label: "Users",          icon: Users,           color: "text-blue-300" },
  control_panel:  { label: "Control Panel", icon: Settings,        color: "text-amber-300" },
  exports:        { label: "Exports",        icon: Box,             color: "text-zinc-600" },
  bom_inventory:  { label: "BOM & Inventory", icon: FlaskConical,  color: "text-violet-400" },
  driver_duty:    { label: "Driver Duty",   icon: Truck,           color: "text-amber-500" },
  tax_settings:   { label: "Tax Settings",  icon: Percent,         color: "text-emerald-500" },
};

const PERMISSION_FIELDS = [
  { key: "can_view",    label: "View",    icon: Eye,          color: "text-blue-400" },
  { key: "can_create",  label: "Create",  icon: Plus,         color: "text-green-400" },
  { key: "can_edit",    label: "Edit",    icon: Pencil,       color: "text-amber-400" },
  { key: "can_delete",  label: "Delete",  icon: Trash2,       color: "text-red-400" },
  { key: "can_approve", label: "Approve", icon: CheckCircle,  color: "text-purple-400" },
];

const ROLE_COLORS: Record<string, string> = {
  SUPER_ADMIN:       "bg-red-500/20 text-red-400 border-red-500/30",
  ADMIN:             "bg-purple-500/20 text-purple-400 border-purple-500/30",
  SALES_MANAGER:     "bg-blue-500/20 text-blue-400 border-blue-500/30",
  TERRITORY_MANAGER: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  SALESMAN:          "bg-green-500/20 text-green-400 border-green-500/30",
  ACCOUNTS_MANAGER:  "bg-teal-500/20 text-teal-400 border-teal-500/30",
  AUDITOR:           "bg-orange-500/20 text-orange-400 border-orange-500/30",
  WAREHOUSE_MANAGER: "bg-indigo-500/20 text-indigo-400 border-indigo-500/30",
  CNF_USER:          "bg-amber-500/20 text-amber-400 border-amber-500/30",
  SUPER_DEALER_USER: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  RETAILER_USER:     "bg-pink-500/20 text-pink-400 border-pink-500/30",
};

interface ModulePerm {
  id: string | null;
  role_id: string;
  module_name: string;
  can_view: boolean;
  can_create: boolean;
  can_edit: boolean;
  can_delete: boolean;
  can_approve: boolean;
  scope: "downline" | "all";
  status: string;
}

interface RoleMatrix {
  role: { id: string; name: string };
  modules: ModulePerm[];
}

export default function ControlPanelPage() {
  const [matrix, setMatrix] = useState<RoleMatrix[]>([]);
  const [modules, setModules] = useState<string[]>([]);
  const [activeRole, setActiveRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string>("");
  const [search, setSearch] = useState("");
  const [roleDropdownOpen, setRoleDropdownOpen] = useState(false);

    const fetchData = useCallback(async (companyId: string | null) => {
    setLoading(true);
    setMatrix([]);
    setActiveRole(null);
    const url = companyId
      ? `/api/v1/control-panel?company_id=${companyId}`
      : "/api/v1/control-panel";
    const res = await fetch(url);
    const json = await res.json();
      if (json.success) {
        const allMatrix: RoleMatrix[] = json.data.matrix;
        setMatrix(allMatrix);
        setModules(json.data.modules);
        const visible = allMatrix.filter((r) => r.role.name !== "SUPER_ADMIN");
        if (visible.length > 0) {
          setActiveRole(visible[0].role.id);
        }
    }
    setLoading(false);
  }, []);

    useEffect(() => {
      fetchData(null);
    }, [fetchData]);

  const toggle = async (roleId: string, module: string, field: string, current: boolean) => {
    const key = `${roleId}:${module}:${field}`;
    setSaving(key);

    setMatrix((prev) =>
      prev.map((r) =>
        r.role.id !== roleId ? r : {
          ...r,
          modules: r.modules.map((m) =>
m.module_name !== module ? m : { ...m, [field]: !current }
            ),
          }
        )
      );

      await api("/api/v1/control-panel", {
        method: "PATCH",
        body: { role_id: roleId, module_name: module, field, value: !current },
    });

    setSaving("");
  };

  const toggleAllModule = async (roleId: string, module: string, enable: boolean) => {
    for (const f of PERMISSION_FIELDS) {
      const key = `${roleId}:${module}:${f.key}`;
      setSaving(key);
      setMatrix((prev) =>
        prev.map((r) =>
          r.role.id !== roleId ? r : {
            ...r,
            modules: r.modules.map((m) =>
              m.module_name !== module ? m : { ...m, [f.key]: enable }
              ),
            }
          )
        );
        await api("/api/v1/control-panel", {
          method: "PATCH",
          body: { role_id: roleId, module_name: module, field: f.key, value: enable },
      });
    }
    setSaving("");
  };

  const toggleScope = async (roleId: string, module: string, current: "downline" | "all") => {
    const newScope = current === "downline" ? "all" : "downline";
    const key = `${roleId}:${module}:scope`;
    setSaving(key);

    setMatrix((prev) =>
      prev.map((r) =>
        r.role.id !== roleId ? r : {
          ...r,
          modules: r.modules.map((m) =>
            m.module_name !== module ? m : { ...m, scope: newScope }
          ),
        }
      )
    );

    await api("/api/v1/control-panel", {
      method: "PATCH",
      body: { role_id: roleId, module_name: module, field: "scope", value: newScope },
    });

    setSaving("");
  };

      const visibleMatrix = matrix.filter((r) => r.role.name !== "SUPER_ADMIN");
      const activeMatrix = visibleMatrix.find((r) => r.role.id === activeRole);
      const isAdminRole = activeMatrix?.role.name === "ADMIN";
    const filteredModules = (activeMatrix?.modules || []).filter((m) =>
      search === "" || MODULE_META[m.module_name]?.label.toLowerCase().includes(search.toLowerCase())
    );

  const allOn = (mods: ModulePerm[]) => mods.every((m) => PERMISSION_FIELDS.every((f) => m[f.key as keyof ModulePerm]));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
            <Shield className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-zinc-900">Control Panel</h1>
            <p className="text-xs text-zinc-500">Manage what each role can access and do</p>
          </div>
        </div>
        <div className="text-xs text-zinc-600 bg-black/[0.03] border border-black/[0.06] rounded-lg px-3 py-1.5">
          {visibleMatrix.length} roles · {modules.length} modules
        </div>
      </div>



      {/* Loading spinner inline */}
      {loading && (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="w-6 h-6 text-amber-400 animate-spin" />
        </div>
      )}
      {!loading && (
      <div className="flex flex-col lg:flex-row gap-4">
        {/* Role selector — sidebar on desktop, dropdown on mobile */}
        <div className="lg:hidden">
          <button
            onClick={() => setRoleDropdownOpen(!roleDropdownOpen)}
            className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-black/[0.03] border border-black/[0.06] text-zinc-900 text-sm"
            style={{ background: "none", border: "1px solid rgba(17, 17, 24,0.06)", fontFamily: "inherit", cursor: "pointer" }}
          >
            <div className="flex items-center gap-2">
              <span className={`inline-block px-2 py-0.5 rounded-md text-xs font-medium border ${ROLE_COLORS[activeMatrix?.role.name || ""] || "bg-zinc-500/20 text-zinc-600 border-zinc-500/30"}`}>
                {activeMatrix?.role.name.replace(/_/g, " ")}
              </span>
            </div>
            <ChevronDown className={`w-4 h-4 text-zinc-600 transition-transform ${roleDropdownOpen ? "rotate-180" : ""}`} />
          </button>
          {roleDropdownOpen && (
            <div className="mt-1 rounded-xl border border-black/[0.06] bg-[#ffffff] overflow-hidden shadow-xl z-10 relative">
              {visibleMatrix.map((r) => (
                  <button
                    key={r.role.id}
                    onClick={() => { setActiveRole(r.role.id); setRoleDropdownOpen(false); }}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left text-sm hover:bg-black/5 transition-colors"
                  style={{ background: "none", border: "none", fontFamily: "inherit", cursor: "pointer" }}
                >
                  <span className={`inline-block px-2 py-0.5 rounded-md text-xs font-medium border ${ROLE_COLORS[r.role.name] || "bg-zinc-500/20 text-zinc-600 border-zinc-500/30"}`}>
                    {r.role.name.replace(/_/g, " ")}
                  </span>
                  {r.role.id === activeRole && <Check className="w-3.5 h-3.5 text-amber-400 ml-auto" />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Desktop role list */}
        <div className="hidden lg:flex flex-col gap-1 w-56 shrink-0">
          <div className="text-xs text-zinc-500 font-medium px-2 mb-1 uppercase tracking-wider">Roles</div>
            {visibleMatrix.map((r) => {
            const isActive = r.role.id === activeRole;
            const totalOn = r.modules.reduce((acc, m) =>
              acc + PERMISSION_FIELDS.filter((f) => m[f.key as keyof ModulePerm]).length, 0
            );
            const totalPossible = r.modules.length * PERMISSION_FIELDS.length;
            const pct = Math.round((totalOn / totalPossible) * 100);

            return (
              <button
                key={r.role.id}
                onClick={() => setActiveRole(r.role.id)}
                className={`w-full text-left px-3 py-3 rounded-xl transition-all border ${
                  isActive
                    ? "bg-amber-500/10 border-amber-500/20"
                    : "bg-black/[0.02] border-transparent hover:bg-black/[0.04]"
                }`}
                style={{ background: isActive ? undefined : "rgba(17, 17, 24,0.02)", fontFamily: "inherit", cursor: "pointer" }}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className={`text-xs font-medium ${isActive ? "text-amber-400" : "text-zinc-700"}`}>
                    {r.role.name.replace(/_/g, " ")}
                  </span>
                  <span className="text-[0.6rem] text-zinc-500">{pct}%</span>
                </div>
                <div className="w-full h-1 rounded-full bg-black/[0.06]">
                  <div
                    className="h-full rounded-full bg-amber-500/60 transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </button>
            );
          })}
        </div>

        {/* Permission grid */}
        <div className="flex-1 min-w-0">
          {/* Role header */}
          {activeMatrix && (
            <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
              <div className="flex items-center gap-3">
                <span className={`inline-block px-2.5 py-1 rounded-lg text-sm font-semibold border ${ROLE_COLORS[activeMatrix.role.name] || "bg-zinc-500/20 text-zinc-600 border-zinc-500/30"}`}>
                  {activeMatrix.role.name.replace(/_/g, " ")}
                </span>
                <span className="text-xs text-zinc-500">
                  {activeMatrix.modules.reduce((a, m) => a + PERMISSION_FIELDS.filter((f) => m[f.key as keyof ModulePerm]).length, 0)} / {activeMatrix.modules.length * PERMISSION_FIELDS.length} permissions enabled
                </span>
              </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="Search modules..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="px-3 py-1.5 text-xs rounded-lg bg-black/[0.04] border border-black/[0.08] text-zinc-700 placeholder-zinc-600 outline-none focus:border-amber-500/40 w-40"
                  />
                  {!isAdminRole && (
                    <button
                      onClick={() => {
                        const shouldEnable = !allOn(activeMatrix.modules);
                        activeMatrix.modules.forEach((m) => toggleAllModule(activeMatrix.role.id, m.module_name, shouldEnable));
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-black/[0.08] text-zinc-600 hover:text-zinc-900 hover:border-black/20 transition-all"
                      style={{ background: "rgba(17, 17, 24,0.03)", fontFamily: "inherit", cursor: "pointer" }}
                    >
                      {allOn(activeMatrix.modules) ? (
                        <><X className="w-3 h-3" /> Revoke All</>
                      ) : (
                        <><Check className="w-3 h-3" /> Grant All</>
                      )}
                    </button>
                  )}
                </div>
            </div>
          )}

          {/* Admin locked banner */}
          {isAdminRole && (
            <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-purple-500/10 border border-purple-500/20 mb-3">
              <Lock className="w-4 h-4 text-purple-400 shrink-0" />
              <span className="text-xs text-purple-400">Admin has full access to all modules and company data by default. Permissions cannot be modified.</span>
            </div>
          )}

          {/* Module permission cards */}
            <div className="space-y-2">
              {filteredModules.map((mod) => {
                const meta = MODULE_META[mod.module_name] || { label: mod.module_name, icon: Settings, color: "text-zinc-600" };
                const Icon = meta.icon;
                const allEnabled = PERMISSION_FIELDS.every((f) => mod[f.key as keyof ModulePerm]);
                const someEnabled = PERMISSION_FIELDS.some((f) => mod[f.key as keyof ModulePerm]);

                return (
                  <div
                    key={mod.module_name}
                    className={`rounded-xl border transition-all ${
                      someEnabled
                        ? "bg-black/[0.03] border-black/[0.08]"
                        : "bg-black/[0.01] border-black/[0.04]"
                    }`}
                  >
                    <div className="flex items-center gap-3 px-4 py-3">
                      {/* Module icon + name */}
                      <div className={`w-8 h-8 rounded-lg bg-black/[0.05] flex items-center justify-center shrink-0`}>
                        <Icon className={`w-4 h-4 ${meta.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-zinc-900">{meta.label}</span>
                          {!someEnabled && (
                            <span className="text-[0.6rem] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20">No Access</span>
                          )}
                          {someEnabled && !allEnabled && (
                            <span className="text-[0.6rem] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">Partial</span>
                          )}
                          {allEnabled && (
                            <span className="text-[0.6rem] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20">Full Access</span>
                          )}
                        </div>
                      </div>

                      {/* Quick toggle all */}
                      <button
                        onClick={() => !isAdminRole && toggleAllModule(mod.role_id, mod.module_name, !allEnabled)}
                        disabled={isAdminRole}
                        className={`shrink-0 w-10 h-5 rounded-full transition-all relative ${allEnabled ? "bg-amber-500" : "bg-black/10"} ${isAdminRole ? "opacity-60 cursor-not-allowed" : ""}`}
                        style={{ border: "none", cursor: isAdminRole ? "not-allowed" : "pointer" }}
                        title={isAdminRole ? "Admin permissions are locked" : allEnabled ? "Revoke all" : "Grant all"}
                      >
                        <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${allEnabled ? "left-[1.375rem]" : "left-0.5"}`} />
                      </button>
                    </div>

                    {/* Permission toggles + Scope */}
                    <div className="px-4 pb-3 flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex flex-wrap gap-2">
                        {PERMISSION_FIELDS.map((field) => {
                        const isOn = !!mod[field.key as keyof ModulePerm];
                        const isSaving = saving === `${mod.role_id}:${mod.module_name}:${field.key}`;
                        const FIcon = field.icon;

                      return (
                        <button
                          key={field.key}
                          onClick={() => !isAdminRole && toggle(mod.role_id, mod.module_name, field.key, isOn)}
                          disabled={isSaving || isAdminRole}
                          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                            isOn
                              ? `bg-black/[0.07] border-black/20 ${field.color}`
                              : "bg-black/[0.02] border-black/[0.05] text-zinc-600 hover:text-zinc-600 hover:border-black/10"
                          } ${isAdminRole ? "opacity-60 cursor-not-allowed" : ""}`}
                          style={{ cursor: isAdminRole ? "not-allowed" : "pointer", fontFamily: "inherit" }}
                        >
                          {isSaving ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <FIcon className="w-3 h-3" />
                          )}
                          {field.label}
                          {isOn && <Check className="w-2.5 h-2.5 ml-0.5" />}
                        </button>
                        );
                    })}
                      </div>

                    </div>
                  </div>
              );
            })}
            {filteredModules.length === 0 && (
              <div className="text-center py-12 text-zinc-600 text-sm">No modules match your search</div>
            )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
