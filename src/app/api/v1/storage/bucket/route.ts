import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken } from '@/lib/supabase-server'

export async function POST(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    // Only allow ADMIN or SUPER_ADMIN to create buckets
    if (authUser.role !== 'ADMIN' && authUser.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Forbidden' }, { status: 403 })
    }

    const { bucketName } = await req.json()
    const bucket = bucketName || 'party-documents'

    // Check if bucket already exists
    const { data: existingBuckets, error: listError } = await supabaseAdmin.storage.listBuckets()
    
    if (listError) {
      return NextResponse.json({ success: false, message: 'Failed to list buckets: ' + listError.message }, { status: 500 })
    }

    const bucketExists = existingBuckets?.some(b => b.name === bucket)
    
    if (bucketExists) {
      return NextResponse.json({ success: true, message: `Bucket '${bucket}' already exists` })
    }

    // Create the bucket
    const { data, error } = await supabaseAdmin.storage.createBucket(bucket, {
      public: true, // Make it public so URLs are directly accessible
      fileSizeLimit: 5242880, // 5MB limit
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
    })

    if (error) {
      return NextResponse.json({ success: false, message: 'Failed to create bucket: ' + error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, message: `Bucket '${bucket}' created successfully`, data })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to create bucket' },
      { status: 500 }
    )
  }
}