import { BookingSettings } from '../booking/BookingSettings';
import { LoyaltySettings } from '../loyalty/Loyalty';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { useState } from 'react';
import { useCentre } from '../../app/centre';
import { AppearanceControl } from '../../components/Appearance';
import { Field, Notice, useToast } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { supabase } from '../../lib/supabase';
import { PLAN_LABEL, ROLE_LABEL } from '../../lib/types';
import { AlertSettings } from '../floor/FloorPage';
import { TvSettings } from '../tv/TvSettings';
import { Link } from 'react-router';

export function SettingsPage() {
  const { centre, can, role, plan, subscription } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const owner = can('settings.manage');
  const [f, setF] = useState({
    name: centre.name, phone: centre.phone ?? '', email: centre.email ?? '', address: centre.address ?? '', city: centre.city ?? '',
    open_time: centre.open_time.slice(0, 5), close_time: centre.close_time.slice(0, 5), upi_id: centre.upi_id ?? '', gst_enabled: centre.gst_enabled, gstin: centre.gstin ?? '',
    gst_pct: String(centre.gst_rate_bp / 100), prices_include_tax: centre.prices_include_tax, invoice_prefix: centre.invoice_prefix,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const save = useMutation({
    mutationFn: async () => {
      if (f.gst_enabled && f.gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(f.gstin.toUpperCase())) throw new Error('GSTIN looks invalid');
      if (f.close_time === f.open_time) throw new Error('Opening and closing time cannot be the same');
      if (f.upi_id && !/^[A-Za-z0-9._-]{2,64}@[A-Za-z0-9.-]{2,64}$/.test(f.upi_id.trim())) throw new Error('UPI ID looks invalid (example: arena@okicici)');
      const { error } = await supabase.from('centres').update({
        name: f.name.trim(), phone: f.phone || null, email: f.email || null, address: f.address || null, city: f.city || null,
        open_time: f.open_time, close_time: f.close_time, upi_id: f.upi_id.trim() || null, gst_enabled: f.gst_enabled, gstin: f.gstin ? f.gstin.toUpperCase() : null,
        gst_rate_bp: Math.round(Number(f.gst_pct) * 100), prices_include_tax: f.prices_include_tax,
        invoice_prefix: f.invoice_prefix.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'INV', updated_at: new Date().toISOString(),
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

      <section className="card row" style={{ justifyContent: 'space-between' }}>
        <div><h2>Plan</h2><p className="muted" style={{ fontSize: 'var(--t-sm)' }}>
          XS Arena {PLAN_LABEL[plan]}{subscription?.status === 'trialing' ? ` · free trial until ${new Date(subscription.trial_ends_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : ''}</p></div>
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
          <section className="card stack lg">
            <h2>Hours and payments</h2>
            <div className="grid-2">
              <Field label="Opens"><input className="input" type="time" value={f.open_time} onChange={set('open_time')} /></Field>
              <Field label="Closes"><input className="input" type="time" value={f.close_time} onChange={set('close_time')} /></Field>
            </div>
            <Field label="UPI ID for payment QR" hint="Customers scan a QR with the exact bill amount. Example: arena@okicici">
              <input className="input" value={f.upi_id} onChange={set('upi_id')} placeholder="yourcentre@okaxis" autoCapitalize="none" /></Field>
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
            <Field label="Bill number prefix" hint={`Next bill: ${(f.invoice_prefix || 'INV').toUpperCase()}-YYMM-${String(centre.invoice_seq + 1).padStart(4, '0')}`}>
              <input className="input" style={{ maxWidth: 180 }} value={f.invoice_prefix} onChange={set('invoice_prefix')} /></Field>
          </section>
          {save.error && <Notice tone="bad">{errorMessage(save.error)}</Notice>}
          <button className="btn primary block xl" disabled={save.isPending || f.name.trim().length < 2} onClick={() => save.mutate()}>Save settings</button>
        </>
      ) : <Notice tone="info">Only the centre owner can change centre settings. You are signed in as {ROLE_LABEL[role]}.</Notice>}

      <section className="card row" style={{ justifyContent: 'space-between' }}>
        <div><h2>Account</h2><p className="muted" style={{ fontSize: 'var(--t-sm)' }}>XS Arena by Xelorsoft · support@xelorsoft.com</p></div>
        <button className="btn" onClick={() => supabase.auth.signOut()}><LogOut size={18} /> Sign out</button>
      </section>
    </div>
  );
}
