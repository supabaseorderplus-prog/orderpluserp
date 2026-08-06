import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

const BUCKET = 'company-assets'

async function ensureBucket() {
  const { data: buckets } = await supabaseAdmin.storage.listBuckets()
  const exists = (buckets || []).some((b) => b.name === BUCKET)
  if (!exists) {
    await supabaseAdmin.storage.createBucket(BUCKET, {
      public: true,
      fileSizeLimit: 10 * 1024 * 1024,
      allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'],
    })
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: companyId } = await params
    const authUser = await getUserFromToken(req)
    const scopedCompanyId = await resolveCompanyScope(req, authUser)

    // Only allow admin/super-admin to upload logo for their own company
    if (scopedCompanyId && scopedCompanyId !== companyId) {
      return NextResponse.json({ success: false, message: 'Access denied' }, { status: 403 })
    }

    const formData = await req.formData()
    const file = formData.get('logo') as File | null

    if (!file) {
      return NextResponse.json({ success: false, message: 'No file provided' }, { status: 400 })
    }

    // Validate file type
    const allowedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json({ success: false, message: 'Invalid file type. Allowed: PNG, JPEG, WebP, SVG' }, { status: 400 })
    }

    // Validate file size (5MB max)
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ success: false, message: 'File too large. Max 5MB.' }, { status: 400 })
    }

    await ensureBucket()

    const ext = file.name.split('.').pop() || 'png'
    const filePath = `logos/${companyId}/logo.${ext}`

    const buffer = Buffer.from(await file.arrayBuffer())
    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(filePath, buffer, {
        contentType: file.type,
        upsert: true,
      })

    if (uploadError) {
      return NextResponse.json({ success: false, message: 'Upload failed: ' + uploadError.message }, { status: 500 })
    }

    const { data: urlData } = supabaseAdmin.storage
      .from(BUCKET)
      .getPublicUrl(filePath)

    const logoUrl = urlData.publicUrl

    // Update parties table with logo_url
    const { error: updateError } = await supabaseAdmin
      .from('parties')
      .update({ logo_url: logoUrl })
      .eq('id', companyId)

    if (updateError) {
      return NextResponse.json({ success: false, message: 'Failed to update logo URL: ' + updateError.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, data: { logo_url: logoUrl }, message: 'Logo uploaded successfully' })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to upload logo' },
      { status: 500 }
    )
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: companyId } = await params
    const authUser = await getUserFromToken(req)
    const scopedCompanyId = await resolveCompanyScope(req, authUser)

    if (scopedCompanyId && scopedCompanyId !== companyId) {
      return NextResponse.json({ success: false, message: 'Access denied' }, { status: 403 })
    }

    // Remove logo from storage
    const { error: removeError } = await supabaseAdmin.storage
      .from(BUCKET)
      .remove([`logos/${companyId}/logo.png`, `logos/${companyId}/logo.jpg`, `logos/${companyId}/logo.jpeg`, `logos/${companyId}/logo.webp`, `logos/${companyId}/logo.svg`])

    // Clear logo_url in parties table
    const { error: updateError } = await supabaseAdmin
      .from('parties')
      .update({ logo_url: null })
      .eq('id', companyId)

    if (updateError) {
      return NextResponse.json({ success: false, message: 'Failed to clear logo URL' }, { status: 500 })
    }

    return NextResponse.json({ success: true, message: 'Logo removed successfully' })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to remove logo' },
      { status: 500 }
    )
  }
}
