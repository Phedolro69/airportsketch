// >>> airspace-router (copié tel quel dans worker/airspace.js par scripts/sync_airspace.py)
const AV = {
    v(lat, lon) {
        const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
        return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    },
    ll: v => [Math.atan2(v[2], Math.hypot(v[0], v[1])) * 180 / Math.PI, Math.atan2(v[1], v[0]) * 180 / Math.PI],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    norm(a) { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; },
    ang(a, b) { const c = AV.cross(a, b); return Math.atan2(Math.hypot(c[0], c[1], c[2]), AV.dot(a, b)); }
};
const AV_SOUTH_POLE = AV.v(-89.9, 0);

// Les arcs de grand cercle AB et CD (moins de 180°) se coupent-ils ?
function arcsCross(a, b, c, d) {
    const n1 = AV.cross(a, b), n2 = AV.cross(c, d);
    let t = AV.cross(n1, n2);
    if (AV.dot(t, t) < 1e-24) return false;
    t = AV.norm(t);
    for (const sg of [1, -1]) {
        const p = [t[0] * sg, t[1] * sg, t[2] * sg];
        if (AV.dot(AV.cross(a, p), n1) >= 0 && AV.dot(AV.cross(p, b), n1) >= 0
            && AV.dot(AV.cross(c, p), n2) >= 0 && AV.dot(AV.cross(p, d), n2) >= 0) return true;
    }
    return false;
}

class AirspaceRouter {
    constructor(avoid) {
        this.edges = [];
        avoid.zones.forEach(ring => {
            const pts = ring.map(([lon, lat]) => AV.v(lat, lon));
            pts.forEach((a, i) => {
                const b = pts[(i + 1) % pts.length];
                this.edges.push({ a, b, m: AV.norm([a[0] + b[0], a[1] + b[1], a[2] + b[2]]), h: AV.ang(a, b) / 2 });
            });
        });
        this.nodes = avoid.nodes.map(([lat, lon]) => AV.v(lat, lon));
        this.vis = Uint8Array.from(atob(avoid.vis || ''), ch => ch.charCodeAt(0));
    }

    blocked(a, b) {
        const mid = AV.norm([a[0] + b[0], a[1] + b[1], a[2] + b[2]]), half = AV.ang(a, b) / 2;
        for (const e of this.edges) {
            const lim = half + e.h;
            if (lim < Math.PI && AV.dot(mid, e.m) < Math.cos(lim) - 1e-12) continue;
            if (arcsCross(a, b, e.a, e.b)) return true;
        }
        return false;
    }

    inside(p) {
        let n = 0;
        for (const e of this.edges) if (arcsCross(p, AV_SOUTH_POLE, e.a, e.b)) n++;
        return n % 2 === 1;
    }

    bit(i, j) {
        if (i > j) [i, j] = [j, i];
        const k = i * this.nodes.length - (i * (i + 1)) / 2 + (j - i - 1);
        return (this.vis[k >> 3] >> (k & 7)) & 1;
    }

    // Points [lat, lon] de A à B en contournant les zones ; tracé direct si rien ne gêne
    route(aLL, bLL) {
        const a = AV.v(aLL[0], aLL[1]), b = AV.v(bLL[0], bLL[1]);
        if (!this.blocked(a, b) || this.inside(a) || this.inside(b)) return [aLL, bLL];
        const n = this.nodes.length;
        const visA = new Float64Array(n).fill(-1), visB = new Float64Array(n).fill(-1);
        for (let i = 0; i < n; i++) {
            if (!this.blocked(a, this.nodes[i])) visA[i] = AV.ang(a, this.nodes[i]);
            if (!this.blocked(this.nodes[i], b)) visB[i] = AV.ang(this.nodes[i], b);
        }
        const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n);
        for (let i = 0; i < n; i++) if (visA[i] >= 0) dist[i] = visA[i];
        let best = Infinity, bestI = -1;
        for (;;) {
            let u = -1, f = Infinity;
            for (let i = 0; i < n; i++) {
                if (done[i] || dist[i] === Infinity) continue;
                const fi = dist[i] + AV.ang(this.nodes[i], b);
                if (fi < f) { f = fi; u = i; }
            }
            if (u < 0 || f >= best) break;
            done[u] = 1;
            if (visB[u] >= 0 && dist[u] + visB[u] < best) { best = dist[u] + visB[u]; bestI = u; }
            for (let j = 0; j < n; j++) {
                if (done[j] || j === u || !this.bit(u, j)) continue;
                const c = dist[u] + AV.ang(this.nodes[u], this.nodes[j]);
                if (c < dist[j]) { dist[j] = c; prev[j] = u; }
            }
        }
        if (bestI < 0) return [aLL, bLL];
        const chain = [];
        for (let i = bestI; i >= 0; i = prev[i]) chain.push(AV.ll(this.nodes[i]));
        return [aLL, ...chain.reverse(), bLL];
    }
}

// Couloirs imposés (réalité opérationnelle) : Europe -> Japon/Corée par le sud (Turquie, Erevan, Urumqi),
// Japon/Corée -> Europe par le Pacifique nord, le détroit de Béring et le Groenland.
const EUROPE_BOX = [35, 72, -25, 45], EAST_ASIA_BOX = [24, 46, 124, 146];   // [lat min, lat max, lon min, lon max]
const CORRIDOR_EAST = [[39.9, 32.9], [40.18, 44.51], [43.83, 87.62]];
const CORRIDOR_WEST = [[40.0, 150.0], [55.0, -172.0], [65.6, -167.5], [71.0, -42.0]];
const inBox = (p, b) => p[0] >= b[0] && p[0] <= b[1] && p[1] >= b[2] && p[1] <= b[3];

function corridorWaypoints(dep, arr) {
    if (inBox(dep, EUROPE_BOX) && inBox(arr, EAST_ASIA_BOX)) return CORRIDOR_EAST;
    if (inBox(dep, EAST_ASIA_BOX) && inBox(arr, EUROPE_BOX)) return CORRIDOR_WEST;
    return [];
}

// <<< airspace-router
