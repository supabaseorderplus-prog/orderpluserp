import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken } from '@/lib/supabase-server'

const BUCKET = 'aadhaar-docs'

async function ensureBucket() {
  const { data: buckets } = await supabaseAdmin.storage.listBuckets()
  const exists = (buckets || []).some((b) => b.name === BUCKET)
  if (!exists) {
    await supabaseAdmin.storage.createBucket(BUCKET, {
      public: false,
      fileSizeLimit: 5 * 1024 * 1024,
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    })
  }
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    const formData = await req.formData()
    const file = formData.get('aadhaar') as File | null

    if (!file) {
      return NextResponse.json({ success: false, message: 'No file provided' }, { status: 400 })
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json({ success: false, message: 'Invalid file type. Allowed: JPEG, PNG, WebP, PDF' }, { status: 400 })
    }

    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ success: false, message: 'File too large. Max 5MB.' }, { status: 400 })
    }

    await ensureBucket()

    const ext = file.name.split('.').pop()?.toLowerCase() || 'pdf'
    const filePrefix = file.type.startsWith('image/') ? 'img' : 'doc'
    const fileId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
    const filePath = `${filePrefix}-${fileId}.${ext}`

    const buffer = Buffer.from(await file.arrayBuffer())
    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(filePath, buffer, {
        contentType: file.type,
        upsert: false,
      })

    if (uploadError) {
      return NextResponse.json({ success: false, message: 'Upload failed: ' + uploadError.message }, { status: 500 })
    }

    // Aadhaar docs are private — generate a signed URL (1 hour)
    const { data: signedData } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUrl(filePath, 3600)

    return NextResponse.json({
      success: true,
      data: {
        url: signedData?.signedUrl || '',
        file_name: file.name,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to upload file' },
      { status: 500 }
    )
  }
}
