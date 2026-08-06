import { describe, expect, it } from 'vitest'
import { generateOrderPdf, orderPdfFilename, type OrderPdfData } from '@/lib/order-pdf'

function sample(itemCount: number): OrderPdfData {
  const items = Array.from({ length: itemCount }, (_, index) => ({
    name: `Premium construction chemical ${index + 1}`,
    sku: `HT-${index + 1}`,
    quantity: index + 1,
    unit_price: 1250.5,
    line_total: (index + 1) * 1250.5,
    unit: 'kg',
  }))
  return {
    order_number: 'ORD/2026/00421',
    order_date: '2026-07-04',
    company_name: 'HomeTech Chemical',
    party_name: 'Example Party',
    party_phone: '+91 98765 43210',
    items,
    grand_total: items.reduce((sum, item) => sum + item.line_total, 0),
    staff_approved: true,
    party_confirmed: false,
    approval_url: 'https://example.com/approve/single-use-token',
  }
}

describe('order confirmation PDF', () => {
  it('produces a valid PDF with a safe stable filename', () => {
    const data = sample(3)
    const bytes = new Uint8Array(generateOrderPdf(data).output('arraybuffer'))

    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('%PDF')
    expect(bytes.byteLength).toBeGreaterThan(5_000)
    expect(orderPdfFilename(data)).toBe('Order_ORD_2026_00421.pdf')
  })

  it('paginates large orders without failing', () => {
    const pdf = generateOrderPdf(sample(40))

    expect(pdf.getNumberOfPages()).toBeGreaterThan(1)
  })
})
