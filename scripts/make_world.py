#!/usr/bin/env python3
"""
Génère scripts/assets/world.json : fond de carte vectoriel pour la carte des vols.

Source : Natural Earth 1:50m (domaine public), via le paquet npm `world-atlas`
(TopoJSON, licence ISC). À relancer seulement pour changer la résolution ; le fichier
généré est versionné et copié dans data/world.json par build_data.py.

    python scripts/make_world.py

Les longitudes sont rendues continues : un contour qui franchit la ligne de changement de date
dépasse ±180 (la carte du site se répète en longitude).

Format de sortie (coordonnées en centièmes de degré, codées en deltas) :
    {"land":    [anneau, ...],     # terres émergées, anneaux à remplir en "evenodd"
     "borders": [ligne, ...],      # frontières entre pays
     "unit": 0.01}
    anneau / ligne = [x0, y0, dx1, dy1, dx2, dy2, ...]  (x = longitude, y = latitude)
L'Antarctique est omis (aucun vol, et la projection Mercator l'étire à l'infini).
"""

import json
import math
import os
import subprocess
import sys

SOURCE = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "world.json")
UNIT = 0.01            # précision de sortie en degrés
SIMPLIFY_DEG = 0.02    # tolérance Douglas-Peucker (~2 km)
MIN_LAT = -60.0        # on écarte tout ce qui descend sous cette latitude (Antarctique)


def download(url: str) -> dict:
    # curl : le magasin de certificats de Python pose parfois problème sous Windows
    raw = subprocess.run(["curl", "-sS", "-L", "--max-time", "120", url], capture_output=True, check=True).stdout
    return json.loads(raw)


def decode_arcs(topo: dict):
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)
    return arcs


def arc_points(arcs, index: int):
    return arcs[index] if index >= 0 else arcs[~index][::-1]


def ring_points(arcs, ring):
    pts = []
    for i in ring:
        seg = arc_points(arcs, i)
        pts.extend(seg if not pts else seg[1:])
    return pts


def unwrap(points):
    """Longitudes continues : un contour qui passe de +180 à -180 poursuit au-delà de 180 (ex. Tchoukotka à 190°).
    Sans cela, le saut trace une bande horizontale sur toute la largeur de la carte."""
    out = [points[0]]
    for x, y in points[1:]:
        x += 360 * round((out[-1][0] - x) / 360)
        out.append((x, y))
    return out


def rdp(points, eps):
    """Douglas-Peucker itératif (évite la limite de récursion)."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = points[a], points[b]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        far, far_d = -1, 0.0
        for i in range(a + 1, b):
            px, py = points[i]
            d = math.hypot(px - ax, py - ay) if norm == 0 else abs(dy * (px - ax) - dx * (py - ay)) / norm
            if d > far_d:
                far, far_d = i, d
        if far_d > eps:
            keep[far] = True
            stack += [(a, far), (far, b)]
    return [p for p, k in zip(points, keep) if k]


def encode(points):
    q = [(round(x / UNIT), round(y / UNIT)) for x, y in points]
    out = [q[0][0], q[0][1]]
    for (px, py), (x, y) in zip(q, q[1:]):
        out += [x - px, y - py]
    return out


def main():
    topo = download(SOURCE)
    arcs = decode_arcs(topo)

    # Terres : tous les anneaux de l'objet "land" (extérieurs et trous), sans l'Antarctique
    land = []
    geoms = topo["objects"]["land"]["geometries"]
    for g in geoms:
        polys = g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]]
        for poly in polys:
            rings = [ring_points(arcs, r) for r in poly]
            if min(p[1] for p in rings[0]) < MIN_LAT:
                continue
            for r in rings:
                r = rdp(unwrap(r), SIMPLIFY_DEG)
                if len(r) >= 4:
                    land.append(encode(r))

    # Frontières : arcs partagés par deux pays différents
    uses = {}
    for gi, g in enumerate(topo["objects"]["countries"]["geometries"]):
        polys = g["arcs"] if g["type"] == "MultiPolygon" else ([g["arcs"]] if g["type"] == "Polygon" else [])
        for poly in polys:
            for ring in poly:
                for i in ring:
                    uses.setdefault(i if i >= 0 else ~i, set()).add(gi)
    borders = []
    for idx, owners in uses.items():
        if len(owners) < 2:
            continue
        pts = arcs[idx]
        if min(p[1] for p in pts) < MIN_LAT:
            continue
        pts = rdp(unwrap(pts), SIMPLIFY_DEG)
        if len(pts) >= 2:
            borders.append(encode(pts))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"unit": UNIT, "land": land, "borders": borders}, f, separators=(",", ":"))
    size = os.path.getsize(OUT)
    print(f"{OUT}: {size:,} octets ({len(land)} anneaux de terre, {len(borders)} frontières)")


if __name__ == "__main__":
    sys.exit(main())
