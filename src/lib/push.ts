// Staff phone alerts via web push: register the service worker, subscribe, save the subscription for this centre.
import { keyBytes } from './b64';
import { supabase } from './supabase';

const KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
const SW = `${import.meta.env.BASE_URL}assets/push-sw.js`;
const SCOPE = `${import.meta.env.BASE_URL}assets/`;

export function pushSupported(): boolean {
  return !!KEY && typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function registration() {
  return (await navigator.serviceWorker.getRegistration(SCOPE)) ?? navigator.serviceWorker.register(SW, { scope: SCOPE });
}

export async function currentPush(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration(SCOPE);
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Ask permission, subscribe this device and save it for the centre. Returns false if the user said no. */
export async function enablePush(centreId: string): Promise<boolean> {
  if (!pushSupported()) return false;
  if ((await Notification.requestPermission()) !== 'granted') return false;
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription())
    ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(KEY!) as BufferSource });
  const j = sub.toJSON();
  const { error } = await supabase.rpc('save_push_subscription', {
    p_centre: centreId, p_endpoint: sub.endpoint, p_p256dh: j.keys?.p256dh, p_auth: j.keys?.auth, p_user_agent: navigator.userAgent.slice(0, 200),
  });
  if (error) throw error;
  return true;
}

export async function disablePush(): Promise<void> {
  const sub = await currentPush();
  if (!sub) return;
  await supabase.rpc('delete_push_subscription', { p_endpoint: sub.endpoint });
  await sub.unsubscribe();
}
