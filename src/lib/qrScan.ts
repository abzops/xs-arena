// Camera QR scanning that works everywhere: the browser's own BarcodeDetector where it exists (Chrome on Android),
// otherwise jsQR on video frames (iPad/iPhone Safari, Firefox, desktop). jsQR is loaded only when the camera opens.

export const cameraAvailable = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;

type Detector = { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> };

/**
 * Starts the back camera in `video` and calls `onCode` with each QR text found until `accept` returns true.
 * Returns a stop function. `onError` gets a short message when the camera can't be used.
 */
export function startQrScan(video: HTMLVideoElement, accept: (text: string) => boolean, onError: (msg: string) => void): () => void {
  let stopped = false; let stream: MediaStream | null = null; let timer = 0;
  const stop = () => { stopped = true; window.clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };

  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (e) {
      const name = (e as { name?: string }).name;
      onError(name === 'NotAllowedError' ? 'Camera blocked. Allow the camera for this site, or type the code.' : 'Camera not available. Type the code instead.');
      return;
    }
    if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
    video.setAttribute('playsinline', 'true');   // iOS: play inline, not full screen
    video.muted = true;
    video.srcObject = stream;
    try { await video.play(); } catch { /* autoplay hiccup; frames still arrive */ }

    const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    let detector: Detector | null = null;
    if (BD) { try { detector = new BD({ formats: ['qr_code'] }); } catch { detector = null; } }
    const jsQR = detector ? null : (await import('jsqr')).default;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const tick = async () => {
      if (stopped) return;
      try {
        if (video.readyState >= 2 && video.videoWidth) {
          let text: string | null = null;
          if (detector) {
            const codes = await detector.detect(video);
            text = codes.find((c) => accept(c.rawValue))?.rawValue ?? null;
          } else if (jsQR && ctx) {
            // scan a centred square at most 720 px wide: fast enough on an iPad, sharp enough for a phone screen
            const side = Math.min(video.videoWidth, video.videoHeight);
            const size = Math.min(side, 720);
            canvas.width = size; canvas.height = size;
            ctx.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, size, size);
            const img = ctx.getImageData(0, 0, size, size);
            const hit = jsQR(img.data, size, size, { inversionAttempts: 'attemptBoth' });
            if (hit?.data && accept(hit.data)) text = hit.data;
          }
          if (text) { stop(); return; }
        }
      } catch { /* frame not ready */ }
      timer = window.setTimeout(() => void tick(), detector ? 200 : 120);
    };
    void tick();
  })();
  return stop;
}
