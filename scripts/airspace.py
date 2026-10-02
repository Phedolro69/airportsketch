#!/usr/bin/env python3
"""
Espaces aériens à éviter (Russie, Ukraine, Bélarus) et route la plus courte qui les contourne.

Utilisé par :
  - make_world.py : construit les zones (contours simplifiés) et les points de contournement, écrits dans
    world.json (clé « avoid ») et lus par le site (même algorithme en JavaScript dans index.html) ;
  - worker/mock_airlabs.py : positions des vols simulés sur la route contournée ;
  - les tests : `python scripts/airspace.py` vérifie qu'aucune route ne traverse une zone, contre les
    contours COMPLETS (non simplifiés) de Natural Earth.

Méthode : graphe de visibilité sur la sphère. Les nœuds sont les coins saillants des zones, décalés vers
l'extérieur ; un segment (arc de grand cercle) est utilisable s'il ne croise aucun bord de zone ; plus court
chemin par A*. Tout est calculé en vecteurs 3D : aucun souci de ligne de changement de date (la Tchoukotka
chevauche le 180e méridien).

Couloirs imposés (réalité opérationnelle, plus longue que le plus court chemin) :
  Europe -> Japon/Corée : Turquie, Erevan, Urumqi ;  Japon/Corée -> Europe : Pacifique nord, détroit de
  Béring, Groenland. Chaque tronçon d'un couloir est lui aussi vérifié et contourné si besoin.
"""

import heapq
import json
import math
import subprocess
import sys

COUNTRIES_SOURCE = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json"
AVOID_IDS = {"643": "Russie", "804": "Ukraine", "112": "Bélarus"}   # codes ISO 3166 numériques
SIMPLIFY_DEG = 0.15       # tolérance de simplification des contours (~9 nm)
NODE_OFFSET_DEG = 0.4     # décalage des points de contournement vers l'extérieur (> 2 x tolérance)
MIN_RING_AREA = 0.05      # îlots plus petits ignorés (degrés carrés)
EARTH_NM = 3440.065
R = math.pi / 180

# Couloirs : (lat_min, lat_max, lon_min, lon_max)
EUROPE_BOX = (35.0, 72.0, -25.0, 45.0)
EAST_ASIA_BOX = (24.0, 46.0, 124.0, 146.0)
CORRIDOR_EAST = [(39.9, 32.9), (40.18, 44.51), (43.83, 87.62)]
CORRIDOR_WEST = [(40.0, 150.0), (55.0, -172.0), (65.6, -167.5), (71.0, -42.0)]


# ----------------------------------------------------------------------------------- géométrie 3D
def vec(lat, lon):
    la, lo = lat * R, lon * R
    return (math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la))


def latlon(v):
    x, y, z = v
    return (math.atan2(z, math.hypot(x, y)) / R, math.atan2(y, x) / R)


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def norm(a):
    n = math.sqrt(dot(a, a)) or 1.0
    return (a[0] / n, a[1] / n, a[2] / n)


def angle(a, b):
    c = cross(a, b)
    return math.atan2(math.sqrt(dot(c, c)), dot(a, b))


def arcs_cross(a, b, c, d):
    """Les arcs de grand cercle AB et CD (moins de 180°) se coupent-ils ?"""
    n1, n2 = cross(a, b), cross(c, d)
    t = cross(n1, n2)
    if dot(t, t) < 1e-24:
        return False
    t = norm(t)
    for p in (t, (-t[0], -t[1], -t[2])):
        if dot(cross(a, p), n1) >= 0 and dot(cross(p, b), n1) >= 0 and \
           dot(cross(c, p), n2) >= 0 and dot(cross(p, d), n2) >= 0:
            return True
    return False


def interpolate(a, b, f):
    """Point à la fraction f du grand cercle a -> b (vecteurs unitaires)."""
    d = angle(a, b)
    if d == 0:
        return a
    s1, s2 = math.sin((1 - f) * d) / math.sin(d), math.sin(f * d) / math.sin(d)
    return (s1 * a[0] + s2 * b[0], s1 * a[1] + s2 * b[1], s1 * a[2] + s2 * b[2])


def bearing(p, q):
    (la1, lo1), (la2, lo2) = latlon(p), latlon(q)
    dl = (lo2 - lo1) * R
    y = math.sin(dl) * math.cos(la2 * R)
    x = math.cos(la1 * R) * math.sin(la2 * R) - math.sin(la1 * R) * math.cos(la2 * R) * math.cos(dl)
    return round((math.atan2(y, x) / R + 360) % 360)


# ----------------------------------------------------------------------------------- zones
def _download(url):
    return json.loads(subprocess.run(["curl", "-sS", "-L", "--max-time", "120", url], capture_output=True, check=True).stdout)


def _rdp(points, eps):
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = points[a], points[b]
        dx, dy = bx - ax, by - ay
        nrm = math.hypot(dx, dy)
        far, far_d = -1, 0.0
        for i in range(a + 1, b):
            px, py = points[i]
            d = math.hypot(px - ax, py - ay) if nrm == 0 else abs(dy * (px - ax) - dx * (py - ay)) / nrm
            if d > far_d:
                far, far_d = i, d
        if far_d > eps:
            keep[far] = True
            stack += [(a, far), (far, b)]
    return [p for p, k in zip(points, keep) if k]


def _unwrap(points):
    out = [points[0]]
    for x, y in points[1:]:
        out.append((x + 360 * round((out[-1][0] - x) / 360), y))
    return out


def _area(ring):
    return 0.5 * sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]))


def full_rings(topo=None):
    """Contours extérieurs COMPLETS (non simplifiés) des pays à éviter, longitudes continues."""
    topo = topo or _download(COUNTRIES_SOURCE)
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

    def ring_pts(r):
        out = []
        for i in r:
            seg = arcs[i] if i >= 0 else arcs[~i][::-1]
            out.extend(seg if not out else seg[1:])
        return out

    rings = []
    for g in topo["objects"]["countries"]["geometries"]:
        if g.get("id") not in AVOID_IDS:
            continue
        polys = g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]]
        for poly in polys:
            rings.append(_unwrap(ring_pts(poly[0]))[:-1])
    return rings


def point_in_rings(rings, lat, lon):
    """Test planaire indépendant (contours complets), avec les copies du monde à ±360° de longitude."""
    for shift in (-360.0, 0.0, 360.0):
        x = lon + shift
        for rg in rings:
            hit = False
            j = len(rg) - 1
            for i in range(len(rg)):
                xi, yi = rg[i]
                xj, yj = rg[j]
                if (yi > lat) != (yj > lat) and x < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                    hit = not hit
                j = i
            if hit:
                return True
    return False


def build_zones(topo=None, simplify=None):
    """Zones simplifiées : listes de [lon, lat] (longitudes continues)."""
    eps = SIMPLIFY_DEG if simplify is None else simplify
    zones = []
    for ring in full_rings(topo):
        if abs(_area(ring)) < MIN_RING_AREA:
            continue
        simp = _rdp(ring + [ring[0]], eps)[:-1]
        if len(simp) >= 3:
            zones.append([[round(x, 2), round(y, 2)] for x, y in simp])
    return zones


def contour_nodes(zones, offset=None):
    """Coins saillants des zones, décalés vers l'extérieur ; ceux qui tombent dans une zone sont écartés."""
    off = NODE_OFFSET_DEG if offset is None else offset
    nodes = []
    for ring in zones:
        ccw = _area(ring) > 0
        n = len(ring)
        for i in range(n):
            (x0, y0), (x1, y1), (x2, y2) = ring[i - 1], ring[i], ring[(i + 1) % n]
            if ((x1 - x0) * (y2 - y1) - (y1 - y0) * (x2 - x1) > 0) != ccw:
                continue   # coin rentrant : jamais sur un plus court chemin
            k = math.cos(y1 * R) or 1e-6

            def outward(ax, ay, bx, by):
                ex, ey = (bx - ax) * k, by - ay
                nx, ny = (ey, -ex) if ccw else (-ey, ex)
                l = math.hypot(nx, ny) or 1
                return nx / l, ny / l
            n1, n2 = outward(x0, y0, x1, y1), outward(x1, y1, x2, y2)
            bx, by = n1[0] + n2[0], n1[1] + n2[1]
            l = math.hypot(bx, by) or 1
            lat, lon = y1 + off * by / l, x1 + off * (bx / l) / k
            if -85 < lat < 85:
                nodes.append((lat, (lon + 180) % 360 - 180))
    router = Router(zones, [])
    return [[round(a, 2), round(b, 2)] for a, b in nodes if not router.inside(vec(a, b))]


# ----------------------------------------------------------------------------------- routeur
SOUTH_POLE = vec(-89.9, 0.0)   # hors de toute zone : sert de point de référence au test « point dans une zone »


class Router:
    """Graphe de visibilité. `vis` (facultatif) : matrice de bits précalculée des paires de nœuds qui se voient
    (triangle supérieur, ligne par ligne) ; sans elle, la visibilité est calculée à la demande (lent)."""

    def __init__(self, zones, nodes, vis=None):
        self.edges = []        # (a, b, milieu, demi-longueur)
        for ring in zones:
            pts = [vec(lat, lon) for lon, lat in ring]
            for i in range(len(pts)):
                a, b = pts[i], pts[(i + 1) % len(pts)]
                self.edges.append((a, b, norm(tuple(p + q for p, q in zip(a, b))), angle(a, b) / 2))
        self.nodes = [vec(lat, lon) for lat, lon in nodes]
        self.vis = vis

    def inside(self, p):
        return sum(1 for a, b, _, _ in self.edges if arcs_cross(p, SOUTH_POLE, a, b)) % 2 == 1

    def blocked(self, a, b):
        mid = norm(tuple(p + q for p, q in zip(a, b)))
        half = angle(a, b) / 2
        for c, d, m, h in self.edges:
            if half + h < math.pi and dot(mid, m) < math.cos(half + h) - 1e-12:
                continue
            if arcs_cross(a, b, c, d):
                return True
        return False

    def bit(self, i, j):
        n = len(self.nodes)
        if i > j:
            i, j = j, i
        k = i * n - i * (i + 1) // 2 + (j - i - 1)
        return (self.vis[k >> 3] >> (k & 7)) & 1

    def node_visible(self, i, j):
        return bool(self.bit(i, j)) if self.vis is not None else not self.blocked(self.nodes[i], self.nodes[j])

    def compute_vis(self):
        n = len(self.nodes)
        bits = bytearray((n * (n - 1) // 2 + 7) // 8)
        k = 0
        for i in range(n):
            for j in range(i + 1, n):
                if not self.blocked(self.nodes[i], self.nodes[j]):
                    bits[k >> 3] |= 1 << (k & 7)
                k += 1
        return bytes(bits)

    def route(self, a_ll, b_ll):
        """Points [lat, lon] de A à B en contournant les zones (tracé direct si rien ne gêne ou si impossible)."""
        a, b = vec(*a_ll), vec(*b_ll)
        if not self.blocked(a, b) or self.inside(a) or self.inside(b):
            return [list(a_ll), list(b_ll)]
        n = len(self.nodes)
        # Nœuds visibles depuis A et vers B (seuls tests géométriques à faire : 2 x n)
        vis_a = {i: angle(a, self.nodes[i]) for i in range(n) if not self.blocked(a, self.nodes[i])}
        vis_b = {i: angle(self.nodes[i], b) for i in range(n) if not self.blocked(self.nodes[i], b)}
        dist, prev, heap = {}, {}, []
        for i, d in vis_a.items():
            dist[i] = d
            heapq.heappush(heap, (d + angle(self.nodes[i], b), i))
        best, best_i, done = math.inf, None, set()
        while heap:
            f, i = heapq.heappop(heap)
            if i in done:
                continue
            if f >= best:
                break
            done.add(i)
            if i in vis_b and dist[i] + vis_b[i] < best:
                best, best_i = dist[i] + vis_b[i], i
            for j in range(n):
                if j in done or j == i or not self.node_visible(i, j):
                    continue
                c = dist[i] + angle(self.nodes[i], self.nodes[j])
                if c < dist.get(j, math.inf):
                    dist[j], prev[j] = c, i
                    heapq.heappush(heap, (c + angle(self.nodes[j], b), j))
        if best_i is None:
            return [list(a_ll), list(b_ll)]
        chain, i = [], best_i
        while i is not None:
            chain.append(self.nodes[i])
            i = prev.get(i)
        return [list(a_ll)] + [list(latlon(p)) for p in reversed(chain)] + [list(b_ll)]


# ----------------------------------------------------------------------------------- plan de route
def _in_box(p, box):
    return box[0] <= p[0] <= box[1] and box[2] <= p[1] <= box[3]


def corridor_waypoints(dep, arr):
    """Points de passage imposés (Europe -> Japon/Corée par le sud, Japon/Corée -> Europe par Béring)."""
    if _in_box(dep, EUROPE_BOX) and _in_box(arr, EAST_ASIA_BOX):
        return [list(p) for p in CORRIDOR_EAST]
    if _in_box(dep, EAST_ASIA_BOX) and _in_box(arr, EUROPE_BOX):
        return [list(p) for p in CORRIDOR_WEST]
    return []


def plan_path(router, dep, arr, corridors=True):
    """Route estimée dep -> arr (points [lat, lon]) : couloir éventuel, puis contournement des zones tronçon par tronçon."""
    via = corridor_waypoints(dep, arr) if corridors else []
    pts = [list(dep)] + via + [list(arr)]
    out = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        out.extend(router.route(a, b)[1:])
    return out


def path_length_nm(path):
    return sum(angle(vec(*p), vec(*q)) for p, q in zip(path, path[1:])) * EARTH_NM


def point_along(path, frac):
    """(lat, lon, cap) à la fraction frac (0 à 1) de la longueur de la route."""
    vs = [vec(*p) for p in path]
    lengths = [angle(a, b) for a, b in zip(vs, vs[1:])]
    target = max(0.0, min(1.0, frac)) * sum(lengths)
    for i, seg in enumerate(lengths):
        if target <= seg or i == len(lengths) - 1:
            f = target / seg if seg else 0.0
            p = interpolate(vs[i], vs[i + 1], min(1.0, f))
            q = interpolate(vs[i], vs[i + 1], min(1.0, f + 0.002)) if f < 1 else vs[i + 1]
            return latlon(p) + (bearing(p, q),)
        target -= seg


def load_avoid(world_json):
    import base64
    w = json.load(open(world_json, encoding="utf-8"))["avoid"]
    return Router(w["zones"], w["nodes"], base64.b64decode(w["vis"]) if w.get("vis") else None)


# ----------------------------------------------------------------------------------- tests
if __name__ == "__main__":
    import time
    t0 = time.time()
    import os
    world = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "world.json")
    topo = _download(COUNTRIES_SOURCE)
    full = full_rings(topo)
    router = load_avoid(world)
    zones = [None] * len(router.edges)   # seulement pour l'affichage ci-dessous
    print(f"{len(router.edges)} bords, {len(router.nodes)} nœuds, matrice de visibilité : {'oui' if router.vis else 'non'}")
    AP = {'CDG': (49.009, 2.554), 'LHR': (51.471, -0.46), 'FRA': (50.027, 8.558), 'AMS': (52.309, 4.764), 'HEL': (60.317, 24.963),
          'WAW': (52.166, 20.967), 'ARN': (59.65, 17.92), 'RIX': (56.92, 23.97), 'IST': (41.275, 28.752), 'TBS': (41.669, 44.955),
          'TLV': (32.011, 34.887), 'DXB': (25.25, 55.371), 'DEL': (28.556, 77.1), 'PEK': (40.08, 116.584), 'PVG': (31.14, 121.8),
          'NRT': (35.769, 140.389), 'HND': (35.55, 139.787), 'ICN': (37.46, 126.44), 'KIX': (34.427, 135.244), 'ALA': (43.352, 77.04),
          'SFO': (37.62, -122.375), 'JFK': (40.64, -73.78), 'SIN': (1.35, 103.99), 'SYD': (-33.95, 151.18), 'HKG': (22.31, 113.91)}
    pairs = [('CDG', 'NRT'), ('NRT', 'CDG'), ('LHR', 'HND'), ('HND', 'LHR'), ('FRA', 'ICN'), ('ICN', 'AMS'), ('HEL', 'NRT'), ('NRT', 'HEL'),
             ('CDG', 'PEK'), ('PEK', 'CDG'), ('FRA', 'PVG'), ('HEL', 'PEK'), ('WAW', 'TLV'), ('RIX', 'IST'), ('ARN', 'DXB'), ('CDG', 'DEL'),
             ('CDG', 'ALA'), ('IST', 'PEK'), ('TBS', 'HEL'), ('LHR', 'SIN'), ('SFO', 'CDG'), ('JFK', 'HEL'), ('ARN', 'PEK'), ('FRA', 'HKG')]
    failures = 0
    for d, a in pairs:
        t1 = time.time()
        path = plan_path(router, AP[d], AP[a])
        dt = (time.time() - t1) * 1000
        # Contrôle indépendant : échantillon dense de la route, contours COMPLETS
        bad = 0
        vs = [vec(*p) for p in path]
        for u, v in zip(vs, vs[1:]):
            n = max(2, int(angle(u, v) * EARTH_NM / 5))
            for k in range(n + 1):
                lat, lon = latlon(interpolate(u, v, k / n))
                if point_in_rings(full, lat, lon):
                    bad += 1
        direct = path_length_nm([AP[d], AP[a]])
        L = path_length_nm(path)
        failures += bad > 0
        print(f"  {d}->{a}: {len(path) - 2} points intermédiaires, {round(L)} nm (direct {round(direct)}, +{round((L / direct - 1) * 100)} %), "
              f"{dt:.0f} ms, points en zone interdite : {bad}")
    print("ÉCHEC" if failures else "OK : aucune route ne traverse une zone", f"({time.time() - t0:.0f} s)")
    sys.exit(1 if failures else 0)
