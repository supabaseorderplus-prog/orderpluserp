// Client-safe vendor types + fetch helpers. Kept separate from src/lib/vendors.ts,
// which imports the server-only Supabase admin client and must never reach the bundle.

export type VendorType = "CREDITOR" | "DEBTOR";
export type VendorTxnType = "BILL" | "PAYMENT" | "ADJUSTMENT";

export interface Vendor {
  id: string;
  vendor_code: string;
  name: string;
  trade_name: string | null;
  vendor_type: VendorType;
  gstin: string | null;
  pan: string | null;
  address_line1: string | null;
  city: string | null;
  pin_code: string | null;
  contact_person: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  contact_aadhaar_url: string | null;
  credit_limit: number;
  payment_terms_days: number;
  opening_balance: number;
  latitude: number | null;
  longitude: number | null;
  portal_phone: string | null;
  notes: string | null;
  status: string;
  is_verified?: boolean | null;
  verified_at?: string | null;
  verified_by?: string | null;
  current_balance?: number;
  created_at: string;
  updated_at: string;
}

export interface VendorTransaction {
  id: string;
  vendor_id: string;
  txn_type: VendorTxnType;
  amount: number;
  txn_date: string;
  reference_number: string | null;
  description: string | null;
  running_balance?: number;
  created_at: string;
}

export interface VendorFormState {
  name: string;
  trade_name: string;
  vendor_type: VendorType;
  gstin: string;
  pan: string;
  address_line1: string;
  city: string;
  pin_code: string;
  contact_person: string;
  contact_phone: string;
  credit_limit: string;
  payment_terms_days: string;
  opening_balance: string;
  latitude: string;
  longitude: string;
  portal_phone: string;
  portal_password: string;
  notes: string;
}

export const emptyVendorForm: VendorFormState = {
  name: "",
  trade_name: "",
  vendor_type: "CREDITOR",
  gstin: "",
  pan: "",
  address_line1: "",
  city: "",
  pin_code: "",
  contact_person: "",
  contact_phone: "",
  credit_limit: "0",
  payment_terms_days: "21",
  opening_balance: "0",
  latitude: "",
  longitude: "",
  portal_phone: "",
  portal_password: "",
  notes: "",
};

// Auth headers shared by every vendor API call (mirrors the parties page).
export function vendorAuthHeaders(): Record<string, string> {
  if (typeof window === "undefined") return { "Content-Type": "application/json" };
  const token = localStorage.getItem("accessToken");
  const companyId = localStorage.getItem("activeCompanyId");
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(companyId ? { "x-company-id": companyId } : {}),
  };
}

export const inr = (n: number): string =>
  `₹${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

// For a vendor, decide whether a positive net balance is a payable or receivable.
export function balanceLabel(vendor: Pick<Vendor, "vendor_type">, balance: number): {
  text: string;
  tone: "payable" | "receivable" | "settled";
} {
  if (Math.abs(balance) < 0.005) return { text: "Settled", tone: "settled" };
  const positiveIsPayable = vendor.vendor_type === "CREDITOR";
  const isPayable = positiveIsPayable ? balance > 0 : balance < 0;
  return isPayable
    ? { text: "You owe", tone: "payable" }
    : { text: "Owes you", tone: "receivable" };
}
