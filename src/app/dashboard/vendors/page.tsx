"use client";

import { useEffect, useState } from "react";
import { Truck } from "lucide-react";
import { getActiveCompany, getModulePermission } from "@/lib/api";
import VendorsPanel from "@/app/dashboard/parties/VendorsPanel";

export default function VendorsPage() {
  const [canCreate, setCanCreate] = useState(false);
  const [companyId, setCompanyId] = useState<string | null>(null);

  useEffect(() => {
    const syncCompany = () => setCompanyId(getActiveCompany().id);
    syncCompany();
    window.addEventListener("activeCompanyChanged", syncCompany);
    void getModulePermission("parties").then((permission) => setCanCreate(permission.can_create));
    return () => window.removeEventListener("activeCompanyChanged", syncCompany);
  }, []);

  return (
    <div style={{ fontFamily: "'Inter', 'system-ui', sans-serif" }}>
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/10 text-amber-500">
          <Truck className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-zinc-900">Vendors</h1>
          <p className="text-xs text-zinc-500">Manage suppliers, balances, verification, and vendor ledgers.</p>
        </div>
      </div>

      <VendorsPanel canCreate={canCreate} companyId={companyId} />
    </div>
  );
}
