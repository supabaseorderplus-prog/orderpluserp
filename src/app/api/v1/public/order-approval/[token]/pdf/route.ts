import { NextRequest, NextResponse } from 'next/server'
import { getApprovalByToken } from '@/lib/order-approval-links'
import { loadOrderApprovalView } from '@/lib/order-approval-view'
import { generateOrderPdf, orderPdfFilename, type OrderPdfData } from '@/lib/order-pdf'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const found = await getApprovalByToken(token)
    if (!found) {
      return NextResponse.json({ success: false, message: 'This PDF link is invalid.' }, { status: 404 })
    }
    if (found.effective !== 'ACTIVE') {
      return NextResponse.json(
        { success: false, message: 'This PDF link has expired or has already been used.' },
        { status: 410 },
      )
    }

    const { record } = found
    const { order, items } = await loadOrderApprovalView(record.order_id)
    if (!order) {
      return NextResponse.json({ success: false, message: 'This order is no longer available.' }, { status: 404 })
    }

    const pdfData: OrderPdfData = {
      order_number: record.order_number,
      order_date: (order.created_at as string) || record.created_at,
      company_name: record.company_name,
      party_name: record.party_name,
      party_phone: record.party_phone,
      items,
      grand_total: Number(order.grand_total) || record.grand_total,
      staff_approved: true,
      party_confirmed: false,
      approval_url: `${new URL(req.url).origin}/approve/${token}`,
    }
    const pdf = generateOrderPdf(pdfData)
    const bytes = new Uint8Array(pdf.output('arraybuffer'))
    const filename = orderPdfFilename(pdfData).replace(/["\\]/g, '_')

    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : 'Failed to generate order PDF' },
      { status: 500 },
    )
  }
}
