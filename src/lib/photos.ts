// Bill photos: shrink on the phone before upload (max 1600 px, JPEG), store in the private "expense-bills" bucket.
import { supabase } from './supabase';

export const BILL_BUCKET = 'expense-bills';

/** Resize an image file to a JPEG no wider/taller than `max` px. Falls back to the original if the browser can't decode it. */
export async function shrinkImage(file: File, max = 1600, quality = 0.8): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
    return blob ?? file;
  } catch {
    return file;
  }
}

/** Upload a bill photo into the centre's folder; returns the stored path. */
export async function uploadBillPhoto(centreId: string, file: File): Promise<string> {
  const blob = await shrinkImage(file);
  const path = `${centreId}/${crypto.randomUUID()}.jpg`;
  const { error } = await supabase.storage.from(BILL_BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (error) throw error;
  return path;
}

/** A link that works for 10 minutes (the bucket is private). */
export async function billPhotoUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BILL_BUCKET).createSignedUrl(path, 600);
  if (error) throw error;
  return data.signedUrl;
}
