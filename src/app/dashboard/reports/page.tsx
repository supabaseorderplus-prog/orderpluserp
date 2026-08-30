"use client";

import Link from "next/link";
import {
  Activity,
  ArrowRight,
  BarChart3,
  BookOpen,
  Boxes,
  CreditCard,
  Download,
  FileText,
  Gauge,
  Gift,
  IndianRupee,
  Navigation,
  Package,
  Trophy,
  Users,
  Wallet,
} from "lucide-react";

// Defeat the app's aggressive global text effects (matches analytics/dashboard).
const s: React.CSSProperties = {
  transform: "none",
  filter: "none",
  WebkitTextStroke: "0",
  background: "none",
  boxShadow: "none",
  display: "block",
  padding: 0,
};

type ReportStatus = "live" | "linked";

interface ReportCard {
  key: string;
  title: string;
  description: string;
  href: string;
  icon: typeof Activity;
  color: string; // tailwind text + bg pair for the icon chip
  status: ReportStatus;
}

interface ReportSection {
  title: string;
  blurb: string;
  cards: ReportCard[];
}

// The flagship report is the only net-new compute-on-read report; the rest of the
// catalog routes to the existing functional surfaces that already own that data, so
// the hub is a single index of every business report with zero dead links.
const SECTIONS: ReportSection[] = [
  {
    title: "Parties & Engagement",
    blurb: "Who is buying, who is going quiet, and how healthy the roster is.",
    cards: [
      {
        key: "party-activity",
        title: "Party Activity & Order Report",
        description:
          "Every party scored 0–100% on a rolling 28-day window of orders & payments, with active / slowing / at-risk / dormant status.",
        href: "/dashboard/reports/party-activity",
        icon: Gauge,
        color: "text-amber-500 bg-amber-500/10",
        status: "live",
      },
      {
        key: "rankings",
        title: "Party & Salesman Rankings",
        description: "Monthly leaderboards by invoices, payments and collection, segmented by party type.",
        href: "/dashboard/rankings",
        icon: Trophy,
        color: "text-yellow-500 bg-yellow-500/10",
        status: "linked",
      },
      {
        key: "downline",
        title: "Downline Network",
        description: "The full party hierarchy under each company, CNF, super dealer and retailer.",
        href: "/dashboard/downline",
        icon: Users,
        color: "text-sky-500 bg-sky-500/10",
        status: "linked",
      },
    ],
  },
  {
    title: "Sales & Orders",
    blurb: "Demand, product mix and order throughput.",
    cards: [
      {
        key: "analytics",
        title: "Sales Analytics",
        description: "Today / MTD sales, active orders, top products and top buyers at a glance.",
        href: "/dashboard/analytics",
        icon: BarChart3,
        color: "text-emerald-500 bg-emerald-500/10",
        status: "linked",
      },
      {
        key: "orders-export",
        title: "Orders Export",
        description: "Full order register with line items and status, exportable to CSV.",
        href: "/dashboard/exports",
        icon: FileText,
        color: "text-cyan-500 bg-cyan-500/10",
        status: "linked",
      },
      {
        key: "products",
        title: "Product Catalogue",
        description: "Product master with HSN, pricing and pack sizes for sales planning.",
        href: "/dashboard/products",
        icon: Package,
        color: "text-orange-500 bg-orange-500/10",
        status: "linked",
      },
    ],
  },
  {
    title: "Financials & Collections",
    blurb: "Outstanding money, collections and the cash position.",
    cards: [
      {
        key: "outstanding",
        title: "Outstanding & Dues",
        description: "Receivables by party — who owes what, ranked by outstanding balance.",
        href: "/dashboard/payments",
        icon: IndianRupee,
        color: "text-red-500 bg-red-500/10",
        status: "linked",
      },
      {
        key: "collections",
        title: "Collection Report",
        description: "Payment collection summary by party and by salesman, with date ranges.",
        href: "/dashboard/exports",
        icon: CreditCard,
        color: "text-blue-500 bg-blue-500/10",
        status: "linked",
      },
      {
        key: "wallets",
        title: "Wallet Balances",
        description: "Derived wallet position per party and salesman collection balances.",
        href: "/dashboard/wallets",
        icon: Wallet,
        color: "text-teal-500 bg-teal-500/10",
        status: "linked",
      },
      {
        key: "ledgers",
        title: "Ledgers",
        description: "Party-wise running ledger of invoices, payments and adjustments.",
        href: "/dashboard/ledgers",
        icon: BookOpen,
        color: "text-indigo-500 bg-indigo-500/10",
        status: "linked",
      },
    ],
  },
  {
    title: "Field, Inventory & Schemes",
    blurb: "Ground operations, stock and incentive programmes.",
    cards: [
      {
        key: "tracking",
        title: "Field Tracking",
        description: "Salesman duty, GPS routes and on-ground coverage of the territory.",
        href: "/dashboard/tracking",
        icon: Navigation,
        color: "text-purple-500 bg-purple-500/10",
        status: "linked",
      },
      {
        key: "inventory",
        title: "BOM & Inventory",
        description: "Stock levels, low-stock alerts and bill-of-material consumption.",
        href: "/dashboard/bom-inventory",
        icon: Boxes,
        color: "text-lime-600 bg-lime-500/10",
        status: "linked",
      },
      {
        key: "schemes",
        title: "Scheme Progress",
        description: "Live progress of every party and salesman against active schemes.",
        href: "/dashboard/schemes",
        icon: Gift,
        color: "text-pink-500 bg-pink-500/10",
        status: "linked",
      },
      {
        key: "exports",
        title: "Accounting Exports",
        description: "Tally XML, GSTR-1 and TD/CD ledger exports for filing & accounting.",
        href: "/dashboard/exports",
        icon: Download,
        color: "text-zinc-600 bg-zinc-500/10",
        status: "linked",
      },
    ],
  },
];

export default function ReportsHubPage() {
  const flagship = SECTIONS[0].cards[0];
  const FlagshipIcon = flagship.icon;
  const totalReports = SECTIONS.reduce((total, section) => total + section.cards.length, 0);
  const liveReports = SECTIONS.reduce(
    (total, section) => total + section.cards.filter((card) => card.status === "live").length,
    0,
  );
  const quickReports = [
    flagship,
    SECTIONS[1].cards[0],
    SECTIONS[2].cards[0],
  ];

  return (
    <div className="space-y-6" style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1 text-[0.65rem] font-bold uppercase tracking-wide text-amber-600">
            <FileText className="h-3.5 w-3.5" />
            Report Centre
          </div>
          <h1 className="text-2xl font-bold text-zinc-900" style={{ ...s, fontSize: "1.5rem" }}>
            Reports
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500" style={{ ...s, fontSize: "0.85rem", marginTop: "0.25rem" }}>
            Organised views for engagement, sales, collections and field operations.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          {[
            { label: "Reports", value: totalReports },
            { label: "Live", value: liveReports },
          ].map((item) => (
            <div key={item.label} className="rounded-xl border border-black/[0.06] bg-white/70 px-4 py-3 shadow-sm">
              <div className="text-lg font-bold text-zinc-900 tabular-nums" style={{ ...s, fontSize: "1.1rem" }}>
                {item.value}
              </div>
              <div className="text-[0.65rem] font-semibold uppercase tracking-wide text-zinc-400">
                {item.label}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1.25fr_1fr]">
        <Link
          href={flagship.href}
          className="group flex min-h-[150px] flex-col justify-between rounded-xl border border-amber-500/25 bg-white/75 p-5 shadow-sm transition-all hover:border-amber-500/45 hover:shadow-md"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-500">
                <FlagshipIcon className="h-6 w-6" />
              </div>
              <div className="min-w-0">
                <span className="mb-2 inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[0.58rem] font-bold uppercase tracking-wide text-emerald-600">
                  <Activity className="h-3 w-3" /> Live Report
                </span>
                <h2 className="text-lg font-bold text-zinc-900" style={{ ...s, fontSize: "1.05rem" }}>
                  {flagship.title}
                </h2>
              </div>
            </div>
            <ArrowRight className="hidden h-5 w-5 shrink-0 text-amber-500 transition-transform group-hover:translate-x-1 sm:block" />
          </div>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-zinc-600" style={{ fontSize: "0.82rem" }}>
            {flagship.description}
          </p>
        </Link>

        <div className="rounded-xl border border-black/[0.06] bg-white/70 p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold text-zinc-900" style={{ ...s, fontSize: "0.88rem" }}>
              Quick Open
            </h2>
            <span className="text-[0.65rem] font-semibold uppercase tracking-wide text-zinc-400">
              Most Used
            </span>
          </div>
          <div className="space-y-2">
            {quickReports.map((card) => {
              const Icon = card.icon;
              return (
                <Link
                  key={card.key}
                  href={card.href}
                  className="group flex items-center gap-3 rounded-lg border border-transparent px-2.5 py-2 transition-all hover:border-black/[0.06] hover:bg-black/[0.025]"
                >
                  <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${card.color}`}>
                    <Icon className="h-4.5 w-4.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-zinc-900" style={{ fontSize: "0.8rem" }}>
                      {card.title}
                    </div>
                    <div className="text-[0.68rem] text-zinc-500">
                      {card.status === "live" ? "Live dashboard" : "Linked report"}
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 text-zinc-300 transition-all group-hover:translate-x-0.5 group-hover:text-zinc-500" />
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      <div className="space-y-5">
        {SECTIONS.map((section) => (
          <section key={section.title} className="rounded-xl border border-black/[0.06] bg-white/65 p-4 shadow-sm">
            <div className="mb-4 flex flex-col gap-1 border-b border-black/[0.05] pb-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h3 className="text-sm font-semibold text-zinc-900" style={{ ...s, fontSize: "0.9rem" }}>
                  {section.title}
                </h3>
                <p className="text-xs text-zinc-500 mt-0.5" style={{ ...s, fontSize: "0.72rem", marginTop: "0.1rem" }}>
                  {section.blurb}
                </p>
              </div>
              <span className="text-[0.65rem] font-semibold uppercase tracking-wide text-zinc-400">
                {section.cards.length} reports
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {section.cards.map((card) => {
                const Icon = card.icon;
                return (
                  <Link
                    key={card.key}
                    href={card.href}
                    className="group flex min-h-[132px] flex-col rounded-lg border border-black/[0.06] bg-white/80 p-4 transition-all hover:border-amber-500/30 hover:bg-amber-500/[0.03]"
                  >
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${card.color}`}>
                        <Icon className="h-5 w-5" />
                      </div>
                      {card.status === "live" ? (
                        <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 text-[0.55rem] font-bold uppercase tracking-wide">
                          Live
                        </span>
                      ) : (
                        <ArrowRight className="w-4 h-4 text-zinc-300 transition-all group-hover:text-zinc-500 group-hover:translate-x-0.5" />
                      )}
                    </div>
                    <h4 className="text-sm font-semibold text-zinc-900 leading-snug" style={{ ...s, fontSize: "0.85rem" }}>
                      {card.title}
                    </h4>
                    <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-zinc-500" style={{ fontSize: "0.72rem" }}>
                      {card.description}
                    </p>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
