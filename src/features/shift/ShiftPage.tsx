// Cash drawer: open a shift with starting cash, close it by counting; differences need a note.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useCentre } from '../../app/centre';
import { Empty, Field, Loading, Notice, useToast } from '../../components/ui';
import { formatDateTime } from '../../lib/dates';
import { errorMessage } from '../../lib/errors';
import { formatINR, parseINR } from '../../lib/money';
import { rpc, supabase } from '../../lib/supabase';
import { METHOD_LABEL, type Method } from '../../lib/types';

type Figures = { by_method: Record<string, number>; cash_in: number; drawer_expenses: number; bills: number; sales: number; discounts: number; voids: number; dues: number };
type Current = { id: string; opened_at: string; opening_cash_paise: number; opened_by: string | null; figures: Figures; expected_cash_paise: number } | null;
type Past = { id: string; opened_at: string; closed_at: string; expected_cash_paise: number; counted_cash_paise: number; difference_paise: number; note: string | null; summary: Figures };

export function ShiftPage() {
  const { centre, can } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const [opening, setOpening] = useState('');
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const cur = useQuery({ queryKey: ['shift', centre.id], queryFn: () => rpc<Current>('current_shift', { p_centre: centre.id }), refetchInterval: 30_000 });
  const past = useQuery({
    queryKey: ['shifts', centre.id],
    queryFn: async () => {
      const { data, error } = await supabase.from('shifts').select('*').eq('centre_id', centre.id).eq('status', 'closed').order('opened_at', { ascending: false }).limit(30);
      if (error) throw error;
      return data as Past[];
    },
  });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['shift', centre.id] }), qc.invalidateQueries({ queryKey: ['shifts', centre.id] })]);
  const open = useMutation({ mutationFn: () => rpc('open_shift', { p_centre: centre.id, p_opening_cash_paise: parseINR(opening || '0') ?? 0 }),
    onSuccess: async () => { await refresh(); toast('Shift opened'); setOpening(''); } });
  const close = useMutation({ mutationFn: () => rpc('close_shift', { p_centre: centre.id, p_counted_cash_paise: parseINR(counted || '0') ?? 0, p_note: note || null }),
    onSuccess: async () => { await refresh(); toast('Shift closed'); setCounted(''); setNote(''); } });
  if (cur.isPending) return <Loading rows={4} />;
  if (cur.error) return <Notice tone="bad">{errorMessage(cur.error)}</Notice>;
  const s = cur.data;
  const countedP = counted === '' ? null : counted.trim() === '0' ? 0 : parseINR(counted);
  const diff = s && countedP != null ? countedP - s.expected_cash_paise : null;
  return (
    <div className="stack xl">
      <div className="page-head"><h1>Shift & cash</h1></div>
      {!s ? (
        <section className="card stack lg">
          <h2>Open a shift</h2>
          <p className="muted" style={{ margin: 0 }}>Count the cash in the drawer before the first customer.</p>
          <Field label="Cash in drawer (₹)"><input className="input num" inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="0" /></Field>
          {open.error && <Notice tone="bad">{errorMessage(open.error)}</Notice>}
          <button className="btn primary block xl" disabled={open.isPending} onClick={() => open.mutate()}>Open shift</button>
        </section>
      ) : (
        <>
          <div className="tiles">
            <div className="tile"><span className="label">Sales this shift</span><span className="value num">{formatINR(s.figures.sales)}</span><span className="sub">{s.figures.bills} bills</span></div>
            <div className="tile"><span className="label">Cash expected in drawer</span><span className="value num">{formatINR(s.expected_cash_paise)}</span>
              <span className="sub">{formatINR(s.opening_cash_paise)} start + {formatINR(s.figures.cash_in)} cash − {formatINR(s.figures.drawer_expenses)} spent</span></div>
          </div>
          <section className="card">
            <ul className="ios-list" style={{ margin: 0 }}>
              {Object.entries(s.figures.by_method).map(([m, v]) => <li key={m}><span>{METHOD_LABEL[m as Method] ?? m}</span><b className="num">{formatINR(v)}</b></li>)}
              <li><span>Discounts</span><b className="num">{formatINR(s.figures.discounts)}</b></li>
              <li><span>Voids (bills + games)</span><b className="num">{s.figures.voids}</b></li>
              <li><span>New dues</span><b className="num">{formatINR(s.figures.dues)}</b></li>
            </ul>
            <p className="muted" style={{ fontSize: 'var(--t-sm)' }}>Opened {formatDateTime(s.opened_at, centre.timezone)}{s.opened_by ? ` by ${s.opened_by}` : ''}</p>
          </section>
          <section className="card stack lg">
            <h2>Close shift</h2>
            <Field label="Cash you counted (₹)"><input className="input num" inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} /></Field>
            {diff !== null && diff !== 0 && <Notice tone={diff < 0 ? 'bad' : 'warn'}>Cash is {diff < 0 ? 'short' : 'over'} by {formatINR(Math.abs(diff))}. Add a note to close.</Notice>}
            {diff === 0 && <Notice tone="ok">Cash matches.</Notice>}
            <Field label={diff ? 'Note (required)' : 'Note (optional)'}><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            {close.error && <Notice tone="bad">{errorMessage(close.error)}</Notice>}
            <button className="btn primary block xl" disabled={close.isPending || countedP == null || (!!diff && !note.trim())} onClick={() => close.mutate()}>Close shift</button>
          </section>
        </>
      )}
      {can('reports.view') && (
        <section className="stack">
          <h2>Past shifts</h2>
          {past.isPending ? <Loading rows={3} /> : !past.data?.length ? <div className="card"><Empty title="No closed shifts yet" /></div> : (
            <ul className="list card flush">
              {past.data.map((p) => (
                <li key={p.id} className="item">
                  <span className="main-col"><span className="title">{formatDateTime(p.opened_at, centre.timezone)} → {formatDateTime(p.closed_at, centre.timezone)}</span>
                    <span className="meta"><span>Sales {formatINR(p.summary?.sales ?? 0)}</span><span>Expected {formatINR(p.expected_cash_paise)}</span><span>Counted {formatINR(p.counted_cash_paise)}</span>{p.note && <span>{p.note}</span>}</span></span>
                  <span className="end-col"><span className={`badge ${p.difference_paise === 0 ? 'ok' : p.difference_paise < 0 ? 'bad' : 'warn'}`}>
                    {p.difference_paise === 0 ? 'Matched' : `${p.difference_paise < 0 ? 'Short' : 'Over'} ${formatINR(Math.abs(p.difference_paise))}`}</span></span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
