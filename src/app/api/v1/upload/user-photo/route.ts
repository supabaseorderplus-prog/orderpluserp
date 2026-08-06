import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken } from '@/lib/supabase-server'

const BUCKET = 'user-photos'
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

async function ensureBucket() {
  const headers = {
    'Content-Type': 'application/json',
    apikey: supabaseServiceKey,
    Authorization: `Bearer ${supabaseServiceKey}`,
  }

  const listRes = await fetch(`${supabaseUrl}/storage/v1/bucket`, { headers })
  if (!listRes.ok) throw new Error(`Storage not accessible: ${listRes.statusText}`)
  const buckets: { name: string }[] = await listRes.json()
  if (buckets.some((b) => b.name === BUCKET)) return

  const createRes = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: BUCKET,
      name: BUCKET,
      public: true,
      file_size_limit: 5 * 1024 * 1024,
      allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'],
    }),
  })
  if (!createRes.ok) {
    const body = await createRes.json().catch(() => ({}))
    const msg: string = body?.message ?? createRes.statusText
    if (!msg.toLowerCase().includes('already exists')) {
      throw new Error(`Failed to create storage bucket: ${msg}`)
    }
  }
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    const formData = await req.formData()
    const file = formData.get('photo') as File | null

    if (!file) {
      return NextResponse.json({ success: false, message: 'No file provided' }, { status: 400 })
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp']
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json({ success: false, message: 'Invalid file type. Allowed: JPEG, PNG, WebP' }, { status: 400 })
    }

    if (file.size > 3 * 1024 * 1024) {
      return NextResponse.json({ success: false, message: 'File too large. Max 3MB.' }, { status: 400 })
    }

    await ensureBucket()

    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
    const fileId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
    const filePath = `${fileId}.${ext}`

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

    const { data: urlData } = supabaseAdmin.storage
      .from(BUCKET)
      .getPublicUrl(filePath)

    return NextResponse.json({
      success: true,
      data: { url: urlData.publicUrl, file_name: file.name },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to upload photo' },
      { status: 500 }
    )
  }
}
