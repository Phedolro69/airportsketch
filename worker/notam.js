/**
 * NOTAM d'un aéroport, relayés depuis un fournisseur externe choisi selon le secret configuré :
 *   - SkyLink API (https://skylinkapi.com/docs/v3/notams/) : secret SKYLINK_API_KEY, offre gratuite de 1 000 appels
 *     par mois, NOTAM mondiaux (flux FAA SWIM FNS) ;
 *   - FAA NMS-API : à brancher quand l'accès aura été accordé (identifiants demandés à notams@faa.gov).
 * Un seul aéroport par requête ; les réponses (absences comprises) sont mises en cache dans Workers KV, partagé
 * entre visiteurs, pour que chaque aéroport ne coûte qu'un appel par NOTAM_TTL. Au-delà de NOTAM_DAILY_BUDGET
 * appels réels par jour (UTC), plus aucun appel jusqu'au lendemain ; le cache reste servi.
 *
 * Réponse compacte, identique quel que soit le fournisseur : { t, notams: [{ id, raw, text, from, to, q, scope, schedule }] },
 *   triés du plus récent au plus ancien ; from / to : secondes Unix (to null = permanent ou inconnu) ;
 *   raw : texte ICAO complet ; text : champ E) seul ; q : code Q (ex. QMRLC) ; scope : AERODROME | FIR | null.
 * Le classement par importance est fait par le site (js/app.js), à partir du code Q et du texte.
 */

const SKYLINK_API = 'https://data.skylinkapi.com/v3/notams/';
const ICAO_CODE = /^[A-Z0-9]{4}$/;
export const NOTAM_TTL = 6 * 3600;
const MAX_NOTAMS = 150;
const DEFAULT_DAILY_BUDGET = 25;   // ~750 appels par mois : sous les 1 000 de l'offre gratuite SkyLink

export function parseNotamId(raw) {
    const id = String(raw || '').toUpperCase().trim();
    return ICAO_CODE.test(id) ? id : null;
}

// « 202603241038 » (AAAAMMJJhhmm, UTC) -> secondes Unix ; « PERM » et valeurs illisibles -> null
function notamTime(v) {
    const m = String(v ?? '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    return Number.isFinite(t) ? t / 1000 : null;
}

export function compactSkylink(n) {
    return {
        id: String(n.notam_id || ''),
        raw: String(n.raw || '').trim(),
        text: String(n.body || '').trim(),
        from: notamTime(n.effective),
        to: notamTime(n.expiration),
        q: n.q_code || null,
        scope: n.scope || null,
        schedule: n.schedule || null
    };
}

/** Appelle SkyLink. Lève { status, quota } en cas d'échec (401/403/429 : clé refusée ou quota épuisé). */
async function fetchSkylink(id, apiKey) {
    // QK : NOTAM « checklist » (liste récapitulative), sans intérêt pour l'utilisateur
    const res = await fetch(`${SKYLINK_API}${id}?exclude_qcode=QK`, { headers: { 'x-api-key': apiKey, Accept: 'application/json' } });
    if (!res.ok) throw Object.assign(new Error(`SkyLink HTTP ${res.status}`), { status: res.status, quota: res.status === 429 });
    const data = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.notams)) throw Object.assign(new Error('SkyLink réponse invalide'), { status: 502 });
    return data.notams.map(compactSkylink);
}

const today = () => new Date().toISOString().slice(0, 10);

function dailyBudget(env) {
    const raw = env.NOTAM_DAILY_BUDGET;
    const n = raw === undefined || raw === null || String(raw).trim() === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_BUDGET;
}

/** Renvoie { body, cache } depuis le cache KV ou le fournisseur. Lève { status, quota | missing | budget } en cas d'échec. */
export async function notams(id, env, ctx) {
    const key = `notam:${id}`;
    const kv = env.FLIGHT_CACHE;
    const cached = kv ? await kv.get(key) : null;
    if (cached) return { body: cached, cache: 'HIT' };
    if (!env.SKYLINK_API_KEY) throw Object.assign(new Error('Aucun fournisseur de NOTAM configuré'), { status: 500, missing: true });

    if (kv) {
        const budgetKey = `notam-budget:${today()}`;
        const used = Number(await kv.get(budgetKey)) || 0;
        if (used >= dailyBudget(env)) throw Object.assign(new Error('Budget NOTAM du jour atteint'), { status: 503, budget: true });
        ctx.waitUntil(kv.put(budgetKey, String(used + 1), { expirationTtl: 3 * 86400 }));
    }

    const rows = await fetchSkylink(id, env.SKYLINK_API_KEY);
    const list = rows.filter(n => n.raw).sort((a, b) => (b.from || 0) - (a.from || 0)).slice(0, MAX_NOTAMS);
    const body = JSON.stringify({ notams: list, t: Math.floor(Date.now() / 1000) });
    if (kv) ctx.waitUntil(kv.put(key, body, { expirationTtl: NOTAM_TTL }));
    return { body, cache: 'MISS' };
}
