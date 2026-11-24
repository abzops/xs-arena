import { useMutation, useQuery } from '@tanstack/react-query';
import { Camera, Plus, Repeat, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useCentre, useRefresh } from '../../app/centre';
import { ReasonSheet } from '../../components/centre';
import { Empty, Field, Loading, Notice, Sheet, useToast } from '../../components/ui';
import { formatDate, todayInCentre } from '../../lib/dates';
import { errorMessage } from '../../lib/errors';
import { formatINR, parseINR } from '../../lib/money';
import { billPhotoUrl, uploadBillPhoto } from '../../lib/photos';
import { rpc, supabase } from '../../lib/supabase';
import {
  EXPENSE_CATEGORIES, METHOD_LABEL, METHODS, PAID_FROM_LABEL, type Expense, type Method, type RecurringExpense,
} from '../../lib/types';

/** Expenses for the current month (or any month), with category totals, monthly expenses, bill photos and void. */
export function ExpensesPage() {
  const { centre, can } = useCentre();
  const [params, setParams] = useSearchParams();
  const [month, setMonth] = useState(() => todayInCentre(centre.timezone).slice(0, 7));
  const [voiding, setVoiding] = useState<Expense | null>(null);
  const [rule, setRule] = useState<RecurringExpense | 'new' | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const adding = params.get('new') === '1';
  const refresh = useRefresh();
  const toast = useToast();

  // post any monthly expenses that fell due since the last visit (the server also does this every morning)
  useEffect(() => {
    rpc<number>('post_due_recurring', { p_centre: centre.id })
      .then((n) => { if (n > 0) void refresh('expenses', 'dashboard', 'recurring'); })
      .catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centre.id]);

  const list = useQuery({
    queryKey: ['expenses', centre.id, month],
    queryFn: async () => {
      const [y, m] = month.split('-').map(Number);
      const end = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
      const { data, error } = await supabase.from('expenses').select('*').eq('centre_id', centre.id)
        .gte('expense_date', `${month}-01`).lt('expense_date', end).order('expense_date', { ascending: false }).order('created_at', { ascending: false });
      if (error) throw error;
      return data as Expense[];
    },
  });
  const rules = useQuery({
    queryKey: ['recurring', centre.id],
    queryFn: async () => {
      const { data, error } = await supabase.from('recurring_expenses').select('*').eq('centre_id', centre.id).order('day_of_month').order('category');
      if (error) throw error;
      return data as RecurringExpense[];
    },
  });

  const ok = (list.data ?? []).filter((e) => e.status === 'ok');
  const total = ok.reduce((a, e) => a + e.amount_paise, 0);
  const byCat = Object.entries(ok.reduce<Record<string, number>>((a, e) => ((a[e.category] = (a[e.category] ?? 0) + e.amount_paise), a), {}))
    .sort((a, b) => b[1] - a[1]);
  const monthly = (rules.data ?? []).filter((r) => r.active).reduce((a, r) => a + r.amount_paise, 0);
  const manage = can('expenses.manage');

  const openPhoto = async (path: string) => {
    try { setPhoto(await billPhotoUrl(path)); } catch (e) { toast(errorMessage(e)); }
  };

  return (
    <div className="stack lg">
      <div className="page-head">
        <h1>Expenses</h1>
        <button className="btn primary" onClick={() => setParams({ new: '1' })} aria-label="Add expense"><Plus size={18} /> <span className="btn-text">Add expense</span></button>
      </div>

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <input className="input" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} style={{ maxWidth: 200 }} aria-label="Month" />
        <b className="num">{formatINR(total)}</b>
      </div>

      {byCat.length > 0 && (
        <div className="tiles">
          {byCat.slice(0, 4).map(([c, v]) => (
            <div key={c} className="tile"><span className="label">{c}</span><span className="value num">{formatINR(v)}</span>
              <span className="sub">{total ? Math.round((v / total) * 100) : 0}% of month</span></div>
          ))}
        </div>
      )}

      {list.isPending ? <Loading rows={4} /> : list.error ? <Notice tone="bad">{errorMessage(list.error)}</Notice> : !list.data.length ? (
        <div className="card"><Empty title="No expenses this month">Add rent, electricity, salaries, snack stock and RC repairs to see your real profit.</Empty></div>
      ) : (
        <ul className="list card flush">
          {list.data.map((e) => (
            <li key={e.id} className="exp-row">
              <button className="item" onClick={() => e.status === 'ok' && setVoiding(e)} style={e.status === 'void' ? { opacity: 0.5 } : undefined}>
                <span className="main-col">
                  <span className="title">{e.category}{e.description ? ` · ${e.description}` : ''}</span>
                  <span className="meta"><span>{formatDate(e.expense_date)}</span><span>{METHOD_LABEL[e.method]}</span><span>{PAID_FROM_LABEL[e.paid_from]}</span>
                    {e.recurring_id && <span><Repeat size={12} /> Monthly</span>}</span>
                </span>
                <span className="end-col">
                  <b className="num">{formatINR(e.amount_paise)}</b>
                  {e.status === 'void' && <span className="badge bad">Void</span>}
                </span>
              </button>
              {e.photo_path && (
                <button className="btn small ghost icon-btn exp-photo" aria-label={`View bill photo for ${e.category}`} onClick={() => openPhoto(e.photo_path!)}>
                  <Camera size={16} /></button>
              )}
            </li>
          ))}
        </ul>
      )}

      <section className="stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2><Repeat size={18} style={{ verticalAlign: -3 }} /> Every month</h2>
          {manage && <button className="btn small" onClick={() => setRule('new')}><Plus size={16} /> Add</button>}
        </div>
        <p className="muted" style={{ fontSize: 'var(--t-sm)', marginTop: -6 }}>
          Rent, salaries, internet… added automatically on their day{monthly > 0 ? ` · ${formatINR(monthly)} a month` : ''}.
        </p>
        {rules.data && rules.data.length > 0 && (
          <ul className="list card flush">
            {rules.data.map((r) => (
              <li key={r.id}>
                <button className="item" disabled={!manage} onClick={() => setRule(r)} style={r.active ? undefined : { opacity: 0.55 }}>
                  <span className="main-col">
                    <span className="title">{r.category}{r.description ? ` · ${r.description}` : ''}</span>
                    <span className="meta"><span>Day {r.day_of_month}{r.day_of_month > 28 ? ' (or month end)' : ''}</span><span>{PAID_FROM_LABEL[r.paid_from]}</span>
                      {!r.active && <span>Paused</span>}</span>
                  </span>
                  <span className="end-col"><b className="num">{formatINR(r.amount_paise)}</b></span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {adding && <ExpenseSheet onClose={() => setParams({})} />}
      {rule && <RecurringSheet rule={rule === 'new' ? null : rule} onClose={() => setRule(null)} />}
      {photo && (
        <Sheet title="Bill photo" onClose={() => setPhoto(null)}>
          <img src={photo} alt="Bill" className="bill-photo" />
        </Sheet>
      )}
      {voiding && (
        <ReasonSheet title="Void expense" confirmLabel="Void expense" onClose={() => setVoiding(null)}
          warning={`${voiding.category} · ${formatINR(voiding.amount_paise)} will be removed from your totals. It stays in the history as void.`}
          onConfirm={async (reason) => {
            await rpc('void_expense', { p_centre: centre.id, p_expense: voiding.id, p_reason: reason });
            await refresh('expenses', 'dashboard'); toast('Expense voided');
          }} />
      )}
    </div>
  );
}

function ExpenseSheet({ onClose }: { onClose: () => void }) {
  const { centre } = useCentre();
  const refresh = useRefresh();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [f, setF] = useState({
    category: EXPENSE_CATEGORIES[0], amount: '', date: todayInCentre(centre.timezone), method: 'cash' as Method,
    paid_from: 'drawer' as Expense['paid_from'], description: '',
  });
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const amount = parseINR(f.amount);
  const save = useMutation({
    mutationFn: async () => {
      const path = file ? await uploadBillPhoto(centre.id, file) : null;
      return rpc('record_expense', {
        p_centre: centre.id, p_category: f.category, p_amount_paise: amount, p_expense_date: f.date, p_method: f.method,
        p_paid_from: f.paid_from, p_description: f.description || null, p_photo_path: path,
      });
    },
    onSuccess: async () => { await refresh('expenses', 'dashboard'); toast('Expense added'); onClose(); },
  });
  return (
    <Sheet title="Add expense" onClose={onClose}>
      <form className="stack lg" onSubmit={(e) => { e.preventDefault(); if (amount) save.mutate(); }}>
        <div className="grid-2">
          <Field label="Amount (₹)" error={f.amount && !amount ? 'Enter a valid amount' : null}>
            <input className="input num" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} autoFocus /></Field>
          <Field label="Category"><select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {EXPENSE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
        </div>
        <div className="grid-2">
          <Field label="Date"><input className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label="Paid by"><select className="input" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value as Method })}>
            {METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</select></Field>
        </div>
        <Field label="Money came from" hint={f.paid_from === 'drawer' ? 'Cash taken from the drawer shows up in the shift close' : undefined}>
          <select className="input" value={f.paid_from} onChange={(e) => setF({ ...f, paid_from: e.target.value as Expense['paid_from'] })}>
            {(Object.keys(PAID_FROM_LABEL) as Expense['paid_from'][]).map((k) => <option key={k} value={k}>{PAID_FROM_LABEL[k]}</option>)}</select></Field>
        <Field label="Note (optional)"><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. KSEB bill, RC car #4 motor" /></Field>
        <div className="field"><span>Bill photo (optional)</span>
          <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden aria-label="Bill photo"
            onChange={(e) => { const x = e.target.files?.[0] ?? null; setFile(x); setPreview(x ? URL.createObjectURL(x) : null); }} />
          {preview ? (
            <div className="bill-thumb"><img src={preview} alt="Bill preview" />
              <button type="button" className="btn small ghost icon-btn" aria-label="Remove photo" onClick={() => { setFile(null); setPreview(null); if (fileRef.current) fileRef.current.value = ''; }}><X size={16} /></button>
            </div>
          ) : <button type="button" className="btn" style={{ justifySelf: 'start' }} onClick={() => fileRef.current?.click()}><Camera size={18} /> Take or choose photo</button>}
        </div>
        {save.error && <Notice tone="bad">{errorMessage(save.error)}</Notice>}
        <button className="btn primary block xl" disabled={save.isPending || !amount}>{save.isPending ? 'Saving…' : 'Save expense'}</button>
      </form>
    </Sheet>
  );
}

function RecurringSheet({ rule, onClose }: { rule: RecurringExpense | null; onClose: () => void }) {
  const { centre } = useCentre();
  const refresh = useRefresh();
  const toast = useToast();
  const [f, setF] = useState({
    category: rule?.category ?? 'Rent', amount: rule ? String(rule.amount_paise / 100) : '', day: rule?.day_of_month ?? 1,
    method: rule?.method ?? 'bank' as Method, paid_from: rule?.paid_from ?? 'bank' as Expense['paid_from'], description: rule?.description ?? '',
    active: rule?.active ?? true,
  });
  const amount = parseINR(f.amount);
  const save = useMutation({
    mutationFn: () => rpc('save_recurring_expense', { p_centre: centre.id, p_rule: {
      id: rule?.id ?? null, category: f.category, amount_paise: amount, day_of_month: f.day, method: f.method,
      paid_from: f.paid_from, description: f.description, active: f.active,
    } }),
    onSuccess: async () => { await refresh('recurring', 'expenses', 'dashboard'); toast(rule ? 'Saved' : 'Monthly expense added'); onClose(); },
  });
  return (
    <Sheet title={rule ? 'Monthly expense' : 'Add monthly expense'} onClose={onClose}>
      <form className="stack lg" onSubmit={(e) => { e.preventDefault(); if (amount) save.mutate(); }}>
        <div className="grid-2">
          <Field label="Amount (₹)" error={f.amount && !amount ? 'Enter a valid amount' : null}>
            <input className="input num" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} autoFocus={!rule} /></Field>
          <Field label="Category"><select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {EXPENSE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
        </div>
        <div className="grid-2">
          <Field label="Day of the month" hint="29–31 means the last day in shorter months">
            <select className="input" value={f.day} onChange={(e) => setF({ ...f, day: Number(e.target.value) })}>
              {Array.from({ length: 31 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select></Field>
          <Field label="Money came from"><select className="input" value={f.paid_from} onChange={(e) => setF({ ...f, paid_from: e.target.value as Expense['paid_from'] })}>
            {(Object.keys(PAID_FROM_LABEL) as Expense['paid_from'][]).map((k) => <option key={k} value={k}>{PAID_FROM_LABEL[k]}</option>)}</select></Field>
        </div>
        <Field label="Paid by"><select className="input" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value as Method })}>
          {METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</select></Field>
        <Field label="Note (optional)"><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. Shop rent, Rahul's salary" /></Field>
        {rule && <label className="check-row"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> <span>Active (uncheck to pause)</span></label>}
        {!rule && <Notice tone="info">Added automatically on day {f.day} from now on. If this month's day has already passed, add this month's one as a normal expense.</Notice>}
        {save.error && <Notice tone="bad">{errorMessage(save.error)}</Notice>}
        <button className="btn primary block xl" disabled={save.isPending || !amount}>Save</button>
      </form>
    </Sheet>
  );
}
