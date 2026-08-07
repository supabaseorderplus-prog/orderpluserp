"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import {
  api,
  setActiveCompany,
  clearActiveCompany,
  persistAuthSessionToNative,
  restoreAuthSessionFromNative,
} from "@/lib/api";
import { showNativeLoginNotification } from "@/lib/native-notifications";
import {
  Building2,
  Briefcase,
  Download,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  Phone,
  Shield,
  Store,
  Truck,
  UserCog,
  Users,
  X,
} from "lucide-react";

type PortalGroup = "PARTY" | "STAFF" | "ADMIN";
type AdminTab = "ADMIN" | "SUPER_ADMIN";

type LoginResponse = {
  success: boolean;
  data?: {
    accessToken: string;
    refreshToken: string;
    user: {
      id: string;
      name: string;
      email: string;
      phone: string;
      role: string;
      role_id?: string | null;
      zoneId?: string | null;
      territoryId?: string | null;
      party_id?: string | null;
      party_name?: string | null;
    };
  };
  message?: string;
  hint?: string;
};

type AccountOption = {
  userId: string;
  email: string | null;
  phone?: string | null;
  role: string;
  partyId: string | null;
  partyName?: string; // the party's own name (e.g. the retailer's shop name)
  companyName: string; // the parent company / org the party belongs to
  companyCode?: string | null;
  name?: string;
};

type AccountsLookupResponse = {
  success: boolean;
  data?: {
    accounts: AccountOption[];
    multiple: boolean;
    totalCompanies?: number;
  };
  message?: string;
  hint?: string;
};

type GroupConfig = {
  label: string;
  description: string;
  accent: string;
  iconBg: string;
  icon: React.ElementType;
};

const GROUP_CONFIG: Record<PortalGroup, GroupConfig> = {
  PARTY: {
    label: "Party & Vendor Login",
    description: "Retailers · Super Dealers · CNF · Distributors — every vendor",
    accent: "from-amber-500 to-orange-600",
    iconBg: "bg-gradient-to-br from-amber-500 to-orange-600 text-white",
    icon: Store,
  },
  STAFF: {
    label: "Team Login",
    description: "Salesmen, managers & field staff",
    accent: "from-emerald-500 to-teal-600",
    iconBg: "bg-gradient-to-br from-emerald-500 to-teal-600 text-white",
    icon: Briefcase,
  },
  ADMIN: {
    label: "Administration",
    description: "Company admins & super admin",
    accent: "from-blue-500 to-indigo-600",
    iconBg: "bg-gradient-to-br from-blue-500 to-indigo-600 text-white",
    icon: Shield,
  },
};

// Friendly labels for the role badge shown in the account picker.
const ROLE_LABELS: Record<string, string> = {
  RETAILER_USER: "Retailer",
  RETAILER: "Retailer",
  SUPER_DEALER_USER: "Super Dealer",
  SUPER_DEALER: "Super Dealer",
  CNF_USER: "CNF / Distributor",
  CNF: "CNF / Distributor",
  ADMIN: "Admin",
  SUPER_ADMIN: "Super Admin",
  SALESMAN: "Salesman",
  DRIVER: "Driver",
  SALES_MANAGER: "Sales Manager",
  TERRITORY_MANAGER: "Territory Manager",
  WAREHOUSE_MANAGER: "Warehouse Manager",
  ACCOUNTS_MANAGER: "Accounts Manager",
  AUDITOR: "Auditor",
};

function roleLabel(role: string): string {
  const key = (role || "").toUpperCase();
  return (
    ROLE_LABELS[key] ||
    key
      .split("_")
      .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
      .join(" ")
  );
}

// Primary/secondary lines for an account row. When the party's own name differs
// from the company it belongs to, show the party name as the headline (with the
// person as subtitle); otherwise (party IS the company, e.g. staff) lead with the
// person's name. The company itself is always shown separately as the group header.
function partyLines(a: AccountOption): { primary: string; secondary: string } {
  const person = a.name || a.email?.split("@")[0] || "Account";
  const own = a.partyName?.trim() || "";
  if (own && own !== a.companyName) {
    return { primary: own, secondary: person };
  }
  return { primary: person, secondary: "" };
}

export default function LoginPage() {
  const router = useRouter();
  const [activeGroup, setActiveGroup] = useState<PortalGroup | null>(null);
  const [adminTab, setAdminTab] = useState<AdminTab>("ADMIN");
  const [isCapacitor, setIsCapacitor] = useState(false);

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [showAccountPicker, setShowAccountPicker] = useState(false);

  const showInvalidPassword = /invalid credentials|wrong password/i.test(error);

  useEffect(() => {
    setIsCapacitor(
      typeof window !== "undefined" &&
        (window.navigator.userAgent.includes("Capacitor") ||
          !!(window as unknown as Record<string, unknown>).Capacitor)
    );
  }, []);

  useEffect(() => {
    const continueSavedSession = () => {
      if (restoreAuthSessionFromNative()) router.replace("/dashboard");
    };
    continueSavedSession();
    window.addEventListener("hometech:native-auth-restored", continueSavedSession);
    return () => window.removeEventListener("hometech:native-auth-restored", continueSavedSession);
  }, [router]);

  const config = activeGroup ? GROUP_CONFIG[activeGroup] : null;
  // Super Admin authenticates by email; everyone else by mobile number.
  const isEmailMode = activeGroup === "ADMIN" && adminTab === "SUPER_ADMIN";
  const lookupGroup = activeGroup === "ADMIN" ? "ADMIN" : activeGroup;

  function resetFields() {
    setIdentifier("");
    setPassword("");
    setShowPassword(false);
    setError("");
    setHint("");
    setAccounts([]);
    setSelectedAccountId("");
    setShowAccountPicker(false);
  }

  function openGroup(group: PortalGroup) {
    setActiveGroup(group);
    setAdminTab("ADMIN");
    resetFields();
  }

  function closeGroup() {
    setActiveGroup(null);
    resetFields();
  }

  function switchAdminTab(tab: AdminTab) {
    if (tab === adminTab) return;
    setAdminTab(tab);
    resetFields();
  }

  async function handleLoginSuccess(res: LoginResponse) {
    const user = res.data!.user;
    localStorage.setItem("accessToken", res.data!.accessToken);
    localStorage.setItem("refreshToken", res.data!.refreshToken);
    localStorage.setItem("user", JSON.stringify(user));
    await showNativeLoginNotification(user.name || user.email || "your account");

    if (user.role === "SUPER_ADMIN") {
      // Clear any stale company so the company list always shows first
      clearActiveCompany();
      persistAuthSessionToNative();
      router.push("/dashboard");
      return;
    }

    if (user.party_id && user.party_name) {
      setActiveCompany(user.party_id, user.party_name);
    }
    persistAuthSessionToNative();
    // The dashboard layout self-routes salesman/driver to their own screens.
    router.push("/dashboard");
  }

  async function loginWithEmail() {
    setLoading(true);
    try {
      const res = await api<LoginResponse>("/api/v1/auth/login", {
        method: "POST",
        body: { email: identifier.trim(), password, role: "SUPER_ADMIN" },
      });
      if (!res.success) throw new Error(res.message || "Login failed");
      await handleLoginSuccess(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  async function lookupAccounts() {
    const value = identifier.trim();
    if (!value) {
      setError("Please enter your mobile number");
      return;
    }
    setLoading(true);
    setError("");
    setHint("");
    try {
      const res = await api<AccountsLookupResponse>(
        `/api/v1/auth/companies?phone=${encodeURIComponent(value)}&group=${lookupGroup}`
      );
      if (!res.success || !res.data) {
        setError(res.message || "No account found with this mobile number");
        if (res.hint) setHint(res.hint);
        return;
      }
      const list = res.data.accounts || [];
      setAccounts(list);
      if (list.length === 1) {
        setSelectedAccountId(list[0].userId);
      } else if (list.length > 1) {
        setShowAccountPicker(true);
      } else {
        setError("No account found with this mobile number");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setLoading(false);
    }
  }

  async function loginWithAccount() {
    if (!password) {
      setError("Please enter your password");
      return;
    }
    const selected = accounts.find((a) => a.userId === selectedAccountId);
    setLoading(true);
    try {
      const res = await api<LoginResponse>("/api/v1/auth/login", {
        method: "POST",
        body: {
          password,
          userId: selectedAccountId,
          phone: identifier.trim(),
          role: selected?.role || "",
        },
      });
      if (!res.success) throw new Error(res.message || "Login failed");
      await handleLoginSuccess(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!activeGroup) return;
    setError("");

    if (isEmailMode) {
      await loginWithEmail();
      return;
    }
    // Phone mode: step 1 look up accounts, step 2 authenticate the chosen account
    if (!selectedAccountId) {
      await lookupAccounts();
      return;
    }
    await loginWithAccount();
  }

  const selectedAccount = accounts.find((a) => a.userId === selectedAccountId) || null;
  const showPasswordField = isEmailMode || !!selectedAccountId;
  const identifierLabel = isEmailMode ? "Email Address" : "Mobile Number";
  const identifierPlaceholder = isEmailMode
    ? "Enter registered email address"
    : "Enter registered mobile number";
  const submitDisabled =
    loading ||
    (!isEmailMode && !identifier.trim() && !selectedAccountId) ||
    (showAccountPicker && !selectedAccountId);

  // Group accounts by company so multi-company phones read clearly.
  const accountsByCompany = accounts.reduce<Record<string, AccountOption[]>>((acc, account) => {
    const key = account.companyName || "No Company";
    (acc[key] ||= []).push(account);
    return acc;
  }, {});

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#fefce8] px-4 py-10">
      <div className="absolute inset-0">
        <div className="absolute left-1/4 top-1/4 h-96 w-96 rounded-full bg-yellow-300/20 blur-[120px]" />
        <div className="absolute bottom-1/4 right-1/4 h-96 w-96 rounded-full bg-amber-200/20 blur-[120px]" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(17,17,24,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(17,17,24,0.02)_1px,transparent_1px)] bg-[size:64px_64px]" />
      </div>

      <div className="relative z-10 w-full max-w-2xl">
        <div className="mb-8 text-center">
          <div className="mb-5 flex justify-center">
            <Image
              src="/order-plus-logo.png"
              alt="Order Plus ERP logo"
              width={480}
              height={320}
              className="h-auto w-64 max-w-full rounded-2xl shadow-2xl shadow-orange-500/30 sm:w-80"
              priority
            />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-5xl">Order Plus ERP</h1>
          <p className="mt-3 text-sm text-zinc-500">Welcome back — choose how you want to sign in.</p>
        </div>

        {/* Hero: Party & Vendor login — the primary, eye-catching entry */}
        <button
          type="button"
          onClick={() => openGroup("PARTY")}
          className="group relative w-full overflow-hidden rounded-[2rem] border border-amber-300/70 bg-gradient-to-br from-amber-400 via-orange-500 to-orange-600 p-7 text-left shadow-2xl shadow-orange-500/30 transition-all hover:-translate-y-0.5 hover:shadow-orange-500/50 sm:p-9"
        >
          <div className="pointer-events-none absolute -right-10 -top-10 h-48 w-48 rounded-full bg-white/20 blur-2xl" />
          <div className="pointer-events-none absolute -bottom-12 left-1/3 h-40 w-40 rounded-full bg-amber-200/30 blur-2xl" />
          <div className="relative">
            <div className="mb-5 flex items-center gap-2">
              {[Store, Users, Truck].map((Icon, i) => (
                <span
                  key={i}
                  className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/20 text-white ring-1 ring-white/30 backdrop-blur-sm"
                >
                  <Icon className="h-5 w-5" />
                </span>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-white/25 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white ring-1 ring-white/30">
                Parties & Vendors
              </span>
            </div>
            <h2 className="mt-3 text-2xl font-bold tracking-tight text-white sm:text-3xl">
              Retailer, Dealer, CNF &amp; Vendor Login
            </h2>
            <p className="mt-2 max-w-lg text-sm text-white/90 sm:text-base">
              Enter your mobile number to see every account registered to it, then pick your company and sign in.
            </p>
            <span className="mt-6 inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-orange-600 shadow-lg transition-transform group-hover:translate-x-0.5">
              <Phone className="h-4 w-4" />
              Continue with mobile number
              <span aria-hidden>→</span>
            </span>
          </div>
        </button>

        {/* Secondary: subdued Team & Admin entries */}
        <div className="mt-5">
          <p className="mb-2 text-center text-xs font-medium uppercase tracking-wider text-zinc-400">
            For staff &amp; administrators
          </p>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => openGroup("STAFF")}
              className="flex items-center gap-3 rounded-2xl border border-amber-200/60 bg-white/60 px-4 py-3 text-left transition-all hover:border-emerald-300 hover:bg-white"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600">
                <Briefcase className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-zinc-800">Team Login</span>
                <span className="block truncate text-xs text-zinc-500">Salesmen &amp; managers</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => openGroup("ADMIN")}
              className="flex items-center gap-3 rounded-2xl border border-amber-200/60 bg-white/60 px-4 py-3 text-left transition-all hover:border-blue-300 hover:bg-white"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600">
                <Shield className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-zinc-800">Admin</span>
                <span className="block truncate text-xs text-zinc-500">Admin &amp; super admin</span>
              </span>
            </button>
          </div>
        </div>

        {!isCapacitor && (
          <div className="mt-6 flex justify-center">
            <a
              href="/api/v1/app/download?v=2"
              className="inline-flex items-center gap-2 rounded-xl border border-amber-300 bg-gradient-to-r from-amber-400 to-orange-500 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-amber-200/40 transition-all hover:from-amber-500 hover:to-orange-600 hover:shadow-amber-300/50"
            >
              <Download className="h-4 w-4" />
              Download Android App
            </a>
          </div>
        )}
      </div>

      {activeGroup && config && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-[2rem] border border-amber-200/50 bg-yellow-50/95 p-6 shadow-2xl shadow-amber-200/20 sm:p-8">
            <div className="mb-6 flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className={`flex h-14 w-14 items-center justify-center rounded-2xl ${config.iconBg}`}>
                  <config.icon className="h-6 w-6" />
                </div>
                <div>
                  <div className="text-xl font-semibold text-zinc-900">{config.label}</div>
                  <div className="text-sm text-zinc-500">{config.description}</div>
                </div>
              </div>
              <button
                type="button"
                onClick={closeGroup}
                className="rounded-xl border border-black/10 p-2 text-zinc-500 transition-colors hover:bg-black/[0.03] hover:text-zinc-900"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Admin group: Admin / Super Admin tabs */}
            {activeGroup === "ADMIN" && (
              <div className="mb-5 grid grid-cols-2 gap-2 rounded-2xl border border-black/10 bg-black/[0.03] p-1">
                {(["ADMIN", "SUPER_ADMIN"] as AdminTab[]).map((tab) => {
                  const TabIcon = tab === "ADMIN" ? UserCog : Shield;
                  const isActive = adminTab === tab;
                  return (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => switchAdminTab(tab)}
                      className={`flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition-all ${
                        isActive
                          ? "bg-white text-zinc-900 shadow-sm"
                          : "text-zinc-500 hover:text-zinc-800"
                      }`}
                    >
                      <TabIcon className="h-4 w-4" />
                      {tab === "ADMIN" ? "Admin" : "Super Admin"}
                    </button>
                  );
                })}
              </div>
            )}

            {error && (
              <div className="mb-4 whitespace-pre-line rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-500">
                {error}
                {hint && <div className="mt-1 text-xs text-red-400">{hint}</div>}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="mb-2 block text-sm font-medium text-zinc-700">{identifierLabel}</label>
                <div className="relative">
                  {isEmailMode ? (
                    <Mail className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-zinc-500" />
                  ) : (
                    <Phone className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-zinc-500" />
                  )}
                  <input
                    type={isEmailMode ? "email" : "tel"}
                    value={identifier}
                    onChange={(e) => {
                      setIdentifier(e.target.value);
                      setAccounts([]);
                      setSelectedAccountId("");
                      setShowAccountPicker(false);
                      if (error) setError("");
                    }}
                    placeholder={identifierPlaceholder}
                    required
                    disabled={!!selectedAccountId}
                    className="w-full rounded-xl border border-black/10 bg-black/[0.03] py-3 pl-11 pr-4 text-zinc-900 placeholder-zinc-400 outline-none transition-all focus:border-yellow-400/60 focus:ring-1 focus:ring-yellow-400/40 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </div>
              </div>

              {showAccountPicker && accounts.length > 1 && !selectedAccountId && (
                <div>
                  <label className="mb-2 block text-sm font-medium text-zinc-700">
                    Select your account ({accounts.length} found)
                  </label>
                  <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
                    {Object.entries(accountsByCompany).map(([companyName, companyAccounts]) => (
                      <div key={companyName}>
                        <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                          <Building2 className="h-3.5 w-3.5 text-amber-500" />
                          {companyName}
                        </div>
                        <div className="space-y-2">
                          {companyAccounts.map((account) => {
                            const lines = partyLines(account);
                            return (
                              <button
                                key={account.userId}
                                type="button"
                                onClick={() => {
                                  setSelectedAccountId(account.userId);
                                  setShowAccountPicker(false);
                                }}
                                className="flex w-full items-center gap-3 rounded-xl border border-black/10 bg-black/[0.03] p-3 text-left transition-all hover:border-yellow-300 hover:bg-yellow-50"
                              >
                                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-black/10 text-sm font-bold text-zinc-600">
                                  {(lines.primary || "?").charAt(0).toUpperCase()}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-sm font-medium text-zinc-900">
                                    {lines.primary}
                                  </div>
                                  <div className="truncate text-xs text-zinc-500">
                                    {lines.secondary || account.companyName}
                                  </div>
                                </div>
                                <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                                  {roleLabel(account.role)}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-zinc-500">
                    Multiple accounts are registered to this mobile number. Choose one to continue.
                  </p>
                </div>
              )}

              {showPasswordField && (
                <>
                  {selectedAccount && (
                    <div className="flex items-center justify-between rounded-xl border border-green-500/30 bg-green-500/10 p-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-green-500/20">
                          <Building2 className="h-5 w-5 text-green-600" />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-zinc-900">
                            {partyLines(selectedAccount).primary}
                          </div>
                          <div className="truncate text-xs text-zinc-500">
                            {selectedAccount.companyName} · {roleLabel(selectedAccount.role)}
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedAccountId("");
                          setPassword("");
                          if (accounts.length > 1) setShowAccountPicker(true);
                        }}
                        className="shrink-0 text-xs text-zinc-500 underline hover:text-zinc-700"
                      >
                        Change
                      </button>
                    </div>
                  )}

                  <div>
                    <label className="mb-2 block text-sm font-medium text-zinc-700">Password</label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-zinc-500" />
                      <input
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(e) => {
                          setPassword(e.target.value);
                          if (error) setError("");
                        }}
                        aria-invalid={showInvalidPassword}
                        placeholder="Enter your password"
                        required
                        autoFocus
                        className={`w-full rounded-xl border bg-black/[0.03] py-3 pl-11 pr-12 text-zinc-900 placeholder-zinc-400 outline-none transition-all focus:ring-1 ${
                          showInvalidPassword
                            ? "border-red-500/60 focus:border-red-500/70 focus:ring-red-500/40"
                            : "border-black/10 focus:border-yellow-400/60 focus:ring-yellow-400/40"
                        }`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((prev) => !prev)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 transition-colors hover:text-zinc-700"
                      >
                        {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                      </button>
                    </div>
                    {showInvalidPassword && (
                      <p className="mt-2 text-sm text-red-500">Wrong password. Please try again.</p>
                    )}
                  </div>
                </>
              )}

              <button
                type="submit"
                disabled={submitDisabled}
                className={`flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r px-4 py-3 font-semibold text-white transition-all disabled:cursor-not-allowed disabled:opacity-50 ${config.accent}`}
              >
                {loading ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    Processing...
                  </>
                ) : showPasswordField ? (
                  "Sign In"
                ) : (
                  "Continue"
                )}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
