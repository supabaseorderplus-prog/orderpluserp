"use client";

import { useEffect, useState, useCallback } from "react";
import { api, getActiveCompany } from "@/lib/api";
import { Loader2, Search, Users as UsersIcon, Plus, X, Eye, EyeOff, Trash2, Upload, Camera, CreditCard, FileDown, KeyRound, UserCheck, UserX } from "lucide-react";

interface User {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: string;
  companyName: string | null;
  isActive: boolean;
  createdAt: string;
  employee_code: string | null;
  photo_url: string | null;
}

interface Role {
  id: string;
  name: string;
}

interface PartyUser {
  id: string;
  name: string;
  email: string;
}

const roleLabel = (role: string, companyName: string | null) => {
  if (role === "ADMIN") return companyName ? `Admin — ${companyName}` : "Admin";
  return role.replace(/_/g, " ");
};

const roleColors: Record<string, string> = {
  SUPER_ADMIN: "bg-red-500/20 text-red-400",
  ADMIN: "bg-amber-500/20 text-amber-400",
  SALES_MANAGER: "bg-blue-500/20 text-blue-400",
  TERRITORY_MANAGER: "bg-cyan-500/20 text-cyan-400",
  SALESMAN: "bg-green-500/20 text-green-400",
  WAREHOUSE_MANAGER: "bg-indigo-500/20 text-indigo-400",
  ACCOUNTS_MANAGER: "bg-teal-500/20 text-teal-400",
  AUDITOR: "bg-violet-500/20 text-violet-400",
  CNF_USER: "bg-orange-500/20 text-orange-400",
  SUPER_DEALER_USER: "bg-pink-500/20 text-pink-400",
  RETAILER_USER: "bg-rose-500/20 text-rose-400",
  DRIVER: "bg-sky-500/20 text-sky-400",
};

const canDownloadJoiningLetter = (u: User) => u.role !== "ADMIN";

// Party/external roles — excluded from this page (this page shows only internal/staff users)
const PARTY_ROLES = ["CNF_USER", "SUPER_DEALER_USER", "RETAILER_USER"];
// Roles excluded from create form
const BASE_EXCLUDED_ROLES = ["SUPER_ADMIN", ...PARTY_ROLES];
const USERS_FETCH_BATCH_SIZE = 100;

const s: React.CSSProperties = { transform: "none", filter: "none", WebkitTextStroke: "0", background: "none", boxShadow: "none", display: "block", padding: 0 };
const inputStyle: React.CSSProperties = { fontSize: "0.8rem", fontFamily: "inherit" };

export default function UsersPage() {
  const EXCLUDED_ROLES = BASE_EXCLUDED_ROLES;

  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [roles, setRoles] = useState<Role[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [form, setForm] = useState({ name: "", email: "", phone: "", employee_code: "", role_id: "", status: "ACTIVE", password: "", parent_user_id: "", company_id: "", aadhaar_number: "", photo_url: "" });
  const [activeCompanyName, setActiveCompanyName] = useState("");
  const [previewEmpCode, setPreviewEmpCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [superDealers, setSuperDealers] = useState<PartyUser[]>([]);
  const [loadingSuperDealers, setLoadingSuperDealers] = useState(false);
  const [cnfUsers, setCnfUsers] = useState<PartyUser[]>([]);
  const [loadingCnfUsers, setLoadingCnfUsers] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [pwTarget, setPwTarget] = useState<User | null>(null);
  const [pwValue, setPwValue] = useState("");
  const [pwShow, setPwShow] = useState(false);
  const [pwSaving, setPwSaving] = useState(false);
  const [pwError, setPwError] = useState("");
  const [pwSuccess, setPwSuccess] = useState("");
  const [statusUpdatingId, setStatusUpdatingId] = useState<string | null>(null);
  const [statusError, setStatusError] = useState("");

    const fetchUsers = useCallback(async () => {
      setLoading(true);
      try {
        const makeParams = (batchPage: number) => {
          const params = new URLSearchParams({
            page: String(batchPage),
            limit: String(USERS_FETCH_BATCH_SIZE),
            exclude_roles: PARTY_ROLES.join(","),
          });
          if (search) params.set("search", search);
          if (roleFilter) params.set("role", roleFilter);
          return params;
        };

        const firstBatch = await api<{ data: User[]; meta: { total: number; page: number; totalPages: number } }>(`/api/v1/users?${makeParams(1)}`);
        const allUsers = [...(firstBatch.data || [])];
        const batchCount = firstBatch.meta?.totalPages || 1;

        for (let batchPage = 2; batchPage <= batchCount; batchPage += 1) {
          const batch = await api<{ data: User[] }>(`/api/v1/users?${makeParams(batchPage)}`);
          allUsers.push(...(batch.data || []));
        }

        setUsers(allUsers);
        setTotal(firstBatch.meta?.total ?? allUsers.length);
      } catch {
        setUsers([]);
      }
      setLoading(false);
    }, [search, roleFilter]);

  const fetchRoles = useCallback(async () => {
    try {
      const res = await api<{ data: Role[] }>("/api/v1/roles");
      setRoles(res.data || []);
    } catch { setRoles([]); }
  }, []);

  useEffect(() => { fetchUsers(); fetchRoles(); }, [fetchUsers, fetchRoles]);

  const openCreate = async () => {
    const activeCompany = getActiveCompany();
    setForm({ name: "", email: "", phone: "", employee_code: "", role_id: "", status: "ACTIVE", password: "", parent_user_id: "", company_id: activeCompany?.id || "", aadhaar_number: "", photo_url: "" });
    setActiveCompanyName(activeCompany?.name || "");
    setShowPassword(false);
    setCreateError("");
    setPhotoError("");
    setPhotoPreview(null);
    setSuperDealers([]);
    setCnfUsers([]);
    fetchRoles();

    // Preview employee code
    if (activeCompany?.name && activeCompany?.id) {
      const prefix = activeCompany.name.substring(0, 2).toUpperCase();
      setPreviewEmpCode(`${prefix}EMP...`);
      try {
        const res = await api<{ nextCode: string }>(`/api/v1/users/next-emp-code?party_id=${activeCompany.id}&company_name=${encodeURIComponent(activeCompany.name)}`);
        setPreviewEmpCode(res.nextCode || `${prefix}EMP001`);
      } catch { setPreviewEmpCode(`${prefix}EMP001`); }
    } else {
      setPreviewEmpCode("");
    }

    setShowCreate(true);
  };

  const fetchSuperDealers = useCallback(async () => {
    setLoadingSuperDealers(true);
    try {
      const res = await api<{ data: { tree: { id: string; name: string; level: string; children: { id: string; name: string; level: string }[] }[]; unattachedSD: { id: string; name: string; level: string }[] } }>("/api/v1/downline");
      const tree = res.data?.tree || [];
      const unattached = res.data?.unattachedSD || [];
      const fromTree: PartyUser[] = [];
      tree.forEach(cnf => {
        (cnf.children || []).forEach(sd => {
          if (sd.level === "SUPER_DEALER") fromTree.push({ id: sd.id, name: sd.name, email: "" });
        });
      });
      const allSD = [...fromTree, ...unattached.map(u => ({ id: u.id, name: u.name, email: "" }))];
      setSuperDealers(allSD);
    } catch { setSuperDealers([]); }
    setLoadingSuperDealers(false);
  }, []);

  const fetchCnfUsers = useCallback(async () => {
    setLoadingCnfUsers(true);
    try {
      const res = await api<{ data: { tree: { id: string; name: string; level: string }[] } }>("/api/v1/downline");
      const cnfs = (res.data?.tree || []).filter(n => n.level === "CNF").map(n => ({ id: n.id, name: n.name, email: "" }));
      setCnfUsers(cnfs);
    } catch { setCnfUsers([]); }
    setLoadingCnfUsers(false);
  }, []);

  const handlePhotoUpload = async (file: File) => {
    setPhotoError("");
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setPhotoError("Only JPEG, PNG, or WebP images allowed.");
      return;
    }
    if (file.size > 3 * 1024 * 1024) { setPhotoError("File too large. Max 3MB."); return; }
    setPhotoUploading(true);
    try {
      const fd = new FormData();
      fd.append("photo", file);
      const token = typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;
      const companyId = typeof window !== "undefined" ? localStorage.getItem("activeCompanyId") : null;
      const res = await fetch("/api/v1/upload/user-photo", {
        method: "POST",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(companyId ? { "x-company-id": companyId } : {}) },
        body: fd,
      });
      const json = await res.json();
      if (!res.ok || !json.success) { setPhotoError(json.message || "Upload failed"); return; }
      setForm(f => ({ ...f, photo_url: json.data.url }));
      setPhotoPreview(json.data.url);
    } catch { setPhotoError("Upload failed. Try again."); }
    finally { setPhotoUploading(false); }
  };

  const handleCreate = async () => {
    if (!form.company_id) { setCreateError("Please select the company this user belongs to"); return; }
    if (!form.name.trim() || !form.role_id) { setCreateError("Name and role are required"); return; }
    const selectedRole = roles.find(r => r.id === form.role_id);
    if (selectedRole?.name === "SUPER_ADMIN" && !form.email.trim()) { setCreateError("Email is required for Super Admin"); return; }
    if (selectedRole?.name !== "SUPER_ADMIN" && !form.phone.trim()) { setCreateError("Phone number is required"); return; }
    if (!form.password.trim() || form.password.length < 6) { setCreateError("Password must be at least 6 characters"); return; }
    if (selectedRole?.name === "RETAILER_USER" && !form.parent_user_id) { setCreateError("Please select the Super Dealer this retailer belongs to"); return; }
    if (selectedRole?.name === "SUPER_DEALER_USER" && !form.parent_user_id) { setCreateError("Please select the CNF this Super Dealer belongs to"); return; }
    setCreating(true);
    setCreateError("");
    try {
      // Only include email for SUPER_ADMIN, otherwise omit it so backend generates unique email
      const payload: Record<string, unknown> = { ...form, party_id: form.company_id };
      if (selectedRole?.name !== "SUPER_ADMIN") delete (payload as Record<string, unknown>).email;
      if (form.aadhaar_number) payload.aadhaar_number = form.aadhaar_number.replace(/\s/g, "");
      await api("/api/v1/users", { method: "POST", body: payload });
      setShowCreate(false);
      fetchUsers();
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : "Failed to create user");
    }
      setCreating(false);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await api(`/api/v1/users?id=${deleteTarget.id}`, { method: "DELETE" });
      setDeleteTarget(null);
      fetchUsers();
    } catch (e: unknown) {
      setDeleteError(e instanceof Error ? e.message : "Failed to delete user");
    }
    setDeleting(false);
  };

  const handleChangePassword = async () => {
    if (!pwTarget) return;
    if (pwValue.length < 6) { setPwError("Password must be at least 6 characters"); return; }
    setPwSaving(true); setPwError(""); setPwSuccess("");
    try {
      await api(`/api/v1/users/${pwTarget.id}/password`, { method: "POST", body: { new_password: pwValue } });
      setPwSuccess("Password updated. The user can now login with their phone number and new password.");
      setPwValue("");
    } catch (e: unknown) {
      setPwError(e instanceof Error ? e.message : "Failed to update password");
    }
    setPwSaving(false);
  };

  const handleToggleActive = async (u: User) => {
    const nextStatus = u.isActive ? "INACTIVE" : "ACTIVE";
    if (u.isActive) {
      const ok = window.confirm(`Deactivate ${u.name}? They will not be able to login, and their wallet will be inactive/hidden until you activate them again.`);
      if (!ok) return;
    }

    setStatusUpdatingId(u.id);
    setStatusError("");
    try {
      await api(`/api/v1/users/${u.id}`, { method: "PATCH", body: { status: nextStatus } });
      setUsers(prev => prev.map(item => item.id === u.id ? { ...item, isActive: nextStatus === "ACTIVE" } : item));
    } catch (e: unknown) {
      setStatusError(e instanceof Error ? e.message : "Failed to update user status");
    }
    setStatusUpdatingId(null);
  };

  const downloadJoiningLetter = (u: User) => {
    if (!canDownloadJoiningLetter(u)) return;

    const company = u.companyName || "Your Company";
    const joinDate = new Date(u.createdAt).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });
    const empCode = u.employee_code || "—";
    const role = u.role.replace(/_/g, " ");
    const initials = u.name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Joining Letter — ${u.name}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Inter',Arial,sans-serif;color:#18181b;background:#fff;min-height:100vh;display:flex;flex-direction:column}
  .page{width:794px;min-height:1123px;margin:0 auto;display:flex;flex-direction:column;padding:0}
  /* HEADER */
  .header{background:#18181b;color:#fff;padding:32px 48px 28px;display:flex;align-items:center;justify-content:space-between;gap:24px}
  .header-logo{width:52px;height:52px;border-radius:14px;background:linear-gradient(135deg,#f59e0b,#d97706);display:flex;align-items:center;justify-content:center;font-size:1.4rem;font-weight:700;color:#000;flex-shrink:0}
  .header-text{flex:1}
  .header-company{font-size:1.25rem;font-weight:700;letter-spacing:-0.01em;line-height:1.2}
  .header-tagline{font-size:0.72rem;color:#a1a1aa;margin-top:3px;text-transform:uppercase;letter-spacing:0.08em}
  .header-doc{text-align:right}
  .header-doc-label{font-size:0.62rem;text-transform:uppercase;letter-spacing:0.1em;color:#a1a1aa}
  .header-doc-num{font-size:0.85rem;font-weight:600;color:#f59e0b;font-family:monospace;margin-top:2px}
  /* BODY */
  .body{flex:1;padding:40px 48px}
  .title-row{display:flex;align-items:center;gap:16px;margin-bottom:32px;padding-bottom:20px;border-bottom:2px solid #f4f4f5}
  .title-badge{background:#f59e0b;color:#000;font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;padding:4px 12px;border-radius:4px}
  .title-text{font-size:1.4rem;font-weight:700;color:#18181b;letter-spacing:-0.02em}
  .date-right{margin-left:auto;font-size:0.75rem;color:#71717a}
  /* AVATAR + NAME */
  .user-card{display:flex;align-items:center;gap:20px;background:#fafafa;border:1.5px solid #f4f4f5;border-radius:14px;padding:20px 24px;margin-bottom:28px}
  .avatar{width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#e4e4e7,#d4d4d8);display:flex;align-items:center;justify-content:center;font-size:1.3rem;font-weight:700;color:#3f3f46;flex-shrink:0;overflow:hidden;border:2px solid #e4e4e7}
  .avatar img{width:100%;height:100%;object-fit:cover;border-radius:50%}
  .user-name{font-size:1.1rem;font-weight:700;color:#18181b}
  .user-role{font-size:0.72rem;color:#a1a1aa;text-transform:uppercase;letter-spacing:0.08em;margin-top:3px}
  /* GREETING */
  .greeting{font-size:0.92rem;line-height:1.75;color:#3f3f46;margin-bottom:24px}
  .greeting strong{color:#18181b}
  /* DETAILS TABLE */
  .details-title{font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#a1a1aa;margin-bottom:12px}
  .details-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:28px}
  .detail-box{background:#fafafa;border:1px solid #f4f4f5;border-radius:10px;padding:12px 16px}
  .detail-label{font-size:0.62rem;text-transform:uppercase;letter-spacing:0.08em;color:#a1a1aa;margin-bottom:4px}
  .detail-value{font-size:0.85rem;font-weight:600;color:#18181b}
  /* BODY TEXT */
  .body-text{font-size:0.875rem;line-height:1.8;color:#52525b;margin-bottom:16px}
  /* SIGNATURE */
  .sig-section{padding:24px 48px 28px;display:flex;justify-content:space-between;align-items:flex-end;border-top:1.5px solid #f4f4f5}
  .sig-block{text-align:left}
  .sig-line{width:160px;border-bottom:1.5px solid #d4d4d8;margin-bottom:8px}
  .sig-name{font-size:0.8rem;font-weight:600;color:#18181b}
  .sig-title{font-size:0.68rem;color:#a1a1aa;text-transform:uppercase;letter-spacing:0.06em}
  .seal{width:72px;height:72px;border-radius:50%;border:2px dashed #d4d4d8;display:flex;align-items:center;justify-content:center;font-size:0.55rem;color:#a1a1aa;text-align:center;line-height:1.4;text-transform:uppercase;letter-spacing:0.06em}
  /* FOOTER */
  .footer{background:#fafafa;border-top:1.5px solid #f4f4f5;padding:18px 48px;display:flex;align-items:center;justify-content:space-between;gap:16px}
  .footer-company{font-size:0.75rem;font-weight:600;color:#18181b}
  .footer-note{font-size:0.65rem;color:#a1a1aa;text-align:center}
  .footer-page{font-size:0.65rem;color:#a1a1aa}
  @media print{body{print-color-adjust:exact;-webkit-print-color-adjust:exact}.no-print{display:none!important}@page{margin:0;size:A4}}
</style>
</head>
<body>
<div class="page">
  <!-- HEADER -->
  <div class="header">
    <div class="header-logo">${u.photo_url ? `<img src="${u.photo_url}" style="width:100%;height:100%;object-fit:cover;border-radius:14px;" />` : initials}</div>
    <div class="header-text">
      <div class="header-company">${company}</div>
      <div class="header-tagline">Official Document · Confidential</div>
    </div>
    <div class="header-doc">
      <div class="header-doc-label">Document No.</div>
      <div class="header-doc-num">${empCode}/JL/${new Date().getFullYear()}</div>
    </div>
  </div>

  <!-- BODY -->
  <div class="body">
    <div class="title-row">
      <span class="title-badge">Joining Letter</span>
      <span class="title-text">Letter of Appointment</span>
      <span class="date-right">Date: ${joinDate}</span>
    </div>

    <div class="user-card">
      <div class="avatar">${u.photo_url ? `<img src="${u.photo_url}" alt="${u.name}" />` : initials}</div>
      <div>
        <div class="user-name">${u.name}</div>
        <div class="user-role">${role}</div>
      </div>
    </div>

    <p class="greeting">
      Dear <strong>${u.name}</strong>,<br/><br/>
      We are pleased to inform you that you have been appointed as <strong>${role}</strong> at
      <strong>${company}</strong>, effective <strong>${joinDate}</strong>. We extend a warm
      welcome to you and look forward to your valuable contributions to our team.
    </p>

    <div class="details-title">Employment Details</div>
    <div class="details-grid">
      <div class="detail-box">
        <div class="detail-label">Full Name</div>
        <div class="detail-value">${u.name}</div>
      </div>
      <div class="detail-box">
        <div class="detail-label">Employee ID</div>
        <div class="detail-value">${empCode}</div>
      </div>
      <div class="detail-box">
        <div class="detail-label">Designation</div>
        <div class="detail-value">${role}</div>
      </div>
      <div class="detail-box">
        <div class="detail-label">Date of Joining</div>
        <div class="detail-value">${joinDate}</div>
      </div>
      <div class="detail-box">
        <div class="detail-label">Contact</div>
        <div class="detail-value">${u.phone || "—"}</div>
      </div>
      <div class="detail-box">
        <div class="detail-label">Company</div>
        <div class="detail-value">${company}</div>
      </div>
    </div>

    <p class="body-text">
      You are required to adhere to all company policies, rules, and regulations as communicated
      from time to time. This letter serves as your official confirmation of employment.
      Please sign and return a copy of this letter as acknowledgement of your acceptance.
    </p>
    <p class="body-text">
      We wish you a successful and rewarding career with <strong>${company}</strong>.
    </p>
  </div>

  <!-- SIGNATURE — outside body so it always sits directly above the footer -->
  <div class="sig-section">
    <div class="sig-block">
      <div class="sig-line"></div>
      <div class="sig-name">Authorised Signatory</div>
      <div class="sig-title">${company}</div>
    </div>
    <div class="seal">Company<br/>Seal</div>
    <div class="sig-block" style="text-align:right">
      <div class="sig-line" style="margin-left:auto"></div>
      <div class="sig-name">${u.name}</div>
      <div class="sig-title">Employee Signature</div>
    </div>
  </div>

  <!-- FOOTER PAGE 1 -->
  <div class="footer">
    <div class="footer-company">${company}</div>
    <div class="footer-note">This is a system-generated document. For queries contact HR.</div>
    <div class="footer-page">Page 1 of 2</div>
  </div>
</div>

<!-- PAGE 2 — EMPLOYEE AGREEMENT -->
<div class="page" style="margin-top:0;page-break-before:always">
  <!-- HEADER -->
  <div class="header">
    <div class="header-logo">${u.photo_url ? `<img src="${u.photo_url}" style="width:100%;height:100%;object-fit:cover;border-radius:14px;" />` : initials}</div>
    <div class="header-text">
      <div class="header-company">${company}</div>
      <div class="header-tagline">Official Legal Employee Agreement · Confidential</div>
    </div>
    <div class="header-doc">
      <div class="header-doc-label">Document No.</div>
      <div class="header-doc-num">${empCode}/EA/${new Date().getFullYear()}</div>
    </div>
  </div>

  <div class="body" style="display:flex;flex-direction:column">
    <!-- AGREEMENT TITLE -->
    <div style="text-align:center;margin-bottom:24px;padding-bottom:16px;border-bottom:2px solid #f4f4f5">
      <div style="font-size:1.2rem;font-weight:700;color:#18181b;letter-spacing:-0.01em">EMPLOYEE AGREEMENT</div>
      <div style="font-size:0.78rem;color:#71717a;margin-top:4px">(Official Legal Document)</div>
    </div>

    <!-- PREAMBLE -->
    <p style="font-size:0.85rem;line-height:1.8;color:#3f3f46;margin-bottom:20px">
      This Agreement is made and entered into on this
      <strong>${new Date(u.createdAt).getDate()} day of ${new Date(u.createdAt).toLocaleDateString("en-IN",{month:"long"})}, ${new Date(u.createdAt).getFullYear()}</strong>,
      between <strong>${company}</strong> (hereinafter referred to as the <em>"Company"</em>) and
      <strong>${u.name}</strong> (hereinafter referred to as the <em>"Employee"</em>).
    </p>
    <p style="font-size:0.85rem;line-height:1.8;color:#3f3f46;margin-bottom:20px">
      The Employee agrees to the following legally binding terms and conditions:
    </p>

    <!-- TERMS -->
    <div style="display:grid;gap:12px;margin-bottom:28px">

      <div style="padding:12px 16px;background:#fafafa;border:1px solid #f4f4f5;border-radius:10px">
        <div style="font-size:0.78rem;font-weight:700;color:#18181b;margin-bottom:4px">1. Duty &amp; Attendance</div>
        <div style="font-size:0.8rem;line-height:1.7;color:#52525b">The Employee must strictly follow assigned duty hours. Daily check-in, check-out, and proper marking of all visits are mandatory.</div>
      </div>

      <div style="padding:12px 16px;background:#fafafa;border:1px solid #f4f4f5;border-radius:10px">
        <div style="font-size:0.78rem;font-weight:700;color:#18181b;margin-bottom:4px">2. Authorization of Business Deals</div>
        <div style="font-size:0.8rem;line-height:1.7;color:#52525b">The Employee shall not finalize any scheme, offer, or deal with any retailer without prior written or verbal approval from the Company or reporting authority.</div>
      </div>

      <div style="padding:12px 16px;background:#fafafa;border:1px solid #f4f4f5;border-radius:10px">
        <div style="font-size:0.78rem;font-weight:700;color:#18181b;margin-bottom:4px">3. Payment &amp; Collection Policy</div>
        <div style="font-size:0.8rem;line-height:1.7;color:#52525b">The Employee is strictly prohibited from receiving any payment in personal bank accounts. All cash collections must be supported by an official receipt and real-time entry in the Company's software.</div>
      </div>

      <div style="padding:12px 16px;background:#fafafa;border:1px solid #f4f4f5;border-radius:10px">
        <div style="font-size:0.78rem;font-weight:700;color:#18181b;margin-bottom:4px">4. Market Outstanding Liability</div>
        <div style="font-size:0.8rem;line-height:1.7;color:#52525b">The Employee shall be fully responsible and liable for all outstanding dues within their assigned market territory.</div>
      </div>

      <div style="padding:12px 16px;background:#fafafa;border:1px solid #f4f4f5;border-radius:10px">
        <div style="font-size:0.78rem;font-weight:700;color:#18181b;margin-bottom:4px">5. Follow-up Responsibility</div>
        <div style="font-size:0.8rem;line-height:1.7;color:#52525b">The Employee must ensure regular follow-up with juniors, retailers, dealers, super dealers, and CNF agents to maintain business operations and collections.</div>
      </div>

      <div style="padding:12px 16px;background:#fafafa;border:1px solid #f4f4f5;border-radius:10px">
        <div style="font-size:0.78rem;font-weight:700;color:#18181b;margin-bottom:4px">6. Monthly Statement Compliance</div>
        <div style="font-size:0.8rem;line-height:1.7;color:#52525b">The Employee must update statements regularly and obtain signed hard copies from each retailer at least once every month.</div>
      </div>

      <div style="padding:12px 16px;background:#fafafa;border:1px solid #f4f4f5;border-radius:10px">
        <div style="font-size:0.78rem;font-weight:700;color:#18181b;margin-bottom:4px">7. Financial Discrepancy Clause</div>
        <div style="font-size:0.8rem;line-height:1.7;color:#52525b">In case of any financial dispute, mismatch, or shortage, the Employee shall be personally liable to compensate the Company for the full amount without delay.</div>
      </div>

      <div style="padding:12px 16px;background:#fafafa;border:1px solid #f4f4f5;border-radius:10px">
        <div style="font-size:0.78rem;font-weight:700;color:#18181b;margin-bottom:4px">8. Security &amp; Documentation</div>
        <div style="font-size:0.8rem;line-height:1.7;color:#52525b">The Employee shall submit three signed blank cheques, passport-size photographs, and valid KYC documents at the time of joining.</div>
      </div>

      <div style="padding:12px 16px;background:#fafafa;border:1px solid #f4f4f5;border-radius:10px">
        <div style="font-size:0.78rem;font-weight:700;color:#18181b;margin-bottom:4px">9. Confidentiality Clause</div>
        <div style="font-size:0.8rem;line-height:1.7;color:#52525b">The Employee shall not disclose any confidential information including pricing, customer data, or business strategies during or after employment.</div>
      </div>

      <div style="padding:12px 16px;background:#fafafa;border:1px solid #f4f4f5;border-radius:10px">
        <div style="font-size:0.78rem;font-weight:700;color:#18181b;margin-bottom:4px">10. Termination by Company</div>
        <div style="font-size:0.8rem;line-height:1.7;color:#52525b">The Company reserves the right to terminate employment without prior notice in case of misconduct, fraud, negligence, or violation of company policies.</div>
      </div>

      <div style="padding:12px 16px;background:#fafafa;border:1px solid #f4f4f5;border-radius:10px">
        <div style="font-size:0.78rem;font-weight:700;color:#18181b;margin-bottom:4px">11. Resignation by Employee</div>
        <div style="font-size:0.8rem;line-height:1.7;color:#52525b">The Employee must provide a minimum of 2 months prior written notice before leaving the job. The Employee must complete full handover of all data, accounts, collections, and responsibilities with proper accountability. Failure to do so will result in legal action and recovery of losses from the Employee.</div>
      </div>

      <div style="padding:12px 16px;background:#fafafa;border:1px solid #f4f4f5;border-radius:10px">
        <div style="font-size:0.78rem;font-weight:700;color:#18181b;margin-bottom:4px">12. Legal Jurisdiction</div>
        <div style="font-size:0.8rem;line-height:1.7;color:#52525b">Any disputes arising from this agreement shall be subject to the jurisdiction of the local courts where the Company operates.</div>
      </div>
    </div>

    <!-- DECLARATION -->
    <div style="background:#fffbeb;border:1.5px solid #fde68a;border-radius:12px;padding:16px 20px;margin-bottom:28px">
      <div style="font-size:0.78rem;font-weight:700;color:#92400e;margin-bottom:6px">Declaration</div>
      <div style="font-size:0.82rem;line-height:1.7;color:#78350f">I hereby declare that I have read, understood, and agree to all the above terms and conditions.</div>
    </div>

    <!-- SPACER pushes signature to very bottom -->
    <div style="flex:1"></div>

    <!-- SIGNATURE SECTION — pinned to bottom -->
    <div style="margin-top:auto;padding-top:28px;border-top:2px solid #f4f4f5">
      <div style="font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#a1a1aa;margin-bottom:32px">Signatures &amp; Acknowledgement</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:48px">
        <div>
          <div style="height:48px"></div>
          <div style="border-bottom:1.5px solid #18181b;margin-bottom:10px"></div>
          <div style="font-size:0.82rem;font-weight:700;color:#18181b">${u.name}</div>
          <div style="font-size:0.7rem;color:#71717a;margin-top:3px">${role}</div>
          <div style="font-size:0.68rem;color:#a1a1aa;margin-top:2px">Date: ${joinDate}</div>
        </div>
        <div>
          <div style="height:48px"></div>
          <div style="border-bottom:1.5px solid #18181b;margin-bottom:10px"></div>
          <div style="font-size:0.82rem;font-weight:700;color:#18181b">Authorised Signatory</div>
          <div style="font-size:0.7rem;color:#71717a;margin-top:3px">${company}</div>
          <div style="font-size:0.68rem;color:#a1a1aa;margin-top:2px">Date: ____________________</div>
        </div>
      </div>
    </div>
  </div>

  <!-- FOOTER PAGE 2 -->
  <div class="footer">
    <div class="footer-company">${company}</div>
    <div class="footer-note">Official Legal Employee Agreement · Confidential</div>
    <div class="footer-page">Page 2 of 2</div>
  </div>
</div>

<script>window.onload=()=>{window.print()}</script>
</body>
</html>`;

    const win = window.open("", "_blank", "width=900,height=700");
    if (win) { win.document.write(html); win.document.close(); }
  };

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      <div className="flex items-center justify-between mb-4 lg:mb-6">
        <div>
          <h1 className="text-xl lg:text-2xl font-bold text-zinc-900" style={{ ...s, marginBottom: "0.25rem" }}>Users</h1>
          <p className="text-zinc-600" style={{ fontSize: "0.8rem", margin: 0 }}>{total} registered users</p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 px-3 py-2 lg:px-4 lg:py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-medium transition-colors"
          style={{ fontSize: "0.8rem", fontFamily: "inherit", cursor: "pointer", border: "none", boxShadow: "none" }}
        >
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">Create User</span>
          <span className="sm:hidden">Add</span>
        </button>
      </div>

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowCreate(false)}>
          <div className="w-full max-w-md rounded-xl border border-black/10 bg-[#ffffff] p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold text-zinc-900" style={{ ...s, fontSize: "1.1rem" }}>Create User</h2>
              <button onClick={() => setShowCreate(false)} className="p-1 rounded-lg hover:bg-black/10 text-zinc-600 hover:text-zinc-900 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}><X className="w-5 h-5" /></button>
            </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs text-zinc-600 mb-1.5" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Company</label>
                  <div className="w-full px-3 py-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5 text-amber-400 font-medium" style={{ fontSize: "0.8rem" }}>
                    {activeCompanyName || "No active company"}
                  </div>
                </div>
              <div>
                <label className="block text-xs text-zinc-600 mb-1.5" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Name *</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Full name" className="w-full px-3 py-2.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-amber-500/40" style={inputStyle} />
              </div>
              {roles.find(r => r.id === form.role_id)?.name === "SUPER_ADMIN" && (
                <div>
                  <label className="block text-xs text-zinc-600 mb-1.5" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Email</label>
                  <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="user@example.com" type="email" className="w-full px-3 py-2.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-amber-500/40" style={inputStyle} />
                </div>
              )}
              <div>
                <label className="block text-xs text-zinc-600 mb-1.5" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Password *</label>
                <div className="relative">
                  <input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Set login password" type={showPassword ? "text" : "password"} className="w-full px-3 py-2.5 pr-10 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-amber-500/40" style={inputStyle} />
                  <button type="button" onClick={() => setShowPassword(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-700 transition-colors" style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-600 mb-1.5" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Phone</label>
                  <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+91 98765 43210" className="w-full px-3 py-2.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-amber-500/40" style={inputStyle} />
                </div>
                  <div>
                    <label className="block text-xs text-zinc-600 mb-1.5" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Employee ID</label>
                    <div className="w-full px-3 py-2.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-700 font-mono flex items-center gap-2" style={{ fontSize: "0.8rem" }}>
                      {previewEmpCode ? (
                        <span className="text-amber-400 font-semibold">{previewEmpCode}</span>
                      ) : (
                        <span className="text-zinc-600 italic">Auto-generated</span>
                      )}
                      <span className="ml-auto text-zinc-600" style={{ fontSize: "0.65rem" }}>auto</span>
                    </div>
                  </div>
              </div>
              <div>
                <label className="block text-xs text-zinc-600 mb-1.5" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Role *</label>
                <select value={form.role_id} onChange={(e) => { const r = roles.find(x => x.id === e.target.value); setForm({ ...form, role_id: e.target.value, parent_user_id: "" }); if (r?.name === "RETAILER_USER") fetchSuperDealers(); if (r?.name === "SUPER_DEALER_USER") fetchCnfUsers(); }} className="w-full px-3 py-2.5 rounded-lg border border-black/10 bg-[#ffffff] text-zinc-700 outline-none focus:border-amber-500/40" style={inputStyle}>
                  <option value="">Select a role</option>
                    {roles.filter(r => !EXCLUDED_ROLES.includes(r.name)).map((r) => <option key={r.id} value={r.id}>{r.name?.replace(/_/g, " ")}</option>)}
                    <option value="__DRIVER__">DRIVER</option>
                </select>
              </div>
              {roles.find(r => r.id === form.role_id)?.name === "RETAILER_USER" && (
                <div>
                  <label className="block text-xs text-zinc-600 mb-1.5" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Super Dealer <span className="text-amber-500">*</span></label>
                  <select value={form.parent_user_id} onChange={(e) => setForm({ ...form, parent_user_id: e.target.value })} className="w-full px-3 py-2.5 rounded-lg border border-amber-500/30 bg-[#ffffff] text-zinc-700 outline-none focus:border-amber-500/60" style={inputStyle}>
                    <option value="">{loadingSuperDealers ? "Loading super dealers..." : "Select a Super Dealer"}</option>
                    {superDealers.map((sd) => <option key={sd.id} value={sd.id}>{sd.name}</option>)}
                  </select>
                  {superDealers.length === 0 && !loadingSuperDealers && <p className="mt-1 text-zinc-500" style={{ fontSize: "0.7rem" }}>No super dealers found. Create one first.</p>}
                </div>
              )}
              {roles.find(r => r.id === form.role_id)?.name === "SUPER_DEALER_USER" && (
                <div>
                  <label className="block text-xs text-zinc-600 mb-1.5" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>CNF <span className="text-amber-500">*</span></label>
                  <select value={form.parent_user_id} onChange={(e) => setForm({ ...form, parent_user_id: e.target.value })} className="w-full px-3 py-2.5 rounded-lg border border-amber-500/30 bg-[#ffffff] text-zinc-700 outline-none focus:border-amber-500/60" style={inputStyle}>
                    <option value="">{loadingCnfUsers ? "Loading CNFs..." : "Select a CNF"}</option>
                    {cnfUsers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  {cnfUsers.length === 0 && !loadingCnfUsers && <p className="mt-1 text-zinc-500" style={{ fontSize: "0.7rem" }}>No CNF users found. Create one first.</p>}
                </div>
              )}
              <div>
                <label className="block text-xs text-zinc-600 mb-1.5" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Status</label>
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="w-full px-3 py-2.5 rounded-lg border border-black/10 bg-[#ffffff] text-zinc-700 outline-none focus:border-amber-500/40" style={inputStyle}>
                  <option value="ACTIVE">Active</option>
                  <option value="INACTIVE">Inactive</option>
                </select>
              </div>

              {/* Profile Photo */}
              <div>
                <label className="block text-xs text-zinc-600 mb-1.5" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Profile Photo</label>
                <div className="flex items-center gap-4">
                  <div className="w-16 h-16 rounded-full border-2 border-black/10 bg-black/[0.03] flex items-center justify-center shrink-0 overflow-hidden">
                    {photoPreview ? (
                      <img src={photoPreview} alt="Profile" className="w-full h-full object-cover" />
                    ) : (
                      <Camera className="w-6 h-6 text-zinc-400" />
                    )}
                  </div>
                  <div className="flex-1">
                    <label className="flex items-center gap-2 w-full px-3 py-2.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-600 cursor-pointer hover:bg-black/[0.05] transition-colors" style={{ fontSize: "0.8rem" }}>
                      {photoUploading ? <Loader2 className="w-4 h-4 animate-spin text-amber-500" /> : <Upload className="w-4 h-4" />}
                      <span>{photoUploading ? "Uploading..." : photoPreview ? "Change Photo" : "Upload Photo"}</span>
                      <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" disabled={photoUploading} onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePhotoUpload(f); e.target.value = ""; }} />
                    </label>
                    <p className="mt-1 text-zinc-500" style={{ fontSize: "0.65rem" }}>JPEG, PNG, WebP · Max 3 MB</p>
                    {photoError && <p className="mt-1 text-red-400" style={{ fontSize: "0.7rem" }}>{photoError}</p>}
                  </div>
                  {photoPreview && (
                    <button type="button" onClick={() => { setPhotoPreview(null); setForm(f => ({ ...f, photo_url: "" })); }} className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }} title="Remove photo">
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Aadhaar Number */}
              <div>
                <label className="block text-xs text-zinc-600 mb-1.5" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  <span className="flex items-center gap-1.5"><CreditCard className="w-3 h-3" /> Aadhaar Number</span>
                </label>
                <input
                  value={form.aadhaar_number}
                  onChange={(e) => {
                    const val = e.target.value.replace(/\D/g, "").slice(0, 12);
                    const formatted = val.replace(/(\d{4})(?=\d)/g, "$1 ").trim();
                    setForm({ ...form, aadhaar_number: formatted });
                  }}
                  placeholder="0000 0000 0000"
                  maxLength={14}
                  className="w-full px-3 py-2.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-amber-500/40 font-mono"
                  style={{ fontSize: "0.85rem", fontFamily: "monospace", letterSpacing: "0.08em" }}
                />
                {form.aadhaar_number.replace(/\s/g, "").length > 0 && form.aadhaar_number.replace(/\s/g, "").length < 12 && (
                  <p className="mt-1 text-amber-500" style={{ fontSize: "0.65rem" }}>Enter full 12-digit Aadhaar number</p>
                )}
              </div>
            </div>
              {createError && (
                <div className="mt-4 flex items-start gap-2 px-3 py-2.5 rounded-lg border border-red-500/30 bg-red-500/10">
                  <span className="text-red-400 mt-0.5 shrink-0">⚠</span>
                  <p className="text-red-400" style={{ fontSize: "0.78rem", margin: 0 }}>{createError}</p>
                </div>
              )}
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2.5 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:bg-black/5 transition-colors" style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}>Cancel</button>
              <button onClick={handleCreate} disabled={creating} className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-medium transition-colors disabled:opacity-50" style={{ fontSize: "0.8rem", fontFamily: "inherit", cursor: "pointer", border: "none" }}>
                {creating && <Loader2 className="w-4 h-4 animate-spin" />}
                {creating ? "Creating..." : "Create User"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => { setDeleteTarget(null); setDeleteError(""); }}>
          <div className="w-full max-w-sm rounded-xl border border-black/10 bg-[#ffffff] p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-4 mb-5">
              <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-zinc-900 mb-1" style={{ ...s, fontSize: "1rem" }}>Delete User</h2>
                <p className="text-zinc-600" style={{ fontSize: "0.8rem" }}>
                  Are you sure you want to delete <span className="text-zinc-900 font-medium">{deleteTarget.name}</span>? This action cannot be undone.
                </p>
              </div>
            </div>
            {deleteError && <p className="mb-4 text-red-400" style={{ fontSize: "0.75rem" }}>{deleteError}</p>}
            <div className="flex justify-end gap-3">
              <button onClick={() => { setDeleteTarget(null); setDeleteError(""); }} className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:bg-black/5 transition-colors" style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}>Cancel</button>
              <button onClick={handleDelete} disabled={deleting} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500 hover:bg-red-400 text-zinc-900 font-medium transition-colors disabled:opacity-50" style={{ fontSize: "0.8rem", fontFamily: "inherit", cursor: "pointer", border: "none" }}>
                {deleting && <Loader2 className="w-4 h-4 animate-spin" />}
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Change Password modal */}
      {pwTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => { setPwTarget(null); setPwValue(""); setPwError(""); setPwSuccess(""); }}>
          <div className="w-full max-w-sm rounded-xl border border-black/10 bg-[#ffffff] p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-4 mb-5">
              <div className="w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center shrink-0">
                <KeyRound className="w-5 h-5 text-amber-500" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-zinc-900 mb-1" style={{ ...s, fontSize: "1rem" }}>Change Password</h2>
                <p className="text-zinc-600" style={{ fontSize: "0.8rem" }}>
                  Set a new password for <span className="font-medium text-zinc-900">{pwTarget.name}</span>.
                  {pwTarget.phone && <> They can login with <span className="font-mono text-zinc-900">{pwTarget.phone}</span> and the new password.</>}
                </p>
              </div>
            </div>
            <div className="relative mb-4">
              <input
                value={pwValue}
                onChange={(e) => { setPwValue(e.target.value); setPwError(""); setPwSuccess(""); }}
                placeholder="New password (min 6 characters)"
                type={pwShow ? "text" : "password"}
                className="w-full px-3 py-2.5 pr-10 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-amber-500/40"
                style={{ fontSize: "0.8rem", fontFamily: "inherit" }}
              />
              <button type="button" onClick={() => setPwShow(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-700" style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                {pwShow ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {pwError && <p className="mb-3 text-red-400" style={{ fontSize: "0.75rem" }}>{pwError}</p>}
            {pwSuccess && <p className="mb-3 text-emerald-500" style={{ fontSize: "0.75rem" }}>{pwSuccess}</p>}
            <div className="flex justify-end gap-3">
              <button onClick={() => { setPwTarget(null); setPwValue(""); setPwError(""); setPwSuccess(""); }} className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:bg-black/5 transition-colors" style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}>Cancel</button>
              <button onClick={handleChangePassword} disabled={pwSaving || !!pwSuccess} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-medium transition-colors disabled:opacity-50" style={{ fontSize: "0.8rem", fontFamily: "inherit", cursor: "pointer", border: "none" }}>
                {pwSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                {pwSaving ? "Saving..." : "Update Password"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type="text"
            placeholder="Search users..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-amber-500/40"
            style={{ fontSize: "0.8rem", fontFamily: "inherit" }}
          />
        </div>
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          className="px-4 py-2.5 rounded-lg border border-black/10 bg-[#ffffff] text-zinc-700 outline-none"
          style={{ fontSize: "0.8rem", fontFamily: "inherit" }}
        >
            <option value="">All Roles</option>
              {Object.keys(roleColors).filter(r => !EXCLUDED_ROLES.includes(r) && !PARTY_ROLES.includes(r)).map((r) => (
              <option key={r} value={r}>{r.replace(/_/g, " ")}</option>
            ))}
        </select>
      </div>

      {statusError && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-red-500" style={{ fontSize: "0.78rem" }}>
          {statusError}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-amber-500 animate-spin" /></div>
      ) : users.length === 0 ? (
        <div className="text-center py-20 text-zinc-500">
          <UsersIcon className="w-12 h-12 mx-auto mb-4 opacity-30" />
          <p style={{ fontSize: "0.875rem" }}>No users found</p>
          {activeCompanyName && (
            <p className="mt-2 text-xs text-zinc-400 max-w-xs mx-auto">
              The admin account for <span className="font-medium text-zinc-600">{activeCompanyName}</span> may not have been saved to the database.
              Use <span className="font-medium text-amber-600">+ Create User</span> to add the admin manually.
            </p>
          )}
        </div>
      ) : (
        <>
          {/* Mobile cards */}
          <div className="flex flex-col gap-3 lg:hidden">
              {users.map((u) => (
                <div key={u.id} className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-4 transition-colors">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-zinc-100 to-zinc-200 flex items-center justify-center shrink-0 cursor-pointer overflow-hidden" onClick={() => window.location.href = `/dashboard/users/${u.id}`}>
                      {u.photo_url ? <img src={u.photo_url} alt={u.name} className="w-full h-full object-cover" /> : <span className="text-zinc-900 text-sm font-medium">{u.name.charAt(0)}</span>}
                    </div>
                    <div className="flex-1 min-w-0 cursor-pointer" onClick={() => window.location.href = `/dashboard/users/${u.id}`}>
                      <div className="text-zinc-900 font-medium truncate" style={{ fontSize: "0.875rem" }}>{u.name}</div>
                      <div className="text-zinc-600 truncate" style={{ fontSize: "0.75rem" }}>{u.phone || u.email}</div>
                      {u.employee_code && <div className="text-zinc-500 font-mono" style={{ fontSize: "0.65rem", letterSpacing: "0.04em" }}>{u.employee_code}</div>}
                    </div>
                    {canDownloadJoiningLetter(u) && (
                      <button onClick={() => downloadJoiningLetter(u)} title="Download Joining Letter" className="p-1.5 rounded-lg text-zinc-600 hover:text-amber-400 hover:bg-amber-500/10 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}>
                        <FileDown className="w-4 h-4" />
                      </button>
                    )}
                    <button onClick={() => { setPwTarget(u); setPwValue(""); setPwShow(false); setPwError(""); setPwSuccess(""); }} title="Change Password" className="p-1.5 rounded-lg text-zinc-600 hover:text-amber-500 hover:bg-amber-500/10 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}>
                      <KeyRound className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleToggleActive(u)}
                      disabled={statusUpdatingId === u.id}
                      title={u.isActive ? "Deactivate user and wallet" : "Activate user and wallet"}
                      className={`inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg transition-colors disabled:opacity-50 ${u.isActive ? "text-red-500 bg-red-500/10 hover:bg-red-500/15" : "text-emerald-600 bg-emerald-500/10 hover:bg-emerald-500/15"}`}
                      style={{ border: "none", cursor: "pointer", fontSize: "0.68rem", fontWeight: 600 }}
                    >
                      {statusUpdatingId === u.id ? <Loader2 className="w-4 h-4 animate-spin" /> : u.isActive ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
                      <span>{u.isActive ? "Deactivate" : "Activate"}</span>
                    </button>
                    <button onClick={() => { setDeleteTarget(u); setDeleteError(""); }} className="p-1.5 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}>
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap cursor-pointer" onClick={() => window.location.href = `/dashboard/users/${u.id}`}>
                      <span className={`inline-block px-2 py-0.5 rounded-md text-xs font-medium ${roleColors[u.role] || "bg-zinc-500/20 text-zinc-600"}`} style={{ fontSize: "0.65rem" }}>
                        {roleLabel(u.role, u.companyName)}
                      </span>
                    {u.phone && <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>{u.phone}</span>}
                    <span className={`inline-flex items-center gap-1 ${u.isActive ? "text-emerald-500" : "text-zinc-500"}`} style={{ fontSize: "0.7rem" }}>
                      <span className={`w-1.5 h-1.5 rounded-full ${u.isActive ? "bg-emerald-500" : "bg-zinc-500"}`} />
                      {u.isActive ? "Active" : "Inactive"}
                    </span>
                    <span className="text-zinc-600 ml-auto" style={{ fontSize: "0.7rem" }}>
                      {new Date(u.createdAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" })}
                    </span>
                  </div>
                </div>
              ))}
          </div>

          {/* Desktop table */}
          <div className="hidden lg:block rounded-xl border border-black/[0.06] overflow-hidden">
            <div
              role="region"
              aria-label="Scrollable users list"
              tabIndex={0}
              data-testid="users-table-scroll"
              className="max-h-[36rem] overflow-auto overscroll-contain focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
            >
              <table className="w-full" style={{ borderCollapse: "collapse" }}>
                <thead className="sticky top-0 z-10">
                  <tr className="h-12 border-b border-black/[0.06]">
                      {["Name", "Phone", "Role", "Status", "Joined", "Actions"].map((h) => (
                        <th key={h} className="bg-[#f8f8f9] px-4 py-3 text-left text-xs font-medium text-zinc-500" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                      ))}
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className="h-16 border-b border-black/[0.04] hover:bg-black/[0.02] transition-colors cursor-pointer" onClick={() => window.location.href = `/dashboard/users/${u.id}`}>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-zinc-100 to-zinc-200 flex items-center justify-center shrink-0 overflow-hidden">
                              {u.photo_url ? <img src={u.photo_url} alt={u.name} className="w-full h-full object-cover" /> : <span className="text-zinc-900 text-xs">{u.name.charAt(0)}</span>}
                            </div>
                            <div>
                              <div className="text-zinc-800" style={{ fontSize: "0.8rem" }}>{u.name}</div>
                              {u.employee_code && <div className="text-zinc-500 font-mono" style={{ fontSize: "0.65rem", letterSpacing: "0.04em" }}>{u.employee_code}</div>}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-zinc-600" style={{ fontSize: "0.8rem" }}>{u.phone || "—"}</td>
                        <td className="px-4 py-3">
                            <span className={`inline-block px-2 py-1 rounded-md text-xs font-medium ${roleColors[u.role] || "bg-zinc-500/20 text-zinc-600"}`} style={{ fontSize: "0.65rem" }}>
                              {roleLabel(u.role, u.companyName)}
                            </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1.5 ${u.isActive ? "text-emerald-400" : "text-zinc-500"}`} style={{ fontSize: "0.75rem" }}>
                            <span className={`w-1.5 h-1.5 rounded-full ${u.isActive ? "bg-emerald-500" : "bg-zinc-600"}`} />
                            {u.isActive ? "Active" : "Inactive"}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-zinc-500" style={{ fontSize: "0.75rem" }}>
                          {new Date(u.createdAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" })}
                        </td>
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-1">
                            {canDownloadJoiningLetter(u) && (
                              <button onClick={(e) => { e.stopPropagation(); downloadJoiningLetter(u); }} title="Download Joining Letter" className="p-1.5 rounded-lg text-zinc-600 hover:text-amber-400 hover:bg-amber-500/10 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}>
                                <FileDown className="w-4 h-4" />
                              </button>
                            )}
                            <button onClick={(e) => { e.stopPropagation(); setPwTarget(u); setPwValue(""); setPwShow(false); setPwError(""); setPwSuccess(""); }} title="Change Password" className="p-1.5 rounded-lg text-zinc-600 hover:text-amber-500 hover:bg-amber-500/10 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}>
                              <KeyRound className="w-4 h-4" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleToggleActive(u); }}
                              disabled={statusUpdatingId === u.id}
                              title={u.isActive ? "Deactivate user and wallet" : "Activate user and wallet"}
                              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-50 ${u.isActive ? "text-red-500 bg-red-500/10 hover:bg-red-500/15" : "text-emerald-600 bg-emerald-500/10 hover:bg-emerald-500/15"}`}
                              style={{ border: "none", cursor: "pointer", fontSize: "0.68rem", fontWeight: 600 }}
                            >
                              {statusUpdatingId === u.id ? <Loader2 className="w-4 h-4 animate-spin" /> : u.isActive ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
                              <span>{u.isActive ? "Deactivate" : "Activate"}</span>
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); setDeleteTarget(u); setDeleteError(""); }} className="p-1.5 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}>
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

        </>
      )}
    </div>
  );
}
