#!/usr/bin/env python3
"""
AirportSketch - Simulateur local du proxy de vols (worker/flight-proxy.js)

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
"""

import argparse
import datetime
import hashlib
import json
import random
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# Mêmes règles que ROUTES dans flight-proxy.js
ROUTES = {
    "/live": {
        "airline_iata": re.compile(r"^[A-Z0-9]{2}$"),
        "airline_icao": re.compile(r"^[A-Z]{3}$"),
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
    parser = argparse.ArgumentParser(description="Simulateur local du proxy AirLabs d'AirportSketch")
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
