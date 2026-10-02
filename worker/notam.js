/**
 * NOTAM d'un aéroport, via l'ICAO API Data Service (https://applications.icao.int/dataservices), mondiale.
 * Clé gratuite limitée (100 appels au total, puis forfaits payants) : secret ICAO_API_KEY du worker.
 * Un seul aéroport par requête ; les réponses (absences comprises) sont mises en cache dans Workers KV, partagé
 * entre visiteurs, pour que chaque aéroport ne coûte qu'un appel par NOTAM_TTL.
 *
 * Réponse compacte : { notams: [{ id, raw, from, to, q, ...}] }, triés du plus récent au plus ancien,
 *   from / to : secondes Unix (to null = permanent ou inconnu), raw : texte ICAO complet.
 */

const ICAO_API = 'https://applications.icao.int/dataservices/api/notams-realtime-list';
const ICAO_CODE = /^[A-Z0-9]{4}$/;
export const NOTAM_TTL = 6 * 3600;
const MAX_NOTAMS = 150;

export function parseNotamId(raw) {
    const id = String(raw || '').toUpperCase().trim();
    return ICAO_CODE.test(id) ? id : null;
}

function seconds(v) {
    if (v === null || v === undefined || v === '') return null;
    const t = typeof v === 'number' ? v : Date.parse(String(v).includes('T') || String(v).includes('Z') ? v : String(v).replace(' ', 'T') + 'Z');
    return Number.isFinite(t) ? Math.round((t > 1e11 ? t : t * 1000) / 1000) : null;
}

export function compactNotam(n) {
    return {
        id: String(n.id ?? n.key ?? ''),
        raw: String(n.all ?? n.message ?? '').trim(),
        text: String(n.message ?? '').trim(),
        from: seconds(n.startdate ?? n.start),
        to: /perm/i.test(String(n.enddate ?? '')) ? null : seconds(n.enddate ?? n.end),
        q: n.Qcode || n.qcode || null,
        subject: n.Subject || null,
        condition: n.Condition || null
    };
}

/** Appelle l'ICAO. Lève { status, quota } en cas d'échec (401/403/429 : clé refusée ou quota épuisé). */
async function fetchIcao(id, apiKey) {
    const url = `${ICAO_API}?api_key=${encodeURIComponent(apiKey)}&format=json&criticality=&locations=${id}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`ICAO HTTP ${res.status}`), { status: res.status });
    let data;
    try { data = text.trim() ? JSON.parse(text) : []; } catch (e) { throw Object.assign(new Error('ICAO réponse invalide'), { status: 502, body: text.slice(0, 200) }); }
    // L'API répond parfois 200 avec un message d'erreur (quota, clé) sous forme d'objet
    if (!Array.isArray(data)) throw Object.assign(new Error(String(data.message || data.error || 'ICAO erreur')), { status: 429, quota: true });
    return data;
}

/** Renvoie { notams } depuis le cache KV ou l'ICAO. Lève { status, quota } si l'ICAO échoue. */
export async function notams(id, env, ctx) {
    const key = `notam:${id}`;
    const kv = env.FLIGHT_CACHE;
    const cached = kv ? await kv.get(key) : null;
    if (cached) return { body: cached, cache: 'HIT' };
    if (!env.ICAO_API_KEY) throw Object.assign(new Error('ICAO_API_KEY non configurée'), { status: 500, missing: true });
    const rows = await fetchIcao(id, env.ICAO_API_KEY);
    const list = rows.map(compactNotam).filter(n => n.raw).sort((a, b) => (b.from || 0) - (a.from || 0)).slice(0, MAX_NOTAMS);
    const body = JSON.stringify({ notams: list, t: Math.floor(Date.now() / 1000) });
    if (kv) ctx.waitUntil(kv.put(key, body, { expirationTtl: NOTAM_TTL }));
    return { body, cache: 'MISS' };
}
