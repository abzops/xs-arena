import { BookingSettings } from '../booking/BookingSettings';
import { LoyaltySettings } from '../loyalty/Loyalty';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useCentre } from '../../app/centre';
import { AppearanceControl } from '../../components/Appearance';
import { Field, Notice, useToast } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { rpc, supabase } from '../../lib/supabase';
import { PLAN_LABEL, ROLE_LABEL } from '../../lib/types';
import { AlertSettings } from '../floor/FloorPage';
import { TvSettings } from '../tv/TvSettings';
import { MyPhoto, ProfilePictures, UpiSetup } from './CentreProfile';
import { Link } from 'react-router';

/** Snacks & stock is free during the pilot: the owner turns it on with one tap. */
function FreeAddonButton() {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const on = useMutation({
    mutationFn: () => rpc('claim_free_addon', { p_centre: centre.id, p_addon: 'snacks' }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['centre'] }); toast('Snacks & stock is on — free during the pilot'); },
    onError: (e) => toast(errorMessage(e)),
  });
  return <button type="button" className="btn small primary" data-testid="addon-snacks" disabled={on.isPending} onClick={() => on.mutate()}>Turn on · free during pilot</button>;
}

export function SettingsPage() {
  useEffect(() => { if (window.location.hash === '#my-profile') document.getElementById('my-profile')?.scrollIntoView({ block: 'center' }); }, []);
  const { centre, can, role, plan, subscription, hasFeature } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const owner = can('settings.manage');
  const [f, setF] = useState({
    name: centre.name, phone: centre.phone ?? '', email: centre.email ?? '', address: centre.address ?? '', city: centre.city ?? '',
    open_time: centre.open_time.slice(0, 5), close_time: centre.close_time.slice(0, 5), upi_id: centre.upi_id ?? '', gst_enabled: centre.gst_enabled, gstin: centre.gstin ?? '',
    gst_pct: String(centre.gst_rate_bp / 100), prices_include_tax: centre.prices_include_tax, invoice_prefix: centre.invoice_prefix,
    require_customer: centre.require_customer,
    about: centre.about ?? '', maps_url: centre.maps_url ?? '', instagram: centre.instagram ?? '',
    upi_payee: centre.upi_payee ?? '', upi_mode: centre.upi_mode ?? 'amount',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const save = useMutation({
    mutationFn: async () => {
      if (f.gst_enabled && f.gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(f.gstin.toUpperCase())) throw new Error('GSTIN looks invalid');
      if (f.close_time === f.open_time) throw new Error('Opening and closing time cannot be the same');
      if (f.upi_id && !/^[A-Za-z0-9._-]{2,64}@[A-Za-z0-9.-]{2,64}$/.test(f.upi_id.trim())) throw new Error('UPI ID looks invalid (example: arena@okicici)');
      if (f.upi_mode === 'amount' && !f.upi_id.trim() && centre.upi_qr_path) throw new Error('Add your UPI ID for exact-amount QRs, or choose "My uploaded QR"');
      const maps = f.maps_url.trim();
      if (maps && !/^https:\/\/\S+$/.test(maps)) throw new Error('Google Maps link should start with https://');
      const insta = f.instagram.trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/\/.*$/, '');
      if (insta && !/^[A-Za-z0-9._]{1,30}$/.test(insta)) throw new Error('Instagram name looks invalid (example: xsarena.kochi)');
      const { error } = await supabase.from('centres').update({
        name: f.name.trim(), phone: f.phone || null, email: f.email || null, address: f.address || null, city: f.city || null,
        open_time: f.open_time, close_time: f.close_time, upi_id: f.upi_id.trim() || null, gst_enabled: f.gst_enabled, gstin: f.gstin ? f.gstin.toUpperCase() : null,
        gst_rate_bp: Math.round(Number(f.gst_pct) * 100), prices_include_tax: f.prices_include_tax,
        invoice_prefix: f.invoice_prefix.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'INV', require_customer: f.require_customer,
        about: f.about.trim().slice(0, 300) || null, maps_url: maps || null, instagram: insta || null,
        upi_payee: f.upi_payee.trim().slice(0, 60) || null, upi_mode: f.upi_mode === 'own' && centre.upi_qr_path ? 'own' : 'amount',
        updated_at: new Date().toISOString(),
      }).eq('id', centre.id);
      if (error) throw error;
    },
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['centre'] }); toast('Settings saved'); },
  });

  return (
    <div className="stack xl">
      <div className="page-head"><h1>Settings</h1></div>

      <div className="card appearance-row"><h2>Appearance</h2><AppearanceControl /></div>

      <section className="card stack">
        <h2>Alerts on this device</h2>
        <AlertSettings />
      </section>

      {owner && (
        <section className="card row" style={{ justifyContent: 'space-between' }}>
          <div><h2>Floor & prices</h2><p className="muted" style={{ fontSize: 'var(--t-sm)' }}>Draw your hall, place tables, consoles and tracks, and set prices.</p></div>
          <div className="row"><Link className="btn" to={`/s/${centre.slug}/designer`}>Floor designer</Link><Link className="btn" to={`/s/${centre.slug}/prices`}>Prices</Link></div>
        </section>
      )}
      {owner && <BookingSettings />}
      {can('loyalty.manage') && <LoyaltySettings />}
      {owner && <TvSettings />}

      <section className="card stack" data-testid="plan-card">
        <div><h2>Plan</h2><p className="muted" style={{ fontSize: 'var(--t-sm)' }}>
          XS Arena {PLAN_LABEL[plan]}{subscription?.status === 'trialing' ? ` · free trial until ${new Date(subscription.trial_ends_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : ''}</p></div>
        <div className="addon-row">
          <div><b>Snacks & stock add-on</b>
            <p className="muted" style={{ margin: 0, fontSize: 'var(--t-sm)' }}>Sell snacks and drinks on the bill, track stock and get low-stock alerts.</p></div>
          {hasFeature('snacks')
            ? <span className="badge ok" data-testid="addon-snacks">On</span>
            : owner
              ? <FreeAddonButton />
              : <span className="badge neutral" data-testid="addon-snacks">Off</span>}
        </div>
      </section>

      {owner ? (
        <>
          <section className="card stack lg">
            <h2>Centre</h2>
            <div className="grid-2">
              <Field label="Name"><input className="input" value={f.name} onChange={set('name')} /></Field>
              <Field label="Phone"><input className="input" inputMode="tel" value={f.phone} onChange={set('phone')} /></Field>
            </div>
            <div className="grid-2">
              <Field label="Address"><input className="input" value={f.address} onChange={set('address')} /></Field>
              <Field label="City"><input className="input" value={f.city} onChange={set('city')} /></Field>
            </div>
            <Field label="Email"><input className="input" type="email" value={f.email} onChange={set('email')} /></Field>
          </section>
          <section className="card stack lg" data-guide="profile">
            <h2>Centre profile</h2>
            <ProfilePictures />
            <Field label="About your centre" hint={`${f.about.length}/300 · shown on your booking page`}>
              <textarea className="input" rows={3} maxLength={300} value={f.about} data-testid="about" onChange={set('about')}
                placeholder="4 snooker tables, 6 PS5s and an RC track. Open till midnight." /></Field>
            <div className="grid-2">
              <Field label="Google Maps link"><input className="input" inputMode="url" value={f.maps_url} data-testid="maps-url" onChange={set('maps_url')} placeholder="https://maps.app.goo.gl/…" /></Field>
              <Field label="Instagram"><input className="input" value={f.instagram} data-testid="instagram" onChange={set('instagram')} placeholder="xsarena.kochi" autoCapitalize="none" /></Field>
            </div>
          </section>
          <section className="card stack lg">
            <h2>Customers</h2>
            <label className="check-row" style={{ padding: 0 }}>
              <input type="checkbox" checked={f.require_customer} data-testid="require-customer" onChange={(e) => setF({ ...f, require_customer: e.target.checked })} />
              <span className="grow">Ask every new customer for name and mobile
                <span className="muted" style={{ display: 'block', fontSize: 'var(--t-sm)' }}>Staff can't start a game or add someone to the waiting list without them. Builds your customer list for offers.</span></span>
            </label>
          </section>
          <section className="card stack lg">
            <h2>Hours and payments</h2>
            <div className="grid-2">
              <Field label="Opens"><input className="input" type="time" value={f.open_time} onChange={set('open_time')} /></Field>
              <Field label="Closes"><input className="input" type="time" value={f.close_time} onChange={set('close_time')} /></Field>
            </div>
            <UpiSetup f={f} onChange={(p) => setF((cur) => ({ ...cur, ...p }))} />
            <div className="grid-2">
              <Field label="UPI ID" hint="Filled in from your QR. Example: arena@okicici">
                <input className="input" value={f.upi_id} data-testid="upi-id" onChange={set('upi_id')} placeholder="yourcentre@okaxis" autoCapitalize="none" /></Field>
              <Field label="Name customers see when paying" hint="Leave empty to use your centre name">
                <input className="input" value={f.upi_payee} data-testid="upi-payee" onChange={set('upi_payee')} placeholder={centre.name} /></Field>
            </div>
          </section>
          <section className="card stack lg">
            <h2>GST and bills</h2>
            <label className="check-row" style={{ padding: 0 }}><input type="checkbox" checked={f.gst_enabled} onChange={(e) => setF({ ...f, gst_enabled: e.target.checked })} />
              <span className="grow">Charge GST on bills</span></label>
            {f.gst_enabled && (
              <div className="grid-2">
                <Field label="GSTIN"><input className="input" value={f.gstin} onChange={set('gstin')} placeholder="32ABCDE1234F1Z5" /></Field>
                <Field label="Rate"><select className="input" value={f.gst_pct} onChange={set('gst_pct')}>{['5', '12', '18', '28'].map((r) => <option key={r} value={r}>{r}%</option>)}</select></Field>
                <Field label="Menu prices"><select className="input" value={f.prices_include_tax ? '1' : '0'} onChange={(e) => setF({ ...f, prices_include_tax: e.target.value === '1' })}>
                  <option value="1">Include GST</option><option value="0">Exclude GST (added on bill)</option></select></Field>
              </div>
            )}
            <Field label="Bill number prefix" hint={`Next bill: ${(f.invoice_prefix || 'INV').toUpperCase()}-${new Date().toISOString().slice(2, 4)}${new Date().toISOString().slice(5, 7)}-${String(centre.invoice_seq + 1).padStart(4, '0')}`}>
              <input className="input" style={{ maxWidth: 180 }} value={f.invoice_prefix} onChange={set('invoice_prefix')} /></Field>
          </section>
          {save.error && <Notice tone="bad">{errorMessage(save.error)}</Notice>}
          <button className="btn primary block xl" disabled={save.isPending || f.name.trim().length < 2} onClick={() => save.mutate()}>Save settings</button>
        </>
      ) : <Notice tone="info">Only the centre owner can change centre settings. You are signed in as {ROLE_LABEL[role]}.</Notice>}

      <section className="card stack" id="my-profile" data-testid="my-profile"><h2>My profile</h2><MyPhoto /></section>

      <section className="card row" style={{ justifyContent: 'space-between' }}>
        <div><h2>Account</h2><p className="muted" style={{ fontSize: 'var(--t-sm)' }}>XS Arena by Xelorsoft · support@xelorsoft.com</p></div>
        <button className="btn" onClick={() => supabase.auth.signOut()}><LogOut size={18} /> Sign out</button>
      </section>
    </div>
  );
}
