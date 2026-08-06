// Client-side Order Confirmation PDF. Shared to the party over WhatsApp (as a
// real attachment via the Web Share API on mobile) and downloadable from the
// public approval page. Lists every product with quantity, unit price and line
// amount, the grand total, and the dual-approval state.
//
// Mirrors the visual language of the wallet statement PDF (brand ink + amber).
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'

export interface OrderPdfItem {
  name: string
  sku: string
  quantity: number
  unit_price: number
  line_total: number
  unit?: string
}

export interface OrderPdfData {
  order_number: string
  order_date: string
  company_name: string
  party_name: string
  party_phone?: string
  items: OrderPdfItem[]
  grand_total: number
  staff_approved?: boolean
  party_confirmed?: boolean
  party_confirmed_name?: string | null
  party_confirmed_at?: string | null
  approval_url?: string | null
}

const INK: [number, number, number] = [24, 24, 27]
const AMBER: [number, number, number] = [217, 119, 6]
const EMERALD: [number, number, number] = [5, 150, 105]
const MUTE: [number, number, number] = [113, 113, 122]
const LINE: [number, number, number] = [228, 228, 231]

const money = (n: number) =>
  'Rs ' + new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0)

const fmtDate = (value: string) => {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value || '—'
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function orderPdfFilename(data: OrderPdfData): string {
  const safe = (data.order_number || 'order').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')
  return `Order_${safe}.pdf`
}

export function generateOrderPdf(data: OrderPdfData): jsPDF {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' })
  const pageW = doc.internal.pageSize.getWidth()
  const marginX = 40

  // ── Header band ────────────────────────────────────────────────────────────
  doc.setFillColor(...INK)
  doc.rect(0, 0, pageW, 96, 'F')
  doc.setFillColor(...AMBER)
  doc.rect(0, 96, pageW, 3, 'F')

  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.text(data.company_name || 'Order Confirmation', marginX, 40)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(212, 212, 216)
  doc.text('ORDER CONFIRMATION', marginX, 58)

  doc.setFontSize(9)
  doc.setTextColor(161, 161, 170)
  doc.text(`Order No: ${data.order_number || '—'}`, pageW - marginX, 34, { align: 'right' })
  doc.text(`Date: ${fmtDate(data.order_date)}`, pageW - marginX, 50, { align: 'right' })

  // ── Party card ─────────────────────────────────────────────────────────────
  let y = 118
  doc.setDrawColor(...LINE)
  doc.setFillColor(250, 250, 250)
  doc.roundedRect(marginX, y, pageW - marginX * 2, 62, 6, 6, 'FD')

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(...MUTE)
  doc.text('BILL TO', marginX + 16, y + 20)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.setTextColor(...INK)
  doc.text(data.party_name || '—', marginX + 16, y + 38)
  if (data.party_phone) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(...MUTE)
    doc.text(`Phone: ${data.party_phone}`, marginX + 16, y + 52)
  }

  // ── Approval status chips (top-right of card) ────────────────────────────────
  const chip = (label: string, on: boolean, cx: number, cy: number) => {
    const color = on ? EMERALD : MUTE
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8)
    doc.setTextColor(...color)
    doc.text((on ? '[x] ' : '[ ] ') + label, cx, cy, { align: 'right' })
  }
  chip('Approved by ' + (data.company_name || 'Seller'), data.staff_approved !== false, pageW - marginX - 16, y + 24)
  chip(
    data.party_confirmed ? 'Confirmed by ' + (data.party_confirmed_name || data.party_name || 'Party') : 'Awaiting party confirmation',
    !!data.party_confirmed,
    pageW - marginX - 16,
    y + 42,
  )

  // ── Items table ──────────────────────────────────────────────────────────────
  y += 80
  const body = data.items.map((it, i) => [
    String(i + 1),
    `${it.name || '—'}${it.sku ? `\n${it.sku}` : ''}`,
    `${it.quantity}${it.unit ? ` ${it.unit}` : ''}`,
    money(it.unit_price),
    money(it.line_total),
  ])

  autoTable(doc, {
    startY: y,
    head: [['#', 'Product', 'Qty', 'Unit Price', 'Amount']],
    body,
    margin: { left: marginX, right: marginX },
    theme: 'grid',
    headStyles: { fillColor: INK, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8, halign: 'left' },
    bodyStyles: { fontSize: 9, textColor: [39, 39, 42], cellPadding: 6, lineColor: LINE, lineWidth: 0.5 },
    alternateRowStyles: { fillColor: [250, 250, 250] },
    columnStyles: {
      0: { cellWidth: 26, halign: 'center', textColor: MUTE },
      2: { cellWidth: 70, halign: 'center' },
      3: { cellWidth: 90, halign: 'right' },
      4: { cellWidth: 96, halign: 'right', fontStyle: 'bold' },
    },
    foot: [[
      { content: 'Grand Total', colSpan: 4, styles: { halign: 'right', fontStyle: 'bold' } },
      { content: money(data.grand_total), styles: { halign: 'right', textColor: AMBER, fontStyle: 'bold', fontSize: 11 } },
    ]],
    footStyles: { fillColor: [244, 244, 245], textColor: INK, fontSize: 9 },
    showFoot: 'lastPage',
  })

  // jspdf-autotable augments the doc instance with lastAutoTable.
  const afterTableY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y + 200
  let ny = afterTableY + 24
  const pageH = doc.internal.pageSize.getHeight()
  const calloutHeight = data.approval_url && !data.party_confirmed ? 62 : data.party_confirmed ? 22 : 0
  if (calloutHeight > 0 && ny + calloutHeight > pageH - 48) {
    doc.addPage()
    ny = 48
  }

  if (data.approval_url && !data.party_confirmed) {
    doc.setDrawColor(...AMBER)
    doc.setFillColor(255, 251, 235)
    doc.roundedRect(marginX, ny, pageW - marginX * 2, 46, 6, 6, 'FD')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(...AMBER)
    doc.text('CONFIRM THIS ORDER', marginX + 14, ny + 18)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...INK)
    doc.text('Open the secure link to review & approve this order (no login needed):', marginX + 14, ny + 32)
    doc.setTextColor(37, 99, 235)
    doc.setFont('helvetica', 'bold')
    doc.textWithLink('Open secure approval link', marginX + 14, ny + 42, { url: data.approval_url })
    ny += 62
  } else if (data.party_confirmed) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(...EMERALD)
    const when = data.party_confirmed_at ? ` on ${fmtDate(data.party_confirmed_at)}` : ''
    doc.text(`Order confirmed by ${data.party_confirmed_name || data.party_name || 'party'}${when}.`, marginX, ny + 4)
  }

  // ── Footer ───────────────────────────────────────────────────────────────────
  const pageCount = doc.getNumberOfPages()
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page)
    doc.setDrawColor(...LINE)
    doc.line(marginX, pageH - 34, pageW - marginX, pageH - 34)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(...MUTE)
    doc.text('System-generated order confirmation.', marginX, pageH - 20)
    doc.text(`Page ${page} of ${pageCount}`, pageW / 2, pageH - 20, { align: 'center' })
    doc.text(data.company_name || '', pageW - marginX, pageH - 20, { align: 'right' })
  }

  return doc
}

export function orderPdfBlob(data: OrderPdfData): Blob {
  return generateOrderPdf(data).output('blob')
}

export function orderPdfFile(data: OrderPdfData): File {
  return new File([orderPdfBlob(data)], orderPdfFilename(data), { type: 'application/pdf' })
}

export function downloadOrderPdf(data: OrderPdfData): void {
  generateOrderPdf(data).save(orderPdfFilename(data))
}
