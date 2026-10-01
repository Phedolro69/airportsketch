/**
 * AirportSketch - Proxy Cloudflare Worker pour l'API AirLabs
 *
 * Garde la clé AirLabs côté serveur (secret AIRLABS_API_KEY) et met les
 * réponses en cache pour économiser le quota.
 *
 * Routes :
 *   GET /live?airline_iata=AF   | /live?airline_icao=AFR    -> vols en direct de la compagnie
 *   GET /flight?flight_iata=AF173 | /flight?flight_icao=AFR173 -> vol le plus proche (en vol, prévu ou atterri)
 */

const AIRLABS_BASE = 'https://airlabs.co/api/v9';

const LIVE_FIELDS = [
    'flight_iata', 'flight_icao', 'flight_number',
    'airline_iata', 'airline_icao',
    'dep_iata', 'dep_icao', 'arr_iata', 'arr_icao',
    'status'
].join(',');

// Paramètres autorisés par route, avec leur format attendu
const ROUTES = {
    '/live': {
        upstream: '/flights',
        ttl: 120,
        params: {
            airline_iata: /^[A-Z0-9]{2}$/,
            airline_icao: /^[A-Z]{3}$/
        },
        extra: { _fields: LIVE_FIELDS }
    },
    '/flight': {
        upstream: '/flight',
        ttl: 60,
        params: {
            flight_iata: /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/,
            flight_icao: /^[A-Z]{3}\d{1,4}[A-Z]?$/
        },
        extra: {}
    }
};

// Origines de développement local (localhost et réseau privé, tous ports)
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/;

function corsHeaders(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const ok = allowed.includes(origin) || DEV_ORIGIN.test(origin);
    return ok ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Vary': 'Origin'
    } : {};
}

function json(body, status, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }
    });
}

export default {
    async fetch(request, env, ctx) {
        const cors = corsHeaders(request, env);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: cors });
        }
        if (request.method !== 'GET') {
            return json({ error: { message: 'Méthode non autorisée' } }, 405, cors);
        }

        const url = new URL(request.url);
        const route = ROUTES[url.pathname];
        if (!route) {
            return json({ error: { message: 'Route inconnue' } }, 404, cors);
        }

        // Exactement un paramètre reconnu et valide
        const entries = Object.entries(route.params)
            .map(([name, re]) => [name, (url.searchParams.get(name) || '').toUpperCase(), re])
            .filter(([, value]) => value);
        if (entries.length !== 1 || !entries[0][2].test(entries[0][1])) {
            return json({ error: { message: 'Paramètre invalide' } }, 400, cors);
        }
        const [paramName, paramValue] = entries[0];

        if (!env.AIRLABS_API_KEY) {
            return json({ error: { message: 'AIRLABS_API_KEY non configurée sur le Worker' } }, 500, cors);
        }

        // Clé de cache sans la clé d'API
        const cacheKey = new Request(`${url.origin}${url.pathname}?${paramName}=${paramValue}`);
        const cache = caches.default;
        let cached = await cache.match(cacheKey);
        if (cached) {
            return new Response(cached.body, { status: cached.status, headers: { ...Object.fromEntries(cached.headers), ...cors } });
        }

        const upstreamUrl = new URL(AIRLABS_BASE + route.upstream);
        upstreamUrl.searchParams.set(paramName, paramValue);
        for (const [k, v] of Object.entries(route.extra)) upstreamUrl.searchParams.set(k, v);
        upstreamUrl.searchParams.set('api_key', env.AIRLABS_API_KEY);

        let data;
        try {
            const res = await fetch(upstreamUrl.toString(), { headers: { 'Accept': 'application/json' } });
            data = await res.json();
        } catch (err) {
            return json({ error: { message: 'Service AirLabs injoignable' } }, 502, cors);
        }

        // On ne renvoie que la réponse ou l'erreur (jamais l'écho de la requête, qui contient la clé)
        const body = data && data.error
            ? { error: { message: data.error.message || 'Erreur AirLabs', code: data.error.code } }
            : { response: data ? data.response ?? null : null };
        const status = body.error ? 502 : 200;

        const response = json(body, status, { 'Cache-Control': `public, max-age=${route.ttl}` });
        if (status === 200) {
            ctx.waitUntil(cache.put(cacheKey, response.clone()));
        }
        return new Response(response.body, { status, headers: { ...Object.fromEntries(response.headers), ...cors } });
    }
};
