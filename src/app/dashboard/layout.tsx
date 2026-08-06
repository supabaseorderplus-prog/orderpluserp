"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { api, getUser, isLoggedIn, logout, getActiveCompany, clearActiveCompany } from "@/lib/api";
import { useVisibleInterval } from "@/lib/hooks/use-visible-interval";
import { SalesmanGpsGuardian } from "@/components/SalesmanGpsGuardian";
import { AdminGpsNotificationListener } from "@/components/AdminGpsNotificationListener";
import type { LucideIcon } from "lucide-react";
import {
    AlertTriangle,
    BarChart3,
    Box,
    Building2,
    ChevronDown,
    ChevronLeft,
    Coins,
    FileBarChart2,
    FileText,
    LayoutGrid,
    Layers,
    ClipboardList,
    CreditCard,
    Wallet,
    Gift,
    LayoutDashboard,
    Lock,
    LogOut,
    Menu,
    MessageCircle,
    Navigation,
    Network,
    Package,
    Percent,
    Settings,
    Shield,
    ShoppingCart,
    Tag,
    Truck,
    Trophy,
    Users,
    Radar,
    ReceiptIndianRupee,
    Warehouse,
    X,
  } from "lucide-react";

type SidebarItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  module: string;
  exact?: boolean;
};

type SidebarSection = {
  label?: string;
  icon?: LucideIcon;
  items: SidebarItem[];
};

const SIDEBAR_SECTIONS: SidebarSection[] = [
  {
    items: [
      { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, module: "dashboard" },
      { label: "My Dashboard", href: "/dashboard/salesman", icon: LayoutDashboard, module: "salesman_home" },
    ],
  },
  {
    label: "Sales",
    icon: ShoppingCart,
    items: [
      { label: "Orders", href: "/dashboard/invoices/new", icon: ClipboardList, module: "invoices" },
      { label: "Invoices", href: "/dashboard/invoices", icon: FileText, module: "invoices", exact: true },
      { label: "Delivery Lots", href: "/dashboard/delivery-lots", icon: Box, module: "delivery_lots" },
      { label: "Procurement", href: "/dashboard/procurement", icon: ShoppingCart, module: "procurement" },
      { label: "Reconcile", href: "/dashboard/payments/reconcile", icon: Navigation, module: "reconcile" },
      { label: "Driver Duty", href: "/dashboard/driver-duty", icon: Truck, module: "driver_duty" },
    ],
  },
  {
    label: "Customers",
    icon: Users,
    items: [
      { label: "Parties", href: "/dashboard/parties", icon: Building2, module: "parties" },
    ],
  },
  {
    label: "Vendors",
    icon: Truck,
    items: [
      { label: "Vendors", href: "/dashboard/vendors", icon: Truck, module: "parties" },
    ],
  },
  {
    label: "Products & Inventory",
    icon: Package,
    items: [
      { label: "Products", href: "/dashboard/products", icon: Package, module: "products" },
      { label: "Pricing", href: "/dashboard/pricing", icon: Tag, module: "pricing" },
      { label: "Stock Ledger", href: "/dashboard/bom-inventory", icon: Warehouse, module: "bom_inventory" },
      { label: "Tax Settings", href: "/dashboard/tax-settings", icon: Percent, module: "tax_settings" },
    ],
  },
  {
    label: "Finance & Accounts",
    icon: Wallet,
    items: [
      { label: "Financials", href: "/dashboard/payments", icon: CreditCard, module: "payments" },
      { label: "Wallets & Finances", href: "/dashboard/wallets", icon: Wallet, module: "wallets" },
      { label: "Expense Approvals", href: "/dashboard/expenses", icon: ReceiptIndianRupee, module: "expenses" },
    ],
  },
  {
    label: "Schemes & Rewards",
    icon: Gift,
    items: [
      { label: "Schemes", href: "/dashboard/schemes", icon: Gift, module: "schemes", exact: true },
      { label: "Token Rewards", href: "/dashboard/schemes/tokens", icon: Coins, module: "schemes" },
      { label: "Rankings", href: "/dashboard/rankings", icon: Trophy, module: "rankings" },
    ],
  },
  {
    label: "Distribution Network",
    icon: Network,
    items: [
      { label: "Groups", href: "/dashboard/groups", icon: Layers, module: "groups" },
      { label: "Routes", href: "/dashboard/routes", icon: Navigation, module: "routes" },
      { label: "Downline", href: "/dashboard/downline", icon: Network, module: "downline" },
      { label: "Tracking", href: "/dashboard/tracking", icon: Radar, module: "tracking" },
    ],
  },
  {
    label: "Reports & Analytics",
    icon: BarChart3,
    items: [
      { label: "Analytics", href: "/dashboard/analytics", icon: BarChart3, module: "analytics" },
      { label: "Reports", href: "/dashboard/reports", icon: FileBarChart2, module: "reports" },
      { label: "Exports", href: "/dashboard/exports", icon: Box, module: "exports" },
    ],
  },
  {
    label: "Administration",
    icon: Settings,
    items: [
      { label: "Users", href: "/dashboard/users", icon: Users, module: "users" },
      { label: "Security", href: "/dashboard/security", icon: Shield, module: "security" },
      { label: "Control Panel", href: "/dashboard/control-panel", icon: Settings, module: "control_panel" },
      { label: "Support Chat", href: "/dashboard/support", icon: MessageCircle, module: "support_chat" },
    ],
  },
];

const ALL_SIDEBAR_ITEMS = SIDEBAR_SECTIONS.flatMap((section) => section.items);
const DEFAULT_COLLAPSED_SIDEBAR_SECTIONS = SIDEBAR_SECTIONS.flatMap((section) =>
  section.label ? [section.label] : []
);

// Bottom nav shows first 4 most-used items on mobile
const bottomNavItems = [
  { label: "Home",     href: "/dashboard",              icon: LayoutDashboard, module: "dashboard" },
  { label: "Parties",  href: "/dashboard/parties",      icon: Building2,       module: "parties"   },
  { label: "Orders",   href: "/dashboard/invoices/new", icon: ClipboardList,   module: "invoices"  },
  { label: "Products", href: "/dashboard/products",     icon: Package,         module: "products"  },
];

function matchesSidebarPath(pathname: string, item: SidebarItem) {
  if (pathname === item.href) return true;
  return !item.exact && item.href !== "/dashboard" && pathname.startsWith(`${item.href}/`);
}

function activeSidebarHref(pathname: string, sections: SidebarSection[]) {
  return sections
    .flatMap((section) => section.items)
    .filter((item) => matchesSidebarPath(pathname, item))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

type SidebarNavigationProps = {
  sections: SidebarSection[];
  pathname: string;
  collapsed?: boolean;
  supportUnread: number;
  expenseBadge: number;
  collapsedSections: Set<string>;
  onToggleSection: (section: string) => void;
  onDashboardClick: (event: React.MouseEvent) => void;
};

export function SidebarNavigation({
  sections,
  pathname,
  collapsed = false,
  supportUnread,
  expenseBadge,
  collapsedSections,
  onToggleSection,
  onDashboardClick,
}: SidebarNavigationProps) {
  const activeHref = activeSidebarHref(pathname, sections);

  return (
    <nav
      aria-label="Dashboard navigation"
      className={`flex-1 overflow-y-auto px-3 [font-family:'Avenir_Next','Inter',system-ui,sans-serif] ${collapsed ? "py-3" : "py-3"}`}
    >
      {sections.map((section, sectionIndex) => {
        const SectionIcon = section.icon;
        const isSectionOpen = !section.label || !collapsedSections.has(section.label);
        return (
          <div
            key={section.label || "primary"}
            className={sectionIndex === 0 ? "" : collapsed ? "mt-2 border-t border-black/[0.06] pt-2" : "mt-1"}
          >
            {section.label && (
              <button
                type="button"
                onClick={() => onToggleSection(section.label!)}
                aria-expanded={isSectionOpen}
                aria-label={`${isSectionOpen ? "Collapse" : "Expand"} ${section.label}`}
                title={collapsed ? section.label : undefined}
                className={`relative flex w-full items-center rounded-lg font-extrabold uppercase text-zinc-500 transition-colors hover:bg-amber-500/[0.05] hover:text-amber-700 ${
                  collapsed
                    ? "justify-center p-2"
                    : "gap-2 bg-transparent px-3 pb-1.5 pt-2.5 text-[0.64rem] tracking-[0.1em]"
                }`}
                style={{ border: "none", cursor: "pointer", fontFamily: "inherit" }}
              >
                {SectionIcon && <SectionIcon className="h-3.5 w-3.5 text-amber-500/80" aria-hidden="true" />}
                {!collapsed && <span className="min-w-0 flex-1 truncate text-left">{section.label}</span>}
                <ChevronDown
                  className={`text-zinc-400 transition-transform duration-200 ${
                    collapsed ? "absolute bottom-0.5 right-0.5 h-2.5 w-2.5" : "h-3.5 w-3.5"
                  } ${isSectionOpen ? "" : "-rotate-90"}`}
                  aria-hidden="true"
                />
              </button>
            )}
            {isSectionOpen && <div className="space-y-0.5">
              {section.items.map((item) => {
                const isActive = activeHref === item.href;
                const Icon = item.icon;
                const badge = item.module === "support_chat"
                  ? supportUnread
                  : item.module === "expenses"
                    ? expenseBadge
                    : 0;
                return (
                  <Link
                    key={`${section.label || "primary"}-${item.href}`}
                    href={item.href}
                    title={collapsed ? item.label : undefined}
                    aria-current={isActive ? "page" : undefined}
                    onClick={item.href === "/dashboard" ? onDashboardClick : undefined}
                    className={`relative flex items-center rounded-lg text-[0.86rem] tracking-[-0.01em] transition-all duration-200 ${
                      collapsed ? "justify-center px-3 py-2.5" : `gap-3 px-3 ${section.label ? "py-2" : "py-2.5"}`
                    } ${
                      isActive
                        ? "bg-gradient-to-r from-amber-500/15 to-amber-500/[0.04] font-bold text-amber-600 shadow-[inset_3px_0_0_#f59e0b]"
                        : "font-semibold text-zinc-600 hover:translate-x-0.5 hover:bg-black/5 hover:text-zinc-950"
                    }`}
                  >
                    <Icon className={`shrink-0 ${section.label && !collapsed ? "h-[18px] w-[18px]" : "h-5 w-5"}`} aria-hidden="true" />
                    {!collapsed && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
                    {badge > 0 && (
                      collapsed
                        ? <span className={`absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white ${item.module === "expenses" ? "bg-rose-500" : "bg-amber-500"}`} />
                        : <span className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-bold ${item.module === "expenses" ? "bg-rose-500 text-white" : "bg-amber-500 text-zinc-950"}`}>{badge > 99 ? "99+" : badge}</span>
                    )}
                  </Link>
                );
              })}
            </div>}
          </div>
        );
      })}
    </nav>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsedSidebarSections, setCollapsedSidebarSections] = useState<Set<string>>(
    () => new Set(DEFAULT_COLLAPSED_SIDEBAR_SECTIONS)
  );
  const [user, setUser] = useState<{ name: string; email: string; role: string; role_id?: string; party_id?: string } | null>(null);
  const [allowedModules, setAllowedModules] = useState<Set<string> | "ALL" | "LOADING">("LOADING");
  const [activeCompany, setActiveCompanyState] = useState<{ id: string; name: string } | null>(null);
  const [subscriptionBlocked, setSubscriptionBlocked] = useState(false);
  const [subscriptionChecked, setSubscriptionChecked] = useState(false);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [supportUnread, setSupportUnread] = useState(0);
  const [expenseBadge, setExpenseBadge] = useState(0);

  // Some embedded browsers block clipboard access even on user actions.
  // Prevent that specific permission error from bubbling into the dev error overlay.
  useEffect(() => {
    const isClipboardPermissionError = (err: unknown) => {
      if (!err) return false;
      const e = err as { name?: string; message?: string };
      const message = String(e.message || "");
      return e.name === "NotAllowedError" && message.includes("writeText") && message.toLowerCase().includes("clipboard");
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (isClipboardPermissionError(event.reason)) {
        event.preventDefault();
      }
    };

    const onWindowError = (event: ErrorEvent) => {
      if (isClipboardPermissionError(event.error)) {
        event.preventDefault();
      }
    };

    window.addEventListener("unhandledrejection", onUnhandledRejection);
    window.addEventListener("error", onWindowError);
    return () => {
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      window.removeEventListener("error", onWindowError);
    };
  }, []);

    // Sync activeCompany from localStorage (updated by dashboard page).
    // getActiveCompany() ALWAYS returns an object ({ id: null, name: null } when
    // nothing is selected), so store it as-is and `!activeCompany` is never true
    // — the super-admin sidebar and company banner then render on the company
    // list before any company is entered. Normalise the empty case to null.
    useEffect(() => {
      const sync = () => {
        const c = getActiveCompany();
        setActiveCompanyState(c.id ? { id: c.id, name: c.name ?? "" } : null);
      };
      sync();
      window.addEventListener("activeCompanyChanged", sync);
      return () => window.removeEventListener("activeCompanyChanged", sync);
    }, []);

  useEffect(() => {
    if (!isLoggedIn()) {
      router.push("/login");
      return;
    }
    const u = getUser();
    setUser(u);

    // Redirect salesman to their own dashboard — but DON'T return. This effect
    // runs once (deps: [router]); returning here on the initial `/dashboard`
    // landing skipped the permissions fetch below, and since `pathname` isn't a
    // dep the effect never re-ran after the redirect — leaving allowedModules
    // stuck on "LOADING" so the salesman sidebar came up empty. Fall through to
    // the fetch so their modules load.
    if (u?.role === "SALESMAN" && pathname === "/dashboard") {
      router.replace("/dashboard/salesman");
    }
    // Redirect driver to driver duty page (same fall-through reasoning)
    if (u?.role === "DRIVER" && pathname === "/dashboard") {
      router.replace("/dashboard/driver-duty");
    }

    // SUPER_ADMIN and ADMIN see everything — no fetch needed (also covers the
    // super-admin company-list home screen).
    if (u?.role === "SUPER_ADMIN" || u?.role === "ADMIN") {
      setAllowedModules("ALL");
      return;
    }

    // Fetch this user's permissions — use role_id if available, fall back to role name
    const params = new URLSearchParams();
    if (u?.role_id) params.set("role_id", u.role_id);
    else if (u?.role) params.set("role_name", u.role);
    else { setAllowedModules(new Set()); return; }

    // Pass company_id if user has an active company
    if (activeCompany?.id) params.set("company_id", activeCompany.id);

    fetch(`/api/v1/permissions/me?${params}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success) {
          const allowed = new Set<string>(
            (json.data as { module: string; can_view: boolean }[])
              .filter((p) => p.can_view)
              .map((p) => p.module)
          );
          setAllowedModules(allowed);
        } else {
          setAllowedModules(new Set());
        }
      })
      .catch(() => setAllowedModules(new Set()));
  }, [router]);

  // ── Subscription gate: block users without an active subscription ──
  useEffect(() => {
    if (!user) return;
    // Only SUPER_ADMIN is exempt from subscription check
    if (user.role === "SUPER_ADMIN") {
      setSubscriptionChecked(true);
      setSubscriptionBlocked(false);
      return;
    }
    const companyId = activeCompany?.id || user.party_id;
    if (!companyId) {
      setSubscriptionChecked(true);
      return;
    }
    const token = typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;
    fetch(`/api/v1/companies/subscriptions?company_id=${companyId}`, {
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "x-company-id": companyId,
      },
    })
      .then(r => r.json())
      .then(json => {
        const subs = json.data || [];
        const today = new Date().toISOString().split("T")[0];
        const hasActive = subs.some((s: { status: string; expires_at: string | null }) =>
          s.status === "ACTIVE" && (!s.expires_at || s.expires_at >= today)
        );
        setSubscriptionBlocked(!hasActive);
      })
      .catch(() => {
        // If we can't fetch, don't block (fail open for network issues)
        setSubscriptionBlocked(false);
      })
      .finally(() => setSubscriptionChecked(true));
  }, [user, activeCompany]);

  // Read the same server-computed wallet used by the Wallets board. This includes
  // transfers and pending/approved expense reservations, keeping every wallet
  // surface reconciled after approvals, partial refunds, and rejections.
  const isSalesmanUser = user?.role === "SALESMAN";

  const refreshWalletBalance = useCallback(async () => {
    if (!user || user.role !== "SALESMAN") return;
    try {
      const result = await api<{ data?: Array<{ user_id: string; user_name: string; balance: number }> }>("/api/v1/wallets", { noCache: true, suppressErrorLog: true });
      const own = (result.data || []).find((wallet) => wallet.user_id === (user as { id?: string }).id)
        || (result.data || []).find((wallet) => wallet.user_name === user.name);
      if (own) setWalletBalance(Number(own.balance) || 0);
    } catch {
      /* surfaced on next interval/event refresh */
    }
  }, [user]);

  useEffect(() => {
    if (!isSalesmanUser) return;
    void refreshWalletBalance();
    const handler = () => { void refreshWalletBalance(); };
    window.addEventListener("walletBalanceChanged", handler);
    window.addEventListener("expenseChanged", handler);
    window.addEventListener("paymentRecorded", handler);
    return () => {
      window.removeEventListener("walletBalanceChanged", handler);
      window.removeEventListener("expenseChanged", handler);
      window.removeEventListener("paymentRecorded", handler);
    };
  }, [isSalesmanUser, refreshWalletBalance]);

  // This poll runs on every dashboard page for every salesman, so it is a real
  // egress line item. Every path that moves the balance already fires
  // walletBalanceChanged / expenseChanged / paymentRecorded, so the timer is only
  // a safety net — a minute of staleness on a sidebar figure is fine.
  useVisibleInterval(refreshWalletBalance, isSalesmanUser ? 60_000 : 0);

  const isSuperAdmin = allowedModules === "ALL";
  const permissionsLoaded = allowedModules !== "LOADING";
  // Hide sidebar ONLY when super admin is on the company list (no company selected yet)
  const isSuperAdminHome = isSuperAdmin && pathname === "/dashboard" && !activeCompany;

  const isSalesman = user?.role === "SALESMAN";
  const isDriver = user?.role === "DRIVER";
  const supportBlockedRoles = new Set(["SALESMAN", "DRIVER", "SALES_MANAGER", "TERRITORY_MANAGER", "WAREHOUSE_MANAGER", "ACCOUNTS_MANAGER", "AUDITOR"]);
  const canUseSupport = !!user && (user.role === "ADMIN" || user.role === "SUPER_ADMIN" || !supportBlockedRoles.has(user.role));

  const canView = (module: string) => {
    if (module === "support_chat") return canUseSupport;
    if (module === "salesman_home") return isSalesman;
    if (module === "driver_duty") return isDriver;
    // Rankings is a universal feature — every party user, salesman and admin
    // can see their own leaderboard. Drivers are duty-only.
    if (module === "rankings") return !isDriver;
    if (module === "expenses") return !!user && ["SALESMAN", "ACCOUNTS_MANAGER", "ADMIN", "SUPER_ADMIN"].includes(user.role);
    // "Wallets & Finances" has no grantable `wallets` permission of its own
    // (it isn't in the control-panel matrix / permissions table). Gate it on the
    // Financials (`payments`) permission so finance roles like ACCOUNTS_MANAGER
    // can open it — otherwise the item is hidden and /dashboard/wallets 403s.
    if (module === "wallets") return !isDriver && !isSalesman && (isSuperAdmin || (allowedModules instanceof Set && (allowedModules.has("wallets") || allowedModules.has("payments"))));
    if (module === "bom_inventory") return !isDriver && !isSalesman && (isSuperAdmin || (allowedModules instanceof Set && allowedModules.has(module)));
    if (module === "tax_settings") return !isDriver && !isSalesman && (isSuperAdmin || (allowedModules instanceof Set && allowedModules.has(module)));
    if (module === "van_tracking") return !isDriver && (isSuperAdmin || (allowedModules instanceof Set && allowedModules.has(module)));
    if (module === "dashboard") return !isSalesman && !isDriver && (isSuperAdmin || (allowedModules instanceof Set && allowedModules.has(module)));
    if (isDriver) return false; // drivers only see driver_duty
    return isSuperAdmin || (allowedModules instanceof Set && allowedModules.has(module));
  };

  const supportPollActive = !!user && canUseSupport && !(user.role === "SUPER_ADMIN" && !activeCompany?.id);

  const refreshSupportUnread = useCallback(() => {
    if (!supportPollActive) return;
    void api<{ summary?: { unread?: number } }>("/api/v1/support/conversations", { noCache: true, suppressErrorLog: true })
      .then((result) => setSupportUnread(Number(result.summary?.unread || 0)))
      .catch(() => { /* migration may not be applied yet */ });
  }, [supportPollActive]);

  useEffect(() => {
    if (!supportPollActive) {
      setSupportUnread(0);
      return;
    }
    refreshSupportUnread();
    window.addEventListener("supportUnreadChanged", refreshSupportUnread);
    return () => {
      window.removeEventListener("supportUnreadChanged", refreshSupportUnread);
    };
  }, [supportPollActive, refreshSupportUnread, activeCompany?.id]);

  // 15s -> 60s: supportUnreadChanged fires on every send/read, so the timer only
  // catches messages that arrived from another device.
  useVisibleInterval(refreshSupportUnread, supportPollActive ? 60_000 : 0);

  const expensePollActive = !!user && ["SALESMAN", "ACCOUNTS_MANAGER", "ADMIN"].includes(user.role);

  const refreshExpenseBadge = useCallback(() => {
    if (!user || !expensePollActive) return;
    void api<{ summary?: { pendingMineCount?: number; pendingApprovalCount?: number } }>("/api/v1/expenses", { noCache: true, suppressErrorLog: true })
      .then((result) => {
        const count = user.role === "SALESMAN"
          ? Number(result.summary?.pendingMineCount || 0)
          : Number(result.summary?.pendingApprovalCount || 0);
        setExpenseBadge(count);
      })
      .catch(() => { /* migration may not be applied yet */ });
  }, [user, expensePollActive]);

  useEffect(() => {
    if (!expensePollActive) {
      setExpenseBadge(0);
      return;
    }
    refreshExpenseBadge();
    window.addEventListener("expenseChanged", refreshExpenseBadge);
    return () => {
      window.removeEventListener("expenseChanged", refreshExpenseBadge);
    };
  }, [expensePollActive, refreshExpenseBadge, activeCompany?.id]);

  // 20s -> 60s: expenseChanged already covers this user's own submissions and
  // approvals; the timer only catches another user's.
  useVisibleInterval(refreshExpenseBadge, expensePollActive ? 60_000 : 0);

  const isPartyUser = !!user && !["SALESMAN", "ADMIN", "SUPER_ADMIN", "DRIVER"].includes(user.role);

  // Filter sidebar sections by permission — empty categories disappear automatically.
  // For party/retailer users, remap the "Orders" link to their own orders page
  const sidebarSections = permissionsLoaded
    ? SIDEBAR_SECTIONS.map((section) => ({
        ...section,
        items: section.items
          .filter((item) => canView(item.module))
          .map((item) =>
            item.label === "Orders" && item.href === "/dashboard/invoices/new" && isPartyUser
              ? { ...item, href: "/dashboard/orders" }
              : item
          ),
      })).filter((section) => section.items.length > 0)
    : [];

  const visibleBottomNav = permissionsLoaded
    ? bottomNavItems.filter((item) => canView(item.module)).map(item =>
        item.label === "Orders" && item.href === "/dashboard/invoices/new" && isPartyUser
          ? { ...item, href: "/dashboard/orders" }
          : item
      )
    : [];

  // Determine if current page module is accessible
  const currentModule = ALL_SIDEBAR_ITEMS
    .filter((item) => matchesSidebarPath(pathname, item))
    .sort((a, b) => b.href.length - a.href.length)[0]?.module;
  const activeSidebarSectionLabel = sidebarSections.find(
    (section) => section.label && section.items.some((item) => matchesSidebarPath(pathname, item))
  )?.label;
  const isAccessDenied =
    permissionsLoaded &&
    !isSuperAdmin &&
    !!currentModule &&
    !canView(currentModule);

  const toggleSidebarSection = useCallback((section: string) => {
    setCollapsedSidebarSections((current) => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }, []);

  // Direct navigation to a page should always reveal its active menu item.
  useEffect(() => {
    if (!activeSidebarSectionLabel) return;
    setCollapsedSidebarSections((current) => {
      if (!current.has(activeSidebarSectionLabel)) return current;
      const next = new Set(current);
      next.delete(activeSidebarSectionLabel);
      return next;
    });
  }, [activeSidebarSectionLabel]);

  const handleDashboardNavClick = (e: React.MouseEvent) => {
    // If super admin is already on /dashboard, clear the company so the list shows
    if (isSuperAdmin && pathname === "/dashboard") {
      e.preventDefault();
      clearActiveCompany();
      setActiveCompanyState(null);
      window.dispatchEvent(new Event("activeCompanyChanged"));
    }
  };

  // Close drawer on route change
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  if (!user) return (
    <div className="min-h-screen bg-[#f4f4f5] flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-amber-600 flex items-center justify-center animate-pulse">
          <span className="text-zinc-900 font-bold text-sm">HT</span>
        </div>
        <div className="w-5 h-5 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin" />
      </div>
    </div>
  );

  const roleColor: Record<string, string> = {
    SUPER_ADMIN: "bg-red-500/20 text-red-400",
    ADMIN: "bg-purple-500/20 text-purple-400",
    SALES_MANAGER: "bg-blue-500/20 text-blue-400",
    FIELD_MANAGER: "bg-cyan-500/20 text-cyan-400",
    SALESMAN: "bg-green-500/20 text-green-400",
    DISTRIBUTOR: "bg-amber-500/20 text-amber-400",
    SUB_DISTRIBUTOR: "bg-orange-500/20 text-orange-400",
    RETAILER: "bg-pink-500/20 text-pink-400",
    WAREHOUSE_MANAGER: "bg-indigo-500/20 text-indigo-400",
    ACCOUNTANT: "bg-teal-500/20 text-teal-400",
    DRIVER: "bg-sky-500/20 text-sky-400",
  };

  return (
    <div className="android-app-shell bg-[#f4f4f5] flex" style={{ fontFamily: "'Inter', 'system-ui', sans-serif" }}>

      {/* ── MOBILE DRAWER OVERLAY ── */}
      {mobileOpen && !isSuperAdminHome && (
        <div
          className="fixed inset-0 z-40 bg-black/70 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* ── MOBILE FULL DRAWER (slides from left) ── */}
      {!isSuperAdminHome && (
      <aside
        className={`fixed top-0 left-0 z-50 h-[100dvh] w-[min(18rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] flex flex-col border-r border-black/[0.06] bg-[#ffffff] transition-transform duration-300 lg:hidden ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Drawer header */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-black/[0.06] shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-amber-500 to-amber-600 flex items-center justify-center shrink-0">
              <span className="text-zinc-900 font-bold text-sm">HT</span>
            </div>
            <span className="text-zinc-900 font-semibold text-sm">Order Plus ERP</span>
          </div>
          <button
            onClick={() => setMobileOpen(false)}
            className="p-1.5 rounded-lg text-zinc-600 hover:text-zinc-900 hover:bg-black/10"
            style={{ background: "none", border: "none" }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* User info */}
        <div className="px-4 py-4 border-b border-black/[0.06] shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-zinc-100 to-zinc-200 flex items-center justify-center shrink-0">
              <span className="text-zinc-900 text-sm font-medium">
                {user.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
              </span>
            </div>
            <div>
              <div className="text-sm text-zinc-900 font-medium">{user.name}</div>
              <span className={`inline-block px-1.5 py-0.5 rounded text-[0.6rem] font-medium ${roleColor[user.role] || "bg-zinc-500/20 text-zinc-600"}`}>
                  {user.role?.replace(/_/g, " ")}
                </span>
              </div>
            </div>
          </div>

        <SidebarNavigation
          sections={sidebarSections}
          pathname={pathname}
          supportUnread={supportUnread}
          expenseBadge={expenseBadge}
          collapsedSections={collapsedSidebarSections}
          onToggleSection={toggleSidebarSection}
          onDashboardClick={handleDashboardNavClick}
        />

        {/* Wallet widget — salesman only (mobile drawer) */}
        {isSalesman && walletBalance !== null && (
          <div className="px-3 pb-2">
            <Link href="/dashboard/my-wallet" className="block rounded-xl bg-gradient-to-br from-emerald-500/10 to-teal-500/5 border border-emerald-500/20 px-3 py-2.5 hover:border-emerald-500/40 transition-all">
              <div className="flex items-center gap-2 mb-1">
                <Wallet className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                <span className="text-[0.65rem] font-semibold text-zinc-500 uppercase tracking-wide">My Wallet</span>
              </div>
              <div className="text-lg font-bold text-emerald-600 tabular-nums leading-tight">
                ₹{walletBalance.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
              </div>
              <div className="text-[0.6rem] text-zinc-400 mt-0.5">Tap to view breakdown →</div>
            </Link>
          </div>
        )}

        {/* Sign out */}
        <div className="border-t border-black/[0.06] p-3 shrink-0">
          <button
            onClick={logout}
            className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-all text-sm"
            style={{ background: "none", border: "none", fontFamily: "inherit", cursor: "pointer" }}
          >
            <LogOut className="w-4 h-4 shrink-0" />
            <span>Sign Out</span>
          </button>
        </div>
        </aside>
      )}

      {/* ── DESKTOP SIDEBAR ── */}
      {!isSuperAdminHome && (
      <aside
        className={`hidden lg:flex sticky top-0 h-[100dvh] flex-col border-r border-black/[0.06] bg-[#ffffff] transition-all duration-300 shrink-0 ${
          collapsed ? "w-[72px]" : "w-64"
        }`}
      >
        {/* Logo */}
        <div className="h-16 flex items-center px-4 border-b border-black/[0.06] shrink-0">
          <div className="flex items-center gap-3 overflow-hidden">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-amber-500 to-amber-600 flex items-center justify-center shrink-0">
              <span className="text-zinc-900 font-bold text-sm">HT</span>
            </div>
            {!collapsed && (
              <span className="text-zinc-900 font-semibold text-sm whitespace-nowrap">Order Plus ERP</span>
            )}
          </div>
        </div>

        <SidebarNavigation
          sections={sidebarSections}
          pathname={pathname}
          collapsed={collapsed}
          supportUnread={supportUnread}
          expenseBadge={expenseBadge}
          collapsedSections={collapsedSidebarSections}
          onToggleSection={toggleSidebarSection}
          onDashboardClick={handleDashboardNavClick}
        />

        {/* Wallet widget — salesman only */}
        {isSalesman && !collapsed && walletBalance !== null && (
          <div className="px-3 py-2 border-t border-black/[0.06]">
            <Link href="/dashboard/my-wallet" className="block rounded-xl bg-gradient-to-br from-emerald-500/10 to-teal-500/5 border border-emerald-500/20 px-3 py-2.5 hover:border-emerald-500/40 hover:from-emerald-500/15 transition-all">
              <div className="flex items-center gap-2 mb-1">
                <Wallet className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                <span className="text-[0.65rem] font-semibold text-zinc-500 uppercase tracking-wide">My Wallet</span>
              </div>
              <div className="text-lg font-bold text-emerald-600 tabular-nums leading-tight">
                ₹{walletBalance.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
              </div>
              <div className="text-[0.6rem] text-zinc-400 mt-0.5">Tap to view breakdown →</div>
            </Link>
          </div>
        )}

        {/* User section */}
        <div className="border-t border-black/[0.06] p-3 shrink-0">
          {!collapsed && (
            <div className="flex items-center gap-3 mb-3">
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-zinc-100 to-zinc-200 flex items-center justify-center shrink-0">
                <span className="text-zinc-900 text-xs font-medium">
                  {user.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                </span>
              </div>
              <div className="overflow-hidden">
                <div className="text-sm text-zinc-900 font-medium truncate" style={{ fontSize: "0.8rem" }}>
                  {user.name}
                </div>
                <span className={`inline-block px-1.5 py-0.5 rounded text-[0.6rem] font-medium ${roleColor[user.role] || "bg-zinc-500/20 text-zinc-600"}`}>
                  {user.role?.replace(/_/g, " ")}
                  </span>
              </div>
            </div>
          )}
          <button
            onClick={logout}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-all"
            style={{ fontSize: "0.8rem", background: "none", border: "none", fontFamily: "inherit", cursor: "pointer" }}
          >
            <LogOut className="w-4 h-4 shrink-0" />
            {!collapsed && <span>Sign Out</span>}
          </button>
        </div>

        {/* Collapse toggle */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="absolute -right-3 top-20 w-6 h-6 rounded-full bg-[#ffffff] border border-black/10 flex items-center justify-center text-zinc-600 hover:text-zinc-900 transition-colors"
          style={{ padding: 0, background: "#ffffff", border: "1px solid rgba(17, 17, 24,0.1)" }}
        >
          <ChevronLeft className={`w-3 h-3 transition-transform ${collapsed ? "rotate-180" : ""}`} />
        </button>
        </aside>
      )}

      {/* ── MAIN CONTENT ── */}
      <div className="flex-1 flex flex-col min-h-[100dvh] min-w-0 max-w-full overflow-x-hidden">
        {/* Top bar */}
        <header className="h-14 lg:h-16 border-b border-black/[0.06] flex items-center justify-between gap-2 px-3 sm:px-4 lg:px-6 bg-[#f4f4f5]/80 backdrop-blur-xl sticky top-0 z-30 shrink-0">
          {/* Hamburger — mobile only */}
          {!isSuperAdminHome && (
            <button
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-2 -ml-1 rounded-lg text-zinc-600 hover:text-zinc-900 hover:bg-black/5 transition-colors"
              style={{ background: "none", border: "none" }}
            >
              <Menu className="w-5 h-5" />
            </button>
          )}

          {/* Mobile logo */}
          <div className="flex lg:hidden items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-md bg-gradient-to-br from-amber-500 to-amber-600 flex items-center justify-center">
              <span className="text-zinc-900 font-bold text-xs">HT</span>
            </div>
            <span className="text-zinc-900 font-semibold text-sm truncate">Order Plus ERP</span>
          </div>

          <div className="flex-1" />

            <div className="flex items-center justify-end gap-2 min-w-0">
                    {/* Go to Super Admin Dashboard — visible only to SUPER_ADMIN, hidden on the company list itself */}
                        {user?.role === "SUPER_ADMIN" && !(pathname === "/dashboard" && !activeCompany) && (
                          <button
onClick={() => {
                                      clearActiveCompany();
                                      setActiveCompanyState(null);
                                      window.dispatchEvent(new Event("activeCompanyChanged"));
                                      router.push("/dashboard");
                                    }}
                            className="flex items-center gap-2 px-4 py-2 rounded-xl font-bold text-sm transition-all"
                            style={{
                              background: "linear-gradient(135deg, rgba(245,158,11,0.25) 0%, rgba(245,158,11,0.1) 100%)",
                              border: "1px solid rgba(245,158,11,0.5)",
                              color: "#fbbf24",
                              boxShadow: "0 0 18px rgba(245,158,11,0.25), inset 0 1px 0 rgba(17, 17, 24,0.05)",
                            }}
                          >
                            <LayoutGrid className="w-4 h-4 shrink-0" />
                            <span className="hidden sm:inline">Super Admin Dashboard</span>
                            <span className="sm:hidden">SA Dashboard</span>
                          </button>
                        )}
                {/* Active company banner — SUPER_ADMIN viewing a company */}
              {user?.role === "SUPER_ADMIN" && activeCompany && (
                <div className="flex items-center gap-2.5 min-w-0 px-2.5 sm:px-3 py-1.5 rounded-xl border border-amber-500/40 bg-gradient-to-r from-amber-500/15 to-amber-600/5" style={{ boxShadow: "0 0 16px rgba(245,158,11,0.15)" }}>
                  <div className="w-6 h-6 rounded-md bg-amber-500/20 border border-amber-500/30 flex items-center justify-center shrink-0">
                    <Building2 className="w-3.5 h-3.5 text-amber-400" />
                  </div>
                  <div className="hidden sm:block">
                    <div className="text-amber-700 text-xs font-bold leading-tight max-w-[180px] truncate">{activeCompany.name}</div>
                    <div className="text-amber-600/70 text-[0.6rem] leading-tight">Viewing this company&apos;s data only</div>
                  </div>
                  <span className="sm:hidden text-amber-700 text-xs font-bold max-w-[100px] truncate">{activeCompany.name}</span>
                </div>
              )}

              {/* Company name banner — ADMIN users always see their own company */}
              {user?.role !== "SUPER_ADMIN" && activeCompany && (
                <div className="flex items-center gap-2 sm:gap-3 min-w-0 rounded-xl bg-gradient-to-r from-emerald-50/80 to-teal-50/50 border border-emerald-200/60 px-2.5 sm:px-3 py-1.5" style={{ boxShadow: "0 2px 8px rgba(16,185,129,0.1)" }}>
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shrink-0 shadow-md" style={{ boxShadow: "0 2px 6px rgba(16,185,129,0.25)" }}>
                    <Building2 className="w-4 h-4 text-white" />
                  </div>
                  <div className="min-w-0 flex items-center gap-2.5">
                    <h1 className="text-sm font-bold text-zinc-900 tracking-tight truncate">{activeCompany.name}</h1>
                    <span className="hidden sm:inline text-zinc-300">•</span>
                    <span className="hidden sm:inline text-xs font-medium text-zinc-600">{user?.name || "User"}</span>
                    <span className="hidden sm:inline text-[0.65rem] font-semibold px-2 py-0.5 rounded-full bg-gradient-to-r from-amber-100 to-amber-200/80 text-amber-700 border border-amber-300/40">{user?.role?.replace(/_/g, " ")}</span>
                  </div>
                </div>
              )}

            </div>
        </header>

          {/* Page content — extra bottom padding on mobile for bottom nav */}
          <main className="flex-1 min-w-0 max-w-full overflow-x-hidden p-3 pb-[calc(6rem+env(safe-area-inset-bottom))] sm:p-4 lg:p-6 lg:pb-6">
            {subscriptionBlocked && subscriptionChecked ? (
              <div className="flex flex-col items-center justify-center min-h-[60vh] gap-5 text-center px-4">
                <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-red-500/20 to-amber-500/10 border border-red-500/20 flex items-center justify-center" style={{ boxShadow: "0 0 40px rgba(239,68,68,0.1)" }}>
                  <Lock className="w-9 h-9 text-red-400" />
                </div>
                <div>
                  <h2 className="text-zinc-900 font-bold text-xl mb-2">Subscription Required</h2>
                  <p className="text-zinc-500 text-sm leading-relaxed max-w-md mx-auto">
                    {user?.role === "ADMIN"
                      ? <>Your company does not have an active subscription.<br />Please contact Order Plus ERP support to activate your plan.</>
                      : <>Please renew your subscription or buy a subscription.<br />Contact your administrator.</>}
                  </p>
                </div>
                <div className="flex items-center gap-2 mt-2 px-4 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                  <span className="text-amber-500 text-xs font-medium">Your company&apos;s subscription is inactive or expired</span>
                </div>
                <button
                  onClick={logout}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium text-red-400 hover:text-red-300 transition-all mt-2"
                  style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", cursor: "pointer", fontFamily: "inherit" }}
                >
                  <LogOut className="w-4 h-4" />
                  Sign Out
                </button>
              </div>
            ) : isAccessDenied ? (
              <div className="flex flex-col items-center justify-center h-64 gap-4 text-center">
                <div className="w-14 h-14 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
                  <Shield className="w-7 h-7 text-red-400" />
                </div>
                <div>
                  <h2 className="text-zinc-900 font-semibold text-lg">Access Denied</h2>
                  <p className="text-zinc-500 text-sm mt-1">You don&apos;t have permission to view this module.</p>
                  <p className="text-zinc-600 text-xs mt-1">Contact your administrator to request access.</p>
                </div>
              </div>
            ) : children}
          </main>
      </div>

      {/* ── MOBILE BOTTOM NAV ── */}
      <SalesmanGpsGuardian enabled={isSalesman} />
      <AdminGpsNotificationListener enabled={user?.role === "ADMIN"} />

      {!isSuperAdminHome && (
      <nav className="fixed bottom-0 left-0 right-0 z-30 lg:hidden border-t border-black/[0.06] bg-[#ffffff]/95 backdrop-blur-xl">
        <div className="flex items-center justify-around gap-1 px-1.5 py-2 safe-area-inset-bottom">
              {visibleBottomNav.map((item) => {
              const isActive = pathname === item.href || (!(item as { exact?: boolean }).exact && item.href !== "/dashboard" && pathname.startsWith(item.href));
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={item.href === "/dashboard" ? handleDashboardNavClick : undefined}
                  className={`flex min-w-0 flex-1 flex-col items-center gap-1 px-1 py-1.5 rounded-xl transition-all ${
                    isActive ? "text-amber-400" : "text-zinc-500"
                  }`}
                >
                  <Icon className={`w-5 h-5 ${isActive ? "text-amber-400" : ""}`} />
                  <span className="max-w-full truncate" style={{ fontSize: "0.6rem" }}>{item.label}</span>
                </Link>
              );
            })}
          {/* "More" button opens the full drawer */}
          <button
            onClick={() => setMobileOpen(true)}
            className="flex min-w-0 flex-1 flex-col items-center gap-1 px-1 py-1.5 rounded-xl text-zinc-500 transition-all"
            style={{ background: "none", border: "none", fontFamily: "inherit", cursor: "pointer" }}
          >
            <Menu className="w-5 h-5" />
            <span className="max-w-full truncate" style={{ fontSize: "0.6rem" }}>More</span>
          </button>
        </div>
      </nav>
      )}
    </div>
  );
}
