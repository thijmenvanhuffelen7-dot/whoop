// Minimale, stateless proxy voor de officiële WHOOP-API (OAuth + data).
// Werkt als Cloudflare Worker (plak dit hele bestand) én als Netlify Function.
// Bewaart niets: tokens gaan via het URL-fragment terug naar je telefoon.
//
// Omgevingsvariabelen:
//   WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET  – uit het WHOOP Developer Dashboard
//   APP_URL       – adres van je app, bv. https://naam.github.io/whoop/
//   REDIRECT_URI  – (optioneel) standaard <dit adres>/api/whoop/callback

const WHOOP = 'https://api.prod.whoop.com';
const SCOPES = 'offline read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement';
const ALLOWED_PATHS = new Set([
  '/v2/activity/sleep', '/v2/recovery', '/v2/cycle', '/v2/activity/workout',
  '/v2/user/profile/basic', '/v2/user/measurement/body',
]);

export async function handle(request, env) {
  const url = new URL(request.url);
  const action = url.pathname.replace(/\/+$/, '').split('/').pop();
  const appUrl = env.APP_URL;
  if (!env.WHOOP_CLIENT_ID || !env.WHOOP_CLIENT_SECRET || !appUrl) return text('Proxy is niet geconfigureerd (omgevingsvariabelen ontbreken).', 500);

  const cors = {
    'Access-Control-Allow-Origin': new URL(appUrl).origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const redirectUri = env.REDIRECT_URI || `${url.origin}${url.pathname.replace(/[^/]+\/?$/, 'callback')}`;

  try {
    if (action === 'login') {
      const state = url.searchParams.get('state') || '';
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(state)) return text('Ongeldige state', 400);
      const auth = new URL(`${WHOOP}/oauth/oauth2/auth`);
      auth.search = new URLSearchParams({ response_type: 'code', client_id: env.WHOOP_CLIENT_ID, redirect_uri: redirectUri, scope: SCOPES, state }).toString();
      return Response.redirect(auth.toString(), 302);
    }

    if (action === 'callback') {
      const back = (frag) => Response.redirect(`${appUrl.split('#')[0]}#${frag}`, 302);
      const err = url.searchParams.get('error');
      if (err) return back(`whoop-error=${encodeURIComponent(err)}`);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state') || '';
      if (!code) return back('whoop-error=geen_code');
      const t = await token(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
      const payload = b64url(JSON.stringify({ access_token: t.access_token, refresh_token: t.refresh_token, expires_in: t.expires_in, state }));
      return back(`whoop=${payload}`);
    }

    if (action === 'refresh' && request.method === 'POST') {
      const { refresh_token } = await request.json();
      if (!refresh_token) return json({ error: 'refresh_token ontbreekt' }, 400, cors);
      const t = await token(env, { grant_type: 'refresh_token', refresh_token, scope: 'offline' });
      return json({ access_token: t.access_token, refresh_token: t.refresh_token, expires_in: t.expires_in }, 200, cors);
    }

    if (action === 'data') {
      const path = url.searchParams.get('path') || '';
      if (!ALLOWED_PATHS.has(path)) return json({ error: 'Niet toegestaan pad' }, 400, cors);
      const auth = request.headers.get('Authorization') || '';
      if (!/^Bearer [\w.~+/=-]+$/.test(auth)) return json({ error: 'Geen token' }, 401, cors);
      const q = new URLSearchParams();
      for (const k of ['limit', 'start', 'end', 'nextToken']) if (url.searchParams.has(k)) q.set(k, url.searchParams.get(k));
      const res = await fetch(`${WHOOP}/developer${path}${q.size ? `?${q}` : ''}`, { headers: { Authorization: auth, Accept: 'application/json' } });
      return new Response(await res.text(), { status: res.status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
  } catch (e) {
    return json({ error: String(e.message || e) }, 502, cors);
  }
  return text('Niet gevonden', 404);
}

async function token(env, params) {
  const res = await fetch(`${WHOOP}/oauth/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ ...params, client_id: env.WHOOP_CLIENT_ID, client_secret: env.WHOOP_CLIENT_SECRET }),
  });
  if (!res.ok) throw new Error(`Token-aanvraag mislukt (${res.status})`);
  return res.json();
}

const text = (body, status) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
const json = (obj, status, headers) => new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Cloudflare Worker
export default { fetch: (request, env) => handle(request, env) };
