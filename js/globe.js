// ========================================================
// GLOBE 3D DE LA CARTE DU VOL (MapLibre GL, projection « globe »)
// Alternative à la carte 2D (canvas de app.js), activée dans les réglages de la carte (mapPrefs.globe).
// MapLibre n'est téléchargé qu'à la première ouverture du globe. Mêmes données que la carte 2D : route
// (flightMap.route.lines), avion, aéroports le long de la route, dégagements, zones de conflit, brouillage GPS.
// Fond : imagerie satellite (Esri World Imagery) ou fond sombre dessiné avec data/world.json et la palette
// de la carte (MAP_COLORS, qui suit le thème et le style choisis).
// ========================================================
const MAPLIBRE_VERSION = '5.24.0';
const GLOBE_LABEL_ZOOM = 3.5;   // en dessous : étiquettes des aéroports le long de la route masquées
const GLOBE_SAT_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const globe = {
    map: null, loading: null, ready: false, el: null,
    worldGeo: null, worldRaw: null,
    apMarkers: new Map(), apKey: '', fixed: [],   // marqueurs DOM : aéroports (réutilisés), départ / arrivée / avion / spider
    fitSeq: -1                                    // vol (flightMap.seq) déjà cadré
};

function loadMapLibre() {
    if (window.maplibregl) return Promise.resolve();
    if (!globe.loading) {
        globe.loading = new Promise((resolve, reject) => {
            const base = `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/`;
            const css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = base + 'maplibre-gl.css';
            document.head.appendChild(css);
            const js = document.createElement('script');
            js.src = base + 'maplibre-gl.js';
            js.onload = resolve;
            js.onerror = () => { globe.loading = null; js.remove(); reject(new Error(tr('Globe indisponible'))); };
            document.head.appendChild(js);
        });
    }
    return globe.loading;
}

// --- Données GeoJSON ---------------------------------------------------------------
const fc = features => ({ type: 'FeatureCollection', features });
const closeRing = pts => (pts.length && (pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1]) ? [...pts, pts[0]] : pts);

// Terres et frontières (data/world.json, même codage que la carte 2D), converties une fois
function globeWorldGeo() {
    const raw = flightMap.world && flightMap.world.raw;
    if (!raw) return fc([]);
    if (globe.worldRaw !== raw) {
        const u = raw.unit;
        const decode = a => {
            const pts = [];
            let x = a[0], y = a[1];
            pts.push([x * u, y * u]);
            for (let i = 2; i < a.length; i += 2) { x += a[i]; y += a[i + 1]; pts.push([x * u, y * u]); }
            return pts;
        };
        globe.worldGeo = fc([
            ...raw.land.map(r => ({ type: 'Feature', properties: { k: 'land' }, geometry: { type: 'Polygon', coordinates: [closeRing(decode(r))] } })),
            ...raw.borders.map(b => ({ type: 'Feature', properties: { k: 'border' }, geometry: { type: 'LineString', coordinates: decode(b) } }))
        ]);
        globe.worldRaw = raw;
    }
    return globe.worldGeo;
}

function globeConflictGeo() {
    if (!mapPrefs.conflict || !flightMap.conflict) return fc([]);
    return fc(flightMap.conflict.zones.flatMap(z => z.rings.map(pts => ({
        type: 'Feature', properties: { level: z.level }, geometry: { type: 'Polygon', coordinates: [closeRing(pts)] }
    }))));
}

function globeJammingGeo() {
    if (!mapPrefs.jamming || !flightMap.jamming) return fc([]);
    return fc(flightMap.jamming.hexes.map(h => ({
        type: 'Feature', properties: { level: String(h.level) }, geometry: { type: 'Polygon', coordinates: [closeRing(h.pts)] }
    })));
}

function globeRouteGeo() {
    const route = flightMap.route;
    const lines = route ? route.lines.filter(l => l.coords.length > 1).map(l => ({
        type: 'Feature', properties: { kind: l.kind }, geometry: { type: 'LineString', coordinates: l.coords }
    })) : [];
    spiderLinks().forEach(l => lines.push({
        type: 'Feature', properties: { kind: 'spider' }, geometry: { type: 'LineString', coordinates: l.arc.map(([lat, lon]) => [lon, lat]) }
    }));
    return fc(lines);
}

// --- Style ---------------------------------------------------------------------------
const globeStyleKey = () => `${theme}|${mapPrefs.style}|${mapPrefs.globeBase}`;
function globeStyle() {
    globe.styleKey = globeStyleKey();
    const c = MAP_COLORS, sat = mapPrefs.globeBase === 'satellite';
    const kind = (...k) => ['in', ['get', 'kind'], ['literal', k]];
    const lvl = v => ['match', ['get', 'level'], ...Object.entries(v).flat(), 'rgba(0, 0, 0, 0)'];   // couleur par niveau (clés texte)
    const layers = [
        { id: 'bg', type: 'background', paint: { 'background-color': sat ? '#000' : c.sea } },
        sat
            ? { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-brightness-max': 0.85, 'raster-saturation': -0.15 } }
            : { id: 'land', type: 'fill', source: 'world', filter: ['==', ['get', 'k'], 'land'], paint: { 'fill-color': c.land } },
        ...(sat ? [] : [{ id: 'coast', type: 'line', source: 'world', filter: ['==', ['get', 'k'], 'land'], paint: { 'line-color': c.coast, 'line-width': c.coastW || 0.9 } }]),
        { id: 'borders', type: 'line', source: 'world', filter: ['==', ['get', 'k'], 'border'],
          paint: { 'line-color': sat ? 'rgba(255, 255, 255, 0.45)' : c.border, 'line-width': 0.8 } },
        { id: 'jam-fill', type: 'fill', source: 'jamming',
          paint: { 'fill-color': lvl({ 2: JAM_STYLES[2].fill, 1: JAM_STYLES[1].fill }), 'fill-outline-color': lvl({ 2: JAM_STYLES[2].stroke, 1: JAM_STYLES[1].stroke }) } },
        { id: 'conflict-fill', type: 'fill', source: 'conflict',
          paint: { 'fill-color': lvl({ high: CONFLICT_STYLES.high.fill, caution: CONFLICT_STYLES.caution.fill }) } },
        { id: 'conflict-line', type: 'line', source: 'conflict',
          paint: { 'line-color': lvl({ high: CONFLICT_STYLES.high.stroke, caution: CONFLICT_STYLES.caution.stroke }), 'line-width': 1.2, 'line-dasharray': [4, 3] } },
        // Route : mêmes codes que la carte 2D (plein = suivi ADS-B, tirets = sans réception, points = reste à parcourir)
        { id: 'route-casing', type: 'line', source: 'route', filter: kind('solid', 'flownEst'),
          layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.casing, 'line-width': 6 } },
        { id: 'route-solid', type: 'line', source: 'route', filter: kind('solid'),
          layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.route, 'line-width': 3 } },
        { id: 'route-flown', type: 'line', source: 'route', filter: kind('flownEst'),
          layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.routeSoft, 'line-width': 2.4 } },
        { id: 'route-dashed', type: 'line', source: 'route', filter: kind('dashed'),
          paint: { 'line-color': c.routeSoft, 'line-width': 2.2, 'line-dasharray': [3, 2.6] } },
        { id: 'route-remaining', type: 'line', source: 'route', filter: kind('remaining'),
          layout: { 'line-cap': 'round' }, paint: { 'line-color': c.routeSoft, 'line-width': 2.6, 'line-dasharray': [0, 2.4] } },
        { id: 'route-direct', type: 'line', source: 'route', filter: kind('direct'),
          paint: { 'line-color': sat ? '#e2e8f0' : c.direct, 'line-width': 2, 'line-dasharray': [3, 3.5] } },
        { id: 'spider', type: 'line', source: 'route', filter: kind('spider'),
          paint: { 'line-color': c.spider, 'line-width': 1.7, 'line-dasharray': [4, 3] } }
    ];
    return {
        version: 8,
        projection: { type: 'globe' },
        // Atmosphère autour du globe en vue lointaine, effacée en zoomant
        sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0] },
        sources: {
            sat: { type: 'raster', tiles: [GLOBE_SAT_TILES], tileSize: 256, maxzoom: 19, attribution: 'Esri, Maxar, Earthstar Geographics' },
            world: { type: 'geojson', data: globeWorldGeo() },
            jamming: { type: 'geojson', data: globeJammingGeo() },
            conflict: { type: 'geojson', data: globeConflictGeo() },
            route: { type: 'geojson', data: globeRouteGeo() }
        },
        layers
    };
}

// --- Cycle de vie ------------------------------------------------------------------------
// Affiche le globe (création au premier appel) ; true si le conteneur a une taille
function globeShow() {
    if (!globe.el) {
        globe.el = document.createElement('div');
        globe.el.id = 'globeMap';
        mapCanvas.after(globe.el);
    }
    if (!globe.el.clientWidth || !globe.el.clientHeight) return false;
    if (globe.map) {
        globe.map.resize();
        if (flightMap.needsFit) globeFit();
        globeRender();
        return true;
    }
    loadMapLibre().then(() => {
        if (globe.map) return;
        globe.map = new maplibregl.Map({
            container: globe.el,
            style: globeStyle(),
            center: [2, 46], zoom: 1.6,
            attributionControl: { compact: true },
            maxPitch: 75,
            fadeDuration: 0
        });
        globe.map.on('load', () => {
            globe.ready = true;
            if (globe.styleKey !== globeStyleKey()) globeRestyle();   // thème ou fond changé pendant le chargement
            globeFit();
            globeRender();
        });
        // Déplacement par l'utilisateur : plus de recadrage automatique
        globe.map.on('movestart', e => { if (e.originalEvent) flightMap.userMoved = true; });
        globe.map.on('mousemove', e => {
            if (e.originalEvent.target.closest && e.originalEvent.target.closest('.maplibregl-marker')) return;
            const { clientX, clientY } = e.originalEvent;
            if (!showLayerTipAt(e.lngLat.lng, e.lngLat.lat, clientX, clientY)) hideMapTip();
        });
        globe.map.on('mouseout', hideMapTip);
        const farView = () => globe.el.classList.toggle('far', globe.map.getZoom() < GLOBE_LABEL_ZOOM);
        globe.map.on('zoom', farView);
        farView();
        globe.map.on('dragstart', hideMapTip);
    }).catch(() => {
        flightMap.notice = tr('Globe indisponible : carte 2D affichée');
        mapPrefs.globe = false;
        syncMapSettings();
        updateMapOverlay();
        resizeMapCanvas();
    });
    return true;
}

// Fond ou palette changés : nouveau style (les données courantes y sont incluses)
function globeRestyle() {
    if (!globe.map || !globe.ready || globe.styleKey === globeStyleKey()) return;
    globe.map.setStyle(globeStyle());
    globe.apKey = '';   // couleurs des repères à refaire
    globeRender();
}

function globeZoom(factor) {
    if (globe.map) globe.map.easeTo({ zoom: globe.map.getZoom() + Math.log2(factor), duration: 250 });
}

// Cadrage sur la trajectoire (route, départ, arrivée, avion), comme fitFlightMap en 2D
function globeFit() {
    if (!globe.map || !globe.ready) { flightMap.needsFit = true; return; }
    flightMap.needsFit = false;
    globe.fitSeq = flightMap.seq;
    const route = flightMap.route;
    const pts = route ? route.lines.flatMap(l => l.coords) : [];
    if (route && route.plane) pts.push([route.plane.lon, route.plane.lat]);
    if (!pts.length) { globe.map.easeTo({ center: [2, 46], zoom: 1.6, pitch: 0, bearing: 0 }); return; }
    const lons = pts.map(p => p[0]), lats = pts.map(p => p[1]);
    const pad = Math.min(80, Math.round(Math.min(globe.el.clientWidth, globe.el.clientHeight) * 0.15));
    globe.map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], {
        padding: { top: pad + 50, bottom: pad, left: pad, right: pad }, maxZoom: 7, pitch: 0, bearing: 0, duration: 600
    });
}

// Met à jour les données et les repères (appelé à la place de drawFlightMap quand le globe est affiché)
function globeRender() {
    if (!globe.map || !globe.ready) return;
    if (globe.fitSeq !== flightMap.seq && flightMap.route && flightMap.route.lines.length) globeFit();
    const set = (id, data) => { const src = globe.map.getSource(id); if (src) src.setData(data); };
    set('jamming', globeJammingGeo());
    set('conflict', globeConflictGeo());
    set('route', globeRouteGeo());
    if (globe.map.getSource('world') && globe.worldRaw !== (flightMap.world && flightMap.world.raw)) set('world', globeWorldGeo());
    globeMarkers();
}

// --- Repères DOM : aéroports, départ / arrivée, avion, étiquettes du spider -------------------------
function globeMarker(el, lngLat, opts = {}) {
    return new maplibregl.Marker({ element: el, ...opts }).setLngLat(lngLat).addTo(globe.map);
}

function globeAirportEvents(el, icao) {
    el.addEventListener('mouseenter', e => showMapTip(icao, e.clientX, e.clientY));
    el.addEventListener('mouseleave', hideMapTip);
    el.addEventListener('click', e => { e.stopPropagation(); hideMapTip(); openFlightAirport(icao); });
}

function globeMarkers() {
    const route = flightMap.route, c = MAP_COLORS;
    // Aéroports le long de la route : recréés seulement si la liste ou leur météo change
    const aps = route ? visibleOverflown() : [];
    const key = aps.map(o => `${o.ap.ident}:${wxColor(o.ap.ident) || ''}`).join(',') + '|' + mapPrefs.code;
    if (key !== globe.apKey) {
        globe.apKey = key;
        globe.apMarkers.forEach(m => m.remove());
        globe.apMarkers.clear();
        aps.forEach(o => {
            const big = isLargeOnRoute(o.ap);
            const el = document.createElement('div');
            el.className = 'globe-ap' + (big ? ' big' : '');
            el.innerHTML = `<i style="background:${wxColor(o.ap.ident) || (big ? c.apLarge : c.apMedium)}"></i><span>${escapeHtml(mapAirportLabel(o.ap, airportCode(o.ap)))}</span>`;
            globeAirportEvents(el, o.ap.ident);
            globe.apMarkers.set(o.ap.ident, globeMarker(el, [o.ap.lon, o.ap.lat], { anchor: 'left', offset: [-5, 0] }));
        });
    }

    // Départ, arrivée, avion et spider : peu nombreux, refaits à chaque fois
    globe.fixed.forEach(m => m.remove());
    globe.fixed = [];
    if (!route) return;
    spiderLinks().forEach(l => {
        const [lat, lon] = l.arc[Math.floor(l.arc.length * 0.65)];
        const el = document.createElement('div');
        el.className = 'globe-chip globe-spider';
        el.textContent = `${airportCode(l.ap)} · ${Math.round(l.d).toLocaleString(LOCALE)} nm${l.min !== null ? ' · ' + formatDuration(Math.round(l.min)) : ''}`;
        globe.fixed.push(globeMarker(el, [lon, lat]));
    });
    [route.dep, route.arr].forEach(m => {
        if (!m) return;
        const el = document.createElement('div');
        el.className = 'globe-end';
        el.innerHTML = `<i style="background:${wxColor(m.icao) || c.edge}"></i><span class="globe-chip">${escapeHtml(m.label)}</span>`;
        if (m.icao) globeAirportEvents(el, m.icao);
        globe.fixed.push(globeMarker(el, [m.lon, m.lat], { anchor: 'left', offset: [-6, 0] }));
    });
    if (route.plane) {
        const el = document.createElement('div');
        el.className = 'globe-plane';
        el.innerHTML = `<svg width="31" height="31" viewBox="0 0 24 24"><path d="${PLANE_SVG_D}" fill="${c.plane}" stroke="${c.edge}" stroke-width="1"/></svg>`;
        globe.fixed.push(globeMarker(el, [route.plane.lon, route.plane.lat], { rotation: route.plane.heading || 0, rotationAlignment: 'map', pitchAlignment: 'map' }));
    }
}
const PLANE_SVG_D = 'M12 1.5 L13.6 8.5 L22 13.5 L22 15.5 L13.6 12.8 L13.2 19 L16 21 L16 22.5 L12 21.5 L8 22.5 L8 21 L10.8 19 L10.4 12.8 L2 15.5 L2 13.5 L10.4 8.5 Z';
