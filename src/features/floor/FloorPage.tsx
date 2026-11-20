import { LayoutGrid } from 'lucide-react';
import { useCentre } from '../../app/centre';
import { Empty } from '../../components/ui';

/** Placeholder until the floor designer (Day 3) and live floor (Day 4) land. */
export function FloorPage() {
  const { can } = useCentre();
  return (
    <div className="stack lg">
      <div className="page-head"><h1>Floor</h1></div>
      <div className="card">
        <Empty title="Your live floor is on its way">
          <p className="muted" style={{ maxWidth: 440, margin: '0 auto' }}>
            {can('floor.design')
              ? 'Soon you will draw your hall here, drop in pool and snooker tables, PS5 stations and RC tracks, and run every timer from this screen.'
              : 'Soon every table, console and track will show here with live timers.'}
          </p>
          <LayoutGrid size={28} aria-hidden style={{ opacity: 0.4, marginTop: 12 }} />
        </Empty>
      </div>
    </div>
  );
}
