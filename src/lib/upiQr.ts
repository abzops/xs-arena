// What's inside a centre's UPI QR: "upi://pay?pa=name@bank&pn=Name…", or a Bharat QR (EMV) string with the UPI ID inside.
export type UpiQrInfo = { upiId: string; payee: string | null };

const VPA = /^[A-Za-z0-9._-]{2,64}@[A-Za-z0-9.-]{2,64}$/;

export function parseUpiQr(text: string | null | undefined): UpiQrInfo | null {
  const raw = (text ?? '').trim();
  if (!raw) return null;
  if (/^upi:\/\//i.test(raw)) {
    const q = raw.slice(raw.indexOf('?') + 1);
    let params: URLSearchParams;
    try { params = new URLSearchParams(q); } catch { return null; }
    const pa = params.get('pa')?.trim();
    if (!pa || !VPA.test(pa)) return null;
    const pn = params.get('pn')?.trim() || null;
    return { upiId: pa, payee: pn ? pn.slice(0, 60) : null };
  }
  // Bharat QR / EMV: find the UPI ID; merchant name is tag 59
  if (/^000201/.test(raw)) {
    const tags = readEmv(raw);
    // merchant account templates are tags 26–51; the UPI ID is one of their sub-values
    let upiId: string | null = null;
    for (let t = 26; t <= 51 && !upiId; t++) {
      const sub = tags[String(t)];
      if (sub) upiId = Object.values(readEmv(sub)).find((v) => VPA.test(v)) ?? null;
    }
    if (!upiId) return null;
    return { upiId, payee: tags['59']?.trim().slice(0, 60) || null };
  }
  return null;
}

function readEmv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i + 4 <= s.length) {
    const tag = s.slice(i, i + 2); const len = Number(s.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(s.slice(i + 2, i + 4)) || i + 4 + len > s.length) break;
    out[tag] = s.slice(i + 4, i + 4 + len); i += 4 + len;
  }
  return out;
}
