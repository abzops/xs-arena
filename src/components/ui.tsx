import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, type LinkProps } from 'react-router';
import { setTransition } from '../lib/motion';
import { project, rubberband, Spring, SPRING, VelocityTracker } from '../lib/spring';

/* ---------- Sheet ----------
   Phones: an iOS-style bottom sheet driven by springs. It tracks the finger
   1:1 from wherever it is grabbed (even mid-animation), rubber-bands when
   pulled up, and on release hands the finger's velocity to the spring,
   projecting the flick to decide between settling and dismissing.
   Wider screens and reduced motion: a centred dialog with a short fade. */
/** One shared history entry while any sheet is open, so the phone Back gesture closes the top sheet.
 *  Swapping one sheet for another (table → bill) keeps the entry; it is removed only after the last sheet closes. */
const sheetHistory = (() => {
  const stack: (() => void)[] = [];
  let pushed = false;
  let pending: number | undefined;
  const mark = () => { try { window.history.pushState({ ...(window.history.state ?? {}), xsSheet: true }, ''); pushed = true; } catch { /* ignore */ } };
  const marked = () => !!(window.history.state as { xsSheet?: boolean } | null)?.xsSheet;
  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', () => {
      if (!pushed || marked()) return;
      pushed = false;
      const top = stack[stack.length - 1];
      if (stack.length > 1) mark();       // more sheets below: keep Back working for them
      top?.();
    });
  }
  return {
    open(close: () => void) {
      stack.push(close);
      if (pending) { clearTimeout(pending); pending = undefined; }
      if (!pushed) mark();
      return () => {
        const i = stack.lastIndexOf(close);
        if (i >= 0) stack.splice(i, 1);
        if (stack.length || !pushed) return;
        pending = window.setTimeout(() => {
          pending = undefined;
          if (stack.length || !pushed) return;
          pushed = false;
          if (marked()) window.history.back();   // closed from the app: drop our entry (unless the page moved on)
        }, 80);
      };
    },
  };
})();

export function Sheet({ title, onClose, onClosing, children, instant = false }: { title: string; onClose: () => void; onClosing?: () => void; children: ReactNode; instant?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  // A voice assistant must be immediately touchable when launched. Other
  // sheets keep the shared spring/drag behavior unchanged.
  const [physical] = useState(() =>
    !instant && window.matchMedia('(max-width: 719px)').matches &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const spring = useRef<Spring | null>(null);
  const tracker = useRef(new VelocityTracker());
  const drag = useRef<{ start: number; base: number; moved: boolean } | null>(null);
  const done = useRef(false);
  const closeRequested = useRef(false);
  const height = () => ref.current?.offsetHeight || 600;
  const openedAt = useRef(performance.now());

  const finish = useCallback(() => {
    if (done.current) return;
    done.current = true;
    onClose();
  }, [onClose]);

  const close = useCallback((velocity = 0) => {
    if (closeRequested.current) return;
    closeRequested.current = true;
    onClosing?.(); // Stop microphones and pending input before the exit animation.
    if (physical && spring.current) {
      spring.current.to(height(), SPRING.sheet, { velocity, onRest: finish });
    } else {
      setClosing(true);
      setTimeout(finish, 180);
    }
  }, [physical, finish, onClosing]);

  // Spring in from below before the first paint.
  useLayoutEffect(() => {
    if (!physical || !ref.current) return;
    const el = ref.current;
    const h = height();
    spring.current = new Spring(h, (y) => {
      el.style.transform = `translate3d(0, ${y}px, 0)`;
      if (backdrop.current) backdrop.current.style.opacity = String(Math.max(0, Math.min(1, 1 - y / h)));
    });
    spring.current.set(h);
    spring.current.to(0, SPRING.smooth);
    return () => spring.current?.stop();
  }, [physical]);

  // Phone Back gesture: close the top sheet instead of leaving the page.
  useEffect(() => sheetHistory.open(() => close()), [close]);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not([data-close])');
    if (window.matchMedia('(pointer: fine)').matches) first?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      prev?.focus();
    };
  }, [close]);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!physical || !spring.current || e.pointerType === 'mouse' || (e.target as HTMLElement).closest('button')) return;
    spring.current.stop(); // grab it mid-flight
    drag.current = { start: e.clientY, base: spring.current.value, moved: false };
    tracker.current.reset();
    tracker.current.add(e.clientY);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || !spring.current) return;
    const dy = e.clientY - d.start;
    if (!d.moved && Math.abs(dy) < 6) return; // small hysteresis before committing
    d.moved = true;
    tracker.current.add(e.clientY);
    const y = d.base + dy;
    spring.current.set(y < 0 ? -rubberband(-y, height()) : y);
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !spring.current) return;
    const v = d.moved ? tracker.current.velocity() : 0;
    const resting = spring.current.value + project(v);
    if (resting > height() * 0.45) close(v);
    else spring.current.to(0, Math.abs(v) > 300 ? SPRING.flick : SPRING.smooth, { velocity: v });
  };

  // Portal: sheets must sit above the tab bar, outside the page's
  // view-transition stacking context.
  return createPortal(
    <div className={`overlay ${physical ? 'physical' : ''} ${closing ? 'closing' : ''}`}>
      <div className="backdrop" ref={backdrop} onClick={() => { if (performance.now() - openedAt.current > 400) close(); }} aria-hidden />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="sheet-grab" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <span className="handle" aria-hidden />
          <div className="sheet-head">
            <h2>{title}</h2>
            <button className="btn ghost icon-btn" onClick={() => close()} aria-label="Close" data-close>
              <X size={20} />
            </button>
          </div>
        </div>
        {children}
      </div>
    </div>
  , document.body);
}

/** Smoothly expands or collapses its content (used for optional form fields). */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={`collapse ${open ? 'open' : ''}`} aria-hidden={!open}>
      <div>{children}</div>
    </div>
  );
}

/* ---------- Toasts ---------- */
type Toast = { id: number; text: string; tone: 'ok' | 'bad' };
const ToastContext = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'bad' ? 6000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone === 'bad' ? 'bad' : ''}`}>
            {t.tone === 'bad' ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ---------- Brand ---------- */
const BRAND = `${import.meta.env.BASE_URL}brand/`;

/**
 * Official Xelorsoft lockup. `onDark` always uses the Night artwork (for
 * Carbon panels); otherwise it follows the system theme.
 */
export function Logo({ width = 180, className = 'logo', onDark = false }: { width?: number; className?: string; onDark?: boolean }) {
  const height = Math.round((width * 496) / 1439);
  if (onDark) return <img className={className} src={`${BRAND}xelorsoft-on-dark.svg`} alt="Xelorsoft" width={width} height={height} />;
  return (
    <>
      <img className={`${className} only-light`} src={`${BRAND}xelorsoft-on-light.svg`} alt="Xelorsoft" width={width} height={height} />
      <img className={`${className} only-dark`} src={`${BRAND}xelorsoft-on-dark.svg`} alt="Xelorsoft" width={width} height={height} />
    </>
  );
}

/* ---------- Small pieces ---------- */
const STATUS: Record<string, { label: string; tone: string }> = {
  booked: { label: 'Booked', tone: 'info' },
  confirmed: { label: 'Confirmed', tone: 'ok' },
  arrived: { label: 'Arrived', tone: 'warn' },
  in_service: { label: 'In service', tone: 'warn' },
  completed: { label: 'Completed', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  no_show: { label: 'No-show', tone: 'bad' },
  paid: { label: 'Paid', tone: 'ok' },
  partial: { label: 'Part paid', tone: 'warn' },
  unpaid: { label: 'Unpaid', tone: 'bad' },
  void: { label: 'Void', tone: 'neutral' },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: 'neutral' };
  return <span className={`badge ${s.tone}`}>{s.label}</span>;
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'bad' | 'ok'; children: ReactNode }) {
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'info' ? Info : AlertTriangle;
  return (
    <div className={`notice ${tone}`} role={tone === 'bad' ? 'alert' : undefined}>
      <Icon size={18} />
      <div>{children}</div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 56 }} />
      ))}
    </div>
  );
}

export function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {error ? <span className="err">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = wrap.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
      if (el) setThumb({ x: el.offsetLeft, w: el.offsetWidth });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [value, options.length]);
  return (
    <div className="segmented" role="group" aria-label={label} ref={wrap}>
      {thumb && <span className="thumb" aria-hidden style={{ transform: `translateX(${thumb.x}px)`, width: thumb.w }} />}
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Link that opens a detail screen with a push transition. */
export function PushLink(props: LinkProps) {
  return <Link viewTransition {...props} onClick={(e) => { setTransition('push'); props.onClick?.(e); }} />;
}

/** Link back to a parent screen with a pop transition. */
export function BackLink(props: LinkProps) {
  return <Link viewTransition {...props} onClick={(e) => { setTransition('pop'); props.onClick?.(e); }} />;
}
