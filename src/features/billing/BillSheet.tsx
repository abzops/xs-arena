// The bill for a group (tab): games priced live, snacks, customer, discount, split payments, UPI QR, close.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Minus, Plus, Trash2, UserPlus } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useCentre } from '../../app/centre';
import { Field, Loading, Notice, Segmented, Sheet, useToast } from '../../components/ui';
import { formatTime } from '../../lib/dates';
import { errorMessage } from '../../lib/errors';
import { minutesLabel } from '../../lib/floor';
import { upiLink } from '../../lib/messages';
import { formatINR, paiseToInput, parseINR } from '../../lib/money';
import { rpc, supabase } from '../../lib/supabase';
import type { Product } from '../../lib/types';
import '../floor/floor.css';

export type TabPreview = {
  tab_id: string; status: string; customer: { id: string; name: string; phone: string } | null; opened_at: string; live: boolean;
  games: { session_id: string; resource: string; activity: string; minutes: number; started_at: string; ended_at: string | null; status: string;
    players: number; lines: { label: string; amount_paise: number; overtime?: boolean }[]; amount_paise: number }[];
  items: { id: string; name: string; qty: number; unit_price_paise: number; total_paise: number }[];
  subtotal_paise: number; gst_enabled: boolean; gst_rate_bp: number; prices_include_tax: boolean;
};

type PayMode = 'cash' | 'upi' | 'card' | 'split';

export function useTabPreview(tabId: string | null) {
  const { centre } = useCentre();
  return useQuery({
    queryKey: ['tab', centre.id, tabId],
    enabled: !!tabId,
    queryFn: () => rpc<TabPreview>('tab_preview', { p_centre: centre.id, p_tab: tabId }),
    refetchInterval: 15_000,
  });
}

export type Reward = { id: string; name: string; points: number; value_paise: number; affordable?: boolean };
export type Tier = { name: string; min_points: number; multiplier: number };
export type Points = { enabled: boolean; balance: number; value_paise: number; point_value_paise: number; min_redeem: number; usable: number;
  lifetime?: number; tier?: Tier | null; next_tier?: Tier | null; rewards?: Reward[];
  next_expiry: string | null; history: { points: number; kind: string; note: string | null; at: string }[] };

/** A customer's loyalty points; `billPaise` limits how many can be used on this bill. */
export function usePoints(customerId: string | null, billPaise?: number) {
  const { centre, hasFeature } = useCentre();
  const q = useQuery({
    queryKey: ['points', centre.id, customerId, billPaise ?? null],
    enabled: !!customerId && hasFeature('loyalty'),
    queryFn: () => rpc<Points>('customer_points', { p_centre: centre.id, p_customer: customerId, p_bill_paise: billPaise ?? null }),
    placeholderData: (prev) => prev,
  });
  return q.data ?? null;
}

export function BillSheet({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const { centre, can } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const tab = useTabPreview(tabId);
  const [key] = useState(() => crypto.randomUUID());
  const [mode, setMode] = useState<PayMode>('cash');
  const [discount, setDiscount] = useState('');
  const [reason, setReason] = useState('');
  const [split, setSplit] = useState({ cash: '', upi: '', card: '' });
  const [received, setReceived] = useState('');
  const [snacks, setSnacks] = useState(false);
  const [custom, setCustom] = useState(false);
  const [cust, setCust] = useState(false);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['tab', centre.id, tabId] }), qc.invalidateQueries({ queryKey: ['floor', centre.id] })]);

  const products = useQuery({
    queryKey: ['products', centre.id, 'sale'],
    queryFn: async () => {
      const { data, error } = await supabase.from('products').select('*').eq('centre_id', centre.id).eq('status', 'active').eq('kind', 'retail').order('name');
      if (error) throw error;
      return data as Product[];
    },
  });
  const addItem = useMutation({
    mutationFn: (a: { product?: string; name?: string; price?: number; qty?: number }) => rpc('tab_add_item', {
      p_centre: centre.id, p_tab: tabId, p_product: a.product ?? null, p_qty: a.qty ?? 1, p_name: a.name ?? null, p_price_paise: a.price ?? null,
    }),
    onSuccess: refresh,
  });
  const removeItem = useMutation({ mutationFn: (id: string) => rpc('tab_remove_item', { p_centre: centre.id, p_item: id }), onSuccess: refresh });

  const t = tab.data;
  const sub = t?.subtotal_paise ?? 0;
  const disc = discount ? parseINR(discount) ?? -1 : 0;
  const pts = usePoints(t?.customer?.id ?? null, Math.max(0, sub - Math.max(0, disc)));
  const [usePts, setUsePts] = useState(false);
  const [rewardId, setRewardId] = useState<string | null>(null);
  const reward = pts?.enabled ? pts.rewards?.find((r) => r.id === rewardId && r.affordable) ?? null : null;
  const ptsUsed = reward ? reward.points : usePts && pts?.enabled && pts.usable > 0 ? pts.usable : 0;
  const ptsPaise = reward ? Math.min(reward.value_paise, Math.max(0, sub - Math.max(0, disc))) : ptsUsed * (pts?.point_value_paise ?? 0);
  const net = Math.max(0, sub - Math.max(0, disc) - ptsPaise);
  const tax = !t?.gst_enabled ? 0 : t.prices_include_tax ? Math.round((net * t.gst_rate_bp) / (10000 + t.gst_rate_bp)) : Math.round((net * t.gst_rate_bp) / 10000);
  const total = t?.gst_enabled && !t.prices_include_tax ? net + tax : net;
  const payments = useMemo(() => {
    if (mode === 'split') return (['cash', 'upi', 'card'] as const).map((m) => ({ method: m, amount_paise: parseINR(split[m]) ?? 0 })).filter((p) => p.amount_paise > 0);
    return [{ method: mode, amount_paise: total }];
  }, [mode, split, total]);
  const paying = payments.reduce((a, p) => a + p.amount_paise, 0);
  const cashGiven = parseINR(received) ?? 0;

  const close = useMutation({
    mutationFn: () => rpc<{ bill_id: string; bill_no: string; points_earned?: number }>('close_tab', {
      p_centre: centre.id, p_tab: tabId, p_discount_paise: Math.max(0, disc), p_discount_reason: reason || null, p_payments: payments, p_key: key,
      p_points: reward ? 0 : ptsUsed, p_reward: reward?.id ?? null,
    }),
    onSuccess: async (b) => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['floor', centre.id] }), qc.invalidateQueries({ queryKey: ['dashboard', centre.id] }),
        qc.invalidateQueries({ queryKey: ['bills', centre.id] }), qc.invalidateQueries({ queryKey: ['products', centre.id] })]);
      toast(`Bill ${b.bill_no} saved${b.points_earned ? ` · +${b.points_earned} points` : ''}`);
      onClose();
      navigate(`/s/${centre.slug}/bills/${b.bill_id}`);
    },
  });

  // Closing without collecting keeps the bill open — say so, so it isn't forgotten.
  const leave = () => {
    if (!close.isSuccess && total > 0) toast(`${formatINR(total)} not collected yet — it's waiting in Open bills`);
    onClose();
  };

  return (
    <Sheet title="Bill" onClose={leave}>
      {tab.isPending ? <Loading rows={4} /> : tab.error ? <Notice tone="bad">{errorMessage(tab.error)}</Notice> : t && (
        <div className="stack lg">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>{t.customer ? <><b>{t.customer.name}</b> <span className="muted">{t.customer.phone}</span></> : <span className="muted">Walk-in</span>}</span>
            {can('customers.manage') && <button className="btn small ghost" onClick={() => setCust(true)}><UserPlus size={16} /> {t.customer ? 'Change' : 'Add customer'}</button>}
          </div>
          {t.live && <Notice tone="info">Games still running are priced up to now. Closing the bill stops their timers.</Notice>}

          <div className="bill-lines">
            {t.games.map((g) => (
              <div key={g.session_id} className="bill-line">
                <span className="stack" style={{ gap: 2 }}>
                  <b>{g.resource}</b>
                  <span className="sub">{formatTime(g.started_at, centre.timezone)} → {g.ended_at ? formatTime(g.ended_at, centre.timezone) : 'now'} · {minutesLabel(g.minutes)}{g.players > 1 ? ` · ${g.players} players` : ''}</span>
                  {g.lines.map((l, i) => <span key={i} className="sub">{l.label} · {formatINR(l.amount_paise)}</span>)}
                </span>
                <b className="num">{formatINR(g.amount_paise)}</b>
              </div>
            ))}
            {t.items.map((i) => (
              <div key={i.id} className="bill-line">
                <span>{i.name} <span className="muted">× {Number(i.qty)}</span></span>
                <span className="row" style={{ gap: 8 }}>
                  <b className="num">{formatINR(i.total_paise)}</b>
                  <button className="btn small ghost icon-btn" aria-label={`Remove ${i.name}`} disabled={removeItem.isPending} onClick={() => removeItem.mutate(i.id)}><Trash2 size={15} /></button>
                </span>
              </div>
            ))}
            {!t.games.length && !t.items.length && <p className="muted">Nothing on this bill yet.</p>}
          </div>

          <div className="row">
            <button className="btn small" onClick={() => setSnacks((v) => !v)}><Plus size={16} /> Snacks & drinks</button>
            <button className="btn small ghost" onClick={() => setCustom(true)}><Plus size={16} /> Other item</button>
          </div>
          {snacks && (
            <div className="snack-grid">
              {(products.data ?? []).map((p) => (
                <button key={p.id} className="btn" disabled={addItem.isPending} onClick={() => addItem.mutate({ product: p.id })}>
                  <b>{p.name}</b><span className="muted num">{formatINR(p.price_paise)}{Number(p.stock_qty) <= Number(p.reorder_level) ? ` · ${Number(p.stock_qty)} left` : ''}</span>
                </button>
              ))}
              {products.data?.length === 0 && <p className="muted">Add snacks in Snacks & stock first.</p>}
            </div>
          )}
          {addItem.error && <Notice tone="bad">{errorMessage(addItem.error)}</Notice>}

          {can('billing.discount') && (
            <div className="grid-2">
              <Field label="Discount (₹)" error={disc < 0 ? 'Enter a valid amount' : disc > sub ? 'More than the bill' : null}>
                <input className="input num" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0" /></Field>
              {disc > 0 && <Field label="Reason (required)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Regular customer" /></Field>}
            </div>
          )}

          {pts?.enabled && t.customer && (
            <div className="points-box">
              <span><b className="num">{pts.balance}</b> points <span className="muted">· worth {formatINR(pts.value_paise)}</span>
                {pts.tier && <span className="tier-badge">{pts.tier.name}</span>}</span>
              {!!pts.rewards?.length && (
                <div className="chips">{pts.rewards.map((r) => (
                  <button key={r.id} type="button" className="chip" disabled={!r.affordable} aria-pressed={rewardId === r.id}
                    onClick={() => { setRewardId(rewardId === r.id ? null : r.id); setUsePts(false); }}>
                    🎁 {r.name} · {r.points} pts</button>
                ))}</div>
              )}
              {pts.usable > 0 ? (
                <label className="check-row" style={{ padding: 0, minHeight: 0 }}>
                  <input type="checkbox" checked={usePts && !reward} onChange={(e) => { setUsePts(e.target.checked); if (e.target.checked) setRewardId(null); }} />
                  <span>Use {pts.usable} points (−{formatINR(pts.usable * pts.point_value_paise)})</span></label>
              ) : <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>{pts.balance < pts.min_redeem ? `Can use from ${pts.min_redeem} points` : 'Not usable on this bill'}</span>}
            </div>
          )}

          <div className="stack" style={{ gap: 4 }}>
            <div className="bill-line" style={{ border: 0, padding: '2px 0' }}><span className="muted">Subtotal</span><span className="num">{formatINR(sub)}</span></div>
            {disc > 0 && <div className="bill-line" style={{ border: 0, padding: '2px 0' }}><span className="muted">Discount</span><span className="num">−{formatINR(disc)}</span></div>}
            {ptsPaise > 0 && <div className="bill-line" style={{ border: 0, padding: '2px 0' }}><span className="muted">{reward ? `🎁 ${reward.name} (${ptsUsed} pts)` : `Points (${ptsUsed})`}</span><span className="num">−{formatINR(ptsPaise)}</span></div>}
            {tax > 0 && <div className="bill-line" style={{ border: 0, padding: '2px 0' }}><span className="muted">GST {t.gst_rate_bp / 100}%{t.prices_include_tax ? ' (included)' : ''}</span><span className="num">{formatINR(tax)}</span></div>}
            <div className="bill-total"><span>Total</span><span className="num">{formatINR(total)}</span></div>
          </div>

          <Segmented label="Payment" value={mode} onChange={setMode} options={[
            { value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'card', label: 'Card' }, { value: 'split', label: 'Split' }]} />
          {mode === 'cash' && total > 0 && (
            <Field label="Cash received (optional)" hint={cashGiven > total ? `Give back ${formatINR(cashGiven - total)}` : undefined}>
              <input className="input num" inputMode="decimal" value={received} onChange={(e) => setReceived(e.target.value)} placeholder={paiseToInput(total)} /></Field>
          )}
          {mode === 'upi' && total > 0 && <UpiQr amount={total} note={`${centre.name} bill`} />}
          {mode === 'split' && (
            <div className="stack">
              {(['cash', 'upi', 'card'] as const).map((m) => (
                <div key={m} className="pay-row">
                  <span style={{ textTransform: 'capitalize' }}>{m === 'upi' ? 'UPI' : m}</span>
                  <input className="input num" inputMode="decimal" value={split[m]} onChange={(e) => setSplit({ ...split, [m]: e.target.value })} placeholder="0" />
                  <button className="btn small ghost" onClick={() => setSplit({ ...split, [m]: paiseToInput(Math.max(0, total - (paying - (parseINR(split[m]) ?? 0)))) })}>Rest</button>
                </div>
              ))}
              <span className={`muted ${paying !== total ? 'tone-warn' : ''}`} style={{ fontSize: 'var(--t-sm)' }}>
                {paying < total ? `${formatINR(total - paying)} will be saved as due` : paying > total ? `${formatINR(paying - total)} too much` : 'Fully paid'}</span>
              {(parseINR(split.upi) ?? 0) > 0 && <UpiQr amount={parseINR(split.upi)!} note={`${centre.name} bill`} />}
            </div>
          )}

          {close.error && <Notice tone="bad">{errorMessage(close.error)}</Notice>}
          <div className="bill-cta">
          <button className="btn primary block xl" disabled={close.isPending || (!t.games.length && !t.items.length) || disc < 0 || disc > sub || (disc > 0 && !reason.trim()) || paying > total}
            onClick={() => close.mutate()}>
            {close.isPending ? <span className="spinner" /> : mode === 'upi' ? `UPI received · close ${formatINR(total)}` : `Close bill · ${formatINR(total)}`}
          </button>
          </div>
        </div>
      )}
      {custom && <CustomItemSheet onClose={() => setCustom(false)} onAdd={(name, price, qty) => addItem.mutateAsync({ name, price, qty }).then(() => setCustom(false))} />}
      {cust && t && <AttachCustomerSheet tabId={tabId} onClose={() => setCust(false)} onDone={refresh} />}
    </Sheet>
  );
}

/** UPI QR with the exact amount; the customer scans it with any UPI app. */
export function UpiQr({ amount, note }: { amount: number; note: string }) {
  const { centre } = useCentre();
  const [svg, setSvg] = useState('');
  const link = centre.upi_id ? upiLink(centre.upi_id, centre.name, amount, note) : null;
  useEffect(() => {
    if (!link) return;
    let live = true;
    QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then((s) => { if (live) setSvg(s); });
    return () => { live = false; };
  }, [link]);
  if (!link) return <Notice tone="warn">Add your UPI ID in Settings to show a payment QR with the exact amount.</Notice>;
  return (
    <div className="qr-box">
      <div aria-label={`UPI QR code for ${formatINR(amount)}`} role="img" dangerouslySetInnerHTML={{ __html: svg }} />
      <b className="num">{formatINR(amount)}</b>
      <span style={{ fontSize: 'var(--t-sm)' }}>{centre.upi_id} · scan with any UPI app</span>
    </div>
  );
}

function CustomItemSheet({ onClose, onAdd }: { onClose: () => void; onAdd: (name: string, price: number, qty: number) => Promise<unknown> }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState(1);
  const [err, setErr] = useState<string | null>(null);
  const p = parseINR(price);
  return (
    <Sheet title="Other item" onClose={onClose}>
      <form className="stack lg" onSubmit={(e) => { e.preventDefault(); if (p) onAdd(name.trim(), p, qty).catch((x) => setErr(errorMessage(x))); }}>
        <Field label="Item"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Extra controller, cue rental…" autoFocus /></Field>
        <div className="grid-2">
          <Field label="Price (₹)"><input className="input num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
          <div className="field"><span>Quantity</span><div className="row">
            <button type="button" className="btn small icon-btn" onClick={() => setQty(Math.max(1, qty - 1))} aria-label="Less"><Minus size={16} /></button>
            <b className="num">{qty}</b>
            <button type="button" className="btn small icon-btn" onClick={() => setQty(qty + 1)} aria-label="More"><Plus size={16} /></button></div></div>
        </div>
        {err && <Notice tone="bad">{err}</Notice>}
        <button className="btn primary block xl" disabled={!name.trim() || !p}>Add to bill</button>
      </form>
    </Sheet>
  );
}

function AttachCustomerSheet({ tabId, onClose, onDone }: { tabId: string; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { centre } = useCentre();
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const known = useKnownCustomer(phone);
  const save = useMutation({
    mutationFn: () => rpc('tab_set_customer', { p_centre: centre.id, p_tab: tabId, p_phone: phone, p_name: name || known?.full_name || null }),
    onSuccess: async () => { await onDone(); onClose(); },
  });
  return (
    <Sheet title="Customer" onClose={onClose}>
      <form className="stack lg" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Mobile number" hint={known ? `${known.full_name} · ${known.visit_count} visits` : undefined}>
          <input className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoFocus /></Field>
        {!known && <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>}
        {save.error && <Notice tone="bad">{errorMessage(save.error)}</Notice>}
        <button className="btn primary block xl" disabled={phone.replace(/\D/g, '').length < 10 || save.isPending}>Save</button>
      </form>
    </Sheet>
  );
}

/** Looks a customer up by the last 10 digits once a full number is typed. */
export function useKnownCustomer(phone: string) {
  const { centre } = useCentre();
  const digits = phone.replace(/\D/g, '').slice(-10);
  const q = useQuery({
    queryKey: ['customer-by-phone', centre.id, digits],
    enabled: digits.length === 10,
    queryFn: async () => {
      const { data } = await supabase.from('customers').select('id, full_name, phone, visit_count').eq('centre_id', centre.id).like('phone', `%${digits}`).limit(1);
      return (data?.[0] ?? null) as { id: string; full_name: string; phone: string; visit_count: number } | null;
    },
  });
  return digits.length === 10 ? q.data ?? null : null;
}
