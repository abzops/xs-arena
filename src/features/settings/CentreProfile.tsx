// Settings: the centre's own pictures (logo, cover photo), its own UPI QR, and the signed-in person's photo.
import { useQueryClient } from '@tanstack/react-query';
import { Camera, ImagePlus, QrCode, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useCentre } from '../../app/centre';
import { Notice, useToast } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { cropToQr, FITS, fitImage, mediaUrl, readQrFromImage, removeMedia, uploadMedia } from '../../lib/media';
import { supabase } from '../../lib/supabase';
import { parseUpiQr } from '../../lib/upiQr';

type Col = 'logo_path' | 'cover_path';

/** Pick-a-picture button: hidden file input + a normal button. */
function PickButton({ label, testid, onPick, busy, icon }: { label: string; testid: string; onPick: (f: File) => void; busy: boolean; icon?: React.ReactNode }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={ref} type="file" accept="image/png,image/jpeg,image/webp" hidden data-testid={testid}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onPick(f); }} />
      <button type="button" className="btn small" disabled={busy} onClick={() => ref.current?.click()}>
        {busy ? <span className="spinner" /> : icon ?? <ImagePlus size={16} />} {label}</button>
    </>
  );
}

/** Logo + cover photo. Saved straight away (no need to press Save). */
export function ProfilePictures() {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<Col | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const put = async (col: Col, file: File | null) => {
    setBusy(col); setErr(null);
    try {
      const old = centre[col];
      const path = file ? await uploadMedia(centre.id, col === 'logo_path' ? 'logo' : 'cover', await fitImage(file, col === 'logo_path' ? FITS.logo : FITS.cover)) : null;
      const { error } = await supabase.from('centres').update({ [col]: path, updated_at: new Date().toISOString() }).eq('id', centre.id);
      if (error) { await removeMedia(path); throw error; }
      await removeMedia(old);
      await qc.invalidateQueries({ queryKey: ['centre'] });
      toast(file ? (col === 'logo_path' ? 'Logo saved' : 'Cover photo saved') : 'Removed');
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(null); }
  };

  const logo = mediaUrl(centre.logo_path), cover = mediaUrl(centre.cover_path);
  return (
    <div className="stack" data-testid="profile-pictures">
      <div className="profile-preview" style={cover ? { backgroundImage: `url(${cover})` } : undefined}>
        <div className="profile-logo">{logo ? <img src={logo} alt="Logo" data-testid="logo-img" /> : <span>{centre.name.slice(0, 2).toUpperCase()}</span>}</div>
        <b className="profile-name">{centre.name}</b>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 'var(--t-sm)' }}>Shown on your booking page, tickets, receipts and the WhatsApp bill images.</p>
      <div className="row wrap">
        <PickButton label={logo ? 'Change logo' : 'Add logo'} testid="logo-file" busy={busy === 'logo_path'} onPick={(f) => void put('logo_path', f)} />
        {logo && <button type="button" className="btn small ghost" onClick={() => void put('logo_path', null)}><Trash2 size={16} /> Logo</button>}
        <PickButton label={cover ? 'Change cover photo' : 'Add cover photo'} testid="cover-file" busy={busy === 'cover_path'} onPick={(f) => void put('cover_path', f)} />
        {cover && <button type="button" className="btn small ghost" onClick={() => void put('cover_path', null)}><Trash2 size={16} /> Cover</button>}
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
    </div>
  );
}

export type UpiForm = { upi_id: string; upi_payee: string; upi_mode: 'amount' | 'own' };

/** UPI: upload the centre's own QR (we read the UPI ID from it), choose which QR customers see. */
export function UpiSetup({ f, onChange }: { f: UpiForm; onChange: (p: Partial<UpiForm>) => void }) {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn' | 'bad'; text: string } | null>(null);
  const qr = mediaUrl(centre.upi_qr_path);

  const upload = async (file: File) => {
    setBusy(true); setMsg(null);
    try {
      const hit = await readQrFromImage(file).catch(() => null);
      const info = parseUpiQr(hit?.text);
      // a UPI QR found: keep just the QR (sharper on screen); otherwise keep the whole picture
      const path = await uploadMedia(centre.id, 'upi', info ? await cropToQr(file, hit?.box ?? null) : await fitImage(file, FITS.qr));
      const patch: Record<string, unknown> = { upi_qr_path: path, upi_mode: 'own', updated_at: new Date().toISOString() };
      if (info) { patch.upi_id = info.upiId; if (info.payee) patch.upi_payee = info.payee; }
      const { error } = await supabase.from('centres').update(patch).eq('id', centre.id);
      if (error) { await removeMedia(path); throw error; }
      await removeMedia(centre.upi_qr_path);
      onChange({ upi_mode: 'own', ...(info ? { upi_id: info.upiId, ...(info.payee ? { upi_payee: info.payee } : {}) } : {}) });
      await qc.invalidateQueries({ queryKey: ['centre'] });
      setMsg(info
        ? { tone: 'ok', text: `QR saved. UPI ID found: ${info.upiId}${info.payee ? ` (${info.payee})` : ''}` }
        : { tone: 'warn', text: 'QR saved, but we could not read a UPI ID from it. Customers will see your picture; type your UPI ID below if you want exact-amount QRs.' });
      toast('UPI QR saved');
    } catch (e) { setMsg({ tone: 'bad', text: errorMessage(e) }); } finally { setBusy(false); }
  };

  const removeQr = async () => {
    setBusy(true); setMsg(null);
    try {
      const { error } = await supabase.from('centres').update({ upi_qr_path: null, upi_mode: 'amount', updated_at: new Date().toISOString() }).eq('id', centre.id);
      if (error) throw error;
      await removeMedia(centre.upi_qr_path);
      onChange({ upi_mode: 'amount' });
      await qc.invalidateQueries({ queryKey: ['centre'] });
    } catch (e) { setMsg({ tone: 'bad', text: errorMessage(e) }); } finally { setBusy(false); }
  };

  return (
    <div className="stack" data-testid="upi-setup">
      <div className="row wrap" style={{ alignItems: 'flex-start', gap: 'var(--s-4)' }}>
        <div className="upi-own-qr">{qr ? <img src={qr} alt="Your UPI QR" data-testid="upi-qr-img" /> : <QrCode size={40} className="muted" />}</div>
        <div className="stack grow" style={{ minWidth: 220 }}>
          <b>Your UPI QR</b>
          <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>Upload a photo or screenshot of the QR from your bank, GPay, PhonePe or Paytm. We read your UPI ID from it.</span>
          <div className="row wrap">
            <PickButton label={qr ? 'Change QR' : 'Upload QR'} testid="upi-qr-file" busy={busy} onPick={(file) => void upload(file)} icon={<Camera size={16} />} />
            {qr && <button type="button" className="btn small ghost" disabled={busy} onClick={() => void removeQr()}><Trash2 size={16} /> Remove</button>}
          </div>
        </div>
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <div className="field"><span>Customers see</span>
        <label className="check-row" style={{ padding: 0 }}>
          <input type="radio" name="upi_mode" data-testid="upi-mode-amount" checked={f.upi_mode === 'amount'} onChange={() => onChange({ upi_mode: 'amount' })} />
          <span className="grow">A QR with the exact bill amount <span className="badge ok">Recommended</span>
            <span className="muted" style={{ display: 'block', fontSize: 'var(--t-sm)' }}>Made from your UPI ID. The amount is filled in, so no typing mistakes.</span></span>
        </label>
        <label className="check-row" style={{ padding: 0 }}>
          <input type="radio" name="upi_mode" data-testid="upi-mode-own" disabled={!centre.upi_qr_path} checked={f.upi_mode === 'own'} onChange={() => onChange({ upi_mode: 'own' })} />
          <span className="grow">My uploaded QR
            <span className="muted" style={{ display: 'block', fontSize: 'var(--t-sm)' }}>{centre.upi_qr_path ? 'Customers type the amount, shown big next to the QR.' : 'Upload your QR first.'}</span></span>
        </label>
      </div>
    </div>
  );
}

/** The signed-in person's own photo (sidebar, Team list). */
export function MyPhoto() {
  const { centre, me } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const url = mediaUrl(me.avatar_path);
  const put = async (file: File | null) => {
    setBusy(true); setErr(null);
    try {
      const { data } = await supabase.auth.getUser();
      const uid = data.user?.id;
      if (!uid) throw new Error('Sign in again');
      const path = file ? await uploadMedia(`${centre.id}/staff/${uid}`, 'me', await fitImage(file, FITS.avatar)) : null;
      const { error } = await supabase.rpc('set_my_avatar', { p_centre: centre.id, p_path: path });
      if (error) { await removeMedia(path); throw error; }
      await removeMedia(me.avatar_path);
      await qc.invalidateQueries({ queryKey: ['centre'] });
      await qc.invalidateQueries({ queryKey: ['team'] });
      toast(file ? 'Photo saved' : 'Photo removed');
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <div className="stack" data-testid="my-photo">
      <div className="row" style={{ gap: 'var(--s-4)' }}>
        <Avatar name={me.display_name} path={me.avatar_path} color={me.color} size={64} />
        <div className="stack">
          <b>{me.display_name}</b>
          <div className="row wrap">
            <PickButton label={url ? 'Change photo' : 'Add photo'} testid="my-photo-file" busy={busy} onPick={(f) => void put(f)} icon={<Camera size={16} />} />
            {url && <button type="button" className="btn small ghost" disabled={busy} onClick={() => void put(null)}><Trash2 size={16} /> Remove</button>}
          </div>
        </div>
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
    </div>
  );
}

/** Round photo, or initials on the person's colour. */
export function Avatar({ name, path, color, size = 32 }: { name: string; path?: string | null; color?: string | null; size?: number }) {
  const url = mediaUrl(path);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';
  return url
    ? <img className="avatar" src={url} alt={name} width={size} height={size} style={{ width: size, height: size, objectFit: 'cover' }} />
    : <span className="avatar" style={{ width: size, height: size, ...(color ? { background: color, color: '#fff' } : {}), fontSize: size * 0.4 }} aria-hidden>{initials}</span>;
}
