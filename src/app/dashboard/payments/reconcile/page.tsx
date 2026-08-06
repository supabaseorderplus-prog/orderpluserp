'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import {
  ArrowRight, Check, IndianRupee, CreditCard, Clock,
  Search, Filter, AlertCircle, CheckCircle2, XCircle
} from 'lucide-react'

interface Payment {
  id: string
  payment_number: string
  amount: number
  payment_date: string
  payment_mode: string
  reference_number: string | null
  is_verified: boolean
  parties: { name: string; party_code: string } | null
  party_id: string
}

interface Invoice {
  id: string
  invoice_number: string
  grand_total: number
  amount_outstanding: number
  invoice_date: string
  aging_bucket: string
  aging_days: number
}

interface Adjustment {
  invoiceId: string
  invoiceNumber: string
  amount: number
  maxAmount: number
}

function formatINR(n: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}

function cdSlabLabel(days: number): { slab: string; color: string } {
  if (days <= 0) return { slab: 'ADVANCE', color: 'text-emerald-400' }
  if (days <= 7) return { slab: 'WITHIN 7 DAYS', color: 'text-emerald-400' }
  if (days <= 14) return { slab: 'WITHIN 14 DAYS', color: 'text-blue-400' }
  if (days <= 21) return { slab: 'WITHIN 21 DAYS', color: 'text-amber-400' }
  return { slab: 'NO CD', color: 'text-red-400' }
}

export default function PaymentReconciliationPage() {
  const [payments, setPayments] = useState<Payment[]>([])
  const [selectedPayment, setSelectedPayment] = useState<Payment | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [adjustments, setAdjustments] = useState<Adjustment[]>([])
  const [loading, setLoading] = useState(true)
  const [reconciling, setReconciling] = useState(false)
  const [search, setSearch] = useState('')
  const [result, setResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  useEffect(() => {
    fetchPayments()
  }, [])

  async function fetchPayments() {
    setLoading(true)
    try {
      const json = await api<{ success: boolean; data: Payment[] }>('/api/v1/payments?limit=50')
      if (json.success) {
        // Show only unreconciled or partially reconciled payments
        setPayments(json.data || [])
      }
    } catch {
      // ignore
    }
    setLoading(false)
  }

  const fetchInvoices = useCallback(async (partyId: string) => {
    try {
      const json = await api<{ success: boolean; data: Invoice[] }>(`/api/v1/invoices?party_id=${partyId}&status=UNPAID,PARTIAL&limit=50`)
      if (json.success) setInvoices(json.data || [])
    } catch {
      // ignore
    }
  }, [])

  function selectPayment(payment: Payment) {
    setSelectedPayment(payment)
    setAdjustments([])
    setResult(null)
    fetchInvoices(payment.party_id)
  }

  function addAdjustment(invoice: Invoice) {
    if (adjustments.find(a => a.invoiceId === invoice.id)) return

    const remainingPayment = (selectedPayment?.amount || 0) - adjustments.reduce((s, a) => s + a.amount, 0)
    const adjAmount = Math.min(remainingPayment, invoice.amount_outstanding)

    if (adjAmount <= 0) return

    setAdjustments(prev => [...prev, {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      amount: adjAmount,
      maxAmount: invoice.amount_outstanding,
    }])
  }

  function removeAdjustment(invoiceId: string) {
    setAdjustments(prev => prev.filter(a => a.invoiceId !== invoiceId))
  }

  function updateAdjustmentAmount(invoiceId: string, amount: number) {
    setAdjustments(prev => prev.map(a =>
      a.invoiceId === invoiceId ? { ...a, amount: Math.min(Math.max(0, amount), a.maxAmount) } : a
    ))
  }

  async function submitReconciliation() {
    if (!selectedPayment || adjustments.length === 0) return
    setReconciling(true)
    setResult(null)

    try {
      const json = await api<{ success: boolean; message?: string }>('/api/v1/payments/reconcile', {
        method: 'POST',
        body: {
          payment_id: selectedPayment.id,
          adjustments: adjustments.map(a => ({
            invoiceId: a.invoiceId,
            amount: a.amount,
          })),
        },
      })
      if (json.success) {
        setResult({ type: 'success', message: `Reconciled ${formatINR(adjustments.reduce((s, a) => s + a.amount, 0))} against ${adjustments.length} invoice(s)` })
        setAdjustments([])
        setSelectedPayment(null)
        fetchPayments()
      } else {
        setResult({ type: 'error', message: json.message || 'Reconciliation failed' })
      }
    } catch {
      setResult({ type: 'error', message: 'Network error' })
    }
    setReconciling(false)
  }

  const totalAdjusted = adjustments.reduce((s, a) => s + a.amount, 0)
  const remainingAmount = (selectedPayment?.amount || 0) - totalAdjusted

  const filteredPayments = payments.filter(p => {
    if (!search) return true
    const lower = search.toLowerCase()
    return p.payment_number?.toLowerCase().includes(lower) ||
      p.parties?.name?.toLowerCase().includes(lower) ||
      p.parties?.party_code?.toLowerCase().includes(lower)
  })

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 font-[family-name:var(--font-syne)]">
          Payment Reconciliation
        </h1>
        <p className="text-zinc-900/50 text-sm mt-1">Match payments to outstanding invoices and trigger CD auto-credit</p>
      </div>

      {result && (
        <div className={`mb-6 p-4 rounded-xl border ${result.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-red-500/10 border-red-500/30'} flex items-center gap-3`}>
          {result.type === 'success' ? <CheckCircle2 className="w-5 h-5 text-emerald-400" /> : <XCircle className="w-5 h-5 text-red-400" />}
          <span className={result.type === 'success' ? 'text-emerald-400' : 'text-red-400'}>{result.message}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Payments List */}
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-900/30" />
              <input
                type="text"
                placeholder="Search payments..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 rounded-lg bg-black/5 border border-black/10 text-zinc-900 text-sm focus:outline-none focus:border-amber-500/50"
              />
            </div>
            <button className="p-2.5 rounded-lg bg-black/5 border border-black/10 hover:border-black/20 transition-colors">
              <Filter className="w-4 h-4 text-zinc-900/50" />
            </button>
          </div>

          <div className="space-y-2 max-h-[calc(100vh-300px)] overflow-y-auto pr-2">
            {loading ? (
              [...Array(5)].map((_, i) => <div key={i} className="h-20 bg-black/5 rounded-xl animate-pulse" />)
            ) : filteredPayments.length === 0 ? (
              <div className="text-center py-12 text-zinc-900/30">No payments found</div>
            ) : (
              filteredPayments.map(payment => (
                <button
                  key={payment.id}
                  onClick={() => selectPayment(payment)}
                  className={`w-full text-left p-4 rounded-xl border transition-all ${
                    selectedPayment?.id === payment.id
                      ? 'border-amber-500/50 bg-amber-500/10'
                      : 'border-black/5 bg-black/[0.02] hover:border-black/10'
                  }`}
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="text-zinc-900 font-medium text-sm">{payment.payment_number}</p>
                      <p className="text-zinc-900/50 text-xs mt-0.5">{payment.parties?.name} ({payment.parties?.party_code})</p>
                    </div>
                    <div className="text-right">
                      <p className="text-zinc-900 font-bold">{formatINR(payment.amount)}</p>
                      <p className="text-zinc-900/40 text-xs">{payment.payment_date}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <span className="px-2 py-0.5 bg-black/5 text-zinc-900/50 text-xs rounded">{payment.payment_mode}</span>
                    {payment.reference_number && (
                      <span className="text-zinc-900/30 text-xs">Ref: {payment.reference_number}</span>
                    )}
                    {payment.is_verified && (
                      <span className="px-2 py-0.5 bg-emerald-500/10 text-emerald-400 text-xs rounded flex items-center gap-1">
                        <Check className="w-3 h-3" /> Verified
                      </span>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right: Invoice Assignment */}
        <div>
          {!selectedPayment ? (
            <div className="flex flex-col items-center justify-center h-96 text-zinc-900/20">
              <ArrowRight className="w-12 h-12 mb-4" />
              <p className="text-lg">Select a payment to reconcile</p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Payment summary */}
              <div className="p-4 rounded-xl bg-amber-500/5 border border-amber-500/20">
                <div className="flex justify-between items-center">
                  <div>
                    <p className="text-amber-400 text-sm font-medium">Reconciling Payment</p>
                    <p className="text-zinc-900 font-bold text-lg">{formatINR(selectedPayment.amount)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-zinc-900/50 text-xs">Assigned</p>
                    <p className="text-zinc-900 font-medium">{formatINR(totalAdjusted)}</p>
                    <p className={`text-xs font-medium ${remainingAmount > 0 ? 'text-amber-400' : remainingAmount === 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {remainingAmount > 0 ? `${formatINR(remainingAmount)} remaining` : remainingAmount === 0 ? 'Fully assigned' : 'Over-assigned!'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Adjustments */}
              {adjustments.length > 0 && (
                <div className="space-y-2">
                  <p className="text-zinc-900/50 text-sm font-medium">Assigned Invoices</p>
                  {adjustments.map(adj => {
                    const inv = invoices.find(i => i.id === adj.invoiceId)
                    const days = inv ? Math.ceil((new Date(selectedPayment.payment_date).getTime() - new Date(inv.invoice_date).getTime()) / 86400000) : 0
                    const cd = cdSlabLabel(days)
                    return (
                      <div key={adj.invoiceId} className="p-3 rounded-lg bg-black/[0.02] border border-black/5 flex items-center gap-3">
                        <div className="flex-1">
                          <p className="text-zinc-900 text-sm font-medium">{adj.invoiceNumber}</p>
                          <p className={`text-xs ${cd.color}`}>CD: {cd.slab} ({days} days)</p>
                        </div>
                        <input
                          type="number"
                          value={adj.amount}
                          onChange={e => updateAdjustmentAmount(adj.invoiceId, Number(e.target.value))}
                          className="w-32 px-3 py-1.5 rounded bg-black/5 border border-black/10 text-zinc-900 text-sm text-right focus:outline-none focus:border-amber-500/50"
                        />
                        <button onClick={() => removeAdjustment(adj.invoiceId)} className="p-1 hover:bg-red-500/10 rounded">
                          <XCircle className="w-4 h-4 text-red-400" />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Outstanding Invoices */}
              <div>
                <p className="text-zinc-900/50 text-sm font-medium mb-2">Outstanding Invoices</p>
                <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2">
                  {invoices.length === 0 ? (
                    <p className="text-zinc-900/20 text-center py-8">No outstanding invoices</p>
                  ) : (
                    invoices.filter(inv => !adjustments.find(a => a.invoiceId === inv.id)).map(inv => {
                      const days = Math.ceil((new Date(selectedPayment.payment_date).getTime() - new Date(inv.invoice_date).getTime()) / 86400000)
                      const cd = cdSlabLabel(days)
                      return (
                        <button
                          key={inv.id}
                          onClick={() => addAdjustment(inv)}
                          disabled={remainingAmount <= 0}
                          className="w-full text-left p-3 rounded-lg border border-black/5 bg-black/[0.02] hover:border-amber-500/30 hover:bg-amber-500/5 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <div className="flex justify-between items-start">
                            <div>
                              <p className="text-zinc-900 text-sm">{inv.invoice_number}</p>
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className="text-zinc-900/40 text-xs">{inv.invoice_date}</span>
                                <span className={`text-xs px-1.5 py-0.5 rounded ${
                                  inv.aging_bucket === 'CURRENT' ? 'bg-emerald-500/10 text-emerald-400' :
                                  inv.aging_bucket === 'BUCKET_1' ? 'bg-yellow-500/10 text-yellow-400' :
                                  'bg-red-500/10 text-red-400'
                                }`}>{inv.aging_days}d</span>
                                <span className={`text-xs ${cd.color}`}>{cd.slab}</span>
                              </div>
                            </div>
                            <div className="text-right">
                              <p className="text-zinc-900 font-medium text-sm">{formatINR(inv.amount_outstanding)}</p>
                              <p className="text-zinc-900/30 text-xs">of {formatINR(inv.grand_total)}</p>
                            </div>
                          </div>
                        </button>
                      )
                    })
                  )}
                </div>
              </div>

              {/* Submit */}
              {adjustments.length > 0 && (
                <button
                  onClick={submitReconciliation}
                  disabled={reconciling || remainingAmount < 0}
                  className="w-full py-3 rounded-xl bg-gradient-to-r from-amber-600 to-amber-500 text-black font-semibold hover:from-amber-500 hover:to-amber-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {reconciling ? (
                    <div className="w-5 h-5 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                  ) : (
                    <>
                      <CheckCircle2 className="w-5 h-5" />
                      Reconcile {formatINR(totalAdjusted)} against {adjustments.length} invoice(s)
                    </>
                  )}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
