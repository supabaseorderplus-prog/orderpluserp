"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import BalanceSheet from "@/components/wallet/BalanceSheet";
import type { FinanceWallet } from "@/components/wallet/InternalFinances";
import { api } from "@/lib/api";
import { useVisibleInterval } from "@/lib/hooks/use-visible-interval";

export default function BalanceSheetPage() {
  const [wallets, setWallets] = useState<FinanceWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  const loadTreasury = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const response = await api<{ success: boolean; data: FinanceWallet[] }>("/api/v1/wallets", { noCache: true });
      setWallets((response.data || []).filter((wallet) => wallet.role_name !== "SUPER_ADMIN"));
      setReloadToken((token) => token + 1);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load the company treasury");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTreasury();
  }, [loadTreasury]);

  useVisibleInterval(() => {
    void loadTreasury(true);
  }, 30_000);

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      <BalanceSheet
        wallets={wallets}
        onViewExpenseRequests={() => window.location.assign("/dashboard/expenses")}
        reloadToken={reloadToken}
      />
    </div>
  );
}
