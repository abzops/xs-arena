import { mediaUrl } from '../../lib/media';
import { useMutation } from '@tanstack/react-query';
import { Copy, KeyRound, MessageCircle, Plus } from 'lucide-react';
import { useState } from 'react';
import { useCentre, useRefresh, useTeam } from '../../app/centre';
import { waLink } from '../../components/centre';
import { Empty, Field, Loading, Notice, Segmented, Sheet, initials, useToast } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { credentialsText, loginUrl, type CredentialLang, type Credentials } from '../../lib/staffLogin';
import { createStaffLogin, resetStaffPassword } from '../../lib/staffLoginApi';
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
  const [shown, setShown] = useState<{ creds: Credentials; reset: boolean } | null>(null);
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
      <p className="muted">Add a staff member and XS Arena makes their username and password. Send it to them on WhatsApp — no email or sign-up needed.</p>
      {!list.length ? <div className="card"><Empty title="No team yet" /></div> : (
        <ul className="list card flush">
          {list.map((s) => (
            <li key={s.id}>
              <button className="item" disabled={!manage} onClick={() => setEditing(s)} style={s.status !== 'active' ? { opacity: 0.55 } : undefined}>
                {s.avatar_path
                  ? <img className="avatar" src={mediaUrl(s.avatar_path) ?? ''} alt="" style={{ objectFit: 'cover', boxShadow: `0 0 0 2px ${s.color}` }} data-testid="team-photo" />
                  : <span className="avatar" aria-hidden style={{ boxShadow: `inset 0 0 0 2px ${s.color}` }}>{initials(s.display_name)}</span>}
                <span className="main-col">
                  <span className="title">{s.display_name}{s.id === me.id && <span className="muted"> (you)</span>}</span>
                  <span className="meta"><span>{s.title || ROLE_LABEL[s.role]}</span>{s.username && <span className="mono">{s.username}</span>}{s.phone && <span>{s.phone}</span>}</span>
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
      {editing && <StaffSheet s={editing} onClose={() => setEditing(null)} onCredentials={(creds, reset) => { setEditing(null); setShown({ creds, reset }); }} />}
      {shown && <CredentialsSheet creds={shown.creds} reset={shown.reset} onClose={() => setShown(null)} />}
    </div>
  );
}

function StaffSheet({ s, onClose, onCredentials }: { s: Partial<Staff>; onClose: () => void; onCredentials: (c: Credentials, reset: boolean) => void }) {
  const { centre, me } = useCentre();
  const { team } = useTeam();
  const refresh = useRefresh();
  const toast = useToast();
  const [f, setF] = useState({
    display_name: s.display_name ?? '', role: s.role ?? 'front_desk', title: s.title ?? '', phone: s.phone ?? '', email: s.email ?? '',
    color: s.color ?? COLORS[team.length % COLORS.length],
  });
  // New managers and front-desk staff get a username + password by default (like XS Gym). Owners sign in with their own email.
  const canLogin = f.role !== 'owner';
  const [makeLogin, setMakeLogin] = useState(true);
  const save = useMutation({
    mutationFn: async (status: 'active' | 'inactive') => {
      const id = await rpc<string>('save_staff', {
        p_centre: centre.id, p_staff: s.id ?? null, p_display_name: f.display_name.trim(), p_role: f.role, p_title: f.title || null,
        p_phone: f.phone || null, p_email: f.role === 'owner' ? f.email || null : s.email ?? null, p_color: f.color, p_status: status,
      });
      if (!s.id && canLogin && makeLogin) {
        try { return { creds: await createStaffLogin(centre.id, id) }; }
        catch (e) { return { loginError: errorMessage(e) }; }   // the member is saved; the login can be made from their card
      }
      return {};
    },
    onSuccess: async (r: { creds?: Credentials; loginError?: string }) => {
      await refresh('team', 'dashboard');
      if (r.creds) return onCredentials(r.creds, false);
      toast(r.loginError ? `Saved, but the login wasn't made: ${r.loginError}` : 'Team updated');
      onClose();
    },
  });
  const login = useMutation({
    mutationFn: () => (s.username ? resetStaffPassword : createStaffLogin)(centre.id, s.id!),
    onSuccess: async (c) => { await refresh('team'); onCredentials(c, !!s.username); },
  });
  const showLoginActions = !!s.id && s.id !== me.id && s.role !== 'owner' && s.status === 'active' && (!!s.username || !s.user_id);
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
          <Field label="WhatsApp number" hint="The login details are sent here"><input className="input" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          {f.role === 'owner' ? (
            <Field label="Login email" hint={s.user_id ? 'Linked to an account' : 'Owners sign up with this email to get access'}>
              <input className="input" type="email" disabled={!!s.user_id} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          ) : s.username ? (
            <Field label="Username" hint="They sign in with this and their password"><input className="input mono" value={s.username} readOnly /></Field>
          ) : s.user_id ? (
            <Field label="Login"><input className="input" value={s.email ? `Own email · ${s.email}` : 'Own account'} readOnly /></Field>
          ) : null}
        </div>
        {!s.id && canLogin && (
          <label className="check-row">
            <input type="checkbox" checked={makeLogin} onChange={(e) => setMakeLogin(e.target.checked)} />
            <span>Make a username and password for them</span>
          </label>
        )}
        <div className="field"><span>Colour</span>
          <div className="chips">{COLORS.map((c) => (
            <button key={c} type="button" aria-label={c} aria-pressed={f.color === c} onClick={() => setF({ ...f, color: c })}
              style={{ width: 34, height: 34, borderRadius: '50%', border: 0, cursor: 'pointer', background: c, boxShadow: f.color === c ? '0 0 0 3px var(--paper), 0 0 0 5px var(--ink)' : 'none' }} />
          ))}</div></div>
        {save.error && <Notice tone="bad">{errorMessage(save.error)}</Notice>}
        <button className="btn primary block xl" disabled={save.isPending || !f.display_name.trim()}>
          {save.isPending ? <span className="spinner" /> : !s.id && canLogin && makeLogin ? 'Save and make login' : 'Save'}</button>
        {showLoginActions && (
          <>
            {login.error && <Notice tone="bad">{errorMessage(login.error)}</Notice>}
            <button type="button" className="btn block" disabled={login.isPending} onClick={() => login.mutate()}>
              <KeyRound size={16} aria-hidden /> {login.isPending ? 'Please wait…' : s.username ? 'Reset password' : 'Make a username and password'}</button>
          </>
        )}
        {s.id && s.id !== me.id && (
          <button type="button" className={s.status === 'active' ? 'btn danger block' : 'btn block'} disabled={save.isPending}
            onClick={() => save.mutate(s.status === 'active' ? 'inactive' : 'active')}>{s.status === 'active' ? 'Deactivate' : 'Reactivate'}</button>
        )}
      </form>
    </Sheet>
  );
}

const CRED_LANG_KEY = 'xs-wa-lang';

/** Shown once after a login is made or reset: the details plus a ready WhatsApp message. */
function CredentialsSheet({ creds, reset, onClose }: { creds: Credentials; reset: boolean; onClose: () => void }) {
  const { centre } = useCentre();
  const toast = useToast();
  const [lang, setLangState] = useState<CredentialLang>(() => { try { return localStorage.getItem(CRED_LANG_KEY) === 'ml' ? 'ml' : 'en'; } catch { return 'en'; } });
  const setLang = (l: CredentialLang) => { setLangState(l); try { localStorage.setItem(CRED_LANG_KEY, l); } catch { /* private mode */ } };
  const text = credentialsText(lang, creds, centre.name, loginUrl(creds.username), reset);
  const copy = async (value: string, what: string) => {
    try { await navigator.clipboard.writeText(value); toast(`${what} copied`); } catch { toast('Copy failed — select the text instead'); }
  };
  return (
    <Sheet title={reset ? 'New password' : 'Login created'} onClose={onClose}>
      <div className="stack lg">
        <p className="muted" style={{ margin: 0 }}>For <strong>{creds.name}</strong> · {ROLE_LABEL[creds.role]}</p>
        <dl className="kv cred">
          <dt>Username</dt><dd className="mono"><strong data-testid="staff-username">{creds.username}</strong></dd>
          <dt>Password</dt><dd className="mono"><strong data-testid="staff-password">{creds.password}</strong></dd>
        </dl>
        <Notice tone="warn">This password is shown only now. If it's lost, open the team member and tap Reset password.</Notice>
        <Segmented label="Message language" value={lang} onChange={setLang} options={[{ value: 'en', label: 'English' }, { value: 'ml', label: 'മലയാളം' }]} />
        <pre className="cred-message">{text}</pre>
        {creds.phone ? (
          <a className="btn primary block xl" href={waLink(creds.phone, text)} target="_blank" rel="noopener noreferrer">
            <MessageCircle size={18} aria-hidden /> Send on WhatsApp to {creds.phone}
          </a>
        ) : <Notice>Add their WhatsApp number to send it directly.</Notice>}
        <button type="button" className="btn block" onClick={() => copy(text, 'Message')}><Copy size={16} aria-hidden /> Copy message</button>
        <button type="button" className="btn ghost block" onClick={onClose}>Done</button>
      </div>
    </Sheet>
  );
}
