#!/usr/bin/env python3
"""
Génère data/gps_jamming.json : zones d'interférence GNSS (brouillage / leurrage probable) de la veille.

Source
  - GPSJam (https://gpsjam.org/data/) : un fichier par jour UTC, hexagones H3 de résolution 4 (~40 km), avec pour
    chacun le nombre d'avions ADS-B ayant signalé une bonne / mauvaise précision de navigation (NACp).
    Liste des jours publiés : data/manifest.csv (date, suspect, nombre de zones, ...).

Classement (même formule que GPSJam) : pct = 100 * (mauvais - 1) / (bons + mauvais)
    "high" : pct > 10   |   "medium" : 2 < pct <= 10   |   au-dessous : ignoré

Sortie
    {"updated": "...", "date": "AAAA-MM-JJ", "unit": 0.01,
     "hexes": [[niveau, avions touchés, avions, x0, y0, dx1, dy1, ...], ...]}   niveau : 2 = high, 1 = medium
    contour en centièmes de degré (même codage que world.json), longitudes rendues continues

    python scripts/build_gps_jamming.py --output dist
"""

import argparse
import csv
import datetime
import gzip
import io
import json
import os
import sys
import urllib.request

import h3

BASE = "https://gpsjam.org/data/"
UA = {"User-Agent": "Mozilla/5.0 (PleinAxe gps-jamming build)", "Accept-Encoding": "gzip"}


def fetch(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
        if r.headers.get("Content-Encoding") == "gzip" or raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        return raw.decode("utf-8", "replace")


def latest_date():
    """Dernier jour publié dans le manifeste (une ligne par jour, date en première colonne)."""
    rows = [r for r in csv.reader(io.StringIO(fetch(BASE + "manifest.csv"))) if r and r[0][:2] == "20"]
    if not rows:
        sys.exit("Manifeste GPSJam vide ou illisible.")
    return max(r[0] for r in rows)


def encode_ring(ring):
    """Anneau [(lat, lon)...] -> [x0, y0, dx1, dy1, ...] en centièmes de degré ; longitudes rendues continues."""
    out, prev = [], None
    for lat, lon in ring:
        x, y = round(lon * 100), round(lat * 100)
        if prev is not None:
            while x - prev[0] > 18000:
                x -= 36000
            while x - prev[0] < -18000:
                x += 36000
        out += [x, y] if prev is None else [x - prev[0], y - prev[1]]
        prev = (x, y)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", default="dist", help="dossier de sortie (le fichier va dans <output>/data/)")
    ap.add_argument("--date", help="jour UTC AAAA-MM-JJ (par défaut : le dernier publié)")
    args = ap.parse_args()

    date = args.date or latest_date()
    rows = csv.DictReader(io.StringIO(fetch(f"{BASE}{date}-h3_4.csv")))
    hexes, total = [], 0
    for r in rows:
        total += 1
        good, bad = int(r["count_good_aircraft"]), int(r["count_bad_aircraft"])
        if good + bad == 0:
            continue
        pct = 100 * (bad - 1) / (good + bad)
        if pct <= 2:
            continue
        level = 2 if pct > 10 else 1
        hexes.append([level, bad, good + bad] + encode_ring(h3.cell_to_boundary(r["hex"])))
    if total == 0:
        sys.exit(f"Fichier GPSJam du {date} vide.")

    out_dir = os.path.join(args.output, "data")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "gps_jamming.json")
    payload = {
        "updated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "date": date, "unit": 0.01, "hexes": hexes,
    }
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, separators=(",", ":"))
    high = sum(1 for h in hexes if h[0] == 2)
    print(f"{out} : {date}, {total} hexagones lus, {high} forts, {len(hexes) - high} modérés, {os.path.getsize(out):,} octets")


if __name__ == "__main__":
    main()
