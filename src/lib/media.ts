// Centre pictures (logo, cover, own UPI QR) and staff photos: public bucket "centre-media", one folder per centre.
import { supabase } from './supabase';

export const MEDIA_BUCKET = 'centre-media';

/** Public URL of a stored picture (null-safe). */
export function mediaUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return supabase.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;
}

type Fit = { max: number; type: 'image/png' | 'image/jpeg'; crop?: { w: number; h: number } };
export const FITS = {
  logo: { max: 512, type: 'image/png', crop: { w: 1, h: 1 } },          // PNG keeps a transparent background
  cover: { max: 1600, type: 'image/jpeg', crop: { w: 8, h: 3 } },
  qr: { max: 1000, type: 'image/png' },                                  // PNG keeps the QR sharp
  avatar: { max: 384, type: 'image/jpeg', crop: { w: 1, h: 1 } },
} satisfies Record<string, Fit>;

/** Resize (and centre-crop) a picture on the phone before upload. */
export async function fitImage(file: Blob, fit: Fit): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
  if (fit.crop) {
    const want = fit.crop.w / fit.crop.h;
    if (sw / sh > want) { sw = Math.round(sh * want); sx = Math.round((bmp.width - sw) / 2); }
    else { sh = Math.round(sw / want); sy = Math.round((bmp.height - sh) / 2); }
  }
  const scale = Math.min(1, fit.max / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * scale); canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot resize pictures');
  if (fit.type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, fit.type, 0.86));
  if (!blob) throw new Error('Could not read that picture');
  return blob;
}

/** Upload into <centre>/<folder…>/<name>-<random>.<ext>; returns the stored path. */
export async function uploadMedia(folder: string, name: string, blob: Blob): Promise<string> {
  const ext = blob.type === 'image/png' ? 'png' : 'jpg';
  const path = `${folder}/${name}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(path, blob, { contentType: blob.type, upsert: false });
  if (error) throw error;
  return path;
}

/** Remove an old picture; failures are ignored (an unused file does no harm). */
export async function removeMedia(path: string | null | undefined) {
  if (path) await supabase.storage.from(MEDIA_BUCKET).remove([path]).then(() => undefined, () => undefined);
}

export type QrHit = { text: string; box: { x: number; y: number; w: number; h: number } | null };

/** Read the QR inside a picture (a photo or screenshot of the centre's UPI QR), with where it sits (original pixels). */
export async function readQrFromImage(file: Blob): Promise<QrHit | null> {
  const bmp = await createImageBitmap(file);
  type BDHit = { rawValue: string; boundingBox?: DOMRectReadOnly };
  const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect: (s: ImageBitmap) => Promise<BDHit[]> } }).BarcodeDetector;
  if (BD) {
    try {
      const hit = (await new BD({ formats: ['qr_code'] }).detect(bmp))[0];
      if (hit?.rawValue) {
        const r = hit.boundingBox;
        return { text: hit.rawValue, box: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null };
      }
    } catch { /* fall back to jsQR */ }
  }
  const jsQR = (await import('jsqr')).default;
  // try full size (capped) and a smaller copy: big phone screenshots read better scaled down
  for (const max of [1400, 700]) {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    const hit = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
    if (hit?.data) {
      const l = hit.location; const xs = [l.topLeftCorner.x, l.topRightCorner.x, l.bottomLeftCorner.x, l.bottomRightCorner.x];
      const ys = [l.topLeftCorner.y, l.topRightCorner.y, l.bottomLeftCorner.y, l.bottomRightCorner.y];
      const x0 = Math.min(...xs) / scale, y0 = Math.min(...ys) / scale;
      return { text: hit.data, box: { x: x0, y: y0, w: Math.max(...xs) / scale - x0, h: Math.max(...ys) / scale - y0 } };
    }
  }
  return null;
}

/** Cut the QR out of a screenshot (with a white quiet zone) so it fills the picture; the whole picture if we couldn't find it. */
export async function cropToQr(file: Blob, box: QrHit['box'], max = 1000): Promise<Blob> {
  if (!box || box.w < 40 || box.h < 40) return fitImage(file, { max, type: 'image/png' });
  const bmp = await createImageBitmap(file);
  const side = Math.max(box.w, box.h); const pad = side * 0.1;
  const sx = Math.max(0, box.x - pad), sy = Math.max(0, box.y - pad);
  const sw = Math.min(bmp.width - sx, side + pad * 2), sh = Math.min(bmp.height - sy, side + pad * 2);
  const scale = Math.min(1, max / Math.max(sw, sh));
  const canvas = document.createElement('canvas'); canvas.width = Math.round(sw * scale); canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return fitImage(file, { max, type: 'image/png' });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = scale < 1;
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  return blob ?? fitImage(file, { max, type: 'image/png' });
}
