// Generates a tamper-resistant wallet statement PDF entirely on the client.
//
// "Highly protected / cannot be edited": the document is emitted with PDF
// encryption enabled and a RANDOM owner password the recipient never learns,
// while the user password is left blank so the file still opens with a single
// click. Conforming readers (Acrobat, Preview, Chrome, all mobile viewers) honour
// the permission flags below and disable content editing, annotation, copying and
// form filling. Only "print" is granted. There is no UI anywhere that exposes the
// owner password, so the statement is effectively read-only once downloaded.
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { formatIstDate, formatIstTime } from '@/lib/datetime'

export interface StatementRow {
  id: string
  created_at: string
  date: string
  amount: number
  payment_mode: string
  type: string
  party_name: string
  party_code: string
  description: string
  reference: string
  credit: number
  debit: number
  balance: number
}

export interface StatementMeta {
  user_name: string
  role_name: string
  company_name: string
  from: string | null
  to: string | null
  opening_balance: number
  closing_balance: number
  total_credit: number
  total_debit: number
  count: number
  generated_at: string
}

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin',
  ACCOUNTS_MANAGER: 'Financier / Accountant',
  SALES_MANAGER: 'Sales Manager',
  TERRITORY_MANAGER: 'Territory Manager',
  SALESMAN: 'Salesman',
}

const money = (n: number) =>
  'Rs ' +
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0)

const roleLabel = (role: string) => ROLE_LABELS[role] || role.replace(/_/g, ' ')

// Brand palette — kept in sync with the on-screen drawer.
const INK3: [number, number, number] = [24, 24, 27]
const AMBER: [number, number, number] = [217, 119, 6]
const CREDIT: [number, number, number] = [5, 150, 105]
const DEBIT: [number, number, number] = [220, 38, 38]
const MUTE: [number, number, number] = [113, 113, 122]
const LINE: [number, number, number] = [228, 228, 231]

function shortRef(): string {
  // A human-quotable statement id printed on the document for audit reference.
  const t = Date.now().toString(36).toUpperCase()
  const r = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `WS-${t}-${r}`
}

export function generateWalletStatementPdf(rows: StatementRow[], meta: StatementMeta): jsPDF {
  // Random 32-char owner password → never surfaced, so the doc cannot be re-saved
  // with edits by anyone who only has the file.
  const ownerPassword =
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36)

  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'pt',
    format: 'a4',
    encryption: {
      userPassword: '',
      ownerPassword,
      userPermissions: ['print'], // everything else (modify/copy/annot) is denied
    },
  })

  const pageW = doc.internal.pageSize.getWidth()
  const marginX = 40
  const statementRef = shortRef()

  // ── Header band ────────────────────────────────────────────────────────────
  doc.setFillColor(...INK3)
  doc.rect(0, 0, pageW, 96, 'F')
  doc.setFillColor(...AMBER)
  doc.rect(0, 96, pageW, 3, 'F')

  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.text(meta.company_name || 'Wallet Statement', marginX, 40)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(212, 212, 216)
  doc.text('WALLET / TREASURY STATEMENT', marginX, 58)

  doc.setFontSize(8)
  doc.setTextColor(161, 161, 170)
  doc.text(`Statement Ref: ${statementRef}`, pageW - marginX, 34, { align: 'right' })
  doc.text(
    `Generated: ${formatIstDate(meta.generated_at)} ${formatIstTime(meta.generated_at)}`,
    pageW - marginX,
    48,
    { align: 'right' },
  )
  doc.setTextColor(245, 158, 11)
  doc.setFont('helvetica', 'bold')
  doc.text('PROTECTED · READ-ONLY', pageW - marginX, 64, { align: 'right' })

  // ── Account-holder card ──────────────────────────────────────────────────
  let y = 118
  doc.setDrawColor(...LINE)
  doc.setFillColor(250, 250, 250)
  doc.roundedRect(marginX, y, pageW - marginX * 2, 64, 6, 6, 'FD')

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.setTextColor(...INK3)
  doc.text(meta.user_name, marginX + 16, y + 26)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...MUTE)
  doc.text(`Position: ${roleLabel(meta.role_name)}`, marginX + 16, y + 44)

  const periodText =
    meta.from || meta.to
      ? `${meta.from ? formatIstDate(meta.from) : 'Start'}  to  ${meta.to ? formatIstDate(meta.to) : 'Today'}`
      : 'All transactions'
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(...INK3)
  doc.text('Statement Period', pageW - marginX - 16, y + 24, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(...MUTE)
  doc.text(periodText, pageW - marginX - 16, y + 40, { align: 'right' })

  // ── Summary strip ──────────────────────────────────────────────────────────
  y += 80
  const cards: Array<{ label: string; value: string; color: [number, number, number] }> = [
    { label: 'Opening Balance', value: money(meta.opening_balance), color: INK3 },
    { label: 'Total Credit', value: money(meta.total_credit), color: CREDIT },
    { label: 'Total Debit', value: money(meta.total_debit), color: DEBIT },
    { label: 'Closing Balance', value: money(meta.closing_balance), color: AMBER },
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
    doc.setFontSize(11)
    doc.setTextColor(...c.color)
    doc.text(c.value, x + 10, y + 38)
  })

  // ── Ledger table ───────────────────────────────────────────────────────────
  y += 66
  const body = rows.map((r) => [
    `${formatIstDate(r.date)}\n${formatIstTime(r.created_at)}`,
    `${r.description || '—'}${r.party_name ? `\n${r.party_name}${r.party_code ? ` (${r.party_code})` : ''}` : ''}`,
    (r.payment_mode || '—').toUpperCase(),
    r.credit > 0 ? money(r.credit) : '',
    r.debit > 0 ? money(r.debit) : '',
    money(r.balance),
  ])

  autoTable(doc, {
    startY: y,
    head: [['Date', 'Particulars', 'Mode', 'Credit', 'Debit', 'Balance']],
    body,
    margin: { left: marginX, right: marginX },
    theme: 'grid',
    headStyles: {
      fillColor: INK3,
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 8,
      halign: 'left',
    },
    bodyStyles: { fontSize: 8, textColor: [39, 39, 42], cellPadding: 5, lineColor: LINE, lineWidth: 0.5 },
    alternateRowStyles: { fillColor: [250, 250, 250] },
    columnStyles: {
      0: { cellWidth: 66 },
      2: { cellWidth: 50, halign: 'center' },
      3: { cellWidth: 72, halign: 'right', textColor: CREDIT, fontStyle: 'bold' },
      4: { cellWidth: 72, halign: 'right', textColor: DEBIT, fontStyle: 'bold' },
      5: { cellWidth: 78, halign: 'right', fontStyle: 'bold' },
    },
    didParseCell: (data) => {
      if (data.section === 'body' && data.column.index === 5) {
        data.cell.styles.textColor = INK3
      }
    },
    foot: [[
      { content: 'Closing Balance', colSpan: 3, styles: { halign: 'right', fontStyle: 'bold' } },
      { content: money(meta.total_credit), styles: { halign: 'right', textColor: CREDIT, fontStyle: 'bold' } },
      { content: money(meta.total_debit), styles: { halign: 'right', textColor: DEBIT, fontStyle: 'bold' } },
      { content: money(meta.closing_balance), styles: { halign: 'right', fontStyle: 'bold' } },
    ]],
    footStyles: { fillColor: [244, 244, 245], textColor: INK3, fontSize: 8 },
  })

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
    doc.text(
      'This is a system-generated, encrypted statement. Any alteration voids its authenticity.',
      marginX,
      h - 22,
    )
    doc.text(`Page ${p} of ${pageCount}  ·  Ref ${statementRef}`, pageW - marginX, h - 22, { align: 'right' })
  }

  return doc
}

export function downloadWalletStatementPdf(rows: StatementRow[], meta: StatementMeta): void {
  const doc = generateWalletStatementPdf(rows, meta)
  const safeName = (meta.user_name || 'wallet').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')
  const stamp = new Date().toISOString().slice(0, 10)
  doc.save(`Wallet_Statement_${safeName}_${stamp}.pdf`)
}
