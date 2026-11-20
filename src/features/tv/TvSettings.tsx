// Settings → TV screens: link a TV by its 6-digit code, choose staff or customer view, remove.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, Plus } from 'lucide-react';
import { useState } from 'react';
import { useCentre } from '../../app/centre';
import { Field, Notice, Segmented, Sheet, useToast } from '../../components/ui';
import { formatDateTime } from '../../lib/dates';
import { errorMessage } from '../../lib/errors';
import { rpc, supabase } from '../../lib/supabase';

type Screen = { id: string; name: string; mode: 'staff' | 'customer'; paired_at: string; last_seen_at: string | null; revoked_at: string | null };

export function TvSettings() {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const list = useQuery({
    queryKey: ['tv', centre.id],
    queryFn: async () => {
      const { data, error } = await supabase.from('tv_screens').select('id, name, mode, paired_at, last_seen_at, revoked_at').eq('centre_id', centre.id).is('revoked_at', null).order('paired_at');
      if (error) throw error;
      return data as Screen[];
    },
  });
  const revoke = useMutation({ mutationFn: (id: string) => rpc('tv_revoke', { p_centre: centre.id, p_screen: id }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['tv', centre.id] }); toast('TV removed'); } });
  const url = `${window.location.origin}/tv`;
  return (
    <section className="card stack lg">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2><Monitor size={18} style={{ verticalAlign: -3 }} /> TV screens</h2>
        <button className="btn small" onClick={() => setAdding(true)}><Plus size={16} /> Add TV</button>
      </div>
      <p className="muted" style={{ margin: 0 }}>On the TV (smart TV browser, Fire TV Stick or Android box) open <b>{url}</b>. It shows a 6-digit code; type it here. No password is ever typed on the TV.</p>
      {list.data?.map((s) => (
        <div key={s.id} className="row" style={{ justifyContent: 'space-between' }}>
          <span><b>{s.name}</b> <span className="muted">· {s.mode === 'staff' ? 'Staff view' : 'Customer view'} · {s.last_seen_at ? `seen ${formatDateTime(s.last_seen_at, centre.timezone)}` : 'not seen yet'}</span></span>
          <button className="btn small ghost danger" disabled={revoke.isPending} onClick={() => { if (window.confirm(`Remove ${s.name}? It will stop showing the floor.`)) revoke.mutate(s.id); }}>Remove</button>
        </div>
      ))}
      {adding && <LinkSheet onClose={() => setAdding(false)} />}
    </section>
  );
}

function LinkSheet({ onClose }: { onClose: () => void }) {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [name, setName] = useState('Reception TV');
  const [mode, setMode] = useState<'staff' | 'customer'>('staff');
  const link = useMutation({
    mutationFn: () => rpc('tv_link', { p_centre: centre.id, p_code: code.replace(/\D/g, ''), p_name: name, p_mode: mode }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['tv', centre.id] }); toast('TV linked'); onClose(); },
  });
  return (
    <Sheet title="Add a TV" onClose={onClose}>
      <form className="stack lg" onSubmit={(e) => { e.preventDefault(); link.mutate(); }}>
        <Field label="Code shown on the TV"><input className="input num" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" autoFocus style={{ fontSize: 24, letterSpacing: '.15em' }} /></Field>
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Segmented label="What it shows" value={mode} onChange={setMode} options={[{ value: 'staff', label: 'Staff view' }, { value: 'customer', label: 'Customer view' }]} />
        <p className="muted" style={{ margin: 0, fontSize: 'var(--t-sm)' }}>{mode === 'staff' ? 'For the TV facing the counter: first names, timers, overtime.' : 'For the hall: free tables and waiting numbers only. No names, phones or money.'}</p>
        {link.error && <Notice tone="bad">{errorMessage(link.error)}</Notice>}
        <button className="btn primary block xl" disabled={code.replace(/\D/g, '').length !== 6 || link.isPending}>Link TV</button>
      </form>
    </Sheet>
  );
}
