// One SVG renderer for the designer, the live floor and the TV display, so they always match.
import { useId, useRef, type PointerEvent as RPE, type ReactNode } from 'react';
import { formatINR } from '../../lib/money';
import { ArtDefs, ItemArt, Outline } from './Art';
import { FIXTURE_LABEL, playedSeconds, timerText, toneOf, type Activity, type Fixture, type Floor, type Resource, type Tone } from '../../lib/floor';

export const TONE_FILL: Record<Tone, string> = {
  free: 'var(--fm-free)', playing: 'var(--fm-playing)', paused: 'var(--fm-paused)', soon: 'var(--fm-soon)', over: 'var(--fm-over)', off: 'var(--fm-off)',
};

type Mode = 'live' | 'design' | 'tv';
export type DragKind = { kind: 'resource' | 'fixture'; id: string; handle: 'move' | 'resize' } | { kind: 'vertex'; index: number; handle: 'move' };

export function FloorMap({
  floor, resources, activities, mode, selectedId, onSelect, snapshotAt = 0, now = 0, showMoney = true, showNames = true,
  editOutline = false, onDrag, onDragEnd, children, className, busyText, highlight,
}: {
  floor: Floor; resources: Resource[]; activities: Activity[]; mode: Mode; selectedId?: string | null;
  onSelect?: (id: string | null, kind?: 'resource' | 'fixture') => void; snapshotAt?: number; now?: number; showMoney?: boolean; showNames?: boolean;
  editOutline?: boolean; onDrag?: (d: DragKind, x: number, y: number, dx: number, dy: number) => void; onDragEnd?: () => void;
  children?: ReactNode; className?: string;
  /** Public views: show this instead of a timer on busy items (e.g. "Busy"). */ busyText?: string;
  /** Public views: fade items that aren't this activity. */ highlight?: string | null;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const p = `fm${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const drag = useRef<{ d: DragKind; sx: number; sy: number; moved: boolean } | null>(null);
  const act = (id: string) => activities.find((a) => a.id === id);
  const pad = 40;
  const vb = `${-pad} ${-pad} ${floor.width + pad * 2} ${floor.height + pad * 2}`;
  const outline = floor.outline.length >= 3 ? floor.outline : [[0, 0], [floor.width, 0], [floor.width, floor.height], [0, floor.height]] as [number, number][];

  const toFloor = (e: RPE) => {
    const el = svg.current!;
    const pt = el.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(el.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  };
  const start = (d: DragKind) => (e: RPE) => {
    if (mode !== 'design') return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = toFloor(e);
    drag.current = { d, sx: p.x, sy: p.y, moved: false };
    if (d.kind !== 'vertex') onSelect?.(d.id, d.kind);
  };
  const move = (e: RPE) => {
    const g = drag.current;
    if (!g || !onDrag) return;
    const p = toFloor(e);
    const dx = p.x - g.sx, dy = p.y - g.sy;
    if (!g.moved && Math.hypot(dx, dy) < 4) return;
    g.moved = true;
    onDrag(g.d, p.x, p.y, dx, dy);
    g.sx = p.x; g.sy = p.y;
  };
  const end = () => { if (drag.current?.moved) onDragEnd?.(); drag.current = null; };

  return (
    <svg ref={svg} className={`floor-map fm-${mode} ${className ?? ''}`} viewBox={vb} preserveAspectRatio="xMidYMid meet"
      onPointerMove={move} onPointerUp={end} onPointerCancel={end} onPointerDown={() => onSelect?.(null)} role="img" aria-label={`${floor.name} floor plan`}>
      <ArtDefs p={p} />
      <polygon className="fm-hall-shadow" points={outline.map((q) => q.join(',')).join(' ')} transform="translate(0 10)" />
      <polygon className="fm-hall" points={outline.map((q) => q.join(',')).join(' ')} style={{ fill: `url(#${p}-planks)` }} />
      {mode === 'design' && <Grid w={floor.width} h={floor.height} />}
      {floor.fixtures.map((f) => <FixtureShape key={f.id} f={f} selected={selectedId === f.id} onDown={start({ kind: 'fixture', id: f.id, handle: 'move' })}
        onResize={start({ kind: 'fixture', id: f.id, handle: 'resize' })} design={mode === 'design'} />)}
      {resources.map((r) => {
        const a = act(r.activity_id);
        const s = r.session;
        const played = s ? playedSeconds(s, snapshotAt, now) : 0;
        const tone = toneOf(r, played);
        const design = mode === 'design';
        const colour = design ? (a?.color ?? '#888') : TONE_FILL[tone];
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        const sel = selectedId === r.id;
        const small = Math.min(r.w, r.h);
        const fs = Math.min(mode === 'tv' ? 56 : 40, Math.max(design ? 18 : mode === 'tv' ? 30 : 24, small * 0.16));
        const ring = Math.max(8, small * 0.035);
        const main = design ? r.name : tone === 'off' ? 'Out of service' : s ? (busyText ?? `${timerText(s, played)}${s.planned_minutes ? (s.planned_minutes * 60 - played >= 0 ? ' left' : ' over') : ''}`) : 'Free';
        const sub = !design && s && (showNames || showMoney)
          ? [showNames ? s.customer?.name?.split(' ')[0] : null, showMoney && s.cost_paise != null ? formatINR(s.cost_paise) : null, s.status === 'paused' ? 'Paused' : null].filter(Boolean).join(' · ')
          : '';
        // label chip, counter-rotated so it always reads upright
        const nameFs = fs * 0.62, mainFs = design ? fs * 0.8 : fs, subFs = fs * 0.52;
        const lines = design ? [mainFs] : [nameFs, mainFs, ...(sub ? [subFs] : [])];
        const chipH = lines.reduce((t, l) => t + l * 1.18, 0) + fs * 0.5;
        const longest = Math.max(...(design ? [r.name.length * mainFs * 0.56] : [r.name.length * nameFs * 0.56, main.length * mainFs * 0.6, sub.length * subFs * 0.55]));
        const chipW = Math.min(Math.max(r.w, r.h) * 0.92, longest + fs * 1.1);
        let ty = cy - chipH / 2 + fs * 0.25;
        return (
          <g key={r.id} className={`fm-res tone-${tone} ${sel ? 'sel' : ''} ${highlight && r.activity_id !== highlight ? 'fm-faded' : ''}`} transform={`rotate(${r.rotation} ${cx} ${cy})`}
            onPointerDown={design ? start({ kind: 'resource', id: r.id, handle: 'move' }) : (e) => e.stopPropagation()}
            onClick={design ? undefined : (e) => { e.stopPropagation(); onSelect?.(r.id, 'resource'); }}
            role="button" aria-label={`${r.name}${!design ? `, ${tone}` : ''}`}>
            <g className={tone === 'off' && !design ? 'fm-dim' : undefined}>
              <ItemArt r={r} a={a} busy={!design && !!s} glow={colour} p={p} />
            </g>
            {!design && <g style={{ stroke: colour, strokeWidth: ring }}><Outline r={r} a={a} grow={ring / 2 + 3} className="fm-ring" /></g>}
            {sel && <g style={{ strokeWidth: Math.max(6, ring * 0.8) }}><Outline r={r} a={a} grow={ring + 8} className="fm-sel" /></g>}
            <g transform={`rotate(${-r.rotation} ${cx} ${cy})`} className="fm-text">
              <rect x={cx - chipW / 2} y={cy - chipH / 2} width={chipW} height={chipH} rx={Math.min(chipH / 2, fs * 0.6)} className="fm-chip" style={{ fill: colour }} />
              {lines.map((size, i) => {
                const yy = ty + size * 0.59; ty += size * 1.18;
                const text = design ? main : [r.name, main, sub][i];
                const cls = design ? 'fm-name' : ['fm-name', 'fm-timer', 'fm-sub'][i];
                return <text key={i} x={cx} y={yy} fontSize={size} textAnchor="middle" dominantBaseline="central" className={cls}>{text}</text>;
              })}
            </g>
            {design && sel && (
              <rect x={r.x + r.w - 22} y={r.y + r.h - 22} width={44} height={44} rx={10} className="fm-handle"
                onPointerDown={start({ kind: 'resource', id: r.id, handle: 'resize' })} aria-label="Resize" />
            )}
          </g>
        );
      })}
      {mode === 'design' && editOutline && outline.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={22} className="fm-vertex" onPointerDown={start({ kind: 'vertex', index: i, handle: 'move' })} />
      ))}
      {children}
    </svg>
  );
}

function Grid({ w, h }: { w: number; h: number }) {
  const lines: ReactNode[] = [];
  for (let x = 100; x < w; x += 100) lines.push(<line key={`x${x}`} x1={x} y1={0} x2={x} y2={h} />);
  for (let y = 100; y < h; y += 100) lines.push(<line key={`y${y}`} x1={0} y1={y} x2={w} y2={y} />);
  return <g className="fm-grid">{lines}</g>;
}

function FixtureShape({ f, selected, onDown, onResize, design }: { f: Fixture; selected: boolean; onDown: (e: RPE) => void; onResize: (e: RPE) => void; design: boolean }) {
  const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
  const fs = Math.max(16, Math.min(f.w, f.h) * 0.3);
  return (
    <g className={`fm-fixture fx-${f.type} ${selected ? 'sel' : ''}`} transform={`rotate(${f.rotation} ${cx} ${cy})`} onPointerDown={onDown}>
      <rect x={f.x} y={f.y} width={f.w} height={f.h} rx={f.type === 'wall' ? 2 : 12} />
      {f.type !== 'wall' && (
        <text x={cx} y={cy} fontSize={fs} textAnchor="middle" dominantBaseline="middle" transform={`rotate(${-f.rotation} ${cx} ${cy})`}>
          {f.label || FIXTURE_LABEL[f.type]}
        </text>
      )}
      {design && selected && <rect x={f.x + f.w - 22} y={f.y + f.h - 22} width={44} height={44} rx={10} className="fm-handle" onPointerDown={onResize} />}
    </g>
  );
}
