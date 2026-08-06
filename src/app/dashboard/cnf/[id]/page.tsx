'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import {
  TrendingUp, TrendingDown, IndianRupee, Shield, Award, Clock,
  ArrowLeft, Download, BarChart3, PieChart, Target, Calendar,
  ChevronRight, Users, FileText, CreditCard, Building2
} from 'lucide-react'

interface KPI {
  billing: number
  outstanding: number
  tdEarned: number
  tdBalance: number
  cdEarned: number
  securityBalance: number
  rank: number | null
  rankChange: number
  totalParties: number
}

interface DashboardData {
  party: Record<string, unknown>
  kpi: KPI
  agingBreakdown: Record<string, number>
  monthlyTrend: { month: string; value: number }[]
  schemes: Record<string, unknown>[]
}

function formatINR(n: number): string {
  if (n >= 10000000) return `${(n / 10000000).toFixed(2)} Cr`
  if (n >= 100000) return `${(n / 100000).toFixed(2)} L`
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}

export default function CNFDashboardPage() {
  const params = useParams()
  const partyId = params.id as string
  const [data, setData] = useState<DashboardData | null>(null)
  const [period, setPeriod] = useState<'MTD' | 'YTD'>('MTD')
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/v1/parties/${partyId}/dashboard?period=${period}`)
      const json = await res.json()
      if (json.success) setData(json.data)
    } catch {
      // ignore
    }
    setLoading(false)
  }, [partyId, period])

  useEffect(() => { fetchData() }, [fetchData])

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-6">
          <div className="h-8 bg-black/5 rounded w-64" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(8)].map((_, i) => <div key={i} className="h-32 bg-black/5 rounded-xl" />)}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="h-80 bg-black/5 rounded-xl" />
            <div className="h-80 bg-black/5 rounded-xl" />
          </div>
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="p-8 text-center">
        <p className="text-zinc-900/50 text-lg">Party not found or failed to load data.</p>
        <Link href="/dashboard/parties" className="text-amber-400 hover:text-amber-300 mt-4 inline-block">
          Back to Parties
        </Link>
      </div>
    )
  }

  const { party, kpi, agingBreakdown, monthlyTrend, schemes } = data
  const partyName = (party as Record<string, unknown>).name as string
  const partyCode = (party as Record<string, unknown>).party_code as string
  const partyType = ((party as Record<string, unknown>).party_types as Record<string, unknown>)?.name as string

  const agingTotal = Object.values(agingBreakdown).reduce((s, v) => s + v, 0)
  const maxMonthly = Math.max(...monthlyTrend.map(m => m.value), 1)

  const kpiCards = [
    { label: `Territory Billing (${period})`, value: kpi.billing, icon: BarChart3, color: 'from-emerald-500/20 to-emerald-500/5', iconColor: 'text-emerald-400' },
    { label: 'Outstanding', value: kpi.outstanding, icon: Clock, color: 'from-red-500/20 to-red-500/5', iconColor: 'text-red-400' },
    { label: `TD Earned (${period})`, value: kpi.tdEarned, icon: TrendingUp, color: 'from-amber-500/20 to-amber-500/5', iconColor: 'text-amber-400' },
    { label: 'TD Balance', value: kpi.tdBalance, icon: IndianRupee, color: 'from-amber-500/20 to-amber-500/5', iconColor: 'text-amber-400' },
    { label: `CD Earned (${period})`, value: kpi.cdEarned, icon: CreditCard, color: 'from-blue-500/20 to-blue-500/5', iconColor: 'text-blue-400' },
    { label: 'Security Balance', value: kpi.securityBalance, icon: Shield, color: 'from-purple-500/20 to-purple-500/5', iconColor: 'text-purple-400' },
  ]

  return (
    <div className="p-6 lg:p-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link href="/dashboard/parties" className="p-2 rounded-lg bg-black/5 hover:bg-black/10 transition-colors">
            <ArrowLeft className="w-5 h-5 text-zinc-900/70" />
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-zinc-900 font-[family-name:var(--font-syne)]">
                {partyName}
              </h1>
              <span className="px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-400 border border-amber-500/30">
                {partyType}
              </span>
            </div>
            <p className="text-zinc-900/50 text-sm mt-1">{partyCode}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex bg-black/5 rounded-lg p-1">
            {(['MTD', 'YTD'] as const).map(p => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
                  period === p ? 'bg-amber-500/20 text-amber-400' : 'text-zinc-900/50 hover:text-zinc-900/70'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          <button className="p-2 rounded-lg bg-black/5 hover:bg-black/10 transition-colors">
            <Download className="w-5 h-5 text-zinc-900/70" />
          </button>
        </div>
      </div>

      {/* Rank Badge */}
      {kpi.rank && (
        <div className="flex items-center gap-4 p-4 rounded-xl bg-gradient-to-r from-amber-500/10 to-transparent border border-amber-500/20">
          <div className="w-12 h-12 rounded-full bg-amber-500/20 flex items-center justify-center">
            <Award className="w-6 h-6 text-amber-400" />
          </div>
          <div>
            <p className="text-zinc-900 font-semibold">
              Rank #{kpi.rank} of {kpi.totalParties} {partyType}s
            </p>
            <div className="flex items-center gap-1 text-sm">
              {kpi.rankChange > 0 ? (
                <><TrendingUp className="w-4 h-4 text-emerald-400" /> <span className="text-emerald-400">Up {kpi.rankChange}</span></>
              ) : kpi.rankChange < 0 ? (
                <><TrendingDown className="w-4 h-4 text-red-400" /> <span className="text-red-400">Down {Math.abs(kpi.rankChange)}</span></>
              ) : (
                <span className="text-zinc-900/50">No change</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {kpiCards.map((card, i) => (
          <div key={i} className={`p-4 rounded-xl bg-gradient-to-br ${card.color} border border-black/5`}>
            <div className="flex items-center gap-2 mb-3">
              <card.icon className={`w-4 h-4 ${card.iconColor}`} />
              <span className="text-zinc-900/50 text-xs">{card.label}</span>
            </div>
            <p className="text-zinc-900 text-lg font-bold font-[family-name:var(--font-syne)]">
              {formatINR(card.value)}
            </p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Monthly Billing Trend */}
        <div className="p-6 rounded-xl bg-black/[0.02] border border-black/5">
          <h3 className="text-zinc-900 font-semibold mb-4 flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-amber-400" />
            Monthly Billing Trend
          </h3>
          <div className="space-y-2">
            {monthlyTrend.map((m, i) => {
              const pct = (m.value / maxMonthly) * 100
              const monthLabel = new Date(m.month + '-01').toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
              return (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-zinc-900/40 text-xs w-16 text-right">{monthLabel}</span>
                  <div className="flex-1 h-6 bg-black/5 rounded overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-amber-500/60 to-amber-500/30 rounded transition-all duration-500"
                      style={{ width: `${Math.max(pct, 1)}%` }}
                    />
                  </div>
                  <span className="text-zinc-900/60 text-xs w-20 text-right">{formatINR(m.value)}</span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Aging Breakdown */}
        <div className="p-6 rounded-xl bg-black/[0.02] border border-black/5">
          <h3 className="text-zinc-900 font-semibold mb-4 flex items-center gap-2">
            <PieChart className="w-5 h-5 text-red-400" />
            Outstanding Aging Breakdown
          </h3>
          {agingTotal === 0 ? (
            <div className="flex items-center justify-center h-48 text-zinc-900/30">
              No outstanding invoices
            </div>
          ) : (
            <div className="space-y-4">
              {[
                { key: 'CURRENT', label: '0-30 Days', color: 'bg-emerald-500' },
                { key: 'BUCKET_1', label: '31-60 Days', color: 'bg-yellow-500' },
                { key: 'BUCKET_2', label: '61-90 Days', color: 'bg-orange-500' },
                { key: 'BUCKET_3', label: '91-120 Days', color: 'bg-red-500' },
                { key: 'BUCKET_4', label: '120+ Days', color: 'bg-red-700' },
              ].map(bucket => {
                const val = agingBreakdown[bucket.key] || 0
                const pct = agingTotal > 0 ? (val / agingTotal) * 100 : 0
                return (
                  <div key={bucket.key}>
                    <div className="flex justify-between mb-1">
                      <span className="text-zinc-900/60 text-sm">{bucket.label}</span>
                      <span className="text-zinc-900 text-sm font-medium">{formatINR(val)}</span>
                    </div>
                    <div className="h-3 bg-black/5 rounded-full overflow-hidden">
                      <div className={`h-full ${bucket.color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })}
              <div className="pt-4 border-t border-black/5 flex justify-between">
                <span className="text-zinc-900/50 text-sm">Total Outstanding</span>
                <span className="text-zinc-900 font-bold">{formatINR(agingTotal)}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Scheme Tracker */}
      <div className="p-6 rounded-xl bg-black/[0.02] border border-black/5">
        <h3 className="text-zinc-900 font-semibold mb-4 flex items-center gap-2">
          <Target className="w-5 h-5 text-emerald-400" />
          Active Schemes
        </h3>
        {schemes.length === 0 ? (
          <p className="text-zinc-900/30 text-center py-8">No active schemes</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {schemes.map((sp, i) => {
              const scheme = (sp as Record<string, unknown>).schemes as Record<string, unknown> | null
              const progress = Number((sp as Record<string, unknown>).progress_percent || 0)
              const currentVal = Number((sp as Record<string, unknown>).current_value || 0)
              const targetVal = Number((sp as Record<string, unknown>).target_value || 0)
              const endDate = scheme?.end_date as string
              const daysLeft = endDate ? Math.max(0, Math.ceil((new Date(endDate).getTime() - Date.now()) / 86400000)) : 0
              const isAchieved = (sp as Record<string, unknown>).is_achieved as boolean

              return (
                <div key={i} className={`p-4 rounded-lg border ${isAchieved ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-black/5 bg-black/[0.02]'}`}>
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <p className="text-zinc-900 font-medium">{scheme?.name as string}</p>
                      <p className="text-zinc-900/40 text-xs">{scheme?.scheme_code as string}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {isAchieved ? (
                        <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 text-xs rounded-full font-medium">Achieved</span>
                      ) : (
                        <span className="px-2 py-0.5 bg-black/10 text-zinc-900/50 text-xs rounded-full flex items-center gap-1">
                          <Calendar className="w-3 h-3" /> {daysLeft}d left
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="mb-2">
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-zinc-900/50">{formatINR(currentVal)} / {formatINR(targetVal)}</span>
                      <span className="text-zinc-900/70 font-medium">{progress.toFixed(1)}%</span>
                    </div>
                    <div className="h-2 bg-black/5 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${isAchieved ? 'bg-emerald-500' : 'bg-amber-500'}`}
                        style={{ width: `${Math.min(progress, 100)}%` }}
                      />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Quick Links */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'View Invoices', icon: FileText, href: `/dashboard/invoices/new?party=${partyId}` },
          { label: 'TD/CD Ledger', icon: IndianRupee, href: `/dashboard/ledgers?party=${partyId}` },
          { label: 'Security Ledger', icon: Shield, href: `/dashboard/ledgers?party=${partyId}&tab=security` },
          { label: 'Party Hierarchy', icon: Building2, href: `/dashboard/parties?highlight=${partyId}` },
        ].map((link, i) => (
          <Link
            key={i}
            href={link.href}
            className="flex items-center gap-3 p-4 rounded-xl bg-black/[0.02] border border-black/5 hover:border-amber-500/30 hover:bg-amber-500/5 transition-all group"
          >
            <link.icon className="w-5 h-5 text-zinc-900/40 group-hover:text-amber-400 transition-colors" />
            <span className="text-zinc-900/60 group-hover:text-zinc-900 text-sm transition-colors">{link.label}</span>
            <ChevronRight className="w-4 h-4 text-zinc-900/20 ml-auto group-hover:text-amber-400 transition-colors" />
          </Link>
        ))}
      </div>
    </div>
  )
}
