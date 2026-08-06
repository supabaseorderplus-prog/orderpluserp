"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import {
  AlertTriangle, CheckCircle, ChevronDown, ChevronRight,
  Edit2, FlaskConical, Package, Plus, Search, Trash2,
  TrendingDown, TrendingUp, Warehouse, X, ArrowDownToLine,
  ArrowUpFromLine, History, Layers, Info, Loader2, RefreshCw,
} from "lucide-react";
import { api } from "@/lib/api";

// ─── Types ────────────────────────────────────────────────────────────────────

type Category = "Raw Material" | "Finished Goods" | "Packaging" | "Consumable" | "Intermediate";
type Unit = "kg" | "g" | "L" | "mL" | "pcs" | "bags" | "drums" | "boxes" | "bottles" | "tons";

interface ProductOption {
  id: string;
  name: string;
  hsn_code: string;
}

interface InventoryItem {
  id: string;
  name: string;
  code: string;
  category: Category;
  unit: Unit;
  current_stock: number;
  min_stock: number;
  max_stock: number;
  cost_per_unit: number;
  location: string;
  supplier: string;
  created_at: string;
  updated_at: string;
}

interface StockMovement {
  id: string;
  item_id: string;
  type: "in" | "out" | "adjustment";
  quantity: number;
  reason: string;
  reference: string;
  created_at: string;
}

interface BOMComponent {
  id: string;
  material_id: string;
  material_name: string;
  quantity: number;
  unit: Unit;
  notes: string;
}

interface BOM {
  id: string;
  product_name: string;
  product_code: string;
  batch_size: number;
  batch_unit: Unit;
  description: string;
  components: BOMComponent[];
  created_at: string;
  updated_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

const CATEGORIES: Category[] = ["Raw Material", "Finished Goods", "Intermediate", "Packaging", "Consumable"];
const UNITS: Unit[] = ["kg", "g", "L", "mL", "pcs", "bags", "drums", "boxes", "bottles", "tons"];

function stockStatus(item: InventoryItem) {
  if (item.current_stock <= 0) return { label: "Out of Stock", color: "text-red-400 bg-red-500/10 border-red-500/20" };
  if (item.current_stock <= item.min_stock) return { label: "Low Stock", color: "text-orange-400 bg-orange-500/10 border-orange-500/20" };
  if (item.max_stock > 0 && item.current_stock > item.max_stock) return { label: "Overstock", color: "text-sky-400 bg-sky-500/10 border-sky-500/20" };
  return { label: "In Stock", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" };
}

function isBomInventorySchemaMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.toLowerCase().includes("bom and inventory database migration has not been applied yet");
}

function categoryColor(c: Category) {
  const map: Record<Category, string> = {
    "Raw Material": "bg-amber-500/10 text-amber-400",
    "Finished Goods": "bg-emerald-500/10 text-emerald-400",
    "Intermediate": "bg-violet-500/10 text-violet-400",
    "Packaging": "bg-blue-500/10 text-blue-400",
    "Consumable": "bg-zinc-500/10 text-zinc-500",
  };
  return map[c] ?? "bg-zinc-500/10 text-zinc-500";
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ModalOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(4px)" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-yellow-50 rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto border border-yellow-200/[0.5]">
        {children}
      </div>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-zinc-600 mb-1">{label}</label>
      {children}
    </div>
  );
}

const inputCls = "w-full px-3 py-2 rounded-lg border border-black/10 bg-black/[0.02] text-zinc-900 text-sm outline-none focus:border-amber-400 transition-colors";
const selectCls = "w-full px-3 py-2 rounded-lg border border-black/10 bg-black/[0.02] text-zinc-900 text-sm outline-none focus:border-amber-400 transition-colors appearance-none";

// ─── Inventory Item Modal ─────────────────────────────────────────────────────

function ItemModal({ item, onSave, onClose, saving }: {
  item: InventoryItem | null;
  onSave: (i: Omit<InventoryItem, 'id' | 'created_at' | 'updated_at'> & { id?: string }) => void;
  onClose: () => void;
  saving: boolean;
}) {
  const blank = { name: "", code: "", category: "Raw Material" as Category, unit: "kg" as Unit, current_stock: 0, min_stock: 0, max_stock: 0, cost_per_unit: 0, location: "", supplier: "" };
  const [form, setForm] = useState(item ? {
    name: item.name, code: item.code, category: item.category, unit: item.unit,
    current_stock: item.current_stock, min_stock: item.min_stock, max_stock: item.max_stock,
    cost_per_unit: item.cost_per_unit, location: item.location, supplier: item.supplier,
  } : blank);
  const f = (k: string, v: string | number) => setForm(p => ({ ...p, [k]: v }));

  return (
    <ModalOverlay onClose={onClose}>
      <div className="p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-zinc-900 font-semibold text-base">{item ? "Edit Item" : "New Inventory Item"}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/5" style={{ background: "none", border: "none", cursor: "pointer" }}><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="Item Name *">
              <input className={inputCls} value={form.name} onChange={e => f("name", e.target.value)} placeholder="e.g. Sodium Hydroxide" />
            </FieldRow>
            <FieldRow label="Code / SKU">
              <input className={inputCls} value={form.code} onChange={e => f("code", e.target.value)} placeholder="e.g. RM-001" />
            </FieldRow>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="Category">
              <select className={selectCls} value={form.category} onChange={e => f("category", e.target.value as Category)}>
                {CATEGORIES.map(c => <option key={c}>{c}</option>)}
              </select>
            </FieldRow>
            <FieldRow label="Unit">
              <select className={selectCls} value={form.unit} onChange={e => f("unit", e.target.value as Unit)}>
                {UNITS.map(u => <option key={u}>{u}</option>)}
              </select>
            </FieldRow>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <FieldRow label="Current Stock">
              <input className={inputCls} type="number" min={0} value={form.current_stock} onChange={e => f("current_stock", Number(e.target.value))} />
            </FieldRow>
            <FieldRow label="Min Stock">
              <input className={inputCls} type="number" min={0} value={form.min_stock} onChange={e => f("min_stock", Number(e.target.value))} />
            </FieldRow>
            <FieldRow label="Max Stock">
              <input className={inputCls} type="number" min={0} value={form.max_stock} onChange={e => f("max_stock", Number(e.target.value))} />
            </FieldRow>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="Cost per Unit (₹)">
              <input className={inputCls} type="number" min={0} step={0.01} value={form.cost_per_unit} onChange={e => f("cost_per_unit", Number(e.target.value))} />
            </FieldRow>
            <FieldRow label="Location">
              <input className={inputCls} value={form.location} onChange={e => f("location", e.target.value)} placeholder="e.g. Rack A-2" />
            </FieldRow>
          </div>
          <FieldRow label="Supplier">
            <input className={inputCls} value={form.supplier} onChange={e => f("supplier", e.target.value)} placeholder="e.g. Avantor" />
          </FieldRow>
        </div>
        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 rounded-xl border border-black/10 text-zinc-600 text-sm hover:bg-black/5 transition-all" style={{ background: "none", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          <button
            onClick={() => { if (!form.name.trim()) return; onSave({ ...form, ...(item ? { id: item.id } : {}) }); }}
            disabled={saving || !form.name.trim()}
            className="flex-1 px-4 py-2.5 rounded-xl bg-amber-500 text-zinc-900 font-semibold text-sm hover:bg-amber-400 transition-all disabled:opacity-50"
            style={{ cursor: "pointer", border: "none", fontFamily: "inherit" }}
          >
            {saving ? <span className="flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Saving…</span> : item ? "Save Changes" : "Add Item"}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

// ─── Stock Movement Modal ─────────────────────────────────────────────────────

function StockMoveModal({ item, type, onSave, onClose, saving }: {
  item: InventoryItem;
  type: "in" | "out";
  onSave: (qty: number, reason: string, ref: string) => void;
  onClose: () => void;
  saving: boolean;
}) {
  const [qty, setQty] = useState(0);
  const [reason, setReason] = useState("");
  const [ref, setRef] = useState("");

  const inReasons = ["Purchase Receipt", "Production Return", "Transfer In", "Opening Stock", "Adjustment"];
  const outReasons = ["Production Consumption", "Sales Dispatch", "Wastage", "Transfer Out", "Sample", "Adjustment"];
  const reasons = type === "in" ? inReasons : outReasons;

  return (
    <ModalOverlay onClose={onClose}>
      <div className="p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${type === "in" ? "bg-emerald-500/10 border border-emerald-500/20" : "bg-red-500/10 border border-red-500/20"}`}>
            {type === "in" ? <ArrowDownToLine className="w-4 h-4 text-emerald-400" /> : <ArrowUpFromLine className="w-4 h-4 text-red-400" />}
          </div>
          <div>
            <h2 className="text-zinc-900 font-semibold text-base">{type === "in" ? "Stock In" : "Stock Out"}</h2>
            <p className="text-zinc-500 text-xs">{item.name} · Current: {item.current_stock} {item.unit}</p>
          </div>
          <button onClick={onClose} className="ml-auto p-1.5 rounded-lg text-zinc-500 hover:bg-black/5" style={{ background: "none", border: "none", cursor: "pointer" }}><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-3">
          <FieldRow label={`Quantity (${item.unit}) *`}>
            <input className={inputCls} type="number" min={0.001} step={0.001} value={qty || ""} onChange={e => setQty(Number(e.target.value))} placeholder="0" />
          </FieldRow>
          <FieldRow label="Reason *">
            <select className={selectCls} value={reason} onChange={e => setReason(e.target.value)}>
              <option value="">Select reason...</option>
              {reasons.map(r => <option key={r}>{r}</option>)}
            </select>
          </FieldRow>
          <FieldRow label="Reference (optional)">
            <input className={inputCls} value={ref} onChange={e => setRef(e.target.value)} placeholder="PO number, Lot number, Invoice..." />
          </FieldRow>
          {type === "out" && qty > item.current_stock && (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-orange-500/10 border border-orange-500/20">
              <AlertTriangle className="w-4 h-4 text-orange-400 shrink-0" />
              <span className="text-orange-400 text-xs">Quantity exceeds current stock ({item.current_stock} {item.unit})</span>
            </div>
          )}
        </div>
        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 rounded-xl border border-black/10 text-zinc-600 text-sm hover:bg-black/5 transition-all" style={{ background: "none", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          <button
            onClick={() => { if (!qty || !reason) return; onSave(qty, reason, ref); }}
            disabled={!qty || !reason || saving}
            className={`flex-1 px-4 py-2.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-40 ${type === "in" ? "bg-emerald-500 hover:bg-emerald-400 text-white" : "bg-red-500 hover:bg-red-400 text-white"}`}
            style={{ cursor: "pointer", border: "none", fontFamily: "inherit" }}
          >
            {saving ? <span className="flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /></span> : type === "in" ? "Add Stock" : "Consume Stock"}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

// ─── BOM Modal ────────────────────────────────────────────────────────────────

function BOMModal({ bom, inventory, onSave, onClose, saving }: {
  bom: BOM | null;
  inventory: InventoryItem[];
  onSave: (b: Omit<BOM, 'id' | 'created_at' | 'updated_at'> & { id?: string }) => void;
  onClose: () => void;
  saving: boolean;
}) {
  const blank: Omit<BOM, 'id' | 'created_at' | 'updated_at'> = { product_name: "", product_code: "", batch_size: 1, batch_unit: "kg", description: "", components: [] };
  const [form, setForm] = useState(bom ? {
    product_name: bom.product_name, product_code: bom.product_code, batch_size: bom.batch_size,
    batch_unit: bom.batch_unit, description: bom.description, components: [...bom.components],
  } : blank);
  const f = (k: string, v: string | number | BOMComponent[]) => setForm(p => ({ ...p, [k]: v }));

  const [products, setProducts] = useState<ProductOption[]>([]);
  const [productsLoading, setProductsLoading] = useState(true);

  useEffect(() => {
    setProductsLoading(true);
    api<{ success: boolean; data: Array<{ id: string; name: string; hsn_codes?: { hsn_code: string } | null }> }>("/api/v1/products?limit=200")
      .then(res => {
        const opts = (res.data || []).map(p => ({ id: p.id, name: p.name, hsn_code: p.hsn_codes?.hsn_code || "" }));
        setProducts(opts);
      })
      .catch(() => setProducts([]))
      .finally(() => setProductsLoading(false));
  }, []);

  const handleProductSelect = (productId: string) => {
    const product = products.find(p => p.id === productId);
    if (product) setForm(p => ({ ...p, product_name: product.name, product_code: product.hsn_code }));
    else setForm(p => ({ ...p, product_name: "", product_code: "" }));
  };

  const addComponent = () => setForm(p => ({
    ...p,
    components: [...p.components, { id: uid(), material_id: "", material_name: "", quantity: 0, unit: "kg" as Unit, notes: "" }]
  }));

  const removeComponent = (id: string) => setForm(p => ({ ...p, components: p.components.filter(c => c.id !== id) }));

  const updateComponent = (id: string, k: keyof BOMComponent, v: string | number) => setForm(p => ({
    ...p,
    components: p.components.map(c => c.id === id ? { ...c, [k]: v } : c)
  }));

  const selectMaterial = (id: string, invId: string) => {
    const item = inventory.find(i => i.id === invId);
    if (item) {
      setForm(p => ({
        ...p,
        components: p.components.map(c => c.id === id ? { ...c, material_id: invId, material_name: item.name, unit: item.unit } : c)
      }));
    }
  };

  const selectedProductId = products.find(p => p.name === form.product_name)?.id || "";

  return (
    <ModalOverlay onClose={onClose}>
      <div className="p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-zinc-900 font-semibold text-base">{bom ? "Edit BOM" : "New Bill of Materials"}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg text-zinc-500 hover:bg-black/5" style={{ background: "none", border: "none", cursor: "pointer" }}><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-3 mb-5">
          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="Product Name *">
              {productsLoading ? (
                <div className={inputCls + " text-zinc-400"}>Loading products…</div>
              ) : products.length > 0 ? (
                <select className={selectCls} value={selectedProductId} onChange={e => handleProductSelect(e.target.value)}>
                  <option value="">— Select a product —</option>
                  {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              ) : (
                <input className={inputCls} value={form.product_name} onChange={e => f("product_name", e.target.value)} placeholder="e.g. Cleaning Agent A" />
              )}
            </FieldRow>
            <FieldRow label="Product Code (HSN)">
              <input
                className={inputCls + (form.product_code ? " bg-amber-500/5 border-amber-500/20 font-mono" : "")}
                value={form.product_code}
                onChange={e => f("product_code", e.target.value)}
                placeholder="Auto-filled from product"
                readOnly={!!selectedProductId}
              />
            </FieldRow>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="Batch Size *">
              <input className={inputCls} type="number" min={0.001} step={0.001} value={form.batch_size} onChange={e => f("batch_size", Number(e.target.value))} />
            </FieldRow>
            <FieldRow label="Batch Unit">
              <select className={selectCls} value={form.batch_unit} onChange={e => f("batch_unit", e.target.value as Unit)}>
                {UNITS.map(u => <option key={u}>{u}</option>)}
              </select>
            </FieldRow>
          </div>
          <FieldRow label="Description">
            <input className={inputCls} value={form.description} onChange={e => f("description", e.target.value)} placeholder="Optional notes about this formulation" />
          </FieldRow>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-zinc-900 text-sm font-semibold">Components / Raw Materials</h3>
            <button onClick={addComponent} className="flex items-center gap-1.5 text-xs text-amber-500 hover:text-amber-400 font-medium transition-colors" style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>
              <Plus className="w-3.5 h-3.5" /> Add Component
            </button>
          </div>
          {form.components.length === 0 && (
            <div className="text-center py-4 text-zinc-400 text-xs border border-dashed border-black/10 rounded-xl">
              No components yet. Click "Add Component" to start.
            </div>
          )}
          <div className="space-y-2">
            {form.components.map((comp, i) => (
              <div key={comp.id} className="p-3 rounded-xl border border-black/[0.06] bg-black/[0.02]">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-zinc-500 text-[0.6rem] font-semibold w-5 text-center shrink-0">{i + 1}</span>
                  <div className="flex-1 grid grid-cols-2 sm:grid-cols-5 gap-2">
                    <div className="col-span-2">
                      {inventory.length > 0 ? (
                        <select
                          className={selectCls + " text-xs"}
                          value={comp.material_id || "__manual__"}
                          onChange={e => {
                            if (e.target.value === "__manual__") updateComponent(comp.id, "material_id", "");
                            else selectMaterial(comp.id, e.target.value);
                          }}
                        >
                          <option value="__manual__">— Type manually —</option>
                          {inventory.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
                        </select>
                      ) : (
                        <input className={inputCls + " text-xs"} placeholder="Material name" value={comp.material_name} onChange={e => updateComponent(comp.id, "material_name", e.target.value)} />
                      )}
                    </div>
                    {!comp.material_id && inventory.length > 0 && (
                      <input className={inputCls + " text-xs col-span-1"} placeholder="Name" value={comp.material_name} onChange={e => updateComponent(comp.id, "material_name", e.target.value)} />
                    )}
                    <input className={`${inputCls} text-xs ${comp.material_id || inventory.length === 0 ? "col-span-1" : ""}`} type="number" min={0} step={0.001} placeholder="Qty" value={comp.quantity || ""} onChange={e => updateComponent(comp.id, "quantity", Number(e.target.value))} />
                    <select className={`${selectCls} text-xs ${comp.material_id || inventory.length === 0 ? "col-span-1" : ""}`} value={comp.unit} onChange={e => updateComponent(comp.id, "unit", e.target.value as Unit)}>
                      {UNITS.map(u => <option key={u}>{u}</option>)}
                    </select>
                  </div>
                  <button onClick={() => removeComponent(comp.id)} className="text-zinc-400 hover:text-red-400 transition-colors shrink-0" style={{ background: "none", border: "none", cursor: "pointer" }}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <input className={inputCls + " text-xs"} placeholder="Notes (optional)" value={comp.notes} onChange={e => updateComponent(comp.id, "notes", e.target.value)} />
              </div>
            ))}
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 rounded-xl border border-black/10 text-zinc-600 text-sm hover:bg-black/5 transition-all" style={{ background: "none", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          <button
            onClick={() => { if (!form.product_name.trim()) return; onSave({ ...form, ...(bom ? { id: bom.id } : {}) }); }}
            disabled={saving || !form.product_name.trim()}
            className="flex-1 px-4 py-2.5 rounded-xl bg-amber-500 text-zinc-900 font-semibold text-sm hover:bg-amber-400 transition-all disabled:opacity-50"
            style={{ cursor: "pointer", border: "none", fontFamily: "inherit" }}
          >
            {saving ? <span className="flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /></span> : bom ? "Save Changes" : "Create BOM"}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

// ─── Movement History Modal ───────────────────────────────────────────────────

function HistoryModal({ item, onClose }: { item: InventoryItem; onClose: () => void }) {
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ success: boolean; data: StockMovement[] }>(`/api/v1/stock-movements?item_id=${item.id}`)
      .then(res => setMovements(res.data || []))
      .catch((err) => {
        if (!isBomInventorySchemaMessage(err)) setMovements([]);
        else setMovements([]);
      })
      .finally(() => setLoading(false));
  }, [item.id]);

  return (
    <ModalOverlay onClose={onClose}>
      <div className="p-6">
        <div className="flex items-center gap-3 mb-5">
          <History className="w-5 h-5 text-amber-400" />
          <div className="flex-1">
            <h2 className="text-zinc-900 font-semibold text-base">{item.name}</h2>
            <p className="text-zinc-500 text-xs">Stock movement history</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-zinc-500 hover:bg-black/5" style={{ background: "none", border: "none", cursor: "pointer" }}><X className="w-4 h-4" /></button>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-amber-400" /></div>
        ) : movements.length === 0 ? (
          <div className="text-center py-10 text-zinc-400 text-sm">No movements recorded yet.</div>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {movements.map(m => (
              <div key={m.id} className="flex items-start gap-3 p-3 rounded-xl border border-black/[0.06] bg-black/[0.01]">
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${m.type === "in" ? "bg-emerald-500/10" : "bg-red-500/10"}`}>
                  {m.type === "in" ? <TrendingUp className="w-3.5 h-3.5 text-emerald-400" /> : <TrendingDown className="w-3.5 h-3.5 text-red-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className={`text-sm font-semibold ${m.type === "in" ? "text-emerald-400" : "text-red-400"}`}>
                      {m.type === "in" ? "+" : "-"}{m.quantity} {item.unit}
                    </span>
                    <span className="text-zinc-500 text-xs">{new Date(m.created_at).toLocaleDateString("en-IN")}</span>
                  </div>
                  <p className="text-zinc-600 text-xs mt-0.5">{m.reason}</p>
                  {m.reference && <p className="text-zinc-500 text-[0.6rem] mt-0.5">Ref: {m.reference}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </ModalOverlay>
  );
}

// ─── BOM Detail Modal ─────────────────────────────────────────────────────────

function BOMDetailModal({ bom, inventory, onClose }: { bom: BOM; inventory: InventoryItem[]; onClose: () => void }) {
  const totalCost = bom.components.reduce((sum, c) => {
    const inv = inventory.find(i => i.id === c.material_id);
    return sum + (inv ? inv.cost_per_unit * c.quantity : 0);
  }, 0);

  return (
    <ModalOverlay onClose={onClose}>
      <div className="p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0">
            <FlaskConical className="w-5 h-5 text-violet-400" />
          </div>
          <div className="flex-1">
            <h2 className="text-zinc-900 font-semibold text-base">{bom.product_name}</h2>
            <p className="text-zinc-500 text-xs">{bom.product_code} · Batch: {bom.batch_size} {bom.batch_unit}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-zinc-500 hover:bg-black/5" style={{ background: "none", border: "none", cursor: "pointer" }}><X className="w-4 h-4" /></button>
        </div>
        {bom.description && <p className="text-zinc-500 text-sm mb-4">{bom.description}</p>}
        <div className="space-y-2 mb-4">
          {bom.components.map((comp, i) => {
            const inv = inventory.find(iv => iv.id === comp.material_id);
            const st = inv ? stockStatus(inv) : null;
            return (
              <div key={comp.id} className="flex items-center gap-3 p-3 rounded-xl border border-black/[0.06] bg-black/[0.01]">
                <span className="text-zinc-400 text-xs w-5 text-center shrink-0">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-zinc-900 text-sm font-medium">{comp.material_name}</div>
                  {comp.notes && <div className="text-zinc-500 text-xs">{comp.notes}</div>}
                </div>
                <div className="text-right shrink-0">
                  <div className="text-zinc-900 text-sm font-semibold">{comp.quantity} {comp.unit}</div>
                  {inv && <div className="text-zinc-500 text-[0.6rem]">Stock: {inv.current_stock} {inv.unit}</div>}
                </div>
                {st && <span className={`px-1.5 py-0.5 rounded-md text-[0.6rem] font-medium border shrink-0 ${st.color}`}>{st.label}</span>}
              </div>
            );
          })}
        </div>
        {totalCost > 0 && (
          <div className="flex items-center justify-between p-3 rounded-xl bg-amber-500/5 border border-amber-500/20">
            <span className="text-zinc-600 text-sm">Estimated Batch Cost</span>
            <span className="text-amber-400 font-bold text-sm">₹{totalCost.toFixed(2)}</span>
          </div>
        )}
      </div>
    </ModalOverlay>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function BOMInventoryPage() {
  const [tab, setTab] = useState<"inventory" | "bom">("inventory");
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [boms, setBOMs] = useState<BOM[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState<"All" | Category>("All");
  const [error, setError] = useState("");

  // Modals
  const [itemModal, setItemModal] = useState<{ open: boolean; item: InventoryItem | null }>({ open: false, item: null });
  const [stockModal, setStockModal] = useState<{ open: boolean; item: InventoryItem | null; type: "in" | "out" }>({ open: false, item: null, type: "in" });
  const [historyModal, setHistoryModal] = useState<InventoryItem | null>(null);
  const [bomModal, setBOMModal] = useState<{ open: boolean; bom: BOM | null }>({ open: false, bom: null });
  const [bomDetail, setBOMDetail] = useState<BOM | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [invRes, bomRes] = await Promise.all([
        api<{ success: boolean; data: InventoryItem[] }>("/api/v1/raw-materials"),
        api<{ success: boolean; data: BOM[] }>("/api/v1/bom-items"),
      ]);
      setInventory(invRes.data || []);
      setBOMs(bomRes.data || []);
    } catch (err) {
      if (isBomInventorySchemaMessage(err)) {
        setInventory([]);
        setBOMs([]);
        setError("");
      } else {
        setError(err instanceof Error ? err.message : "Failed to load data");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ── Inventory CRUD ──────────────────────────────────────────────────────────

  const saveItem = async (item: Omit<InventoryItem, 'id' | 'created_at' | 'updated_at'> & { id?: string }) => {
    setSaving(true);
    setError("");
    try {
      if (item.id) {
        await api("/api/v1/raw-materials", { method: "PUT", body: item });
      } else {
        await api("/api/v1/raw-materials", { method: "POST", body: item });
      }
      setItemModal({ open: false, item: null });
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save item");
    } finally {
      setSaving(false);
    }
  };

  const deleteItem = async (id: string) => {
    if (!confirm("Delete this item? All stock history will also be removed.")) return;
    setError("");
    try {
      await api(`/api/v1/raw-materials?id=${id}`, { method: "DELETE" });
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete item");
    }
  };

  const applyStock = async (item: InventoryItem, type: "in" | "out", qty: number, reason: string, ref: string) => {
    setSaving(true);
    setError("");
    try {
      await api("/api/v1/stock-movements", {
        method: "POST",
        body: { item_id: item.id, type, quantity: qty, reason, reference: ref },
      });
      setStockModal({ open: false, item: null, type: "in" });
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record movement");
    } finally {
      setSaving(false);
    }
  };

  // ── BOM CRUD ────────────────────────────────────────────────────────────────

  const saveBOM = async (bom: Omit<BOM, 'id' | 'created_at' | 'updated_at'> & { id?: string }) => {
    setSaving(true);
    setError("");
    try {
      if (bom.id) {
        await api("/api/v1/bom-items", { method: "PUT", body: bom });
      } else {
        await api("/api/v1/bom-items", { method: "POST", body: bom });
      }
      setBOMModal({ open: false, bom: null });
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save BOM");
    } finally {
      setSaving(false);
    }
  };

  const deleteBOM = async (id: string) => {
    if (!confirm("Delete this BOM?")) return;
    setError("");
    try {
      await api(`/api/v1/bom-items?id=${id}`, { method: "DELETE" });
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete BOM");
    }
  };

  // ── Derived data ────────────────────────────────────────────────────────────

  const filteredInventory = useMemo(() => {
    return inventory.filter(i => {
      const matchCat = catFilter === "All" || i.category === catFilter;
      const matchSearch = !search || i.name.toLowerCase().includes(search.toLowerCase()) || i.code.toLowerCase().includes(search.toLowerCase());
      return matchCat && matchSearch;
    });
  }, [inventory, catFilter, search]);

  const filteredBOMs = useMemo(() => {
    if (!search) return boms;
    return boms.filter(b => b.product_name.toLowerCase().includes(search.toLowerCase()) || b.product_code.toLowerCase().includes(search.toLowerCase()));
  }, [boms, search]);

  const inventoryStats = useMemo(() => ({
    total: inventory.length,
    lowStock: inventory.filter(i => i.current_stock <= i.min_stock && i.current_stock > 0).length,
    outOfStock: inventory.filter(i => i.current_stock <= 0).length,
    totalValue: inventory.reduce((s, i) => s + i.current_stock * i.cost_per_unit, 0),
  }), [inventory]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2.5 mb-0.5">
            <div className="w-8 h-8 rounded-lg bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0">
              <Layers className="w-4 h-4 text-violet-400" />
            </div>
            <h1 className="text-zinc-900 text-xl font-bold">BOM &amp; Inventory</h1>
          </div>
          <p className="text-zinc-500 text-sm ml-10">Manage raw materials, finished goods and product formulations</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadAll}
            className="p-2 rounded-xl border border-black/10 text-zinc-500 hover:text-zinc-800 hover:border-black/20 transition-all"
            style={{ background: "none", cursor: "pointer" }}
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => tab === "inventory" ? setItemModal({ open: true, item: null }) : setBOMModal({ open: true, bom: null })}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500 text-zinc-900 font-semibold text-sm hover:bg-amber-400 transition-all shrink-0"
            style={{ border: "none", cursor: "pointer", fontFamily: "inherit" }}
          >
            <Plus className="w-4 h-4" />
            {tab === "inventory" ? "Add Item" : "New BOM"}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center justify-between p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          <span>{error}</span>
          <button onClick={() => setError("")} style={{ background: "none", border: "none", cursor: "pointer" }}><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 p-1 rounded-xl bg-black/[0.03] border border-black/[0.06] w-fit">
        {([["inventory", "Inventory", Warehouse], ["bom", "Bill of Materials", FlaskConical]] as const).map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => { setTab(key); setSearch(""); setCatFilter("All"); }}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${tab === key ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-700"}`}
            style={{ border: "none", cursor: "pointer", fontFamily: "inherit", background: tab === key ? "#ffffff" : "none", boxShadow: tab === key ? "0 1px 3px rgba(0,0,0,0.08)" : "none" }}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-zinc-500">
          <Loader2 className="w-6 h-6 animate-spin mr-2 text-amber-400" />
          <span className="text-sm">Loading…</span>
        </div>
      ) : (
        <>
          {/* ── INVENTORY TAB ─────────────────────────────────────────────────── */}
          {tab === "inventory" && (
            <>
              {/* Stats */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: "Total Items", value: inventoryStats.total, icon: Package, color: "from-zinc-100 to-zinc-200" },
                  { label: "Low Stock", value: inventoryStats.lowStock, icon: AlertTriangle, color: "from-orange-500/10 to-orange-600/5", dot: "bg-orange-400" },
                  { label: "Out of Stock", value: inventoryStats.outOfStock, icon: X, color: "from-red-500/10 to-red-600/5", dot: "bg-red-400" },
                  { label: "Total Value", value: `₹${inventoryStats.totalValue >= 1000 ? (inventoryStats.totalValue / 1000).toFixed(1) + "k" : inventoryStats.totalValue.toFixed(0)}`, icon: TrendingUp, color: "from-emerald-500/10 to-emerald-600/5", dot: "bg-emerald-400" },
                ].map(s => (
                  <div key={s.label} className={`rounded-xl p-4 bg-gradient-to-br ${s.color} border border-black/[0.06]`}>
                    <div className="flex items-center justify-between mb-2">
                      <s.icon className="w-4 h-4 text-zinc-600" />
                      {"dot" in s && <span className={`w-2 h-2 rounded-full ${s.dot}`} />}
                    </div>
                    <div className="text-zinc-900 text-2xl font-bold">{s.value}</div>
                    <div className="text-zinc-500 text-xs mt-0.5">{s.label}</div>
                  </div>
                ))}
              </div>

              {/* Filters */}
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                  <input type="text" placeholder="Search items..." value={search} onChange={e => setSearch(e.target.value)} className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-black/10 bg-white text-zinc-900 text-sm outline-none focus:border-amber-400 transition-colors" />
                </div>
                <div className="flex items-center gap-1 p-1 rounded-xl bg-black/[0.03] border border-black/[0.06] flex-wrap">
                  {(["All", ...CATEGORIES] as const).map(c => (
                    <button key={c} onClick={() => setCatFilter(c as "All" | Category)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${catFilter === c ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-700"}`}
                      style={{ border: "none", cursor: "pointer", fontFamily: "inherit", background: catFilter === c ? "#ffffff" : "none", boxShadow: catFilter === c ? "0 1px 3px rgba(0,0,0,0.08)" : "none" }}
                    >{c === "All" ? `All (${inventory.length})` : c}</button>
                  ))}
                </div>
              </div>

              {/* Table */}
              {filteredInventory.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-zinc-500">
                  <Warehouse className="w-12 h-12 mb-3 opacity-20" />
                  <p className="text-sm font-medium">{inventory.length === 0 ? "No items yet" : "No items match your search"}</p>
                  <p className="text-xs mt-1 text-zinc-400">{inventory.length === 0 ? 'Click "Add Item" to add your first inventory item.' : "Try a different search or filter."}</p>
                </div>
              ) : (
                <div className="rounded-xl border border-black/[0.06] overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full" style={{ borderCollapse: "collapse" }}>
                      <thead>
                        <tr className="border-b border-black/[0.06]">
                          {["Item", "Category", "Unit", "Current Stock", "Min / Max", "Cost/Unit", "Status", "Actions"].map(h => (
                            <th key={h} className="text-left px-4 py-3 text-[0.65rem] font-semibold text-zinc-500 uppercase tracking-wider bg-black/[0.02] whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredInventory.map(item => {
                          const st = stockStatus(item);
                          return (
                            <tr key={item.id} className="border-b border-black/[0.04] hover:bg-black/[0.01] transition-colors">
                              <td className="px-4 py-3">
                                <div className="text-zinc-900 text-sm font-medium">{item.name}</div>
                                <div className="text-zinc-500 text-[0.65rem] font-mono">{item.code || "—"}</div>
                                {item.location && <div className="text-zinc-500 text-[0.6rem]">📍 {item.location}</div>}
                              </td>
                              <td className="px-4 py-3">
                                <span className={`px-2 py-0.5 rounded-md text-[0.65rem] font-medium ${categoryColor(item.category)}`}>{item.category}</span>
                              </td>
                              <td className="px-4 py-3 text-zinc-600 text-sm">{item.unit}</td>
                              <td className="px-4 py-3">
                                <div className={`text-sm font-bold ${item.current_stock <= item.min_stock ? "text-orange-400" : "text-zinc-900"}`}>
                                  {Number(item.current_stock)} {item.unit}
                                </div>
                              </td>
                              <td className="px-4 py-3 text-zinc-500 text-xs">{Number(item.min_stock)} / {Number(item.max_stock) || "∞"}</td>
                              <td className="px-4 py-3 text-zinc-600 text-sm">{Number(item.cost_per_unit) > 0 ? `₹${Number(item.cost_per_unit)}` : "—"}</td>
                              <td className="px-4 py-3">
                                <span className={`px-2 py-0.5 rounded-full text-[0.6rem] font-medium border ${st.color}`}>{st.label}</span>
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-1">
                                  <button onClick={() => setStockModal({ open: true, item, type: "in" })} title="Stock In" className="p-1.5 rounded-lg text-emerald-400 hover:bg-emerald-500/10 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}><ArrowDownToLine className="w-3.5 h-3.5" /></button>
                                  <button onClick={() => setStockModal({ open: true, item, type: "out" })} title="Stock Out" className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/10 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}><ArrowUpFromLine className="w-3.5 h-3.5" /></button>
                                  <button onClick={() => setHistoryModal(item)} title="History" className="p-1.5 rounded-lg text-zinc-400 hover:bg-black/5 hover:text-zinc-600 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}><History className="w-3.5 h-3.5" /></button>
                                  <button onClick={() => setItemModal({ open: true, item })} title="Edit" className="p-1.5 rounded-lg text-zinc-400 hover:bg-black/5 hover:text-zinc-600 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}><Edit2 className="w-3.5 h-3.5" /></button>
                                  <button onClick={() => deleteItem(item.id)} title="Delete" className="p-1.5 rounded-lg text-zinc-400 hover:bg-red-500/10 hover:text-red-400 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}><Trash2 className="w-3.5 h-3.5" /></button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── BOM TAB ────────────────────────────────────────────────────────── */}
          {tab === "bom" && (
            <>
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input type="text" placeholder="Search BOMs..." value={search} onChange={e => setSearch(e.target.value)} className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-black/10 bg-white text-zinc-900 text-sm outline-none focus:border-amber-400 transition-colors" />
              </div>

              {filteredBOMs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-zinc-500">
                  <FlaskConical className="w-12 h-12 mb-3 opacity-20" />
                  <p className="text-sm font-medium">{boms.length === 0 ? "No BOMs yet" : "No BOMs match your search"}</p>
                  <p className="text-xs mt-1 text-zinc-400">{boms.length === 0 ? 'Click "New BOM" to create your first Bill of Materials.' : "Try a different search."}</p>
                </div>
              ) : (
                <div className="grid gap-3">
                  {filteredBOMs.map(bom => (
                    <div key={bom.id} className="rounded-xl border border-black/[0.06] bg-white p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3">
                          <div className="w-9 h-9 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0">
                            <FlaskConical className="w-4 h-4 text-violet-400" />
                          </div>
                          <div>
                            <div className="text-zinc-900 font-semibold text-sm">{bom.product_name}</div>
                            <div className="text-zinc-500 text-xs mt-0.5">
                              {bom.product_code && <span className="font-mono mr-2">{bom.product_code}</span>}
                              Batch: {bom.batch_size} {bom.batch_unit} · {bom.components.length} component{bom.components.length !== 1 ? "s" : ""}
                            </div>
                            {bom.description && <div className="text-zinc-400 text-xs mt-0.5">{bom.description}</div>}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button onClick={() => setBOMDetail(bom)} title="View" className="p-1.5 rounded-lg text-zinc-400 hover:bg-black/5 hover:text-violet-500 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}><Info className="w-3.5 h-3.5" /></button>
                          <button onClick={() => setBOMModal({ open: true, bom })} title="Edit" className="p-1.5 rounded-lg text-zinc-400 hover:bg-black/5 hover:text-zinc-600 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}><Edit2 className="w-3.5 h-3.5" /></button>
                          <button onClick={() => deleteBOM(bom.id)} title="Delete" className="p-1.5 rounded-lg text-zinc-400 hover:bg-red-500/10 hover:text-red-400 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* Modals */}
      {itemModal.open && (
        <ItemModal item={itemModal.item} onSave={saveItem} onClose={() => setItemModal({ open: false, item: null })} saving={saving} />
      )}
      {stockModal.open && stockModal.item && (
        <StockMoveModal item={stockModal.item} type={stockModal.type} onSave={(qty, reason, ref) => applyStock(stockModal.item!, stockModal.type, qty, reason, ref)} onClose={() => setStockModal({ open: false, item: null, type: "in" })} saving={saving} />
      )}
      {historyModal && (
        <HistoryModal item={historyModal} onClose={() => setHistoryModal(null)} />
      )}
      {bomModal.open && (
        <BOMModal bom={bomModal.bom} inventory={inventory} onSave={saveBOM} onClose={() => setBOMModal({ open: false, bom: null })} saving={saving} />
      )}
      {bomDetail && (
        <BOMDetailModal bom={bomDetail} inventory={inventory} onClose={() => setBOMDetail(null)} />
      )}
    </div>
  );
}
