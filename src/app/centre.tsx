import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import type { Centre, PlanCode, Role, Staff, Subscription } from '../lib/types';
import { useAuth } from './auth';

export type CentreContextValue = {
  centre: Centre;
  role: Role;
  me: Staff;
  subscription: Subscription | null;
  plan: PlanCode;
  canWrite: boolean;
  /** UI hint only — the database enforces every permission. */
  can: (permission: string) => boolean;
  /** Is a feature in the centre's plan? UI hint only — the database enforces it too. */
  hasFeature: (feature: string) => boolean;
};

const CentreContext = createContext<CentreContextValue | null>(null);

export function useCentre(): CentreContextValue {
  const value = useContext(CentreContext);
  if (!value) throw new Error('useCentre must be used inside a centre route');
  return value;
}

export function CentreProvider({ value, children }: { value: CentreContextValue; children: ReactNode }) {
  return <CentreContext.Provider value={value}>{children}</CentreContext.Provider>;
}

/** Centres the signed-in user works at (also links pending staff invites to this account). */
export function useMyCentres() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['my-centres', session?.user.id],
    enabled: !!session,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('my_home');   // claims invites, then lists centres — one call
      if (error) throw error;
      return (data ?? []) as { centre_id: string; name: string; slug: string; role: Role; city: string | null }[];
    },
  });
}

/** Loads a centre by slug plus the caller's role, permissions, plan and features. */
export function useCentreBySlug(slug: string | undefined) {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['centre', slug, session?.user.id],
    enabled: !!slug && !!session,
    queryFn: async (): Promise<CentreContextValue | null> => {
      // one call: centre + my staff row + subscription + permissions + features
      const { data, error } = await supabase.rpc('centre_context', { p_slug: slug! });
      if (error) throw error;
      if (!data) return null;
      const ctx = data as { centre: Centre; me: Staff; subscription: Subscription | null; plan: PlanCode; permissions: string[]; features: string[] };
      const permSet = new Set(ctx.permissions);
      const featureSet = new Set(ctx.features);
      // Subscription billing is not live yet: an active centre can always work.
      const canWrite = ctx.centre.status === 'active';
      return {
        centre: ctx.centre, role: ctx.me.role, me: ctx.me, subscription: ctx.subscription, plan: ctx.plan, canWrite,
        can: (p) => permSet.has(p), hasFeature: (f) => featureSet.has(f),
      };
    },
  });
}

/** Team list: small, shared by several screens. */
export function useTeam() {
  const { centre } = useCentre();
  const team = useQuery({
    queryKey: ['team', centre.id],
    queryFn: async () => {
      const { data, error } = await supabase.from('centre_staff').select('*').eq('centre_id', centre.id).order('sort').order('display_name');
      if (error) throw error;
      return data as Staff[];
    },
  });
  const all = team.data ?? [];
  return {
    loading: team.isPending,
    error: team.error,
    team: all,
    activeTeam: all.filter((s) => s.status === 'active'),
    staffName: (id: string | null | undefined) => all.find((s) => s.id === id)?.display_name ?? '',
  };
}

/** Invalidates everything that an edit can change. */
export function useRefresh() {
  const qc = useQueryClient();
  const { centre } = useCentre();
  return (...keys: string[]) => Promise.all((keys.length ? keys : ['dashboard', 'customers', 'customer', 'products', 'expenses'])
    .map((k) => qc.invalidateQueries({ queryKey: [k, centre.id] })));
}
