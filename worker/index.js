// XS Arena edge worker (Cloudflare) — arena.xelorsoft.com
// Serves the built app from the `deploy` branch of abzops/xs-arena (written by
// .github/workflows/deploy.yml), with security headers and SPA routing.
// Hashed files under /assets/ are immutable; index.html is revalidated.
const ORIGIN = 'https://raw.githubusercontent.com/abzops/xs-arena/deploy';
const TYPES = {
  js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', html: 'text/html; charset=utf-8', svg: 'image/svg+xml',
  png: 'image/png', woff2: 'font/woff2', woff: 'font/woff', webmanifest: 'application/manifest+json', json: 'application/json', txt: 'text/plain',
};
const SEC = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(self), microphone=(self), geolocation=()', 'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

async function fromOrigin(path, ttl) {
  const r = await fetch(`${ORIGIN}${path}`, { cf: { cacheTtl: ttl, cacheEverything: true } });
  return r.ok ? r : null;
}


// Link previews for links customers see (booking page, ticket, receipt): show the CENTRE's name,
// not the XS Arena landing preview. Other pages keep the XS Arena preview.
const API = 'https://ppdfdymgtvrimmhcrmbl.supabase.co';
const KEY = 'sb_publishable_x4pVCUzAwSQjbfUigqTS9A_l3ESZQ1g'; // publishable (public) key — the same one the web app ships with
async function rpc(fn, args) {
  try {
    const r = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: KEY, 'content-type': 'application/json' }, body: JSON.stringify(args), cf: { cacheTtl: 300 } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
async function previewFor(pathname) {
  let m = pathname.match(/^\/b\/([a-z0-9-]{2,60})\/?$/i);
  if (m) {
    const c = (await rpc('booking_page', { p_slug: m[1] }))?.centre;
    return c ? { title: `Book at ${c.name}`, desc: `Pick a game and a time at ${c.name}${c.city ? `, ${c.city}` : ''}. Book in a minute.` } : { title: 'Book a game', desc: 'Pick a game and a time.' };
  }
  m = pathname.match(/^\/t\/([A-Za-z0-9_-]{16,128})$/);
  if (m) {
    const c = (await rpc('booking_ticket', { p_token: m[1] }))?.centre;
    return { title: c ? `Your booking at ${c.name}` : 'Your booking', desc: 'Show the QR at the counter.' };
  }
  m = pathname.match(/^\/r\/([a-f0-9]{32,128})$/);
  if (m) {
    let c = null;
    try { const r = await fetch(`${API}/functions/v1/receipt?t=${m[1]}`); if (r.ok) c = (await r.json()).centre; } catch { /* keep generic */ }
    return { title: c ? `Receipt from ${c.name}` : 'Your receipt', desc: 'Thanks for playing!' };
  }
  return null;
}
function rebrand(res, p) {
  const set = (v) => ({ element(e) { e.setAttribute('content', v); } });
  return new HTMLRewriter()
    .on('title', { element(e) { e.setInnerContent(p.title); } })
    .on('meta[property="og:title"], meta[name="twitter:title"]', set(p.title))
    .on('meta[property="og:description"], meta[name="description"], meta[name="twitter:description"]', set(p.desc))
    .on('meta[property="og:site_name"]', set(p.title))
    .on('meta[property^="og:image"], meta[name="twitter:image"], meta[name^="twitter:image"]', { element(e) { e.remove(); } })
    .on('meta[name="twitter:card"]', set('summary'))
    .transform(res);
}

export default {
  async fetch(req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    const { pathname } = new URL(req.url);
    if (pathname === '/healthz') return new Response('ok');
    if (pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /b/\nDisallow: /\n', { headers: { 'content-type': TYPES.txt } });
    const ext = (pathname.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
    if (ext && TYPES[ext]) {
      if (!/^\/(assets|brand)\/[\w.@-]+$|^\/(theme\.js|manifest\.webmanifest)$/.test(pathname)) return new Response('Not found', { status: 404 });
      const immutable = pathname.startsWith('/assets/');
      const r = await fromOrigin(pathname, immutable ? 31536000 : 300);
      if (!r) return new Response('Not found', { status: 404 });
      return new Response(r.body, { headers: { ...SEC, 'content-type': TYPES[ext], 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300' } });
    }
    // Bust GitHub's raw CDN cache every 30 s so a new deploy shows within a minute.
    const r = await fromOrigin(`/index.html?v=${Math.floor(Date.now() / 30000)}`, 30);
    if (!r) return new Response('XS Arena is updating. Please refresh in a moment.', { status: 503 });
    const page = new Response(r.body, { headers: { ...SEC, 'content-type': TYPES.html, 'cache-control': 'no-cache', 'content-security-policy': "frame-ancestors 'none'" } });
    const p = await previewFor(pathname);
    return p ? rebrand(page, p) : page;   // HTMLRewriter escapes the text it inserts
  },
};
