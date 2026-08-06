"use client";

import React, { useEffect, useState, use } from "react";
import { api } from "@/lib/api";
import { Loader2, Printer } from "lucide-react";

interface LotOrder {
  order_id: string;
  invoice_number: string;
  party_name: string;
  grand_total: number;
  manufacturing_status: string;
}

interface DeliveryLot {
  id: string;
  lot_number: string;
  name: string;
  dispatch_date: string;
  destination: string;
  vehicle_no: string;
  driver_name: string;
  notes: string;
  status: string;
  order_ids: string[];
  order_meta: Record<string, { invoice_number: string; party_name: string; grand_total: number }>;
  manufacturing_statuses: Record<string, string>;
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

export default function DeliveryLotPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [lot, setLot] = useState<DeliveryLot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: DeliveryLot[] }>("/api/v1/delivery-lots")
      .then(res => {
        const lots = res.data || [];
        const found = lots.find(l => l.id === id);
        if (found) setLot(found);
        else setError("Delivery lot not found");
      })
      .catch(() => setError("Failed to load delivery lot"))
      .finally(() => setLoading(false));
  }, [id]);

  const orders: LotOrder[] = lot
    ? (lot.order_ids || []).map(oid => ({
        order_id: oid,
        invoice_number: lot.order_meta?.[oid]?.invoice_number || "—",
        party_name: lot.order_meta?.[oid]?.party_name || "—",
        grand_total: lot.order_meta?.[oid]?.grand_total || 0,
        manufacturing_status: lot.manufacturing_statuses?.[oid] || "Not Started",
      }))
    : [];

  const grandTotal = orders.reduce((s, o) => s + o.grand_total, 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
      </div>
    );
  }

  if (error || !lot) {
    return (
      <div className="flex items-center justify-center min-h-screen text-red-400">
        {error || "Lot not found"}
      </div>
    );
  }

  return (
    <>
      {/* Print button — hidden when printing */}
      <div className="print:hidden flex justify-end p-4 bg-zinc-950">
        <button
          onClick={() => window.print()}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium"
        >
          <Printer className="w-4 h-4" /> Print Lot Sheet
        </button>
      </div>

      {/* Printable content */}
      <div className="p-8 bg-white text-black font-sans text-sm print:p-6" id="lot-sheet">
        {/* Header */}
        <div className="border-b-2 border-black pb-4 mb-6">
          <h1 className="text-2xl font-bold tracking-tight">DELIVERY LOT SHEET</h1>
          <div className="flex gap-8 mt-3 text-sm">
            <div><span className="font-semibold">Lot Number:</span> {lot.lot_number}</div>
            <div><span className="font-semibold">Name:</span> {lot.name || "—"}</div>
            <div><span className="font-semibold">Status:</span> {lot.status}</div>
          </div>
        </div>

        {/* Details */}
        <div className="grid grid-cols-2 gap-4 mb-6 text-sm">
          <div className="space-y-1.5">
            <div><span className="font-semibold text-gray-600">Dispatch Date:</span>&nbsp;
              {lot.dispatch_date ? new Date(lot.dispatch_date).toLocaleDateString("en-IN") : "—"}
            </div>
            <div><span className="font-semibold text-gray-600">Destination:</span>&nbsp;{lot.destination || "—"}</div>
            <div><span className="font-semibold text-gray-600">Vehicle No:</span>&nbsp;{lot.vehicle_no || "—"}</div>
            <div><span className="font-semibold text-gray-600">Driver:</span>&nbsp;{lot.driver_name || "—"}</div>
          </div>
          <div className="space-y-1.5">
            <div><span className="font-semibold text-gray-600">Total Orders:</span>&nbsp;{orders.length}</div>
            <div><span className="font-semibold text-gray-600">Total Value:</span>&nbsp;<strong>{fmt(grandTotal)}</strong></div>
            {lot.notes && <div><span className="font-semibold text-gray-600">Notes:</span>&nbsp;{lot.notes}</div>}
          </div>
        </div>

        {/* Orders Table */}
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-gray-300 px-3 py-2 text-left font-semibold">#</th>
              <th className="border border-gray-300 px-3 py-2 text-left font-semibold">Invoice No.</th>
              <th className="border border-gray-300 px-3 py-2 text-left font-semibold">Party Name</th>
              <th className="border border-gray-300 px-3 py-2 text-right font-semibold">Amount</th>
              <th className="border border-gray-300 px-3 py-2 text-left font-semibold">Mfg. Status</th>
              <th className="border border-gray-300 px-3 py-2 text-center font-semibold">Received (✓)</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o, idx) => (
              <tr key={o.order_id} className="even:bg-gray-50">
                <td className="border border-gray-200 px-3 py-2 text-gray-500">{idx + 1}</td>
                <td className="border border-gray-200 px-3 py-2 font-mono text-xs">{o.invoice_number}</td>
                <td className="border border-gray-200 px-3 py-2">{o.party_name}</td>
                <td className="border border-gray-200 px-3 py-2 text-right font-medium">{fmt(o.grand_total)}</td>
                <td className="border border-gray-200 px-3 py-2">
                  <span className={`px-2 py-0.5 rounded text-xs ${
                    o.manufacturing_status === "Completed" ? "bg-green-100 text-green-800" :
                    o.manufacturing_status === "In Progress" ? "bg-yellow-100 text-yellow-800" :
                    "bg-gray-100 text-gray-600"
                  }`}>{o.manufacturing_status}</span>
                </td>
                <td className="border border-gray-200 px-3 py-2 text-center">□</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-gray-100 font-bold">
              <td colSpan={3} className="border border-gray-300 px-3 py-2 text-right">TOTAL</td>
              <td className="border border-gray-300 px-3 py-2 text-right">{fmt(grandTotal)}</td>
              <td colSpan={2} className="border border-gray-300 px-3 py-2"></td>
            </tr>
          </tfoot>
        </table>

        {/* Signatures */}
        <div className="grid grid-cols-3 gap-8 mt-12 pt-6 border-t border-gray-300">
          {["Prepared By", "Driver Signature", "Received By"].map(label => (
            <div key={label} className="text-center">
              <div className="border-b border-gray-400 mb-2 h-10"></div>
              <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
            </div>
          ))}
        </div>

        <div className="text-center text-xs text-gray-400 mt-6">
          Printed: {new Date().toLocaleString("en-IN")}
        </div>
      </div>

      <style>{`
        @media print {
          body { margin: 0; }
          #lot-sheet { padding: 15mm; }
          .print\\:hidden { display: none !important; }
        }
      `}</style>
    </>
  );
}
