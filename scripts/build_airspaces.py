#!/usr/bin/env python3
"""
Génère data/airspaces/ : espaces aériens OpenAIP découpés en tuiles de 5° x 5°, chargées à la demande par la carte.

Source : OpenAIP (https://www.openaip.net), licence CC BY-NC 4.0 : attribution obligatoire, usage non commercial.
Clé d'API gratuite (compte openaip.net, Profil > API) dans la variable d'environnement OPENAIP_API_KEY ;
sans clé, le script ne fait rien (la couche reste désactivée sur le site) et se termine en succès.

Types retenus (par défaut) : 1 réglementée (R), 2 dangereuse (D), 3 interdite (P), 4 CTR, 7 TMA, 12 ADIZ.

Sortie
    <output>/data/airspaces/index.json   {"updated", "source", "tile": 5, "unit": 0.01, "tiles": {"5_45": 12, ...}}
    <output>/data/airspaces/<lon0>_<lat0>.json   [{"n": nom, "t": type, "c": classe OACI (lettre), "lo": plancher,
                                                   "hi": plafond, "g": anneau}, ...]
    anneau = [x0, y0, dx1, dy1, ...] en centièmes de degré (même codage que world.json) ; un espace aérien
    qui chevauche plusieurs tuiles est répété dans chacune.

    python scripts/build_airspaces.py --output dist
    python scripts/build_airspaces.py --output dist --from-file items.json   # réponses d'API déjà téléchargées (tests)
"""

import argparse
import datetime
import json
import math
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.core.openaip.net/api/airspaces"
DEFAULT_TYPES = [1, 2, 3, 4, 7, 12]
CLASSES = {0: "A", 1: "B", 2: "C", 3: "D", 4: "E", 5: "F", 6: "G"}
TILE = 5
SIMPLIFY_DEG = 0.01   # ~1 km
PAGE = 1000


def fetch_page(key, params, retries=5):
    url = API + "?" + urllib.parse.urlencode(params)
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={"x-openaip-api-key": key, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            if err.code in (429, 502, 503, 504) and attempt < retries - 1:
                time.sleep(5 * (attempt + 1))
                continue
            raise
    raise RuntimeError("inaccessible")


def fetch_all(key, types):
    items = []
    for t in types:
        page = 1
        while page:
            data = fetch_page(key, {"type": t, "page": page, "limit": PAGE,
                                    "fields": "name,type,icaoClass,upperLimit,lowerLimit,geometry"})
            items += data.get("items", [])
            print(f"  type {t}: page {page}/{data.get('totalPages', '?')} ({len(items)} espaces aériens)")
            page = data.get("nextPage")
            time.sleep(0.5)   # l'API est limitée en débit
    return items


def limit_text(lim):
    if not lim:
        return ""
    v, unit, datum = lim.get("value", 0), lim.get("unit"), lim.get("referenceDatum")
    if unit == 6:
        return f"FL{v:03d}"
    if v == 0 and datum == 0:
        return "GND"
    suffix = {0: "AGL", 1: "AMSL", 2: ""}.get(datum, "")
    return f"{v} {'m' if unit == 0 else 'ft'} {suffix}".strip()


def simplify(pts, tol):
    """Ramer-Douglas-Peucker itératif ; un anneau fermé est coupé au point le plus éloigné du départ."""
    if len(pts) < 5:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    if pts[0] == pts[-1]:
        far = max(range(1, len(pts) - 1), key=lambda i: (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2)
        keep[far] = True
        stack = [(0, far), (far, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy) or 1e-12
        best, idx = 0.0, None
        for i in range(a + 1, b):
            d = abs(dy * (pts[i][0] - ax) - dx * (pts[i][1] - ay)) / norm
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def encode_ring(ring):
    out, prev = [], None
    for lon, lat in ring:
        x, y = round(lon * 100), round(lat * 100)
        out += [x, y] if prev is None else [x - prev[0], y - prev[1]]
        prev = (x, y)
    return out


def build_tiles(items):
    tiles = {}
    kept = 0
    for it in items:
        geom = it.get("geometry") or {}
        if geom.get("type") != "Polygon" or not geom.get("coordinates"):
            continue
        ring = simplify([(p[0], p[1]) for p in geom["coordinates"][0]], SIMPLIFY_DEG)
        if len(ring) < 4:
            continue
        rec = {"n": it.get("name", ""), "t": it.get("type", 0), "c": CLASSES.get(it.get("icaoClass"), ""),
               "lo": limit_text(it.get("lowerLimit")), "hi": limit_text(it.get("upperLimit")), "g": encode_ring(ring)}
        lons, lats = [p[0] for p in ring], [p[1] for p in ring]
        for x in range(math.floor(min(lons) / TILE), math.floor(max(lons) / TILE) + 1):
            for y in range(math.floor(min(lats) / TILE), math.floor(max(lats) / TILE) + 1):
                tiles.setdefault((x * TILE, y * TILE), []).append(rec)
        kept += 1
    return tiles, kept


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", default="dist")
    ap.add_argument("--types", default=",".join(map(str, DEFAULT_TYPES)), help="types OpenAIP, séparés par des virgules")
    ap.add_argument("--from-file", help="JSON (liste d'espaces aériens au format de l'API) au lieu d'appeler l'API")
    args = ap.parse_args()

    if args.from_file:
        items = json.load(open(args.from_file, encoding="utf-8"))
    else:
        key = os.environ.get("OPENAIP_API_KEY", "").strip()
        if not key:
            print("OPENAIP_API_KEY absente : couche des espaces aériens non générée.")
            return
        items = fetch_all(key, [int(t) for t in args.types.split(",") if t.strip()])
    if not items:
        sys.exit("Aucun espace aérien reçu.")

    tiles, kept = build_tiles(items)
    out_dir = os.path.join(args.output, "data", "airspaces")
    shutil.rmtree(out_dir, ignore_errors=True)
    os.makedirs(out_dir)
    total = 0
    for (x, y), recs in tiles.items():
        path = os.path.join(out_dir, f"{x}_{y}.json")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(recs, f, separators=(",", ":"), ensure_ascii=False)
        total += os.path.getsize(path)
    index = {"updated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
             "source": "OpenAIP (CC BY-NC 4.0)", "tile": TILE, "unit": 0.01,
             "tiles": {f"{x}_{y}": len(r) for (x, y), r in tiles.items()}}
    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(index, f, separators=(",", ":"))
    print(f"{out_dir} : {kept} espaces aériens, {len(tiles)} tuiles, {total:,} octets")


if __name__ == "__main__":
    main()
