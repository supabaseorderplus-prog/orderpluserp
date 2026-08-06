"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Loader2, Trophy, Crown, Lightbulb, ReceiptText, Wallet, Medal } from "lucide-react";

type BoardKind = "party" | "salesman";

interface RankingEntry {
  id: string;
  name: string;
  code: string | null;
  invoiceValue: number;
  paymentValue: number;
  score: number;
  rank: number;
  isSelf: boolean;
}

interface RankingBoard {
  board: BoardKind;
  category: string | null;
  scope: "admin" | "self";
  period: { from: string; label: string };
  entries: RankingEntry[];
  totalCount: number;
  self: RankingEntry | null;
  tip: string | null;
  categories?: string[];
}

interface StoredUser {
  role?: string;
  name?: string;
}

const ADMIN_ROLES = ["ADMIN", "SUPER_ADMIN"];
const CATEGORY_LABEL: Record<string, string> = {
  SUPER_DEALER: "Super Dealers",
  CNF: "CNF",
  RETAILER: "Retailers",
};

// Defensive reset — neutralises aggressive global styles on this surface.
const reset: React.CSSProperties = {
  transform: "none", filter: "none", WebkitTextStroke: "0",
  boxShadow: "none", textTransform: "none",
};

const fmtINR = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n || 0);

const fmtCompact = (n: number) => {
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(2)} Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(2)} L`;
  return fmtINR(n);
};

export default function RankingsPage() {
  const [user, setUser] = useState<StoredUser | null>(null);
  const [board, setBoard] = useState<RankingBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Admin-only selectors
  const [adminBoard, setAdminBoard] = useState<BoardKind>("party");
  const [adminCategory, setAdminCategory] = useState("SUPER_DEALER");

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem("user");
      if (raw) setUser(JSON.parse(raw));
    } catch {
      setUser(null);
    }
  }, []);

  const isAdmin = !!user && ADMIN_ROLES.includes(user.role || "");

  useEffect(() => {
    if (!user) return;
    let active = true;
    const params = new URLSearchParams();
    if (isAdmin) {
      params.set("board", adminBoard);
      if (adminBoard === "party") params.set("category", adminCategory);
    }

    // showSpinner: only on the initial / param-change load. Background polls
    // refresh ranks silently so positions climb in real time without a flash.
    const load = (showSpinner: boolean) => {
      if (showSpinner) {
        setLoading(true);
        setError(null);
      }
      api<{ success: boolean; data: RankingBoard | null; message?: string }>(
        `/api/v1/rankings?${params.toString()}`
      )
        .then((r) => {
          if (!active) return;
          if (!r.success) throw new Error(r.message || "Failed to load rankings");
          setBoard(r.data);
          setError(null);
        })
        .catch((e) => {
          if (!active) return;
          // Surface errors only on the visible load; keep last board on poll fail.
          if (showSpinner) {
            setError(e instanceof Error ? e.message : "Failed to load rankings");
            setBoard(null);
          }
        })
        .finally(() => {
          if (active && showSpinner) setLoading(false);
        });
    };

    load(true);
    // Rankings are recomputed on read from invoices + payments, so each poll is an
    // expensive scan. It is a monthly leaderboard — 2 minutes between refreshes,
    // and none at all while the tab is hidden, is plenty.
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      load(false);
    }, 120_000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [user, isAdmin, adminBoard, adminCategory]);

  const isSalesmanBoard = board?.board === "salesman";

  const heading = useMemo(() => {
    if (isAdmin) return adminBoard === "salesman" ? "Salesman Rankings" : "Party Rankings";
    if (board?.board === "salesman") return "Salesman Rankings";
    return board?.category ? `${CATEGORY_LABEL[board.category] || board.category} Rankings` : "Rankings";
  }, [isAdmin, adminBoard, board]);

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      <div className="flex items-center gap-2 mb-1">
        <Trophy className="w-6 h-6 text-amber-500" />
        <h1 className="text-2xl font-bold text-zinc-900" style={{ ...reset, fontSize: "1.5rem" }}>{heading}</h1>
      </div>
      <p className="text-zinc-600 mb-5" style={{ fontSize: "0.8rem" }}>
        {board?.period?.label ? `${board.period.label} · ` : ""}
        {isSalesmanBoard
          ? "Ranked by total payment collected this month."
          : "Ranked by invoices generated + payments made this month."}
      </p>

      {/* Admin board switch */}
      {isAdmin && (
        <div className="flex flex-wrap gap-2 mb-4">
          {(["party", "salesman"] as BoardKind[]).map((b) => (
            <button
              key={b}
              onClick={() => setAdminBoard(b)}
              className={`px-4 py-2 rounded-lg text-sm transition-all ${
                adminBoard === b
                  ? "bg-amber-500/15 text-amber-600 border border-amber-500/40 font-medium"
                  : "border border-black/10 text-zinc-600 hover:bg-black/[0.04]"
              }`}
              style={{ ...reset, fontSize: "0.8rem", cursor: "pointer", background: adminBoard === b ? undefined : "none" }}
            >
              {b === "party" ? "Parties" : "Salesmen"}
            </button>
          ))}
        </div>
      )}

      {/* Admin category sub-tabs (party board only) */}
      {isAdmin && adminBoard === "party" && (
        <div className="flex flex-wrap gap-2 mb-6">
          {(board?.categories || ["SUPER_DEALER", "CNF", "RETAILER"]).map((c) => (
            <button
              key={c}
              onClick={() => setAdminCategory(c)}
              className={`px-3.5 py-1.5 rounded-full text-xs transition-all ${
                adminCategory === c
                  ? "bg-zinc-900 text-white border border-zinc-900"
                  : "border border-black/10 text-zinc-600 hover:bg-black/[0.04]"
              }`}
              style={{ ...reset, fontSize: "0.72rem", cursor: "pointer", background: adminCategory === c ? undefined : "none" }}
            >
              {CATEGORY_LABEL[c] || c.replace(/_/g, " ")}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
        </div>
      ) : error ? (
        <EmptyState text={error} />
      ) : !board || board.totalCount === 0 ? (
        <EmptyState text={`No ranking activity yet for ${board?.period?.label || "this month"}.`} />
      ) : (
        <>
          {/* Improvement tip (self views only) */}
          {board.scope === "self" && board.tip && (
            <div
              className="relative flex items-start gap-3 mb-6 overflow-hidden rounded-xl border-2 border-amber-400 bg-gradient-to-r from-amber-100 to-amber-200/70 px-4 py-3.5 shadow-lg shadow-amber-500/25 ring-1 ring-amber-300/50"
              style={reset}
            >
              <span className="absolute inset-y-0 left-0 w-1.5 bg-amber-500" aria-hidden />
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500 shadow-sm">
                <Lightbulb className="w-4.5 h-4.5 text-white" />
              </span>
              <div>
                <div className="text-[0.7rem] uppercase tracking-wide text-amber-700 font-bold" style={{ fontSize: "0.62rem", letterSpacing: "0.07em" }}>
                  How to climb
                </div>
                <p className="text-amber-950 font-medium" style={{ fontSize: "0.9rem" }}>{board.tip}</p>
              </div>
            </div>
          )}

          {/* Podium for top 3 */}
          <Podium entries={board.entries.slice(0, 3)} isSalesman={isSalesmanBoard} mask={board.scope === "self"} />

          {/* Self standing card (self view, outside top 3) */}
          {board.scope === "self" && board.self && board.self.rank > 3 && (
            <div className="mt-6">
              <div className="text-[0.7rem] uppercase tracking-wide text-zinc-500 font-semibold mb-2" style={{ fontSize: "0.62rem", letterSpacing: "0.06em" }}>
                Your standing
              </div>
              <SelfRow entry={board.self} total={board.totalCount} isSalesman={isSalesmanBoard} />
            </div>
          )}

          {/* Full leaderboard — admins on any board, and salesmen on their own
              board (so a salesman sees every salesman and their rank). Party
              self-view stays trimmed to podium + self standing. */}
          {(board.scope === "admin" || isSalesmanBoard) && board.entries.length > 3 && (
            <div className="mt-8">
              <Leaderboard entries={board.entries.slice(3)} isSalesman={isSalesmanBoard} mask={board.scope === "self"} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="text-center py-20 text-zinc-500">
      <Trophy className="w-12 h-12 mx-auto mb-4 opacity-30" />
      <p style={{ fontSize: "0.875rem" }}>{text}</p>
    </div>
  );
}

// Privacy mask for peers on a self-scope board: keep the first 2 letters of the
// name and last 2 letters readable, blur everything in between so one salesman
// can recognise a rival's position without reading their full name. Note this is
// a visual guard only — the value still exists in the DOM/API response.
function MaskedName({ name }: { name: string }) {
  const trimmed = (name || "").trim();
  if (trimmed.length <= 4) {
    return <span style={{ filter: "blur(4px)", userSelect: "none" }} aria-label="Hidden name">{trimmed}</span>;
  }
  const prefix = trimmed.slice(0, 2);
  const middle = trimmed.slice(2, -2);
  const suffix = trimmed.slice(-2);
  return (
    <span aria-label="Hidden name">
      {prefix}
      <span style={{ filter: "blur(4px)", userSelect: "none" }} aria-hidden>{middle}</span>
      {suffix}
    </span>
  );
}

const MEDAL = [
  { ring: "from-amber-300 to-amber-500", chip: "bg-amber-500/15 text-amber-600", label: "1st", icon: Crown },
  { ring: "from-zinc-300 to-zinc-400", chip: "bg-zinc-400/20 text-zinc-600", label: "2nd", icon: Medal },
  { ring: "from-orange-300 to-orange-500", chip: "bg-orange-500/15 text-orange-600", label: "3rd", icon: Medal },
];

function Podium({ entries, isSalesman, mask }: { entries: RankingEntry[]; isSalesman: boolean; mask: boolean }) {
  // Visual order: 2nd, 1st, 3rd — with 1st raised.
  const order = [entries[1], entries[0], entries[2]].filter(Boolean) as RankingEntry[];
  return (
    <div className="grid grid-cols-3 gap-2 sm:gap-3 items-end">
      {order.map((e) => {
        const place = e.rank - 1;
        const m = MEDAL[place] || MEDAL[2];
        const Icon = m.icon;
        const raised = place === 0;
        return (
          <div
            key={e.id}
            className={`rounded-2xl border bg-white px-3 pt-5 pb-4 text-center relative ${
              e.isSelf ? "border-amber-500/50 ring-2 ring-amber-500/20" : "border-black/[0.07]"
            }`}
            style={{ ...reset, marginBottom: raised ? 0 : 14 }}
          >
            <div className={`mx-auto mb-2 w-12 h-12 rounded-full bg-gradient-to-br ${m.ring} flex items-center justify-center text-white`} style={reset}>
              <Icon className="w-6 h-6" />
            </div>
            <div className={`inline-block px-2 py-0.5 rounded-full text-[0.6rem] font-bold mb-1.5 ${m.chip}`} style={{ ...reset, fontSize: "0.6rem" }}>
              {m.label}
            </div>
            <div className="font-semibold text-zinc-900 truncate" style={{ fontSize: raised ? "0.92rem" : "0.82rem" }} title={mask && !e.isSelf ? undefined : e.name}>
              {mask && !e.isSelf ? <MaskedName name={e.name} /> : e.name}
            </div>
            {e.code && <div className="text-zinc-400 truncate" style={{ fontSize: "0.6rem" }}>{e.code}</div>}
            <div className="mt-2 font-bold text-amber-600" style={{ fontSize: raised ? "1.05rem" : "0.95rem" }}>
              {fmtCompact(e.score)}
            </div>
            {e.isSelf && <div className="mt-1 text-[0.6rem] font-semibold text-amber-600" style={{ fontSize: "0.6rem" }}>YOU</div>}
            {!isSalesman && (
              <div className="mt-2 flex flex-col items-center gap-0.5 text-zinc-500" style={{ fontSize: "0.6rem" }}>
                <span className="flex items-center gap-1"><ReceiptText className="w-3 h-3 shrink-0" />{fmtCompact(e.invoiceValue)}</span>
                <span className="flex items-center gap-1"><Wallet className="w-3 h-3 shrink-0" />{fmtCompact(e.paymentValue)}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SelfRow({ entry, total, isSalesman }: { entry: RankingEntry; total: number; isSalesman: boolean }) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-amber-500/40 bg-amber-50/60 px-4 py-3" style={reset}>
      <div className="w-10 h-10 rounded-full bg-amber-500/15 text-amber-600 flex items-center justify-center font-bold" style={{ ...reset, fontSize: "0.85rem" }}>
        #{entry.rank}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-zinc-900 truncate" style={{ fontSize: "0.85rem" }}>{entry.name} <span className="text-amber-600">· YOU</span></div>
        <div className="text-zinc-500" style={{ fontSize: "0.66rem" }}>Rank {entry.rank} of {total}</div>
      </div>
      <div className="text-right">
        <div className="font-bold text-amber-600" style={{ fontSize: "0.95rem" }}>{fmtCompact(entry.score)}</div>
        {!isSalesman && (
          <div className="text-zinc-500 flex gap-2 justify-end" style={{ fontSize: "0.6rem" }}>
            <span>Inv {fmtCompact(entry.invoiceValue)}</span>
            <span>Paid {fmtCompact(entry.paymentValue)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Leaderboard({ entries, isSalesman, mask }: { entries: RankingEntry[]; isSalesman: boolean; mask: boolean }) {
  // Mobile-first list: each entry is a flex row that wraps gracefully on narrow
  // screens instead of a multi-column table that overflows. The party board's
  // invoice/payment breakdown sits as sub-text under the name rather than in its
  // own columns.
  return (
    <div className="rounded-xl border border-black/[0.07] divide-y divide-black/[0.05] overflow-hidden">
      <div className="px-4 py-2.5 bg-black/[0.02] text-zinc-500 font-medium" style={{ fontSize: "0.66rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {isSalesman ? "Salesman leaderboard" : "Party leaderboard"}
      </div>
      {entries.map((e) => (
        <div
          key={e.id}
          className={`flex items-center gap-3 px-3 sm:px-4 py-3 ${e.isSelf ? "bg-amber-50/60" : "hover:bg-black/[0.02]"}`}
        >
          <span className="inline-flex w-7 h-7 shrink-0 rounded-full bg-black/[0.04] text-zinc-600 items-center justify-center font-semibold" style={{ fontSize: "0.72rem" }}>
            {e.rank}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-zinc-900 font-medium truncate" style={{ fontSize: "0.82rem" }}>
              {mask && !e.isSelf ? <MaskedName name={e.name} /> : e.name}
              {e.isSelf && <span className="text-amber-600"> · YOU</span>}
            </div>
            {!isSalesman && (
              <div className="text-zinc-500 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5" style={{ fontSize: "0.62rem" }}>
                <span className="flex items-center gap-1"><ReceiptText className="w-3 h-3" />{fmtCompact(e.invoiceValue)}</span>
                <span className="flex items-center gap-1"><Wallet className="w-3 h-3" />{fmtCompact(e.paymentValue)}</span>
              </div>
            )}
            {e.code && <div className="text-zinc-400 mt-0.5 truncate" style={{ fontSize: "0.6rem" }}>{e.code}</div>}
          </div>
          <div className="text-right shrink-0">
            <div className="text-amber-600 font-bold" style={{ fontSize: "0.85rem" }}>{fmtCompact(e.score)}</div>
            <div className="text-zinc-400" style={{ fontSize: "0.55rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              {isSalesman ? "Collected" : "Score"}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
