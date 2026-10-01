#!/usr/bin/env python3
"""
Approches IFR des aéroports américains, à partir des données publiques de la FAA :
  - d-TPP (digital Terminal Procedures Publication) : liste officielle des cartes
    d'approche par aéroport, avec le PDF de chaque carte.
  - CIFP (Coded Instrument Flight Procedures, ARINC 424) : catégorie, fréquence,
    axe et pente de chaque ILS.

Les deux jeux sont publiés tous les 28 jours (cycle AIRAC).

Résultat : {ident_aeroport: {piste_normalisee: [approche, ...]}}, où chaque approche vaut
  {"type": "ILS"|"LOC"|"RNAV"|"VOR"|"NDB"|"VIS", "cat": 1-3 (ILS seulement),
   "name": "ILS OR LOC RWY 04R", "pdf": "00610IL4R.PDF", "ils": {...} (si connu)}
"""

import datetime
import io
import os
import re
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

USER_AGENT = "Mozilla/5.0 (AirportSketch-DataBuilder)"
DTPP_META_URL = "https://aeronav.faa.gov/d-tpp/{cycle}/xml_data/d-TPP_Metafile.xml"
DTPP_PDF_BASE = "https://aeronav.faa.gov/d-tpp/{cycle}/"
CIFP_ZIP_URL = "https://aeronav.faa.gov/Upload_313-d/cifp/CIFP_{date:%y%m%d}.zip"
CIFP_PAGE_URL = "https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/download/"

# Référence AIRAC : le cycle 2001 est entré en vigueur le 2 janvier 2020
AIRAC_EPOCH = datetime.date(2020, 1, 2)

# Ordre d'affichage des types (du plus précis au moins précis)
TYPE_ORDER = {"ILS": 0, "LOC": 1, "RNAV": 2, "VOR": 3, "NDB": 4, "VIS": 5}

ROMAN = {"I": 1, "II": 2, "III": 3}


def airac_cycle(day: datetime.date):
    """Retourne (identifiant 'YYNN', date d'entrée en vigueur) du cycle AIRAC en cours à `day`."""
    n = (day - AIRAC_EPOCH).days // 28
    effective = AIRAC_EPOCH + datetime.timedelta(days=28 * n)
    first_of_year = AIRAC_EPOCH + datetime.timedelta(
        days=28 * -(-(datetime.date(effective.year, 1, 1) - AIRAC_EPOCH).days // 28))
    number = (effective - first_of_year).days // 28 + 1
    return f"{effective:%y}{number:02d}", effective


def _download(url: str, timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def normalize_runway(ident: str) -> str:
    """'04L' -> '4L', 'RW04L' -> '4L' : permet de rapprocher OurAirports et la FAA."""
    ident = ident.strip().upper()
    if ident.startswith("RW"):
        ident = ident[2:]
    m = re.match(r"^0*(\d{1,2})([LRC]?)$", ident)
    return f"{m.group(1)}{m.group(2)}" if m else ident


def runways_in_chart_name(name: str):
    """'VOR OR GPS RWY 13L/R' -> ['13L', '13R'] ; 'VOR-A' -> []."""
    result = []
    for num, sides in re.findall(r"RWY\s+(\d{1,2})((?:[LRC])(?:/[LRC])*)?", name):
        for side in (sides.split("/") if sides else [""]):
            result.append(normalize_runway(num + side))
    return result


def classify_chart(name: str):
    """Types d'approche couverts par une carte, d'après son nom officiel."""
    n = name.upper()
    if n.startswith("COPTER"):
        return []
    types = []
    if "VISUAL" in n:
        return ["VIS"]
    if re.search(r"\b(ILS|GLS)\b", n):
        types.append("ILS")
    elif re.search(r"\b(LOC|LDA|SDF)\b", n):
        types.append("LOC")
    if re.search(r"\b(RNAV|RNP|GPS)\b", n):
        types.append("RNAV")
    if re.search(r"\b(VOR|TACAN)\b", n):
        types.append("VOR")
    if re.search(r"\bNDB\b", n):
        types.append("NDB")
    return types


def chart_ils_category(name: str) -> int:
    """'ILS RWY 04R (CAT II - III)' -> 3 ; 'ILS OR LOC RWY 04L' -> 1."""
    cats = [ROMAN[c] for c in re.findall(r"CAT\s*(I{1,3})\b", name.upper())]
    cats += [ROMAN[c] for c in re.findall(r"CAT\s*I{1,3}\s*-\s*(I{1,3})\b", name.upper())]
    return max(cats) if cats else 1


def parse_dtpp(xml_bytes: bytes):
    """{ident_aeroport: [(nom_carte, pdf), ...]} pour les cartes d'approche (IAP)."""
    charts = {}
    root = ET.fromstring(xml_bytes)
    for apt in root.iter("airport_name"):
        records = [(r.findtext("chart_name") or "", r.findtext("pdf_name") or "")
                   for r in apt.findall("record") if r.findtext("chart_code") == "IAP"]
        if not records:
            continue
        for key in {apt.get("icao_ident") or "", apt.get("apt_ident") or ""}:
            if key:
                charts.setdefault(key.upper(), []).extend(records)
    return charts


def parse_cifp_ils(cifp_text: str):
    """{ident_aeroport: {piste_normalisee: {ident, cat, mhz, crs, gs}}} depuis les enregistrements ILS (PI)."""
    ils = {}
    for line in cifp_text.splitlines():
        # Section P (aéroport), sous-section I (localizer/glide), enregistrement principal
        if len(line) < 97 or line[0] != "S" or line[4] != "P" or line[12] != "I" or line[21] not in "01":
            continue
        try:
            entry = {
                "ident": line[13:17].strip(),
                "cat": int(line[17]) if line[17] in "123" else 1,
                "mhz": int(line[22:27]) / 100,
                "crs": int(line[51:55]) / 10,
            }
            gs = line[87:90].strip()
            if gs.isdigit() and int(gs) > 0:
                entry["gs"] = int(gs) / 100
        except ValueError:
            continue
        airport = line[6:10].strip().upper()
        ils.setdefault(airport, {})[normalize_runway(line[27:32])] = entry
    return ils


def download_cifp_zip(effective: datetime.date) -> bytes:
    """Télécharge le zip CIFP du cycle entré en vigueur à `effective`."""
    urls = [CIFP_ZIP_URL.format(date=effective)]
    try:
        page = _download(CIFP_PAGE_URL, timeout=60).decode("utf-8", errors="replace")
        wanted = f"CIFP_{effective:%y%m%d}.zip"
        urls += [u for u in re.findall(r"https?://[^\"']+CIFP_\d{6}\.zip", page) if u.endswith(wanted) and u not in urls]
    except (urllib.error.URLError, TimeoutError):
        pass
    last_error = None
    for url in urls:
        try:
            data = _download(url, timeout=180)
            zipfile.ZipFile(io.BytesIO(data)).testzip()
            print(f"[faa] CIFP: {url}")
            return data
        except (urllib.error.URLError, TimeoutError, zipfile.BadZipFile) as e:
            last_error = e
    raise RuntimeError(f"CIFP indisponible ({last_error})")


def cifp_text(zip_bytes: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        name = next(n for n in z.namelist() if n.upper().startswith("FAACIFP"))
        return z.read(name).decode("latin-1")


class FaaCache:
    """
    Fichiers FAA bruts par cycle (dtpp_2610.xml, cifp_2610.zip) : un seul téléchargement
    par cycle AIRAC, et repli sur le dernier cycle connu si la FAA est injoignable.
    Sans dossier, rien n'est mis en cache.
    """

    def __init__(self, directory: str = None):
        self.dir = directory
        if self.dir:
            os.makedirs(self.dir, exist_ok=True)

    def _path(self, name):
        return os.path.join(self.dir, name) if self.dir else None

    def get(self, name):
        path = self._path(name)
        if path and os.path.exists(path):
            with open(path, "rb") as f:
                return f.read()
        return None

    def put(self, name, data):
        path = self._path(name)
        if path:
            with open(path, "wb") as f:
                f.write(data)

    def latest_dtpp_cycle(self):
        if not self.dir:
            return None
        cycles = sorted(m.group(1) for n in os.listdir(self.dir) if (m := re.match(r"^dtpp_(\d{4})\.xml$", n)))
        return cycles[-1] if cycles else None

    def keep_only(self, cycle):
        """Supprime les fichiers des autres cycles et note le cycle utilisé (pour la clé de cache CI)."""
        if not self.dir:
            return
        for n in os.listdir(self.dir):
            if re.match(r"^(dtpp|cifp)_\d{4}\.", n) and f"_{cycle}." not in n:
                os.remove(os.path.join(self.dir, n))
        with open(os.path.join(self.dir, "CYCLE"), "w") as f:
            f.write(cycle)


def build_approaches(today: datetime.date = None, cache_dir: str = None):
    """
    Retourne (cycle, pdf_base, {ident_aeroport: {piste_normalisee: [approche, ...]}}).
    Lève une exception si aucun d-TPP n'est disponible (ni en ligne ni en cache) :
    l'appelant décide de continuer sans.
    """
    cache = FaaCache(cache_dir)
    today = today or datetime.datetime.now(datetime.timezone.utc).date()
    current = airac_cycle(today)
    previous = airac_cycle(current[1] - datetime.timedelta(days=1))

    # d-TPP : cycle en cours, sinon le précédent (publication en retard), sinon le dernier en cache
    meta, cycle, effective = None, None, None
    for c, eff in (current, previous):
        meta = cache.get(f"dtpp_{c}.xml")
        if meta:
            print(f"[faa] d-TPP cycle {c} : cache")
        else:
            try:
                meta = _download(DTPP_META_URL.format(cycle=c))
                cache.put(f"dtpp_{c}.xml", meta)
                print(f"[faa] d-TPP cycle {c} : téléchargé ({len(meta):,} octets)")
            except (urllib.error.URLError, TimeoutError) as e:
                print(f"[faa] d-TPP cycle {c} indisponible ({e})")
        if meta:
            cycle, effective = c, eff
            break
    if not meta:
        cycle = cache.latest_dtpp_cycle()
        if not cycle:
            raise RuntimeError("d-TPP indisponible et aucun cycle en cache")
        meta = cache.get(f"dtpp_{cycle}.xml")
        print(f"[faa] FAA injoignable : repli sur le cycle {cycle} en cache")
    charts = parse_dtpp(meta)

    # CIFP : facultatif, enrichit les ILS (catégorie, fréquence, axe, pente)
    cifp_ils = {}
    zip_bytes = cache.get(f"cifp_{cycle}.zip")
    if zip_bytes:
        print(f"[faa] CIFP cycle {cycle} : cache")
    elif effective:
        try:
            zip_bytes = download_cifp_zip(effective)
            cache.put(f"cifp_{cycle}.zip", zip_bytes)
        except RuntimeError as e:
            print(f"[faa] {e}")
    if zip_bytes:
        cifp_ils = parse_cifp_ils(cifp_text(zip_bytes))
    else:
        print("[faa] sans CIFP : catégories ILS déduites des seuls noms de cartes")

    cache.keep_only(cycle)

    result = {}
    for airport, records in charts.items():
        by_rwy = {}
        for name, pdf in records:
            types = classify_chart(name)
            if not types:
                continue
            for rwy in runways_in_chart_name(name):
                for t in types:
                    app = {"type": t, "name": name, "pdf": pdf}
                    if t == "ILS":
                        ils = cifp_ils.get(airport, {}).get(rwy)
                        app["cat"] = max(chart_ils_category(name), ils["cat"] if ils else 1)
                        if ils:
                            app["ils"] = {k: v for k, v in ils.items() if k != "cat"}
                    by_rwy.setdefault(rwy, []).append(app)
        for apps in by_rwy.values():
            apps.sort(key=lambda a: (TYPE_ORDER[a["type"]], -a.get("cat", 0), a["name"]))
        if by_rwy:
            result[airport] = by_rwy

    total = sum(len(a) for r in result.values() for a in r.values())
    print(f"[faa] {total:,} approches ({len(result):,} identifiants d'aéroport)")
    return cycle, DTPP_PDF_BASE.format(cycle=cycle), result


if __name__ == "__main__":
    import json
    import sys
    cycle, base, data = build_approaches(cache_dir=os.environ.get("FAA_CACHE_DIR"))
    ident = (sys.argv[1] if len(sys.argv) > 1 else "KJFK").upper()
    print(f"cycle {cycle} — {base}")
    print(json.dumps(data.get(ident, {}), indent=1, ensure_ascii=False))
