/**
 * Mode démo : 20 vols FICTIFS mais réalistes, servis à tous les visiteurs sans code d'accès.
 * Aucun appel à AirLabs, donc aucun quota consommé.
 *
 * Les horaires sont recalculés par rapport à l'heure actuelle (arrondie à 5 min) : chaque vol garde son
 * « stade » (en vol à 45 %, prévu dans 2 h…), ce qui rend la démo toujours vivante. Les positions des vols
 * en cours sont calculées sur le grand cercle départ -> arrivée.
 *
 * Format identique à AirLabs (/flight, /flights) pour que le site n'ait rien de particulier à faire.
 */

// IATA -> [OACI, latitude, longitude, ville, décalage UTC en heures (approximation, sans changement d'heure)]
const AIRPORTS = {
    CDG: ['LFPG', 49.009, 2.5541, 'Paris', 2],
    JFK: ['KJFK', 40.6394, -73.7793, 'New York', -4],
    LAX: ['KLAX', 33.9425, -118.408, 'Los Angeles', -7],
    NRT: ['RJAA', 35.7686, 140.3887, 'Tokyo', 9],
    NCE: ['LFMN', 43.6584, 7.2159, 'Nice', 2],
    LHR: ['EGLL', 51.4707, -0.4599, 'London', 1],
    SIN: ['WSSS', 1.3502, 103.994, 'Singapore', 8],
    FRA: ['EDDF', 50.0267, 8.5584, 'Frankfurt', 2],
    SFO: ['KSFO', 37.6198, -122.3748, 'San Francisco', -7],
    DXB: ['OMDB', 25.2498, 55.371, 'Dubai', 4],
    SYD: ['YSSY', -33.9461, 151.177, 'Sydney', 10],
    HND: ['RJTT', 35.5497, 139.787, 'Tokyo', 9],
    AMS: ['EHAM', 52.3086, 4.7639, 'Amsterdam', 2],
    MAD: ['LEMD', 40.4934, -3.5722, 'Madrid', 2],
    GRU: ['SBGR', -23.4313, -46.47, 'São Paulo', -3],
    ORD: ['KORD', 41.9786, -87.9048, 'Chicago', -5],
    TLS: ['LFBO', 43.6291, 1.3638, 'Toulouse', 2],
    ATL: ['KATL', 33.6367, -84.4281, 'Atlanta', -4]
};

const AIRLINES = {
    AF: ['AFR', 'Air France', 'FR'], BA: ['BAW', 'British Airways', 'GB'], LH: ['DLH', 'Lufthansa', 'DE'],
    UA: ['UAL', 'United Airlines', 'US'], DL: ['DAL', 'Delta Air Lines', 'US'], AA: ['AAL', 'American Airlines', 'US'],
    EK: ['UAE', 'Emirates', 'AE'], QF: ['QFA', 'Qantas', 'AU'], JL: ['JAL', 'Japan Airlines', 'JP'],
    SQ: ['SIA', 'Singapore Airlines', 'SG'], KL: ['KLM', 'KLM', 'NL'], IB: ['IBE', 'Iberia', 'ES'], NH: ['ANA', 'All Nippon Airways', 'JP']
};

/*
 * Vols : [compagnie, numéro, départ, arrivée, durée (min), appareil, immatriculation, stade, retard (min)]
 * stade = fraction du vol déjà parcourue (0 à 1 : en vol), ou 'S+120' (décolle dans 120 min),
 * 'L-45' (atterri il y a 45 min), 'X' (annulé).
 */
const FLIGHTS = [
    ['AF', 22, 'CDG', 'JFK', 500, 'A359', 'F-HTYA', 0.45, 0],
    ['AF', 66, 'CDG', 'LAX', 690, 'B77W', 'F-GSQV', 0.62, 15],
    ['AF', 276, 'CDG', 'NRT', 760, 'B77W', 'F-GZNE', 0.28, 0],
    ['AF', 7706, 'CDG', 'NCE', 95, 'A320', 'F-HBNK', 0.55, 0],
    ['AF', 7520, 'CDG', 'TLS', 80, 'A321', 'F-GTAZ', 'S+95', 0],
    ['BA', 117, 'LHR', 'JFK', 480, 'A35K', 'G-XWBF', 'S+150', 0],
    ['BA', 11, 'LHR', 'SIN', 790, 'B77W', 'G-STBK', 0.6, 0],
    ['LH', 400, 'FRA', 'JFK', 520, 'B748', 'D-ABYL', 0.2, 0],
    ['UA', 901, 'SFO', 'FRA', 645, 'B789', 'N29975', 0.52, 0],
    ['DL', 1, 'JFK', 'LHR', 415, 'A333', 'N819NW', 0.38, 40],
    ['AA', 100, 'JFK', 'LHR', 420, 'B77W', 'N733AR', 'L-35', 0],
    ['EK', 73, 'DXB', 'CDG', 455, 'A388', 'A6-EUK', 0.35, 0],
    ['QF', 1, 'SYD', 'SIN', 480, 'A388', 'VH-OQA', 0.66, 0],
    ['JL', 4, 'HND', 'JFK', 770, 'B77W', 'JA732J', 0.48, 0],
    ['SQ', 26, 'SIN', 'FRA', 785, 'A359', '9V-SMF', 0.15, 0],
    ['KL', 643, 'AMS', 'JFK', 500, 'B789', 'PH-BHA', 'X', 0],
    ['IB', 6825, 'MAD', 'GRU', 625, 'A359', 'EC-NBE', 0.55, 0],
    ['AA', 1, 'JFK', 'LAX', 380, 'A321', 'N101NN', 0.41, 0],
    ['UA', 1435, 'ORD', 'SFO', 290, 'B739', 'N38479', 0.74, 0],
    ['NH', 7, 'NRT', 'SFO', 600, 'B789', 'JA882A', 0.86, 0]
];

const R = Math.PI / 180;
const fmt = d => d.toISOString().slice(0, 16).replace('T', ' ');
const local = (d, code) => new Date(d.getTime() + AIRPORTS[code][4] * 3600000);

function interpolate(a, b, f) {
    const [la1, lo1, la2, lo2] = [a[1] * R, a[2] * R, b[1] * R, b[2] * R];
    const d = 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
    const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
    const z = A * Math.sin(la1) + B * Math.sin(la2);
    return [Math.atan2(z, Math.hypot(x, y)) / R, Math.atan2(y, x) / R];
}

function bearing(p, q) {
    const dl = (q[1] - p[1]) * R;
    const y = Math.sin(dl) * Math.cos(q[0] * R);
    const x = Math.cos(p[0] * R) * Math.sin(q[0] * R) - Math.sin(p[0] * R) * Math.cos(q[0] * R) * Math.cos(dl);
    return Math.round((Math.atan2(y, x) / R + 360) % 360);
}

function buildFlight(def, nowMs) {
    const [iata, number, dep, arr, duration, aircraft, reg, stage, delay] = def;
    const [icao, name, flag] = AIRLINES[iata];
    const now = new Date(Math.floor(nowMs / 300000) * 300000);   // arrondi 5 min : réponses stables
    let status, depActual;
    if (typeof stage === 'number') {
        status = 'en-route';
        depActual = new Date(now.getTime() - stage * duration * 60000);
    } else if (stage === 'X') {
        status = 'cancelled';
        depActual = new Date(now.getTime() + 4 * 3600000);
    } else if (stage[0] === 'S') {
        status = 'scheduled';
        depActual = new Date(now.getTime() + Number(stage.slice(2)) * 60000);
    } else {
        status = 'landed';
        depActual = new Date(now.getTime() - (duration + Number(stage.slice(2))) * 60000);
    }
    const depSched = new Date(depActual.getTime() - delay * 60000);
    const arrSched = new Date(depSched.getTime() + duration * 60000);
    const arrEst = new Date(arrSched.getTime() + delay * 60000);
    const started = status === 'en-route' || status === 'landed';

    const side = (prefix, code, sched, real, done) => ({
        [`${prefix}_iata`]: code,
        [`${prefix}_icao`]: AIRPORTS[code][0],
        [`${prefix}_terminal`]: prefix === 'dep' ? '2' : '1',
        [`${prefix}_gate`]: null,
        [`${prefix}_time`]: fmt(local(sched, code)),
        [`${prefix}_estimated`]: delay && status !== 'cancelled' ? fmt(local(real, code)) : null,
        [`${prefix}_actual`]: done ? fmt(local(real, code)) : null,
        [`${prefix}_time_utc`]: fmt(sched),
        [`${prefix}_estimated_utc`]: delay && status !== 'cancelled' ? fmt(real) : null,
        [`${prefix}_actual_utc`]: done ? fmt(real) : null,
        [`${prefix}_delayed`]: delay || null,
        [`${prefix}_city`]: AIRPORTS[code][3]
    });

    const flight = {
        demo: true,
        aircraft_icao: aircraft,
        airline_iata: iata,
        airline_icao: icao,
        airline_name: name,
        flag,
        flight_iata: `${iata}${number}`,
        flight_icao: `${icao}${number}`,
        flight_number: String(number),
        ...side('dep', dep, depSched, depActual, started),
        ...side('arr', arr, arrSched, arrEst, status === 'landed'),
        reg_number: reg,
        status,
        duration,
        delayed: delay || null,
        updated: Math.round(now.getTime() / 1000)
    };

    if (status === 'en-route') {
        const a = AIRPORTS[dep], b = AIRPORTS[arr];
        const pos = interpolate(a, b, stage);
        const ahead = interpolate(a, b, Math.min(1, stage + 0.01));
        const climb = Math.min(1, stage / 0.08), descent = Math.min(1, (1 - stage) / 0.08);
        flight.lat = Math.round(pos[0] * 10000) / 10000;
        flight.lng = Math.round(pos[1] * 10000) / 10000;
        flight.alt = Math.round(11000 * Math.min(climb, descent) / 10) * 10 || 600;   // mètres, comme AirLabs
        flight.dir = bearing(pos, ahead);
        flight.speed = Math.round(880 * Math.max(0.45, Math.min(climb, descent)));  // km/h
        flight.v_speed = 0;
        flight.percent = Math.round(stage * 100);
    }
    return flight;
}

const LIVE_FIELDS = ['flight_iata', 'flight_icao', 'flight_number', 'airline_iata', 'airline_icao',
    'dep_iata', 'dep_icao', 'arr_iata', 'arr_icao', 'status'];

/** Les 20 vols, format réduit de la liste (pour la liste déroulante du site). */
export function demoList(nowMs = Date.now()) {
    return FLIGHTS.map(def => {
        const f = buildFlight(def, nowMs);
        const row = Object.fromEntries(LIVE_FIELDS.map(k => [k, f[k]]));
        row.demo = true;
        return row;
    });
}

/** Équivalent de /live : vols de démo de la compagnie (code IATA ou OACI). */
export function demoLive(param, value, nowMs = Date.now()) {
    const key = param === 'airline_icao' ? 'airline_icao' : 'airline_iata';
    return demoList(nowMs).filter(f => f[key] === value);
}

/** Équivalent de /flight : fiche du vol de démo, ou null s'il n'existe pas. */
export function demoFlight(param, value, nowMs = Date.now()) {
    const key = param === 'flight_icao' ? 'flight_icao' : 'flight_iata';
    const def = FLIGHTS.find(d => buildFlight(d, nowMs)[key] === value);
    return def ? buildFlight(def, nowMs) : null;
}

/** Équivalent de /track : position actuelle du vol de démo en cours. */
export function demoTrack(callsign, nowMs = Date.now()) {
    const f = demoFlight('flight_icao', callsign, nowMs) || demoFlight('flight_iata', callsign, nowMs);
    if (!f || f.status !== 'en-route') return null;
    return {
        callsign: f.flight_icao, hex: null, reg: f.reg_number, type: f.aircraft_icao,
        now: { lat: f.lat, lon: f.lng, alt: Math.round(f.alt * 3.28084), gs: Math.round(f.speed * 0.539957), track: f.dir, vs: 0, ts: f.updated },
        track: [], source: 'demo'
    };
}
