// Realistic top-down drawings for floor items: snooker / pool tables, console stations, RC tracks.
// Everything is drawn inside the item's box (x, y, w, h) so the designer, live floor, booking page and TV all match.
import type { ReactNode } from 'react';
import type { Activity, Resource } from '../../lib/floor';

export type ArtKind = 'snooker' | 'pool' | 'console' | 'drift' | 'offroad' | 'generic';

export function artKind(a: Activity | undefined): ArtKind {
  if (!a) return 'generic';
  const n = `${a.icon} ${a.name}`.toLowerCase();
  if (n.includes('snooker')) return 'snooker';
  if (n.includes('pool') || n.includes('billiard') || n.includes('8 ball')) return 'pool';
  if (a.kind === 'console') return 'console';
  if (a.kind === 'track') return n.includes('off') || n.includes('mountain') || n.includes('dirt') ? 'offroad' : 'drift';
  return 'generic';
}

/** Shared gradients and patterns. `p` is a per-map prefix so ids stay unique on a page. */
export function ArtDefs({ p }: { p: string }) {
  return (
    <defs>
      <pattern id={`${p}-planks`} width="720" height="96" patternUnits="userSpaceOnUse">
        <rect width="720" height="96" className="fm-plank" />
        <rect y="24" width="720" height="24" className="fm-plank-alt" />
        <rect y="72" width="720" height="24" className="fm-plank-alt" />
        <path d="M0 24H720M0 48H720M0 72H720M0 96H720M180 0V24M610 0V24M420 24V48M90 48V72M520 48V72M300 72V96" className="fm-plank-line" />
      </pattern>
      <linearGradient id={`${p}-wood`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#8A5530" /><stop offset=".5" stopColor="#6E3F1F" /><stop offset="1" stopColor="#5A3218" />
      </linearGradient>
      <radialGradient id={`${p}-felt-snooker`} cx=".5" cy=".5" r=".7">
        <stop offset="0" stopColor="#2E9E5B" /><stop offset="1" stopColor="#1C7A41" />
      </radialGradient>
      <radialGradient id={`${p}-felt-pool`} cx=".5" cy=".5" r=".7">
        <stop offset="0" stopColor="#2E86C8" /><stop offset="1" stopColor="#1B5F98" />
      </radialGradient>
      <radialGradient id={`${p}-ball`} cx=".35" cy=".3" r=".75">
        <stop offset="0" stopColor="#fff" stopOpacity=".85" /><stop offset=".35" stopColor="#fff" stopOpacity="0" />
      </radialGradient>
      <linearGradient id={`${p}-sofa`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#5E6270" /><stop offset="1" stopColor="#474A55" />
      </linearGradient>
      <pattern id={`${p}-kerb`} width="40" height="40" patternUnits="userSpaceOnUse">
        <rect width="20" height="40" fill="#E53935" /><rect x="20" width="20" height="40" fill="#fff" />
      </pattern>
    </defs>
  );
}

/** Small stable pseudo-random numbers from an id (so scattered balls don't jump around on every render). */
function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}

const POOL_COLOURS = ['#F5C518', '#1E5BD8', '#E53935', '#6A1B9A', '#FB8C00', '#2E7D32', '#8D1C1C', '#111111'];

function Ball({ x, y, r, fill, p, stripe }: { x: number; y: number; r: number; fill: string; p: string; stripe?: boolean }) {
  return (
    <g>
      <circle cx={x} cy={y} r={r} fill={stripe ? '#fff' : fill} />
      {stripe && <path d={`M${x - r * 0.9} ${y - r * 0.42} H${x + r * 0.9} A ${r} ${r} 0 0 1 ${x + r * 0.9} ${y + r * 0.42} H${x - r * 0.9} A ${r} ${r} 0 0 1 ${x - r * 0.9} ${y - r * 0.42} Z`} fill={fill} />}
      <circle cx={x} cy={y} r={r} fill={`url(#${p}-ball)`} />
    </g>
  );
}

function Table({ r, kind, busy, p }: { r: Resource; kind: 'snooker' | 'pool'; busy: boolean; p: string }) {
  const { x, y, w, h } = r;
  const t = Math.min(w, h) * 0.1;                      // rail width
  const fx = x + t, fy = y + t, fw = w - 2 * t, fh = h - 2 * t;
  const pr = t * 0.5;                                   // pocket radius
  const br = Math.max(2.5, fh * (kind === 'snooker' ? 0.03 : 0.045));
  const pockets: [number, number][] = [[x + t * 0.8, y + t * 0.8], [x + w / 2, y + t * 0.65], [x + w - t * 0.8, y + t * 0.8],
    [x + t * 0.8, y + h - t * 0.8], [x + w / 2, y + h - t * 0.65], [x + w - t * 0.8, y + h - t * 0.8]];
  const sights: ReactNode[] = [];
  for (const k of [1, 2, 3, 5, 6, 7]) {
    sights.push(<circle key={`t${k}`} cx={x + (w * k) / 8} cy={y + t * 0.45} r={t * 0.08} className="fm-sight" />);
    sights.push(<circle key={`b${k}`} cx={x + (w * k) / 8} cy={y + h - t * 0.45} r={t * 0.08} className="fm-sight" />);
  }
  const balls: ReactNode[] = [];
  const rand = rng(r.id);
  if (kind === 'snooker') {
    const baulk = fx + fw * 0.21, cy = fy + fh / 2;
    const colours: [number, number, string][] = [[baulk, cy, '#6D4C41'], [baulk, cy - fh * 0.17, '#2E7D32'], [baulk, cy + fh * 0.17, '#F9A825'],
      [fx + fw / 2, cy, '#1E5BD8'], [fx + fw * 0.75, cy, '#EC407A'], [fx + fw * 0.91, cy, '#111']];
    if (!busy) {
      colours.forEach(([bx, by, c], i) => balls.push(<Ball key={`c${i}`} x={bx} y={by} r={br} fill={c} p={p} />));
      let k = 0;
      for (let row = 0; row < 5; row++) for (let j = 0; j <= row; j++) {
        balls.push(<Ball key={`r${k++}`} x={fx + fw * 0.75 + br * 2.2 + row * br * 1.75} y={cy + (j - row / 2) * br * 2.05} r={br} fill="#C62828" p={p} />);
      }
      balls.push(<Ball key="cue" x={baulk - fh * 0.08} y={cy + fh * 0.06} r={br} fill="#FAFAFA" p={p} />);
    } else {
      for (let i = 0; i < 9; i++) balls.push(<Ball key={`s${i}`} x={fx + br * 2 + rand() * (fw - br * 4)} y={fy + br * 2 + rand() * (fh - br * 4)} r={br} fill={i < 5 ? '#C62828' : ['#1E5BD8', '#EC407A', '#111', '#F9A825'][i - 5]} p={p} />);
      balls.push(<Ball key="cue" x={fx + br * 2 + rand() * (fw - br * 4)} y={fy + br * 2 + rand() * (fh - br * 4)} r={br} fill="#FAFAFA" p={p} />);
    }
    return (
      <g className="fm-art">
        <rect x={x + 4} y={y + 6} width={w} height={h} rx={t * 0.7} className="fm-shadow" />
        <rect x={x} y={y} width={w} height={h} rx={t * 0.7} fill={`url(#${p}-wood)`} />
        <rect x={fx - t * 0.18} y={fy - t * 0.18} width={fw + t * 0.36} height={fh + t * 0.36} rx={t * 0.2} fill="#14592F" />
        <rect x={fx} y={fy} width={fw} height={fh} rx={t * 0.12} fill={`url(#${p}-felt-snooker)`} />
        <line x1={baulk} y1={fy} x2={baulk} y2={fy + fh} className="fm-felt-line" />
        <path d={`M${baulk} ${cy - fh * 0.17} A ${fh * 0.17} ${fh * 0.17} 0 0 0 ${baulk} ${cy + fh * 0.17}`} className="fm-felt-line" />
        {pockets.map(([px, py], i) => <circle key={i} cx={px} cy={py} r={pr} fill="#0B0B0B" />)}
        {sights}
        {balls}
      </g>
    );
  }
  // pool
  const cy = fy + fh / 2;
  if (!busy) {
    const order = [0, 8, 1, 9, 7, 2, 10, 3, 11, 4, 12, 5, 13, 6, 14];
    let k = 0;
    for (let row = 0; row < 5; row++) for (let j = 0; j <= row; j++) {
      const n = order[k++];
      const c = n === 7 ? '#111111' : POOL_COLOURS[n % 8];
      balls.push(<Ball key={`r${k}`} x={fx + fw * 0.72 + row * br * 1.75} y={cy + (j - row / 2) * br * 2.05} r={br} fill={c} stripe={n > 7} p={p} />);
    }
    balls.push(<Ball key="cue" x={fx + fw * 0.25} y={cy} r={br} fill="#FAFAFA" p={p} />);
  } else {
    for (let i = 0; i < 8; i++) balls.push(<Ball key={`s${i}`} x={fx + br * 2 + rand() * (fw - br * 4)} y={fy + br * 2 + rand() * (fh - br * 4)} r={br} fill={POOL_COLOURS[i % 8]} stripe={i % 3 === 1} p={p} />);
    balls.push(<Ball key="cue" x={fx + br * 2 + rand() * (fw - br * 4)} y={fy + br * 2 + rand() * (fh - br * 4)} r={br} fill="#FAFAFA" p={p} />);
  }
  return (
    <g className="fm-art">
      <rect x={x + 4} y={y + 6} width={w} height={h} rx={t * 0.7} className="fm-shadow" />
      <rect x={x} y={y} width={w} height={h} rx={t * 0.7} fill={`url(#${p}-wood)`} />
      <rect x={fx - t * 0.18} y={fy - t * 0.18} width={fw + t * 0.36} height={fh + t * 0.36} rx={t * 0.2} fill="#164F7E" />
      <rect x={fx} y={fy} width={fw} height={fh} rx={t * 0.12} fill={`url(#${p}-felt-pool)`} />
      <circle cx={fx + fw * 0.25} cy={cy} r={br * 0.35} className="fm-spot" />
      <circle cx={fx + fw * 0.72} cy={cy} r={br * 0.35} className="fm-spot" />
      {pockets.map(([px, py], i) => <circle key={i} cx={px} cy={py} r={pr} fill="#0B0B0B" />)}
      {sights}
      {balls}
    </g>
  );
}

function Console({ r, glow, p }: { r: Resource; glow: string; p: string }) {
  const { x, y, w, h } = r;
  const tvW = w * 0.62, tvX = x + (w - tvW) / 2;
  const sofaY = y + h * 0.66, sofaH = h * 0.3, sofaX = x + w * 0.1, sofaW = w * 0.8, arm = sofaW * 0.09;
  const ctrl = (cx: number, cy: number) => (
    <g transform={`translate(${cx} ${cy})`}>
      <rect x={-h * 0.05} y={-h * 0.022} width={h * 0.1} height={h * 0.044} rx={h * 0.02} fill="#F2F2F2" />
      <circle cx={-h * 0.028} cy={h * 0.012} r={h * 0.009} fill="#1B1B1B" /><circle cx={h * 0.028} cy={h * 0.012} r={h * 0.009} fill="#1B1B1B" />
    </g>
  );
  return (
    <g className="fm-art">
      <rect x={x} y={y} width={w} height={h} rx={Math.min(w, h) * 0.06} className="fm-rug" />
      {/* TV stand + TV */}
      <rect x={tvX - w * 0.04} y={y + h * 0.04} width={tvW + w * 0.08} height={h * 0.13} rx={4} className="fm-stand" />
      <rect x={tvX} y={y + h * 0.065} width={tvW} height={h * 0.05} rx={3} fill="#0E0E10" />
      <rect x={tvX + tvW * 0.04} y={y + h * 0.075} width={tvW * 0.92} height={h * 0.03} rx={2} fill={glow} opacity=".85" />
      {/* console */}
      <rect x={tvX + tvW + w * 0.005} y={y + h * 0.055} width={w * 0.05} height={h * 0.09} rx={3} fill="#F4F4F6" stroke="#1B1B1B" strokeWidth={1.5} />
      {/* coffee table */}
      <rect x={x + w * 0.33} y={y + h * 0.42} width={w * 0.34} height={h * 0.14} rx={6} className="fm-stand" opacity=".9" />
      {/* sofa */}
      <rect x={sofaX + 3} y={sofaY + 5} width={sofaW} height={sofaH} rx={sofaH * 0.25} className="fm-shadow" />
      <rect x={sofaX} y={sofaY} width={sofaW} height={sofaH} rx={sofaH * 0.25} fill={`url(#${p}-sofa)`} />
      <rect x={sofaX} y={sofaY + sofaH * 0.62} width={sofaW} height={sofaH * 0.38} rx={sofaH * 0.18} fill="#3C3F48" />
      <rect x={sofaX} y={sofaY} width={arm} height={sofaH} rx={arm * 0.4} fill="#3C3F48" />
      <rect x={sofaX + sofaW - arm} y={sofaY} width={arm} height={sofaH} rx={arm * 0.4} fill="#3C3F48" />
      <line x1={x + w / 2} y1={sofaY + sofaH * 0.08} x2={x + w / 2} y2={sofaY + sofaH * 0.6} stroke="#3C3F48" strokeWidth={2} />
      {ctrl(x + w * 0.36, sofaY + sofaH * 0.32)}
      {ctrl(x + w * 0.64, sofaY + sofaH * 0.32)}
    </g>
  );
}

/** A loop shape (ellipse for round items, stadium for rectangles), inset by `i`. */
function loop(r: Resource, i: number, props: Record<string, unknown>, key?: string) {
  const { x, y, w, h } = r;
  if (r.shape === 'round') return <ellipse key={key} cx={x + w / 2} cy={y + h / 2} rx={Math.max(1, w / 2 - i)} ry={Math.max(1, h / 2 - i)} {...props} />;
  const rad = Math.max(1, Math.min(w, h) / 2 - i);
  return <rect key={key} x={x + i} y={y + i} width={Math.max(1, w - 2 * i)} height={Math.max(1, h - 2 * i)} rx={rad} {...props} />;
}

function Track({ r, kind, p }: { r: Resource; kind: 'drift' | 'offroad'; p: string }) {
  const { x, y, w, h } = r;
  const lane = Math.min(w, h) * 0.2;
  const rand = rng(r.id);
  if (kind === 'drift') {
    return (
      <g className="fm-art">
        {loop(r, -4, { className: 'fm-shadow', transform: 'translate(4 6)' })}
        {loop(r, 0, { fill: `url(#${p}-kerb)` })}
        {loop(r, lane * 0.08, { fill: '#45484E' })}
        {loop(r, lane / 2, { fill: 'none', stroke: '#F5F5F5', strokeWidth: 3, strokeDasharray: '22 18', opacity: 0.8 })}
        {loop(r, lane, { fill: `url(#${p}-kerb)` })}
        {loop(r, lane + lane * 0.08, { fill: '#4C9A4A' })}
        {loop(r, lane + lane * 0.6, { fill: 'none', stroke: '#5DAE59', strokeWidth: lane * 0.25, opacity: 0.6 })}
        {/* start / finish */}
        <g transform={`translate(${x + w / 2 - lane * 0.08} ${y + h - lane})`}>
          {Array.from({ length: 8 }, (_, i) => (
            <rect key={i} x={(i % 2) * (lane * 0.08)} y={i * (lane / 8)} width={lane * 0.08} height={lane / 8} fill={i % 2 ? '#111' : '#fff'} />
          ))}
          {Array.from({ length: 8 }, (_, i) => (
            <rect key={`b${i}`} x={((i + 1) % 2) * (lane * 0.08)} y={i * (lane / 8)} width={lane * 0.08} height={lane / 8} fill={i % 2 ? '#fff' : '#111'} />
          ))}
        </g>
      </g>
    );
  }
  // offroad: dirt lane, sandy infield, ramps and tyre stacks
  const ramps: ReactNode[] = [];
  const cx = x + w / 2, cy = y + h / 2;
  for (const [ang, len] of [[200, 0.9], [340, 0.9]] as [number, number][]) {
    const a = (ang * Math.PI) / 180;
    const rx = (w / 2 - lane / 2) * Math.cos(a), ry = (h / 2 - lane / 2) * Math.sin(a);
    ramps.push(
      <g key={ang} transform={`translate(${cx + rx} ${cy + ry}) rotate(${ang + 90})`}>
        <rect x={-lane * len / 2} y={-lane * 0.16} width={lane * len} height={lane * 0.32} rx={4} fill="#6B4A2B" />
        <rect x={-lane * len / 2} y={-lane * 0.16} width={lane * len} height={lane * 0.1} rx={3} fill="#8E6A43" />
      </g>,
    );
  }
  const tyres: ReactNode[] = [];
  for (let i = 0; i < 7; i++) {
    const a = rand() * Math.PI * 2, d = 0.35 + rand() * 0.25;
    tyres.push(<circle key={i} cx={cx + (w / 2 - lane) * d * Math.cos(a)} cy={cy + (h / 2 - lane) * d * Math.sin(a)} r={lane * 0.12} fill="none" stroke="#1E1E1E" strokeWidth={lane * 0.07} />);
  }
  const tufts: ReactNode[] = [];
  for (let i = 0; i < 14; i++) {
    const a = rand() * Math.PI * 2, d = rand() * 0.8;
    tufts.push(<circle key={i} cx={cx + (w / 2 - lane * 1.2) * d * Math.cos(a)} cy={cy + (h / 2 - lane * 1.2) * d * Math.sin(a)} r={lane * (0.05 + rand() * 0.08)} fill="#7FA05A" opacity=".75" />);
  }
  return (
    <g className="fm-art">
      {loop(r, -4, { className: 'fm-shadow', transform: 'translate(4 6)' })}
      {loop(r, 0, { fill: '#5E8A45' })}
      {loop(r, lane * 0.06, { fill: '#8A6340' })}
      {loop(r, lane / 2, { fill: 'none', stroke: '#6E4D30', strokeWidth: lane * 0.18, strokeDasharray: '6 14', opacity: 0.7 })}
      {loop(r, lane, { fill: '#C9A874' })}
      {tufts}
      {ramps}
      {tyres}
    </g>
  );
}

function Generic({ r, fill }: { r: Resource; fill: string }) {
  const { x, y, w, h } = r;
  if (r.shape === 'round') return <g className="fm-art"><ellipse cx={x + w / 2 + 3} cy={y + h / 2 + 5} rx={w / 2} ry={h / 2} className="fm-shadow" /><ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} fill={fill} className="fm-generic" /></g>;
  if (r.shape === 'polygon' && r.points?.length) {
    const pts = r.points.map(([px, py]) => `${x + px},${y + py}`).join(' ');
    return <g className="fm-art"><polygon points={pts} fill={fill} className="fm-generic" /></g>;
  }
  const rad = Math.min(w, h) * 0.12;
  return <g className="fm-art"><rect x={x + 3} y={y + 5} width={w} height={h} rx={rad} className="fm-shadow" /><rect x={x} y={y} width={w} height={h} rx={rad} fill={fill} className="fm-generic" /></g>;
}

export function ItemArt({ r, a, busy, glow, p }: { r: Resource; a: Activity | undefined; busy: boolean; glow: string; p: string }) {
  const k = artKind(a);
  if (r.shape === 'polygon' && r.points?.length) return <Generic r={r} fill={a?.color ?? '#8E8E93'} />;
  if (k === 'snooker' || k === 'pool') return <Table r={r} kind={k} busy={busy} p={p} />;
  if (k === 'console') return <Console r={r} glow={glow} p={p} />;
  if (k === 'drift' || k === 'offroad') return <Track r={r} kind={k} p={p} />;
  return <Generic r={r} fill={a?.color ?? '#8E8E93'} />;
}

/** Outline of the item (for the status ring and selection), `grow` units outside the art. */
export function Outline({ r, a, grow, className }: { r: Resource; a: Activity | undefined; grow: number; className: string }) {
  const { x, y, w, h } = r;
  if (r.shape === 'polygon' && r.points?.length) return <polygon points={r.points.map(([px, py]) => `${x + px},${y + py}`).join(' ')} className={className} />;
  if (r.shape === 'round') return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2 + grow} ry={h / 2 + grow} className={className} />;
  const k = artKind(a);
  const rad = (k === 'drift' || k === 'offroad' ? Math.min(w, h) / 2 : Math.min(w, h) * 0.08) + grow;
  return <rect x={x - grow} y={y - grow} width={w + grow * 2} height={h + grow * 2} rx={rad} className={className} />;
}
