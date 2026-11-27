import { mediaUrl } from '../../lib/media';
// Public receipt: the link the customer gets on WhatsApp. No login; loaded by its secret token.
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useParams } from 'react-router';
import { Loading, Notice } from '../../components/ui';
import { formatDateTime, formatTime } from '../../lib/dates';
import { minutesLabel } from '../../lib/floor';
import type { ReceiptGame, ReceiptItem } from '../../lib/messages';
import { formatINR } from '../../lib/money';
import '../floor/floor.css';
import '../booking/booking.css';

type Receipt = {
  bill_no: string; created_at: string; status: string; subtotal_paise: number; discount_paise: number; discount_reason: string | null;
  tax_paise: number; gst_rate_bp: number; total_paise: number; paid_paise: number; points_redeemed: number; points_paise: number;
  lines: { games: ReceiptGame[]; items: ReceiptItem[] };
  customer: string | null;
  centre: { name: string; slug: string; phone: string | null; address: string | null; city: string | null; timezone: string; gstin: string | null; logo_path?: string | null; instagram?: string | null };
};

export function ReceiptPublic() {
  const { token = '' } = useParams();
  const q = useQuery({
    queryKey: ['public-receipt', token],
    queryFn: async () => {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/receipt?t=${encodeURIComponent(token)}`);
      const body = await res.json().catch(() => ({ error: 'Could not load the receipt.' }));
      if (!res.ok) throw new Error(body.error ?? 'Could not load the receipt.');
      return body as Receipt;
    },
    retry: 1,
  });
  useEffect(() => { if (q.data) document.title = `Receipt ${q.data.bill_no} · ${q.data.centre.name}`; }, [q.data]);

  return (
    <main className="book-page">
      <div className="book-wrap stack lg">
        {q.isPending ? <Loading rows={6} /> : q.error ? (
          <>
            <Notice tone="bad">{(q.error as Error).message}</Notice>
            <p className="muted">Open the exact link you got on WhatsApp, or ask the centre to send it again.</p>
          </>
        ) : q.data && <Body r={q.data} />}
      </div>
    </main>
  );
}

function Body({ r }: { r: Receipt }) {
  const tz = r.centre.timezone;
  const due = r.status === 'void' ? 0 : r.total_paise - r.paid_paise;
  return (
    <>
      <article className="receipt">
        {r.centre.logo_path && <img className="book-logo small" style={{ margin: '0 auto 6px', display: 'block' }} src={mediaUrl(r.centre.logo_path) ?? ''} alt="" data-testid="receipt-logo" />}
        <h2>{r.centre.name}</h2>
        <div className="r-meta">{[r.centre.address, r.centre.city, r.centre.phone].filter(Boolean).join(' · ')}{r.centre.gstin ? <><br />GSTIN {r.centre.gstin}</> : null}</div>
        <hr />
        <div className="r-row"><span>{r.bill_no}</span><span>{formatDateTime(r.created_at, tz)}</span></div>
        {r.customer && <div className="r-row"><span>{r.customer}</span></div>}
        <hr />
        {r.lines.games.map((g, i) => (
          <div key={i} className="stack" style={{ gap: 2 }}>
            <div className="r-row b"><span>{g.resource}</span><span className="num">{formatINR(g.amount_paise)}</span></div>
            <div className="r-row"><span>In {formatTime(g.started_at, tz)} · Out {g.ended_at ? formatTime(g.ended_at, tz) : '—'}</span><span>{minutesLabel(g.minutes)}</span></div>
            {g.lines.map((l, j) => <div key={j} className="r-row muted"><span>{l.label}</span><span className="num">{formatINR(l.amount_paise)}</span></div>)}
          </div>
        ))}
        {r.lines.items.map((it, i) => <div key={i} className="r-row"><span>{it.name} × {Number(it.qty)}</span><span className="num">{formatINR(it.total_paise)}</span></div>)}
        <hr />
        <div className="r-row"><span>Subtotal</span><span className="num">{formatINR(r.subtotal_paise)}</span></div>
        {r.discount_paise > 0 && <div className="r-row"><span>Discount{r.discount_reason ? ` (${r.discount_reason})` : ''}</span><span className="num">−{formatINR(r.discount_paise)}</span></div>}
        {r.points_paise > 0 && <div className="r-row"><span>Points used ({r.points_redeemed})</span><span className="num">−{formatINR(r.points_paise)}</span></div>}
        {r.tax_paise > 0 && <div className="r-row"><span>GST {r.gst_rate_bp / 100}%</span><span className="num">{formatINR(r.tax_paise)}</span></div>}
        <div className="r-row b"><span>Total</span><span className="num">{formatINR(r.total_paise)}</span></div>
        <div className="r-row"><span>Paid</span><span className="num">{formatINR(r.paid_paise)}</span></div>
        {due > 0 && <div className="r-row b"><span>Balance due</span><span className="num">{formatINR(due)}</span></div>}
        {r.status === 'void' && <div className="r-row b"><span>This bill was cancelled</span></div>}
        <hr />
        <div className="r-meta">Thank you for playing! · XS Arena by Xelorsoft</div>
      </article>
      <div className="stack no-print" style={{ maxWidth: 420, margin: '0 auto', width: '100%' }}>
        <button className="btn block" onClick={() => window.print()}><Printer size={18} /> Save or print</button>
        <Link className="btn block primary" to={`/b/${r.centre.slug}`}>Book your next game</Link>
      </div>
    </>
  );
}
