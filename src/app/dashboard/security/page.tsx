'use client'

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'
import {
  Shield, Plus, Download, ArrowUpRight, ArrowDownRight, Clock,
  IndianRupee, Percent, Calendar, Building2, ChevronDown
} from 'lucide-react'

interface SecurityEntry {
  id: string
  entry_type: string
  amount: number
  narration: string
  reference_no: string
  payment_mode: string
  balance: number
  interest_rate: number | null
  fiscal_year: string
  transaction_date: string
  created_at: string
}

interface PartySummary {
  id: string
  name: string
  party_code: string
}

function formatINR(n: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}

const entryTypeConfig: Record<string, { label: string; icon: typeof ArrowUpRight; color: string; bgColor: string }> = {
  DEPOSIT: { label: 'Deposit', icon: ArrowUpRight, color: 'text-emerald-400', bgColor: 'bg-emerald-500/10' },
  BONUS_DEPOSIT: { label: 'Bonus Deposit', icon: ArrowUpRight, color: 'text-blue-400', bgColor: 'bg-blue-500/10' },
  INTEREST_CREDIT: { label: 'Interest', icon: Percent, color: 'text-amber-400', bgColor: 'bg-amber-500/10' },
  ADJUSTMENT: { label: 'Adjustment', icon: Clock, color: 'text-yellow-400', bgColor: 'bg-yellow-500/10' },
  REFUND: { label: 'Refund', icon: ArrowDownRight, color: 'text-red-400', bgColor: 'bg-red-500/10' },
  TRANSFER: { label: 'Transfer', icon: ArrowDownRight, color: 'text-purple-400', bgColor: 'bg-purple-500/10' },
}

export default function SecurityLedgerPage() {
  const searchParams = useSearchParams()
  const initialPartyId = searchParams.get('party') || ''

  const [partyId, setPartyId] = useState(initialPartyId)
  const [parties, setParties] = useState<PartySummary[]>([])
  const [entries, setEntries] = useState<SecurityEntry[]>([])
  const [summary, setSummary] = useState({ totalDeposits: 0, totalWithdrawals: 0, currentBalance: 0 })
  const [loading, setLoading] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [formData, setFormData] = useState({ entry_type: 'DEPOSIT', amount: '', narration: '', reference_no: '', payment_mode: 'NEFT' })
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    fetchParties()
  }, [])

  useEffect(() => {
    if (partyId) fetchLedger()
  }, [partyId])

  async function fetchParties() {
    try {
      const json = await api<{ success: boolean; data: Record<string, unknown>[] }>('/api/v1/parties?limit=100')
      if (json.success) {
        setParties((json.data || []).map((p: Record<string, unknown>) => ({
          id: String(p.id), name: String(p.name), party_code: String(p.party_code),
        })))
      }
    } catch { /* ignore */ }
  }

  async function fetchLedger() {
    setLoading(true)
    try {
      const json = await api<{ success: boolean; data: { entries: SecurityEntry[]; summary: { totalDeposits: number; totalWithdrawals: number; currentBalance: number } } }>(`/api/v1/security/${partyId}`)
      if (json.success) {
        setEntries(json.data.entries || [])
        setSummary(json.data.summary)
      }
    } catch { /* ignore */ }
    setLoading(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!partyId || !formData.amount) return
    setSubmitting(true)
    try {
      const json = await api<{ success: boolean }>(`/api/v1/security/${partyId}`, {
        method: 'POST',
        body: {
          ...formData,
          amount: Number(formData.amount),
        },
      })
      if (json.success) {
        setShowForm(false)
        setFormData({ entry_type: 'DEPOSIT', amount: '', narration: '', reference_no: '', payment_mode: 'NEFT' })
        fetchLedger()
      }
    } catch { /* ignore */ }
    setSubmitting(false)
  }

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 font-[family-name:var(--font-syne)]">
            Security Deposit Ledger
          </h1>
          <p className="text-zinc-900/50 text-sm mt-1">Track security deposits, interest credits, and adjustments</p>
        </div>
        <div className="flex items-center gap-3">
          {partyId && (
            <>
              <button
                onClick={() => setShowForm(!showForm)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/30 hover:bg-amber-500/20 transition-colors text-sm"
              >
                <Plus className="w-4 h-4" /> Add Entry
              </button>
              <a
                href={`/api/v1/export/td-cd-report?partyId=${partyId}`}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-black/5 text-zinc-900/60 border border-black/10 hover:border-black/20 transition-colors text-sm"
              >
                <Download className="w-4 h-4" /> Export
              </a>
            </>
          )}
        </div>
      </div>

      {/* Party Selector */}
      <div className="relative max-w-md">
        <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-900/30" />
        <select
          value={partyId}
          onChange={e => setPartyId(e.target.value)}
          className="w-full pl-10 pr-10 py-2.5 rounded-lg bg-black/5 border border-black/10 text-zinc-900 text-sm focus:outline-none focus:border-amber-500/50 appearance-none"
        >
          <option value="" className="bg-neutral-900">Select Party...</option>
          {parties.map(p => (
            <option key={p.id} value={p.id} className="bg-neutral-900">{p.name} ({p.party_code})</option>
          ))}
        </select>
        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-900/30 pointer-events-none" />
      </div>

      {partyId && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="p-5 rounded-xl bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 border border-emerald-500/20">
              <div className="flex items-center gap-2 mb-2">
                <ArrowUpRight className="w-4 h-4 text-emerald-400" />
                <span className="text-emerald-400/70 text-sm">Total Deposits</span>
              </div>
              <p className="text-zinc-900 text-2xl font-bold font-[family-name:var(--font-syne)]">{formatINR(summary.totalDeposits)}</p>
            </div>
            <div className="p-5 rounded-xl bg-gradient-to-br from-red-500/10 to-red-500/5 border border-red-500/20">
              <div className="flex items-center gap-2 mb-2">
                <ArrowDownRight className="w-4 h-4 text-red-400" />
                <span className="text-red-400/70 text-sm">Total Withdrawals</span>
              </div>
              <p className="text-zinc-900 text-2xl font-bold font-[family-name:var(--font-syne)]">{formatINR(summary.totalWithdrawals)}</p>
            </div>
            <div className="p-5 rounded-xl bg-gradient-to-br from-amber-500/10 to-amber-500/5 border border-amber-500/20">
              <div className="flex items-center gap-2 mb-2">
                <Shield className="w-4 h-4 text-amber-400" />
                <span className="text-amber-400/70 text-sm">Current Balance</span>
              </div>
              <p className="text-zinc-900 text-2xl font-bold font-[family-name:var(--font-syne)]">{formatINR(summary.currentBalance)}</p>
            </div>
          </div>

          {/* Add Entry Form */}
          {showForm && (
            <form onSubmit={handleSubmit} className="p-6 rounded-xl bg-black/[0.02] border border-amber-500/20 space-y-4">
              <h3 className="text-zinc-900 font-semibold">New Security Entry</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div>
                  <label className="text-zinc-900/50 text-xs block mb-1">Entry Type</label>
                  <select
                    value={formData.entry_type}
                    onChange={e => setFormData(prev => ({ ...prev, entry_type: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg bg-black/5 border border-black/10 text-zinc-900 text-sm focus:outline-none focus:border-amber-500/50"
                  >
                    {Object.entries(entryTypeConfig).map(([k, v]) => (
                      <option key={k} value={k} className="bg-neutral-900">{v.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-zinc-900/50 text-xs block mb-1">Amount</label>
                  <input
                    type="number"
                    value={formData.amount}
                    onChange={e => setFormData(prev => ({ ...prev, amount: e.target.value }))}
                    placeholder="0"
                    className="w-full px-3 py-2 rounded-lg bg-black/5 border border-black/10 text-zinc-900 text-sm focus:outline-none focus:border-amber-500/50"
                    required
                  />
                </div>
                <div>
                  <label className="text-zinc-900/50 text-xs block mb-1">Payment Mode</label>
                  <select
                    value={formData.payment_mode}
                    onChange={e => setFormData(prev => ({ ...prev, payment_mode: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg bg-black/5 border border-black/10 text-zinc-900 text-sm focus:outline-none focus:border-amber-500/50"
                  >
                    {['NEFT', 'RTGS', 'UPI', 'CHEQUE', 'CASH', 'DD'].map(m => (
                      <option key={m} value={m} className="bg-neutral-900">{m}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-zinc-900/50 text-xs block mb-1">Reference No.</label>
                  <input
                    type="text"
                    value={formData.reference_no}
                    onChange={e => setFormData(prev => ({ ...prev, reference_no: e.target.value }))}
                    placeholder="UTR / Cheque No"
                    className="w-full px-3 py-2 rounded-lg bg-black/5 border border-black/10 text-zinc-900 text-sm focus:outline-none focus:border-amber-500/50"
                  />
                </div>
              </div>
              <div>
                <label className="text-zinc-900/50 text-xs block mb-1">Narration</label>
                <input
                  type="text"
                  value={formData.narration}
                  onChange={e => setFormData(prev => ({ ...prev, narration: e.target.value }))}
                  placeholder="Description..."
                  className="w-full px-3 py-2 rounded-lg bg-black/5 border border-black/10 text-zinc-900 text-sm focus:outline-none focus:border-amber-500/50"
                />
              </div>
              <div className="flex gap-3">
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-6 py-2 rounded-lg bg-amber-500 text-black font-semibold text-sm hover:bg-amber-400 transition-colors disabled:opacity-50"
                >
                  {submitting ? 'Saving...' : 'Save Entry'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="px-6 py-2 rounded-lg bg-black/5 text-zinc-900/60 text-sm hover:bg-black/10 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {/* Ledger Timeline */}
          <div className="p-6 rounded-xl bg-black/[0.02] border border-black/5">
            <h3 className="text-zinc-900 font-semibold mb-4">Ledger Timeline</h3>
            {loading ? (
              <div className="space-y-3">
                {[...Array(5)].map((_, i) => <div key={i} className="h-16 bg-black/5 rounded-lg animate-pulse" />)}
              </div>
            ) : entries.length === 0 ? (
              <p className="text-zinc-900/30 text-center py-12">No entries found</p>
            ) : (
              <div className="space-y-1">
                {/* Header */}
                <div className="grid grid-cols-12 gap-3 px-4 py-2 text-zinc-900/40 text-xs font-medium">
                  <span className="col-span-2">Date</span>
                  <span className="col-span-2">Type</span>
                  <span className="col-span-3">Narration</span>
                  <span className="col-span-1 text-right">Credit</span>
                  <span className="col-span-1 text-right">Debit</span>
                  <span className="col-span-2 text-right">Balance</span>
                  <span className="col-span-1 text-right">Mode</span>
                </div>
                {entries.map((entry, i) => {
                  const config = entryTypeConfig[entry.entry_type] || entryTypeConfig.ADJUSTMENT
                  const isCredit = ['DEPOSIT', 'BONUS_DEPOSIT', 'INTEREST_CREDIT'].includes(entry.entry_type)
                  return (
                    <div key={entry.id} className="grid grid-cols-12 gap-3 px-4 py-3 rounded-lg hover:bg-black/[0.02] transition-colors text-sm items-center">
                      <span className="col-span-2 text-zinc-900/50 text-xs">
                        {new Date(entry.transaction_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })}
                      </span>
                      <span className="col-span-2">
                        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs ${config.bgColor} ${config.color}`}>
                          <config.icon className="w-3 h-3" />
                          {config.label}
                        </span>
                      </span>
                      <span className="col-span-3 text-zinc-900/60 text-xs truncate" title={entry.narration}>
                        {entry.narration || '-'}
                      </span>
                      <span className="col-span-1 text-right text-emerald-400 text-xs font-medium">
                        {isCredit ? formatINR(entry.amount) : '-'}
                      </span>
                      <span className="col-span-1 text-right text-red-400 text-xs font-medium">
                        {!isCredit ? formatINR(entry.amount) : '-'}
                      </span>
                      <span className="col-span-2 text-right text-zinc-900 font-medium text-xs">
                        {formatINR(entry.balance)}
                      </span>
                      <span className="col-span-1 text-right text-zinc-900/30 text-xs">
                        {entry.payment_mode || '-'}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
