"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { ArrowLeft, Loader2, Phone, Shield, User } from "lucide-react";

interface UserDetail {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: string;
  zone: { name: string } | null;
  parentUser: { name: string; role: string } | null;
  isVerified: boolean;
  status: string;
  createdAt: string;
  lastLogin: string | null;
  employee_code: string | null;
  photo_url: string | null;
}

interface Performance {
  mtdOrders: number;
  mtdSales: number;
  outstandingBalance: number;
}

interface HierarchyNode {
  id: string;
  name: string;
  role: string;
  children: HierarchyNode[];
}

const roleColors: Record<string, string> = {
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
};

const s: React.CSSProperties = { transform: "none", filter: "none", WebkitTextStroke: "0", background: "none", boxShadow: "none", display: "block", padding: 0 };

function fmt(n: number): string {
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(2)} Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(2)} L`;
  if (n >= 1000) return `₹${(n / 1000).toFixed(1)}K`;
  return `₹${n.toFixed(0)}`;
}

function TreeNode({ node, depth = 0 }: { node: HierarchyNode; depth?: number }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = node.children && node.children.length > 0;

  return (
    <div style={{ marginLeft: depth * 20 }}>
      <div
        className="flex items-center gap-2 py-2 px-3 rounded-lg hover:bg-black/5 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        {hasChildren && (
          <span className="text-zinc-500 text-xs" style={{ fontSize: "0.7rem" }}>
            {expanded ? "▼" : "▶"}
          </span>
        )}
        {!hasChildren && <span className="w-3" />}
        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-zinc-100 to-zinc-200 flex items-center justify-center shrink-0">
          <span className="text-zinc-900 text-[0.5rem]" style={{ transform: "none" }}>{node.name.charAt(0)}</span>
        </div>
        <span className="text-zinc-800 text-sm" style={{ fontSize: "0.8rem" }}>{node.name}</span>
        <span className={`ml-auto px-1.5 py-0.5 rounded text-[0.6rem] font-medium ${roleColors[node.role] || "bg-zinc-500/20 text-zinc-600"}`} style={{ transform: "none" }}>
            {node.role?.replace(/_/g, " ")}
        </span>
      </div>
      {expanded && hasChildren && node.children.map((child) => (
        <TreeNode key={child.id} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}

export default function UserDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const [user, setUser] = useState<UserDetail | null>(null);
  const [perf, setPerf] = useState<Performance | null>(null);
  const [hierarchy, setHierarchy] = useState<HierarchyNode | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadOptional<T>(path: string): Promise<{ data: T | null }> {
      try {
        const res = await api<{ data: T }>(path, { suppressErrorLog: true });
        return { data: res.data ?? null };
      } catch {
        return { data: null };
      }
    }

    async function load() {
      try {
        const [userRes, perfRes, hierarchyRes] = await Promise.all([
          api<{ data: UserDetail }>(`/api/v1/users/${id}`),
          loadOptional<Performance>(`/api/v1/users/${id}/performance`),
          loadOptional<HierarchyNode>(`/api/v1/users/${id}/hierarchy`),
        ]);
        setUser(userRes.data);
        if (perfRes.data) setPerf(perfRes.data);
        if (hierarchyRes.data) setHierarchy(hierarchyRes.data);
      } catch {
        /* handled */
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="text-center py-20 text-zinc-500" style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
        <User className="w-12 h-12 mx-auto mb-4 opacity-30" />
        <p style={{ fontSize: "0.875rem" }}>User not found</p>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      {/* Back button */}
      <button
        onClick={() => router.back()}
        className="flex items-center gap-2 text-zinc-600 hover:text-zinc-900 mb-6 transition-colors"
        style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", border: "none", boxShadow: "none", cursor: "pointer", textTransform: "none" }}
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Users
      </button>

      {/* Header */}
      <div className="flex items-start gap-4 mb-8">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-zinc-100 to-zinc-200 flex items-center justify-center shrink-0 overflow-hidden">
          {user.photo_url
            ? <img src={user.photo_url} alt={user.name} className="w-full h-full object-cover" />
            : <span className="text-zinc-900 text-xl font-medium" style={{ transform: "none" }}>{user.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}</span>
          }
        </div>
        <div>
          <h1 className="text-2xl font-bold text-zinc-900" style={{ ...s, fontSize: "1.5rem", marginBottom: "0.25rem" }}>{user.name}</h1>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`inline-block px-2 py-1 rounded-md text-xs font-medium ${roleColors[user.role] || "bg-zinc-500/20 text-zinc-600"}`} style={{ fontSize: "0.65rem" }}>
              {user.role?.replace(/_/g, " ") ?? "—"}
            </span>
            <span className={`inline-flex items-center gap-1.5 text-xs ${user.status === "ACTIVE" ? "text-emerald-400" : "text-zinc-500"}`} style={{ fontSize: "0.7rem" }}>
              <span className={`w-1.5 h-1.5 rounded-full ${user.status === "ACTIVE" ? "bg-emerald-500" : "bg-zinc-600"}`} />
              {user.status}
            </span>
            {user.employee_code && (
              <span className="text-zinc-500 font-mono" style={{ fontSize: "0.65rem", letterSpacing: "0.04em" }}>{user.employee_code}</span>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Contact Info */}
        <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-6" style={{ borderRadius: "0.75rem" }}>
          <h3 className="text-sm font-semibold text-zinc-900 mb-4" style={{ ...s, fontSize: "0.875rem", marginBottom: "1rem" }}>Contact Info</h3>
          <div className="space-y-4">
            {user.phone && (
              <div className="flex items-center gap-3">
                <Phone className="w-4 h-4 text-zinc-500" />
                <span className="text-zinc-700 text-sm" style={{ fontSize: "0.8rem" }}>{user.phone}</span>
              </div>
            )}
          </div>
        </div>

        {/* Status & Info */}
        <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-6" style={{ borderRadius: "0.75rem" }}>
          <h3 className="text-sm font-semibold text-zinc-900 mb-4" style={{ ...s, fontSize: "0.875rem", marginBottom: "1rem" }}>Status & Info</h3>
          <div className="flex items-center gap-3">
            <Shield className="w-4 h-4 text-zinc-500" />
            <span className="text-zinc-700 text-sm" style={{ fontSize: "0.8rem" }}>
              {user.isVerified ? "Verified" : "Unverified"}
            </span>
          </div>
          {user.parentUser && (
            <div className="mt-4 pt-4 border-t border-black/[0.06]">
              <div className="text-xs text-zinc-500 mb-1" style={{ fontSize: "0.7rem" }}>Reports to</div>
              <div className="text-sm text-zinc-700" style={{ fontSize: "0.8rem" }}>
                  {user.parentUser.name} ({user.parentUser.role?.replace(/_/g, " ") ?? "—"})
              </div>
            </div>
          )}
          <div className="mt-4 pt-4 border-t border-black/[0.06]">
            <div className="flex justify-between text-xs text-zinc-500" style={{ fontSize: "0.7rem" }}>
              <span>Joined</span>
              <span>{new Date(user.createdAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</span>
            </div>
            {user.lastLogin && (
              <div className="flex justify-between text-xs text-zinc-500 mt-2" style={{ fontSize: "0.7rem" }}>
                <span>Last Login</span>
                <span>{new Date(user.lastLogin).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</span>
              </div>
            )}
          </div>
        </div>

        {/* Performance */}
        <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-6" style={{ borderRadius: "0.75rem" }}>
          <h3 className="text-sm font-semibold text-zinc-900 mb-4" style={{ ...s, fontSize: "0.875rem", marginBottom: "1rem" }}>MTD Performance</h3>
          {perf ? (
            <div className="space-y-6">
              <div>
                <div className="text-xs text-zinc-500 mb-1" style={{ fontSize: "0.7rem" }}>Orders This Month</div>
                <div className="text-2xl font-bold text-zinc-900" style={{ ...s, fontSize: "1.5rem" }}>{perf.mtdOrders}</div>
              </div>
              <div>
                <div className="text-xs text-zinc-500 mb-1" style={{ fontSize: "0.7rem" }}>Sales This Month</div>
                <div className="text-2xl font-bold text-emerald-400" style={{ ...s, fontSize: "1.5rem" }}>{fmt(Number(perf.mtdSales))}</div>
              </div>
              <div>
                <div className="text-xs text-zinc-500 mb-1" style={{ fontSize: "0.7rem" }}>Outstanding Balance</div>
                <div className="text-2xl font-bold text-red-400" style={{ ...s, fontSize: "1.5rem" }}>{fmt(Number(perf.outstandingBalance))}</div>
              </div>
            </div>
          ) : (
            <p className="text-zinc-500 text-sm" style={{ fontSize: "0.8rem" }}>No performance data</p>
          )}
        </div>

        {/* Hierarchy Tree */}
        <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-6" style={{ borderRadius: "0.75rem" }}>
          <h3 className="text-sm font-semibold text-zinc-900 mb-4" style={{ ...s, fontSize: "0.875rem", marginBottom: "1rem" }}>Hierarchy</h3>
          {hierarchy ? (
            <div className="max-h-80 overflow-y-auto">
              <TreeNode node={hierarchy} />
            </div>
          ) : (
            <p className="text-zinc-500 text-sm" style={{ fontSize: "0.8rem" }}>No hierarchy data</p>
          )}
        </div>
      </div>
    </div>
  );
}
