"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import { ChevronLeft, ChevronRight, FolderOpen, ImagePlus, Loader2, Package, Pencil, Plus, Search, Tag, Trash2, X } from "lucide-react";

interface Product {
  id: string;
  name: string;
  sku: string;
  category_id?: string | null;
  product_categories: { name: string } | null;
  hsn_codes: { hsn_code: string; gst_rate: number; cess_rate: number | null } | null;
  base_price: number;
  mrp: number;
  unit_of_measure: string;
  pack_size: number;
  technical_specs?: { net_weight_with_packaging?: number; net_weight_unit?: string; image_url?: string | null } | null;
  status: string;
  image_url?: string | null;
}

function getProductImage(p: Product): string | null {
  return p.image_url || (p.technical_specs as { image_url?: string | null } | null)?.image_url || null;
}

interface Category { id: string; name: string }

const s: React.CSSProperties = { transform: "none", filter: "none", WebkitTextStroke: "0", background: "none", boxShadow: "none", display: "block", padding: 0 };

const inputCls = "w-full px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-amber-500/40";
const inputStyle: React.CSSProperties = { fontSize: "0.8rem", fontFamily: "inherit" };
const labelStyle: React.CSSProperties = { fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.35rem", display: "block" };

const emptyForm = {
  name: "",
  unit_of_measure: "KG",
  pack_size: "",
  base_price: "",
  category_id: "",
  net_weight_with_packaging: "",
  hsn_code: "",
  image_url: "",
};

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [unitOptions, setUnitOptions] = useState<string[]>(["KG", "LITRE", "BAG", "SET", "DRUM", "PIECE", "BOX", "MT"]);

  const [imageUploading, setImageUploading] = useState(false);
  const [imagePreview, setImagePreview] = useState<string>("");
  const imageInputRef = useRef<HTMLInputElement>(null);

  // Per-product image upload
  const [rowImageUploading, setRowImageUploading] = useState<string>("");
  const rowImageInputRef = useRef<HTMLInputElement>(null);
  const rowImageTargetId = useRef<string>("");

  // Category management
  const [showManageCats, setShowManageCats] = useState(false);
  const [catsList, setCatsList] = useState<Category[]>([]);
  const [catsLoading, setCatsLoading] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [catCreating, setCatCreating] = useState(false);
  const [catError, setCatError] = useState("");

  const fetchCategories = useCallback(async () => {
    setCatsLoading(true);
    try {
      const res = await api<{ success: boolean; data: Category[] }>("/api/v1/product-categories");
      setCatsList(res.data || []);
      setCategories(res.data || []);
    } catch { /* ignore */ }
    setCatsLoading(false);
  }, []);

  const fetchProducts = useCallback(async (p = 1) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(p), limit: "20" });
      if (search) params.set("search", search);
      const res = await api<{ success: boolean; data: Product[]; pagination: { total: number; page: number; pages: number } }>(`/api/v1/products?${params}`);
      setProducts(res.data || []);
      if (res.pagination) { setTotal(res.pagination.total); setPage(res.pagination.page); setTotalPages(res.pagination.pages); }
    } catch { setProducts([]); }
    setLoading(false);
  }, [search]);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);

  const uploadImage = async (file: File): Promise<{ url: string }> => {
    const doFetch = async () => {
      const token = localStorage.getItem("accessToken") || "";
      const companyId = localStorage.getItem("activeCompanyId") || "";
      const fd = new FormData();
      fd.append("image", file);
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      if (companyId) headers["x-company-id"] = companyId;
      return fetch("/api/v1/upload/product-image", { method: "POST", headers, body: fd });
    };

    let res = await doFetch();
    if (res.status === 401) {
      const refreshToken = localStorage.getItem("refreshToken");
      if (refreshToken) {
        try {
          const rr = await fetch("/api/v1/auth/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken }) });
          if (rr.ok) {
            const rd = await rr.json();
            if (rd.success) {
              localStorage.setItem("accessToken", rd.data.accessToken);
              localStorage.setItem("refreshToken", rd.data.refreshToken);
              res = await doFetch();
            }
          }
        } catch { /* fall through to error */ }
      }
    }

    const json = await res.json();
    if (!json.success) throw new Error(json.message || "Upload failed");
    return json.data;
  };

  const handleImageUpload = async (file: File) => {
    setImageUploading(true);
    const preview = URL.createObjectURL(file);
    setImagePreview(preview);
    try {
      const data = await uploadImage(file);
      set("image_url", data.url);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Image upload failed");
      setImagePreview("");
    }
    setImageUploading(false);
  };

  const handleRowImageUpload = async (productId: string, file: File) => {
    setRowImageUploading(productId);
    try {
      const data = await uploadImage(file);
      await api("/api/v1/products", { method: "PATCH", body: { id: productId, image_url: data.url } });
      setProducts((prev) => prev.map((p) => p.id === productId ? { ...p, image_url: data.url, technical_specs: { ...p.technical_specs, image_url: data.url } } : p));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Image upload failed");
    }
    setRowImageUploading("");
  };

  const closeModal = () => {
    setShowCreate(false);
    setEditId(null);
    setImagePreview("");
  };

  const openCreate = async () => {
    setCreateError("");
    setEditId(null);
    setImagePreview("");
    setShowCreate(true);
    try {
      const [catRes, unitRes] = await Promise.all([
        api<{ success: boolean; data: Category[] }>("/api/v1/product-categories"),
        api<{ success: boolean; data: string[] }>("/api/v1/units-of-measure"),
      ]);
      const cats = catRes.data || [];
      const units = unitRes.data || ["KG"];
      setCategories(cats);
      setUnitOptions(units);
      setForm({ ...emptyForm, unit_of_measure: units[0] || "KG" });
    } catch {
      setUnitOptions(["KG", "LITRE", "BAG", "SET", "DRUM", "PIECE", "BOX", "MT"]);
      setForm({ ...emptyForm, unit_of_measure: "KG" });
    }
  };

  const openEdit = async (p: Product) => {
    setCreateError("");
    setEditId(p.id);
    const img = getProductImage(p) || "";
    setImagePreview(img);
    setShowCreate(true);
    // Pre-fill from the product immediately so the form never flashes empty.
    setForm({
      name: p.name || "",
      unit_of_measure: p.unit_of_measure || "KG",
      pack_size: p.pack_size != null ? String(p.pack_size) : "",
      base_price: p.base_price != null ? String(p.base_price) : "",
      category_id: p.category_id || "",
      net_weight_with_packaging:
        p.technical_specs?.net_weight_with_packaging != null ? String(p.technical_specs.net_weight_with_packaging) : "",
      hsn_code: p.hsn_codes?.hsn_code || "",
      image_url: img,
    });
    // Load category + unit options for the selects without disturbing the pre-filled form.
    try {
      const [catRes, unitRes] = await Promise.all([
        api<{ success: boolean; data: Category[] }>("/api/v1/product-categories"),
        api<{ success: boolean; data: string[] }>("/api/v1/units-of-measure"),
      ]);
      if (catRes.data) setCategories(catRes.data);
      const units = unitRes.data?.length ? unitRes.data : unitOptions;
      setUnitOptions(units.includes(p.unit_of_measure) ? units : [p.unit_of_measure, ...units]);
    } catch { /* keep current options */ }
  };

  const handleCreate = async () => {
    if (!form.name.trim() || !form.base_price) {
        setCreateError("Name and Base Price are required");
      return;
    }
    setCreating(true);
    setCreateError("");
    try {
        const hasNetWeightInput = form.net_weight_with_packaging.trim() !== "";
        const netWeightWithPackaging = hasNetWeightInput
          ? parseFloat(form.net_weight_with_packaging)
          : null;

        if (netWeightWithPackaging !== null && (!Number.isFinite(netWeightWithPackaging) || netWeightWithPackaging < 0)) {
          setCreateError("Net weight must be zero or a positive number");
          setCreating(false);
          return;
        }

        const technicalSpecs = { net_weight_with_packaging: netWeightWithPackaging, net_weight_unit: "KG" };

      if (editId) {
        const payload: Record<string, unknown> = {
          id: editId,
          name: form.name.trim(),
          unit_of_measure: form.unit_of_measure,
          base_price: parseFloat(form.base_price),
          pack_size: form.pack_size ? parseFloat(form.pack_size) : 1,
          category_id: form.category_id || null,
          hsn_code: form.hsn_code.trim() || null,
          technical_specs: technicalSpecs,
          image_url: form.image_url || null,
        };
        await api("/api/v1/products", { method: "PATCH", body: payload });
        closeModal();
        fetchProducts(page);
        return;
      }

      const sku = form.name.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) + "-" + Date.now().toString(36).toUpperCase().slice(-4);
        const payload: Record<string, unknown> = {
          name: form.name.trim(),
          trade_name: form.name.trim(),
          sku,
          unit_of_measure: form.unit_of_measure,
          base_price: parseFloat(form.base_price),
          mrp: parseFloat(form.base_price),
          pack_size: form.pack_size ? parseFloat(form.pack_size) : 1,
            technical_specs: technicalSpecs,
        };
        if (form.category_id) payload.category_id = form.category_id;
        if (form.hsn_code.trim()) payload.hsn_code = form.hsn_code.trim();
        if (form.image_url) payload.image_url = form.image_url;


      await api("/api/v1/products", { method: "POST", body: payload });
      closeModal();
      fetchProducts();
    } catch (e: unknown) {
      console.error(editId ? "Update product failed:" : "Create product failed:", e);
      setCreateError(e instanceof Error ? e.message : `Failed to ${editId ? "update" : "create"} product`);
    }
    setCreating(false);
  };

  const set = (key: string, val: string) => setForm((f) => ({ ...f, [key]: val }));

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this product?")) return;
    try {
      await api("/api/v1/products", { method: "DELETE", body: { id } });
      fetchProducts(page);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete product");
    }
  };

  const openManageCats = () => {
    setNewCatName("");
    setCatError("");
    setShowManageCats(true);
    fetchCategories();
  };

  const handleCreateCategory = async () => {
    if (!newCatName.trim()) return;
    setCatCreating(true);
    setCatError("");
    try {
      await api("/api/v1/product-categories", { method: "POST", body: { name: newCatName.trim() } });
      setNewCatName("");
      fetchCategories();
    } catch (e: unknown) {
      setCatError(e instanceof Error ? e.message : "Failed to create category");
    }
    setCatCreating(false);
  };

  const handleDeleteCategory = async (id: string) => {
    if (!confirm("Delete this category? Products in it won't be deleted.")) return;
    setCatError("");
    try {
      await api("/api/v1/product-categories", { method: "DELETE", body: { id } });
      fetchCategories();
      if (filterCategory === id) setFilterCategory("");
    } catch (e: unknown) {
      setCatError(e instanceof Error ? e.message : "Failed to delete category");
    }
  };

  const fmt = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

  // Client-side category filter
  const displayedProducts = filterCategory
    ? products.filter((p) => p.product_categories && categories.find((c) => c.id === filterCategory)?.name === p.product_categories!.name)
    : products;

    return (
      <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
        <div className="flex items-center justify-between mb-4 lg:mb-6">
          <div>
            <h1 className="text-xl lg:text-2xl font-bold text-zinc-900" style={{ ...s, marginBottom: "0.25rem" }}>Products</h1>
            <p className="text-zinc-600" style={{ fontSize: "0.8rem", margin: 0 }}>{total} products in catalog</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={openManageCats}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:bg-black/5 transition-colors"
              style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}
            >
              <FolderOpen className="w-4 h-4" /><span className="hidden sm:inline">Categories</span>
            </button>
            <button
              onClick={openCreate}
              className="inline-flex items-center gap-2 px-3 py-2 lg:px-4 rounded-lg text-black font-semibold hover:opacity-90 transition-opacity"
              style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "linear-gradient(135deg,#f59e0b,#d97706)", border: "none", cursor: "pointer" }}
            >
              <Plus className="w-4 h-4" /><span className="hidden sm:inline">Create Product</span><span className="sm:hidden">Add</span>
            </button>
          </div>
        </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input type="text" placeholder="Search products..." value={search} onChange={(e) => setSearch(e.target.value)}
            className={inputCls + " pl-10"} style={inputStyle} />
        </div>
        {categories.length > 0 && (
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-700 outline-none focus:border-amber-500/40"
            style={{ fontSize: "0.8rem", fontFamily: "inherit", minWidth: "160px" }}
          >
            <option value="">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-amber-500 animate-spin" /></div>
      ) : displayedProducts.length === 0 ? (
        <div className="text-center py-20 text-zinc-500"><Package className="w-12 h-12 mx-auto mb-4 opacity-30" /><p style={{ fontSize: "0.875rem" }}>No products found</p></div>
      ) : (
          <>
            {/* Mobile cards */}
            <div className="flex flex-col gap-3 lg:hidden">
              {displayedProducts.map((p) => (
                <div key={p.id} className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-4">
                    <div className="flex items-start justify-between mb-2">
                        <div className="flex items-center gap-3 min-w-0">
                            <button
                              title={getProductImage(p) ? "Change image" : "Upload image"}
                              onClick={() => { rowImageTargetId.current = p.id; rowImageInputRef.current?.click(); }}
                              className="relative shrink-0 group"
                              style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
                            >
                              {rowImageUploading === p.id ? (
                                <div className="w-10 h-10 rounded-lg bg-black/[0.04] border border-black/10 flex items-center justify-center">
                                  <Loader2 className="w-4 h-4 animate-spin text-amber-500" />
                                </div>
                              ) : getProductImage(p) ? (
                                <>
                                  <img src={getProductImage(p)!} alt={p.name} className="w-10 h-10 rounded-lg object-cover border border-black/10 group-hover:opacity-70 transition-opacity" />
                                  <div className="absolute inset-0 rounded-lg flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/30 transition-opacity">
                                    <ImagePlus className="w-4 h-4 text-white" />
                                  </div>
                                </>
                              ) : (
                                <div className="w-10 h-10 rounded-lg bg-black/[0.04] border border-dashed border-black/20 flex items-center justify-center group-hover:border-amber-500/50 group-hover:bg-amber-500/5 transition-colors">
                                  <ImagePlus className="w-4 h-4 text-zinc-400 group-hover:text-amber-500 transition-colors" />
                                </div>
                              )}
                            </button>
                            <div className="text-zinc-900 font-medium" style={{ fontSize: "0.875rem" }}>{p.name}</div>
                          </div>
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex items-center gap-1 shrink-0 ${p.status === "ACTIVE" ? "text-emerald-400" : "text-zinc-500"}`} style={{ fontSize: "0.7rem" }}>
                          <span className={`w-1.5 h-1.5 rounded-full ${p.status === "ACTIVE" ? "bg-emerald-500" : "bg-zinc-600"}`} />
                          {p.status === "ACTIVE" ? "Active" : "Inactive"}
                        </span>
                        <button onClick={() => openEdit(p)}
                          className="p-1 rounded-lg text-zinc-600 hover:text-amber-600 hover:bg-amber-500/10 transition-colors"
                          style={{ background: "none", border: "none", cursor: "pointer" }}
                          title="Edit product">
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => handleDelete(p.id)}
                          className="p-1 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                          style={{ background: "none", border: "none", cursor: "pointer" }}
                          title="Delete product">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                  </div>
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-amber-400 font-semibold" style={{ fontSize: "0.85rem" }}>{fmt(Number(p.base_price))}</span>
                      {p.product_categories && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-black/10 text-zinc-600" style={{ fontSize: "0.66rem" }}>
                          <Tag className="w-2.5 h-2.5" />{p.product_categories.name}
                        </span>
                      )}
                      <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>
                        {p.unit_of_measure}
                        {(p.technical_specs?.net_weight_with_packaging !== undefined && p.technical_specs?.net_weight_with_packaging !== null)
                          ? ` · Net ${p.technical_specs.net_weight_with_packaging} KG`
                          : ""}
                        {` · GST ${p.hsn_codes?.gst_rate ?? 18}%`}
                        {p.hsn_codes?.cess_rate ? ` + Cess ${p.hsn_codes.cess_rate}%` : ""}
                      </span>
                    </div>

                </div>
              ))}
            </div>

            {/* Desktop table */}
            <div className="hidden lg:block rounded-xl border border-black/[0.06] overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full" style={{ borderCollapse: "collapse" }}>
                  <thead>
                      <tr className="border-b border-black/[0.06]">
                          {["Product","Category","Base Price","Unit","Net Weight",""].map((h, i) => (
                        <th key={i} className="text-left px-4 py-3 text-xs font-medium text-zinc-500 bg-black/[0.02]" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayedProducts.map((p) => (
                      <tr key={p.id} className="border-b border-black/[0.04] hover:bg-black/[0.02] transition-colors">
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-3">
                                <button
                                  title={getProductImage(p) ? "Click to change image" : "Click to upload image"}
                                  onClick={() => { rowImageTargetId.current = p.id; rowImageInputRef.current?.click(); }}
                                  className="relative shrink-0 group"
                                  style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
                                >
                                  {rowImageUploading === p.id ? (
                                    <div className="w-9 h-9 rounded-lg bg-black/[0.04] border border-black/10 flex items-center justify-center">
                                      <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-500" />
                                    </div>
                                  ) : getProductImage(p) ? (
                                    <>
                                      <img src={getProductImage(p)!} alt={p.name} className="w-9 h-9 rounded-lg object-cover border border-black/10 group-hover:opacity-70 transition-opacity" />
                                      <div className="absolute inset-0 rounded-lg flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/30">
                                        <ImagePlus className="w-3.5 h-3.5 text-white" />
                                      </div>
                                    </>
                                  ) : (
                                    <div className="w-9 h-9 rounded-lg bg-black/[0.04] border border-dashed border-black/20 flex items-center justify-center group-hover:border-amber-500/50 group-hover:bg-amber-500/5 transition-colors">
                                      <ImagePlus className="w-3.5 h-3.5 text-zinc-400 group-hover:text-amber-500 transition-colors" />
                                    </div>
                                  )}
                                </button>
                                <span className="text-zinc-800" style={{ fontSize: "0.8rem" }}>{p.name}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3" style={{ fontSize: "0.8rem" }}>
                              {p.product_categories ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-black/10 text-zinc-600" style={{ fontSize: "0.68rem" }}>
                                  <Tag className="w-2.5 h-2.5" />{p.product_categories.name}
                                </span>
                              ) : <span className="text-zinc-400">—</span>}
                            </td>
                              <td className="px-4 py-3 text-zinc-900 font-medium" style={{ fontSize: "0.8rem" }}>{fmt(Number(p.base_price))}</td>
                              <td className="px-4 py-3 text-zinc-600" style={{ fontSize: "0.8rem" }}>{p.unit_of_measure}</td>
                              <td className="px-4 py-3 text-zinc-600" style={{ fontSize: "0.8rem" }}>
                                {(p.technical_specs?.net_weight_with_packaging !== undefined && p.technical_specs?.net_weight_with_packaging !== null)
                                    ? `${p.technical_specs.net_weight_with_packaging} KG`
                                    : "—"}
                              </td>
                              <td className="px-4 py-3 text-right">
                              <div className="flex items-center justify-end gap-1">
                                <button onClick={() => openEdit(p)}
                                  className="p-1.5 rounded-lg text-zinc-600 hover:text-amber-600 hover:bg-amber-500/10 transition-colors"
                                  style={{ background: "none", border: "none", cursor: "pointer" }}
                                  title="Edit product">
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                                <button onClick={() => handleDelete(p.id)}
                                  className="p-1.5 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                  style={{ background: "none", border: "none", cursor: "pointer" }}
                                  title="Delete product">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <span className="text-xs text-zinc-500" style={{ fontSize: "0.7rem" }}>Page {page} of {totalPages}</span>
              <div className="flex gap-2">
                <button onClick={() => fetchProducts(page - 1)} disabled={page <= 1} className="p-2 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:bg-black/5 disabled:opacity-30" style={{ fontFamily: "inherit", background: "none", boxShadow: "none", cursor: "pointer" }}><ChevronLeft className="w-4 h-4" /></button>
                <button onClick={() => fetchProducts(page + 1)} disabled={page >= totalPages} className="p-2 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:bg-black/5 disabled:opacity-30" style={{ fontFamily: "inherit", background: "none", boxShadow: "none", cursor: "pointer" }}><ChevronRight className="w-4 h-4" /></button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Hidden file input for per-row image upload */}
      <input
        ref={rowImageInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && rowImageTargetId.current) handleRowImageUpload(rowImageTargetId.current, f);
          if (rowImageInputRef.current) rowImageInputRef.current.value = "";
        }}
      />

      {/* Manage Categories Modal */}
      {showManageCats && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}>
          <div className="w-full max-w-sm rounded-xl border border-black/10 p-6" style={{ background: "#ffffff", maxHeight: "80vh", overflowY: "auto" }}>
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <FolderOpen className="w-4 h-4 text-amber-500" />
                <h2 className="text-zinc-900 font-semibold" style={{ fontSize: "1rem" }}>Manage Categories</h2>
              </div>
              <button onClick={() => setShowManageCats(false)} className="text-zinc-500 hover:text-zinc-900" style={{ background: "none", border: "none", cursor: "pointer" }}><X className="w-5 h-5" /></button>
            </div>

            {/* Create new category */}
            <div className="flex gap-2 mb-4">
              <input
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreateCategory()}
                placeholder="New category name…"
                className={inputCls + " flex-1"}
                style={inputStyle}
              />
              <button
                onClick={handleCreateCategory}
                disabled={catCreating || !newCatName.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-black font-semibold hover:opacity-90 disabled:opacity-40"
                style={{ fontSize: "0.78rem", fontFamily: "inherit", background: "linear-gradient(135deg,#f59e0b,#d97706)", border: "none", cursor: "pointer", whiteSpace: "nowrap" }}
              >
                {catCreating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                Add
              </button>
            </div>

            {catError && <div className="mb-3 px-3 py-2 rounded-lg border border-red-500/30 text-red-400" style={{ fontSize: "0.78rem", background: "rgba(239,68,68,0.06)" }}>{catError}</div>}

            {/* Categories list */}
            {catsLoading ? (
              <div className="flex items-center justify-center py-8 text-zinc-400"><Loader2 className="w-5 h-5 animate-spin mr-2" /><span style={{ fontSize: "0.8rem" }}>Loading…</span></div>
            ) : catsList.length === 0 ? (
              <div className="py-6 text-center text-zinc-400" style={{ fontSize: "0.8rem" }}>No categories yet. Create one above.</div>
            ) : (
              <div className="space-y-1">
                {catsList.map((cat) => (
                  <div key={cat.id} className="flex items-center justify-between rounded-lg px-3 py-2.5 border border-black/[0.06] bg-black/[0.02]">
                    <div className="flex items-center gap-2">
                      <Tag className="w-3 h-3 text-amber-500" />
                      <span className="text-zinc-800" style={{ fontSize: "0.82rem" }}>{cat.name}</span>
                    </div>
                    <button
                      onClick={() => handleDeleteCategory(cat.id)}
                      className="p-1 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      style={{ background: "none", border: "none", cursor: "pointer" }}
                      title="Delete category"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create Product Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}>
          <div className="w-full max-w-lg rounded-xl border border-black/10 p-6" style={{ background: "#ffffff", maxHeight: "90vh", overflowY: "auto" }}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-zinc-900 font-semibold" style={{ fontSize: "1.1rem" }}>{editId ? "Edit Product" : "Create Product"}</h2>
              <button onClick={closeModal} className="text-zinc-500 hover:text-zinc-900" style={{ background: "none", border: "none", cursor: "pointer" }}><X className="w-5 h-5" /></button>
            </div>

            {createError && <div className="mb-4 px-3 py-2 rounded-lg border border-red-500/30 text-red-400" style={{ fontSize: "0.8rem", background: "rgba(239,68,68,0.06)" }}>{createError}</div>}

              <div className="space-y-4">
                {/* Product Image Upload */}
                <div>
                  <label className="text-zinc-600 font-medium" style={labelStyle}>Product Image</label>
                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageUpload(f); }}
                  />
                  <div
                    onClick={() => !imageUploading && imageInputRef.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleImageUpload(f); }}
                    className="relative flex items-center gap-4 rounded-lg border border-dashed border-black/20 bg-black/[0.02] cursor-pointer hover:border-amber-500/40 hover:bg-amber-500/[0.02] transition-colors"
                    style={{ padding: "0.75rem" }}
                  >
                    {imagePreview ? (
                      <>
                        <img src={imagePreview} alt="preview" className="w-16 h-16 rounded-lg object-cover border border-black/10 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-zinc-700 font-medium" style={{ fontSize: "0.78rem" }}>Image selected</p>
                          <p className="text-zinc-400" style={{ fontSize: "0.68rem" }}>Click to replace</p>
                        </div>
                        {imageUploading && (
                          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-white/70">
                            <Loader2 className="w-5 h-5 animate-spin text-amber-500" />
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setImagePreview(""); set("image_url", ""); if (imageInputRef.current) imageInputRef.current.value = ""; }}
                          className="ml-auto p-1 rounded-full text-zinc-400 hover:text-red-400 hover:bg-red-500/10 shrink-0"
                          style={{ background: "none", border: "none", cursor: "pointer" }}
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </>
                    ) : (
                      <div className="flex items-center gap-3 w-full">
                        <div className="w-16 h-16 rounded-lg border border-black/10 bg-black/[0.03] flex items-center justify-center shrink-0">
                          {imageUploading ? <Loader2 className="w-5 h-5 animate-spin text-amber-500" /> : <ImagePlus className="w-6 h-6 text-zinc-400" />}
                        </div>
                        <div>
                          <p className="text-zinc-600 font-medium" style={{ fontSize: "0.78rem" }}>Click or drag to upload</p>
                          <p className="text-zinc-400" style={{ fontSize: "0.68rem" }}>JPEG, PNG, WebP · max 5MB</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <label className="text-zinc-600 font-medium" style={labelStyle}>Name *</label>
                  <input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Premium Waterproofing" className={inputCls} style={inputStyle} />
                </div>

                  <div>
                    <label className="text-zinc-600 font-medium" style={labelStyle}>Base Price *</label>
                    <input type="number" value={form.base_price} onChange={(e) => set("base_price", e.target.value)} placeholder="0" className={inputCls} style={inputStyle} />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="text-zinc-600 font-medium" style={labelStyle}>Unit of Measure</label>
                      <select value={form.unit_of_measure} onChange={(e) => set("unit_of_measure", e.target.value)}
                        className={inputCls} style={inputStyle}>
                        {unitOptions.map((u) => <option key={u} value={u} style={{ background: "#1a1a1c" }}>{u}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-zinc-600 font-medium" style={labelStyle}>Pack Size</label>
                      <input type="number" value={form.pack_size} onChange={(e) => set("pack_size", e.target.value)} placeholder="e.g. 20" className={inputCls} style={inputStyle} />
                    </div>
                  </div>

                  <div className="rounded-lg border border-black/10 p-3" style={{ background: "rgba(0,0,0,0.02)" }}>
                    <div className="text-zinc-700 font-medium mb-3" style={labelStyle}>Net Weight (with packaging)</div>
                    <div>
                      <label className="text-zinc-600 font-medium" style={labelStyle}>Actual Net Weight</label>
                      <div className="relative">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={form.net_weight_with_packaging}
                          onChange={(e) => set("net_weight_with_packaging", e.target.value)}
                          placeholder="e.g. 20"
                          className={inputCls}
                          style={{ ...inputStyle, paddingRight: "3.5rem" }}
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 font-medium" style={{ fontSize: "0.75rem" }}>
                          KG
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* HSN Code */}
                  <div>
                    <label className="text-zinc-600 font-medium" style={labelStyle}>HSN Code</label>
                    <input
                      value={form.hsn_code}
                      onChange={(e) => set("hsn_code", e.target.value)}
                      placeholder="e.g. 3824 40 10"
                      className={inputCls + " font-mono"}
                      style={inputStyle}
                    />
                  </div>

                  {/* Category picker */}
                  <div>
                    <label className="text-zinc-600 font-medium" style={labelStyle}>Category</label>
                    <select
                      value={form.category_id}
                      onChange={(e) => set("category_id", e.target.value)}
                      className={inputCls}
                      style={inputStyle}
                    >
                      <option value="">— Select category —</option>
                      {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    {categories.length === 0 && (
                      <p className="text-zinc-400 mt-1" style={{ fontSize: "0.65rem" }}>
                        No categories yet.{" "}
                        <button
                          type="button"
                          onClick={() => { setShowCreate(false); openManageCats(); }}
                          className="text-amber-500 hover:underline"
                          style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", padding: 0 }}
                        >
                          Create one first →
                        </button>
                      </p>
                    )}
                  </div>



            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button onClick={closeModal}
                className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:bg-black/5"
                style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}>
                Cancel
              </button>
              <button onClick={handleCreate} disabled={creating}
                className="inline-flex items-center gap-2 px-5 py-2 rounded-lg text-black font-semibold hover:opacity-90 disabled:opacity-50"
                style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "linear-gradient(135deg,#f59e0b,#d97706)", border: "none", cursor: "pointer" }}>
                {creating && <Loader2 className="w-4 h-4 animate-spin" />}
                {creating ? (editId ? "Saving..." : "Creating...") : (editId ? "Save Changes" : "Create Product")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
