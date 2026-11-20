// Full-screen TV display at /tv. No login on the TV: it shows a 6-digit code, the owner links it from
// Settings, and the TV keeps a secret token. Staff mode shows first names; customer mode hides people and money.
import { useEffect, useRef, useState } from 'react';
import { formatTime } from '../../lib/dates';
import { clock, playedSeconds, toneOf, useNow, type Activity, type Floor, type Resource, type Tone } from '../../lib/floor';
import { supabase } from '../../lib/supabase';
import { FloorMap, TONE_FILL } from '../floor/FloorMap';
import '../floor/floor.css';

const TOKEN_KEY = 'xs-arena-tv-token';
type Poll =
  | { state: 'pairing'; code: string; expires_at: string }
  | { state: 'expired' | 'revoked' | 'paused' }
  | { state: 'live'; mode: 'staff' | 'customer'; name: string; server_time: string; centre: { name: string; timezone: string };
      floors: Floor[]; activities: Activity[]; resources: Resource[]; waitlist: { n: number; activity_id: string; party_size: number; name: string | null }[] };

export function TvPage() {
  const [poll, setPoll] = useState<Poll | null>(null);
  const [snapAt, setSnapAt] = useState(Date.now());
  const [floorIdx, setFloorIdx] = useState(0);
  const [error, setError] = useState(false);
  const now = useNow();
  const busy = useRef(false);

  useEffect(() => {
    document.title = 'XS Arena TV';
    let wake: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    const lock = () => nav.wakeLock?.request('screen').then((w) => { wake = w; }).catch(() => undefined);
    void lock();
    const vis = () => { if (document.visibilityState === 'visible') void lock(); };
    document.addEventListener('visibilitychange', vis);
    return () => { document.removeEventListener('visibilitychange', vis); void wake?.release(); };
  }, []);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        let token = localStorage.getItem(TOKEN_KEY);
        if (!token) {
          const { data, error } = await supabase.rpc('tv_begin');
          if (error) throw error;
          token = (data as { token: string }).token;
          localStorage.setItem(TOKEN_KEY, token);
        }
        const { data, error } = await supabase.rpc('tv_poll', { p_token: token });
        if (error) throw error;
        const p = data as Poll;
        if (p.state === 'expired' || p.state === 'revoked') { localStorage.removeItem(TOKEN_KEY); }
        if (!stop) { setPoll(p); setSnapAt(Date.now()); setError(false); }
      } catch {
        if (!stop) setError(true);
      } finally {
        busy.current = false;
      }
    };
    void tick();
    const t = setInterval(tick, 4000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  // rotate between halls every 20 s
  useEffect(() => {
    if (poll?.state !== 'live' || poll.floors.length < 2) return;
    const t = setInterval(() => setFloorIdx((i) => (i + 1) % poll.floors.length), 20000);
    return () => clearInterval(t);
  }, [poll]);

  if (!poll) return <div className="tv"><div className="tv-pair"><p>Connecting…</p></div></div>;
  if (poll.state === 'pairing') {
    return (
      <div className="tv">
        <div />
        <div className="tv-pair">
          <p>Link this screen to your centre</p>
          <div className="code">{poll.code.slice(0, 3)} {poll.code.slice(3)}</div>
          <p>On your phone open XS Arena → Settings → TV screens → Add TV, and type this code.</p>
          {error && <p>Connection lost. Retrying…</p>}
        </div>
      </div>
    );
  }
  if (poll.state !== 'live') {
    return <div className="tv"><div /><div className="tv-pair"><p>{poll.state === 'paused' ? 'This centre is paused.' : 'Getting a new code…'}</p></div></div>;
  }

  const floor = poll.floors[floorIdx % poll.floors.length];
  const res = poll.resources.filter((r) => r.floor_id === floor?.id);
  const tz = poll.centre.timezone;
  const act = (id: string) => poll.activities.find((a) => a.id === id);
  const tones = poll.resources.map((r) => toneOf(r, r.session ? playedSeconds(r.session, snapAt, now) : 0));
  const freeBy = poll.activities.map((a) => ({ a, n: poll.resources.filter((r, i) => r.activity_id === a.id && tones[i] === 'free').length, total: poll.resources.filter((r) => r.activity_id === a.id).length })).filter((x) => x.total);
  const soon = poll.resources.map((r, i) => ({ r, i, left: r.session?.planned_minutes ? r.session.planned_minutes * 60 - playedSeconds(r.session, snapAt, now) : null }))
    .filter((x) => x.left !== null && x.left <= 600).sort((a, b) => a.left! - b.left!).slice(0, 5);
  const legend: [Tone, string][] = [['free', 'Free'], ['playing', 'Playing'], ['soon', '5 min left'], ['over', "Time's up"]];

  return (
    <div className="tv">
      <header className="tv-head">
        <h1>{poll.centre.name}{poll.floors.length > 1 ? ` · ${floor.name}` : ''}</h1>
        <div className="tv-legend">{legend.map(([t, l]) => <span key={t}><i style={{ background: TONE_FILL[t] }} />{l}</span>)}</div>
        <span className="tv-clock">{formatTime(new Date(now).toISOString(), tz)}</span>
      </header>
      <div className="tv-body">
        {floor ? <FloorMap floor={floor} resources={res} activities={poll.activities} mode="tv" snapshotAt={snapAt} now={now}
          showMoney={false} showNames={poll.mode === 'staff'} /> : <div />}
        <aside className="tv-side">
          <h2>Free now</h2>
          {freeBy.map(({ a, n, total }) => <div key={a.id} className="tv-item"><span>{a.name}</span><b>{n} / {total}</b></div>)}
          {soon.length > 0 && <h2>Finishing soon</h2>}
          {soon.map(({ r, left }) => <div key={r.id} className="tv-item"><span>{r.name}</span><b style={{ color: left! <= 0 ? '#FF453A' : '#FF9F0A' }}>{left! <= 0 ? `+${clock(-left!)}` : clock(left!)}</b></div>)}
          {poll.waitlist.length > 0 && <h2>Waiting list</h2>}
          {poll.waitlist.slice(0, 8).map((w) => (
            <div key={w.n} className="tv-item"><span>#{w.n}{w.name ? ` ${w.name}` : ''} · {act(w.activity_id)?.name}</span><b>{w.party_size}</b></div>
          ))}
          {error && <div className="tv-item"><span>Reconnecting…</span></div>}
        </aside>
      </div>
    </div>
  );
}
