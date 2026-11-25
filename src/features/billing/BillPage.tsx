// A closed bill: receipt with in/out times, print, WhatsApp, collect dues, void.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router';
import { useCentre } from '../../app/centre';
import { ReasonSheet, WhatsAppPairButton } from '../../components/centre';
import { BackLink, Empty, Field, Loading, Notice, Segmented, Sheet, StatusBadge, useToast } from '../../components/ui';
import { formatDateTime, formatTime } from '../../lib/dates';
import { errorMessage } from '../../lib/errors';
import { minutesLabel } from '../../lib/floor';
import { msgReceipt, upiLink, type ReceiptGame, type ReceiptItem } from '../../lib/messages';
import { formatINR, paiseToInput, parseINR } from '../../lib/money';
import { rpc, supabase } from '../../lib/supabase';
import { METHOD_LABEL, type Method } from '../../lib/types';
import { UpiQr, usePoints } from './BillSheet';
import '../floor/floor.css';

type Bill = {
  id: string; bill_no: string; created_at: string; status: string; subtotal_paise: number; discount_paise: number; discount_reason: string | null;
  tax_paise: number; gst_rate_bp: number; total_paise: number; paid_paise: number; void_reason: string | null; points_redeemed: number; points_paise: number; share_token?: string | null;
  lines: { games: (ReceiptGame & { players: number })[]; items: (ReceiptItem & { unit_price_paise: number })[] };
  customers: { id: string; full_name: string; phone: string } | null;
  payments: { id: string; method: Method; amount_paise: number; status: string; created_at: string }[];
};

export function BillPage() {
  const { billId = '' } = useParams();
  const { centre, can } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const [paying, setPaying] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const bill = useQuery({
    queryKey: ['bill', centre.id, billId],
    queryFn: async () => {
      const { data, error } = await supabase.from('bills').select('*, customers(id, full_name, phone), payments(id, method, amount_paise, status, created_at)').eq('id', billId).maybeSingle();
      if (error) throw error;
      return data as Bill | null;
    },
  });
  const earned = useQuery({
    queryKey: ['bill-points', centre.id, billId],
    queryFn: async () => {
      const { data, error } = await supabase.from('loyalty_ledger').select('points, kind').eq('bill_id', billId);
      if (error) throw error;
      return (data as { points: number; kind: string }[]).filter((x) => ['earn', 'welcome', 'birthday'].includes(x.kind)).reduce((a, x) => a + x.points, 0);
    },
  });
  const pts = usePoints(bill.data?.customers?.id ?? null);
  if (bill.isPending) return <Loading rows={5} />;
  if (bill.error) return <Notice tone="bad">{errorMessage(bill.error)}</Notice>;
  const b = bill.data;
  if (!b) return <Empty title="Bill not found" />;
  const tz = centre.timezone;
  const due = b.status === 'void' ? 0 : b.total_paise - b.paid_paise;
  const okPays = b.payments.filter((p) => p.status === 'ok');
  const methods = [...new Set(okPays.map((p) => METHOD_LABEL[p.method]))].join(' + ');
  // the customer's link opens a public receipt (no login); staff link only as a fallback
  const link = b.share_token ? `${window.location.origin}/r/${b.share_token}` : `${window.location.origin}/s/${centre.slug}/bills/${b.id}`;
  const wa = b.customers ? msgReceipt({
    name: b.customers.full_name, centre: centre.name, billNo: b.bill_no, tz, games: b.lines.games, items: b.lines.items, discount: b.discount_paise,
    tax: b.tax_paise, total: b.total_paise,
    points: pts?.enabled ? { used: b.points_redeemed, usedPaise: b.points_paise, earned: earned.data ?? 0, balance: pts.balance } : null, paid: b.paid_paise, methods, link, upiLink: due > 0 && centre.upi_id ? upiLink(centre.upi_id, centre.name, due, b.bill_no) : null,
  }) : null;

  return (
    <div className="stack xl">
      <div className="row no-print" style={{ justifyContent: 'space-between' }}>
        <BackLink className="btn ghost small" to={`/s/${centre.slug}/bills`}>← Bills</BackLink>
        <div className="row">
          {wa && b.customers && <WhatsAppPairButton phone={b.customers.phone} name={b.customers.full_name} texts={wa} label="Send receipt" small={false} />}
          <button className="btn" onClick={() => window.print()}><Printer size={18} /> Print</button>
          {can('floor.operate') && <BackLink className="btn primary" to={`/s/${centre.slug}/floor`}>Back to floor</BackLink>}
        </div>
      </div>

      <article className="receipt">
        <h2>{centre.name}</h2>
        <div className="r-meta">{[centre.address, centre.city, centre.phone].filter(Boolean).join(' · ')}{centre.gst_enabled && centre.gstin ? <><br />GSTIN {centre.gstin}</> : null}</div>
        <hr />
        <div className="r-row"><span>Bill {b.bill_no}</span><span>{formatDateTime(b.created_at, tz)}</span></div>
        {b.customers && <div className="r-row"><span>{b.customers.full_name}</span><span>{b.customers.phone}</span></div>}
        <hr />
        {b.lines.games.map((g, i) => (
          <div key={i} className="stack" style={{ gap: 2 }}>
            <div className="r-row b"><span>{g.resource}</span><span className="num">{formatINR(g.amount_paise)}</span></div>
            <div className="r-row"><span>In {formatTime(g.started_at, tz)} · Out {g.ended_at ? formatTime(g.ended_at, tz) : '—'}</span><span>{minutesLabel(g.minutes)}</span></div>
            {g.lines.map((l, j) => <div key={j} className="r-row muted"><span>{l.label}</span><span className="num">{formatINR(l.amount_paise)}</span></div>)}
          </div>
        ))}
        {b.lines.items.map((it, i) => (
          <div key={i} className="r-row"><span>{it.name} × {Number(it.qty)}</span><span className="num">{formatINR(it.total_paise)}</span></div>
        ))}
        <hr />
        <div className="r-row"><span>Subtotal</span><span className="num">{formatINR(b.subtotal_paise)}</span></div>
        {b.discount_paise > 0 && <div className="r-row"><span>Discount{b.discount_reason ? ` (${b.discount_reason})` : ''}</span><span className="num">−{formatINR(b.discount_paise)}</span></div>}
        {b.points_paise > 0 && <div className="r-row"><span>Points used ({b.points_redeemed})</span><span className="num">−{formatINR(b.points_paise)}</span></div>}
        {b.tax_paise > 0 && <div className="r-row"><span>GST {b.gst_rate_bp / 100}%</span><span className="num">{formatINR(b.tax_paise)}</span></div>}
        <div className="r-row b"><span>Total</span><span className="num">{formatINR(b.total_paise)}</span></div>
        {okPays.map((p) => <div key={p.id} className="r-row"><span>Paid · {METHOD_LABEL[p.method]}</span><span className="num">{formatINR(p.amount_paise)}</span></div>)}
        {due > 0 && <div className="r-row b"><span>Balance due</span><span className="num">{formatINR(due)}</span></div>}
        <hr />
        {pts?.enabled && b.status !== 'void' && (earned.data ?? 0) > 0 && (
          <div className="r-row"><span>⭐ Points earned</span><span className="num">+{earned.data} · balance {pts.balance}</span></div>
        )}
        <div className="r-meta">Thank you for playing! · XS Arena by Xelorsoft</div>
      </article>

      <div className="no-print stack lg" style={{ maxWidth: 420, margin: '0 auto', width: '100%' }}>
        <div className="row" style={{ justifyContent: 'center' }}><StatusBadge status={b.status} /></div>
        {b.status === 'void' && <Notice tone="warn">Voided: {b.void_reason}</Notice>}
        {due > 0 && <button className="btn primary block xl" onClick={() => setPaying(true)}>Collect {formatINR(due)}</button>}
        {due > 0 && <UpiQr amount={due} note={b.bill_no} />}
        {can('billing.void') && b.status !== 'void' && <button className="btn ghost danger" onClick={() => setVoiding(true)}>Void bill</button>}
      </div>
      {paying && <PaySheet billId={b.id} due={due} onClose={() => setPaying(false)} onDone={() => qc.invalidateQueries({ queryKey: ['bill', centre.id, billId] })} />}
      {voiding && <ReasonSheet title="Void bill" confirmLabel="Void bill" onClose={() => setVoiding(false)}
        warning={`Bill ${b.bill_no} (${formatINR(b.total_paise)}) will be cancelled, its payments voided and snacks returned to stock. The owner sees who did it and why.`}
        onConfirm={async (reason) => {
          await rpc('void_bill', { p_centre: centre.id, p_bill: b.id, p_reason: reason });
          await Promise.all(['bill', 'bills', 'dashboard', 'products'].map((k) => qc.invalidateQueries({ queryKey: [k, centre.id] })));
          toast('Bill voided');
        }} />}
    </div>
  );
}

function PaySheet({ billId, due, onClose, onDone }: { billId: string; due: number; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { centre } = useCentre();
  const [method, setMethod] = useState<Method>('cash');
  const [amount, setAmount] = useState(paiseToInput(due));
  const amt = parseINR(amount);
  const pay = useMutation({
    mutationFn: () => rpc('add_payment', { p_centre: centre.id, p_bill: billId, p_method: method, p_amount_paise: amt }),
    onSuccess: async () => { await onDone(); onClose(); },
  });
  return (
    <Sheet title="Collect payment" onClose={onClose}>
      <form className="stack lg" onSubmit={(e) => { e.preventDefault(); pay.mutate(); }}>
        <Segmented label="Method" value={method} onChange={setMethod} options={[{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'card', label: 'Card' }]} />
        <Field label="Amount (₹)"><input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        {method === 'upi' && amt && <UpiQr amount={amt} note="Balance" />}
        {pay.error && <Notice tone="bad">{errorMessage(pay.error)}</Notice>}
        <button className="btn primary block xl" disabled={!amt || amt > due || pay.isPending}>Save payment</button>
      </form>
    </Sheet>
  );
}
