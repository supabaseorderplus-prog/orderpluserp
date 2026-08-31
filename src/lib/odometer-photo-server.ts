import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

export const DUTY_ODOMETER_BUCKET = "duty-odometer-photos";

export async function createOdometerPhotoSignedUrl(path: unknown): Promise<string | null> {
  if (typeof path !== "string" || !path || path === "legacy-verified-photo") return null;
  const { data, error } = await supabaseAdmin.storage
    .from(DUTY_ODOMETER_BUCKET)
    .createSignedUrl(path, 60 * 60);
  if (error) {
    console.warn("odometer photo signed URL error:", error.message);
    return null;
  }
  return data.signedUrl || null;
}

export async function attachOdometerPhotoUrls<T extends Record<string, unknown>>(row: T): Promise<T & {
  start_odometer_photo_url: string | null;
  end_odometer_photo_url: string | null;
}> {
  const [startUrl, endUrl] = await Promise.all([
    createOdometerPhotoSignedUrl(row.start_odometer_photo_path),
    createOdometerPhotoSignedUrl(row.end_odometer_photo_path),
  ]);
  return {
    ...row,
    start_odometer_photo_url: startUrl,
    end_odometer_photo_url: endUrl,
  };
}
