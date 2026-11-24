import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * Adds a strict Content-Security-Policy to the built index.html.
 * GitHub Pages cannot send headers, so the policy travels as a meta tag
 * (SECURITY.md §7). Dev builds skip it because Vite injects inline scripts.
 */
function csp(supabaseUrl: string): Plugin {
  const api = new URL(supabaseUrl);
  const policy = [
    "default-src 'self'",
    // Cloudflare Web Analytics is injected by the Cloudflare proxy in front of the site.
    "script-src 'self' https://static.cloudflareinsights.com",
    "style-src 'self'",
    // bill photos are served from Supabase Storage through short-lived signed links
    `img-src 'self' data: blob: ${api.origin}`,
    "font-src 'self'",
    `connect-src 'self' ${api.origin} wss://${api.host} https://cloudflareinsights.com`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  return {
    name: 'xs-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const supabaseUrl = env.VITE_SUPABASE_URL ?? '';
  // Public sign-up switch (build-time). Default closed; same rule as parseFlag() in src/lib/flags.ts.
  const signupOpen = /^(true|1|yes)$/i.test((process.env.SIGNUP_OPEN ?? env.SIGNUP_OPEN ?? '').trim());
  return {
    base: env.VITE_BASE_PATH || '/',
    define: { __SIGNUP_OPEN__: JSON.stringify(signupOpen) },
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
    plugins: [react(), ...(supabaseUrl ? [csp(supabaseUrl)] : [])],
    build: {
      target: 'es2022',
      sourcemap: false,
      // Long-lived vendor chunks: an app release does not make returning
      // users download React or the Supabase client again.
      rolldownOptions: {
        output: {
          advancedChunks: {
            groups: [
              { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/ },
              { name: 'supabase', test: /node_modules[\\/]@supabase[\\/]/ },
              { name: 'vendor', test: /node_modules[\\/]/ },
            ],
          },
        },
      },
    },
  };
});
