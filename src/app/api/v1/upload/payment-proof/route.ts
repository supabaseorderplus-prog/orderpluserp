import { NextRequest, NextResponse } from 'next/server'
import { getUserFromToken } from '@/lib/supabase-server'

const BUCKET = 'payment-proofs'
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

const storageHeaders = {
  apikey: supabaseServiceKey,
  Authorization: `Bearer ${supabaseServiceKey}`,
}

async function ensureBucket() {
  const listRes = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
    headers: { ...storageHeaders, 'Content-Type': 'application/json' },
  })
  if (!listRes.ok) throw new Error(`Storage not accessible: ${listRes.statusText}`)

  const buckets: { name: string }[] = await listRes.json()
  if (buckets.some((b) => b.name === BUCKET)) return

  const createRes = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...storageHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: BUCKET,
      name: BUCKET,
      public: true,
      file_size_limit: 10 * 1024 * 1024,
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
    const file = formData.get('image') as File | null

    if (!file) {
      return NextResponse.json({ success: false, message: 'No file provided' }, { status: 400 })
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp']
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json(
        { success: false, message: 'Invalid file type. Allowed: JPEG, PNG, WebP' },
        { status: 400 },
      )
    }

    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json({ success: false, message: 'File too large. Max 10MB.' }, { status: 400 })
    }

    await ensureBucket()

    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
    const fileId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
    const filePath = `${fileId}.${ext}`
    const buffer = await file.arrayBuffer()

    // Upload directly via REST API with service-role key — bypasses storage.objects RLS entirely
    const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${filePath}`, {
      method: 'POST',
      headers: {
        ...storageHeaders,
        'Content-Type': file.type,
        'x-upsert': 'false',
      },
      body: buffer,
    })

    if (!uploadRes.ok) {
      const body = await uploadRes.json().catch(() => ({}))
      const msg: string = body?.message ?? body?.error ?? uploadRes.statusText
      return NextResponse.json({ success: false, message: `Upload failed: ${msg}` }, { status: 500 })
    }

    const publicUrl = `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${filePath}`
    return NextResponse.json({ success: true, data: { url: publicUrl } })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to upload proof' },
      { status: 500 },
    )
  }
}
