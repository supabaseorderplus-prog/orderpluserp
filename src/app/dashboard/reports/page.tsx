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

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900" style={{ ...s, fontSize: "1.5rem" }}>
          Reports
        </h1>
        <p className="text-sm text-zinc-500 mt-1" style={{ ...s, fontSize: "0.85rem", marginTop: "0.25rem" }}>
          Every business report in one place — engagement, sales, money and operations.
        </p>
      </div>

      {/* Flagship hero */}
      <Link
        href={flagship.href}
        className="group block rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-500/10 via-amber-500/5 to-transparent p-5 sm:p-6 mb-8 transition-all hover:border-amber-500/50"
        style={{ boxShadow: "0 1px 0 rgba(0,0,0,0.02)" }}
      >
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-amber-500/15 flex items-center justify-center shrink-0">
            <FlagshipIcon className="w-6 h-6 text-amber-500" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 text-[0.6rem] font-bold uppercase tracking-wide">
                <Activity className="w-3 h-3" /> Live
              </span>
            </div>
            <h2 className="text-lg font-bold text-zinc-900" style={{ ...s, fontSize: "1.1rem" }}>
              {flagship.title}
            </h2>
            <p className="text-sm text-zinc-600 mt-1 leading-relaxed" style={{ fontSize: "0.85rem" }}>
              {flagship.description}
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-amber-500 shrink-0 transition-transform group-hover:translate-x-1 hidden sm:block" />
        </div>
      </Link>

      {/* Sections */}
      <div className="space-y-8">
        {SECTIONS.map((section) => (
          <section key={section.title}>
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-zinc-900" style={{ ...s, fontSize: "0.9rem" }}>
                {section.title}
              </h3>
              <p className="text-xs text-zinc-500 mt-0.5" style={{ ...s, fontSize: "0.72rem", marginTop: "0.1rem" }}>
                {section.blurb}
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              {section.cards.map((card) => {
                const Icon = card.icon;
                return (
                  <Link
                    key={card.key}
                    href={card.href}
                    className="group rounded-xl border border-black/[0.06] bg-black/[0.02] p-4 transition-all hover:border-black/[0.12] hover:bg-black/[0.03]"
                  >
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${card.color}`}>
                        <Icon className="w-5 h-5" />
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
                    <p className="text-xs text-zinc-500 mt-1 leading-relaxed" style={{ fontSize: "0.72rem" }}>
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
