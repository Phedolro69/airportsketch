/**
 * Position actuelle d'un vol en cours, via AirLabs /flights (déjà utilisé par le site).
 *
 * Les réseaux ADS-B ouverts (adsb.lol, adsb.fi, airplanes.live, OpenSky) bloquent les requêtes
 * venant de Cloudflare : la trajectoire depuis le décollage n'est donc pas disponible gratuitement.
 * On renvoie la position réelle de l'avion ; le site trace le reste en estimation (grand cercle).
 *
 * Format identique à l'ancien /track, avec une trajectoire vide :
 *   { callsign, hex, reg, type, now: {lat, lon, alt, gs, track, vs, ts}, track: [], source: 'airlabs' }
 */

const AIRLABS_BASE = 'https://airlabs.co/api/v9';
const FIELDS = 'hex,reg_number,aircraft_icao,flight_icao,flight_iata,lat,lng,alt,dir,speed,v_speed,updated,status';

const M_TO_FT = 3.28084;
const KMH_TO_KT = 0.539957;
const KMH_TO_FPM = 54.6807;

const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Retourne null si le vol n'est pas en l'air (ou inconnu), sinon sa position actuelle. */
export async function fetchPosition(callsign, apiKey, fetchImpl = fetch) {
    const url = new URL(`${AIRLABS_BASE}/flights`);
    url.searchParams.set(/^[A-Z]{3}\d/.test(callsign) ? 'flight_icao' : 'flight_iata', callsign);
    url.searchParams.set('_fields', FIELDS);
    url.searchParams.set('api_key', apiKey);

    const res = await fetchImpl(url.toString(), { headers: { 'Accept': 'application/json' } });
    if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status === 429 ? 429 : 502;
        throw err;
    }
    const data = await res.json();
    if (data && data.error) {
        const err = new Error(data.error.message || 'Erreur AirLabs');
        err.status = /limit/i.test(data.error.code || data.error.message || '') ? 429 : 502;
        throw err;
    }

    const f = (data.response || []).find(x => num(x.lat) !== null && num(x.lng) !== null && x.status !== 'landed');
    if (!f) return null;

    const alt = num(f.alt), speed = num(f.speed), vs = num(f.v_speed), dir = num(f.dir);
    return {
        callsign: f.flight_icao || callsign,
        hex: f.hex || null,
        reg: f.reg_number || null,
        type: f.aircraft_icao || null,
        now: {
            lat: round(f.lat, 4),
            lon: round(f.lng, 4),
            alt: alt === null ? null : Math.round(alt * M_TO_FT),
            gs: speed === null ? null : Math.round(speed * KMH_TO_KT),
            track: dir === null ? null : Math.round(dir),
            vs: vs === null ? null : Math.round(vs * KMH_TO_FPM),
            ts: num(f.updated) || Math.round(Date.now() / 1000)
        },
        track: [],
        source: 'airlabs'
    };
}
