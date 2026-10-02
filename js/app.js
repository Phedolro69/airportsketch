// Thème (sombre par défaut) : posé sur <html> par le script de l'en-tête, relu ici pour les couleurs des canvas
let theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

// Couleurs du schéma de pistes (canvas), par thème
const DIAGRAM_THEMES = {
    dark: {
        grid: 'rgba(255, 255, 255, 0.04)', pillBase: 'rgba(11, 15, 25, 0.9)',
        rwyFill: '#374151', rwyStroke: '#64748b', rwyCenter: '#f8fafc', rwyId: '#10b981',
        shortFill: 'rgba(167, 139, 250, 0.35)', shortStroke: '#a78bfa', shortCenter: '#ede9fe', shortId: '#c4b5fd',
        dimBg: 'rgba(15, 23, 42, 0.88)', dimText: '#38bdf8', dispFill: 'rgba(245, 158, 11, 0.25)', dispStroke: '#fbbf24',
        miniBg: '#0d1322', miniRwyOuter: '#64748b', miniRwyInner: '#374151', miniShortInner: '#5b4a8a',
        miniShortOuter: 'rgba(167, 139, 250, 0.7)', miniId: '#10b981', miniShortId: '#c4b5fd'
    },
    light: {
        grid: 'rgba(15, 23, 42, 0.06)', pillBase: 'rgba(255, 255, 255, 0.95)',
        rwyFill: '#6b7280', rwyStroke: '#475569', rwyCenter: '#ffffff', rwyId: '#047857',
        shortFill: 'rgba(139, 92, 246, 0.45)', shortStroke: '#7c3aed', shortCenter: '#ffffff', shortId: '#6d28d9',
        dimBg: 'rgba(255, 255, 255, 0.9)', dimText: '#0369a1', dispFill: 'rgba(234, 88, 12, 0.2)', dispStroke: '#ea580c',
        miniBg: '#e3eaf3', miniRwyOuter: '#475569', miniRwyInner: '#6b7280', miniShortInner: '#a78bfa',
        miniShortOuter: 'rgba(109, 40, 217, 0.8)', miniId: '#047857', miniShortId: '#6d28d9'
    }
};
const DC = { ...DIAGRAM_THEMES[theme] };

const FT_TO_M = 0.3048;
const MIN_RUNWAY_LENGTH_M = 2000;

const canvas = document.getElementById('diagramCanvas');
const ctx = canvas.getContext('2d');
const canvasContainer = document.getElementById('canvasContainer');

let searchIndex = [];
let searchIndexMap = new Map();
let airportCache = new Map();

let rawRunways = [];
let currentRunways = [];
let hideShortRunways = true;   // petites pistes (< 2000 m) masquées par défaut ; bouton pour les afficher
let currentAirportCode = '';
let currentAirportData = null;

// État de la vue (zoom, translation)
let viewState = {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    isDragging: false,
    startX: 0,
    startY: 0,
    baseBounds: null
};

// État multi-touch pour zoom pincé et déplacement tactile
let touchState = {
    initialDistance: 0,
    initialScale: 1,
    lastMidpoint: null,
    lastTapTime: 0
};

// Redimensionnement du Canvas adapté Retina / HiDPI
function resizeCanvas(triggerDraw = true) {
    const dpr = window.devicePixelRatio || 1;
    const width = canvasContainer.clientWidth;
    const height = canvasContainer.clientHeight;
    
    if (width === 0 || height === 0) return false;

    const targetW = Math.round(width * dpr);
    const targetH = Math.round(height * dpr);

    if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (triggerDraw && currentRunways.length > 0) {
        draw();
    }
    return true;
}

// Observer réactif pour détecter tout changement de dimension (flexbox, responsive, plein écran)
if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => {
        resizeCanvas();
        if (viewMode === 'map') resizeMapCanvas();
    });
    ro.observe(canvasContainer);
} else {
    window.addEventListener('resize', () => resizeCanvas());
}

window.addEventListener('orientationchange', () => {
    setTimeout(resizeCanvas, 150);
});

// Initialisation immédiate des dimensions du canvas
resizeCanvas();

window.addEventListener('load', () => {
    resizeCanvas();
    if (currentRunways.length > 0) {
        resetView();
    }
});


// Navigation mobile par onglets
function switchMobileTab(tab) {
    document.body.setAttribute('data-mobile-tab', tab);
    const tabDiagramBtn = document.getElementById('tabBtnDiagram');
    const tabDetailsBtn = document.getElementById('tabBtnDetails');

    if (tab === 'diagram') {
        tabDiagramBtn.classList.add('active');
        tabDetailsBtn.classList.remove('active');
        setTimeout(() => {
            resizeCanvas();
            resetView();
            if (viewMode === 'map') { resizeMapCanvas(); fitFlightMap(); }
        }, 50);
    } else {
        tabDiagramBtn.classList.remove('active');
        tabDetailsBtn.classList.add('active');
    }
}

// Bascule Plein Écran
function toggleFullscreen() {
    const isFs = canvasContainer.classList.toggle('is-fullscreen');

    if (isFs) {
        // Tenter le mode plein écran natif si disponible
        if (canvasContainer.requestFullscreen) {
            canvasContainer.requestFullscreen().catch(() => {});
        } else if (canvasContainer.webkitRequestFullscreen) {
            canvasContainer.webkitRequestFullscreen();
        }
        showTouchHint();
    } else {
        if (document.fullscreenElement && document.exitFullscreen) {
            document.exitFullscreen().catch(() => {});
        }
    }

    setTimeout(() => {
        resizeCanvas();
        resetView();
        if (viewMode === 'map') { resizeMapCanvas(); fitFlightMap(); }
    }, 60);
}

// Écouter la sortie du plein écran natif (touche Échap ou geste système)
document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && canvasContainer.classList.contains('is-fullscreen')) {
        toggleFullscreen();
    }
});

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && canvasContainer.classList.contains('is-fullscreen')) {
        toggleFullscreen();
    }
});

let toastTimer = null;
function showTouchHint() {
    const hint = document.getElementById('touchHint');
    if (!hint) return;
    hint.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        hint.classList.remove('visible');
    }, 3200);
}

function getAirportTypeBadge(type) {
    const config = {
        'large_airport':  { label: 'Grand aéroport', bg: '#10b981', color: '#ffffff' },
        'medium_airport': { label: 'Aéroport moyen', bg: '#3b82f6', color: '#ffffff' },
        'small_airport':  { label: 'Petit aéroport', bg: '#8b5cf6', color: '#ffffff' },
        'heliport':       { label: 'Héliport',        bg: '#f59e0b', color: '#ffffff' },
        'seaplane_base':  { label: 'Hydrobase',       bg: '#06b6d4', color: '#ffffff' },
        'closed':         { label: 'Fermé',           bg: '#ef4444', color: '#ffffff' }
    };

    const cfg = config[type] || { label: type || 'N/A', bg: '#4b5563', color: '#ffffff' };
    return `<span style="background-color: ${cfg.bg}; color: ${cfg.color}; font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 4px; display: inline-block;">${cfg.label}</span>`;
}

async function initApp() {
    const flightModeReady = loadFlightDataMode();   // en parallèle du chargement de l'index
    const statusBox = document.getElementById('statusBox');
    const errorBox = document.getElementById('fileError');
    const inputEl = document.getElementById('airportInput');

    try {
        statusBox.innerText = "Chargement de l'index des aéroports...";

        const res = await fetch('./data/search_index.json');
        if (!res.ok) {
            throw new Error(`Index introuvable (${res.status}). Veuillez exécuter 'python scripts/build_data.py'`);
        }

        searchIndex = await res.json();
        searchIndexMap = new Map();
        for (let i = 0; i < searchIndex.length; i++) {
            searchIndexMap.set(searchIndex[i].ident, searchIndex[i]);
            // L'index est trié par importance : on garde le premier aéroport pour chaque code IATA
            if (searchIndex[i].iata && !iataIndexMap.has(searchIndex[i].iata)) {
                iataIndexMap.set(searchIndex[i].iata, searchIndex[i]);
            }
        }

        statusBox.style.display = 'none';
        inputEl.disabled = false;
        inputEl.placeholder = "ICAO, IATA ou Nom (ex: LFPG, Nice, CDG)...";

        // Vérifier si un paramètre d'URL est fourni, sinon défaut à LFMN
        const urlParams = new URLSearchParams(window.location.search);
        const initialCode = (urlParams.get('icao') || 'LFMN').toUpperCase();
        selectAirport(initialCode);

        // Vol passé dans l'URL (?flight=AF173)
        await flightModeReady;
        const initialFlight = parseFlightQuery(urlParams.get('flight') || '');
        if (initialFlight && initialFlight.complete && FLIGHT_API_BASE) {
            setSearchMode('flight', false);
            document.getElementById('flightInput').value = initialFlight.q;
            selectFlight(initialFlight.q, initialFlight.flightParam);
        }

    } catch (err) {
        statusBox.style.display = 'none';
        errorBox.innerHTML = `
            <strong>Impossible de charger les données :</strong> ${err.message}<br><br>
            <small>Astuce : En local, générez les données avec <code>python scripts/build_data.py --output .</code> et lancez un serveur avec <code>python -m http.server</code>.</small>
        `;
        errorBox.style.display = 'block';
    }
}

function handleInput(val) {
    const query = val.trim().toUpperCase();
    const resultsBox = document.getElementById('autocompleteResults');
    
    if (!query) {
        resultsBox.style.display = 'none';
        return;
    }

    const matches = [];
    for (let i = 0; i < searchIndex.length; i++) {
        const item = searchIndex[i];
        if (
            item.ident.startsWith(query) ||
            (item.iata && item.iata.startsWith(query)) ||
            item.name.toUpperCase().includes(query) ||
            (item.municipality && item.municipality.toUpperCase().includes(query))
        ) {
            matches.push(item);
            if (matches.length >= 8) break;
        }
    }

    if (matches.length > 0) {
        resultsBox.innerHTML = '';
        matches.forEach(item => {
            const typeBadge = getAirportTypeBadge(item.type);
            const el = document.createElement('div');
            el.className = 'autocomplete-item';
            el.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <b>${item.ident}</b>
                        ${item.iata ? `<span style="color:var(--accent-blue); font-size:11px; margin-left:4px;">(${item.iata})</span>` : ''}
                        <span style="margin-left:6px;">${typeBadge}</span>
                    </div>
                    <span style="color:var(--n-9ca3af); font-size:11px;">${item.runways} piste(s)</span>
                </div>
                <div style="color:var(--n-94a3b8); font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                    ${item.name}${item.municipality ? ` (${item.municipality})` : ''}
                </div>
            `;
            el.onclick = () => {
                document.getElementById('airportInput').value = item.ident;
                resultsBox.style.display = 'none';
                selectAirport(item.ident);
            };
            resultsBox.appendChild(el);
        });
        resultsBox.style.display = 'block';
    } else {
        resultsBox.style.display = 'none';
    }

    if (searchIndexMap.has(query)) {
        selectAirport(query);
    }
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box')) {
        document.getElementById('autocompleteResults').style.display = 'none';
        document.getElementById('flightResults').style.display = 'none';
    }
});

async function selectAirport(code) {
    const upperCode = code.toUpperCase().trim();
    if (zoomReturn && zoomReturn.icao !== upperCode) zoomReturn = null;
    setViewMode('diagram');
    const errorBox = document.getElementById('fileError');
    const statusBox = document.getElementById('statusBox');
    errorBox.style.display = 'none';

    document.getElementById('airportInput').value = upperCode;
    document.getElementById('autocompleteResults').style.display = 'none';

    let data = airportCache.get(upperCode);

    if (!data) {
        statusBox.style.display = 'flex';
        statusBox.innerText = `Chargement des données de ${upperCode}...`;

        try {
            const res = await fetch(`./data/airports/${upperCode}.json`);
            if (!res.ok) {
                throw new Error(`Aéroport '${upperCode}' non trouvé ou non répertorié.`);
            }
            data = await res.json();
            airportCache.set(upperCode, data);
        } catch (err) {
            statusBox.style.display = 'none';
            errorBox.innerText = err.message;
            errorBox.style.display = 'block';
            return;
        } finally {
            statusBox.style.display = 'none';
        }
    }

    currentAirportCode = upperCode;
    currentAirportData = data;
    hideShortRunways = true;   // chaque nouvel aéroport s'ouvre petites pistes masquées

    displayAirportInfo(data);
    updateFlightCardActive();
    rawRunways = processRunwayCoordinates(data.runways || []);
    
    updateFilterButtonVisibility();
    applyFilterAndRefresh();

    // Mettre à jour l'URL sans rechargement de page
    if (window.history && window.history.replaceState) {
        const url = new URL(window.location);
        url.searchParams.set('icao', upperCode);
        window.history.replaceState({}, '', url);
    }
}

// ========================================================
// RECHERCHE DE VOLS & DOSSIER DE VOL (AirLabs via proxy Cloudflare Worker)
// ========================================================

// URL du Worker déployé (voir worker/README) : ex. 'https://airportsketch-flights.<compte>.workers.dev'
const FLIGHT_API_PROD = 'https://airportsketch-flights.phedolro-cd3.workers.dev';
// En local (PC ou téléphone sur le même réseau), on utilise `wrangler dev` sur le port 8787
const IS_LOCAL_HOST = /^(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)$/.test(location.hostname);
const FLIGHT_API_BASE = IS_LOCAL_HOST ? `http://${location.hostname}:8787` : FLIGHT_API_PROD;
const LIVE_CACHE_TTL_MS = 10 * 60 * 1000;   // comme le cache du worker (quota AirLabs)
const MAX_FLIGHT_RESULTS = 30;

const FLIGHT_STATUS = {
    'en-route':  { label: 'En vol',  color: 'var(--accent-green)' },
    'scheduled': { label: 'Prévu',   color: 'var(--accent-amber)' },
    'landed':    { label: 'Atterri', color: 'var(--text-muted)' },
    'cancelled': { label: 'Annulé',  color: 'var(--accent-red)' }
};

let iataIndexMap = new Map();
const liveFlightsCache = new Map();
let flightInputTimer = null;
let flightQuerySeq = 0;
let currentFlight = null;

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function isMobileLayout() {
    return window.matchMedia('(max-width: 768px)').matches;
}

function setSearchMode(mode, focus = true) {
    const isFlight = mode === 'flight';
    document.getElementById('searchSection').dataset.mode = mode;
    const btnAirport = document.getElementById('modeBtnAirport');
    const btnFlight = document.getElementById('modeBtnFlight');
    btnAirport.classList.toggle('active', !isFlight);
    btnFlight.classList.toggle('active', isFlight);
    btnAirport.setAttribute('aria-selected', String(!isFlight));
    btnFlight.setAttribute('aria-selected', String(isFlight));
    document.getElementById('airportSearchBox').hidden = isFlight;
    document.getElementById('flightSearchBox').hidden = !isFlight;

    // Le dossier de vol n'est visible qu'en mode « Vol » ; il réapparaît tel quel au retour
    document.body.dataset.searchMode = mode;
    if (!isFlight && viewMode === 'map') setViewMode('diagram');

    const label = document.getElementById('searchLabel');
    label.textContent = isFlight ? 'Rechercher un vol' : 'Rechercher un aéroport';
    label.htmlFor = isFlight ? 'flightInput' : 'airportInput';

    if (focus) document.getElementById(isFlight ? 'flightInput' : 'airportInput').focus();
}

// "AF173" -> compagnie IATA AF ; "AFR173" -> compagnie ICAO AFR
function parseFlightQuery(raw) {
    const q = raw.replace(/\s+/g, '').toUpperCase();
    let m = q.match(/^([A-Z]{3})(\d{0,4}[A-Z]?)$/);
    if (m) {
        return { q, airline: m[1], airlineParam: 'airline_icao', flightParam: 'flight_icao', complete: /^\d{1,4}[A-Z]?$/.test(m[2]) };
    }
    m = q.match(/^([A-Z0-9]{2})(\d{0,4}[A-Z]?)$/);
    if (m) {
        return { q, airline: m[1], airlineParam: 'airline_iata', flightParam: 'flight_iata', complete: /^\d{1,4}[A-Z]?$/.test(m[2]) };
    }
    return null;
}

// --- Mode des données de vol ---------------------------------------------
// Par défaut, le worker sert 20 vols de démonstration (fictifs). Les vraies données (AirLabs) sont réservées
// au propriétaire : ouvrir une fois le site avec ?code=… (secret LIVE_ACCESS_CODE du worker) ; ?code=off
// revient à la démo. C'est le worker qui vérifie le code : le site ne fait que le transmettre.
const ACCESS_CODE_KEY = 'pleinaxe.accessCode';
let accessCode = '';
try {
    const urlCode = new URLSearchParams(location.search).get('code');
    if (urlCode !== null) {
        if (urlCode === '' || urlCode.toLowerCase() === 'off') localStorage.removeItem(ACCESS_CODE_KEY);
        else localStorage.setItem(ACCESS_CODE_KEY, urlCode);
        // Le code ne reste pas dans la barre d'adresse (ni dans l'historique partagé)
        const clean = new URL(location.href);
        clean.searchParams.delete('code');
        history.replaceState({}, '', clean);
    }
    accessCode = localStorage.getItem(ACCESS_CODE_KEY) || '';
} catch (err) { /* stockage indisponible : mode démo */ }

let flightDataMode = null;     // 'demo' | 'live' | null (service sans /config, ex. simulateur local)
let demoFlights = [];

async function loadFlightDataMode() {
    if (!FLIGHT_API_BASE) return;
    try {
        const res = await fetch(`${FLIGHT_API_BASE}/config`, { headers: accessCode ? { 'X-Access-Code': accessCode } : {} });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const cfg = await res.json();
        flightDataMode = cfg.mode === 'live' ? 'live' : 'demo';
        demoFlights = Array.isArray(cfg.flights) ? cfg.flights : [];
    } catch (err) {
        flightDataMode = null;
    }
    document.body.dataset.flightData = flightDataMode || '';
    document.getElementById('demoNotice').hidden = flightDataMode !== 'demo';
    document.getElementById('demoModePill').hidden = flightDataMode !== 'demo';
    // Repère pour le propriétaire seulement : vraies données grâce à son code
    document.getElementById('liveModePill').hidden = !(flightDataMode === 'live' && accessCode);
}

// Mode démo : la liste complète des vols dès le clic dans le champ, sans attendre une saisie
function showDemoFlightsIfEmpty() {
    const input = document.getElementById('flightInput');
    if (flightDataMode === 'demo' && !input.value.trim()) renderDemoFlights('');
}

function renderDemoFlights(raw) {
    const q = raw.replace(/\s+/g, '').toUpperCase();
    const matches = demoFlights
        .filter(f => !q || [f.flight_iata, f.flight_icao, f.dep_iata, f.arr_iata].some(v => (v || '').startsWith(q)))
        .sort((a, b) => (a.flight_iata || '').localeCompare(b.flight_iata || '', 'fr', { numeric: true }));
    renderFlightResults({ q, flightParam: 'flight_iata', complete: false }, matches, null);
    if (!matches.length) showFlightMessage(`Aucun vol de démonstration ne correspond à <b>${escapeHtml(q)}</b>.`);
}

async function callFlightApi(path) {
    const res = await fetch(`${FLIGHT_API_BASE}${path}`, { headers: accessCode ? { 'X-Access-Code': accessCode } : {} });
    const body = await res.json().catch(() => null);
    if (!body || body.error) {
        throw new Error(body && body.error ? body.error.message : `Erreur du service de vols (${res.status})`);
    }
    return body.response;
}

async function fetchLiveFlights(p) {
    const key = `${p.airlineParam}:${p.airline}`;
    const cached = liveFlightsCache.get(key);
    if (cached && Date.now() - cached.time < LIVE_CACHE_TTL_MS) return cached.flights;

    const flights = (await callFlightApi(`/live?${p.airlineParam}=${encodeURIComponent(p.airline)}`)) || [];
    liveFlightsCache.set(key, { time: Date.now(), flights });
    return flights;
}

// Retrouve l'aéroport dans notre index (ICAO prioritaire, sinon IATA)
function findAirport(icao, iata) {
    if (icao && searchIndexMap.has(icao)) return searchIndexMap.get(icao);
    if (iata && iataIndexMap.has(iata)) return iataIndexMap.get(iata);
    return null;
}

function showFlightMessage(html) {
    const box = document.getElementById('flightResults');
    box.innerHTML = `<div class="autocomplete-msg">${html}</div>`;
    box.style.display = 'block';
}

function handleFlightInput(val) {
    clearTimeout(flightInputTimer);
    const seq = ++flightQuerySeq;
    const box = document.getElementById('flightResults');

    if (!FLIGHT_API_BASE) {
        showFlightMessage("Service de vols non configuré (URL du Worker manquante).");
        return;
    }
    // Mode démo : filtrage local des 20 vols, aucun appel au service
    if (flightDataMode === 'demo') {
        renderDemoFlights(val);
        return;
    }
    if (!val.trim()) {
        box.style.display = 'none';
        return;
    }
    const p = parseFlightQuery(val);
    if (!p) {
        showFlightMessage('Saisissez un code compagnie puis un numéro (ex : AF173, AFR173).');
        return;
    }

    showFlightMessage('Recherche des vols en direct…');
    flightInputTimer = setTimeout(async () => {
        let flights = [];
        let liveError = null;
        try {
            flights = await fetchLiveFlights(p);
        } catch (err) {
            liveError = err.message;
        }
        if (seq !== flightQuerySeq) return;

        const matches = flights
            .filter(f => (f[p.flightParam] || '').startsWith(p.q))
            .sort((a, b) => (parseInt(a.flight_number, 10) || 0) - (parseInt(b.flight_number, 10) || 0))
            .slice(0, MAX_FLIGHT_RESULTS);
        renderFlightResults(p, matches, liveError);
    }, /\d/.test(p.q) ? 300 : 900); // sans chiffre, "AF" peut encore devenir "AFR" : on attend plus longtemps
}

function renderFlightResults(p, matches, liveError) {
    const box = document.getElementById('flightResults');
    box.innerHTML = '';

    // Numéro complet sans vol en direct : proposer le dernier vol connu
    if (p.complete && !matches.some(f => f[p.flightParam] === p.q)) {
        const el = document.createElement('div');
        el.className = 'autocomplete-item';
        el.innerHTML = `
            <div><b>${escapeHtml(p.q)}</b> <span style="color:var(--n-9ca3af); font-size:11px; margin-left:4px;">pas en vol actuellement</span></div>
            <div style="color:var(--mode-accent); font-size:11px;">Afficher le dernier vol connu ➔</div>
        `;
        el.onclick = () => selectFlight(p.q, p.flightParam);
        box.appendChild(el);
    }

    matches.forEach(f => {
        const code = f[p.flightParam];
        const other = p.flightParam === 'flight_iata' ? f.flight_icao : f.flight_iata;
        const dep = findAirport(f.dep_icao, f.dep_iata);
        const arr = findAirport(f.arr_icao, f.arr_iata);
        const status = FLIGHT_STATUS[f.status] || { label: f.status || '', color: 'var(--text-muted)' };

        const el = document.createElement('div');
        el.className = 'autocomplete-item';
        el.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <b>${escapeHtml(code)}</b>
                    ${other ? `<span style="color:var(--mode-accent); font-size:11px; margin-left:4px;">(${escapeHtml(other)})</span>` : ''}
                </div>
                <span style="color:${status.color}; font-size:11px; font-weight:600;">${escapeHtml(status.label)}</span>
            </div>
            <div style="color:var(--n-94a3b8); font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                ${escapeHtml(f.dep_iata || f.dep_icao || '?')} → ${escapeHtml(f.arr_iata || f.arr_icao || '?')}
                ${dep || arr ? ` · ${escapeHtml(dep ? dep.municipality || dep.name : '?')} → ${escapeHtml(arr ? arr.municipality || arr.name : '?')}` : ''}
            </div>
        `;
        el.onclick = () => selectFlight(code, p.flightParam);
        box.appendChild(el);
    });

    if (!box.children.length) {
        showFlightMessage(liveError
            ? `Vols en direct indisponibles : ${escapeHtml(liveError)}`
            : `Aucun vol en direct commençant par <b>${escapeHtml(p.q)}</b>. Tapez le numéro complet pour voir le dernier vol connu.`);
        return;
    }
    box.style.display = 'block';
}

function handleFlightKeydown(e) {
    if (handleListKeydown(e, 'flightResults')) return;
    if (e.key !== 'Enter') return;
    const p = parseFlightQuery(e.target.value);
    if (p && p.complete && FLIGHT_API_BASE) selectFlight(p.q, p.flightParam);
}

// Navigation clavier dans une liste de suggestions : flèches haut/bas, Entrée, Échap.
// Retourne true si la touche a été traitée.
function handleListKeydown(e, boxId) {
    const box = document.getElementById(boxId);
    const open = box.style.display !== 'none' && box.style.display !== '';
    const items = open ? [...box.querySelectorAll('.autocomplete-item')] : [];
    const current = items.findIndex(el => el.classList.contains('kb-active'));

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!items.length) return false;
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const next = current === -1
            ? (step === 1 ? 0 : items.length - 1)
            : (current + step + items.length) % items.length;
        items.forEach((el, i) => el.classList.toggle('kb-active', i === next));
        items[next].scrollIntoView({ block: 'nearest' });
        return true;
    }
    if (e.key === 'Enter' && items.length) {
        // Élément surligné, sinon le premier de la liste (recherche d'aéroport)
        const target = current !== -1 ? items[current] : (boxId === 'autocompleteResults' ? items[0] : null);
        if (!target) return false;
        e.preventDefault();
        target.click();
        return true;
    }
    if (e.key === 'Escape' && open) {
        box.style.display = 'none';
        return true;
    }
    return false;
}

async function selectFlight(code, param) {
    clearTimeout(flightInputTimer);
    const seq = ++flightQuerySeq;
    document.getElementById('flightInput').value = code;
    showFlightMessage(`Chargement du vol ${escapeHtml(code)}…`);

    let flight;
    try {
        flight = await callFlightApi(`/flight?${param}=${encodeURIComponent(code)}`);
    } catch (err) {
        if (seq === flightQuerySeq) showFlightMessage(`Impossible de charger le vol : ${escapeHtml(err.message)}`);
        return;
    }
    if (seq !== flightQuerySeq) return;
    if (!flight || Array.isArray(flight) || !(flight.dep_iata || flight.dep_icao)) {
        showFlightMessage(`Aucun vol connu pour <b>${escapeHtml(code)}</b>.`);
        return;
    }

    document.getElementById('flightResults').style.display = 'none';
    currentFlight = flight;
    renderFlightCard(flight);
    if (!isMobileLayout()) showFlightMap();

    if (window.history && window.history.replaceState) {
        const url = new URL(window.location);
        url.searchParams.set('flight', flight.flight_iata || code);
        window.history.replaceState({}, '', url);
    }
    if (isMobileLayout()) switchMobileTab('details');
}

// "2026-10-01 14:20" -> "14:20" ; renvoie '' si absent
function flightTime(s) {
    return s && s.length >= 16 ? s.slice(11, 16) : '';
}
function flightDate(s) {
    return s && s.length >= 10 ? `${s.slice(8, 10)}/${s.slice(5, 7)}` : '';
}

function renderFlightAirportBlock(f, side) {
    const icao = f[`${side}_icao`];
    const iata = f[`${side}_iata`];
    const ap = findAirport(icao, iata);
    const scheduled = f[`${side}_time`];
    const updated = f[`${side}_actual`] || f[`${side}_estimated`];
    const delay = f[`${side}_delayed`];
    const extras = [
        f[`${side}_terminal`] ? `Terminal ${f[`${side}_terminal`]}` : '',
        f[`${side}_gate`] ? `Porte ${f[`${side}_gate`]}` : '',
        side === 'arr' && f.arr_baggage ? `Tapis ${f.arr_baggage}` : ''
    ].filter(Boolean).join(' · ');

    let timeHtml = scheduled ? `${flightTime(scheduled)} <span style="color:var(--text-dim); font-size:11px;">${flightDate(scheduled)}</span>` : '--:--';
    if (updated && flightTime(updated) !== flightTime(scheduled)) {
        timeHtml += ` → <span class="late">${flightTime(updated)}</span>`;
    }
    if (delay) timeHtml += ` <span class="late">(+${escapeHtml(delay)} min)</span>`;

    return `
        <div class="flight-ap ${side}">
            <div class="flight-ap-label">${side === 'dep' ? 'Départ' : 'Arrivée'}</div>
            <div class="flight-ap-code">${escapeHtml(iata || icao || '?')}${iata && icao ? `<small>${escapeHtml(icao)}</small>` : ''}</div>
            <div class="flight-ap-name" title="${escapeHtml(ap ? ap.name : '')}">${escapeHtml(ap ? (ap.municipality || ap.name) : 'Aéroport inconnu')}</div>
            <div class="flight-ap-time">${timeHtml}</div>
            ${extras ? `<div class="flight-ap-extra">${escapeHtml(extras)}</div>` : ''}
        </div>
    `;
}

function renderFlightDiagramButton(f, side) {
    const ap = findAirport(f[`${side}_icao`], f[`${side}_iata`]);
    const label = side === 'dep' ? 'Départ' : 'Arrivée';
    if (!ap) {
        return `<button class="btn-ap-diagram" disabled>${label} : diagramme indisponible</button>`;
    }
    return `<button class="btn-ap-diagram" data-icao="${escapeHtml(ap.ident)}" onclick="openFlightAirport('${escapeHtml(ap.ident)}')">Diagramme ${label.toLowerCase()} · ${escapeHtml(ap.ident)}</button>`;
}

function renderFlightCard(f) {
    const card = document.getElementById('flightCard');
    const status = FLIGHT_STATUS[f.status] || { label: f.status || 'Inconnu', color: 'var(--text-muted)' };
    const isLive = f.status === 'en-route';
    const code = f.flight_iata || f.flight_icao;
    const meta = [
        f.airline_name || '',
        f.flight_iata && f.flight_icao ? f.flight_icao : '',
        f.aircraft_icao ? `Appareil ${f.aircraft_icao}` : '',
        f.reg_number ? f.reg_number : '',
        f.duration ? `${Math.floor(f.duration / 60)}h${String(f.duration % 60).padStart(2, '0')}` : ''
    ].filter(Boolean).join(' · ');

    card.innerHTML = `
        <div class="info-card-header">
            <div>
                <h2>Dossier de vol</h2>
                <div class="flight-meta">
                    <span class="flight-status" style="color:${status.color};">${escapeHtml(status.label)}</span>${escapeHtml(meta)}
                </div>
            </div>
            <div style="display:flex; align-items:center; gap:6px;">
                <span class="ident-badge">${escapeHtml(code)}</span>
                <button class="btn-close-card" onclick="closeFlightCard()" title="Fermer le dossier de vol">×</button>
            </div>
        </div>
        <div class="flight-note ${isLive ? 'live' : ''}">
            ${isLive ? (f.demo ? 'Vol en cours.' : '● Vol en cours : données en direct.') : 'Pas en vol actuellement : affichage du vol connu le plus proche.'}
            Heures locales.
        </div>
        <div class="flight-route">
            ${renderFlightAirportBlock(f, 'dep')}
            <div class="flight-route-arrow">✈</div>
            ${renderFlightAirportBlock(f, 'arr')}
        </div>
        ${isLive ? '<div class="flight-progress" id="flightProgress"></div>' : ''}
        <div class="flight-overflown" id="flightOverflown"></div>
        <div class="flight-diagram-btns">
            <button class="btn-flight-map" onclick="showFlightMap(true)">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/></svg>
                Voir la route sur la carte
            </button>
            ${renderFlightDiagramButton(f, 'dep')}
            ${renderFlightDiagramButton(f, 'arr')}
        </div>
    `;
    card.hidden = false;
    document.body.dataset.flight = '1';
    updateFlightCardActive();
    startFlightProgress();
    refreshOverflown();
}

// --- Grands aéroports survolés -------------------------------------------
const EARTH_NM = 3440.065;
// Réglages de la carte du vol, mémorisés dans le navigateur (simple confort, facultatif)
const MAP_PREFS_KEY = 'airportsketch.mapPrefs';
const mapPrefs = { code: 'icao', band: 100, largeOnly: false, style: 'standard', conflict: true, airspaces: false,
    aspTypes: [3, 1, 2, 4, 7, 26, 12], aspClasses: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] };   // code : 'icao' (KJFK, par défaut) | 'iata' (JFK) ; couloir en nm ; style : 'standard' | 'inverted' | 'contrast'
try {
    const saved = JSON.parse(localStorage.getItem(MAP_PREFS_KEY) || '{}');
    if (['standard', 'inverted', 'contrast'].includes(saved.style)) mapPrefs.style = saved.style;
    if (typeof saved.conflict === 'boolean') mapPrefs.conflict = saved.conflict;
    if (typeof saved.airspaces === 'boolean') mapPrefs.airspaces = saved.airspaces;
    if (Array.isArray(saved.aspTypes)) mapPrefs.aspTypes = saved.aspTypes.filter(Number.isInteger);
    if (Array.isArray(saved.aspClasses)) mapPrefs.aspClasses = saved.aspClasses.filter(c => /^[A-G]$/.test(c));
    if (saved.code === 'iata' || saved.code === 'icao') mapPrefs.code = saved.code;
    if (typeof saved.largeOnly === 'boolean') mapPrefs.largeOnly = saved.largeOnly;
    if (Number.isFinite(saved.band)) mapPrefs.band = Math.min(300, Math.max(100, Math.round(saved.band / 10) * 10));
} catch (err) { /* stockage indisponible : valeurs par défaut */ }
function saveMapPrefs() {
    try { localStorage.setItem(MAP_PREFS_KEY, JSON.stringify(mapPrefs)); } catch (err) { /* ignoré */ }
}

// Code affiché selon le réglage (OACI si l'aéroport n'a pas de code IATA)
function airportCode(ap) {
    if (!ap) return '';
    const iata = ap.iata && ap.iata !== '-' ? ap.iata : '';
    return mapPrefs.code === 'icao' ? ap.ident : (iata || ap.ident);
}

function toRad(d) { return d * Math.PI / 180; }

// Distance angulaire (radians) et cap initial (radians) entre deux points
function gcDist(a, b) {
    const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2
        + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lon - a.lon) / 2) ** 2;
    return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function gcBearing(a, b) {
    const dl = toRad(b.lon - a.lon);
    return Math.atan2(Math.sin(dl) * Math.cos(toRad(b.lat)),
        Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dl));
}

const OVERFLY_STEP_NM = 50;     // pas d'échantillonnage de la route
const OVERFLY_NEAREST = 2;      // toujours retenus en chaque point (dégagements océaniques)

// Point à la fraction f du grand cercle a -> b
function gcInterpolate(a, b, d, f) {
    if (d === 0) return { lat: a.lat, lon: a.lon };
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const la1 = toRad(a.lat), lo1 = toRad(a.lon), la2 = toRad(b.lat), lo2 = toRad(b.lon);
    const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
    const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
    const z = A * Math.sin(la1) + B * Math.sin(la2);
    return { lat: Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI, lon: Math.atan2(y, x) * 180 / Math.PI };
}

/**
 * Aéroports le long de la route, logique « ETOPS » : la route (départ -> arrivée, ou départ -> avion
 * -> arrivée si la position est connue) est échantillonnée tous les 50 nm ; en chaque point on retient
 * les aéroports éligibles à 100 nm ou moins ET toujours les 2 plus proches, quelle que soit la distance
 * (au-dessus des océans : Shannon, Keflavik, Gander, Lajes...).
 * Éligibles = aéroports dont l'index fournit les coordonnées (large_airport avec une piste ≥ 2 800 m, ou medium_airport avec
 * une piste d'au moins 2 500 m, voir build_data.py). Départ et arrivée exclus, ainsi que ce qui est
 * derrière le départ ou au-delà de l'arrivée.
 * Résultat trié dans l'ordre de passage : [{ ap, xtrack (nm, + = à droite), along (nm depuis le départ) }].
 */
function computeOverflown(points, excluded) {
    const segs = [];
    let offset = 0;
    for (let i = 1; i < points.length; i++) {
        const len = gcDist(points[i - 1], points[i]);
        if (len > 0) segs.push({ a: points[i - 1], b: points[i], len, brg: gcBearing(points[i - 1], points[i]), offset });
        offset += len;
    }
    if (!segs.length) return [];
    const total = offset;

    // Échantillons de la route : position, abscisse curviligne et tronçon
    const step = OVERFLY_STEP_NM / EARTH_NM;
    const samples = [];
    segs.forEach((sg, si) => {
        const n = Math.max(1, Math.ceil(sg.len / step));
        for (let i = (si === 0 ? 0 : 1); i <= n; i++) {
            samples.push({ ...gcInterpolate(sg.a, sg.b, sg.len, i / n), along: sg.offset + sg.len * i / n, seg: si });
        }
    });

    const candidates = searchIndex.filter(ap => typeof ap.lat === 'number' && !excluded.has(ap.ident));
    const band = mapPrefs.band / EARTH_NM;
    const chosen = new Map();   // ident -> { ap, d, sample } (échantillon le plus proche)
    const keep = (ap, d, smp) => {
        const cur = chosen.get(ap.ident);
        if (!cur || d < cur.d) chosen.set(ap.ident, { ap, d, smp });
    };
    for (const smp of samples) {
        let n1 = null, n2 = null;   // deux plus proches de ce point
        for (const ap of candidates) {
            const d = gcDist(smp, ap);
            if (d <= band) keep(ap, d, smp);
            if (!n1 || d < n1.d) { n2 = n1; n1 = { ap, d }; }
            else if (!n2 || d < n2.d) n2 = { ap, d };
        }
        [n1, n2].slice(0, OVERFLY_NEAREST).forEach(n => { if (n) keep(n.ap, n.d, smp); });
    }

    const out = [];
    for (const { ap, d, smp } of chosen.values()) {
        // Projection sur le tronçon de l'échantillon le plus proche : distance latérale signée et abscisse
        const sg = segs[smp.seg];
        const d13 = gcDist(sg.a, ap);
        const dt = gcBearing(sg.a, ap) - sg.brg;
        const xt = Math.asin(Math.sin(d13) * Math.sin(dt));
        let at = Math.acos(Math.max(-1, Math.min(1, Math.cos(d13) / Math.cos(xt))));
        if (Math.cos(dt) < 0) at = -at;
        const along = sg.offset + at;
        // Derrière le départ ou au-delà de l'arrivée : exclu
        if (along < 0 || along > total) continue;
        const inside = at >= 0 && at <= sg.len;
        out.push({
            ap,
            xtrack: (inside ? Math.abs(xt) : d) * Math.sign(xt || 1) * EARTH_NM,
            along: (inside ? along : smp.along) * EARTH_NM
        });
    }
    return out.sort((p, q) => p.along - q.along);
}

// Recalcule la liste pour le vol courant (départ, avion si connu, arrivée) puis met à jour carte et dossier
async function refreshOverflown({ fit = true } = {}) {
    const f = currentFlight;
    const seq = ++flightMap.overflownSeq;
    if (!f) return;
    const [dep, arr] = await Promise.all([getAirportData(f.dep_icao), getAirportData(f.arr_icao), loadWorld().catch(() => null)]);
    if (seq !== flightMap.overflownSeq || f !== currentFlight) return;
    let list = [];
    if (dep && arr) {
        // Même route que celle tracée sur la carte (contournement des espaces interdits compris)
        const path = flightMap.flight === f && flightMap.plan
            ? flightMap.plan.path
            : planFlightPath([dep.lat, dep.lon], [arr.lat, arr.lon]);
        list = computeOverflown(path.map(asLL), new Set([dep.ident, arr.ident]));
    }
    flightMap.overflown = list;
    renderOverflownList(f, list, !!(dep && arr));
    if (flightMap.flight === f) updateMapOverlay();
    loadWeatherForMap();
    if (fit && viewMode === 'map' && flightMap.flight === f && !flightMap.userMoved) fitFlightMap();
    else scheduleMapDraw();
}

// Type d'un aéroport sur la carte du vol : un grand aéroport dont la plus longue piste fait moins de
// 2 800 m y compte comme aéroport moyen (route_type fourni par build_data.py)
function routeType(ap) { return (ap && (ap.route_type || ap.type)) || ''; }
function isLargeOnRoute(ap) { return routeType(ap) === 'large_airport'; }

// Aéroports le long de la route affichés (carte et liste), selon « grands aéroports seulement »
function visibleOverflown(list = flightMap.overflown) {
    return mapPrefs.largeOnly ? list.filter(o => isLargeOnRoute(o.ap)) : list.slice();
}

function renderOverflownList(f, list, routeKnown) {
    const box = document.getElementById('flightOverflown');
    if (!box) return;
    if (!routeKnown) { box.innerHTML = ''; return; }
    const wasOpen = box.querySelector('details') && box.querySelector('details').open;
    const shown = visibleOverflown(list);
    const rows = shown.map(o => {
        const code = airportCode(o.ap);
        const side = Math.round(Math.abs(o.xtrack)) < 1 ? 'sur la route' : `${Math.round(Math.abs(o.xtrack))} nm ${o.xtrack > 0 ? 'à droite' : 'à gauche'}`;
        return `<button type="button" class="overflown-row${isLargeOnRoute(o.ap) ? '' : ' is-medium'}" onclick="openFlightAirport('${escapeHtml(o.ap.ident)}')" title="${escapeHtml(o.ap.name)} — ouvrir le diagramme">
            <b><i class="wx-dot ${wxCat(o.ap.ident) || ''}"></i>${escapeHtml(code)}</b>
            <span class="overflown-city">${escapeHtml(o.ap.municipality && o.ap.municipality !== 'N/A' ? o.ap.municipality : o.ap.name)}</span>
            <span class="overflown-dist">${side}</span>
        </button>`;
    }).join('');
    box.innerHTML = `
        <details${wasOpen ? ' open' : ''}>
            <summary>Aéroports le long de la route <span class="overflown-count">${shown.length}</span></summary>
            <label class="overflown-filter">
                <input type="checkbox" ${mapPrefs.largeOnly ? 'checked' : ''} onchange="setLargeOnly(this.checked)">
                <span class="overflown-switch"></span>
                Grands aéroports seulement
            </label>
            ${shown.length ? `<div class="overflown-list">${rows}</div>` : `<div class="overflown-empty">${mapPrefs.largeOnly && list.length ? 'Aucun grand aéroport le long de la route.' : 'Aucun aéroport éligible le long de la route.'}</div>`}
        </details>`;
}

// --- Progression d'un vol en cours ---------------------------------------
let flightProgressTimer = null;

// Heure UTC AirLabs ("2026-10-01 20:30") -> millisecondes
function utcMs(s) {
    if (!s || s.length < 16) return null;
    const t = Date.parse(s.slice(0, 16).replace(' ', 'T') + ':00Z');
    return Number.isNaN(t) ? null : t;
}

function formatDuration(min) {
    const h = Math.floor(min / 60), m = min % 60;
    return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

// Départ réel (sinon estimé, sinon prévu) et arrivée estimée (sinon prévue + retard connu)
function flightProgressInfo(f) {
    const dep = utcMs(f.dep_actual_utc) || utcMs(f.dep_estimated_utc) || utcMs(f.dep_time_utc);
    let arr = utcMs(f.arr_estimated_utc) || utcMs(f.arr_actual_utc);
    if (!arr && utcMs(f.arr_time_utc)) arr = utcMs(f.arr_time_utc) + (f.arr_delayed || 0) * 60000;
    if (!arr && dep && f.duration) arr = dep + f.duration * 60000;
    if (!dep || !arr || arr <= dep) return null;
    const now = Date.now();
    return {
        ratio: Math.max(0, Math.min(1, (now - dep) / (arr - dep))),
        elapsed: Math.max(0, Math.round((now - dep) / 60000)),
        remaining: Math.max(0, Math.round((arr - now) / 60000))
    };
}

function renderFlightProgress() {
    const box = document.getElementById('flightProgress');
    if (!box || !currentFlight) return;
    const info = flightProgressInfo(currentFlight);
    if (!info) {
        box.hidden = true;
        return;
    }
    const pct = (info.ratio * 100).toFixed(1);
    box.hidden = false;
    box.innerHTML = `
        <div class="flight-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(info.ratio * 100)}">
            <div class="flight-progress-fill" style="width:${pct}%"></div>
            <svg class="flight-progress-plane" style="left:${pct}%" viewBox="0 0 24 24"><path fill="currentColor" transform="rotate(90 12 12)" d="M12 1.5 L13.6 8.5 L22 13.5 L22 15.5 L13.6 12.8 L13.2 19 L16 21 L16 22.5 L12 21.5 L8 22.5 L8 21 L10.8 19 L10.4 12.8 L2 15.5 L2 13.5 L10.4 8.5 Z"/></svg>
        </div>
        <div class="flight-progress-info">
            <span>${formatDuration(info.elapsed)} de vol · ${Math.round(info.ratio * 100)} %</span>
            <span>${info.remaining > 0 ? `Arrivée dans <b>${formatDuration(info.remaining)}</b>` : '<b>Arrivée imminente</b>'}</span>
        </div>`;
}

function startFlightProgress() {
    if (flightProgressTimer) clearInterval(flightProgressTimer);
    flightProgressTimer = null;
    if (!document.getElementById('flightProgress')) return;
    renderFlightProgress();
    flightProgressTimer = setInterval(renderFlightProgress, 30000);
}

function openFlightAirport(icao) {
    selectAirport(icao);
    if (isMobileLayout()) switchMobileTab('diagram');
}

// Met en évidence le bouton de l'aéroport actuellement affiché
function updateFlightCardActive() {
    document.querySelectorAll('#flightCard .btn-ap-diagram[data-icao]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.icao === currentAirportCode);
    });
    updateViewToggle();
}

// Bascule au-dessus du schéma : « Diagramme <départ> », « Diagramme <arrivée> », « Carte »
function updateViewToggle() {
    const f = currentFlight;
    const isMap = viewMode === 'map';
    [['viewBtnDep', 'dep'], ['viewBtnArr', 'arr']].forEach(([id, side]) => {
        const btn = document.getElementById(id);
        if (!f) return;
        const ap = findAirport(f[`${side}_icao`], f[`${side}_iata`]);
        const label = (f[`${side}_iata`] || f[`${side}_icao`] || '?').toUpperCase();
        btn.querySelector('span').textContent = `Diagramme ${label}`;
        btn.disabled = !ap;
        btn.title = ap ? `Diagramme de pistes de ${ap.name}` : 'Diagramme indisponible pour cet aéroport';
        btn.onclick = ap ? () => openFlightAirport(ap.ident) : null;
        const active = !isMap && !!ap && ap.ident === currentAirportCode;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', String(active));
    });
    const mapBtn = document.getElementById('viewBtnMap');
    mapBtn.classList.toggle('active', isMap);
    mapBtn.setAttribute('aria-selected', String(isMap));
}

function closeFlightCard() {
    currentFlight = null;
    zoomReturn = null;
    if (flightProgressTimer) { clearInterval(flightProgressTimer); flightProgressTimer = null; }
    delete document.body.dataset.flight;
    setViewMode('diagram');
    flightMap.seq++;
    flightMap.flight = null;
    flightMap.route = null;
    stopMapRefresh();
    document.getElementById('flightCard').hidden = true;
    document.getElementById('flightInput').value = '';
    if (window.history && window.history.replaceState) {
        const url = new URL(window.location);
        url.searchParams.delete('flight');
        window.history.replaceState({}, '', url);
    }
}

// Le bouton n'a de sens que si l'aéroport a à la fois des petites et des grandes pistes
function updateFilterButtonVisibility() {
    const hasShortRunways = rawRunways.some(r => r.length_m < MIN_RUNWAY_LENGTH_M);
    const hasLongRunways = rawRunways.some(r => r.length_m >= MIN_RUNWAY_LENGTH_M);
    const isApplicable = hasShortRunways && hasLongRunways;
    ['shortRwyBtn', 'fsFilterBtn'].forEach(id => { document.getElementById(id).hidden = !isApplicable; });
}

function toggleShortRunways() {
    hideShortRunways = !hideShortRunways;
    applyFilterAndRefresh();
}

function applyFilterAndRefresh() {
    // Un aéroport qui n'a que des petites pistes les montre toutes (sinon le diagramme serait vide)
    const longRunways = rawRunways.filter(r => r.length_m >= MIN_RUNWAY_LENGTH_M);
    currentRunways = hideShortRunways && longRunways.length ? longRunways : [...rawRunways];
    ['shortRwyBtn', 'fsFilterBtn'].forEach(id => {
        const btn = document.getElementById(id);
        btn.classList.toggle('active', hideShortRunways);
        btn.querySelector('.short-rwy-label').textContent = hideShortRunways ? 'Afficher petites pistes' : 'Masquer petites pistes';
    });

    updateSidebarInfo(currentAirportCode);
    resetView();
}

function displayAirportInfo(data) {
    const card = document.getElementById('airportCard');
    // Affiche le deuxième panneau (grand écran) ; la zone de dessin change de taille : on la remesure tout de suite,
    // avant que le schéma soit cadré
    if (document.body.classList.toggle('airport-open', !!data)) resizeCanvas(false);
    if (!data) {
        card.style.display = 'none';
        return;
    }

    document.getElementById('apName').innerText = data.name || data.ident;
    document.getElementById('apIdent').innerText = data.ident;
    document.getElementById('apIata').innerText = (data.iata && data.iata !== '-') ? data.iata : '-';
    document.getElementById('apTypeBadge').innerHTML = getAirportTypeBadge(data.type);
    document.getElementById('apMunicipality').innerText = data.municipality || '-';
    document.getElementById('apCountry').innerText = data.country || '-';
    
    // Header plein écran
    document.getElementById('fsIdent').innerText = data.ident;
    document.getElementById('fsName').innerText = data.name || data.ident;
    document.getElementById('fsRunwaysCount').innerText = `${(data.runways || []).length} piste(s)`;
    
    // Badge onglet mobile
    document.getElementById('tabRunwayBadge').innerText = (data.runways || []).length;
    document.getElementById('quickPillText').innerText = `${data.ident} • ${data.name || ''}`;

    // Titre en grand sur le diagramme
    const city = data.municipality && data.municipality !== 'N/A' ? data.municipality : '';
    document.getElementById('diagramTitleName').textContent = data.name || data.ident;
    document.getElementById('diagramTitleMeta').innerHTML = [
        escapeHtml(data.ident),
        data.iata && data.iata !== '-' ? escapeHtml(data.iata) : '',
        city ? `<span>${escapeHtml(city)}</span>` : ''
    ].filter(Boolean).join(' · ');
    document.getElementById('diagramTitle').hidden = false;

    if (data.elev_ft !== null && data.elev_ft !== undefined) {
        const elevM = Math.round(data.elev_ft * FT_TO_M);
        document.getElementById('apElev').innerText = `${data.elev_ft} ft (${elevM} m)`;
    } else {
        document.getElementById('apElev').innerText = '-';
    }

    document.getElementById('apCoords').innerText = `${(data.lat || 0).toFixed(3)}°, ${(data.lon || 0).toFixed(3)}°`;

    const freqs = data.frequencies || [];
    const freqSummary = document.getElementById('freqSummary');
    const freqList = document.getElementById('freqList');
    
    freqSummary.innerText = `Fréquences radio (${freqs.length})`;
    freqList.innerHTML = '';

    if (freqs.length === 0) {
        freqList.innerHTML = `<div style="font-size:11px; color:var(--n-6b7280); font-style:italic;">Aucune fréquence répertoriée</div>`;
    } else {
        freqs.forEach(f => {
            const item = document.createElement('div');
            item.className = 'freq-item';
            const label = f.description ? `${f.type} (${f.description})` : f.type;
            item.innerHTML = `
                <span class="freq-type" title="${label}">${label}</span>
                <span class="freq-mhz">${f.mhz} MHz</span>
            `;
            freqList.appendChild(item);
        });
    }

    card.style.display = 'flex';
    loadAirportWeather(data.ident);
}

function processRunwayCoordinates(runways) {
    if (!runways || runways.length === 0) return [];

    let centerLat = 0, centerLon = 0;
    runways.forEach(r => {
        centerLat += (r.le_lat + r.he_lat) / 2;
        centerLon += (r.le_lon + r.he_lon) / 2;
    });
    centerLat /= runways.length;
    centerLon /= runways.length;

    const R = 6371000;
    const radCenterLat = centerLat * Math.PI / 180;

    const gpsToMeters = (lat, lon) => ({
        x: (lon - centerLon) * Math.PI / 180 * Math.cos(radCenterLat) * R,
        y: (lat - centerLat) * Math.PI / 180 * R
    });

    return runways.map(r => {
        const le_m = gpsToMeters(r.le_lat, r.le_lon);
        const he_m = gpsToMeters(r.he_lat, r.he_lon);
        const length_m = Math.hypot(he_m.x - le_m.x, he_m.y - le_m.y);

        return {
            ...r,
            le_m: le_m,
            he_m: he_m,
            length_m: length_m,
            width_m: r.width_ft * FT_TO_M,
            le_disp_m: r.le_disp_ft * FT_TO_M,
            he_disp_m: r.he_disp_ft * FT_TO_M
        };
    });
}

// ========================================================
// APPROCHES IFR (données FAA, aéroports américains)
// ========================================================
const APPROACH_STYLES = {
    ILS3: { label: 'ILS CAT III', cls: 'appr-ils3', bg: '#15803d',                bd: '#22c55e', fg: '#ffffff' },
    ILS2: { label: 'ILS CAT II',  cls: 'appr-ils2', bg: 'rgba(34,197,94,0.30)',   bd: '#22c55e', fg: '#bbf7d0', fgL: '#166534' },
    ILS1: { label: 'ILS CAT I',   cls: 'appr-ils1', bg: 'rgba(34,197,94,0.14)',   bd: '#16a34a', fg: '#86efac', fgL: '#15803d' },
    LOC:  { label: 'LOC',         cls: 'appr-loc',  bg: 'rgba(20,184,166,0.12)',  bd: '#14b8a6', fg: '#99f6e4', fgL: '#0f766e' },
    RNAV: { label: 'RNAV',        cls: 'appr-rnav', bg: 'rgba(217,70,239,0.18)',  bd: '#d946ef', fg: '#f0abfc', fgL: '#a21caf' },
    VOR:  { label: 'VOR',         cls: 'appr-vor',  bg: 'rgba(245,158,11,0.16)',  bd: '#f59e0b', fg: '#fcd34d', fgL: '#3730a3', bdL: '#6366f1', bgL: 'rgba(238,242,255,0.97)' },
    NDB:  { label: 'NDB',         cls: 'appr-ndb',  bg: 'rgba(245,158,11,0.16)',  bd: '#f59e0b', fg: '#fcd34d', fgL: '#3730a3', bdL: '#6366f1', bgL: 'rgba(238,242,255,0.97)' },
    VIS:  { label: 'VIS',         cls: 'appr-vis',  bg: 'rgba(11,15,25,0.9)',     bd: '#475569', fg: '#94a3b8', fgL: '#475569', bgL: 'rgba(255,255,255,0.95)' }
};

// Pastilles d'un seuil : un type par pastille, ILS avec sa catégorie max, LOC seulement sans ILS
function approachTags(ident) {
    const apps = (currentAirportData && currentAirportData.approaches && currentAirportData.approaches[ident]) || [];
    const byType = {};
    apps.forEach(a => (byType[a.type] = byType[a.type] || []).push(a));

    const tags = [];
    if (byType.ILS) {
        const cat = Math.max(...byType.ILS.map(a => a.cat || 1));
        tags.push({ key: `ILS${cat}`, apps: byType.ILS });
    } else if (byType.LOC) {
        tags.push({ key: 'LOC', apps: byType.LOC });
    }
    ['RNAV', 'VOR', 'NDB', 'VIS'].forEach(t => { if (byType[t]) tags.push({ key: t, apps: byType[t] }); });
    return tags.map(t => {
        const charts = [];
        t.apps.forEach(a => { if (!charts.some(c => c.pdf === a.pdf)) charts.push({ name: a.name, pdf: a.pdf }); });
        return { ...APPROACH_STYLES[t.key], key: t.key, charts };
    });
}

function chartUrl(pdf) {
    return (currentAirportData.approaches_pdf_base || '') + pdf;
}

function closeChartMenu() {
    document.getElementById('chartMenu').hidden = true;
}

// Une seule carte : ouverture directe. Plusieurs : menu au point de clic.
function openApproachCharts(ident, key, clientX, clientY) {
    const tag = approachTags(ident).find(t => t.key === key);
    if (!tag || !tag.charts.length) return;
    if (tag.charts.length === 1) {
        closeChartMenu();
        window.open(chartUrl(tag.charts[0].pdf), '_blank', 'noopener');
        return;
    }
    const menu = document.getElementById('chartMenu');
    menu.innerHTML = `
        <div class="chart-menu-title"><b>${escapeHtml(ident)}</b> <span class="appr-tag ${tag.cls}">${tag.label}</span></div>
        ${tag.charts.map(c => `<a href="${escapeHtml(chartUrl(c.pdf))}" target="_blank" rel="noopener">${escapeHtml(c.name)} <span>PDF ↗</span></a>`).join('')}
    `;
    menu.hidden = false;
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(clientX + 8, window.innerWidth - w - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(clientY + 8, window.innerHeight - h - 8))}px`;
}

function approachTagsHtml(ident) {
    const tags = approachTags(ident);
    if (!tags.length) return '<span class="approach-none">Aucune approche IFR publiée</span>';
    return tags.map(t => `<button type="button" class="appr-tag ${t.cls}" data-ident="${escapeHtml(ident)}" data-key="${t.key}"
        title="${escapeHtml(t.charts.map(c => c.name).join('\n'))}">${t.label}</button>`).join('');
}

// Légende et source, en dernier élément de la liste scrollable des pistes
function appendApproachInfo(listEl) {
    const data = currentAirportData;
    if (!data || !data.approaches) return;
    const used = new Set(currentRunways.flatMap(r => [r.le_ident, r.he_ident]).flatMap(id => approachTags(id).map(t => t.key)));
    const legend = Object.entries(APPROACH_STYLES)
        .filter(([key]) => used.has(key))
        .map(([, s]) => `<span class="appr-tag ${s.cls}">${s.label}</span>`).join('');
    const box = document.createElement('div');
    box.className = 'approach-info';
    box.innerHTML = `
        <div class="approach-legend">${legend}</div>
        <div class="approach-source">
            Approches IFR : FAA (d-TPP / CIFP), cycle AIRAC ${escapeHtml(data.approaches_cycle || '')}.
            Cliquez sur une pastille pour ouvrir la carte d'approche (PDF FAA). Information indicative —
            ne pas utiliser pour la navigation.
        </div>`;
    listEl.appendChild(box);
}

function updateSidebarInfo(code) {
    document.getElementById('statsBox').style.display = 'flex';
    const filterNotice = currentRunways.length < rawRunways.length ? ' (petites pistes masquées)' : '';
    document.getElementById('statsTitle').innerText = `${code} : ${currentRunways.length} Piste(s)${filterNotice}`;
    
    const listEl = document.getElementById('runwayList');
    listEl.innerHTML = '';

    currentRunways.forEach(r => {
        const lengthM = Math.round(r.length_m);
        const hasDisp = r.le_disp_ft > 0 || r.he_disp_ft > 0;
        let dispInfo = '';
        if (r.le_disp_ft > 0) dispInfo += `Seuil ${r.le_ident}: ${Math.round(r.le_disp_ft)}ft `;
        if (r.he_disp_ft > 0) dispInfo += `Seuil ${r.he_ident}: ${Math.round(r.he_disp_ft)}ft`;

        const item = document.createElement('div');
        const isShort = r.length_m < MIN_RUNWAY_LENGTH_M;
        item.className = isShort ? 'runway-item is-short' : 'runway-item';
        item.innerHTML = `
            <div>
                <span class="runway-ident">${r.le_ident}/${r.he_ident}</span>${isShort ? '<span class="short-rwy-tag">PETITE PISTE</span>' : ''}
                <div style="color:var(--n-94a3b8); font-size:11px; margin-top:2px;">Largeur: ${Math.round(r.width_m)}m (${Math.round(r.width_ft)}ft)</div>
                ${hasDisp ? `<div style="color:var(--disp-text); font-size:10px; margin-top:3px; font-weight:500;">${dispInfo}</div>` : ''}
            </div>
            <div style="text-align:right;">
                <div style="font-weight:700; color:var(--n-f8fafc);">${lengthM} m</div>
                <div style="color:var(--n-94a3b8); font-size:11px;">${Math.round(lengthM / FT_TO_M)} ft</div>
            </div>
            ${currentAirportData && currentAirportData.approaches ? `
            <div class="runway-approaches">
                <div class="approach-row"><span class="approach-row-ident">${r.le_ident}</span>${approachTagsHtml(r.le_ident)}</div>
                <div class="approach-row"><span class="approach-row-ident">${r.he_ident}</span>${approachTagsHtml(r.he_ident)}</div>
            </div>` : ''}
        `;
        listEl.appendChild(item);
    });
    appendApproachInfo(listEl);
}

function calculateBounds() {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    currentRunways.forEach(r => {
        minX = Math.min(minX, r.le_m.x, r.he_m.x);
        maxX = Math.max(maxX, r.le_m.x, r.he_m.x);
        minY = Math.min(minY, r.le_m.y, r.he_m.y);
        maxY = Math.max(maxY, r.le_m.y, r.he_m.y);
    });
    return { minX, maxX, minY, maxY, width: maxX - minX || 100, height: maxY - minY || 100 };
}

function resetView() {
    if (currentRunways.length === 0) return;

    // Synchroniser les dimensions physiques et logiques du canvas
    resizeCanvas(false);

    const width = canvasContainer.clientWidth;
    const height = canvasContainer.clientHeight;
    if (width === 0 || height === 0) {
        requestAnimationFrame(() => resetView());
        return;
    }

    viewState.baseBounds = calculateBounds();
    const padding = Math.min(width, height) * 0.15;
    // Place pour les pastilles d'approche au-delà des seuils (plafonnée sur petit écran)
    const hasApproaches = !!(currentAirportData && currentAirportData.approaches);
    const padX = hasApproaches ? Math.min(Math.max(padding, 175), width * 0.3) : padding;
    const padY = hasApproaches ? Math.min(Math.max(padding, 75), height * 0.3) : padding;
    // Titre de l'aéroport en haut (masqué en plein écran et sur mobile) : les seuils du haut doivent
    // commencer sous le titre, avec la place de leur identifiant et de leurs pastilles d'approche
    // (jusqu'à ~65 px au-delà du seuil), sinon ces éléments débordent sur le titre
    const titleEl = document.getElementById('diagramTitle');
    const titleBottom = titleEl && !titleEl.hidden && titleEl.offsetParent !== null
        ? titleEl.offsetTop + titleEl.offsetHeight : 0;
    const padTop = titleBottom ? Math.max(padY, titleBottom + (hasApproaches ? 75 : 45)) : padY;
    const scaleX = (width - 2 * padX) / viewState.baseBounds.width;
    const scaleY = (height - padTop - padY) / viewState.baseBounds.height;
    viewState.scale = Math.min(scaleX, scaleY);
    viewState.fitScale = viewState.scale;   // référence pour le retour vers la carte au dézoom
    viewState.offsetX = 0;
    viewState.offsetY = (padTop - padY) / 2;
    draw();
}

function zoom(factor, clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const cx = (clientX !== undefined) ? (clientX - rect.left) : (canvasContainer.clientWidth / 2);
    const cy = (clientY !== undefined) ? (clientY - rect.top) : (canvasContainer.clientHeight / 2);
    const centerX = canvasContainer.clientWidth / 2;
    const centerY = canvasContainer.clientHeight / 2;

    const newScale = Math.max(0.0001, viewState.scale * factor);
    viewState.offsetX = cx - centerX - (cx - centerX - viewState.offsetX) * factor;
    viewState.offsetY = cy - centerY - (cy - centerY - viewState.offsetY) * factor;
    viewState.scale = newScale;
    draw();
    if (factor < 1) maybeReturnToMap();
}

function toCanvasCoords(m) {
    const b = viewState.baseBounds;
    if (!b) return { x: 0, y: 0 };
    const centerX = (b.minX + b.maxX) / 2;
    const centerY = (b.minY + b.maxY) / 2;
    return {
        x: canvasContainer.clientWidth / 2 + (m.x - centerX) * viewState.scale + viewState.offsetX,
        y: canvasContainer.clientHeight / 2 - (m.y - centerY) * viewState.scale + viewState.offsetY
    };
}

function drawDisplacedThreshold(pStart, ux, uy, nx, ny, dispPx, halfWidthPx) {
    if (dispPx <= 0) return;

    const pEnd = { x: pStart.x + ux * dispPx, y: pStart.y + uy * dispPx };

    ctx.fillStyle = DC.dispFill;
    ctx.beginPath();
    ctx.moveTo(pStart.x + nx * halfWidthPx, pStart.y + ny * halfWidthPx);
    ctx.lineTo(pEnd.x + nx * halfWidthPx, pEnd.y + ny * halfWidthPx);
    ctx.lineTo(pEnd.x - nx * halfWidthPx, pEnd.y - ny * halfWidthPx);
    ctx.lineTo(pStart.x - nx * halfWidthPx, pStart.y - ny * halfWidthPx);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = DC.dispStroke;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(pEnd.x + nx * (halfWidthPx + 4), pEnd.y + ny * (halfWidthPx + 4));
    ctx.lineTo(pEnd.x - nx * (halfWidthPx + 4), pEnd.y - ny * (halfWidthPx + 4));
    ctx.stroke();

    const arrowCount = Math.max(1, Math.floor(dispPx / 25));
    const step = dispPx / (arrowCount + 1);

    ctx.lineWidth = 2.5;
    for (let i = 1; i <= arrowCount; i++) {
        const cx = pStart.x + ux * (step * i);
        const cy = pStart.y + uy * (step * i);
        const arrowSize = Math.max(8, halfWidthPx * 0.7);

        ctx.beginPath();
        ctx.moveTo(cx - ux * arrowSize + nx * arrowSize, cy - uy * arrowSize + ny * arrowSize);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx - ux * arrowSize - nx * arrowSize, cy - uy * arrowSize - ny * arrowSize);
        ctx.stroke();
    }
}

// Zones cliquables des pastilles sur le schéma (coordonnées canvas, recalculées à chaque dessin)
let approachHitAreas = [];

function approachTagAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left, py = clientY - rect.top;
    // La dernière pastille dessinée est celle visible au-dessus en cas de chevauchement
    return approachHitAreas.findLast(a => px >= a.x && px <= a.x + a.w && py >= a.y && py <= a.y + a.h);
}

// (ux, uy) : direction unitaire vers l'extérieur de la piste depuis le seuil p
function drawApproachTags(ident, p, ux, uy) {
    const tags = approachTags(ident);
    if (!tags.length) return;

    ctx.save();
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const gap = 3, h = 14;
    const widths = tags.map(t => ctx.measureText(t.label).width + 10);
    const total = widths.reduce((a, b) => a + b, 0) + gap * (tags.length - 1);

    // Centre du bloc : juste après l'identifiant (centré à 28 px du seuil), sans le recouvrir
    // ni recouvrir la piste, quelle que soit l'orientation
    ctx.font = 'bold 12px sans-serif';
    const identReach = Math.abs(ux) * ctx.measureText(ident).width / 2 + Math.abs(uy) * 7;
    ctx.font = 'bold 9px sans-serif';
    const reach = Math.abs(ux) * total / 2 + Math.abs(uy) * h / 2;
    const d = 28 + identReach + 5 + reach;
    let x = p.x + ux * d - total / 2;
    const y = p.y + uy * d - h / 2;

    tags.forEach((t, i) => {
        const w = widths[i];
        approachHitAreas.push({ x, y, w, h, ident, key: t.key });
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, w, h, 3); else ctx.rect(x, y, w, h);
        ctx.fillStyle = DC.pillBase;
        ctx.fill();
        ctx.fillStyle = theme === 'light' && t.bgL ? t.bgL : t.bg;
        ctx.fill();
        ctx.strokeStyle = theme === 'light' && t.bdL ? t.bdL : t.bd;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = theme === 'light' && t.fgL ? t.fgL : t.fg;
        ctx.fillText(t.label, x + w / 2, y + h / 2 + 0.5);
        x += w + gap;
    });
    ctx.restore();
}

function draw() {
    approachHitAreas = [];
    const width = canvasContainer.clientWidth;
    const height = canvasContainer.clientHeight;
    ctx.clearRect(0, 0, width, height);

    // Grille d'arrière-plan
    ctx.strokeStyle = DC.grid;
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = 0; y < height; y += 40) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }

    if (!viewState.baseBounds) return;

    currentRunways.forEach(r => {
        const p1 = toCanvasCoords(r.le_m);
        const p2 = toCanvasCoords(r.he_m);
        const dx = p2.x - p1.x, dy = p2.y - p1.y;
        const len = Math.hypot(dx, dy);
        if (len === 0) return;

        const ux = dx / len, uy = dy / len;
        const nx = -uy, ny = ux;
        const halfWidthPx = Math.max((r.width_m * viewState.scale) / 2, 3);

        // Corps de la piste (violet pâle pour les pistes de moins de 2000 m)
        const isShort = r.length_m < MIN_RUNWAY_LENGTH_M;
        ctx.fillStyle = isShort ? DC.shortFill : DC.rwyFill;
        ctx.strokeStyle = isShort ? DC.shortStroke : DC.rwyStroke;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p1.x + nx * halfWidthPx, p1.y + ny * halfWidthPx);
        ctx.lineTo(p2.x + nx * halfWidthPx, p2.y + ny * halfWidthPx);
        ctx.lineTo(p2.x - nx * halfWidthPx, p2.y - ny * halfWidthPx);
        ctx.lineTo(p1.x - nx * halfWidthPx, p1.y - ny * halfWidthPx);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Ligne axiale
        ctx.strokeStyle = isShort ? DC.shortCenter : DC.rwyCenter;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([8, 8]);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Seuils décalés
        const leDispPx = r.le_disp_m * viewState.scale;
        const heDispPx = r.he_disp_m * viewState.scale;
        drawDisplacedThreshold(p1, ux, uy, nx, ny, leDispPx, halfWidthPx);
        drawDisplacedThreshold(p2, -ux, -uy, -nx, -ny, heDispPx, halfWidthPx);

        // Identifiants de pistes
        ctx.fillStyle = isShort ? DC.shortId : DC.rwyId;
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(r.le_ident, p1.x - ux * 28, p1.y - uy * 28);
        ctx.fillText(r.he_ident, p2.x + ux * 28, p2.y + uy * 28);

        // Pastilles d'approche IFR, dans le prolongement de l'axe au-delà de l'identifiant
        drawApproachTags(r.le_ident, p1, -ux, -uy);
        drawApproachTags(r.he_ident, p2, ux, uy);

        // Dimensions et étiquette orientée
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;
        const lengthM = Math.round(r.length_m);
        const lengthFt = Math.round(lengthM / FT_TO_M);
        const widthM = Math.round(r.width_m);
        const widthFt = Math.round(r.width_ft);

        const label = `${lengthM}m x ${widthM}m (${lengthFt}ft x ${widthFt}ft)`;

        ctx.save();
        ctx.translate(midX, midY);
        let angle = Math.atan2(dy, dx);
        if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;
        ctx.rotate(angle);

        ctx.font = '10px monospace';
        const textWidth = ctx.measureText(label).width;
        
        ctx.fillStyle = DC.dimBg;
        ctx.fillRect(-textWidth / 2 - 4, -18, textWidth + 8, 14);

        ctx.fillStyle = DC.dimText;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, 0, -11);
        ctx.restore();
    });
}

// ========================================================
// INTERACTIONS SOURIS (DESKTOP)
// ========================================================
canvas.addEventListener('mousedown', (e) => {
    viewState.isDragging = true;
    viewState.startX = e.clientX - viewState.offsetX;
    viewState.startY = e.clientY - viewState.offsetY;
});

window.addEventListener('mousemove', (e) => {
    if (viewState.isDragging) {
        viewState.offsetX = e.clientX - viewState.startX;
        viewState.offsetY = e.clientY - viewState.startY;
        draw();
    }
});

window.addEventListener('mouseup', () => {
    viewState.isDragging = false;
});

// Clic / tap sur une pastille d'approche (ignoré si la carte a été déplacée)
let pointerDownPos = null;
canvas.addEventListener('pointerdown', (e) => { pointerDownPos = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('click', (e) => {
    if (pointerDownPos && Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y) > 6) return;
    const hit = approachTagAt(e.clientX, e.clientY);
    if (hit) {
        e.stopPropagation();
        openApproachCharts(hit.ident, hit.key, e.clientX, e.clientY);
    }
});
canvas.addEventListener('mousemove', (e) => {
    if (!viewState.isDragging) canvas.style.cursor = approachTagAt(e.clientX, e.clientY) ? 'pointer' : '';
});

document.getElementById('runwayList').addEventListener('click', (e) => {
    const btn = e.target.closest('.appr-tag[data-key]');
    if (!btn) return;
    e.stopPropagation();
    openApproachCharts(btn.dataset.ident, btn.dataset.key, e.clientX, e.clientY);
});

document.addEventListener('click', (e) => {
    if (!e.target.closest('#chartMenu')) closeChartMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeChartMenu(); });
document.getElementById('runwayList').addEventListener('scroll', closeChartMenu);

// Fenêtre d'aide (Échap et focus gérés nativement par <dialog>)
const helpDialog = document.getElementById('helpDialog');
function openHelp() {
    closeChartMenu();
    helpDialog.showModal();
}
function closeHelp() {
    helpDialog.close();
}
// Clic sur le fond assombri : la cible est alors le <dialog> lui-même
helpDialog.addEventListener('click', (e) => {
    if (e.target === helpDialog) closeHelp();
});

canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (Date.now() < wheelPausedUntil) return;   // juste après une bascule carte -> diagramme
    const factor = e.deltaY < 0 ? 1.15 : 0.85;
    zoom(factor, e.clientX, e.clientY);
}, { passive: false });

// ========================================================
// INTERACTIONS TACTILES MULTI-TOUCH (MOBILE)
// 1 DOIGT = DÉPLACEMENT / PAN
// 2 DOIGTS = ZOOM PINCÉ ANCRÉ / PINCH-TO-ZOOM
// DOUBLE TAP = RECENTRAGE / ZOOM RAPIDE
// ========================================================
canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
        const touch = e.touches[0];
        viewState.isDragging = true;
        viewState.startX = touch.clientX - viewState.offsetX;
        viewState.startY = touch.clientY - viewState.offsetY;

        // Détection du double tap
        const now = Date.now();
        if (now - touchState.lastTapTime < 300) {
            zoom(1.4, touch.clientX, touch.clientY);
            touchState.lastTapTime = 0;
        } else {
            touchState.lastTapTime = now;
        }

    } else if (e.touches.length === 2) {
        viewState.isDragging = false;
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        touchState.initialDistance = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        touchState.initialScale = viewState.scale;
        touchState.lastMidpoint = {
            x: (t1.clientX + t2.clientX) / 2,
            y: (t1.clientY + t2.clientY) / 2
        };
    }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
    // Empêche le défilement et le rafraîchissement natif de la page lors du geste
    e.preventDefault();

    if (e.touches.length === 1 && viewState.isDragging) {
        const touch = e.touches[0];
        viewState.offsetX = touch.clientX - viewState.startX;
        viewState.offsetY = touch.clientY - viewState.startY;
        draw();

    } else if (e.touches.length === 2 && touchState.initialDistance > 0) {
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const currentDistance = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        const currentMidpoint = {
            x: (t1.clientX + t2.clientX) / 2,
            y: (t1.clientY + t2.clientY) / 2
        };

        if (currentDistance > 10 && touchState.initialDistance > 10) {
            const ratio = currentDistance / touchState.initialDistance;
            const newScale = Math.max(0.0001, touchState.initialScale * ratio);
            const scaleFactor = newScale / viewState.scale;

            const rect = canvas.getBoundingClientRect();
            const midX = currentMidpoint.x - rect.left;
            const midY = currentMidpoint.y - rect.top;
            const centerX = canvasContainer.clientWidth / 2;
            const centerY = canvasContainer.clientHeight / 2;

            // Zoom centré sur le point médian entre les deux doigts
            viewState.offsetX = midX - centerX - (midX - centerX - viewState.offsetX) * scaleFactor;
            viewState.offsetY = midY - centerY - (midY - centerY - viewState.offsetY) * scaleFactor;
            viewState.scale = newScale;
            if (scaleFactor < 1) maybeReturnToMap();

            // Déplacement simultané si les deux doigts glissent
            if (touchState.lastMidpoint) {
                viewState.offsetX += (currentMidpoint.x - touchState.lastMidpoint.x);
                viewState.offsetY += (currentMidpoint.y - touchState.lastMidpoint.y);
            }
            touchState.lastMidpoint = currentMidpoint;

            draw();
        }
    }
}, { passive: false });

canvas.addEventListener('touchend', (e) => {
    if (e.touches.length === 0) {
        viewState.isDragging = false;
        touchState.initialDistance = 0;
        touchState.lastMidpoint = null;
    } else if (e.touches.length === 1) {
        // Passage fluide de 2 doigts à 1 doigt
        const touch = e.touches[0];
        viewState.isDragging = true;
        viewState.startX = touch.clientX - viewState.offsetX;
        viewState.startY = touch.clientY - viewState.offsetY;
        touchState.initialDistance = 0;
        touchState.lastMidpoint = null;
    }
});

canvas.addEventListener('touchcancel', () => {
    viewState.isDragging = false;
    touchState.initialDistance = 0;
    touchState.lastMidpoint = null;
});

// ========================================================
// CARTE DU VOL : route réellement suivie (positions ADS-B)
// Fond de carte vectoriel Natural Earth dessiné ici : ni tuiles, ni clé, ni bibliothèque.
// Projection Mercator ; coordonnées du monde = (longitude, -mercY(latitude)) en degrés.
// ========================================================
const mapCanvas = document.getElementById('mapCanvas');
const mctx = mapCanvas.getContext('2d');
const MAP_MAX_LAT = 84;
const MAP_MAX_SCALE = 1500;     // pixels par degré (~75 m par pixel : on peut s'approcher d'un aéroport)
const MAP_GAP_S = 1200;         // au-delà de 20 min sans position, le tracé est interpolé (pointillé)
const MAP_THEMES = {
    dark: {
        sea: '#0f1521', land: '#2b3649', coast: '#5a6d8a', border: 'rgba(148, 163, 184, 0.30)',
        grid: 'rgba(255, 255, 255, 0.05)', halo: '#2b3649', edge: '#0b1220', route: '#a78bfa', routeSoft: 'rgba(167, 139, 250, 0.75)',
        direct: '#64748b', casing: 'rgba(13, 19, 34, 0.85)', plane: '#c4b5fd',
        capitalText: 'rgba(226, 232, 240, 0.72)', capitalDot: 'rgba(226, 232, 240, 0.55)',
        apLarge: '#facc15', apLargeText: '#fde68a', apMedium: 'rgba(250, 204, 21, 0.45)', apMediumText: 'rgba(254, 243, 199, 0.62)',
        labelBg: 'rgba(13, 19, 34, 0.75)', chipBg: 'rgba(15, 23, 42, 0.92)', chipText: '#f8fafc', planeGlow: 'rgba(167, 139, 250, 0.65)',
        legendDot: '#cbd5e1', legendDotMedium: 'rgba(203, 213, 225, 0.55)'
    },
    light: {
        sea: '#d6e4f1', land: '#f7f8fa', coast: '#9db3c9', border: 'rgba(100, 116, 139, 0.38)',
        grid: 'rgba(15, 23, 42, 0.06)', halo: '#d6e4f1', edge: '#d6e4f1', route: '#7c3aed', routeSoft: 'rgba(124, 58, 237, 0.75)',
        direct: '#64748b', casing: 'rgba(255, 255, 255, 0.9)', plane: '#6d28d9',
        capitalText: 'rgba(30, 41, 59, 0.75)', capitalDot: 'rgba(30, 41, 59, 0.55)',
        apLarge: '#475569', apLargeText: '#1e293b', apMedium: 'rgba(71, 85, 105, 0.5)', apMediumText: 'rgba(51, 65, 85, 0.8)',
        labelBg: 'rgba(255, 255, 255, 0.82)', chipBg: 'rgba(255, 255, 255, 0.95)', chipText: '#0f172a', planeGlow: 'rgba(124, 58, 237, 0.45)',
        legendDot: '#334155', legendDotMedium: 'rgba(51, 65, 85, 0.5)'
    }
};
// Styles de carte : « standard » = palette du thème ; « inversé » échange mer et continents ; « contrasté » accentue l'écart
// mer / terres et renforce côtes et frontières. Le halo et le liseré des points suivent la couleur qu'ils avaient (mer ou terres).
const MAP_STYLE_OVERRIDES = {
    contrast: {
        dark:  { sea: '#070b12', land: '#34425c', coast: '#8b5cf6', coastW: 1.7, border: 'rgba(203, 213, 225, 0.45)' },
        light: { sea: '#bcd3e8', land: '#ffffff', coast: '#5f83a8', border: 'rgba(51, 65, 85, 0.5)' }
    }
};
function mapPalette(t = theme) {
    const base = MAP_THEMES[t];
    const style = mapPrefs.style;
    if (style === 'standard') return { ...base, coastW: 0.9 };
    const p = { ...base, coastW: 0.9 };
    if (style === 'inverted') { p.sea = base.land; p.land = base.sea; }
    else Object.assign(p, MAP_STYLE_OVERRIDES.contrast[t]);
    for (const k of ['halo', 'edge']) {
        if (base[k] === base.sea) p[k] = p.sea; else if (base[k] === base.land) p[k] = p.land;
    }
    return p;
}
const MAP_COLORS = mapPalette(theme);
const PLANE_PATH = new Path2D('M12 1.5 L13.6 8.5 L22 13.5 L22 15.5 L13.6 12.8 L13.2 19 L16 21 L16 22.5 L12 21.5 L8 22.5 L8 21 L10.8 19 L10.4 12.8 L2 15.5 L2 13.5 L10.4 8.5 Z');

let viewMode = 'diagram';        // 'diagram' (schéma de pistes) | 'map' (carte du vol)
const flightMap = {
    world: null, worldPromise: null,   // fonds de carte : { land, borders } (Path2D)
    cx: 0, cy: 0, scale: 3,            // centre de la vue (monde) et pixels par degré
    flight: null, dep: null, arr: null, track: null, route: null,
    notice: '', loadedAt: 0, seq: 0, timer: null, needsFit: false, raf: 0, hits: [],
    overflown: [], overflownSeq: 0      // grands aéroports survolés (bande de ±100 nm)
};

function mercY(lat) {
    const p = Math.max(-MAP_MAX_LAT, Math.min(MAP_MAX_LAT, lat)) * Math.PI / 180;
    return Math.log(Math.tan(Math.PI / 4 + p / 2)) * 180 / Math.PI;
}
const mapY = lat => -mercY(lat);
const unwrapLon = (lon, ref) => lon + 360 * Math.round((ref - lon) / 360);

// Grand cercle échantillonné ; la longitude reste continue (peut dépasser ±180) à partir de lon1
function greatCircle(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180;
    const [la1, lo1, la2, lo2] = [lat1 * r, lon1 * r, lat2 * r, lon2 * r];
    const d = 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
    if (!d) return [[lat1, lon1], [lat2, unwrapLon(lon2, lon1)]];
    const steps = Math.max(8, Math.min(120, Math.ceil(d / r / 2)));
    const out = [[lat1, lon1]];
    let prev = lon1;
    for (let i = 1; i <= steps; i++) {
        const f = i / steps, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
        const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
        const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
        const z = A * Math.sin(la1) + B * Math.sin(la2);
        const lon = unwrapLon(Math.atan2(y, x) / r, prev);
        prev = lon;
        out.push([Math.atan2(z, Math.hypot(x, y)) / r, lon]);
    }
    return out;
}

function bearingDeg(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180, dl = (lon2 - lon1) * r;
    const y = Math.sin(dl) * Math.cos(lat2 * r);
    const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dl);
    return (Math.atan2(y, x) / r + 360) % 360;
}

// Charge une seule fois le fond de carte (data/world.json) et le convertit en Path2D
function loadWorld() {
    if (!flightMap.worldPromise) {
        // Version dans l'URL : à changer à chaque régénération de world.json (évite l'ancien fichier en cache)
        flightMap.worldPromise = fetch('./data/world.json?v=3-evitement')
            .then(res => { if (!res.ok) throw new Error('Fond de carte indisponible'); return res.json(); })
            .then(w => {
                const u = w.unit, land = new Path2D(), borders = new Path2D();
                const add = (path, a, close) => {
                    let x = a[0], y = a[1];
                    path.moveTo(x * u, mapY(y * u));
                    for (let i = 2; i < a.length; i += 2) {
                        x += a[i]; y += a[i + 1];
                        path.lineTo(x * u, mapY(y * u));
                    }
                    if (close) path.closePath();
                };
                w.land.forEach(r => add(land, r, true));
                w.borders.forEach(b => add(borders, b, false));
                flightMap.world = { land, borders, capitals: w.capitals || [] };
                if (w.avoid && w.avoid.vis) { flightMap.avoid = new AirspaceRouter(w.avoid); planCache.clear(); }
                loadConflictZones();   // couches facultatives : leur absence ne bloque pas la carte
                loadAirspaceIndex().then(scheduleMapDraw);
            })
            .catch(err => { flightMap.worldPromise = null; throw err; });
    }
    return flightMap.worldPromise;
}

// --- Zones de conflit : bulletins EASA (CZIB), FIR concernées -------------------------------
// data/conflict_zones.json est produit chaque nuit par scripts/build_conflict_zones.py (parsing des bulletins).
const CONFLICT_STYLES = {
    high:    { fill: 'rgba(239, 68, 68, 0.22)',  stroke: 'rgba(239, 68, 68, 0.9)',  label: 'Zone de conflit : ne pas opérer (EASA)' },
    caution: { fill: 'rgba(245, 158, 11, 0.20)', stroke: 'rgba(245, 158, 11, 0.9)', label: 'Zone de conflit : prudence (EASA)' }
};
let conflictPromise = null;
function loadConflictZones() {
    if (!conflictPromise) {
        conflictPromise = fetch('./data/conflict_zones.json', { cache: 'no-cache' })
            .then(res => { if (!res.ok) throw new Error('Zones de conflit indisponibles'); return res.json(); })
            .then(d => {
                const u = d.unit || 0.01;
                const decode = a => {
                    const pts = [];
                    let x = a[0], y = a[1];
                    pts.push([x * u, y * u]);
                    for (let i = 2; i < a.length; i += 2) { x += a[i]; y += a[i + 1]; pts.push([x * u, y * u]); }
                    return pts;
                };
                const paths = { high: new Path2D(), caution: new Path2D() };
                const zones = d.zones.filter(z => (z.firs.length || (z.rings && z.rings.length)) && paths[z.level]).map(z => {
                    const rings = (z.rings || z.firs.flatMap(c => d.firs[c] || [])).map(decode);   // z.rings : FIR découpées par le bulletin
                    rings.forEach(pts => {
                        pts.forEach(([lon, lat], i) => paths[z.level][i ? 'lineTo' : 'moveTo'](lon, mapY(lat)));
                        paths[z.level].closePath();
                    });
                    return { ...z, rings };
                });
                flightMap.conflict = { zones, paths, updated: d.updated };
                scheduleMapDraw();
                if (flightMap.flight) updateMapOverlay();
            })
            .catch(() => { /* couche absente : la carte reste utilisable */ });
    }
    return conflictPromise;
}

// --- Espaces aériens OpenAIP (tuiles 5° x 5° produites par scripts/build_airspaces.py) -----------
// Couche facultative : sans data/airspaces/index.json (pas de clé OpenAIP au dernier build), elle reste muette.
const AIRSPACE_MIN_SCALE = 30;   // pixels par degré : en dessous, trop d'espaces aériens pour être lisibles
const AIRSPACE_STYLES = {
    3:  { fill: 'rgba(244, 63, 94, 0.22)',  stroke: 'rgba(244, 63, 94, 0.95)',  label: 'Zone interdite (P)' },
    1:  { fill: 'rgba(251, 146, 60, 0.20)', stroke: 'rgba(251, 146, 60, 0.95)', label: 'Zone réglementée (R)' },
    2:  { fill: 'rgba(250, 204, 21, 0.16)', stroke: 'rgba(250, 204, 21, 0.95)', label: 'Zone dangereuse (D)' },
    4:  { fill: 'rgba(34, 211, 238, 0.14)', stroke: 'rgba(34, 211, 238, 0.9)',  label: 'CTR' },
    7:  { fill: 'rgba(99, 102, 241, 0.12)', stroke: 'rgba(129, 140, 248, 0.85)', label: 'TMA' },
    26: { fill: 'rgba(163, 230, 53, 0.08)', stroke: 'rgba(163, 230, 53, 0.75)', label: 'CTA' },
    12: { fill: 'rgba(148, 163, 184, 0.08)', stroke: 'rgba(148, 163, 184, 0.8)', label: 'ADIZ' }
};
// Ordre et libellés courts des filtres (réglages de la carte) ; classes OACI filtrables
const AIRSPACE_TYPE_ORDER = [[3, 'P'], [1, 'R'], [2, 'D'], [4, 'CTR'], [7, 'TMA'], [26, 'CTA'], [12, 'ADIZ']];
const AIRSPACE_CLASSES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
// Un espace aérien est montré si son type est coché et, s'il a une classe OACI, si cette classe l'est aussi
const airspaceShown = (t, c) => mapPrefs.aspTypes.includes(+t) && (!c || mapPrefs.aspClasses.includes(c));
const airspaces = { index: undefined, tiles: new Map(), loading: new Set(), fetching: null };

function loadAirspaceIndex() {
    if (!airspaces.fetching) {
        airspaces.fetching = fetch('./data/airspaces/index.json', { cache: 'no-cache' })
            .then(res => res.ok ? res.json() : null)
            .then(idx => { airspaces.index = idx; document.getElementById('mapAirspacesRow').hidden = !idx; if (idx) buildAirspaceFilters(); syncMapSettings(); })
            .catch(() => { airspaces.index = null; });
    }
    return airspaces.fetching;
}

function loadAirspaceTile(key) {
    if (airspaces.tiles.has(key) || airspaces.loading.has(key)) return;
    airspaces.loading.add(key);
    fetch(`./data/airspaces/${key}.json`)
        .then(res => res.ok ? res.json() : [])
        .catch(() => [])
        .then(list => {
            const u = airspaces.index.unit || 0.01;
            const paths = {};
            const items = list.map(a => {
                const pts = [];
                let x = a.g[0], y = a.g[1];
                pts.push([x * u, y * u]);
                for (let i = 2; i < a.g.length; i += 2) { x += a.g[i]; y += a.g[i + 1]; pts.push([x * u, y * u]); }
                const pk = `${a.t}|${a.c || ''}`;
                const path = paths[pk] || (paths[pk] = new Path2D());
                pts.forEach(([lon, lat], i) => path[i ? 'lineTo' : 'moveTo'](lon, mapY(lat)));
                path.closePath();
                return { ...a, pts };
            });
            airspaces.loading.delete(key);
            airspaces.tiles.set(key, { paths, items });
            scheduleMapDraw();
        });
}

// Clés des tuiles non vides qui touchent [lonMin, lonMax] x [latMin, latMax] (longitudes dans [-180, 180])
function airspaceTileKeys(lonMin, lonMax, latMin, latMax) {
    const idx = airspaces.index;
    if (!idx) return [];
    const T = idx.tile, keys = [];
    for (let x = Math.floor(Math.max(-180, lonMin) / T) * T; x <= Math.min(179.99, lonMax); x += T) {
        for (let y = Math.floor(Math.max(-90, latMin) / T) * T; y <= Math.min(89.99, latMax); y += T) {
            const k = `${x}_${y}`;
            if (idx.tiles[k]) keys.push(k);
        }
    }
    return keys;
}

const latOfWorldY = wy => Math.atan(Math.sinh(-wy * Math.PI / 180)) * 180 / Math.PI;

// Espaces aériens chargés contenant le point (lon, lat)
function airspacesAt(lon, lat) {
    const out = [];
    const lo = ((lon + 180) % 360 + 360) % 360 - 180;
    for (const t of airspaces.tiles.values()) {
        for (const a of t.items) {
            let inside = false;
            const pts = a.pts;
            for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
                const [xi, yi] = pts[i], [xj, yj] = pts[j];
                if ((yi > lat) !== (yj > lat) && lo < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
            }
            if (inside) out.push(a);
        }
    }
    return out;
}

// Zones contenant le point (lon, lat) ; longitude ramenée près de chaque copie du contour
function conflictZonesAt(lon, lat) {
    const c = flightMap.conflict;
    if (!c) return [];
    return c.zones.filter(z => z.rings.some(pts => {
        const x0 = pts[0][0], lo = lon + 360 * Math.round((x0 - lon) / 360);
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const [xi, yi] = pts[i], [xj, yj] = pts[j];
            if ((yi > lat) !== (yj > lat) && lo < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }));
}

async function getAirportData(icao) {
    if (!icao) return null;
    const code = icao.toUpperCase();
    let data = airportCache.get(code);
    if (!data) {
        try {
            const res = await fetch(`./data/airports/${code}.json`);
            if (!res.ok) return null;
            data = await res.json();
            airportCache.set(code, data);
        } catch (err) {
            return null;
        }
    }
    return data;
}

// Trajectoire du vol en cours via le worker (ADS-B). Ne lève jamais d'exception.
async function loadFlightTrack(f) {
    const notices = {
        scheduled: 'Vol pas encore parti : route estimée',
        landed: 'Vol atterri : route estimée',
        cancelled: 'Vol annulé : route estimée'
    };
    if (f.status !== 'en-route') return { data: null, notice: notices[f.status] || 'Vol non suivi : route estimée' };
    // La fiche AirLabs (/flight) d'un vol en cours contient déjà sa position : aucun appel de plus
    if (typeof f.lat === 'number' && typeof f.lng === 'number') {
        const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        return {
            data: {
                callsign: f.flight_icao || f.flight_iata, hex: f.hex || null, reg: f.reg_number || null, type: f.aircraft_icao || null,
                now: {
                    lat: f.lat, lon: f.lng,
                    alt: num(f.alt) === null ? null : Math.round(f.alt * 3.28084),       // m -> ft
                    gs: num(f.speed) === null ? null : Math.round(f.speed * 0.539957),   // km/h -> kt
                    track: num(f.dir) === null ? null : Math.round(f.dir),
                    vs: null,
                    ts: num(f.updated) || Math.round(Date.now() / 1000)
                },
                track: [], source: f.demo ? 'demo' : 'airlabs'
            },
            notice: ''
        };
    }
    const callsign = (f.flight_icao || `${f.airline_icao || ''}${f.flight_number || ''}`).toUpperCase();
    if (!/^[A-Z0-9]{3,8}$/.test(callsign)) return { data: null, notice: 'Vol non suivi : route estimée' };
    try {
        const data = await callFlightApi(`/track?callsign=${encodeURIComponent(callsign)}`);
        return data ? { data, notice: '' } : { data: null, notice: 'Position actuelle indisponible : route estimée' };
    } catch (err) {
        return { data: null, notice: `${err.message} : route estimée` };
    }
}

// Étiquette d'aéroport sur la carte : « Boston - BOS » (ville, sinon nom ; code IATA, sinon OACI)
function mapAirportLabel(ap, fallbackCode) {
    if (!ap) return fallbackCode;
    const code = airportCode(ap) || fallbackCode;
    const place = ap.municipality && ap.municipality !== 'N/A' ? ap.municipality : ap.name;
    return place ? `${place.split(/[,(]/)[0].trim()} - ${code}` : code;
}

// ========================================================
// ESPACES AÉRIENS À ÉVITER : Russie, Ukraine, Bélarus (zones dans world.json, clé « avoid »)
// Plus court chemin autour de ces zones sur la sphère (graphe de visibilité entre les coins des zones ;
// la matrice de visibilité des coins est précalculée par scripts/airspace.py). Même algorithme que
// le simulateur local (scripts/airspace.py), qui sert aussi à le tester contre les contours complets.
// ========================================================

// Route estimée dep -> arr ([lat, lon]) : couloir éventuel, puis contournement des zones tronçon par tronçon
const planCache = new Map();
function planFlightPath(dep, arr, corridors = true) {
    const key = `${dep}|${arr}|${corridors}|${flightMap.avoid ? 1 : 0}`;
    if (planCache.has(key)) return planCache.get(key);
    const pts = [dep, ...(corridors ? corridorWaypoints(dep, arr) : []), arr];
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
        const leg = flightMap.avoid ? flightMap.avoid.route(pts[i - 1], pts[i]) : [pts[i - 1], pts[i]];
        out.push(...leg.slice(1));
    }
    planCache.set(key, out);
    return out;
}

// --- Géométrie d'une route (suite de points [lat, lon] reliés par des arcs de grand cercle) ---
const asLL = p => ({ lat: p[0], lon: p[1] });
const pathLens = path => path.slice(1).map((p, i) => gcDist(asLL(path[i]), asLL(p)));
const pathTotal = path => pathLens(path).reduce((a, b) => a + b, 0);

function pointAtFraction(a, b, len, f) {
    if (!len) return [a[0], a[1]];
    const p = gcInterpolate(asLL(a), asLL(b), len, f);
    return [p.lat, p.lon];
}

// Point à la distance s (radians) le long de la route, avec le cap
function pointOnPath(path, s) {
    const lens = pathLens(path);
    let acc = 0;
    for (let i = 0; i < lens.length; i++) {
        if (s <= acc + lens[i] || i === lens.length - 1) {
            const f = lens[i] ? Math.min(1, Math.max(0, (s - acc) / lens[i])) : 0;
            const p = pointAtFraction(path[i], path[i + 1], lens[i], f);
            const q = f < 0.995 ? pointAtFraction(path[i], path[i + 1], lens[i], Math.min(1, f + 0.005)) : path[i + 1];
            const from = f < 0.995 ? p : pointAtFraction(path[i], path[i + 1], lens[i], Math.max(0, f - 0.005));
            return { lat: p[0], lon: p[1], heading: bearingDeg(from[0], from[1], q[0], q[1]) };
        }
        acc += lens[i];
    }
    return { lat: path[0][0], lon: path[0][1], heading: 0 };
}

// Projection d'un point sur la route : abscisse s (radians) et écart (radians) à la route
function projectOnPath(path, p) {
    const lens = pathLens(path);
    let acc = 0, best = { s: 0, dist: Infinity };
    for (let i = 0; i < lens.length; i++) {
        const a = asLL(path[i]), b = asLL(path[i + 1]), d13 = gcDist(a, p);
        let dist, at;
        if (!lens[i]) { dist = d13; at = 0; } else {
            const dt = gcBearing(a, p) - gcBearing(a, b);
            const xt = Math.asin(Math.max(-1, Math.min(1, Math.sin(d13) * Math.sin(dt))));
            at = Math.acos(Math.max(-1, Math.min(1, Math.cos(d13) / Math.cos(xt))));
            if (Math.cos(dt) < 0) at = -at;
            dist = at >= 0 && at <= lens[i] ? Math.abs(xt) : Math.min(d13, gcDist(b, p));
            at = Math.max(0, Math.min(lens[i], at));
        }
        if (dist < best.dist) best = { s: acc + at, dist };
        acc += lens[i];
    }
    return best;
}

// Morceau de la route entre les abscisses s0 et s1 (radians), extrémités interpolées
function pathSlice(path, s0, s1) {
    const lens = pathLens(path), out = [];
    const push = p => { const l = out[out.length - 1]; if (!l || l[0] !== p[0] || l[1] !== p[1]) out.push(p); };
    let acc = 0;
    for (let i = 0; i < lens.length; i++) {
        const L = lens[i];
        if (acc + L >= s0 && acc <= s1) {
            push(pointAtFraction(path[i], path[i + 1], L, L ? Math.max(0, (s0 - acc) / L) : 0));
            push(pointAtFraction(path[i], path[i + 1], L, L ? Math.min(1, (s1 - acc) / L) : 1));
        }
        acc += L;
    }
    if (out.length < 2) { const q = pointOnPath(path, s0); return [[q.lat, q.lon], [q.lat, q.lon]]; }
    return out;
}

// Points denses (arcs de grand cercle) d'une route, longitudes continues
function denseArcs(pts) {
    const out = [[pts[0][0], pts[0][1]]];
    let lon = pts[0][1];
    for (let i = 1; i < pts.length; i++) {
        const arc = greatCircle(pts[i - 1][0], lon, pts[i][0], pts[i][1]);
        arc.slice(1).forEach(q => out.push(q));
        lon = arc[arc.length - 1][1];
    }
    return out;
}

// Plan d'un vol : route estimée dep -> arr et position de l'avion (abscisse s) sur cette route.
// Position proche de la route (< 60 nm) : calée dessus ; sinon la route passe par la position réelle.
const ROUTE_SNAP_NM = 60;
function planForFlight(dep, arr, fix) {
    const D = [dep.lat, dep.lon], A = [arr.lat, arr.lon];
    let path = planFlightPath(D, A), s = 0;
    if (fix) {
        const pr = projectOnPath(path, fix);
        if (pr.dist * EARTH_NM <= ROUTE_SNAP_NM) {
            s = pr.s;
        } else {
            const first = planFlightPath(D, [fix.lat, fix.lon], false);
            path = first.concat(planFlightPath([fix.lat, fix.lon], A, false).slice(1));
            s = pathTotal(first);
        }
    }
    return { path, s, total: pathTotal(path) };
}

// Géométrie de la route (chemins en coordonnées du monde) à partir de la trajectoire et des aéroports
function buildFlightRoute() {
    const { track: t, dep, arr, flight: f } = flightMap;
    const route = {
        solid: new Path2D(), dashed: new Path2D(), remaining: new Path2D(), direct: new Path2D(), flownEst: new Path2D(),
        hasTrack: false, hasGap: false, hasRemaining: false, hasPosition: false,
        plane: null, dep: null, arr: null, points: []
    };
    const depLabel = mapAirportLabel(dep, (f.dep_iata || f.dep_icao || '').toUpperCase());
    const arrLabel = mapAirportLabel(arr, (f.arr_iata || f.arr_icao || '').toUpperCase());
    const draw = (path, pts) => pts.forEach(([lat, lon], i) => {
        const y = mapY(lat);
        if (i === 0) path.moveTo(lon, y); else path.lineTo(lon, y);
        route.points.push([lon, y]);
    });

    if (t && Array.isArray(t.track) && t.track.length >= 2) {
        route.hasTrack = true;
        let prev = t.track[0][1];
        const pts = t.track.map((p, i) => {
            const lon = i ? unwrapLon(p[1], prev) : p[1];
            prev = lon;
            return { lat: p[0], lon, ts: p[3] };
        });
        route.solid.moveTo(pts[0].lon, mapY(pts[0].lat));
        route.points.push([pts[0].lon, mapY(pts[0].lat)]);
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1], b = pts[i];
            if (b.ts - a.ts > MAP_GAP_S) {
                // Aucune réception (océan) : arc de grand cercle en pointillé
                route.hasGap = true;
                draw(route.dashed, greatCircle(a.lat, a.lon, b.lat, b.lon));
                route.solid.moveTo(b.lon, mapY(b.lat));
            } else {
                route.solid.lineTo(b.lon, mapY(b.lat));
            }
            route.points.push([b.lon, mapY(b.lat)]);
        }
        const last = pts[pts.length - 1], now = t.now || {};
        const lat = now.lat ?? last.lat;
        const lon = unwrapLon(now.lon ?? last.lon, last.lon);
        const before = pts[pts.length - 2];
        route.plane = {
            lat, lon,
            heading: now.track ?? bearingDeg(before.lat, before.lon, last.lat, last.lon)
        };
        route.points.push([lon, mapY(lat)]);
        if (dep) route.dep = { lat: dep.lat, lon: unwrapLon(dep.lon, pts[0].lon), label: depLabel, icao: dep.ident };
        if (arr) {
            const arc = greatCircle(lat, lon, arr.lat, arr.lon);
            draw(route.remaining, arc);
            route.hasRemaining = true;
            route.arr = { lat: arr.lat, lon: arc[arc.length - 1][1], label: arrLabel, icao: arr.ident };
        }
    } else if (t && t.now && typeof t.now.lat === 'number' && dep && arr) {
        // Position de l'avion sans historique : parcouru et reste estimés sur la route qui contourne
        // les espaces aériens interdits (couloir ou plus court chemin)
        route.hasPosition = true;
        if (!flightMap.plan) {
            flightMap.plan = planForFlight(dep, arr, { lat: t.now.lat, lon: t.now.lon });
            flightMap.planS = flightMap.plan.s;
        }
        const plan = flightMap.plan, sNow = Math.min(plan.total, flightMap.planS ?? plan.s);
        draw(route.flownEst, denseArcs(pathSlice(plan.path, 0, sNow)));
        const rest = denseArcs(pathSlice(plan.path, sNow, plan.total));
        draw(route.remaining, rest);
        route.hasRemaining = true;
        const at = pointOnPath(plan.path, sNow);
        route.plane = { lat: at.lat, lon: at.lon, heading: at.heading };
        route.dep = { lat: dep.lat, lon: dep.lon, label: depLabel, icao: dep.ident };
        route.arr = { lat: arr.lat, lon: rest[rest.length - 1][1], label: arrLabel, icao: arr.ident };
        route.path = plan.path;
    } else if (t && t.now && typeof t.now.lat === 'number' && dep) {
        // Position réelle sans aéroport d'arrivée connu : parcouru en grand cercle
        route.hasPosition = true;
        const flown = greatCircle(dep.lat, dep.lon, t.now.lat, t.now.lon);
        draw(route.flownEst, flown);
        const plane = flown[flown.length - 1];
        const before = flown[Math.max(0, flown.length - 2)];
        route.plane = {
            lat: plane[0], lon: plane[1],
            heading: t.now.track ?? bearingDeg(before[0], before[1], plane[0], plane[1])
        };
        route.dep = { lat: dep.lat, lon: dep.lon, label: depLabel, icao: dep.ident };
    } else if (dep && arr) {
        // Pas de position : route estimée (couloir ou plus court chemin autour des espaces interdits)
        const path = planFlightPath([dep.lat, dep.lon], [arr.lat, arr.lon]);
        const arc = denseArcs(path);
        draw(route.direct, arc);
        route.dep = { lat: dep.lat, lon: dep.lon, label: depLabel, icao: dep.ident };
        route.arr = { lat: arr.lat, lon: arc[arc.length - 1][1], label: arrLabel, icao: arr.ident };
        route.path = path;
    }
    return route;
}

// --- Vue : cadrage, zoom, déplacement ---------------------------------
const mapMinScale = () => Math.max(1, mapCanvas.clientWidth / 540);
const clampMapScale = s => Math.min(MAP_MAX_SCALE, Math.max(mapMinScale(), s));

function clampMapCenter() {
    const maxY = -mapY(MAP_MAX_LAT) - 2;
    const half = (mapCanvas.clientHeight / 2) / flightMap.scale;
    const lim = Math.max(0, maxY - half);
    flightMap.cy = Math.max(-lim, Math.min(lim, flightMap.cy));
}

function fitFlightMap() {
    const w = mapCanvas.clientWidth, h = mapCanvas.clientHeight;
    if (!w || !h) { flightMap.needsFit = true; return; }
    flightMap.needsFit = false;
    // Cadrage sur la trajectoire seule (route, départ, arrivée, avion), centrée : les aéroports
    // le long de la route n'y entrent pas (un dégagement lointain comme Keflavik peut sortir du cadre)
    const pts = flightMap.route ? flightMap.route.points.slice() : [];
    flightMap.userMoved = false;
    if (!pts.length) {
        flightMap.cx = 0;
        flightMap.cy = mapY(25);
        flightMap.scale = clampMapScale(w / 330);
    } else {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        pts.forEach(([x, y]) => {
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        });
        // Marges de départ : étiquettes d'aéroport à droite des points, boutons de zoom à droite
        let pads = {
            L: Math.min(Math.max(w * 0.06, 40), w * 0.2),
            R: Math.min(Math.max(w * 0.06, 40) + 70, w * 0.3),
            T: Math.min(Math.max(h * 0.08, 50), h * 0.25),
            B: Math.min(Math.max(h * 0.08, 50), h * 0.25)
        };
        const apply = pd => {
            const scale = clampMapScale(Math.min((w - pd.L - pd.R) / Math.max(maxX - minX, 3), (h - pd.T - pd.B) / Math.max(maxY - minY, 3)));
            // Centre la route dans la zone libre plutôt que dans tout le canvas
            return { scale, cx: (minX + maxX) / 2 - ((pd.L - pd.R) / 2) / scale, cy: (minY + maxY) / 2 - ((pd.T - pd.B) / 2) / scale };
        };

        // Éléments posés sur la carte (légende, réglages, résumé, boutons) : rien d'important dessous.
        // Si un point de la route, un aéroport ou l'étiquette départ/arrivée tombe sous l'un d'eux, on
        // élargit la marge de ce côté (verticale ou horizontale, celle qui garde le plus grand zoom).
        const obstacles = mapObstacles();
        const boxes = mapFitBoxes(pts);
        let view = apply(pads);
        for (let iter = 0; iter < 20 && obstacles.length; iter++) {
            const hit = mapFirstOverlap(boxes, obstacles, view, w, h);
            if (!hit) break;
            const { box, ob } = hit;
            // Étendue de l'élément masqué autour de son point, pour que la marge le dégage entièrement
            const m = 12;
            const vertical = { ...pads }, horizontal = { ...pads };
            if (ob.y + ob.h / 2 > h / 2) vertical.B = Math.max(pads.B, h - ob.y + m + box.b);
            else vertical.T = Math.max(pads.T, ob.y + ob.h + m + box.t);
            if (ob.x + ob.w / 2 < w / 2) horizontal.L = Math.max(pads.L, ob.x + ob.w + m + box.l);
            else horizontal.R = Math.max(pads.R, w - ob.x + m + box.r);
            const usable = pd => pd.L + pd.R < w * 0.85 && pd.T + pd.B < h * 0.85;
            const frees = v => !mapFirstOverlap([box], [ob], v, w, h);
            const cands = [vertical, horizontal].filter(usable).map(pd => ({ pd, v: apply(pd) }));
            // De préférence une marge qui dégage vraiment cet élément, puis celle qui garde le plus grand zoom
            cands.sort((a, b) => (frees(b.v) - frees(a.v)) || (b.v.scale - a.v.scale));
            if (!cands.length) break;
            pads = cands[0].pd;
            view = cands[0].v;
        }
        flightMap.scale = view.scale;
        flightMap.cx = view.cx;
        flightMap.cy = view.cy;
    }
    clampMapCenter();
    scheduleMapDraw();
}

// Rectangles (pixels du canvas) des éléments visibles posés sur la carte
function mapObstacles() {
    const base = mapCanvas.getBoundingClientRect();
    return ['#mapLegend', '#mapSettings', '#mapHud', '#mapLargeBtn', '#mapNotice', '#viewToggle', '#shortRwyBtn', '.canvas-top-actions', '.controls-overlay', '#fullscreenHeader']
        .map(sel => document.querySelector(sel))
        .filter(el => el && !el.hidden && el.offsetParent !== null && getComputedStyle(el).display !== 'none')
        .map(el => {
            const r = el.getBoundingClientRect();
            return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
        })
        .filter(r => r.w > 0 && r.h > 0);
}

// Ce qui doit rester visible, en coordonnées du monde avec une taille en pixels :
// points de la route et aéroports (petit carré), avion, étiquettes départ/arrivée (à droite du point)
function mapFitBoxes(pts) {
    const boxes = pts.map(([x, y]) => ({ x, y, l: 4, r: 4, t: 4, b: 4 }));
    const route = flightMap.route;
    if (route) {
        mctx.font = 'bold 11px sans-serif';
        [route.dep, route.arr].forEach(m => {
            if (!m) return;
            boxes.push({ x: m.lon, y: mapY(m.lat), l: 6, r: 9 + mctx.measureText(m.label).width + 16, t: 12, b: 12 });
        });
        if (route.plane) boxes.push({ x: route.plane.lon, y: mapY(route.plane.lat), l: 18, r: 18, t: 18, b: 18 });
    }
    return boxes;
}

function mapFirstOverlap(boxes, obstacles, view, w, h) {
    const m = 6;
    for (const bx of boxes) {
        const px = w / 2 + (bx.x - view.cx) * view.scale, py = h / 2 + (bx.y - view.cy) * view.scale;
        const x1 = px - bx.l, x2 = px + bx.r, y1 = py - bx.t, y2 = py + bx.b;
        const ob = obstacles.find(o => x1 < o.x + o.w + m && x2 > o.x - m && y1 < o.y + o.h + m && y2 > o.y - m);
        if (ob) return { box: bx, ob };
    }
    return null;
}

function mapZoomAt(factor, px, py) {
    const w = mapCanvas.clientWidth, h = mapCanvas.clientHeight;
    const s = flightMap.scale, next = clampMapScale(s * factor);
    // Zoom fort près d'un aéroport de la carte : on passe à son diagramme
    if (factor > 1 && next >= MAP_TO_DIAGRAM_SCALE && enterDiagramFromMapAt(px, py)) return;
    if (next === s) return;
    const wx = flightMap.cx + (px - w / 2) / s, wy = flightMap.cy + (py - h / 2) / s;
    flightMap.scale = next;
    flightMap.cx = wx - (px - w / 2) / next;
    flightMap.cy = wy - (py - h / 2) / next;
    clampMapCenter();
    scheduleMapDraw();
}

// --- Zoom sémantique : carte <-> diagramme -----------------------------------------
// En zoomant fort sur un aéroport de la carte (départ, arrivée, aéroport le long de la route), on ouvre
// son diagramme ; en dézoomant nettement ce diagramme, on revient à la carte, là où on l'avait laissée.
const MAP_TO_DIAGRAM_SCALE = 600;   // pixels par degré au-delà desquels on bascule
const VIEW_SWITCH_WHEEL_PAUSE_MS = 600;    // molette ignorée juste après la bascule carte -> diagramme
let wheelPausedUntil = 0;
const MAP_PICK_RADIUS = 60;         // distance max (px) entre le point de zoom et l'aéroport
const DIAGRAM_BACK_RATIO = 0.5;     // dézoom du diagramme sous la moitié de son cadrage : retour carte
let zoomReturn = null;              // { icao } : diagramme ouvert par le zoom depuis la carte

function enterDiagramFromMapAt(px, py) {
    const route = flightMap.route;
    if (!route || viewMode !== 'map') return false;
    const w = mapCanvas.clientWidth, h = mapCanvas.clientHeight, s = flightMap.scale;
    const ox = w / 2 - flightMap.cx * s, oy = h / 2 - flightMap.cy * s;
    const candidates = [];
    [route.dep, route.arr].forEach(m => { if (m && m.icao) candidates.push({ icao: m.icao, lat: m.lat, lon: m.lon }); });
    visibleOverflown().forEach(o => candidates.push({ icao: o.ap.ident, lat: o.ap.lat, lon: unwrapLon(o.ap.lon, flightMap.cx) }));
    let best = null;
    candidates.forEach(c => {
        const lon = unwrapLon(c.lon, flightMap.cx);
        const d = Math.hypot(ox + lon * s - px, oy + mapY(c.lat) * s - py);
        if (d <= MAP_PICK_RADIUS && (!best || d < best.d)) best = { ...c, d };
    });
    if (!best) return false;
    zoomReturn = { icao: best.icao };
    wheelPausedUntil = Date.now() + VIEW_SWITCH_WHEEL_PAUSE_MS;   // la suite du geste ne zoome pas le diagramme
    openFlightAirport(best.icao);
    return true;
}

function maybeReturnToMap() {
    if (!zoomReturn || viewMode !== 'diagram' || !currentFlight || zoomReturn.icao !== currentAirportCode) return;
    if (!viewState.fitScale || viewState.scale > viewState.fitScale * DIAGRAM_BACK_RATIO) return;
    const icao = zoomReturn.icao;
    zoomReturn = null;
    showFlightMap(true);
    // Carte centrée sur l'aéroport, juste sous le seuil de bascule (pas de va-et-vient)
    const ap = searchIndexMap.get(icao) || airportCache.get(icao);
    if (ap && typeof ap.lat === 'number') {
        flightMap.userMoved = true;
        flightMap.scale = clampMapScale(MAP_TO_DIAGRAM_SCALE * 0.55);
        flightMap.cx = unwrapLon(ap.lon, flightMap.cx);
        flightMap.cy = mapY(ap.lat);
        clampMapCenter();
        scheduleMapDraw();
    }
}

// Boutons + / - / recentrer, communs au schéma de pistes et à la carte
function viewZoom(factor) {
    if (viewMode === 'map') flightMap.userMoved = true;
    if (viewMode === 'map') mapZoomAt(factor, mapCanvas.clientWidth / 2, mapCanvas.clientHeight / 2);
    else zoom(factor);
}
function viewReset() {
    if (viewMode === 'map') fitFlightMap();
    else resetView();
}

function resizeMapCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvasContainer.clientWidth, h = canvasContainer.clientHeight;
    if (!w || !h) return false;
    const tw = Math.round(w * dpr), th = Math.round(h * dpr);
    let resized = false;
    if (mapCanvas.width !== tw || mapCanvas.height !== th) {
        mapCanvas.width = tw;
        mapCanvas.height = th;
        mapCanvas.style.width = w + 'px';
        mapCanvas.style.height = h + 'px';
        resized = true;
    }
    // Taille changée (fenêtre, plein écran) : recadrer, sauf si l'utilisateur a déplacé la carte
    if (flightMap.needsFit || (resized && !flightMap.userMoved && flightMap.route)) fitFlightMap();
    else scheduleMapDraw();
    return true;
}

// Les panneaux posés sur la carte changent de taille après coup (polices chargées, résumé qui
// apparaît avec la position, légende qui s'allonge) : recadrer pour que la trajectoire reste dégagée
let mapRefitTimer = 0;
function scheduleMapRefit() {
    if (viewMode !== 'map' || flightMap.userMoved || !flightMap.route) return;
    clearTimeout(mapRefitTimer);
    mapRefitTimer = setTimeout(() => {
        if (viewMode === 'map' && !flightMap.userMoved && flightMap.route) fitFlightMap();
    }, 60);
}
if (window.ResizeObserver) {
    const panelObserver = new ResizeObserver(scheduleMapRefit);
    ['mapLegend', 'mapSettings', 'mapHud', 'mapNotice', 'viewToggle'].forEach(id => {
        const el = document.getElementById(id);
        if (el) panelObserver.observe(el);
    });
}
if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleMapRefit);
window.addEventListener('resize', () => { if (viewMode === 'map') resizeMapCanvas(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) applyEstimatedPosition(); });

function scheduleMapDraw() {
    if (flightMap.raf || viewMode !== 'map') return;
    flightMap.raf = requestAnimationFrame(() => { flightMap.raf = 0; drawFlightMap(); });
}

// --- Dessin -----------------------------------------------------------
function pathRoundRect(c, x, y, w, h, r) {
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h);
}

function drawFlightMap() {
    const w = mapCanvas.clientWidth, h = mapCanvas.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    const s = flightMap.scale, route = flightMap.route, world = flightMap.world;
    const ox = w / 2 - flightMap.cx * s, oy = h / 2 - flightMap.cy * s;

    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mctx.fillStyle = MAP_COLORS.sea;
    mctx.fillRect(0, 0, w, h);

    // Copies du monde visibles (la carte se répète en longitude)
    const k0 = Math.floor((flightMap.cx - w / 2 / s + 180) / 360);
    const k1 = Math.floor((flightMap.cx + w / 2 / s + 180) / 360);
    for (let k = k0; k <= k1; k++) {
        mctx.save();
        mctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (ox + k * 360 * s), dpr * oy);
        mctx.lineJoin = 'round';
        mctx.lineCap = 'round';

        // Graticule tous les 30°
        mctx.strokeStyle = MAP_COLORS.grid;
        mctx.lineWidth = 1 / s;
        mctx.beginPath();
        for (let lon = -180; lon <= 180; lon += 30) { mctx.moveTo(lon, mapY(MAP_MAX_LAT)); mctx.lineTo(lon, mapY(-MAP_MAX_LAT)); }
        for (let lat = -60; lat <= 60; lat += 30) { mctx.moveTo(-180, mapY(lat)); mctx.lineTo(180, mapY(lat)); }
        mctx.stroke();

        if (world) {
            mctx.fillStyle = MAP_COLORS.land;
            mctx.fill(world.land, 'evenodd');
            mctx.strokeStyle = MAP_COLORS.border;
            mctx.lineWidth = 0.7 / s;
            mctx.stroke(world.borders);
            mctx.strokeStyle = MAP_COLORS.coast;
            mctx.lineWidth = (MAP_COLORS.coastW || 0.9) / s;
            mctx.stroke(world.land);
        }

        if (mapPrefs.conflict && flightMap.conflict) {
            for (const [level, st] of Object.entries(CONFLICT_STYLES)) {
                // FIR = terres + mer : la mer reçoit un voile léger, les terres le remplissage complet (zone ≈ pays)
                mctx.fillStyle = st.fill;
                mctx.globalAlpha = 0.35;
                mctx.fill(flightMap.conflict.paths[level], 'nonzero');
                mctx.globalAlpha = 1;
                if (world) {
                    mctx.save();
                    mctx.clip(world.land, 'evenodd');
                    mctx.fill(flightMap.conflict.paths[level], 'nonzero');
                    mctx.restore();
                }
                mctx.strokeStyle = st.stroke;
                mctx.lineWidth = 1.2 / s;
                mctx.setLineDash([6 / s, 4 / s]);
                mctx.stroke(flightMap.conflict.paths[level]);
                mctx.setLineDash([]);
            }
        }

        if (mapPrefs.airspaces && airspaces.index && s >= AIRSPACE_MIN_SCALE) {
            // Fenêtre visible, exprimée dans le repère de cette copie du monde
            const lonMin = flightMap.cx - w / 2 / s - k * 360, lonMax = flightMap.cx + w / 2 / s - k * 360;
            const latA = latOfWorldY(flightMap.cy + h / 2 / s), latB = latOfWorldY(flightMap.cy - h / 2 / s);
            mctx.lineWidth = 1 / s;
            for (const key of airspaceTileKeys(lonMin, lonMax, latA, latB)) {
                const tile = airspaces.tiles.get(key);
                if (!tile) { loadAirspaceTile(key); continue; }
                for (const [pk, path] of Object.entries(tile.paths)) {
                    const [type, cls] = pk.split('|');
                    const st = AIRSPACE_STYLES[type];
                    if (!st || !airspaceShown(type, cls)) continue;
                    mctx.fillStyle = st.fill;
                    mctx.fill(path, 'nonzero');
                    mctx.strokeStyle = st.stroke;
                    mctx.stroke(path);
                }
            }
        }

        mctx.restore();
    }

    // Route : après TOUTES les copies du fond (sinon la copie suivante repeint ses terres par-dessus), et dans
    // les copies voisines, car une route qui franchit l'antiméridien s'étend sur plus de 360° de longitude
    if (route) {
        for (let k = k0 - 1; k <= k1 + 1; k++) {
            mctx.save();
            mctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (ox + k * 360 * s), dpr * oy);
            mctx.lineJoin = 'round';
            mctx.lineCap = 'round';
            if (route) {
                if (route.hasTrack) {
                    mctx.setLineDash([]);
                    mctx.strokeStyle = MAP_COLORS.casing;
                    mctx.lineWidth = 6 / s;
                    mctx.stroke(route.solid);
                    mctx.strokeStyle = MAP_COLORS.route;
                    mctx.lineWidth = 3 / s;
                    mctx.stroke(route.solid);
                    if (route.hasGap) {
                        mctx.setLineDash([7 / s, 6 / s]);
                        mctx.strokeStyle = MAP_COLORS.routeSoft;
                        mctx.lineWidth = 2.2 / s;
                        mctx.stroke(route.dashed);
                    }
                    if (route.hasRemaining) {
                        mctx.setLineDash([0.1 / s, 7 / s]);
                        mctx.strokeStyle = MAP_COLORS.routeSoft;
                        mctx.lineWidth = 2.4 / s;
                        mctx.stroke(route.remaining);
                    }
                } else if (route.hasPosition) {
                    // Parcouru estimé : trait plein plus discret que la route réelle
                    mctx.setLineDash([]);
                    mctx.strokeStyle = MAP_COLORS.casing;
                    mctx.lineWidth = 5 / s;
                    mctx.stroke(route.flownEst);
                    mctx.strokeStyle = MAP_COLORS.routeSoft;
                    mctx.lineWidth = 2.4 / s;
                    mctx.stroke(route.flownEst);
                    if (route.hasRemaining) {
                        mctx.setLineDash([0.1 / s, 7 / s]);
                        mctx.lineWidth = 2.4 / s;
                        mctx.stroke(route.remaining);
                    }
                } else {
                    mctx.setLineDash([6 / s, 7 / s]);
                    mctx.strokeStyle = MAP_COLORS.direct;
                    mctx.lineWidth = 2 / s;
                    mctx.stroke(route.direct);
                }
                mctx.setLineDash([]);
            }
            mctx.restore();
        }
    }

    // Repères en pixels : aéroports puis avion
    flightMap.hits = [];
    if (!route) return;
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Grands aéroports survolés : point discret + code, étiquettes masquées si elles se chevauchent
    const labelBoxes = [];
    const refLon = route.dep ? route.dep.lon : flightMap.cx;
    for (let k = k0; k <= k1; k++) {
        // Grands aéroports d'abord : leurs étiquettes sont prioritaires en cas de chevauchement
        const ordered = visibleOverflown().sort((p, q) =>
            (isLargeOnRoute(p.ap) ? 0 : 1) - (isLargeOnRoute(q.ap) ? 0 : 1));
        ordered.forEach(o => {
            const big = isLargeOnRoute(o.ap);
            const lon = unwrapLon(o.ap.lon, refLon) + k * 360;
            const x = ox + lon * s, y = oy + mapY(o.ap.lat) * s;
            if (x < -20 || x > w + 20 || y < -20 || y > h + 20) return;
            mctx.beginPath();
            mctx.arc(x, y, big ? 3.6 : 2.7, 0, Math.PI * 2);
            mctx.fillStyle = wxColor(o.ap.ident) || (big ? MAP_COLORS.apLarge : MAP_COLORS.apMedium);
            mctx.fill();
            mctx.strokeStyle = MAP_COLORS.edge;
            mctx.lineWidth = 1.5;
            mctx.stroke();
            const label = mapAirportLabel(o.ap, airportCode(o.ap));
            mctx.font = big ? '700 10px sans-serif' : '500 10px sans-serif';
            const tw = mctx.measureText(label).width;
            const bx = x + 6, by = y - 7, bw = tw + 2, bh = 13;
            const clash = labelBoxes.some(b => bx < b.x + b.w && bx + bw > b.x && by < b.y + b.h && by + bh > b.y);
            if (!clash) {
                labelBoxes.push({ x: bx, y: by, w: bw, h: bh });
                mctx.fillStyle = MAP_COLORS.labelBg;
                mctx.fillRect(bx - 1, by, bw + 2, bh);
                mctx.fillStyle = big ? MAP_COLORS.apLargeText : MAP_COLORS.apMediumText;
                mctx.textAlign = 'left';
                mctx.textBaseline = 'middle';
                mctx.fillText(label, bx + 1, y - 0.5);
            }
            flightMap.hits.push({ x: x - 7, y: y - 8, w: (clash ? 14 : bw + 14), h: 16, icao: o.ap.ident });
        });
    }

    // Capitales des pays : texte discret, sous les aéroports. Les étiquettes départ/arrivée et aéroports
    // sont prioritaires ; entre capitales, les plus peuplées d'abord (la liste est déjà triée)
    if (world && world.capitals.length) {
        const reserved = labelBoxes.slice();
        mctx.font = 'bold 11px sans-serif';
        for (let k = k0; k <= k1; k++) {
            [route.dep, route.arr].forEach(m => {
                if (!m) return;
                const x = ox + (m.lon + k * 360) * s, y = oy + mapY(m.lat) * s;
                reserved.push({ x: x - 8, y: y - 12, w: 9 + mctx.measureText(m.label).width + 22, h: 24 });
            });
        }
        mctx.font = '500 10px sans-serif';
        mctx.textAlign = 'left';
        mctx.textBaseline = 'middle';
        for (let k = k0; k <= k1; k++) {
            for (const [name, lat, lon] of world.capitals) {
                const x = ox + (lon + k * 360) * s, y = oy + mapY(lat) * s;
                if (x < -60 || x > w + 10 || y < -10 || y > h + 10) continue;
                const tw = mctx.measureText(name).width;
                const box = { x: x - 3, y: y - 7, w: tw + 10, h: 14 };
                if (reserved.some(b => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y)) continue;
                reserved.push(box);
                mctx.beginPath();
                mctx.arc(x, y, 1.8, 0, Math.PI * 2);
                mctx.fillStyle = MAP_COLORS.capitalDot;
                mctx.fill();
                if (theme === 'light') {
                    // Thème clair : cartouche rectangulaire (un halo qui suit les lettres se voit trop sur fond clair)
                    pathRoundRect(mctx, x + 2, y - 7, tw + 6, 14, 3);
                    mctx.fillStyle = MAP_COLORS.labelBg;
                    mctx.fill();
                } else {
                    mctx.lineWidth = 3;
                    mctx.strokeStyle = MAP_COLORS.halo;
                    mctx.strokeText(name, x + 5, y);
                }
                mctx.fillStyle = MAP_COLORS.capitalText;
                mctx.fillText(name, x + 5, y);
            }
        }
    }

    for (let k = k0; k <= k1; k++) {
        const at = m => ({ x: ox + (m.lon + k * 360) * s, y: oy + mapY(m.lat) * s });
        [route.dep, route.arr].forEach(m => {
            if (!m) return;
            const p = at(m);
            if (p.x < -60 || p.x > w + 60 || p.y < -30 || p.y > h + 30) return;
            mctx.font = 'bold 11px sans-serif';
            const tw = mctx.measureText(m.label).width, bw = tw + 14, bh = 20;
            const bx = p.x + 9, by = p.y - bh / 2;
            pathRoundRect(mctx, bx, by, bw, bh, 6);
            mctx.fillStyle = MAP_COLORS.chipBg;
            mctx.fill();
            mctx.strokeStyle = MAP_COLORS.route;
            mctx.lineWidth = 1.2;
            mctx.stroke();
            mctx.fillStyle = MAP_COLORS.chipText;
            mctx.textAlign = 'left';
            mctx.textBaseline = 'middle';
            mctx.fillText(m.label, bx + 7, p.y + 0.5);
            mctx.beginPath();
            mctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
            mctx.fillStyle = wxColor(m.icao) || MAP_COLORS.edge;
            mctx.fill();
            mctx.strokeStyle = MAP_COLORS.plane;
            mctx.lineWidth = 2;
            mctx.stroke();
            if (m.icao) flightMap.hits.push({ x: p.x - 8, y: by - 2, w: bw + 17, h: bh + 4, icao: m.icao });
        });

        if (route.plane) {
            const p = at(route.plane);
            if (p.x > -40 && p.x < w + 40 && p.y > -40 && p.y < h + 40) {
                mctx.save();
                mctx.translate(p.x, p.y);
                mctx.rotate((route.plane.heading || 0) * Math.PI / 180);
                mctx.scale(1.3, 1.3);
                mctx.translate(-12, -12);
                mctx.shadowColor = MAP_COLORS.planeGlow;
                mctx.shadowBlur = 10;
                mctx.fillStyle = MAP_COLORS.plane;
                mctx.fill(PLANE_PATH);
                mctx.shadowBlur = 0;
                mctx.strokeStyle = MAP_COLORS.edge;
                mctx.lineWidth = 1.3;
                mctx.stroke(PLANE_PATH);
                mctx.restore();
            }
        }
    }
}

// --- Bandeaux : résumé du vol, message, légende ------------------------
function updateMapOverlay() {
    const f = flightMap.flight, t = flightMap.track, route = flightMap.route;
    const hud = document.getElementById('mapHud');
    const notice = document.getElementById('mapNotice');
    const legend = document.getElementById('mapLegend');

    if (f && t && t.now) {
        const n = t.now;
        const hm = ts => new Date(ts * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        const time = n.ts ? (n.estimated
            ? new Date(n.ts * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            : hm(n.ts)) : '';
        hud.innerHTML = [
            `<b>${escapeHtml(f.flight_iata || f.flight_icao || '')}</b>`,
            n.alt != null ? `${n.alt.toLocaleString('fr-FR')} ft` : '',
            n.gs != null ? `${n.gs} kt` : '',
            n.track != null ? `cap ${String(n.track).padStart(3, '0')}°` : '',
            time ? (n.estimated
                ? `<span class="dim" title="Position extrapolée à partir de la dernière position reçue (${hm(n.fixTs)}), de la vitesse et de la route">position estimée à ${time}</span>`
                : `<span class="dim">position à ${time}</span>`) : ''
        ].filter(Boolean).join('<i></i>');
        hud.hidden = false;
    } else {
        hud.hidden = true;
    }

    notice.textContent = flightMap.notice;
    notice.hidden = !flightMap.notice;

    const line = (css, text) => `<div><svg width="30" height="6"><line x1="1" y1="3" x2="29" y2="3" ${css}/></svg>${text}</div>`;
    const items = [];
    if (route && route.hasTrack) {
        items.push(line(`stroke="${MAP_COLORS.route}" stroke-width="3" stroke-linecap="round"`, 'Route suivie (ADS-B)'));
        if (route.hasGap) items.push(line(`stroke="${MAP_COLORS.route}" stroke-width="2" stroke-dasharray="5 4" opacity=".75"`, 'Sans réception'));
        if (route.hasRemaining) items.push(line(`stroke="${MAP_COLORS.route}" stroke-width="2.4" stroke-dasharray="0.1 5" stroke-linecap="round" opacity=".75"`, 'Reste à parcourir (estimé)'));
    } else if (route && route.hasPosition) {
        items.push(`<div><svg width="30" height="14" viewBox="0 0 30 14"><g transform="translate(8 0) scale(0.58) rotate(90 12 12)"><path fill="${MAP_COLORS.plane}" d="M12 1.5 L13.6 8.5 L22 13.5 L22 15.5 L13.6 12.8 L13.2 19 L16 21 L16 22.5 L12 21.5 L8 22.5 L8 21 L10.8 19 L10.4 12.8 L2 15.5 L2 13.5 L10.4 8.5 Z"/></g></svg>${t && t.source === 'demo' ? "Position simulée de l'avion (démo)" : "Position de l'avion"}${t && t.now && t.now.estimated ? ', estimée toutes les 20 s' : ''}</div>`);
        items.push(line(`stroke="${MAP_COLORS.route}" stroke-width="2.4" stroke-linecap="round" opacity=".75"`, 'Parcouru (estimé)'));
        if (route.hasRemaining) items.push(line(`stroke="${MAP_COLORS.route}" stroke-width="2.4" stroke-dasharray="0.1 5" stroke-linecap="round" opacity=".75"`, 'Reste à parcourir (estimé)'));
    } else if (route) {
        items.push(line('stroke="#64748b" stroke-width="2" stroke-dasharray="5 5"', 'Route directe (estimation)'));
    }
    if (route && visibleOverflown().length) {
        const hasLarge = visibleOverflown().some(o => isLargeOnRoute(o.ap));
        const hasMedium = visibleOverflown().some(o => !isLargeOnRoute(o.ap));
        const wxOn = visibleOverflown().some(o => wxCat(o.ap.ident));
        // Avec la météo, la couleur indique la catégorie de vol ; la taille du point, le type d'aéroport
        const colL = wxOn ? MAP_COLORS.legendDot : MAP_COLORS.apLarge, colM = wxOn ? MAP_COLORS.legendDotMedium : MAP_COLORS.apMedium;
        if (hasLarge) items.push(`<div><svg width="30" height="10"><circle cx="15" cy="5" r="3.6" fill="${colL}" stroke="${MAP_COLORS.edge}" stroke-width="1.5"/></svg>Grand aéroport sur la route</div>`);
        if (hasMedium) items.push(`<div><svg width="30" height="10"><circle cx="15" cy="5" r="2.7" fill="${colM}" stroke="${MAP_COLORS.edge}" stroke-width="1.5"/></svg>Aéroport moyen (piste ≥ 2 500 m)</div>`);
        if (wxOn) items.push(`<div class="wx-legend">${Object.entries(WX_CATS).map(([k, c]) => `<span title="${c.help}"><i class="wx-dot" style="background:${c.color}"></i>${k}</span>`).join('')}</div>`);
    }
    if (mapPrefs.conflict && flightMap.conflict) {
        const levels = new Set(flightMap.conflict.zones.map(z => z.level));
        for (const [level, st] of Object.entries(CONFLICT_STYLES)) {
            if (levels.has(level)) items.push(`<div><svg width="30" height="10"><rect x="2" y="1" width="26" height="8" rx="2" fill="${st.fill}" stroke="${st.stroke}" stroke-dasharray="4 3"/></svg>${st.label}</div>`);
        }
    }
    if (mapPrefs.airspaces && airspaces.index) {
        const chips = AIRSPACE_TYPE_ORDER.filter(([t]) => mapPrefs.aspTypes.includes(t)).map(([t]) => `<span><i class="wx-dot" style="background:${AIRSPACE_STYLES[t].stroke}"></i>${AIRSPACE_STYLES[t].label.replace(/^Zone /, '')}</span>`).join('');
        items.push(`<div class="wx-legend">${chips}</div>`);
        if (flightMap.scale < AIRSPACE_MIN_SCALE) items.push('<div style="color:var(--text-dim)">Espaces aériens : zoomez pour les afficher</div>');
    }
    const isDemo = (t && t.source === 'demo') || (flightMap.flight && flightMap.flight.demo);
    const credit = isDemo
        ? 'Vol de démonstration : données fictives · fond Natural Earth'
        : t && t.source === 'airlabs' ? 'Position : AirLabs · fond Natural Earth' : 'Fond de carte : Natural Earth';
    legend.innerHTML = items.length
        ? `${items.join('')}<small>${credit}${mapPrefs.conflict && flightMap.conflict ? ' · zones de conflit : EASA, FIR : VATSpy (CC-BY-SA)' : ''}${mapPrefs.airspaces && airspaces.index ? ' · espaces aériens : OpenAIP (CC BY-NC)' : ''}<br>Plan de vol non public · indicatif, ne pas utiliser pour la navigation</small>`
        : '';
    legend.hidden = !items.length;
    // Le contenu (donc la taille) de ces boîtes vient de changer : la trajectoire doit rester dégagée
    scheduleMapRefit();
}

function syncFullscreenHeader() {
    const f = flightMap.flight;
    if (viewMode === 'map' && f) {
        const status = FLIGHT_STATUS[f.status] ? FLIGHT_STATUS[f.status].label : '';
        document.getElementById('fsIdent').innerText = f.flight_iata || f.flight_icao || '';
        document.getElementById('fsName').innerText = `${f.dep_iata || f.dep_icao || '?'} → ${f.arr_iata || f.arr_icao || '?'}`;
        document.getElementById('fsRunwaysCount').innerText = status;
    } else if (currentAirportData) {
        document.getElementById('fsIdent').innerText = currentAirportData.ident;
        document.getElementById('fsName').innerText = currentAirportData.name || currentAirportData.ident;
        document.getElementById('fsRunwaysCount').innerText = `${(currentAirportData.runways || []).length} piste(s)`;
    }
}

// --- Bascule Schéma / Carte -------------------------------------------
function setViewMode(mode) {
    if (viewMode === mode) return;
    hideMapTip();
    viewMode = mode;
    document.body.dataset.view = mode;
    const isMap = mode === 'map';
    updateViewToggle();
    const tabLabel = document.querySelector('#tabBtnDiagram span');
    if (tabLabel) tabLabel.textContent = isMap ? 'Carte du vol' : 'Schéma Pistes';
    syncFullscreenHeader();
    if (isMap) {
        resizeMapCanvas();
    } else {
        stopMapRefresh();
        resizeCanvas();
    }
}

function stopMapRefresh() {
    if (flightMap.timer) { clearInterval(flightMap.timer); flightMap.timer = null; }
}

// --- Position estimée (navigation à l'estime) ------------------------------------
// Aucun appel au service : à partir de la dernière position reçue (heure, vitesse sol), l'avion avance
// le long du grand cercle vers l'aéroport d'arrivée. Recalculée toutes les 20 s quand la carte est affichée.
const ESTIMATE_PERIOD_MS = 20000;

function estimatedNow(base, nowSec) {
    const fix = base && base.now, plan = flightMap.plan, f = flightMap.flight;
    if (!fix || typeof fix.lat !== 'number' || !plan || !fix.ts || f.status !== 'en-route') return null;
    const remaining = plan.total - plan.s;                    // radians restant à parcourir sur la route
    if (remaining <= 0) return null;
    // Vitesse sol connue, sinon déduite de la distance restante et de l'heure d'arrivée estimée
    let gsKt = typeof fix.gs === 'number' && fix.gs > 50 ? fix.gs : null;
    if (!gsKt) {
        const eta = utcMs(f.arr_estimated_utc) || utcMs(f.arr_time_utc);
        const hours = eta ? (eta / 1000 - fix.ts) / 3600 : 0;
        if (hours > 0.05) gsKt = (remaining * EARTH_NM) / hours;
    }
    if (!gsKt) return null;
    const advance = Math.min(remaining, (gsKt * Math.max(0, nowSec - fix.ts) / 3600) / EARTH_NM);
    const sNow = plan.s + advance;
    const pos = pointOnPath(plan.path, sNow);
    return {
        ...fix,
        lat: pos.lat,
        lon: pos.lon,
        track: Math.round(pos.heading),
        gs: fix.gs ?? Math.round(gsKt),
        ts: nowSec,
        fixTs: fix.ts,
        pathS: sNow,
        estimated: advance > 0
    };
}

function applyEstimatedPosition() {
    if (!flightMap.trackBase || viewMode !== 'map' || document.hidden) return;
    const est = estimatedNow(flightMap.trackBase, Math.round(Date.now() / 1000));
    if (!est) return;
    flightMap.track = { ...flightMap.trackBase, now: est };
    flightMap.planS = est.pathS;
    flightMap.route = buildFlightRoute();
    updateMapOverlay();
    scheduleMapDraw();
}

function startEstimates() {
    stopMapRefresh();
    if (!flightMap.trackBase || !flightMap.flight || flightMap.flight.status !== 'en-route') return;
    applyEstimatedPosition();
    flightMap.timer = setInterval(applyEstimatedPosition, ESTIMATE_PERIOD_MS);
}

// Affiche la carte du vol sélectionné ; `reuse` réutilise les données déjà chargées pour ce vol.
// Pas d'actualisation automatique de la position (quota AirLabs) : rechercher à nouveau le vol la met à jour.
async function showFlightMap(reuse = false) {
    const f = currentFlight;
    if (!f) return;
    // La carte appartient au vol : on revient sur l'onglet « Vol » (dossier de vol visible)
    if (document.body.dataset.searchMode !== 'flight') setSearchMode('flight', false);
    const fresh = reuse && flightMap.flight === f && flightMap.route;
    setViewMode('map');
    if (isMobileLayout()) switchMobileTab('diagram');
    if (fresh) {
        updateMapOverlay();
        resizeMapCanvas();
        startEstimates();
        return;
    }

    const seq = ++flightMap.seq;
    stopMapRefresh();
    Object.assign(flightMap, { flight: f, dep: null, arr: null, track: null, trackBase: null, route: null, plan: null, planS: 0, notice: 'Chargement de la carte…' });
    syncFullscreenHeader();
    updateMapOverlay();
    scheduleMapDraw();

    const [world, dep, arr, tracked] = await Promise.allSettled([
        loadWorld(), getAirportData(f.dep_icao), getAirportData(f.arr_icao), loadFlightTrack(f)
    ]);
    if (seq !== flightMap.seq) return;

    flightMap.dep = dep.value || null;
    flightMap.arr = arr.value || null;
    flightMap.track = tracked.value ? tracked.value.data : null;
    flightMap.trackBase = flightMap.track;   // dernière position reçue, base de l'estime
    flightMap.plan = null;                    // recalculé par buildFlightRoute à partir de cette position
    flightMap.route = buildFlightRoute();
    refreshOverflown();
    flightMap.loadedAt = Date.now();
    flightMap.notice = world.status === 'rejected' ? 'Fond de carte indisponible'
        : (tracked.value ? tracked.value.notice : '');
    if (!flightMap.route.points.length && !flightMap.notice) {
        flightMap.notice = 'Position des aéroports indisponible : route non affichable';
    }
    updateMapOverlay();
    flightMap.needsFit = true;
    resizeMapCanvas();
    startEstimates();
}

// --- Interactions : souris, tactile (déplacement, pincement), clic sur un aéroport ----
const mapPointers = new Map();
let mapPinch = null, mapDown = null;

function mapHitAt(clientX, clientY) {
    const rect = mapCanvas.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    return flightMap.hits.findLast(a => x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h);
}

// --- Réglages de la carte ------------------------------------------------------
function syncMapSettings() {
    document.querySelectorAll('#mapSettings [data-code]').forEach(b => {
        const on = b.dataset.code === mapPrefs.code;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', String(on));
    });
    document.querySelectorAll('#mapSettings [data-mapstyle]').forEach(b => {
        const on = b.dataset.mapstyle === mapPrefs.style;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', String(on));
    });
    document.getElementById('mapBand').value = mapPrefs.band;
    document.getElementById('mapBandValue').textContent = `± ${mapPrefs.band} nm`;
    document.getElementById('mapLargeOnly').checked = mapPrefs.largeOnly;
    document.getElementById('mapConflict').checked = mapPrefs.conflict;
    document.getElementById('mapAirspaces').checked = mapPrefs.airspaces;
    document.getElementById('mapAirspaceFilters').hidden = !mapPrefs.airspaces || !airspaces.index;
    document.querySelectorAll('#mapAirspaceFilters [data-asptype]').forEach(b => b.setAttribute('aria-pressed', String(mapPrefs.aspTypes.includes(+b.dataset.asptype))));
    document.querySelectorAll('#mapAirspaceFilters [data-aspclass]').forEach(b => b.setAttribute('aria-pressed', String(mapPrefs.aspClasses.includes(b.dataset.aspclass))));
    document.getElementById('mapLargeOnlyPhone').checked = mapPrefs.largeOnly;
}


// --- Thème clair / sombre ---------------------------------------------------------
function applyTheme(next, { save = true } = {}) {
    theme = next === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    Object.assign(MAP_COLORS, mapPalette(theme));
    Object.assign(DC, DIAGRAM_THEMES[theme]);
    if (save) { try { localStorage.setItem('pleinaxe.theme', theme); } catch (err) { /* stockage indisponible */ } }
    document.querySelectorAll('[data-themebtn]').forEach(b => {
        const on = b.dataset.themebtn === theme;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', String(on));
    });
    if (typeof hideMapTip === 'function') hideMapTip();
    if (typeof flightMap !== 'undefined' && flightMap.flight) updateMapOverlay();   // légende (couleurs inline)
    if (typeof viewMode !== 'undefined' && viewMode === 'map') scheduleMapDraw(); else if (currentRunways.length) draw();
}
// Lien de partage : l'URL courante (?icao= / ?flight=), sans code d'accès ; feuille de partage native sur téléphone
let shareTimer = null;
async function shareLink() {
    const url = new URL(location.href);
    url.searchParams.delete('code');
    const btn = document.getElementById('shareBtn');
    const done = () => {
        btn.classList.add('copied');
        btn.title = 'Lien copié !';
        clearTimeout(shareTimer);
        shareTimer = setTimeout(() => { btn.classList.remove('copied'); btn.title = 'Copier le lien de cette vue'; }, 2000);
    };
    try {
        if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
            await navigator.share({ title: document.title, url: url.href });
            return;
        }
        await navigator.clipboard.writeText(url.href);
        done();
    } catch (err) {
        if (err && err.name === 'AbortError') return;   // partage annulé
        window.prompt('Copiez ce lien :', url.href);     // presse-papiers indisponible
    }
}
function setTheme(next) { applyTheme(next); }
function toggleTheme() { applyTheme(theme === 'light' ? 'dark' : 'light'); }

// Couches de la carte (zones de conflit EASA, espaces aériens OpenAIP)
function setMapLayer(name, on) {
    mapPrefs[name] = !!on;
    saveMapPrefs();
    syncMapSettings();
    if (flightMap.flight) updateMapOverlay();   // légende
    scheduleMapDraw();
}

// Filtres des espaces aériens : un clic coche / décoche un type ou une classe
function toggleAirspaceFilter(kind, value) {
    const list = kind === 'type' ? mapPrefs.aspTypes : mapPrefs.aspClasses;
    const i = list.indexOf(value);
    if (i >= 0) list.splice(i, 1); else list.push(value);
    saveMapPrefs();
    syncMapSettings();
    hideMapTip();
    if (flightMap.flight) updateMapOverlay();   // légende
    scheduleMapDraw();
}

// Boutons des filtres, générés une fois (types colorés comme sur la carte)
function buildAirspaceFilters() {
    const types = AIRSPACE_TYPE_ORDER.map(([t, short]) =>
        `<button type="button" class="asp-chip" data-asptype="${t}" title="${AIRSPACE_STYLES[t].label}" onclick="toggleAirspaceFilter('type', ${t})"><i style="background:${AIRSPACE_STYLES[t].stroke}"></i>${short}</button>`).join('');
    const classes = AIRSPACE_CLASSES.map(c =>
        `<button type="button" class="asp-chip" data-aspclass="${c}" title="Classe ${c}" onclick="toggleAirspaceFilter('class', '${c}')">${c}</button>`).join('');
    document.getElementById('mapAirspaceFilters').innerHTML =
        `<div class="asp-filter-row"><span>Types</span><div class="asp-chips">${types}</div></div>` +
        `<div class="asp-filter-row"><span>Classes</span><div class="asp-chips">${classes}</div></div>`;
}

function setMapStyle(style) {
    mapPrefs.style = style;
    saveMapPrefs();
    syncMapSettings();
    Object.assign(MAP_COLORS, mapPalette(theme));
    if (flightMap.flight) updateMapOverlay();   // légende (couleurs inline)
    scheduleMapDraw();
}

function setMapCode(code) {
    mapPrefs.code = code;
    saveMapPrefs();
    syncMapSettings();
    if (flightMap.flight && flightMap.route) flightMap.route = buildFlightRoute();   // étiquettes départ/arrivée
    if (currentFlight) renderOverflownList(currentFlight, flightMap.overflown, true);
    scheduleMapDraw();
}

// Réglage partagé entre la carte (panneau de réglages) et la liste du dossier de vol
function setLargeOnly(on) {
    mapPrefs.largeOnly = !!on;
    saveMapPrefs();
    syncMapSettings();
    if (currentFlight) renderOverflownList(currentFlight, flightMap.overflown, true);
    if (flightMap.flight) { updateMapOverlay(); loadWeatherForMap(); }   // légende (types affichés)
    scheduleMapDraw();
}

function setMapBand(value) {
    mapPrefs.band = Math.min(300, Math.max(100, Number(value) || 100));
    saveMapPrefs();
    syncMapSettings();
    refreshOverflown({ fit: false });   // la vue ne bouge pas pendant qu'on règle la bande
}

syncMapSettings();

// ========================================================
// MÉTÉO : METAR (observation) et TAF (prévision), relayés depuis NOAA par le worker (/wx)
// Couleurs des aéroports sur la carte selon la catégorie de vol : VFR, MVFR, IFR, LIFR
// ========================================================
const WX_CATS = {
    VFR:  { color: '#22c55e', label: 'VFR',  help: 'visibilité > 8 km et plafond > 3 000 ft' },
    MVFR: { color: '#3b82f6', label: 'MVFR', help: 'visibilité 5 à 8 km ou plafond 1 000 à 3 000 ft' },
    IFR:  { color: '#ef4444', label: 'IFR',  help: 'visibilité 1,6 à 5 km ou plafond 500 à 1 000 ft' },
    LIFR: { color: '#d946ef', label: 'LIFR', help: 'visibilité < 1,6 km ou plafond < 500 ft' }
};
const WX_METAR_MAX_AGE_MS = 5 * 60 * 1000;
const WX_TAF_MAX_AGE_MS = 15 * 60 * 1000;
const wxStore = new Map();   // OACI -> { metar: obj|null|undefined, taf: obj|null|undefined, tMetar, tTaf, failed }

function wxFresh(icao, kind) {
    const e = wxStore.get(icao);
    const t = e && (kind === 'taf' ? e.tTaf : e.tMetar);
    return !!t && Date.now() - t < (kind === 'taf' ? WX_TAF_MAX_AGE_MS : WX_METAR_MAX_AGE_MS);
}

// Charge les METAR (et TAF si taf) des aéroports absents du cache ; par lots, sans jamais lever d'erreur
async function loadWeather(icaos, { taf = false } = {}) {
    if (!FLIGHT_API_BASE) return;
    const ids = [...new Set(icaos.filter(i => /^[A-Z0-9]{3,4}$/.test(i || '')))]
        .filter(i => !wxFresh(i, 'metar') || (taf && !wxFresh(i, 'taf')));
    for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        try {
            const res = await fetch(`${FLIGHT_API_BASE}/wx?ids=${batch.join(',')}${taf ? '&taf=1' : ''}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const d = await res.json(), now = Date.now();
            batch.forEach(id => {
                const e = wxStore.get(id) || {};
                e.metar = d.metar && d.metar[id] ? d.metar[id] : null;
                e.tMetar = now;
                e.failed = false;
                if (d.taf) { e.taf = d.taf[id] || null; e.tTaf = now; }
                wxStore.set(id, e);
            });
        } catch (err) {
            batch.forEach(id => { const e = wxStore.get(id) || {}; e.failed = true; wxStore.set(id, e); });
        }
    }
}

// --- Catégorie de vol (celle de NOAA pour un METAR ; calculée pour les périodes d'un TAF) ---
function wxVisSM(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return v;
    let sm = 0;
    String(v).replace('+', '').trim().split(/\s+/).forEach(part => {
        const f = part.match(/^(\d+)\/(\d+)$/);
        sm += f ? Number(f[1]) / Number(f[2]) : (parseFloat(part) || 0);
    });
    return sm;
}
function wxCeilingFt(clouds) {
    const bases = (clouds || []).filter(c => ['BKN', 'OVC', 'VV'].includes(c[0]) && typeof c[1] === 'number').map(c => c[1]);
    return bases.length ? Math.min(...bases) : null;
}
function wxCategory(vis, clouds) {
    const sm = wxVisSM(vis), ceil = wxCeilingFt(clouds);
    if (sm === null && ceil === null) return null;
    if ((sm !== null && sm < 1) || (ceil !== null && ceil < 500)) return 'LIFR';
    if ((sm !== null && sm < 3) || (ceil !== null && ceil < 1000)) return 'IFR';
    if ((sm !== null && sm <= 5) || (ceil !== null && ceil <= 3000)) return 'MVFR';
    return 'VFR';
}
function wxCat(icao) {
    const e = wxStore.get(icao), m = e && e.metar;
    return m ? (m.cat || wxCategory(m.vis, m.clouds) || 'VFR') : null;
}
const wxColor = icao => { const c = wxCat(icao); return c ? WX_CATS[c].color : null; };

// --- Mise en forme (français, unités aéronautiques usuelles) ---
function wxFmtVis(v) {
    const sm = wxVisSM(v);
    if (sm === null) return null;
    const km = sm * 1.609344;
    if (km >= 9.5 || (String(v).endsWith('+') && sm >= 6)) return '≥ 10 km';
    if (km >= 5) return `${Math.round(km)} km`;
    if (km >= 1) return `${km.toFixed(1).replace('.', ',')} km`;
    return `${Math.max(50, Math.round(km * 10) * 100)} m`;
}
function wxFmtWind(dir, spd, gst) {
    if (spd === null || spd === undefined) return null;
    if (spd === 0) return 'Calme';
    const d = (dir === 'VRB' || dir === null || dir === undefined) ? 'Variable' : `${String(dir).padStart(3, '0')}°`;
    return `${d} · ${spd} kt${gst ? ` (rafales ${gst})` : ''}`;
}
function wxFmtClouds(clouds) {
    if (!clouds || !clouds.length) return 'Dégagé';
    return clouds.map(([c, base]) => typeof base === 'number' ? `${c} ${base.toLocaleString('fr-FR')} ft` : c).join(' · ');
}
const WX_PHENOMENA = {
    RA: 'pluie', SN: 'neige', DZ: 'bruine', TS: 'orage', SH: 'averses', FG: 'brouillard', BR: 'brume', HZ: 'brume sèche',
    FZ: 'verglaçant', GR: 'grêle', GS: 'grésil', SG: 'neige en grains', PL: 'granules de glace', IC: 'cristaux de glace',
    DU: 'poussière', SA: 'sable', FU: 'fumée', VA: 'cendres volcaniques', SQ: 'grains', FC: 'tornade', DS: 'tempête de poussière',
    SS: 'tempête de sable', MI: 'mince', BC: 'bancs', PR: 'partiel', DR: 'chasse basse', BL: 'chasse haute', UP: 'précipitations'
};
function wxFmtWeather(wx) {
    if (!wx) return null;
    return wx.split(/\s+/).filter(Boolean).map(tok => {
        const m = tok.match(/^([-+]|VC)?((?:[A-Z]{2})+)$/);
        if (!m) return tok;
        const words = m[2].match(/../g).map(c => WX_PHENOMENA[c] || c);
        const pre = m[1] === '-' ? 'faible ' : m[1] === '+' ? 'fort ' : m[1] === 'VC' ? 'à proximité : ' : '';
        return pre + words.join(' ');
    }).join(', ');
}
const wxPad = n => String(n).padStart(2, '0');
const wxHour = ts => `${wxPad(new Date(ts * 1000).getUTCHours())}Z`;
const wxDayHour = ts => `${wxPad(new Date(ts * 1000).getUTCDate())} ${wxHour(ts)}`;
function wxObsTime(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000), min = Math.round((Date.now() - d.getTime()) / 60000);
    const hm = `${wxPad(d.getUTCHours())}:${wxPad(d.getUTCMinutes())} UTC`;
    return min >= 0 && min < 90 ? `${hm} · il y a ${min} min` : hm;
}

// Heure estimée de passage de l'avion à un aéroport : position actuelle, vitesse sol et distance orthodromique
// (ts = secondes Unix ; passed = l'aéroport est derrière l'avion). null hors vol en cours ou sans vitesse fiable.
function flightPassage(icao) {
    const f = flightMap.flight, n = flightMap.track && flightMap.track.now;
    if (!f || f.status !== 'en-route' || !n || typeof n.lat !== 'number' || typeof n.lon !== 'number' || !(n.gs > 50)) return null;
    const ap = searchIndexMap.get(icao);
    if (!ap || !Number.isFinite(ap.lat) || !Number.isFinite(ap.lon)) return null;
    const from = { lat: n.lat, lon: n.lon }, to = { lat: ap.lat, lon: ap.lon };
    const distNm = gcDist(from, to) * EARTH_NM;
    if (typeof n.track === 'number' && distNm > 5) {
        const bearing = (gcBearing(from, to) * 180 / Math.PI + 360) % 360;
        const off = Math.abs(((bearing - n.track + 540) % 360) - 180);   // écart entre le cap et la direction de l'aéroport
        if (off > 100) return { passed: true, distNm };
    }
    return { passed: false, distNm, ts: (n.ts || Date.now() / 1000) + distNm / n.gs * 3600 };
}

// Lignes du TAF valables à l'heure ts : le groupe de base en vigueur (début, FM, BECMG), plus les TEMPO / PROB qui la couvrent
function wxTafActive(taf, ts) {
    const active = new Set();
    if (!taf.fc.length || ts >= taf.to) return active;
    let base = -1;
    taf.fc.forEach((f, i) => { if ((!f.ch || f.ch === 'FM' || f.ch === 'BECMG') && !f.p && f.f <= ts) base = i; });
    if (base < 0) base = taf.fc.findIndex(f => (!f.ch || f.ch === 'FM' || f.ch === 'BECMG') && !f.p);
    if (base >= 0) active.add(base);
    taf.fc.forEach((f, i) => { if ((f.ch === 'TEMPO' || f.p) && f.f <= ts && ts < f.t) active.add(i); });
    return active;
}

function wxFmtEta(ts) {
    const min = Math.round((ts - Date.now() / 1000) / 60);
    const rel = min < 1 ? 'imminent' : min < 60 ? `dans ${min} min` : `dans ${Math.floor(min / 60)} h ${wxPad(min % 60)}`;
    return `${wxDayHour(ts)} · ${rel}`;
}

function wxTafHtml(taf, pass) {
    const now = Date.now() / 1000;
    const eta = pass && !pass.passed ? pass.ts : null;
    const active = eta ? wxTafActive(taf, eta) : new Set();
    const rows = taf.fc.map((f, i) => ({ f, i })).filter(({ f, i }) => f.t > now || active.has(i)).map(({ f, i }) => {
        const tag = [f.p ? `PROB${f.p}` : '', f.ch || ''].filter(Boolean).join(' ');
        const when = (!f.ch || f.ch === 'FM' || f.ch === 'BECMG') && !f.p ? wxDayHour(f.f) : `${wxHour(f.f)}–${wxHour(f.t)}`;
        const parts = [wxFmtWind(f.wdir, f.wspd, f.wgst), wxFmtVis(f.vis), f.clouds.length || !f.ch ? wxFmtClouds(f.clouds) : null, wxFmtWeather(f.wx)]
            .filter(Boolean).join(' · ');
        const cat = wxCategory(f.vis, f.clouds);
        return `<div class="wx-taf-row${active.has(i) ? ' is-eta' : ''}"${active.has(i) ? ' title="Valable à l\'heure estimée de passage"' : ''}><span class="wx-taf-when">${when}</span>
            <span class="wx-taf-what"><i class="wx-dot ${cat || ''}"></i>${tag ? `<span class="wx-tag">${tag}</span>` : ''}${escapeHtml(parts)}</span></div>`;
    }).join('');
    return `<div class="wx-taf">
        <div class="wx-head wx-taf-title"><span class="wx-label">TAF · prévision</span><span class="wx-age">émis ${taf.issue ? wxDayHour(taf.issue) : ''}</span></div>
        ${eta ? `<div class="wx-eta">✈ Passage estimé <b>${wxFmtEta(eta)}</b>${eta >= taf.to ? ' · au-delà de la validité du TAF' : ''}</div>` : ''}
        ${pass && pass.passed ? '<div class="wx-eta wx-eta-past">✈ Aéroport déjà survolé</div>' : ''}
        ${rows || '<div class="wx-none">Prévision expirée</div>'}
    </div>`;
}

// Bloc météo d'un aéroport (infobulle et panneau latéral) : METAR décodé + brut, puis TAF
function wxBlock(icao, { taf = true } = {}) {
    if (!FLIGHT_API_BASE) return '';
    const e = wxStore.get(icao);
    const label = '<span class="wx-label">Météo</span>';
    if (!e || (e.metar === undefined && !e.failed)) return `<div class="wx"><div class="wx-head">${label}</div><div class="wx-none">Chargement…</div></div>`;
    if (e.metar === undefined) return `<div class="wx"><div class="wx-head">${label}</div><div class="wx-none">Météo indisponible</div></div>`;
    const m = e.metar;
    if (!m) return `<div class="wx"><div class="wx-head">${label}</div><div class="wx-none">Pas de METAR pour cet aéroport</div></div>`;
    const cat = m.cat || wxCategory(m.vis, m.clouds) || 'VFR';
    const rows = [
        ['Vent', wxFmtWind(m.wdir, m.wspd, m.wgst)],
        ['Visibilité', wxFmtVis(m.vis)],
        ['Nuages', wxFmtClouds(m.clouds)],
        ['Phénomènes', wxFmtWeather(m.wx)],
        ['Température', m.temp !== null ? `${m.temp}° · point de rosée ${m.dewp !== null ? m.dewp + '°' : '—'}` : null],
        ['QNH', m.alt !== null ? `${Math.round(m.alt)} hPa` : null]
    ].filter(r => r[1]).map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('');
    return `<div class="wx">
        <div class="wx-head">${label}<span class="wx-pill ${cat}" title="${WX_CATS[cat].help}">${cat}</span><span class="wx-age">METAR ${wxObsTime(m.t)}</span></div>
        <dl class="wx-grid">${rows}</dl>
        <div class="wx-raw">${escapeHtml(m.raw)}</div>
        ${taf ? (e.taf ? wxTafHtml(e.taf, flightPassage(icao)) : (e.taf === null ? '<div class="wx-taf"><div class="wx-none">Pas de TAF pour cet aéroport</div></div>' : '')) : ''}
    </div>`;
}

// Fiche aéroport du panneau latéral + pastille sous le titre du diagramme
function renderAirportWeather() {
    const box = document.getElementById('apWeather'), chip = document.getElementById('diagramTitleWx');
    const icao = currentAirportCode;
    if (!icao || !FLIGHT_API_BASE) { box.hidden = true; chip.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = wxBlock(icao);
    const e = wxStore.get(icao), m = e && e.metar;
    chip.innerHTML = m ? `<span class="wx-pill ${wxCat(icao)}">${wxCat(icao)}</span><span>${escapeHtml([wxFmtWind(m.wdir, m.wspd, m.wgst), wxFmtVis(m.vis)].filter(Boolean).join(' · '))}</span>` : '';
}

async function loadAirportWeather(icao) {
    renderAirportWeather();
    await loadWeather([icao], { taf: true });
    if (currentAirportCode === icao) renderAirportWeather();
}

// Carte du vol : METAR du départ, de l'arrivée et des aéroports affichés le long de la route
function loadWeatherForMap() {
    const f = flightMap.flight;
    if (!f) return;
    const ids = new Set([f.dep_icao, f.arr_icao]);
    visibleOverflown().forEach(o => ids.add(o.ap.ident));
    loadWeather([...ids].filter(Boolean)).then(() => {
        if (flightMap.flight !== f) return;
        scheduleMapDraw();
        updateMapOverlay();
        if (currentFlight === f) renderOverflownList(f, flightMap.overflown, true);
    });
}

// Grand écran : infos et pistes de l'aéroport dans un deuxième panneau, à droite du premier
const wideLayout = window.matchMedia('(min-width: 1360px)');
function placeAirportBlocks() {
    const target = wideLayout.matches ? document.getElementById('airportPanel') : document.getElementById('detailsSection');
    ['airportCard', 'statsBox', 'runwayList'].forEach(id => target.appendChild(document.getElementById(id)));
}
placeAirportBlocks();
wideLayout.addEventListener('change', () => {
    placeAirportBlocks();
    setTimeout(() => { if (viewMode === 'map') resizeMapCanvas(); else resetView(); }, 0);   // zone de dessin modifiée : recadrer
});

// --- Infobulle au survol d'un aéroport -------------------------------------
const mapTip = document.getElementById('mapTooltip');
let mapTipIcao = null;

function longestRunway(data) {
    let best = 0;
    (data.runways || []).forEach(r => {
        const a = { lat: r.le_lat, lon: r.le_lon }, b = { lat: r.he_lat, lon: r.he_lon };
        best = Math.max(best, gcDist(a, b) * 6371000);
    });
    return best;
}

// Types d'approche IFR de tout l'aéroport (données FAA), au format des pastilles
function airportApproachTags(data) {
    if (!data || !data.approaches) return [];
    let cat = 0;
    const types = new Set();
    Object.values(data.approaches).forEach(list => list.forEach(a => {
        if (a.type === 'ILS') cat = Math.max(cat, a.cat || 1); else types.add(a.type);
    }));
    const keys = [];
    if (cat) keys.push(`ILS${cat}`); else if (types.has('LOC')) keys.push('LOC');
    ['RNAV', 'VOR', 'NDB', 'VIS'].forEach(t => { if (types.has(t)) keys.push(t); });
    return keys.map(k => APPROACH_STYLES[k]);
}

function renderMapTip(icao, data) {
    const idx = searchIndexMap.get(icao) || {};
    const name = (data && data.name) || idx.name || icao;
    const type = idx.route_type || (data && data.type) || idx.type;
    const iata = (data && data.iata && data.iata !== '-') ? data.iata : idx.iata;
    const cityRaw = (data && data.municipality) || idx.municipality;
    const city = cityRaw && cityRaw !== 'N/A' ? cityRaw : '';
    // Même règle que le mini-diagramme : les pistes de moins de 2 000 m ne comptent pas,
    // sauf si l'aéroport n'a que celles-là
    let rows;
    if (data) {
        const all = data.runways || [];
        const long = all.filter(r => gcDist({ lat: r.le_lat, lon: r.le_lon }, { lat: r.he_lat, lon: r.he_lon }) * 6371000 >= MIN_RUNWAY_LENGTH_M);
        const nRwy = (long.length ? long : all).length;
        rows = `<div class="map-tooltip-row"><b>${nRwy}</b> piste${nRwy > 1 ? 's' : ''}`;
        const len = Math.round(longestRunway(data));
        if (len) rows += ` · plus longue&nbsp;: <b>${len.toLocaleString('fr-FR')} m</b> (${Math.round(len / FT_TO_M).toLocaleString('fr-FR')} ft)`;
    } else {
        rows = '<div class="map-tooltip-row"><span style="color:var(--text-dim)">Chargement…</span>';
    }
    rows += '</div>';
    const tags = data ? airportApproachTags(data) : [];
    mapTip.innerHTML = `
        <div class="map-tooltip-name">${escapeHtml(name)}</div>
        <div class="map-tooltip-codes">${escapeHtml(icao)}${iata ? ' · ' + escapeHtml(iata) : ''}${city ? ` <span>· ${escapeHtml(city)}</span>` : ''}</div>
        ${type ? getAirportTypeBadge(type) : ''}
        ${rows}
        ${tags.length ? `<div class="map-tooltip-tags">${tags.map(t => `<span class="appr-tag ${t.cls}">${t.label}</span>`).join('')}</div>` : ''}
        <div class="map-tooltip-wx">${wxBlock(icao)}</div>
        ${data && (data.runways || []).length ? '<canvas class="map-tooltip-diagram" width="248" height="150"></canvas>' : ''}
        <div class="map-tooltip-hint">Clic : ouvrir le diagramme</div>`;
    const mini = mapTip.querySelector('.map-tooltip-diagram');
    if (mini) drawMiniDiagram(mini, data);
}

// Schéma des pistes en miniature (nord en haut, à l'échelle), dessiné dans l'infobulle
function drawMiniDiagram(cv, data) {
    const W = 248, H = 150, pad = 18;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr;
    cv.height = H * dpr;
    cv.style.width = W + 'px';
    cv.style.height = H + 'px';
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = DC.miniBg;
    c.fillRect(0, 0, W, H);

    const lengthOf = r => gcDist({ lat: r.le_lat, lon: r.le_lon }, { lat: r.he_lat, lon: r.he_lon }) * 6371000;
    const all = data.runways || [];
    const long = all.filter(r => lengthOf(r) >= MIN_RUNWAY_LENGTH_M);
    const rwys = long.length ? long : all;   // petites pistes masquées, sauf s'il n'y a qu'elles
    const lat0 = rwys.reduce((sum, r) => sum + r.le_lat + r.he_lat, 0) / (2 * rwys.length);
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    const P = (lat, lon) => ({ x: lon * kx, y: -lat * ky });
    const segs = rwys.map(r => ({ a: P(r.le_lat, r.le_lon), b: P(r.he_lat, r.he_lon), r }));
    const xs = segs.flatMap(sg => [sg.a.x, sg.b.x]), ys = segs.flatMap(sg => [sg.a.y, sg.b.y]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const scale = Math.min((W - 2 * pad) / Math.max(maxX - minX, 300), (H - 2 * pad) / Math.max(maxY - minY, 300));
    const ox = W / 2 - (minX + maxX) / 2 * scale, oy = H / 2 - (minY + maxY) / 2 * scale;
    const T = pt => ({ x: ox + pt.x * scale, y: oy + pt.y * scale });

    c.lineCap = 'butt';
    segs.forEach(({ a, b, r }) => {
        const p1 = T(a), p2 = T(b);
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const short = len < MIN_RUNWAY_LENGTH_M;
        c.strokeStyle = short ? DC.miniShortOuter : DC.miniRwyOuter;
        c.lineWidth = Math.max(3, Math.min(8, (r.width_ft || 150) * FT_TO_M * scale)) + 2;
        c.beginPath(); c.moveTo(p1.x, p1.y); c.lineTo(p2.x, p2.y); c.stroke();
        c.strokeStyle = short ? DC.miniShortInner : DC.miniRwyInner;
        c.lineWidth -= 2;
        c.beginPath(); c.moveTo(p1.x, p1.y); c.lineTo(p2.x, p2.y); c.stroke();
    });
    // Identifiants de seuil, au-delà de chaque extrémité
    c.font = 'bold 9px sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    segs.forEach(({ a, b, r }) => {
        const p1 = T(a), p2 = T(b);
        const L = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
        const ux = (p2.x - p1.x) / L, uy = (p2.y - p1.y) / L;
        const short = Math.hypot(b.x - a.x, b.y - a.y) < MIN_RUNWAY_LENGTH_M;
        c.fillStyle = short ? DC.miniShortId : DC.miniId;
        c.fillText(r.le_ident, p1.x - ux * 9, p1.y - uy * 9);
        c.fillText(r.he_ident, p2.x + ux * 9, p2.y + uy * 9);
    });
    // Nord
    c.fillStyle = '#ef4444';
    c.font = 'bold 9px sans-serif';
    c.fillText('▲ N', W - 16, 10);
}

function positionMapTip(clientX, clientY) {
    const rect = canvasContainer.getBoundingClientRect();
    const w = mapTip.offsetWidth, h = mapTip.offsetHeight;
    let x = clientX - rect.left + 16, y = clientY - rect.top + 16;
    if (x + w > rect.width - 8) x = clientX - rect.left - w - 16;
    if (y + h > rect.height - 8) y = clientY - rect.top - h - 16;
    mapTip.style.left = `${Math.max(8, x)}px`;
    mapTip.style.top = `${Math.max(8, y)}px`;
}

let mapTipPos = { x: 0, y: 0 };
async function showMapTip(icao, clientX, clientY) {
    mapTipPos = { x: clientX, y: clientY };
    if (mapTipIcao !== icao) {
        mapTipIcao = icao;
        const cached = airportCache.get(icao);
        renderMapTip(icao, cached || null);
        // Météo (METAR + TAF) : chargée au survol, l'infobulle se complète à l'arrivée des données
        if (!wxFresh(icao, 'metar') || !wxFresh(icao, 'taf')) {
            loadWeather([icao], { taf: true }).then(() => {
                if (mapTipIcao !== icao) return;
                renderMapTip(icao, airportCache.get(icao) || null);
                positionMapTip(mapTipPos.x, mapTipPos.y);
            });
        }
        if (!cached) {
            const data = await getAirportData(icao);
            if (mapTipIcao !== icao) return;
            renderMapTip(icao, data);
        }
    }
    mapTip.hidden = false;
    positionMapTip(clientX, clientY);
}

// Infobulle des couches (zones de conflit EASA, espaces aériens OpenAIP) sous le curseur ; true si elle s'affiche
function showLayerTip(clientX, clientY) {
    const conflictOn = mapPrefs.conflict && flightMap.conflict;
    const airspacesOn = mapPrefs.airspaces && airspaces.index && flightMap.scale >= AIRSPACE_MIN_SCALE;
    if (!conflictOn && !airspacesOn) return false;
    const rect = mapCanvas.getBoundingClientRect();
    const s = flightMap.scale;
    const lon = flightMap.cx + (clientX - rect.left - rect.width / 2) / s;
    const lat = latOfWorldY(flightMap.cy + (clientY - rect.top - rect.height / 2) / s);
    const zones = conflictOn ? conflictZonesAt(lon, lat) : [];
    const asp = airspacesOn ? airspacesAt(lon, lat).filter(a => AIRSPACE_STYLES[a.t] && airspaceShown(a.t, a.c)).slice(0, 6) : [];
    if (!zones.length && !asp.length) return false;
    const key = '#layers:' + zones.map(z => z.id).join(',') + '|' + asp.map(a => a.n + a.t).join(',');
    if (mapTipIcao !== key) {
        mapTipIcao = key;
        const conflictHtml = zones.map(z => `
            <div class="map-tooltip-name">${escapeHtml(z.title)}</div>
            <div class="map-tooltip-row" style="color:${CONFLICT_STYLES[z.level].stroke}">${escapeHtml(CONFLICT_STYLES[z.level].label)}</div>
            <div class="map-tooltip-row">${escapeHtml(z.scope.replace(/\s+/g, ' '))}</div>
            <div class="map-tooltip-row" style="color:var(--text-dim)">${escapeHtml(z.id)} · valable jusqu'au ${escapeHtml(z.valid_until)}</div>`).join('');
        const aspHtml = asp.map(a => `
            <div class="map-tooltip-row"><b style="color:${AIRSPACE_STYLES[a.t].stroke}">${escapeHtml(AIRSPACE_STYLES[a.t].label)}${a.c ? ' · classe ' + escapeHtml(a.c) : ''}</b> ${escapeHtml(a.n)}
            <span style="color:var(--text-dim)"><br>${escapeHtml(a.lo || '?')} → ${escapeHtml(a.hi || '?')}</span></div>`).join('');
        mapTip.innerHTML = conflictHtml + aspHtml +
            `<div class="map-tooltip-hint">${zones.length ? 'Bulletins EASA (CZIB)' : ''}${zones.length && asp.length ? ' · ' : ''}${asp.length ? 'OpenAIP' : ''} : indicatif, ne pas utiliser pour la navigation</div>`;
    }
    mapTip.hidden = false;
    positionMapTip(clientX, clientY);
    return true;
}

function hideMapTip() {
    mapTipIcao = null;
    mapTip.hidden = true;
}

mapCanvas.addEventListener('pointerleave', hideMapTip);

applyTheme(theme, { save: false });   // boutons de thème synchronisés, couleurs des canvas

mapCanvas.addEventListener('pointerdown', (e) => {
    hideMapTip();
    try { mapCanvas.setPointerCapture(e.pointerId); } catch (err) { /* pointeur déjà relâché */ }
    mapPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    mapDown = mapPointers.size === 1 ? { x: e.clientX, y: e.clientY, t: Date.now() } : null;
    if (mapPointers.size === 2) {
        const [a, b] = [...mapPointers.values()];
        mapPinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    }
});

mapCanvas.addEventListener('pointermove', (e) => {
    const p = mapPointers.get(e.pointerId);
    if (!p) {
        const hit = mapHitAt(e.clientX, e.clientY);
        mapCanvas.style.cursor = hit ? 'pointer' : '';
        // Survol à la souris uniquement (pas de survol au doigt)
        if (hit && e.pointerType === 'mouse') showMapTip(hit.icao, e.clientX, e.clientY);
        else if (!hit && e.pointerType === 'mouse' && showLayerTip(e.clientX, e.clientY)) { /* infobulle de zone */ }
        else hideMapTip();
        return;
    }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (mapPointers.size === 1) {
        if (dx || dy) flightMap.userMoved = true;
        flightMap.cx -= dx / flightMap.scale;
        flightMap.cy -= dy / flightMap.scale;
        clampMapCenter();
        scheduleMapDraw();
    } else if (mapPointers.size === 2 && mapPinch) {
        flightMap.userMoved = true;
        const [a, b] = [...mapPointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const rect = mapCanvas.getBoundingClientRect();
        flightMap.cx -= (mx - mapPinch.mx) / flightMap.scale;
        flightMap.cy -= (my - mapPinch.my) / flightMap.scale;
        if (mapPinch.dist > 10) mapZoomAt(dist / mapPinch.dist, mx - rect.left, my - rect.top);
        mapPinch = { dist, mx, my };
        clampMapCenter();
        scheduleMapDraw();
    }
});

function mapPointerEnd(e) {
    mapPointers.delete(e.pointerId);
    if (mapPointers.size < 2) mapPinch = null;
    // Clic (pas de déplacement) sur le repère d'un aéroport : ouvre son diagramme de pistes
    if (e.type === 'pointerup' && mapDown && Math.hypot(e.clientX - mapDown.x, e.clientY - mapDown.y) < 6 && Date.now() - mapDown.t < 600) {
        const hit = mapHitAt(e.clientX, e.clientY);
        if (hit) openFlightAirport(hit.icao);
    }
    mapDown = null;
}
mapCanvas.addEventListener('pointerup', mapPointerEnd);
mapCanvas.addEventListener('pointercancel', mapPointerEnd);

mapCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    flightMap.userMoved = true;
    const rect = mapCanvas.getBoundingClientRect();
    mapZoomAt(Math.exp(-Math.max(-300, Math.min(300, e.deltaY)) * 0.002), e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });

mapCanvas.addEventListener('dblclick', (e) => {
    flightMap.userMoved = true;
    const rect = mapCanvas.getBoundingClientRect();
    mapZoomAt(1.6, e.clientX - rect.left, e.clientY - rect.top);
});

// Initialisation de l'application
initApp();
