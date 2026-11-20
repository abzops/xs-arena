import { useMutation } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useCentre, useRefresh, useTeam } from '../../app/centre';
import { Empty, Field, Loading, Notice, Sheet, initials, useToast } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { rpc } from '../../lib/supabase';
import { ROLE_LABEL, type Role, type Staff } from '../../lib/types';

const ROLE_HINT: Record<Role, string> = {
  owner: 'Everything, including settings, team and the floor designer',
  manager: 'Floor, billing, discounts, voids, expenses and reports — not settings or team',
  front_desk: 'Run the floor, take walk-ins, bill and add customers',
};
const COLORS = ['#2A78D6', '#EB6834', '#1BAF7A', '#EDA100', '#9B5DE5', '#E0457B', '#00A3B4', '#6B7A8F'];

export function TeamPage() {
  const { can, me } = useCentre();
  const { team, loading, error } = useTeam();
  const [editing, setEditing] = useState<Partial<Staff> | null>(null);
  const manage = can('staff.manage');
  if (loading) return <Loading rows={4} />;
  if (error) return <Notice tone="bad">{errorMessage(error)}</Notice>;
  const list = [...team].sort((a, b) => (a.status === b.status ? a.sort - b.sort : a.status === 'active' ? -1 : 1));
  return (
    <div className="stack lg">
      <div className="page-head">
        <h1>Team</h1>
        {manage && <button className="btn primary" onClick={() => setEditing({})} aria-label="Add team member"><Plus size={18} /> <span className="btn-text">Add member</span></button>}
      </div>
      <p className="muted">Add an email to give someone their own login. They sign up with that email and land straight in your centre.</p>
      {!list.length ? <div className="card"><Empty title="No team yet" /></div> : (
        <ul className="list card flush">
          {list.map((s) => (
            <li key={s.id}>
              <button className="item" disabled={!manage} onClick={() => setEditing(s)} style={s.status !== 'active' ? { opacity: 0.55 } : undefined}>
                <span className="avatar" aria-hidden style={{ boxShadow: `inset 0 0 0 2px ${s.color}` }}>{initials(s.display_name)}</span>
                <span className="main-col">
                  <span className="title">{s.display_name}{s.id === me.id && <span className="muted"> (you)</span>}</span>
                  <span className="meta"><span>{s.title || ROLE_LABEL[s.role]}</span>{s.phone && <span>{s.phone}</span>}</span>
                </span>
                <span className="end-col">
                  <span className="badge neutral">{ROLE_LABEL[s.role]}</span>
                  {s.status !== 'active' ? <span className="badge bad">Inactive</span> : s.user_id ? <span className="badge ok">Has login</span> : s.email ? <span className="badge warn">Invite pending</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && <StaffSheet s={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function StaffSheet({ s, onClose }: { s: Partial<Staff>; onClose: () => void }) {
  const { centre, me } = useCentre();
  const { team } = useTeam();
  const refresh = useRefresh();
  const toast = useToast();
  const [f, setF] = useState({
    display_name: s.display_name ?? '', role: s.role ?? 'front_desk', title: s.title ?? '', phone: s.phone ?? '', email: s.email ?? '',
    color: s.color ?? COLORS[team.length % COLORS.length],
  });
  const save = useMutation({
    mutationFn: (status: 'active' | 'inactive') => rpc('save_staff', {
      p_centre: centre.id, p_staff: s.id ?? null, p_display_name: f.display_name.trim(), p_role: f.role, p_title: f.title || null,
      p_phone: f.phone || null, p_email: f.email || null, p_color: f.color, p_status: status,
    }),
    onSuccess: async () => { await refresh('team', 'dashboard'); toast('Team updated'); onClose(); },
  });
  return (
    <Sheet title={s.id ? 'Edit team member' : 'Add team member'} onClose={onClose}>
      <form className="stack lg" onSubmit={(e) => { e.preventDefault(); save.mutate('active'); }}>
        <div className="grid-2">
          <Field label="Name"><input className="input" value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></Field>
          <Field label="Title (optional)"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Evening shift" /></Field>
        </div>
        <Field label="Access" hint={ROLE_HINT[f.role as Role]}>
          <select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>
            {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select>
        </Field>
        <div className="grid-2">
          <Field label="Phone (optional)"><input className="input" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label="Login email (optional)" hint={s.user_id ? 'Linked to an account' : 'They sign up with this email to get access'}>
            <input className="input" type="email" disabled={!!s.user_id} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        </div>
        <div className="field"><span>Colour</span>
          <div className="chips">{COLORS.map((c) => (
            <button key={c} type="button" aria-label={c} aria-pressed={f.color === c} onClick={() => setF({ ...f, color: c })}
              style={{ width: 34, height: 34, borderRadius: '50%', border: 0, cursor: 'pointer', background: c, boxShadow: f.color === c ? '0 0 0 3px var(--paper), 0 0 0 5px var(--ink)' : 'none' }} />
          ))}</div></div>
        {save.error && <Notice tone="bad">{errorMessage(save.error)}</Notice>}
        <button className="btn primary block xl" disabled={save.isPending || !f.display_name.trim()}>Save</button>
        {s.id && s.id !== me.id && (
          <button type="button" className={s.status === 'active' ? 'btn danger block' : 'btn block'} disabled={save.isPending}
            onClick={() => save.mutate(s.status === 'active' ? 'inactive' : 'active')}>{s.status === 'active' ? 'Deactivate' : 'Reactivate'}</button>
        )}
      </form>
    </Sheet>
  );
}
