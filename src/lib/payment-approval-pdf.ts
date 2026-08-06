import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import type { PaymentApprovalRecord } from '@/lib/payment-approval-links'

const INK: [number, number, number] = [24, 24, 27]
const AMBER: [number, number, number] = [217, 119, 6]
const GREEN: [number, number, number] = [5, 150, 105]
const MUTED: [number, number, number] = [113, 113, 122]
const LINE: [number, number, number] = [228, 228, 231]

const money = (n: number) => `Rs ${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0)}`
const date = (v: string | null) => {
  if (!v) return '-'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}
const pct = (n: number) => `${Math.max(0, Math.min(100, Number(n) || 0)).toFixed(1)}%`

export function paymentApprovalPdfFilename(record: PaymentApprovalRecord) {
  const safe = record.request_number.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')
  return `Payment_Approval_${safe}.pdf`
}

export function generatePaymentApprovalPdf(record: PaymentApprovalRecord, approvalUrl: string) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' })
  const width = doc.internal.pageSize.getWidth()
  const height = doc.internal.pageSize.getHeight()
  const mx = 40

  const ensure = (y: number, required: number) => {
    if (y + required <= height - 56) return y
    doc.addPage()
    return 44
  }

  doc.setFillColor(...INK)
  doc.rect(0, 0, width, 104, 'F')
  doc.setFillColor(...AMBER)
  doc.rect(0, 104, width, 3, 'F')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.setTextColor(255, 255, 255)
  doc.text(record.company_name || 'HomeTech Chemical', mx, 38)
  doc.setFontSize(9)
  doc.setTextColor(212, 212, 216)
  doc.text('PAYMENT ACKNOWLEDGEMENT & APPROVAL', mx, 57)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(161, 161, 170)
  doc.text(`Request: ${record.request_number}`, width - mx, 35, { align: 'right' })
  doc.text(`Initiated: ${date(record.created_at)}`, width - mx, 51, { align: 'right' })
  doc.text('Status: AWAITING PARTY APPROVAL', width - mx, 67, { align: 'right' })

  let y = 126
  doc.setFillColor(255, 251, 235)
  doc.setDrawColor(...AMBER)
  doc.roundedRect(mx, y, width - mx * 2, 62, 6, 6, 'FD')
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(...MUTED)
  doc.text('PAYMENT PROPOSED', mx + 15, y + 18)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(20)
  doc.setTextColor(...INK)
  doc.text(money(record.payload.amount), mx + 15, y + 43)
  doc.setFontSize(9)
  doc.setTextColor(...AMBER)
  doc.text(`${record.payload.payment_mode}${record.payload.reference_number ? `  |  Ref: ${record.payload.reference_number}` : ''}`, width - mx - 15, y + 29, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(...MUTED)
  doc.text('Not posted until the party approves', width - mx - 15, y + 45, { align: 'right' })

  y += 80
  autoTable(doc, {
    startY: y,
    head: [['Party', 'Party Code', 'Collected By', 'Projected Balance']],
    body: [[record.party_name, record.party_code || '-', record.collector_name || '-', money(record.balance_after)]],
    margin: { left: mx, right: mx },
    theme: 'grid',
    headStyles: { fillColor: INK, textColor: [255, 255, 255], fontSize: 8 },
    bodyStyles: { fontSize: 9, textColor: INK, cellPadding: 7, lineColor: LINE, lineWidth: 0.5 },
  })
  y = ((doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable?.finalY || y) + 22

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(...INK)
  doc.text('INVOICE ALLOCATION', mx, y)
  y += 8
  if (record.invoices.length) {
    autoTable(doc, {
      startY: y,
      head: [['Invoice', 'Date', 'Before', 'Applied', 'After', 'Status']],
      body: record.invoices.map((invoice) => [
        invoice.invoice_number,
        date(invoice.invoice_date),
        money(invoice.outstanding_before),
        money(invoice.allocation),
        money(invoice.outstanding_after),
        invoice.status_after,
      ]),
      margin: { left: mx, right: mx },
      theme: 'grid',
      headStyles: { fillColor: INK, textColor: [255, 255, 255], fontSize: 8 },
      bodyStyles: { fontSize: 8, textColor: INK, cellPadding: 6, lineColor: LINE, lineWidth: 0.5 },
      columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'center', fontStyle: 'bold' } },
    })
    y = ((doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable?.finalY || y) + 22
  } else {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(...MUTED)
    doc.text(record.payload.is_advance ? 'Advance / unallocated payment - no invoice attached.' : 'No invoice allocation selected.', mx, y + 13)
    y += 34
  }

  y = ensure(y, record.schemes.length ? 120 : 58)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(...INK)
  doc.text('SCHEME IMPACT', mx, y)
  y += 8
  if (record.schemes.length) {
    autoTable(doc, {
      startY: y,
      head: [['Scheme', 'Current', 'This Payment', 'Projected', 'Progress', 'Projected Status']],
      body: record.schemes.map((scheme) => [
        `${scheme.name}${scheme.end_date ? `\nEnds ${date(scheme.end_date)}` : ''}`,
        money(scheme.current_value),
        money(scheme.payment_credit),
        `${money(scheme.projected_value)} / ${money(scheme.target_value)}`,
        `${pct(scheme.progress_before)} -> ${pct(scheme.progress_after)}`,
        scheme.status_after,
      ]),
      margin: { left: mx, right: mx },
      theme: 'grid',
      headStyles: { fillColor: INK, textColor: [255, 255, 255], fontSize: 7 },
      bodyStyles: { fontSize: 7.5, textColor: INK, cellPadding: 5, lineColor: LINE, lineWidth: 0.5 },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'center' }, 5: { halign: 'center', fontStyle: 'bold' } },
    })
    y = ((doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable?.finalY || y) + 22
  } else {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(...MUTED)
    doc.text('No party scheme is attached to this payment.', mx, y + 13)
    y += 34
  }

  y = ensure(y, 122)
  autoTable(doc, {
    startY: y,
    head: [['Additional Detail', 'Value']],
    body: [
      ['Payment mode', record.payload.payment_mode],
      ['Bank / instrument', record.payload.bank_name || '-'],
      ['Reference / UTR / coupon', record.payload.reference_number || '-'],
      ['Unallocated amount', money(record.unallocated_amount)],
      ['Notes', record.payload.notes || '-'],
      ['Approval deadline', new Date(record.expires_at).toLocaleString('en-IN')],
    ],
    margin: { left: mx, right: mx },
    theme: 'grid',
    headStyles: { fillColor: [244, 244, 245], textColor: INK, fontSize: 8 },
    bodyStyles: { fontSize: 8, textColor: INK, cellPadding: 5, lineColor: LINE, lineWidth: 0.5 },
    columnStyles: { 0: { cellWidth: 145, textColor: MUTED } },
  })
  y = ((doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable?.finalY || y) + 20
  y = ensure(y, 68)

  doc.setFillColor(236, 253, 245)
  doc.setDrawColor(...GREEN)
  doc.roundedRect(mx, y, width - mx * 2, 50, 6, 6, 'FD')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(...GREEN)
  doc.text('SECURE PARTY APPROVAL REQUIRED', mx + 14, y + 18)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(...INK)
  doc.text('The payment, invoice allocation, wallet and scheme progress update only after approval.', mx + 14, y + 32)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(37, 99, 235)
  doc.textWithLink('Open secure approval page', mx + 14, y + 43, { url: approvalUrl })

  const pages = doc.getNumberOfPages()
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page)
    doc.setDrawColor(...LINE)
    doc.line(mx, height - 34, width - mx, height - 34)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(...MUTED)
    doc.text('System-generated secure payment approval document.', mx, height - 20)
    doc.text(`Page ${page} of ${pages}`, width / 2, height - 20, { align: 'center' })
    doc.text(record.request_number, width - mx, height - 20, { align: 'right' })
  }
  return doc
}
