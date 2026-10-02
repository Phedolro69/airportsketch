/**
 * Météo aéronautique : METAR (observation) et TAF (prévision) des aéroports, via l'API Data de NOAA
 * Aviation Weather Center (https://aviationweather.gov/api). Gratuite, sans clé, mondiale ; elle n'envoie pas
 * d'en-têtes CORS, d'où ce relais. Aucun lien avec le quota AirLabs.
 *
 * Réponse compacte (seulement ce que le site affiche) :
 *   { metar: { LFPG: { raw, cat, t, temp, dewp, wdir, wspd, wgst, vis, alt, clouds: [[couverture, base ft]], wx } | null },
 *     taf:   { LFPG: { raw, issue, from, to, fc: [{ f, t, ch, p, wdir, wspd, wgst, vis, wx, clouds }] } | null } }
 *   cat : VFR | MVFR | IFR | LIFR (calculée par NOAA) ; null = pas de METAR pour cet aéroport.
 *
 * Cache en mémoire de l'instance du worker (METAR 5 min, TAF 15 min), absences comprises : les consultations
 * répétées ne rappellent pas NOAA, et aucune écriture KV n'est faite (quota d'écritures gratuit très bas).
 */

const NOAA = 'https://aviationweather.gov/api/data';
const ICAO = /^[A-Z0-9]{3,4}$/;
export const MAX_IDS = 150;
const METAR_TTL_MS = 5 * 60 * 1000;
const TAF_TTL_MS = 15 * 60 * 1000;
const NOAA_BATCH = 100;

const memory = { metar: new Map(), taf: new Map() };

export function parseIds(raw) {
    const ids = [...new Set(String(raw || '').toUpperCase().split(',').map(s => s.trim()).filter(Boolean))];
    if (!ids.length || ids.length > MAX_IDS || !ids.every(id => ICAO.test(id))) return null;
    return ids.sort();
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function compactMetar(m) {
    return {
        raw: m.rawOb || '',
        cat: m.fltCat || null,
        t: num(m.obsTime),
        temp: num(m.temp),
        dewp: num(m.dewp),
        wdir: m.wdir ?? null,          // degrés, ou "VRB"
        wspd: num(m.wspd),             // nœuds
        wgst: num(m.wgst),
        vis: m.visib ?? null,          // miles terrestres ("6+" = 6 ou plus)
        alt: num(m.altim),             // hPa
        clouds: (m.clouds || []).map(c => [c.cover, num(c.base)]),
        wx: m.wxString || null
    };
}

export function compactTaf(t) {
    return {
        raw: t.rawTAF || '',
        issue: num(t.issueTime ? Date.parse(t.issueTime) / 1000 : null),
        from: num(t.validTimeFrom),
        to: num(t.validTimeTo),
        fc: (t.fcsts || []).map(f => ({
            f: num(f.timeFrom),
            t: num(f.timeTo),
            ch: f.fcstChange || null,   // FM, BECMG, TEMPO ; null = début de validité
            p: num(f.probability),
            wdir: f.wdir ?? null,
            wspd: num(f.wspd),
            wgst: num(f.wgst),
            vis: f.visib ?? null,
            wx: f.wxString || null,
            clouds: (f.clouds || []).map(c => [c.cover, num(c.base)])
        }))
    };
}

async function fetchNoaa(kind, ids) {
    const res = await fetch(`${NOAA}/${kind}?ids=${ids.join(',')}&format=json`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`NOAA ${kind} HTTP ${res.status}`);
    const text = await res.text();
    return text.trim() ? JSON.parse(text) : [];
}

async function fill(kind, ids, ttl, compact) {
    const store = memory[kind], now = Date.now();
    const missing = ids.filter(id => !(store.get(id) && store.get(id).until > now));
    for (let i = 0; i < missing.length; i += NOAA_BATCH) {
        const batch = missing.slice(i, i + NOAA_BATCH);
        const rows = await fetchNoaa(kind, batch);
        const found = new Map();
        // TAF : plusieurs bulletins par station possibles, le plus récent d'abord dans la réponse
        rows.forEach(r => { if (r.icaoId && !found.has(r.icaoId)) found.set(r.icaoId, compact(r)); });
        batch.forEach(id => store.set(id, { until: now + ttl, value: found.get(id) || null }));
    }
    if (store.size > 5000) for (const [k, v] of store) if (v.until < now) store.delete(k);
    return Object.fromEntries(ids.map(id => [id, store.get(id).value]));
}

/** METAR de tous les ids, et leurs TAF si wantTaf. Lève une erreur si NOAA est injoignable. */
export async function weather(ids, wantTaf) {
    const [metar, taf] = await Promise.all([
        fill('metar', ids, METAR_TTL_MS, compactMetar),
        wantTaf ? fill('taf', ids, TAF_TTL_MS, compactTaf) : null
    ]);
    return taf ? { metar, taf } : { metar };
}
