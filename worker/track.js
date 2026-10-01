/**
 * Trajectoire réellement suivie par un vol en cours, depuis le réseau ADS-B ouvert adsb.lol
 * (données ODbL, gratuites, sans clé).
 *
 * Ce n'est PAS le plan de vol déposé (non public) : ce sont les positions émises par l'avion.
 *
 *   1. /v2/callsign/{indicatif}              -> avion en vol (hex, position, altitude, vitesse, cap)
 *   2. /data/traces/.../trace_full_{hex}     -> historique de la journée UTC (plusieurs vols possibles),
 *                                               mis à jour avec ~30 min de retard
 *      /data/traces/.../trace_recent_{hex}   -> dernières ~30 min, à jour
 *   3. fusion des deux, découpe du dernier vol (après le dernier passage au sol),
 *      simplification (Douglas-Peucker) pour garder une réponse légère.
 */

const ADSB_API = 'https://api.adsb.lol';
const ADSB_TRACES = 'https://adsb.lol/data/traces';
const USER_AGENT = 'AirportSketch/1.0 (+https://github.com/Phedolro69/airportsketch)';

const MAX_POINTS = 400;        // taille maximale de la trajectoire renvoyée
const START_TOLERANCE = 0.004; // tolérance initiale de simplification, en degrés (~400 m)

async function getJson(url, fetchImpl) {
    const res = await fetchImpl(url, { headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT } });
    if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return res.json();
}

// Entrée de trace readsb : [décalage_s, lat, lon, altitude_ft | "ground" | null, ...]
function readTrace(data) {
    if (!data || !Array.isArray(data.trace) || typeof data.timestamp !== 'number') return [];
    return data.trace
        .filter(p => Array.isArray(p) && typeof p[1] === 'number' && typeof p[2] === 'number')
        .map(p => ({
            ts: data.timestamp + p[0],
            lat: p[1],
            lon: p[2],
            ground: p[3] === 'ground',
            alt: typeof p[3] === 'number' ? p[3] : null
        }));
}

// trace_full a du retard : on complète avec trace_recent, qui est à jour
function mergeTraces(full, recent) {
    const lastFull = full.length ? full[full.length - 1].ts : -Infinity;
    return [...full, ...recent.filter(p => p.ts > lastFull)].sort((a, b) => a.ts - b.ts);
}

function distanceKm(a, b) {
    const r = Math.PI / 180;
    const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2
        + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
}

// Escale : longue interruption des positions, au même endroit (même aéroport), reprise à basse altitude.
// Une lacune au-dessus de l'océan ne compte pas : l'avion y est en altitude et loin de son point précédent.
function isTurnaround(prev, next) {
    return next.ts - prev.ts > 1800
        && (next.ground || (next.alt !== null && next.alt < 5000))
        && distanceKm(prev, next) < 100;
}

// Dernier vol. Un fichier couvre ~24 h et peut contenir plusieurs vols de l'avion ; on repère le dernier
// décollage : après le dernier point au sol, ou après la dernière escale sans point au sol (avion muet au parking).
export function lastLeg(points) {
    let start = 0;
    for (let i = 1; i < points.length; i++) {
        if (points[i - 1].ground || isTurnaround(points[i - 1], points[i])) start = i;
    }
    while (start < points.length && points[start].ground) start++;
    return points.slice(start);
}

// Douglas-Peucker itératif sur (lon·cos(lat), lat), tolérance en degrés
export function simplify(points, tolerance) {
    if (points.length < 3) return points.slice();
    const k = Math.cos((points[Math.floor(points.length / 2)].lat * Math.PI) / 180) || 1;
    const x = p => p.lon * k;
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        const ax = x(points[a]), ay = points[a].lat, dx = x(points[b]) - ax, dy = points[b].lat - ay;
        const norm = Math.hypot(dx, dy);
        let far = -1, farD = 0;
        for (let i = a + 1; i < b; i++) {
            const px = x(points[i]) - ax, py = points[i].lat - ay;
            const d = norm === 0 ? Math.hypot(px, py) : Math.abs(dy * px - dx * py) / norm;
            if (d > farD) { far = i; farD = d; }
        }
        if (farD > tolerance) {
            keep[far] = 1;
            stack.push([a, far], [far, b]);
        }
    }
    return points.filter((_, i) => keep[i]);
}

function reduce(points) {
    let tolerance = START_TOLERANCE;
    let out = simplify(points, tolerance);
    while (out.length > MAX_POINTS) {
        tolerance *= 1.6;
        out = simplify(points, tolerance);
    }
    return out;
}

const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;

/**
 * Retourne null si le vol n'est pas (ou plus) vu en l'air, sinon
 * { callsign, hex, reg, type, now: {lat, lon, alt, gs, track, vs, ts}, track: [[lat, lon, alt_ft, ts], ...], source }
 */
export async function fetchTrack(callsign, fetchImpl = fetch) {
    const live = await getJson(`${ADSB_API}/v2/callsign/${callsign}`, fetchImpl);
    const ac = (live.ac || []).find(a => typeof a.lat === 'number' && typeof a.lon === 'number'
        && /^[0-9a-f]{6}$/.test(a.hex || ''));
    if (!ac || ac.alt_baro === 'ground') return null;

    const now = {
        lat: round(ac.lat, 4),
        lon: round(ac.lon, 4),
        alt: typeof ac.alt_baro === 'number' ? ac.alt_baro : null,
        gs: typeof ac.gs === 'number' ? Math.round(ac.gs) : null,
        track: typeof ac.track === 'number' ? Math.round(ac.track) : null,
        vs: typeof ac.baro_rate === 'number' ? ac.baro_rate : null,
        ts: Math.round((live.now || Date.now()) / 1000 - (ac.seen_pos || 0))
    };

    // Historique : les deux fichiers sont facultatifs, on se contente de la position actuelle sinon
    const dir = `${ADSB_TRACES}/${ac.hex.slice(-2)}`;
    const [full, recent] = await Promise.allSettled([
        getJson(`${dir}/trace_full_${ac.hex}.json`, fetchImpl).then(readTrace),
        getJson(`${dir}/trace_recent_${ac.hex}.json`, fetchImpl).then(readTrace)
    ]);
    // Si adsb.lol nous limite (429) sur les deux fichiers, mieux vaut échouer que mettre en cache une réponse sans trajectoire
    if (full.status === 'rejected' && recent.status === 'rejected' && full.reason.status === 429) throw full.reason;

    const leg = lastLeg(mergeTraces(full.value || [], recent.value || []));
    if (!leg.length || leg[leg.length - 1].ts < now.ts) {
        leg.push({ ts: now.ts, lat: ac.lat, lon: ac.lon, ground: false, alt: now.alt });
    }
    // Un seul point : pas de trajectoire exploitable
    const track = leg.length < 2 ? [] : reduce(leg).map(p =>
        [round(p.lat, 4), round(p.lon, 4), p.alt === null ? null : Math.round(p.alt / 100) * 100, Math.round(p.ts)]);

    return {
        callsign: (ac.flight || callsign).trim(),
        hex: ac.hex,
        reg: ac.r || null,
        type: ac.t || null,
        now,
        track,
        source: 'adsb.lol'
    };
}
