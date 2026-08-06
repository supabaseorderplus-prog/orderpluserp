// Client-side cash-book / balance-sheet PDF.
//
// Mirrors the wallet-statement PDF: encrypted with a random owner password
// (never surfaced) so the file opens in one click but cannot be re-saved with
// edits — only printing is permitted. Layout: header band → period card →
// summary strip (Opening / Collection / Expense / Closing) → day-by-day cash
// book → collection-by-person → expense breakdown.
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { formatIstDate, formatIstTime, formatDayKey } from '@/lib/datetime'

export interface BsPdfDay {
  date: string
  opening: number
  collection: number
  expense: number
  closing: number
  cash: number
  bank: number
  coupon: number
}

export interface BsPdfCollector {
  name: string
  cash: number
  bank: number
  coupon: number
  total: number
  count: number
}

export interface BsPdfMeta {
  from: string
  to: string
  company_name?: string
  generated_at: string
  opening: number
  closing: number
  collectionTotal: number
  expenseTotal: number
  collectionCash: number
  collectionBank: number
  collectionCoupon: number
}

export interface BsPdfData {
  days: BsPdfDay[]
  byCollector: BsPdfCollector[]
  byCategory: { category: string; amount: number }[]
  byUser: { name: string; amount: number }[]
}

const money = (n: number) =>
  'Rs ' + new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0)

// Brand palette — kept in sync with the on-screen cash book (emerald collection /
// rose expense / violet closing).
const INK3: [number, number, number] = [24, 24, 27]
const EMERALD: [number, number, number] = [5, 150, 105]
const ROSE: [number, number, number] = [225, 29, 72]
const VIOLET: [number, number, number] = [124, 58, 237]
const CYAN: [number, number, number] = [8, 145, 178]
const MUTE: [number, number, number] = [113, 113, 122]
const LINE: [number, number, number] = [228, 228, 231]

function shortRef(): string {
  const t = Date.now().toString(36).toUpperCase()
  const r = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `BS-${t}-${r}`
}

export function generateBalanceSheetPdf(meta: BsPdfMeta, data: BsPdfData): jsPDF {
  const ownerPassword =
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36)

  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'pt',
    format: 'a4',
    encryption: { userPassword: '', ownerPassword, userPermissions: ['print'] },
  })

  const pageW = doc.internal.pageSize.getWidth()
  const marginX = 40
  const ref = shortRef()

  // ── Header band ────────────────────────────────────────────────────────────
  doc.setFillColor(...INK3)
  doc.rect(0, 0, pageW, 96, 'F')
  doc.setFillColor(...EMERALD)
  doc.rect(0, 96, pageW, 3, 'F')

  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.text(meta.company_name || 'Balance Sheet', marginX, 40)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(212, 212, 216)
  doc.text('CASH BOOK · COLLECTION & EXPENSE', marginX, 58)

  doc.setFontSize(8)
  doc.setTextColor(161, 161, 170)
  doc.text(`Ref: ${ref}`, pageW - marginX, 34, { align: 'right' })
  doc.text(
    `Generated: ${formatIstDate(meta.generated_at)} ${formatIstTime(meta.generated_at)}`,
    pageW - marginX,
    48,
    { align: 'right' },
  )
  doc.setTextColor(52, 211, 153)
  doc.setFont('helvetica', 'bold')
  doc.text('PROTECTED · READ-ONLY', pageW - marginX, 64, { align: 'right' })

  // ── Period card ──────────────────────────────────────────────────────────
  let y = 118
  doc.setDrawColor(...LINE)
  doc.setFillColor(250, 250, 250)
  doc.roundedRect(marginX, y, pageW - marginX * 2, 56, 6, 6, 'FD')

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(...INK3)
  doc.text('STATEMENT PERIOD', marginX + 16, y + 22)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(12)
  doc.setTextColor(...INK3)
  doc.text(`${formatDayKey(meta.from)}  to  ${formatDayKey(meta.to)}`, marginX + 16, y + 42)

  const dayCount = data.days.length
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...MUTE)
  doc.text(`${dayCount} ${dayCount === 1 ? 'day' : 'days'}`, pageW - marginX - 16, y + 42, { align: 'right' })

  // ── Summary strip ──────────────────────────────────────────────────────────
  y += 72
  const cards: Array<{ label: string; value: string; color: [number, number, number] }> = [
    { label: 'Opening Balance', value: money(meta.opening), color: CYAN },
    { label: 'Total Collection', value: money(meta.collectionTotal), color: EMERALD },
    { label: 'Total Expense', value: money(meta.expenseTotal), color: ROSE },
    { label: 'Closing Balance', value: money(meta.closing), color: VIOLET },
  ]
  const gap = 10
  const cardW = (pageW - marginX * 2 - gap * (cards.length - 1)) / cards.length
  cards.forEach((c, i) => {
    const x = marginX + i * (cardW + gap)
    doc.setDrawColor(...LINE)
    doc.setFillColor(255, 255, 255)
    doc.roundedRect(x, y, cardW, 50, 5, 5, 'FD')
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(...MUTE)
    doc.text(c.label.toUpperCase(), x + 10, y + 18)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10.5)
    doc.setTextColor(...c.color)
    doc.text(c.value, x + 10, y + 38)
  })

  // ── Day-by-day cash book ─────────────────────────────────────────────────
  y += 66
  autoTable(doc, {
    startY: y,
    head: [['Date', 'Opening', 'Collection', 'Expense', 'Closing']],
    body: data.days.map((d) => [
      formatDayKey(d.date),
      money(d.opening),
      money(d.collection),
      money(d.expense),
      money(d.closing),
    ]),
    margin: { left: marginX, right: marginX },
    theme: 'grid',
    headStyles: { fillColor: INK3, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
    bodyStyles: { fontSize: 8, textColor: [39, 39, 42], cellPadding: 5, lineColor: LINE, lineWidth: 0.5 },
    alternateRowStyles: { fillColor: [250, 250, 250] },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { halign: 'right', textColor: MUTE },
      2: { halign: 'right', textColor: EMERALD, fontStyle: 'bold' },
      3: { halign: 'right', textColor: ROSE, fontStyle: 'bold' },
      4: { halign: 'right', fontStyle: 'bold' },
    },
    foot: [[
      { content: 'Total', styles: { fontStyle: 'bold' } },
      { content: '', styles: {} },
      { content: money(meta.collectionTotal), styles: { halign: 'right', textColor: EMERALD, fontStyle: 'bold' } },
      { content: money(meta.expenseTotal), styles: { halign: 'right', textColor: ROSE, fontStyle: 'bold' } },
      { content: money(meta.closing), styles: { halign: 'right', fontStyle: 'bold' } },
    ]],
    footStyles: { fillColor: [244, 244, 245], textColor: INK3, fontSize: 8 },
  })

  // ── Collection by person ─────────────────────────────────────────────────
  let afterY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 24
  if (data.byCollector.length > 0) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.setTextColor(...INK3)
    doc.text('Collection by Person', marginX, afterY)
    afterY += 8
    autoTable(doc, {
      startY: afterY,
      head: [['Collector', 'Payments', 'Cash', 'Bank', 'Coupon', 'Total']],
      body: data.byCollector.map((c) => [
        c.name,
        String(c.count),
        money(c.cash),
        money(c.bank),
        money(c.coupon),
        money(c.total),
      ]),
      margin: { left: marginX, right: marginX },
      theme: 'grid',
      headStyles: { fillColor: INK3, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
      bodyStyles: { fontSize: 8, textColor: [39, 39, 42], cellPadding: 5, lineColor: LINE, lineWidth: 0.5 },
      alternateRowStyles: { fillColor: [250, 250, 250] },
      columnStyles: {
        0: { cellWidth: 'auto' },
        1: { halign: 'center', textColor: MUTE, cellWidth: 56 },
        2: { halign: 'right' },
        3: { halign: 'right' },
        4: { halign: 'right' },
        5: { halign: 'right', textColor: EMERALD, fontStyle: 'bold' },
      },
      foot: [[
        { content: 'Total', styles: { fontStyle: 'bold' } },
        { content: '', styles: {} },
        { content: money(meta.collectionCash), styles: { halign: 'right', fontStyle: 'bold' } },
        { content: money(meta.collectionBank), styles: { halign: 'right', fontStyle: 'bold' } },
        { content: money(meta.collectionCoupon), styles: { halign: 'right', fontStyle: 'bold' } },
        { content: money(meta.collectionTotal), styles: { halign: 'right', textColor: EMERALD, fontStyle: 'bold' } },
      ]],
      footStyles: { fillColor: [244, 244, 245], textColor: INK3, fontSize: 8 },
    })
    afterY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 24
  }

  // ── Expense breakdown (category) ─────────────────────────────────────────
  if (data.byCategory.length > 0) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.setTextColor(...INK3)
    doc.text('Expense by Category', marginX, afterY)
    afterY += 8
    autoTable(doc, {
      startY: afterY,
      head: [['Category', 'Amount']],
      body: data.byCategory.map((c) => [c.category, money(c.amount)]),
      margin: { left: marginX, right: marginX },
      theme: 'grid',
      headStyles: { fillColor: INK3, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
      bodyStyles: { fontSize: 8, textColor: [39, 39, 42], cellPadding: 5, lineColor: LINE, lineWidth: 0.5 },
      alternateRowStyles: { fillColor: [250, 250, 250] },
      columnStyles: { 0: { cellWidth: 'auto' }, 1: { halign: 'right', textColor: ROSE, fontStyle: 'bold' } },
      foot: [[
        { content: 'Total Expense', styles: { fontStyle: 'bold' } },
        { content: money(meta.expenseTotal), styles: { halign: 'right', textColor: ROSE, fontStyle: 'bold' } },
      ]],
      footStyles: { fillColor: [244, 244, 245], textColor: INK3, fontSize: 8 },
    })
  }

  // ── Footer on every page ─────────────────────────────────────────────────
  const pageCount = doc.getNumberOfPages()
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p)
    const h = doc.internal.pageSize.getHeight()
    doc.setDrawColor(...LINE)
    doc.line(marginX, h - 36, pageW - marginX, h - 36)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(...MUTE)
    doc.text('System-generated cash book. Closing balance reconciles to the live treasury.', marginX, h - 22)
    doc.text(`Page ${p} of ${pageCount}  ·  Ref ${ref}`, pageW - marginX, h - 22, { align: 'right' })
  }

  return doc
}

export function downloadBalanceSheetPdf(meta: BsPdfMeta, data: BsPdfData): void {
  const doc = generateBalanceSheetPdf(meta, data)
  const stamp = `${meta.from}_to_${meta.to}`
  doc.save(`Balance_Sheet_${stamp}.pdf`)
}
