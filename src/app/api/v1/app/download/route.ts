import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export async function GET() {
  // APK is stored as base64 text so Orchids deployment pipeline
  // (which corrupts binary files via UTF-8 replacement) cannot mangle it.
  const b64Path = path.join(process.cwd(), 'public', 'downloads', 'HomeTech.apk.b64')

  if (!fs.existsSync(b64Path)) {
    return NextResponse.json({ error: 'APK not found' }, { status: 404 })
  }

  const b64 = fs.readFileSync(b64Path, 'utf-8').replace(/\s/g, '')
  const apkBuffer = Buffer.from(b64, 'base64')

  return new NextResponse(apkBuffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': 'attachment; filename="Order-Plus-ERP-v2.apk"',
      'Content-Length': apkBuffer.length.toString(),
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
    },
  })
}
