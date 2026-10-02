#!/usr/bin/env python3
"""
Plein Axe - Simulateur local du proxy de vols (worker/flight-proxy.js)

Remplace `wrangler dev` pour le développement : mêmes routes, même validation,
même format de réponse, mais des vols générés localement. Aucune clé AirLabs,
aucun quota consommé, pas besoin de Node.

    python worker/mock_airlabs.py              # http://localhost:8787 (aussi accessible du réseau local)
    python worker/mock_airlabs.py --delay 800  # latence simulée en ms (défaut 300)

Le site appelle automatiquement le port 8787 quand il est servi en local.

Les vols sont déterministes (un même numéro donne toujours la même route) et calés
sur l'heure courante, ce qui donne des statuts variés : en vol, prévu, atterri,
annulé, retardé.

Cas particuliers pour tester l'interface :
    ZZ / ZZZ ......... compagnie sans aucun vol en cours (liste vide)
    XX / XXX ......... erreur AirLabs simulée (HTTP 502)
    numéro 9999 ...... vol inconnu (ex : AF9999 -> « Aucun vol connu »)
    numéro 1 à 9 ..... statut forcé, pour retrouver chaque cas facilement :
                       1 en vol · 2 prévu · 3 atterri · 4 annulé · 5 en vol retardé de 45 min

Route /track?callsign=AFR1 (position actuelle du vol en cours, comme AirLabs en production) :
position simulée le long du grand cercle avec un léger écart latéral ; pas d'historique (track vide).
    vol pas en l'air ou compagnie ZZZ ... réponse null
    numéro 429 ....................... erreur « quota atteint » (HTTP 503)
"""

import argparse
import datetime
import hashlib
import json
import math
import os
import sys
import random
import re
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# Mêmes règles que ROUTES dans flight-proxy.js
ROUTES = {
    "/live": {
        "airline_iata": re.compile(r"^[A-Z0-9]{2}$"),
        "airline_icao": re.compile(r"^[A-Z]{3}$"),
    },
    "/track": {
        "callsign": re.compile(r"^[A-Z0-9]{3,8}$"),
    },
    "/flight": {
        "flight_iata": re.compile(r"^[A-Z0-9]{2}\d{1,4}[A-Z]?$"),
        "flight_icao": re.compile(r"^[A-Z]{3}\d{1,4}[A-Z]?$"),
    },
}

# (IATA, ICAO, nom, pays, hub IATA)
AIRLINES = [
    ("AF", "AFR", "Air France", "FR", "CDG"),
    ("BA", "BAW", "British Airways", "GB", "LHR"),
    ("LH", "DLH", "Lufthansa", "DE", "FRA"),
    ("KL", "KLM", "KLM", "NL", "AMS"),
    ("IB", "IBE", "Iberia", "ES", "MAD"),
    ("AZ", "ITY", "ITA Airways", "IT", "FCO"),
    ("U2", "EZY", "easyJet", "GB", "LGW"),
    ("DL", "DAL", "Delta Air Lines", "US", "ATL"),
    ("UA", "UAL", "United Airlines", "US", "ORD"),
    ("AA", "AAL", "American Airlines", "US", "DFW"),
    ("EK", "UAE", "Emirates", "AE", "DXB"),
]

# (IATA, ICAO, ville, pays, décalage UTC en heures, sans heure d'été)
AIRPORTS = {
    "CDG": ("LFPG", "Paris", "FR", 1), "ORY": ("LFPO", "Paris", "FR", 1), "NCE": ("LFMN", "Nice", "FR", 1),
    "LYS": ("LFLL", "Lyon", "FR", 1), "MRS": ("LFML", "Marseille", "FR", 1), "TLS": ("LFBO", "Toulouse", "FR", 1),
    "LHR": ("EGLL", "London", "GB", 0), "LGW": ("EGKK", "London", "GB", 0), "FRA": ("EDDF", "Frankfurt", "DE", 1),
    "MUC": ("EDDM", "Munich", "DE", 1), "AMS": ("EHAM", "Amsterdam", "NL", 1), "MAD": ("LEMD", "Madrid", "ES", 1),
    "BCN": ("LEBL", "Barcelona", "ES", 1), "FCO": ("LIRF", "Rome", "IT", 1), "GVA": ("LSGG", "Geneva", "CH", 1),
    "JFK": ("KJFK", "New York", "US", -5), "SFO": ("KSFO", "San Francisco", "US", -8), "LAX": ("KLAX", "Los Angeles", "US", -8),
    "ORD": ("KORD", "Chicago", "US", -6), "ATL": ("KATL", "Atlanta", "US", -5), "DFW": ("KDFW", "Dallas", "US", -6),
    "BOS": ("KBOS", "Boston", "US", -5), "MIA": ("KMIA", "Miami", "US", -5), "DXB": ("OMDB", "Dubai", "AE", 4),
    "YUL": ("CYUL", "Montreal", "CA", -5), "NRT": ("RJAA", "Tokyo", "JP", 9),
}

# Coordonnées (lat, lon) des aéroports ci-dessus
COORDS = {
    "CDG": (49.0128, 2.55), "ORY": (48.7233, 2.3794), "NCE": (43.6584, 7.2159), "LYS": (45.7256, 5.0811),
    "MRS": (43.4393, 5.2214), "TLS": (43.6293, 1.3638), "LHR": (51.4706, -0.4619), "LGW": (51.1537, -0.1821),
    "FRA": (50.0379, 8.5622), "MUC": (48.3538, 11.7861), "AMS": (52.3086, 4.7639), "MAD": (40.4936, -3.5668),
    "BCN": (41.2971, 2.0785), "FCO": (41.8003, 12.2389), "GVA": (46.2381, 6.1089), "JFK": (40.6398, -73.7789),
    "SFO": (37.6213, -122.379), "LAX": (33.9416, -118.4085), "ORD": (41.9742, -87.9073), "ATL": (33.6407, -84.4277),
    "DFW": (32.8998, -97.0403), "BOS": (42.3656, -71.0096), "MIA": (25.7959, -80.287), "DXB": (25.2532, 55.3657),
    "YUL": (45.4706, -73.7408), "NRT": (35.772, 140.3929),
}

AIRCRAFT = ["A320", "A321", "A319", "B738", "B38M", "A20N", "A21N", "B772", "B77W", "B789", "A333", "A359", "A388", "E190"]

UNKNOWN_FLIGHT = 9999
FORCED_STATUS = {1: "en-route", 2: "scheduled", 3: "landed", 4: "cancelled", 5: "delayed"}


def rng_for(*parts) -> random.Random:
    """Générateur déterministe : un même vol donne toujours les mêmes valeurs."""
    seed = hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()
    return random.Random(int(seed[:16], 16))


def find_airline(code: str):
    for a in AIRLINES:
        if code in (a[0], a[1]):
            return a
    # Compagnie inconnue : générée à partir de son code
    r = rng_for("airline", code)
    iata = code if len(code) == 2 else code[:2]
    icao = code if len(code) == 3 else (code + "X")[:3]
    return (iata, icao, f"Compagnie {code}", "XX", r.choice(list(AIRPORTS)))


def fmt(dt: datetime.datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M")


def generate_flight(airline, number: int, now: datetime.datetime):
    """Fiche complète au format AirLabs /flight, cohérente avec l'heure courante."""
    iata, icao, name, country, hub = airline
    r = rng_for("flight", icao, number)

    # Route : départ ou arrivée au hub de la compagnie
    other = r.choice([a for a in AIRPORTS if a != hub])
    dep, arr = (hub, other) if r.random() < 0.5 else (other, hub)
    duration = r.randint(55, 720) if AIRPORTS[dep][2] != AIRPORTS[arr][2] else r.randint(50, 110)

    # Horaire prévu, réparti sur une fenêtre de -14 h à +10 h autour de maintenant (heure entière du générateur)
    hour = now.replace(minute=0, second=0, microsecond=0)
    dep_utc = hour + datetime.timedelta(minutes=r.randint(-14 * 60, 10 * 60) // 5 * 5)

    forced = FORCED_STATUS.get(number)
    now5 = now.replace(minute=now.minute // 5 * 5, second=0, microsecond=0)
    if forced == "en-route":
        dep_utc = now5 - datetime.timedelta(minutes=duration // 2 // 5 * 5)
    elif forced == "delayed":
        dep_utc = now5 - datetime.timedelta(minutes=45 + duration // 2 // 5 * 5)
    elif forced == "scheduled":
        dep_utc = hour + datetime.timedelta(hours=3)
    elif forced in ("landed", "cancelled"):
        dep_utc = hour - datetime.timedelta(minutes=(duration + 90) // 5 * 5)

    delay = 45 if forced == "delayed" else (r.choice([0, 0, 0, 0, 5, 10, 20, 35, 70]) if not forced else 0)
    dep_real = dep_utc + datetime.timedelta(minutes=delay)
    arr_utc = dep_utc + datetime.timedelta(minutes=duration)
    arr_real = arr_utc + datetime.timedelta(minutes=delay)

    if forced:
        status = "en-route" if forced == "delayed" else forced
    elif now < dep_real:
        status = "scheduled"
    elif now < arr_real:
        status = "en-route"
    else:
        status = "landed"

    def local(code, dt):
        return dt + datetime.timedelta(hours=AIRPORTS[code][3])

    def side(prefix, code, sched, real):
        icao_code, city, ctry, _ = AIRPORTS[code]
        started = status in ("en-route", "landed") if prefix == "dep" else status == "landed"
        return {
            f"{prefix}_iata": code,
            f"{prefix}_icao": icao_code,
            f"{prefix}_terminal": r.choice([None, "1", "2", "2E", "2F", "3", "A", "B", "S"]),
            f"{prefix}_gate": r.choice([None, f"{r.choice('ABCDEFKL')}{r.randint(1, 60)}"]),
            f"{prefix}_time": fmt(local(code, sched)),
            f"{prefix}_estimated": fmt(local(code, real)) if delay and status != "cancelled" else None,
            f"{prefix}_actual": fmt(local(code, real)) if started else None,
            f"{prefix}_time_utc": fmt(sched),
            f"{prefix}_estimated_utc": fmt(real) if delay and status != "cancelled" else None,
            f"{prefix}_actual_utc": fmt(real) if started else None,
            f"{prefix}_time_ts": int(sched.timestamp()),
            f"{prefix}_delayed": delay or None,
            f"{prefix}_name": f"{city} Airport",
            f"{prefix}_city": city,
            f"{prefix}_country": ctry,
        }

    elapsed = (now - dep_real).total_seconds() / 60
    flight = {
        "aircraft_icao": r.choice(AIRCRAFT),
        "airline_iata": iata,
        "airline_icao": icao,
        "flight_iata": f"{iata}{number}",
        "flight_icao": f"{icao}{number}",
        "flight_number": str(number),
        **side("dep", dep, dep_utc, dep_real),
        **side("arr", arr, arr_utc, arr_real),
        "arr_baggage": str(r.randint(1, 45)) if r.random() < 0.6 else None,
        "cs_airline_iata": None,
        "cs_flight_number": None,
        "cs_flight_iata": None,
        "reg_number": f"F-{''.join(r.choice('ABCDEFGHJKLMNPRSTUVWXYZ') for _ in range(4))}" if r.random() < 0.7 else None,
        "status": status,
        "duration": duration,
        "delayed": delay or None,
        "updated": int(now.timestamp()),
        "airline_name": name,
        "flag": country,
        "percent": max(0, min(100, round(elapsed / duration * 100))) if status == "en-route" else (100 if status == "landed" else 0),
        "type": "landplane",
        "utc": fmt(now),
    }
    return flight


sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import airspace  # noqa: E402  (plus court chemin autour de la Russie, de l'Ukraine et du Bélarus)

_AVOID = airspace.load_avoid(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts", "assets", "world.json"))
_ROUTES = {}


def flight_route(dep, arr):
    """Route estimée dep -> arr : couloir éventuel puis contournement des zones interdites (mise en cache)."""
    if (dep, arr) not in _ROUTES:
        _ROUTES[(dep, arr)] = airspace.plan_path(_AVOID, dep, arr)
    return _ROUTES[(dep, arr)]


def great_circle(a, b, f):
    """Point à la fraction f (0..1) du grand cercle a -> b, avec (lat, lon) en degrés."""
    r = math.pi / 180
    la1, lo1, la2, lo2 = a[0] * r, a[1] * r, b[0] * r, b[1] * r
    d = 2 * math.asin(math.sqrt(math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2))
    if d == 0:
        return a
    A, B = math.sin((1 - f) * d) / math.sin(d), math.sin(f * d) / math.sin(d)
    x = A * math.cos(la1) * math.cos(lo1) + B * math.cos(la2) * math.cos(lo2)
    y = A * math.cos(la1) * math.sin(lo1) + B * math.cos(la2) * math.sin(lo2)
    z = A * math.sin(la1) + B * math.sin(la2)
    return (math.atan2(z, math.hypot(x, y)) / r, math.atan2(y, x) / r)


def bearing(a, b):
    r = math.pi / 180
    dl = (b[1] - a[1]) * r
    y = math.sin(dl) * math.cos(b[0] * r)
    x = math.cos(a[0] * r) * math.sin(b[0] * r) - math.sin(a[0] * r) * math.cos(b[0] * r) * math.cos(dl)
    return round((math.atan2(y, x) / r + 360) % 360)


def generate_track(airline, number: int, now):
    """Réponse /track : trajectoire simulée du vol en cours, ou None s'il n'est pas en l'air."""
    f = generate_flight(airline, number, now)
    if f["status"] != "en-route":
        return None
    r = rng_for("track", airline[1], number)
    dep, arr = COORDS[f["dep_iata"]], COORDS[f["arr_iata"]]
    duration = f["duration"]
    progress = max(0.02, min(0.98, f["percent"] / 100))
    started = datetime.datetime.strptime(f["dep_actual_utc"], "%Y-%m-%d %H:%M")
    route = flight_route(dep, arr)
    detour = len(route) > 2   # route contournée : on la suit exactement (pas d'écart latéral simulé)
    amp = 0 if detour else r.uniform(-1, 1) * 1.6 * min(1, duration / 400)  # écart latéral max en degrés

    def pos(frac):
        if detour:
            return airspace.point_along(route, frac)[:2]
        lat, lon = great_circle(dep, arr, frac)
        # écart perpendiculaire approximatif, nul au départ et à l'arrivée
        dlat = amp * math.sin(math.pi * frac) * math.cos(math.radians(bearing(dep, arr) + 90))
        dlon = amp * math.sin(math.pi * frac) * math.sin(math.radians(bearing(dep, arr) + 90)) / max(0.3, math.cos(math.radians(lat)))
        return (lat + dlat, lon + dlon)

    def alt(frac):
        up = min(1, frac / 0.12)
        down = min(1, (1 - frac) / 0.1)
        return round((400 + (37000 - 400) * min(up, down)) / 100) * 100

    n = max(8, int(progress * 70))
    fracs = [progress * i / n for i in range(n + 1)]
    if duration > 300:  # lacune de couverture au-dessus de l'océan
        fracs = [x for x in fracs if not (0.38 < x < 0.58)]
    track = []
    for x in fracs:
        la, lo = pos(x)
        ts = int((started + datetime.timedelta(minutes=x * duration)).replace(tzinfo=datetime.timezone.utc).timestamp())
        track.append([round(la, 4), round(lo, 4), alt(x), ts])
    cur = pos(progress)
    prev = pos(max(0, progress - 0.01))
    track.append([round(cur[0], 4), round(cur[1], 4), alt(progress), int(now.replace(tzinfo=datetime.timezone.utc).timestamp())])
    return {
        "callsign": f["flight_icao"],
        "hex": f"{rng_for('hex', airline[1], number).getrandbits(24):06x}",
        "reg": f["reg_number"],
        "type": f["aircraft_icao"],
        "now": {"lat": round(cur[0], 4), "lon": round(cur[1], 4), "alt": alt(progress), "gs": r.randint(430, 490),
                "track": bearing(prev, cur), "vs": 0, "ts": track[-1][3]},
        "track": [],  # comme en production : position seule, sans historique
        "source": "mock",
    }


# --- Météo : vraie météo NOAA (gratuite, sans clé), même format compact que worker/weather.js -------------
_WX_CACHE = {}


def _noaa(kind, ids):
    out = subprocess.run(["curl", "-sS", "-m", "20", f"https://aviationweather.gov/api/data/{kind}?ids={','.join(ids)}&format=json"],
                         capture_output=True, check=True).stdout
    return json.loads(out) if out.strip() else []


def _compact_metar(m):
    return {"raw": m.get("rawOb", ""), "cat": m.get("fltCat"), "t": m.get("obsTime"), "temp": m.get("temp"), "dewp": m.get("dewp"),
            "wdir": m.get("wdir"), "wspd": m.get("wspd"), "wgst": m.get("wgst"), "vis": m.get("visib"), "alt": m.get("altim"),
            "clouds": [[c.get("cover"), c.get("base")] for c in m.get("clouds") or []], "wx": m.get("wxString")}


def _compact_taf(t):
    issue = t.get("issueTime")
    return {"raw": t.get("rawTAF", ""),
            "issue": int(datetime.datetime.fromisoformat(issue.replace("Z", "+00:00")).timestamp()) if issue else None,
            "from": t.get("validTimeFrom"), "to": t.get("validTimeTo"),
            "fc": [{"f": f.get("timeFrom"), "t": f.get("timeTo"), "ch": f.get("fcstChange"), "p": f.get("probability"),
                    "wdir": f.get("wdir"), "wspd": f.get("wspd"), "wgst": f.get("wgst"), "vis": f.get("visib"), "wx": f.get("wxString"),
                    "clouds": [[c.get("cover"), c.get("base")] for c in f.get("clouds") or []]} for f in t.get("fcsts") or []]}


def weather_response(query):
    ids = sorted({i.strip().upper() for i in (query.get("ids") or [""])[0].split(",") if i.strip()})
    if not ids or len(ids) > 150 or not all(re.fullmatch(r"[A-Z0-9]{3,4}", i) for i in ids):
        return 400, {"error": {"message": "Paramètre ids invalide (1 à 150 codes OACI)"}}
    want_taf = (query.get("taf") or [""])[0] == "1"
    out = {}
    try:
        for kind, compact, ttl in (("metar", _compact_metar, 300), ("taf", _compact_taf, 900)):
            if kind == "taf" and not want_taf:
                continue
            now = time.time()
            missing = [i for i in ids if not (_WX_CACHE.get((kind, i)) and _WX_CACHE[(kind, i)][0] > now)]
            for k in range(0, len(missing), 100):
                batch = missing[k:k + 100]
                found = {}
                for r in _noaa(kind, batch):
                    found.setdefault(r.get("icaoId"), compact(r))
                for i in batch:
                    _WX_CACHE[(kind, i)] = (now + ttl, found.get(i))
            out[kind] = {i: _WX_CACHE[(kind, i)][1] for i in ids}
    except Exception:
        return 502, {"error": {"message": "Service météo indisponible"}}
    return 200, out


LIVE_FIELDS = ["flight_iata", "flight_icao", "flight_number", "airline_iata", "airline_icao",
               "dep_iata", "dep_icao", "arr_iata", "arr_icao", "status"]


def live_flights(airline, now):
    """Vols en cours de la compagnie (format réduit de /live), ~25 vols cohérents avec /flight."""
    r = rng_for("live", airline[1], now.strftime("%Y-%m-%d %H"))
    numbers = [1, 5] + sorted({r.randint(6, 9998) for _ in range(400)})
    result = []
    for n in numbers:
        f = generate_flight(airline, n, now)
        if f["status"] == "en-route":
            result.append({k: f[k] for k in LIVE_FIELDS})
        if len(result) >= 25:
            break
    return result


class Handler(BaseHTTPRequestHandler):
    delay_ms = 300

    def _send(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        origin = self.headers.get("Origin")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Vary", "Origin")
        self.send_header("X-Mock", "airlabs")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_POST(self):
        self._send(405, {"error": {"message": "Méthode non autorisée"}})

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/wx":
            return self._send(*weather_response(parse_qs(url.query)))
        params = ROUTES.get(url.path)
        if params is None:
            return self._send(404, {"error": {"message": "Route inconnue"}})

        query = {k: v[0].upper() for k, v in parse_qs(url.query).items() if k in params and v and v[0]}
        if len(query) != 1:
            return self._send(400, {"error": {"message": "Paramètre invalide"}})
        name, value = next(iter(query.items()))
        if not params[name].match(value):
            return self._send(400, {"error": {"message": "Paramètre invalide"}})

        time.sleep(self.delay_ms / 1000)
        now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)

        if url.path == "/track":
            if value.startswith(("XXX", "XX")):
                return self._send(502, {"error": {"message": "Position du vol indisponible"}})
            m = re.match(r"^([A-Z]{3})(\d{1,4})", value)
            if not m or m.group(1) == "ZZZ":
                return self._send(200, {"response": None})
            if int(m.group(2)) == 429:
                return self._send(503, {"error": {"message": "Quota de suivi atteint, réessayez plus tard", "code": "rate_limited"}})
            return self._send(200, {"response": generate_track(find_airline(m.group(1)), int(m.group(2)), now)})

        if url.path == "/live":
            if value in ("XX", "XXX"):
                return self._send(502, {"error": {"message": "Erreur AirLabs simulée", "code": "mock_error"}})
            if value in ("ZZ", "ZZZ"):
                return self._send(200, {"response": []})
            return self._send(200, {"response": live_flights(find_airline(value), now)})

        airline_code = value[:3] if name == "flight_icao" else value[:2]
        number = int(re.match(r"\d+", value[len(airline_code):]).group())
        if airline_code in ("XX", "XXX"):
            return self._send(502, {"error": {"message": "Erreur AirLabs simulée", "code": "mock_error"}})
        if number == UNKNOWN_FLIGHT or airline_code in ("ZZ", "ZZZ"):
            return self._send(200, {"response": None})
        return self._send(200, {"response": generate_flight(find_airline(airline_code), number, now)})

    def log_message(self, fmt_, *args):
        print(f"[mock] {self.address_string()} {fmt_ % args}")


def main():
    parser = argparse.ArgumentParser(description="Simulateur local du proxy AirLabs de Plein Axe")
    parser.add_argument("--port", type=int, default=8787, help="port d'écoute (défaut 8787, celui attendu par le site)")
    parser.add_argument("--host", default="0.0.0.0", help="interface (défaut 0.0.0.0 : accessible depuis un téléphone du réseau local)")
    parser.add_argument("--delay", type=int, default=300, help="latence simulée en ms (défaut 300)")
    args = parser.parse_args()

    Handler.delay_ms = args.delay
    # Sans SO_REUSEADDR : sous Windows il permettrait de partager le port avec `wrangler dev`
    # sans erreur, et on ne saurait plus qui répond
    ThreadingHTTPServer.allow_reuse_address = False
    try:
        server = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as e:
        raise SystemExit(f"Port {args.port} indisponible ({e}). `wrangler dev` tourne-t-il déjà ? "
                         f"Arrêtez-le ou utilisez --port.")
    print(f"Simulateur AirLabs sur http://localhost:{args.port}  (latence {args.delay} ms, Ctrl+C pour arrêter)")
    print("  Essais : /live?airline_iata=AF   /flight?flight_iata=AF1 (en vol) … AF5 (retardé)   AF9999 (inconnu)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
