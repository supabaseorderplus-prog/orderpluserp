"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { ArrowLeft, Building2, Loader2, Mail } from "lucide-react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await api("/api/v1/auth/forgot-password", {
        method: "POST",
        body: { email },
      });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f4f4f5] relative overflow-hidden">
      <div className="absolute inset-0">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-amber-500/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-amber-600/5 rounded-full blur-[120px]" />
      </div>

      <div className="relative z-10 w-full max-w-md mx-4">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-amber-500 to-amber-600 mb-4 shadow-lg shadow-amber-500/20">
            <Building2 className="w-8 h-8 text-zinc-900" />
          </div>
          <h1
            className="text-3xl font-bold text-zinc-900 tracking-tight"
            style={{ transform: "none", filter: "none", WebkitTextStroke: "0", fontSize: "1.875rem", background: "none", boxShadow: "none", display: "block", padding: 0, marginBottom: "0.5rem" }}
          >
            Reset Password
          </h1>
          <p className="text-zinc-600 text-sm" style={{ fontSize: "0.875rem" }}>
            Enter your email to receive a password reset link
          </p>
        </div>

        <div className="rounded-2xl border border-black/10 bg-black/5 backdrop-blur-xl p-8" style={{ borderRadius: "1rem" }}>
          {sent ? (
            <div className="text-center">
              <div className="w-12 h-12 rounded-full bg-emerald-500/20 flex items-center justify-center mx-auto mb-4">
                <Mail className="w-6 h-6 text-emerald-400" />
              </div>
              <h2 className="text-lg font-semibold text-zinc-900 mb-2" style={{ transform: "none", fontSize: "1.125rem", background: "none", display: "block", padding: 0 }}>
                Check your email
              </h2>
              <p className="text-zinc-600 text-sm mb-6" style={{ fontSize: "0.875rem" }}>
                If an account with that email exists, we&apos;ve sent a password reset link.
              </p>
              <Link
                href="/login"
                className="inline-flex items-center gap-2 text-amber-400 hover:text-amber-300 text-sm transition-colors"
                style={{ fontSize: "0.875rem", textDecoration: "none" }}
              >
                <ArrowLeft className="w-4 h-4" />
                Back to sign in
              </Link>
            </div>
          ) : (
            <>
              {error && (
                <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm" style={{ fontSize: "0.875rem" }}>
                  {error}
                </div>
              )}
              <form onSubmit={handleSubmit} className="space-y-5">
                <div>
                  <label className="block text-sm font-medium text-zinc-700 mb-2" style={{ fontSize: "0.875rem", transform: "none" }}>
                    Email Address
                  </label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500" />
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full pl-11 pr-4 py-3 rounded-xl bg-black/5 border border-black/10 text-zinc-900 placeholder-zinc-500 focus:outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/50 transition-all"
                      placeholder="your@email.com"
                      required
                      style={{ fontSize: "0.95rem", borderRadius: "0.75rem" }}
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 text-zinc-900 font-semibold hover:from-amber-600 hover:to-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                  style={{ fontSize: "1rem", borderRadius: "0.75rem", transform: "none", boxShadow: "none", border: "none", padding: "0.75rem", fontFamily: "inherit", textTransform: "none" }}
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    "Send Reset Link"
                  )}
                </button>
              </form>

              <div className="mt-6 text-center">
                <Link
                  href="/login"
                  className="inline-flex items-center gap-2 text-zinc-600 hover:text-zinc-900 text-sm transition-colors"
                  style={{ fontSize: "0.8rem", textDecoration: "none" }}
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back to sign in
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
