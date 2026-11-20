import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useCentre } from '../../app/centre';
import type { FloorState } from '../../lib/floor';
import { rpc, supabase } from '../../lib/supabase';

/** Live floor: refreshes on database changes (realtime) and every 10 s as a safety net. */
export function useFloorState() {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const fetchedAt = useRef(Date.now());
  const q = useQuery({
    queryKey: ['floor', centre.id],
    queryFn: async () => {
      const data = await rpc<FloorState>('floor_state', { p_centre: centre.id });
      fetchedAt.current = Date.now();
      return data;
    },
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
  });
  useEffect(() => {
    const refresh = () => void qc.invalidateQueries({ queryKey: ['floor', centre.id] });
    const ch = supabase.channel(`floor-${centre.id}`);
    for (const table of ['sessions', 'waitlist', 'resources', 'tabs']) {
      ch.on('postgres_changes', { event: '*', schema: 'public', table, filter: `centre_id=eq.${centre.id}` }, refresh);
    }
    ch.subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [centre.id, qc]);
  return { ...q, snapshotAt: q.dataUpdatedAt || fetchedAt.current };
}
