#!/usr/bin/env python3
"""
AirportSketch Data Builder
Downloads CSV datasets from OurAirports, extracts airports with valid runway coordinates,
and generates:
  1. data/search_index.json (lightweight search index for fast autocomplete)
  2. data/airports/{ICAO}.json (individual JSON per airport with runways and frequencies,
     plus IFR approaches per runway end for US airports, from FAA d-TPP/CIFP)
"""

import argparse
import csv
import io
import json
import math
import os
import re
import shutil
import sys
import time
import urllib.request

from faa_approaches import build_approaches, normalize_runway

RUNWAYS_URL = "https://davidmegginson.github.io/ourairports-data/runways.csv"
AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
FREQUENCIES_URL = "https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv"

# Pays couverts par la FAA (États-Unis et territoires) pour les approches IFR
FAA_COUNTRIES = {"US", "PR", "VI", "GU", "AS", "MP", "UM"}

TYPE_PRIORITY = {
    "large_airport": 1,
    "medium_airport": 2,
    "small_airport": 3,
    "heliport": 4,
    "seaplane_base": 5,
    "balloonport": 6,
    "closed": 7
}


# Longueur de piste minimale d'un medium_airport pour figurer parmi les aéroports de la route (dégagements)
ELIGIBLE_MIN_RUNWAY_M = 2500


def longest_runway_m(runways):
    """Plus longue piste, calculée depuis les coordonnées des seuils (comme le schéma du site)."""
    best = 0.0
    for r in runways:
        p1, p2 = math.radians(r["le_lat"]), math.radians(r["he_lat"])
        dl = math.radians(r["he_lon"] - r["le_lon"])
        c = math.sin(p1) * math.sin(p2) + math.cos(p1) * math.cos(p2) * math.cos(dl)
        best = max(best, math.acos(max(-1.0, min(1.0, c))) * 6371000)
    return best


def neighbour_runways(key: str):
    """'5L' -> ['4L', '6L'] ; '36' -> ['35', '1']."""
    m = re.match(r"^(\d{1,2})([LRC]?)$", key)
    if not m:
        return []
    n, side = int(m.group(1)), m.group(2)
    return [f"{(n + d - 1) % 36 + 1}{side}" for d in (-1, 1)]


def download_csv(url: str, name: str) -> str:
    print(f"[{name}] Downloading from {url}...")
    t0 = time.time()
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "AirportSketch-DataBuilder/1.0"}
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        content = resp.read().decode("utf-8", errors="replace")
    print(f"[{name}] Downloaded {len(content):,} characters in {time.time() - t0:.2f}s")
    return content


def build_data(output_dir: str, copy_html: bool = True, faa_cache: str = None):
    start_time = time.time()
    print(f"Starting data build into: {output_dir}")

    # 1. Download CSVs
    raw_runways = download_csv(RUNWAYS_URL, "runways")
    raw_airports = download_csv(AIRPORTS_URL, "airports")
    raw_freqs = download_csv(FREQUENCIES_URL, "frequencies")

    # 2. Parse runways
    print("Parsing runways...")
    runways_by_airport = {}
    reader_runways = csv.DictReader(io.StringIO(raw_runways))
    total_valid_runways = 0

    for row in reader_runways:
        ident = row.get("airport_ident", "").strip().upper()
        if not ident:
            continue

        try:
            le_lat = float(row["le_latitude_deg"])
            le_lon = float(row["le_longitude_deg"])
            he_lat = float(row["he_latitude_deg"])
            he_lon = float(row["he_longitude_deg"])
        except (ValueError, KeyError, TypeError):
            # Skip runways that do not have valid start/end GPS coords
            continue

        width_ft = 150.0
        if row.get("width_ft"):
            try:
                width_ft = float(row["width_ft"])
            except ValueError:
                width_ft = 150.0

        le_disp = 0.0
        if row.get("le_displaced_threshold_ft"):
            try:
                le_disp = max(0.0, float(row["le_displaced_threshold_ft"]))
            except ValueError:
                le_disp = 0.0

        he_disp = 0.0
        if row.get("he_displaced_threshold_ft"):
            try:
                he_disp = max(0.0, float(row["he_displaced_threshold_ft"]))
            except ValueError:
                he_disp = 0.0

        runway_obj = {
            "le_ident": row.get("le_ident") or "LE",
            "he_ident": row.get("he_ident") or "HE",
            "le_lat": le_lat,
            "le_lon": le_lon,
            "he_lat": he_lat,
            "he_lon": he_lon,
            "width_ft": width_ft,
            "le_disp_ft": le_disp,
            "he_disp_ft": he_disp
        }

        runways_by_airport.setdefault(ident, []).append(runway_obj)
        total_valid_runways += 1

    print(f"Processed {total_valid_runways:,} valid runways across {len(runways_by_airport):,} airports.")

    # 3. Parse frequencies
    print("Parsing frequencies...")
    freqs_by_airport = {}
    reader_freqs = csv.DictReader(io.StringIO(raw_freqs))
    total_freqs = 0

    for row in reader_freqs:
        ident = row.get("airport_ident", "").strip().upper()
        if not ident or ident not in runways_by_airport:
            continue

        freqs_by_airport.setdefault(ident, []).append({
            "type": row.get("type") or "FREQ",
            "description": row.get("description") or "",
            "mhz": row.get("frequency_mhz") or "-"
        })
        total_freqs += 1

    print(f"Processed {total_freqs:,} radio frequencies for airports with runways.")

    # 4. Parse airports
    print("Parsing airports and preparing files...")
    airports_meta = {}
    alt_codes = {}
    reader_airports = csv.DictReader(io.StringIO(raw_airports))

    for row in reader_airports:
        ident = row.get("ident", "").strip().upper()
        if not ident:
            continue

        elev = None
        if row.get("elevation_ft"):
            try:
                elev = float(row["elevation_ft"])
            except ValueError:
                elev = None

        lat = 0.0
        if row.get("latitude_deg"):
            try:
                lat = float(row["latitude_deg"])
            except ValueError:
                lat = 0.0

        lon = 0.0
        if row.get("longitude_deg"):
            try:
                lon = float(row["longitude_deg"])
            except ValueError:
                lon = 0.0

        airports_meta[ident] = {
            "ident": ident,
            "name": row.get("name") or ident,
            "type": row.get("type") or "small_airport",
            "lat": lat,
            "lon": lon,
            "elev_ft": elev,
            "country": row.get("iso_country") or "N/A",
            "municipality": row.get("municipality") or "N/A",
            "iata": row.get("iata_code") or "-",
            "home_link": row.get("home_link") or ""
        }
        # Codes alternatifs pour rapprocher les données FAA (ex. OurAirports "US-1234" / FAA "1B1")
        alt_codes[ident] = [c.strip().upper() for c in (row.get("gps_code"), row.get("local_code")) if c and c.strip()]

    # 4b. IFR approaches (US, FAA) - optional: the build continues without them on failure
    print("Fetching FAA instrument approaches...")
    approaches_by_airport, approaches_cycle, approaches_pdf_base = {}, None, None
    try:
        approaches_cycle, approaches_pdf_base, approaches_by_airport = build_approaches(cache_dir=faa_cache)
    except Exception as e:
        print(f"[faa] WARNING: approaches skipped ({e})")

    # Prepare target directories
    data_dir = os.path.join(output_dir, "data")
    airports_dir = os.path.join(data_dir, "airports")
    os.makedirs(airports_dir, exist_ok=True)

    # 5. Generate individual airport JSON files
    search_index = []
    written_airports = 0
    airports_with_approaches = 0

    print("Writing individual airport JSON files...")
    for ident, runways in runways_by_airport.items():
        meta = airports_meta.get(ident)
        if not meta:
            # Fallback if airport metadata row was missing
            meta = {
                "ident": ident,
                "name": ident,
                "type": "small_airport",
                "lat": runways[0]["le_lat"],
                "lon": runways[0]["le_lon"],
                "elev_ft": None,
                "country": "N/A",
                "municipality": "N/A",
                "iata": "-",
                "home_link": ""
            }

        airport_data = {
            **meta,
            "runways": runways,
            "frequencies": freqs_by_airport.get(ident, [])
        }

        # Approches IFR indexées par seuil de piste, avec les identifiants OurAirports
        faa = None
        if meta["country"] in FAA_COUNTRIES:
            faa = next((approaches_by_airport[c] for c in [ident, *alt_codes.get(ident, [])]
                        if c in approaches_by_airport), None)
        if faa:
            approaches = {}
            ends = [e for rw in runways for e in (rw["le_ident"], rw["he_ident"])]
            exact = {normalize_runway(e) for e in ends} & faa.keys()
            for end in ends:
                key = normalize_runway(end)
                if key not in faa:
                    # Numérotation périmée côté OurAirports (dérive magnétique) : piste voisine à ±1,
                    # seulement si elle n'est pas déjà attribuée et sans ambiguïté
                    candidates = [k for k in neighbour_runways(key) if k in faa and k not in exact]
                    key = candidates[0] if len(candidates) == 1 else None
                if key:
                    approaches[end] = faa[key]
            if approaches:
                airport_data["approaches"] = approaches
                airport_data["approaches_cycle"] = approaches_cycle
                airport_data["approaches_pdf_base"] = approaches_pdf_base
                airports_with_approaches += 1

        # Write {ident}.json
        file_path = os.path.join(airports_dir, f"{ident}.json")
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(airport_data, f, separators=(",", ":"), ensure_ascii=False)

        # Add to search index
        entry = {
            "ident": ident,
            "name": meta["name"],
            "iata": meta["iata"] if meta["iata"] != "-" else "",
            "type": meta["type"],
            "country": meta["country"],
            "municipality": meta["municipality"],
            "runways": len(runways)
        }
        # Coordonnées des aéroports « éligibles » seulement (carte du vol : aéroports le long de la route,
        # dégagements océaniques compris), sans alourdir l'index pour les ~10 000 autres :
        # large_airport, ou medium_airport dont la plus longue piste fait au moins 2 500 m
        eligible = meta["type"] == "large_airport" or (
            meta["type"] == "medium_airport" and longest_runway_m(runways) >= ELIGIBLE_MIN_RUNWAY_M)
        if eligible and (meta["lat"] or meta["lon"]):
            entry["lat"] = round(meta["lat"], 4)
            entry["lon"] = round(meta["lon"], 4)
        search_index.append(entry)
        written_airports += 1

    # Sort search index:
    # Priority: major airports first, then by runway count, then alphabetical
    def sort_key(item):
        priority = TYPE_PRIORITY.get(item["type"], 99)
        return (priority, -item["runways"], item["ident"])

    search_index.sort(key=sort_key)

    # 6. Write search_index.json
    search_index_path = os.path.join(data_dir, "search_index.json")
    print("Writing search_index.json...")
    with open(search_index_path, "w", encoding="utf-8") as f:
        json.dump(search_index, f, separators=(",", ":"), ensure_ascii=False)

    index_size = os.path.getsize(search_index_path)
    print(f"search_index.json created: {index_size:,} bytes ({index_size/1024:.1f} KB)")

    # 6b. Fond de carte vectoriel de la carte des vols (généré par make_world.py, versionné)
    world_src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "world.json")
    if os.path.exists(world_src):
        shutil.copy2(world_src, os.path.join(data_dir, "world.json"))
        print(f"Copied world.json ({os.path.getsize(world_src):,} bytes)")
    else:
        print("WARNING: scripts/assets/world.json missing - flight map background unavailable")

    # 7. Optionally copy index.html
    if copy_html:
        root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        src_html = os.path.join(root_dir, "index.html")
        dst_html = os.path.join(output_dir, "index.html")
        if os.path.exists(src_html) and os.path.abspath(src_html) != os.path.abspath(dst_html):
            print(f"Copying index.html to {dst_html}...")
            shutil.copy2(src_html, dst_html)

    elapsed = time.time() - start_time
    print(f"Build completed successfully in {elapsed:.2f}s!")
    print(f"  - Total airports generated: {written_airports:,}")
    print(f"  - Total runways: {total_valid_runways:,}")
    print(f"  - Total frequencies: {total_freqs:,}")
    print(f"  - Airports with IFR approaches: {airports_with_approaches:,}")
    print(f"  - Output directory: {os.path.abspath(output_dir)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build AirportSketch static datasets")
    parser.add_argument(
        "--output",
        "-o",
        default="dist",
        help="Target output directory (default: 'dist')"
    )
    parser.add_argument(
        "--no-html",
        action="store_true",
        help="Do not copy index.html into the output directory"
    )
    parser.add_argument(
        "--faa-cache",
        default=".cache/faa",
        help="Cache directory for raw FAA files, one download per AIRAC cycle (default: '.cache/faa', '' to disable)"
    )
    args = parser.parse_args()
    build_data(output_dir=args.output, copy_html=not args.no_html, faa_cache=args.faa_cache or None)
