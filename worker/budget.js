/**
 * Protection du quota AirLabs (offre gratuite : 1 000 requêtes par mois).
 *
 * Appelé seulement avant un VRAI appel à AirLabs (cache KV manquant) :
 *   1. limite par visiteur (binding Rate Limiting de Cloudflare « LIMITER », si configuré) :
 *      un robot ou un onglet oublié ne peut pas vider le quota ;
 *   2. budget quotidien partagé (DAILY_BUDGET, 30 par défaut) compté dans KV : au-delà, plus aucun appel
 *      à AirLabs jusqu'au lendemain (UTC) ; les réponses déjà en cache restent servies.
 *
 * Le compteur KV n'est pas transactionnel (deux appels simultanés peuvent lire la même valeur) : un léger
 * dépassement est possible, sans conséquence à cette échelle.
 */

const DEFAULT_DAILY_BUDGET = 30;

export const QUOTA_MESSAGES = {
    rate: 'Trop de recherches de vols en peu de temps : réessayez dans une minute.',
    daily: 'Limite quotidienne de suivi des vols atteinte : réessayez demain. Les vols déjà consultés restent disponibles.',
    monthly: 'Quota mensuel du service de vols épuisé : la recherche de vols reviendra le mois prochain.'
};

const today = () => new Date().toISOString().slice(0, 10);

// DAILY_BUDGET = "0" doit bloquer tout appel : ne pas confondre 0 et « non renseigné »
function dailyBudget(env) {
    const raw = env.DAILY_BUDGET;
    const n = raw === undefined || raw === null || String(raw).trim() === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_BUDGET;
}

/** Retourne null si l'appel est autorisé (et le compte), sinon { code, message }. */
export async function checkBudget(request, env, ctx) {
    if (env.LIMITER) {
        const ip = request.headers.get('CF-Connecting-IP') || 'inconnu';
        try {
            const { success } = await env.LIMITER.limit({ key: ip });
            if (!success) return { code: 'rate_limited', message: QUOTA_MESSAGES.rate };
        } catch (err) { /* limiteur indisponible : on n'empêche pas l'appel */ }
    }

    const kv = env.FLIGHT_CACHE;
    if (!kv) return null;
    const budget = dailyBudget(env);
    const key = `budget:${today()}`;
    const used = Number(await kv.get(key)) || 0;
    if (used >= budget) return { code: 'daily_budget', message: QUOTA_MESSAGES.daily };
    ctx.waitUntil(kv.put(key, String(used + 1), { expirationTtl: 3 * 86400 }));
    return null;
}

/** Erreur AirLabs signalant un quota épuisé (mensuel ou autre limite du compte). */
export function isAirLabsQuotaError(error) {
    const text = `${error && error.code || ''} ${error && error.message || ''}`.toLowerCase();
    return /limit|quota|exceed/.test(text);
}

/** Consommation du jour, pour le suivi (route /usage). */
export async function budgetUsage(env) {
    const kv = env.FLIGHT_CACHE;
    const budget = dailyBudget(env);
    const used = kv ? Number(await kv.get(`budget:${today()}`)) || 0 : 0;
    return { date: today(), used, budget };
}
