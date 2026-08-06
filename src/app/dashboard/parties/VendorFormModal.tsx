"use client";

import { useEffect, useState } from "react";
import {
  X, Loader2, Smartphone, KeyRound, MapPin, Navigation, Eye, EyeOff,
} from "lucide-react";
import { Vendor, VendorFormState, emptyVendorForm, vendorAuthHeaders } from "./vendor-types";

const inp = "w-full px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-amber-500/40";
const is: React.CSSProperties = { fontSize: "0.8rem", fontFamily: "inherit" };
const lbl: React.CSSProperties = { fontSize: "0.75rem", display: "block", marginBottom: "0.25rem", color: "#a1a1aa" };

interface VendorFormModalProps {
  open: boolean;
  editing: Vendor | null;
  onClose: () => void;
  onSaved: (vendor: Vendor) => void;
}

async function readJsonSafe(res: Response): Promise<Record<string, unknown> | null> {
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return await res.json() as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  const text = await res.text().catch(() => "");
  return text ? { message: text } : null;
}

function positionToCoords(position: GeolocationPosition) {
  return {
    latitude: position.coords.latitude.toFixed(6),
    longitude: position.coords.longitude.toFixed(6),
  };
}

function toFormState(v: Vendor): VendorFormState {
  return {
    name: v.name || "",
    trade_name: v.trade_name || "",
    vendor_type: v.vendor_type,
    gstin: v.gstin || "",
    pan: v.pan || "",
    address_line1: v.address_line1 || "",
    city: v.city || "",
    pin_code: v.pin_code || "",
    contact_person: v.contact_person || "",
    contact_phone: v.contact_phone || "",
    credit_limit: String(v.credit_limit ?? 0),
    payment_terms_days: String(v.payment_terms_days ?? 21),
    opening_balance: String(v.opening_balance ?? 0),
    latitude: v.latitude != null ? String(v.latitude) : "",
    longitude: v.longitude != null ? String(v.longitude) : "",
    portal_phone: v.portal_phone || "",
    portal_password: "",
    notes: v.notes || "",
  };
}

export default function VendorFormModal({ open, editing, onClose, onSaved }: VendorFormModalProps) {
  const [form, setForm] = useState<VendorFormState>(emptyVendorForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsError, setGpsError] = useState("");
  const [portalPhoneTouched, setPortalPhoneTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(editing ? toFormState(editing) : emptyVendorForm);
    setError("");
    setGpsError("");
    setShowPassword(false);
    setPortalPhoneTouched(Boolean(editing?.portal_phone));
  }, [open, editing]);

  if (!open) return null;

  const set = (key: keyof VendorFormState, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const setContactPhone = (value: string) => {
    setForm((current) => ({
      ...current,
      contact_phone: value,
      portal_phone: portalPhoneTouched ? current.portal_phone : value,
    }));
  };

  const setPortalPhone = (value: string) => {
    setPortalPhoneTouched(true);
    set("portal_phone", value);
  };

  const useCurrentLocation = async () => {
    setGpsError("");
    if (!navigator.geolocation) {
      setGpsError("Geolocation not supported by your browser.");
      return;
    }

    if (!window.isSecureContext && window.location.hostname !== "localhost") {
      setGpsError("Location requires HTTPS. Use a secure connection or enter coordinates manually.");
      return;
    }

    const getPosition = (options: PositionOptions) =>
      new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, options);
      });

    setGpsLoading(true);
    try {
      const fastPosition = await getPosition({
        enableHighAccuracy: false,
        maximumAge: 300000,
        timeout: 5000,
      }).catch(() => null);

      if (fastPosition) {
        const coords = positionToCoords(fastPosition);
        setForm((current) => ({ ...current, ...coords }));
        setGpsError("");
        setGpsLoading(false);
        return;
      }

      const precisePosition = await getPosition({
        enableHighAccuracy: true,
        maximumAge: 10000,
        timeout: 20000,
      });
      const coords = positionToCoords(precisePosition);
      setForm((current) => ({ ...current, ...coords }));
      setGpsError("");
    } catch (geoError) {
      let message = "Unable to get location. Enter coordinates manually.";
      if (geoError && typeof geoError === "object" && "code" in geoError) {
        const { code } = geoError as GeolocationPositionError;
        if (code === 1) {
          message = "Location access denied. Allow location in the browser address bar, then try again.";
        } else if (code === 2) {
          message = "Location unavailable. Check device location settings and try again.";
        } else if (code === 3) {
          message = "Could not get a GPS fix in time. Move to an open area, enable device location, then try again.";
        }
      } else {
        message = "Location blocked by the browser. Allow location access or enter coordinates manually.";
      }
      setGpsError(message);
    } finally {
      setGpsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!form.name.trim()) { setError("Vendor name is required."); return; }
    setSaving(true);
    try {
      const payload = { ...form, portal_phone: form.portal_phone || undefined, portal_password: form.portal_password || undefined };
      const url = editing ? `/api/v1/vendors/${editing.id}` : "/api/v1/vendors";
      const res = await fetch(url, {
        method: editing ? "PATCH" : "POST",
        headers: vendorAuthHeaders(),
        body: JSON.stringify(payload),
      });
      const json = await readJsonSafe(res);
      if (!res.ok || !json?.success) {
        const message = typeof json?.message === "string" ? json.message : `Failed to save vendor (${res.status})`;
        throw new Error(message);
      }
      onSaved(json.data as Vendor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save vendor");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={onClose}>
      <div
        className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl mt-8"
        style={{ fontFamily: "'Inter','system-ui',sans-serif" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-black/[0.06]">
          <h2 className="font-bold text-zinc-900" style={{ fontSize: "1rem" }}>
            {editing ? "Edit Vendor" : "Add Vendor"}
          </h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700" style={{ background: "none", border: "none", cursor: "pointer" }}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="overflow-y-auto p-5 space-y-4" style={{ maxHeight: "calc(90vh - 65px)" }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label style={lbl}>Vendor Name *</label>
              <input required className={inp} style={is} value={form.name} onChange={(e) => set("name", e.target.value)} />
            </div>
            <div>
              <label style={lbl}>Trade / Display Name</label>
              <input className={inp} style={is} value={form.trade_name} onChange={(e) => set("trade_name", e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label style={lbl}>GSTIN</label>
              <input className={inp} style={is} placeholder="22AAAAA0000A1Z5" value={form.gstin} onChange={(e) => set("gstin", e.target.value.toUpperCase())} />
            </div>
            <div>
              <label style={lbl}>PAN</label>
              <input className={inp} style={is} placeholder="AAAAA0000A" value={form.pan} onChange={(e) => set("pan", e.target.value.toUpperCase())} />
            </div>
          </div>

          <div>
            <label style={lbl}>Address</label>
            <input className={inp} style={is} placeholder="Street, area, landmark" value={form.address_line1} onChange={(e) => set("address_line1", e.target.value)} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label style={lbl}>City</label>
              <input className={inp} style={is} placeholder="Kolkata" value={form.city} onChange={(e) => set("city", e.target.value)} />
            </div>
            <div>
              <label style={lbl}>PIN Code</label>
              <input className={inp} style={is} placeholder="700001" value={form.pin_code} onChange={(e) => set("pin_code", e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label style={lbl}>Contact Person</label>
              <input className={inp} style={is} value={form.contact_person} onChange={(e) => set("contact_person", e.target.value)} />
            </div>
            <div>
              <label style={lbl}>Contact Phone</label>
              <input className={inp} style={is} inputMode="tel" placeholder="+91 98765 43210" value={form.contact_phone} onChange={(e) => setContactPhone(e.target.value)} />
            </div>
          </div>
          {/* Financials */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label style={lbl}>Opening Balance (INR)</label>
              <input className={inp} style={is} type="number" step="any" value={form.opening_balance} onChange={(e) => set("opening_balance", e.target.value)} />
            </div>
            <div>
              <label style={lbl}>Credit Limit (INR)</label>
              <input className={inp} style={is} type="number" value={form.credit_limit} onChange={(e) => set("credit_limit", e.target.value)} />
            </div>
            <div>
              <label style={lbl}>Payment Terms (days)</label>
              <input className={inp} style={is} type="number" value={form.payment_terms_days} onChange={(e) => set("payment_terms_days", e.target.value)} />
            </div>
          </div>

          {/* GPS */}
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-emerald-600 font-semibold" style={{ fontSize: "0.75rem" }}>
                <MapPin className="w-3.5 h-3.5" /> GPS Location
              </span>
              <button type="button" onClick={useCurrentLocation} disabled={gpsLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-600 hover:bg-emerald-500/30 disabled:opacity-50 transition-all"
                style={{ fontSize: "0.72rem", border: "none", cursor: "pointer" }}>
                {gpsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Navigation className="w-3.5 h-3.5" />}
                Use Current Location
              </button>
            </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label style={lbl}>Latitude</label>
              <input className={inp} style={is} type="number" step="any" placeholder="e.g. 22.5726" value={form.latitude} onChange={(e) => set("latitude", e.target.value)} />
            </div>
            <div>
              <label style={lbl}>Longitude</label>
              <input className={inp} style={is} type="number" step="any" placeholder="e.g. 88.363892" value={form.longitude} onChange={(e) => set("longitude", e.target.value)} />
            </div>
          </div>
          {gpsError && <p className="text-rose-500" style={{ fontSize: "0.72rem" }}>{gpsError}</p>}
        </div>

          {/* Portal access */}
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4 space-y-3">
            <div className="flex items-center gap-2">
              <KeyRound className="w-3.5 h-3.5 text-amber-500" />
              <span className="text-amber-600 font-semibold" style={{ fontSize: "0.75rem" }}>Portal Access</span>
              <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>— optional vendor login</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="flex items-center gap-1" style={lbl}><Smartphone className="w-3 h-3" /> Portal Phone (Login ID)</label>
                <input className={inp} style={is} inputMode="tel" placeholder="98765 43210" value={form.portal_phone} onChange={(e) => setPortalPhone(e.target.value)} />
              </div>
              <div>
                <label className="flex items-center gap-1" style={lbl}><KeyRound className="w-3 h-3" /> Portal Password</label>
                <div className="relative">
                  <input className={inp} style={{ ...is, paddingRight: "2.5rem" }} type={showPassword ? "text" : "password"}
                    placeholder={editing ? "Leave blank to keep" : "Set a password"} value={form.portal_password} onChange={(e) => set("portal_password", e.target.value)} />
                  <button type="button" onClick={() => setShowPassword((s) => !s)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-700"
                    style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                    {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div>
            <label style={lbl}>Notes</label>
            <textarea className={inp} style={{ ...is, minHeight: "60px", resize: "vertical" }} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
          </div>

          {error && <p className="text-rose-500" style={{ fontSize: "0.78rem" }}>{error}</p>}

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5"
              style={{ fontSize: "0.8rem", background: "none", cursor: "pointer" }}>
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="px-6 py-2 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-600 disabled:opacity-50 flex items-center gap-2"
              style={{ fontSize: "0.8rem", border: "none", cursor: "pointer" }}>
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {editing ? "Save Changes" : "Create Vendor"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
