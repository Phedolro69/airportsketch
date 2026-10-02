#!/usr/bin/env python3
"""
Génère data/conflict_zones.json : zones de conflit (bulletins CZIB de l'EASA) avec le contour des FIR concernées.

Sources
  - Bulletins CZIB : https://www.easa.europa.eu/en/domains/air-operations/czibs (pages publiques, texte parsé ici :
    statut, validité, espace aérien concerné, recommandation).
  - Contours des FIR : VATSpy Data Project (Boundaries.geojson, CC-BY-SA 4.0), identifiants = codes OACI des FIR.

Sortie
    {"updated": "...", "zones": [{"id", "title", "level", "valid_until", "url", "scope", "firs": [...]}],
     "firs": {"ORBB": [anneau, ...]}, "unit": 0.01}
    level : "high" (« ne pas opérer ») | "caution" (précautions) | "info"
    anneau = [x0, y0, dx1, dy1, ...] en centièmes de degré (même codage que world.json)

Le contenu des bulletins n'a pas de format machine : si EASA change la mise en page, le script échoue
bruyamment (aucune zone trouvée) plutôt que de publier un fichier vide.

    python scripts/build_conflict_zones.py --output dist
"""

import argparse
import datetime
import html
import json
import os
import re
import sys
import urllib.request

LIST_URL = "https://www.easa.europa.eu/en/domains/air-operations/czibs"
BASE = "https://www.easa.europa.eu"
FIR_URL = "https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/master/Boundaries.geojson"
UA = {"User-Agent": "Mozilla/5.0 (PleinAxe conflict-zones build)"}
SIMPLIFY_DEG = 0.04   # tolérance de simplification des contours (~4 km)


def fetch(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def text_of(page):
    page = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", page, flags=re.S)
    t = html.unescape(re.sub(r"<[^>]+>", "\n", page))
    return re.sub(r"\s*\n\s*", "\n", t)


def field(t, label, stop):
    """Texte entre l'étiquette du champ et la suivante (les pages EASA alternent étiquette / valeur)."""
    m = re.search(rf"\n{re.escape(label)}\n(.*?)\n(?:{stop})\n", t + "\n", re.S)
    return m.group(1).strip() if m else ""


def parse_bulletin(url):
    t = text_of(fetch(url))
    stop = "Affected Countries|Applicability|Referenced publication\\(s\\):|Description"
    zone = {
        "id": field(t, "CZIB number", "Issue date") or url.rsplit("/", 1)[-1].upper(),
        "status": field(t, "Status", "CZIB number"),
        "valid_until": field(t, "Valid until", "Referenced publication\\(s\\):|Affected Airspace"),
        "scope": field(t, "Affected Airspace", stop),
        "url": url,
    }
    title = re.search(r"\n(Airspace of [^\n]+)\n", t)
    zone["title"] = title.group(1) if title else zone["id"]
    reco = t.split("\nRecommendation(s)\n", 1)[-1].split("\nContact us\n", 1)[0] if "Recommendation(s)" in t else ""
    low = reco.lower()
    zone["level"] = "high" if re.search(r"not operate|not to operate|avoid", low) else "caution" if re.search(r"caution|risk", low) else "info"
    zone["firs"] = sorted(set(re.findall(r"(?<![A-Za-z])[A-Z]{4}(?![A-Za-z])", zone["scope"])))   # filtré plus loin sur les FIR connues
    zone["valid_until"] = re.sub(r",? unless reviewed earlier\.?", "", zone["valid_until"])
    return zone


def simplify(pts, tol):
    """Ramer-Douglas-Peucker itératif sur une liste de [lon, lat]."""
    if len(pts) < 4:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    if pts[0] == pts[-1]:   # anneau fermé : la base est de longueur nulle, on coupe au point le plus éloigné
        far = max(range(1, len(pts) - 1), key=lambda i: (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2)
        keep[far] = True
        stack = [(0, far), (far, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy = bx - ax, by - ay
        norm = (dx * dx + dy * dy) ** 0.5 or 1e-12
        best, idx = 0.0, None
        for i in range(a + 1, b):
            d = abs(dy * (pts[i][0] - ax) - dx * (pts[i][1] - ay)) / norm
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def clip_lon(ring, lon_max=None, lon_min=None):
    """Découpe un anneau [[lon, lat]...] au demi-plan lon <= lon_max (ou lon >= lon_min) : Sutherland-Hodgman."""
    keep = (lambda p: p[0] <= lon_max) if lon_max is not None else (lambda p: p[0] >= lon_min)
    edge = lon_max if lon_max is not None else lon_min
    out = []
    for a, b in zip(ring, ring[1:] + ring[:1]):
        ka, kb = keep(a), keep(b)
        if ka:
            out.append(a)
        if ka != kb:
            t = (edge - a[0]) / (b[0] - a[0])
            out.append([edge, a[1] + t * (b[1] - a[1])])
    return out


def scope_clip(scope):
    """« west of longitude 60° East » -> {"lon_max": 60} ; « east of longitude 30° West » -> {"lon_min": -30}."""
    m = re.search(r"(west|east) of longitude\s+(\d+(?:\.\d+)?)\s*°?\s*(East|West|E|W)(?![a-z])", scope, re.I)
    if not m:
        return None
    lon = float(m.group(2)) * (1 if m.group(3).lower().startswith("e") else -1)
    return {"lon_max": lon} if m.group(1).lower() == "west" else {"lon_min": lon}


def encode_ring(ring):
    """Anneau [[lon, lat]...] -> [x0, y0, dx1, dy1, ...] en centièmes de degré ; longitudes rendues continues."""
    out, prev = [], None
    for lon, lat in ring:
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
    args = ap.parse_args()

    listing = fetch(LIST_URL)
    urls = sorted(set(re.findall(r'href="(/en/domains/air-operations/czibs/(?:czib-)?20\d\d-[^"]+)"', listing)))
    zones = []
    for path in urls:
        try:
            z = parse_bulletin(BASE + path)
        except Exception as err:   # une page illisible ne doit pas faire perdre les autres
            print(f"  ! {path}: {err}", file=sys.stderr)
            continue
        if z["status"].lower() != "active":
            continue
        zones.append(z)
        print(f"  {z['id']:<18} {z['level']:<8} FIR {','.join(z['firs']) or '-':<24} {z['scope'][:60]!r}")
    if not zones:
        sys.exit("Aucun bulletin CZIB actif lu : la mise en page de l'EASA a peut-être changé.")

    wanted = {c for z in zones for c in z["firs"]}
    geo = json.loads(fetch(FIR_URL))
    raw, firs = {}, {}
    for feat in geo["features"]:
        fid = feat["properties"]["id"]
        if fid not in wanted:
            continue
        g = feat["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        raw[fid] = [simplify(poly[0], SIMPLIFY_DEG) for poly in polys]   # contour extérieur seulement
    for z in zones:
        missing = [c for c in z["firs"] if c not in raw]
        if missing:
            print(f"  ! {z['id']}: contour introuvable pour {', '.join(missing)}", file=sys.stderr)
        z["firs"] = [c for c in z["firs"] if c in raw]
        clip = scope_clip(z["scope"])
        if clip:
            # Le bulletin ne vise qu'une partie des FIR : les anneaux découpés sont portés par la zone elle-même
            z["clip"] = clip
            z["rings"] = [encode_ring(r) for c in z["firs"] for ring in raw[c] if len(r := clip_lon(ring, **clip)) >= 3]
            print(f"  {z['id']}: découpé {clip}")
        else:
            for c in z["firs"]:
                firs.setdefault(c, [encode_ring(r) for r in raw[c]])

    out_dir = os.path.join(args.output, "data")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "conflict_zones.json")
    payload = {
        "updated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "source": "EASA CZIB ; contours FIR : VATSpy Data Project (CC-BY-SA 4.0)",
        "zones": zones, "firs": firs, "unit": 0.01,
    }
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, separators=(",", ":"), ensure_ascii=False)
    print(f"{out} : {len(zones)} zones, {len(firs)} FIR, {os.path.getsize(out):,} octets")


if __name__ == "__main__":
    main()
