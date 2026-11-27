// XS Arena — staff phone alerts (web push). Scope /assets/ because the host serves only /assets/* as static files.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: e.data ? e.data.text() : 'XS Arena' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'XS Arena', {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: true,
    icon: '/brand/icon-192.png',
    badge: '/brand/icon-192.png',
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) { await c.focus(); if ('navigate' in c) { try { await c.navigate(url); } catch { /* cross-scope */ } } return; }
    }
    await self.clients.openWindow(url);
  })());
});
