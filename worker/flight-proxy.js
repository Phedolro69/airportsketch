/**
 * Plein Axe (ex-AirportSketch) - Proxy Cloudflare Worker pour l'API AirLabs
 *
 * Garde la clé AirLabs côté serveur (secret AIRLABS_API_KEY) et met les
 * réponses en cache (Workers KV, partagé entre visiteurs) pour économiser le quota.
 *
 * Routes :
 *   GET /live?airline_iata=AF   | /live?airline_icao=AFR    -> vols en direct de la compagnie
 *   GET /flight?flight_iata=AF173 | /flight?flight_icao=AFR173 -> vol le plus proche (en vol, prévu ou atterri)
 *   GET /track?callsign=AFR173                                 -> position actuelle du vol en cours (AirLabs /flights)
 *   GET /usage                                                 -> appels AirLabs du jour et budget quotidien
 *   GET /config                                                -> mode (« demo » ou « live ») et, en démo, la liste des vols
 *   GET /wx?ids=LFPG,KJFK[&taf=1]                              -> METAR (et TAF) des aéroports, relayés depuis NOAA (weather.js)
 *   GET /notam?id=LFPG                                         -> NOTAM d'un aéroport, mode réel seulement (notam.js, secret SKYLINK_API_KEY)
 *
 * Mode démo (par défaut) : 20 vols fictifs générés par demo.js, sans aucun appel à AirLabs. Les vraies données
 * ne sont servies qu'avec l'en-tête X-Access-Code égal au secret LIVE_ACCESS_CODE, ou si DATA_MODE = "live".
 *
 * Quota AirLabs (offre gratuite, 1 000 requêtes/mois) : caches longs, limite par visiteur et budget
 * quotidien (budget.js) ; seules les requêtes absentes du cache comptent.
 */

import { fetchPosition } from './position.js';
import { checkBudget, isAirLabsQuotaError, budgetUsage, QUOTA_MESSAGES } from './budget.js';
import { demoList, demoLive, demoFlight, demoTrack } from './demo.js';
import { parseIds, weather, MAX_IDS } from './weather.js';
import { parseNotamId, notams } from './notam.js';

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
        ttl: 600,   // 10 min : la liste des vols d'une compagnie bouge peu
        params: {
            airline_iata: /^[A-Z0-9]{2}$/,
            airline_icao: /^[A-Z]{3}$/
        },
        extra: { _fields: LIVE_FIELDS }
    },
    '/flight': {
        upstream: '/flight',
        ttl: 600,   // 10 min : horaires, portes, retards
        params: {
            flight_iata: /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/,
            flight_icao: /^[A-Z]{3}\d{1,4}[A-Z]?$/
        },
        extra: {}
    }
};

const TRACK_CALLSIGN = /^[A-Z0-9]{3,8}$/;
const TRACK_TTL = 300;   // 5 min : position de l'avion

// Origines de développement local (localhost et réseau privé, tous ports)
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/;

function corsHeaders(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const ok = allowed.includes(origin) || DEV_ORIGIN.test(origin);
    return ok ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'X-Access-Code',
        'Vary': 'Origin'
    } : {};
}

function json(body, status, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }
    });
}

// Vraies données (AirLabs) seulement avec le bon code d'accès, ou si le mode « live » est ouvert à tous
function isLive(request, env) {
    if (String(env.DATA_MODE || '').toLowerCase() === 'live') return true;
    const secret = env.LIVE_ACCESS_CODE || '';
    const given = request.headers.get('X-Access-Code') || '';
    if (!secret || !given) return false;
    // Comparaison en temps constant
    let diff = secret.length ^ given.length;
    for (let i = 0; i < Math.max(secret.length, given.length); i++) {
        diff |= (secret.charCodeAt(i) || 0) ^ (given.charCodeAt(i) || 0);
    }
    return diff === 0;
}

const DEMO_HEADERS = { 'Cache-Control': 'no-store', 'X-Data-Mode': 'demo' };

// Position d'un vol en cours (AirLabs). Même cache KV partagé que les autres routes.
async function handleTrack(request, url, env, ctx, cors) {
    const callsign = (url.searchParams.get('callsign') || '').toUpperCase();
    if (!TRACK_CALLSIGN.test(callsign)) {
        return json({ error: { message: 'Paramètre invalide' } }, 400, cors);
    }

    const cacheHeaders = { 'Cache-Control': `public, max-age=${TRACK_TTL}` };
    const cacheKey = `/track?callsign=${callsign}`;
    const kv = env.FLIGHT_CACHE;
    const cached = kv ? await kv.get(cacheKey) : null;
    if (cached) {
        return new Response(cached, {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8', ...cacheHeaders, 'X-Cache': 'HIT', ...cors }
        });
    }

    if (!env.AIRLABS_API_KEY) {
        return json({ error: { message: 'AIRLABS_API_KEY non configurée sur le Worker' } }, 500, cors);
    }
    const blocked = await checkBudget(request, env, ctx);
    if (blocked) return json({ error: blocked }, 503, cors);
    let track;
    try {
        track = await fetchPosition(callsign, env.AIRLABS_API_KEY);
    } catch (err) {
        if (err && (err.status === 429 || isAirLabsQuotaError(err))) {
            return json({ error: { message: QUOTA_MESSAGES.monthly, code: 'monthly_quota' } }, 503, cors);
        }
        return json({ error: { message: 'Position du vol indisponible' } }, 502, cors);
    }

    // Un vol absent (null) est aussi mis en cache, pour ne pas solliciter AirLabs à chaque rafraîchissement
    const text = JSON.stringify({ response: track });
    if (kv) ctx.waitUntil(kv.put(cacheKey, text, { expirationTtl: TRACK_TTL }));
    return new Response(text, {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...cacheHeaders, 'X-Cache': 'MISS', ...cors }
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
        const live = isLive(request, env);
        if (url.pathname === '/config') {
            return json(live ? { mode: 'live' } : { mode: 'demo', flights: demoList() }, 200, { ...cors, 'Cache-Control': 'no-store', Vary: 'Origin, X-Access-Code' });
        }
        if (url.pathname === '/track') {
            if (!live) {
                const callsign = (url.searchParams.get('callsign') || '').toUpperCase();
                if (!TRACK_CALLSIGN.test(callsign)) return json({ error: { message: 'Paramètre invalide' } }, 400, cors);
                return json({ response: demoTrack(callsign) }, 200, { ...cors, ...DEMO_HEADERS });
            }
            return handleTrack(request, url, env, ctx, cors);
        }
        if (url.pathname === '/wx') {
            // Météo : données publiques NOAA, identiques en démo et en réel, hors quota AirLabs
            const ids = parseIds(url.searchParams.get('ids'));
            if (!ids) return json({ error: { message: `Paramètre ids invalide (1 à ${MAX_IDS} codes OACI)` } }, 400, cors);
            try {
                const data = await weather(ids, url.searchParams.get('taf') === '1');
                return json(data, 200, { ...cors, 'Cache-Control': 'public, max-age=120' });
            } catch (err) {
                return json({ error: { message: 'Service météo indisponible' } }, 502, cors);
            }
        }
        if (url.pathname === '/notam') {
            // NOTAM : fournisseur à quota limité (notam.js), un aéroport par requête, cache KV 6 h ; réservés au mode réel
            const id = parseNotamId(url.searchParams.get('id'));
            if (!id) return json({ error: { message: 'Paramètre id invalide (un code OACI de 4 caractères)' } }, 400, cors);
            if (!live) return json({ error: { message: 'NOTAM disponibles en mode réel uniquement', code: 'notam_live_only' } }, 403, { ...cors, ...DEMO_HEADERS });
            try {
                const { body, cache } = await notams(id, env, ctx);
                return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, max-age=900', 'X-Cache': cache, ...cors } });
            } catch (err) {
                if (err.missing) return json({ error: { message: 'NOTAM non configurés sur ce serveur', code: 'notam_unconfigured' } }, 503, cors);
                if (err.budget) return json({ error: { message: 'Limite quotidienne de NOTAM atteinte : réessayez demain', code: 'notam_budget' } }, 503, cors);
                if (err.status === 401 || err.status === 403 || err.status === 429 || err.quota) {
                    return json({ error: { message: 'Quota NOTAM épuisé ou clé refusée', code: 'notam_quota' } }, 503, cors);
                }
                return json({ error: { message: 'Service NOTAM indisponible' } }, 502, cors);
            }
        }
        if (url.pathname === '/usage') {
            return json(await budgetUsage(env), 200, { ...cors, 'Cache-Control': 'no-store' });
        }
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

        // Mode démo : vols fictifs, aucun appel à AirLabs, aucun cache partagé
        if (!live) {
            const response = url.pathname === '/live' ? demoLive(paramName, paramValue) : demoFlight(paramName, paramValue);
            return json({ response }, 200, { ...cors, ...DEMO_HEADERS });
        }

        if (!env.AIRLABS_API_KEY) {
            return json({ error: { message: 'AIRLABS_API_KEY non configurée sur le Worker' } }, 500, cors);
        }

        // Cache KV partagé entre tous les visiteurs (clé sans la clé d'API)
        const cacheHeaders = { 'Cache-Control': `public, max-age=${route.ttl}` };
        const cacheKey = `${url.pathname}?${paramName}=${paramValue}`;
        const kv = env.FLIGHT_CACHE;
        const cached = kv ? await kv.get(cacheKey) : null;
        if (cached) {
            return new Response(cached, {
                status: 200,
                headers: { 'Content-Type': 'application/json; charset=utf-8', ...cacheHeaders, 'X-Cache': 'HIT', ...cors }
            });
        }

        const blocked = await checkBudget(request, env, ctx);
        if (blocked) return json({ error: blocked }, 503, cors);

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
        const quota = data && data.error && isAirLabsQuotaError(data.error);
        const body = data && data.error
            ? { error: quota ? { message: QUOTA_MESSAGES.monthly, code: 'monthly_quota' }
                             : { message: data.error.message || 'Erreur AirLabs', code: data.error.code } }
            : { response: data ? data.response ?? null : null };
        const status = body.error ? (quota ? 503 : 502) : 200;

        const text = JSON.stringify(body);
        if (status === 200 && kv) {
            // KV impose un TTL minimum de 60 s
            ctx.waitUntil(kv.put(cacheKey, text, { expirationTtl: Math.max(60, route.ttl) }));
        }
        return new Response(text, {
            status,
            headers: { 'Content-Type': 'application/json; charset=utf-8', ...cacheHeaders, 'X-Cache': 'MISS', ...cors }
        });
    }
};
