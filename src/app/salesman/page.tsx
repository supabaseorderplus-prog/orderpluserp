"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { api, isLoggedIn, getUser } from "@/lib/api";
import { Eye, EyeOff, Loader2, Lock, Phone, Users } from "lucide-react";

export default function SalesmanLoginPage() {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // If already logged in as salesman, skip straight to dashboard
  useEffect(() => {
    if (isLoggedIn()) {
      const user = getUser();
      if (user?.role === "SALESMAN") {
        router.replace("/dashboard/salesman");
      } else {
        setError("This portal is for salesmen only. Please use the main login.");
      }
    }
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await api<{
        success: boolean;
        data: {
          accessToken: string;
          refreshToken: string;
          user: { id: string; name: string; email: string; phone: string; role: string; role_id?: string; territoryId?: string | null };
        };
      }>("/api/v1/auth/login", {
        method: "POST",
        body: { phone, password, role: "SALESMAN" },
      });

      const user = res.data.user;

      // Extra client-side guard — only allow SALESMAN role
      if (user.role !== "SALESMAN") {
        setError("This portal is for salesmen only.");
        setLoading(false);
        return;
      }

      localStorage.setItem("accessToken", res.data.accessToken);
      localStorage.setItem("refreshToken", res.data.refreshToken);
      localStorage.setItem("user", JSON.stringify(user));

      router.push("/dashboard/salesman");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Login failed";
      if (/no account found/i.test(msg)) {
        setError("No salesman account found with this mobile number.");
      } else if (/invalid credentials/i.test(msg)) {
        setError("Wrong password. Please try again.");
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-[#f4f4f5] relative overflow-hidden"
      style={{ fontFamily: "'Inter', 'system-ui', sans-serif" }}
    >
      {/* Background gradient */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-cyan-500/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-cyan-600/5 rounded-full blur-[120px]" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(17,17,24,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(17,17,24,0.02)_1px,transparent_1px)] bg-[size:64px_64px]" />
      </div>

      <div className="relative z-10 w-full max-w-sm mx-4">
        {/* Brand */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-cyan-500 to-cyan-600 mb-4 shadow-lg shadow-cyan-500/20">
            <Users className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-zinc-900 tracking-tight mb-1">
            Order Plus ERP
          </h1>
          <p className="text-zinc-500 text-sm">Salesman Portal</p>
        </div>

        {/* Login Card */}
        <div className="rounded-2xl border border-black/10 bg-white/80 backdrop-blur-xl p-8 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900 mb-6">
            Sign in to your account
          </h2>

          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Phone */}
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-2">
                Mobile Number
              </label>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-400" />
                <input
                  type="tel"
                  inputMode="numeric"
                  value={phone}
                  onChange={(e) => { setPhone(e.target.value); setError(""); }}
                  className="w-full pl-11 pr-4 py-3 rounded-xl bg-black/5 border border-black/10 text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50 transition-all text-base"
                  placeholder="98765 43210"
                  required
                  autoComplete="tel"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-2">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-400" />
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(""); }}
                  className="w-full pl-11 pr-12 py-3 rounded-xl bg-black/5 border border-black/10 text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50 transition-all text-base"
                  placeholder="••••••••"
                  required
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 transition-colors"
                  style={{ background: "none", border: "none", padding: 0 }}
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-white font-semibold hover:from-cyan-600 hover:to-cyan-700 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 text-base"
              style={{ border: "none", cursor: "pointer", fontFamily: "inherit" }}
            >
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Signing in...
                </>
              ) : (
                "Sign In"
              )}
            </button>
          </form>
        </div>

        <p className="text-center text-zinc-400 text-xs mt-6">
          This portal is exclusively for Order Plus ERP salesmen.
        </p>
      </div>
    </div>
  );
}
