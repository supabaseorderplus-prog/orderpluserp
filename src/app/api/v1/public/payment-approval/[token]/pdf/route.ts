import { NextRequest, NextResponse } from 'next/server'
import { getPaymentApprovalByToken } from '@/lib/payment-approval-links'
import { generatePaymentApprovalPdf, paymentApprovalPdfFilename } from '@/lib/payment-approval-pdf'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const found = await getPaymentApprovalByToken(token)
    if (!found) return NextResponse.json({ success: false, message: 'This PDF link is invalid.' }, { status: 404 })
    if (found.effective !== 'ACTIVE') {
      return NextResponse.json({ success: false, message: 'This PDF link has expired or has already been used.' }, { status: 410 })
    }
    const approvalUrl = `${new URL(req.url).origin}/approve-payment/${token}`
    const pdf = generatePaymentApprovalPdf(found.record, approvalUrl)
    const bytes = new Uint8Array(pdf.output('arraybuffer'))
    const filename = paymentApprovalPdfFilename(found.record).replace(/["\\]/g, '_')
    return new NextResponse(bytes, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    return NextResponse.json({ success: false, message: error instanceof Error ? error.message : 'Failed to generate payment PDF.' }, { status: 500 })
  }
}
