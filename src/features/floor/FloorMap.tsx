// One SVG renderer for the designer, the live floor and the TV display, so they always match.
import { useRef, type PointerEvent as RPE, type ReactNode } from 'react';
import { formatINR } from '../../lib/money';
import { FIXTURE_LABEL, playedSeconds, timerText, toneOf, type Activity, type Fixture, type Floor, type Resource, type Tone } from '../../lib/floor';

export const TONE_FILL: Record<Tone, string> = {
  free: 'var(--fm-free)', playing: 'var(--fm-playing)', paused: 'var(--fm-paused)', soon: 'var(--fm-soon)', over: 'var(--fm-over)', off: 'var(--fm-off)',
};

type Mode = 'live' | 'design' | 'tv';
export type DragKind = { kind: 'resource' | 'fixture'; id: string; handle: 'move' | 'resize' } | { kind: 'vertex'; index: number; handle: 'move' };

export function FloorMap({
  floor, resources, activities, mode, selectedId, onSelect, snapshotAt = 0, now = 0, showMoney = true, showNames = true,
  editOutline = false, onDrag, onDragEnd, children, className,
}: {
  floor: Floor; resources: Resource[]; activities: Activity[]; mode: Mode; selectedId?: string | null;
  onSelect?: (id: string | null, kind?: 'resource' | 'fixture') => void; snapshotAt?: number; now?: number; showMoney?: boolean; showNames?: boolean;
  editOutline?: boolean; onDrag?: (d: DragKind, x: number, y: number, dx: number, dy: number) => void; onDragEnd?: () => void;
  children?: ReactNode; className?: string;
}) {
  const svg = useRef<SVGSVGElement>(null);
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
      <polygon className="fm-hall" points={outline.map((p) => p.join(',')).join(' ')} />
      {mode === 'design' && <Grid w={floor.width} h={floor.height} />}
      {floor.fixtures.map((f) => <FixtureShape key={f.id} f={f} selected={selectedId === f.id} onDown={start({ kind: 'fixture', id: f.id, handle: 'move' })}
        onResize={start({ kind: 'fixture', id: f.id, handle: 'resize' })} design={mode === 'design'} />)}
      {resources.map((r) => {
        const a = act(r.activity_id);
        const s = r.session;
        const played = s ? playedSeconds(s, snapshotAt, now) : 0;
        const tone = toneOf(r, played);
        const fill = mode === 'design' ? (a?.color ?? '#888') : TONE_FILL[tone];
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        const sel = selectedId === r.id;
        const fs = Math.max(mode === 'design' ? 18 : 30, Math.min(r.w, r.h) * 0.2);
        return (
          <g key={r.id} className={`fm-res tone-${tone} ${sel ? 'sel' : ''}`} transform={`rotate(${r.rotation} ${cx} ${cy})`}
            onPointerDown={mode === 'design' ? start({ kind: 'resource', id: r.id, handle: 'move' }) : (e) => { e.stopPropagation(); onSelect?.(r.id, 'resource'); }}
            role="button" aria-label={`${r.name}${mode !== 'design' ? `, ${tone}` : ''}`}>
            {r.shape === 'round'
              ? <ellipse cx={cx} cy={cy} rx={r.w / 2} ry={r.h / 2} fill={fill} className="fm-shape" />
              : r.shape === 'polygon' && r.points?.length
                ? <polygon points={r.points.map(([px, py]) => `${r.x + px},${r.y + py}`).join(' ')} fill={fill} className="fm-shape" />
                : <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={Math.min(r.w, r.h) * 0.12} fill={fill} className="fm-shape" />}
            <g transform={`rotate(${-r.rotation} ${cx} ${cy})`} className="fm-text">
              <text x={cx} y={cy - (mode === 'design' ? 0 : fs * 0.55)} fontSize={fs * 0.8} textAnchor="middle" dominantBaseline="middle" className="fm-name">{r.name}</text>
              {mode !== 'design' && (
                <>
                  <text x={cx} y={cy + fs * 0.45} fontSize={fs * 1.05} textAnchor="middle" dominantBaseline="middle" className="fm-timer">
                    {tone === 'off' ? 'Out of service' : s ? timerText(s, played) : 'Free'}
                  </text>
                  {s && (showNames || showMoney) && (
                    <text x={cx} y={cy + fs * 1.3} fontSize={fs * 0.62} textAnchor="middle" dominantBaseline="middle" className="fm-sub">
                      {[showNames ? s.customer?.name?.split(' ')[0] : null, showMoney && s.cost_paise != null ? formatINR(s.cost_paise) : null,
                        s.status === 'paused' ? 'Paused' : null].filter(Boolean).join(' · ')}
                    </text>
                  )}
                </>
              )}
            </g>
            {mode === 'design' && sel && (
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
