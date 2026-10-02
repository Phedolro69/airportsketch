#!/usr/bin/env python3
"""
Le routeur d'espaces aériens (Russie, Ukraine, Bélarus) existe en deux endroits qui doivent rester identiques :
le site (bloc balisé « airspace-router » de js/airspace-router.js) et le worker (worker/airspace.js, qui sert aux positions
des vols de démonstration). js/airspace-router.js est la source ; ce script régénère worker/airspace.js.

    python scripts/sync_airspace.py          # régénère
    python scripts/sync_airspace.py --check  # échoue si worker/airspace.js n'est plus à jour (CI)
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML = os.path.join(ROOT, "js", "airspace-router.js")
OUT = os.path.join(ROOT, "worker", "airspace.js")

HEADER = """/**
 * Routes des vols de démonstration : plus court chemin qui contourne la Russie, l'Ukraine et le Bélarus
 * (couloirs imposés Europe <-> Japon/Corée compris).
 *
 * FICHIER GÉNÉRÉ par scripts/sync_airspace.py à partir du bloc « airspace-router » de js/airspace-router.js : ne pas
 * modifier ici. Les zones et la matrice de visibilité sont dans avoid.json (généré par scripts/make_world.py).
 */
"""

FOOTER = """
const EARTH_NM_W = 3440.065;
const gcAng = (a, b) => AV.ang(AV.v(a[0], a[1]), AV.v(b[0], b[1]));

/** Route estimée dep -> arr ([lat, lon]) : couloir éventuel, puis contournement des zones tronçon par tronçon. */
export function planPath(router, dep, arr) {
    const pts = [dep, ...corridorWaypoints(dep, arr), arr];
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) out.push(...router.route(pts[i - 1], pts[i]).slice(1));
    return out;
}

export const pathLengthNm = path => path.slice(1).reduce((n, p, i) => n + gcAng(path[i], p), 0) * EARTH_NM_W;

/** Point à la fraction f (0 à 1) de la longueur de la route : [lat, lon, cap]. */
export function pointAlong(path, f) {
    const lens = path.slice(1).map((p, i) => gcAng(path[i], p));
    const target = Math.max(0, Math.min(1, f)) * lens.reduce((a, b) => a + b, 0);
    const at = (i, g) => {
        const a = AV.v(path[i][0], path[i][1]), b = AV.v(path[i + 1][0], path[i + 1][1]), d = lens[i];
        if (!d) return path[i];
        const s1 = Math.sin((1 - g) * d) / Math.sin(d), s2 = Math.sin(g * d) / Math.sin(d);
        return AV.ll([s1 * a[0] + s2 * b[0], s1 * a[1] + s2 * b[1], s1 * a[2] + s2 * b[2]]);
    };
    let acc = 0;
    for (let i = 0; i < lens.length; i++) {
        if (target <= acc + lens[i] || i === lens.length - 1) {
            const g = lens[i] ? Math.min(1, Math.max(0, (target - acc) / lens[i])) : 0;
            const p = at(i, g), q = g < 0.99 ? at(i, Math.min(1, g + 0.01)) : at(i, 1), from = g < 0.99 ? p : at(i, 0.98);
            const dl = (q[1] - from[1]) * Math.PI / 180, r = Math.PI / 180;
            const y = Math.sin(dl) * Math.cos(q[0] * r);
            const x = Math.cos(from[0] * r) * Math.sin(q[0] * r) - Math.sin(from[0] * r) * Math.cos(q[0] * r) * Math.cos(dl);
            return [p[0], p[1], Math.round((Math.atan2(y, x) / r + 360) % 360)];
        }
        acc += lens[i];
    }
    return [path[0][0], path[0][1], 0];
}
"""


def generate():
    html = open(HTML, encoding="utf-8").read()
    m = re.search(r"// >>> airspace-router[^\n]*\n(.*?)\n\s*// <<< airspace-router", html, re.S)
    if not m:
        sys.exit("Bloc « airspace-router » introuvable dans js/airspace-router.js")
    block = m.group(1).replace("class AirspaceRouter", "export class AirspaceRouter")
    return HEADER + block.rstrip() + "\n" + FOOTER


if __name__ == "__main__":
    new = generate()
    if "--check" in sys.argv:
        old = open(OUT, encoding="utf-8").read() if os.path.exists(OUT) else ""
        if old != new:
            sys.exit("worker/airspace.js n'est plus à jour : lancer python scripts/sync_airspace.py")
        print("worker/airspace.js à jour")
    else:
        open(OUT, "w", encoding="utf-8", newline="\n").write(new)
        print(f"{OUT} régénéré ({len(new):,} octets)")
