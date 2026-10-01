#!/usr/bin/env python3
"""
AirportSketch Data Builder
Downloads CSV datasets from OurAirports, extracts airports with valid runway coordinates,
and generates:
  1. data/search_index.json (lightweight search index for fast autocomplete)
  2. data/airports/{ICAO}.json (individual JSON per airport with runways and frequencies)
"""

import argparse
import csv
import io
import json
import os
import shutil
import sys
import time
import urllib.request

RUNWAYS_URL = "https://davidmegginson.github.io/ourairports-data/runways.csv"
AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
FREQUENCIES_URL = "https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv"

TYPE_PRIORITY = {
    "large_airport": 1,
    "medium_airport": 2,
    "small_airport": 3,
    "heliport": 4,
    "seaplane_base": 5,
    "balloonport": 6,
    "closed": 7
}


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


def build_data(output_dir: str, copy_html: bool = True):
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

    # Prepare target directories
    data_dir = os.path.join(output_dir, "data")
    airports_dir = os.path.join(data_dir, "airports")
    os.makedirs(airports_dir, exist_ok=True)

    # 5. Generate individual airport JSON files
    search_index = []
    written_airports = 0

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

        # Write {ident}.json
        file_path = os.path.join(airports_dir, f"{ident}.json")
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(airport_data, f, separators=(",", ":"), ensure_ascii=False)

        # Add to search index
        search_index.append({
            "ident": ident,
            "name": meta["name"],
            "iata": meta["iata"] if meta["iata"] != "-" else "",
            "type": meta["type"],
            "country": meta["country"],
            "municipality": meta["municipality"],
            "runways": len(runways)
        })
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
    args = parser.parse_args()
    build_data(output_dir=args.output, copy_html=not args.no_html)
