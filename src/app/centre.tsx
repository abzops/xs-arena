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
      await supabase.rpc('claim_invites');
      const { data, error } = await supabase.rpc('my_centres');
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
      const { data: centre, error } = await supabase.from('centres').select('*').eq('slug', slug!).maybeSingle();
      if (error) throw error;
      if (!centre) return null;
      const [staff, sub] = await Promise.all([
        supabase.from('centre_staff').select('*').eq('centre_id', centre.id).eq('user_id', session!.user.id).single(),
        supabase.from('centre_subscriptions').select('*').eq('centre_id', centre.id).maybeSingle(),
      ]);
      if (staff.error) throw staff.error;
      const me = staff.data as Staff;
      const subscription = (sub.data ?? null) as Subscription | null;
      const plan: PlanCode = subscription?.plan ?? 'pro';
      const [perms, feats] = await Promise.all([
        supabase.from('role_permissions').select('permission').eq('role', me.role),
        supabase.from('plan_features').select('feature').eq('plan', plan),
      ]);
      if (perms.error) throw perms.error;
      if (feats.error) throw feats.error;
      const permSet = new Set(perms.data.map((p) => p.permission as string));
      const featureSet = new Set(feats.data.map((f) => f.feature as string));
      // Subscription billing is not live yet: an active centre can always work.
      const canWrite = centre.status === 'active';
      return {
        centre: centre as Centre, role: me.role, me, subscription, plan, canWrite,
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
