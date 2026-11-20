import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useCentre, useRefresh } from '../../app/centre';
import { ReasonSheet } from '../../components/centre';
import { Empty, Field, Loading, Notice, Sheet, useToast } from '../../components/ui';
import { formatDate, todayInCentre } from '../../lib/dates';
import { errorMessage } from '../../lib/errors';
import { formatINR, parseINR } from '../../lib/money';
import { rpc, supabase } from '../../lib/supabase';
import { EXPENSE_CATEGORIES, METHOD_LABEL, METHODS, PAID_FROM_LABEL, type Expense, type Method } from '../../lib/types';

/** Expenses for the current month (or any month), with category totals and void. */
export function ExpensesPage() {
  const { centre } = useCentre();
  const [params, setParams] = useSearchParams();
  const [month, setMonth] = useState(() => todayInCentre(centre.timezone).slice(0, 7));
  const [voiding, setVoiding] = useState<Expense | null>(null);
  const adding = params.get('new') === '1';
  const refresh = useRefresh();
  const toast = useToast();

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

  const ok = (list.data ?? []).filter((e) => e.status === 'ok');
  const total = ok.reduce((a, e) => a + e.amount_paise, 0);
  const byCat = Object.entries(ok.reduce<Record<string, number>>((a, e) => ((a[e.category] = (a[e.category] ?? 0) + e.amount_paise), a), {}))
    .sort((a, b) => b[1] - a[1]);

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
            <li key={e.id}>
              <button className="item" onClick={() => e.status === 'ok' && setVoiding(e)} style={e.status === 'void' ? { opacity: 0.5 } : undefined}>
                <span className="main-col">
                  <span className="title">{e.category}{e.description ? ` · ${e.description}` : ''}</span>
                  <span className="meta"><span>{formatDate(e.expense_date)}</span><span>{METHOD_LABEL[e.method]}</span><span>{PAID_FROM_LABEL[e.paid_from]}</span></span>
                </span>
                <span className="end-col">
                  <b className="num">{formatINR(e.amount_paise)}</b>
                  {e.status === 'void' && <span className="badge bad">Void</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding && <ExpenseSheet onClose={() => setParams({})} />}
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
  const [f, setF] = useState({
    category: EXPENSE_CATEGORIES[0], amount: '', date: todayInCentre(centre.timezone), method: 'cash' as Method,
    paid_from: 'drawer' as Expense['paid_from'], description: '',
  });
  const amount = parseINR(f.amount);
  const save = useMutation({
    mutationFn: () => rpc('record_expense', {
      p_centre: centre.id, p_category: f.category, p_amount_paise: amount, p_expense_date: f.date, p_method: f.method,
      p_paid_from: f.paid_from, p_description: f.description || null,
    }),
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
        {save.error && <Notice tone="bad">{errorMessage(save.error)}</Notice>}
        <button className="btn primary block xl" disabled={save.isPending || !amount}>Save expense</button>
      </form>
    </Sheet>
  );
}
