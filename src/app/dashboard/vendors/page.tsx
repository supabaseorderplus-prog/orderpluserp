"use client";

import { useEffect, useState } from "react";
import { Truck } from "lucide-react";
import { getActiveCompany, getModulePermission, type ModulePermission } from "@/lib/api";
import VendorsPanel from "@/app/dashboard/parties/VendorsPanel";

const VIEW_ONLY: ModulePermission = {
  can_view: true,
  can_create: false,
  can_edit: false,
  can_delete: false,
  can_approve: false,
};

export default function VendorsPage() {
  const [permissions, setPermissions] = useState<ModulePermission>(VIEW_ONLY);
  const [companyId, setCompanyId] = useState<string | null>(null);

  useEffect(() => {
    const syncCompany = () => setCompanyId(getActiveCompany().id);
    syncCompany();
    window.addEventListener("activeCompanyChanged", syncCompany);
    void getModulePermission("vendors").then(setPermissions);
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

      <VendorsPanel permissions={permissions} companyId={companyId} />
    </div>
  );
}
