import { useLocation } from 'react-router';
// "How to use XS Arena": a short guided tour that points at each part of the menu, in English or Malayalam.
// Opens by itself once for new team members (centre_staff.guide_seen_at is empty) and any time from "How to use".
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { useCentre } from '../app/centre';
import { rpc } from '../lib/supabase';
import { Segmented } from './ui';

import { GUIDE_STEPS, type Lang } from './guideSteps';

const LANG_KEY = 'xs-guide-lang';
const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

export function Guide() {
  const { centre, me, can } = useCentre();
  const steps = GUIDE_STEPS.filter((s) => !s.perm || can(s.perm));
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  const [lang, setLangState] = useState<Lang>(() => { try { return localStorage.getItem(LANG_KEY) === 'ml' ? 'ml' : 'en'; } catch { return 'en'; } });
  const [rect, setRect] = useState<DOMRect | null>(null);
  const setLang = (l: Lang) => { setLangState(l); try { localStorage.setItem(LANG_KEY, l); } catch { /* private mode */ } };

  const close = useCallback(() => {
    setOpen(false);
    if (!me.guide_seen_at) void rpc('mark_guide_seen', { p_centre: centre.id }).catch(() => undefined);
  }, [centre.id, me.guide_seen_at]);

  useEffect(() => {
    const start = () => { setI(0); setOpen(true); };
    window.addEventListener('xs-guide', start);
    return () => window.removeEventListener('xs-guide', start);
  }, []);
  // first time for a new team member
  // (an owner setting up a new centre sees it after the setup steps, from the last step)
  const { pathname } = useLocation();
  const settingUp = !centre.onboarded_at || pathname.endsWith('/welcome');
  useEffect(() => { if (!me.guide_seen_at && !settingUp) { const t = window.setTimeout(() => setOpen(true), 600); return () => window.clearTimeout(t); } }, [me.guide_seen_at, settingUp]);

  const step = steps[Math.min(i, steps.length - 1)];
  useLayoutEffect(() => {
    if (!open || !step?.target) { setRect(null); return; }
    const place = () => {
      const el = [...document.querySelectorAll(`[data-guide="${step.target}"]`)].find(visible);
      if (!el) { setRect(null); return; }
      el.scrollIntoView({ block: 'nearest' });
      setRect(el.getBoundingClientRect());
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, step?.target]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight') setI((n) => Math.min(n + 1, steps.length - 1));
      if (e.key === 'ArrowLeft') setI((n) => Math.max(n - 1, 0));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open, close, steps.length]);

  if (!open || !step) return null;
  const last = i >= steps.length - 1;
  // Card sits beside the highlighted item (sidebar) or above it (phone tab bar); centred when nothing to point at.
  const W = Math.min(360, window.innerWidth - 24);
  let style: React.CSSProperties = { width: W };
  if (rect) {
    if (rect.right + 16 + W < window.innerWidth) style = { ...style, left: rect.right + 16, top: Math.max(12, Math.min(rect.top - 8, window.innerHeight - 280)) };
    else style = { ...style, left: Math.max(12, Math.min(rect.left + rect.width / 2 - W / 2, window.innerWidth - W - 12)), bottom: window.innerHeight - rect.top + 14 };
  }
  return (
    <div className="guide" role="dialog" aria-modal="true" aria-label="How to use XS Arena" data-testid="guide">
      <div className={`guide-dim${rect ? " clear" : ""}`} onClick={close} />
      {rect && <div className="guide-spot" style={{ left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12 }} />}
      <div className={`guide-card${rect ? '' : ' centred'}`} style={style}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="muted num" style={{ fontSize: 'var(--t-xs)' }}>{i + 1} / {steps.length}</span>
          <div className="row" style={{ gap: 6 }}>
            <Segmented label="Language" value={lang} onChange={setLang} options={[{ value: 'en', label: 'EN' }, { value: 'ml', label: 'മലയാളം' }]} />
            <button className="btn small ghost icon-btn" onClick={close} aria-label="Close guide"><X size={16} /></button>
          </div>
        </div>
        <h2 style={{ margin: '6px 0 4px', fontSize: 'var(--t-lg)' }}>{step.title[lang]}</h2>
        <p style={{ margin: 0, lineHeight: 1.55 }} lang={lang}>{step.body[lang]}</p>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 14 }}>
          <button className="btn small ghost" onClick={close}>{lang === 'ml' ? 'ഒഴിവാക്കുക' : 'Skip'}</button>
          <div className="row" style={{ gap: 6 }}>
            {i > 0 && <button className="btn small" onClick={() => setI(i - 1)} aria-label="Back"><ChevronLeft size={16} /></button>}
            <button className="btn small primary" data-testid="guide-next" onClick={() => (last ? close() : setI(i + 1))}>
              {last ? (lang === 'ml' ? 'തീർന്നു' : 'Done') : <>{lang === 'ml' ? 'അടുത്തത്' : 'Next'} <ChevronRight size={16} /></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
