// Send a branded image (receipt, ticket, offer…) on WhatsApp instead of a link.
// Phones: the share sheet sends the image straight into WhatsApp. Laptop / number not in contacts:
// the image is copied, the customer's chat opens, and staff paste it (Ctrl+V or long-press → Paste).
import { Copy, Download, ImageIcon, MessageCircle, Share2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Lang } from '../lib/cards';
import { Segmented, Sheet, useToast } from './ui';
import { waLink, type WaPair } from './centre';

const LANG_KEY = 'xs-wa-lang';
const readLang = (): Lang => { try { return localStorage.getItem(LANG_KEY) === 'ml' ? 'ml' : 'en'; } catch { return 'en'; } };

export function canShareImages(): boolean {
  try {
    const f = new File([new Blob(['x'], { type: 'image/png' })], 'x.png', { type: 'image/png' });
    return typeof navigator !== 'undefined' && !!navigator.canShare && navigator.canShare({ files: [f] });
  } catch { return false; }
}

async function copyImage(blob: Blob): Promise<boolean> {
  try {
    if (!('ClipboardItem' in window) || !navigator.clipboard?.write) return false;
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch { return false; }
}

function download(blob: Blob, filename: string) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = u; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 4000);
}

export function ImageSendButton(props: Omit<SheetProps, 'onClose'> & { label: string; small?: boolean; block?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const { label, small = true, block = false, className = '', ...sheet } = props;
  return (
    <>
      <button type="button" className={`btn${small ? ' small' : ''}${block ? ' block' : ''} wa ${className}`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }} aria-label={`${label}${sheet.name ? `: ${sheet.name}` : ''}`}>
        <MessageCircle size={16} aria-hidden /> <span className="btn-text">{label}</span>
      </button>
      {open && <ImageSendSheet {...sheet} onClose={() => setOpen(false)} />}
    </>
  );
}

type SheetProps = {
  title: string; name?: string; phone?: string | null; filename: string;
  /** Makes the image for a language. */ build: (lang: Lang) => Promise<Blob>;
  /** Short caption sent with the image — no links. */ caption: WaPair;
  onClose: () => void; onSent?: () => void;
};

export function ImageSendSheet({ title, name, phone, filename, build, caption, onClose, onSent }: SheetProps) {
  const toast = useToast();
  const [lang, setLangState] = useState<Lang>(readLang);
  const [text, setText] = useState(caption[lang]);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const share = canShareImages();
  const digits = (phone ?? '').replace(/\D/g, '');

  // make the image as soon as the sheet opens (and on language change), so a tap can share it instantly
  useEffect(() => {
    let alive = true; setBlob(null); setErr(null);
    build(lang).then((b) => { if (!alive) return; setBlob(b); setUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(b); }); })
      .catch((e) => alive && setErr(e instanceof Error ? e.message : 'Could not make the image'));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const setLang = (l: Lang) => { setLangState(l); setText(caption[l]); try { localStorage.setItem(LANG_KEY, l); } catch { /* ignore */ } };
  const file = () => new File([blob!], filename, { type: 'image/png' });

  async function viaShareSheet() {
    if (!blob) return;
    try {
      await navigator.share({ files: [file()], text });
      onSent?.(); onClose();
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast('Could not open sharing. Try "Open chat and paste".');
    }
  }
  async function viaChat() {
    if (!blob) return;
    const copied = await copyImage(blob);
    if (!copied) download(blob, filename);
    window.open(digits ? waLink(digits, text) : `https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    toast(copied ? 'Image copied — paste it in the WhatsApp chat (Ctrl+V or long-press → Paste)' : 'Image saved — attach it in the WhatsApp chat');
    onSent?.();
  }

  return (
    <Sheet title={title} onClose={onClose}>
      <div className="stack lg">
        <Segmented label="Language" value={lang} onChange={setLang} options={[{ value: 'en', label: 'English' }, { value: 'ml', label: 'മലയാളം' }]} />
        <div className="img-send-preview" aria-busy={!blob}>
          {url && blob ? <img src={url} alt={`${title} image`} /> : err ? <span className="muted">{err}</span> : <span className="muted"><ImageIcon size={18} /> Making the image…</span>}
        </div>
        <label className="field"><span>Message with the image</span>
          <textarea className="input" rows={2} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        {share ? (
          <>
            <button className="btn primary block xl wa" disabled={!blob} onClick={viaShareSheet}><Share2 size={18} /> Send image on WhatsApp</button>
            <p className="muted" style={{ margin: 0 }}>Choose WhatsApp, then {name ? `${name}'s chat` : 'the chat'}.{digits ? ' Number not saved in contacts? Use the button below.' : ''}</p>
            {digits && <button className="btn block" disabled={!blob} onClick={viaChat}><Copy size={16} /> Open {phone} chat and paste the image</button>}
          </>
        ) : (
          <>
            <button className="btn primary block xl wa" disabled={!blob} onClick={viaChat}><Copy size={18} /> Copy image and open WhatsApp</button>
            <p className="muted" style={{ margin: 0 }}>{digits ? `Opens ${phone}'s chat. ` : ''}Paste the image there (Ctrl+V) and press send.</p>
          </>
        )}
        <button className="btn ghost small" style={{ justifySelf: 'start' }} disabled={!blob} onClick={() => blob && download(blob, filename)}><Download size={16} /> Save image</button>
      </div>
    </Sheet>
  );
}
