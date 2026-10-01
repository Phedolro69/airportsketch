# AirportSketch - Airport Diagram Generator

Générateur et visualiseur interactif de schémas de pistes d'aéroports avec orientation géographique réelle, seuils décalés, dimensions à l'échelle et fréquences radio, approches IFR par piste pour les aéroports américains, et dossier de vol en direct.

Un aéroport peut être ouvert directement par URL : `?icao=KJFK`.

## Architecture des données

L'application utilise une architecture statique pré-compilée :

1. **Index de recherche léger (`data/search_index.json`)** :
   - Contient uniquement les métadonnées de base (ICAO, nom, IATA, type, pays, nombre de pistes) pour les ~11 400 aéroports avec pistes répertoriées.
   - Pèse ~230 Ko gzippé (~1,5 Mo brut) pour un chargement instantané au lancement.
   - Permet l'autocomplétion instantanée avec priorité aux grands aéroports internationaux.

2. **Fiches unitaires par aéroport (`data/airports/{ICAO}.json`)** :
   - Fichiers individuels légers (~1 Ko en général, jusqu'à ~10 Ko pour les grands aéroports américains) chargés uniquement à la demande lors de la sélection.
   - Contient le détail complet : coordonnées précises des seuils de pistes, longueurs/largeurs, seuils décalés, et fréquences radio.
   - Pour les aéroports américains, les **approches IFR par seuil de piste** (voir [Approches IFR](#approches-ifr-faa) ci-dessous).

3. **Job nocturne automatisé (GitHub Actions)** :
   - Le workflow [`.github/workflows/nightly-update.yml`](.github/workflows/nightly-update.yml) s'exécute chaque nuit à **03h00 UTC**.
   - Il télécharge les dernières données OurAirports et FAA, génère le site et le déploie sur **GitHub Pages** sous forme d'artefact sans polluer l'historique Git.
   - Il se déclenche aussi à chaque push sur `main` qui modifie `index.html`, `scripts/` ou le workflow.
   - La source de GitHub Pages doit être réglée sur **GitHub Actions** (Settings → Pages) : en « Deploy from a branch », le déploiement automatique de la branche écraserait le site sans le dossier `data/` (ignoré par Git).

4. **Recherche de vols & dossier de vol (AirLabs)** :
   - Le mode **Vol** de la recherche propose les vols en direct de la compagnie saisie (ex : `AF1…`), et le vol connu le plus proche (dernier ou prochain) quand le vol n'est pas en l'air.
   - Les données viennent de l'API [AirLabs](https://airlabs.co), appelée via un petit proxy **Cloudflare Worker** (`worker/`) qui garde la clé secrète et met les réponses en cache partagé Workers KV (2 min pour les vols en direct, 1 min pour un vol).
   - Un vol peut être partagé par URL : `?flight=AF173`.

---

## Approches IFR (FAA)

Pour ~2 900 aéroports américains, chaque seuil de piste affiche ses approches aux instruments publiées, sur le schéma (dans le prolongement de l'axe) et dans la liste des pistes.

**Affichage** : une pastille par type d'approche, de la plus précise à la moins précise.

| Pastille | Signification |
|---|---|
| `ILS CAT I` / `ILS CAT II` / `ILS CAT III` (vert, de plus en plus plein) | ILS, catégorie maximale publiée pour ce seuil |
| `LOC` (vert-gris) | localizer seul (LOC, LDA, SDF), affiché seulement sans ILS |
| `RNAV` (magenta) | RNAV (GPS), RNAV (RNP), GPS |
| `VOR` / `NDB` (ambre) | approches classiques (VOR, TACAN, NDB) |
| `VIS` (gris) | approche à vue publiée |

Un clic sur une pastille ouvre la carte d'approche officielle (PDF FAA), ou propose le choix quand la pastille regroupe plusieurs cartes. Information indicative : **ne pas utiliser pour la navigation**.

**Sources** (publiques, mises à jour tous les 28 jours au cycle AIRAC) :
- [d-TPP](https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dtpp/) : liste officielle des cartes d'approche par aéroport et leurs PDF ;
- [CIFP](https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/download/) (ARINC 424) : catégorie, fréquence, axe et pente de chaque ILS.

**Extraction** (`scripts/faa_approaches.py`, appelé par `build_data.py`) :
- le cycle AIRAC en cours est calculé automatiquement (repli sur le précédent si le nouveau n'est pas encore publié) ;
- chaque carte est classée d'après son nom officiel (`ILS OR LOC RWY 04R`, `RNAV (GPS) Y RWY 22L`, `VOR OR GPS RWY 13L/R`…) et rattachée aux seuils qu'il cite ;
- les numéros de piste OurAirports parfois périmés (dérive magnétique, ex. `01/19` au lieu de `02/20`) sont rapprochés à ±1 quand il n'y a pas d'ambiguïté ;
- non affichées : approches indirectes sans piste (`RNAV (GPS)-A`) et approches hélicoptère.

**Format** dans `data/airports/{ICAO}.json` (clés = identifiants de seuil OurAirports) :
```json
"approaches_cycle": "2610",
"approaches_pdf_base": "https://aeronav.faa.gov/d-tpp/2610/",
"approaches": {
  "04R": [
    { "type": "ILS", "cat": 3, "name": "ILS OR LOC RWY 04R", "pdf": "00610IL4R.PDF",
      "ils": { "ident": "IJFK", "mhz": 109.5, "crs": 43.8, "gs": 3.0 } },
    { "type": "RNAV", "name": "RNAV (GPS) Y RWY 04R", "pdf": "00610RY4R.PDF" }
  ]
}
```

**Cache par cycle** : les fichiers FAA bruts (~25 Mo) sont gardés dans `.cache/faa/` (ignoré par Git) et ne sont téléchargés qu'une fois par cycle AIRAC. En CI, ce dossier est conservé entre les runs via `actions/cache`. Si la FAA est injoignable, le build réutilise le dernier cycle en cache ; sans cache, il continue sans approches plutôt que d'échouer.

---

## Service de vols (Cloudflare Worker)

1. Créez un compte sur [airlabs.co](https://airlabs.co) et récupérez votre clé d'API.
2. Déployez le proxy (compte Cloudflare gratuit requis) :
   ```bash
   cd worker
   npx wrangler login
   npx wrangler kv namespace create FLIGHT_CACHE   # puis reportez l'id dans wrangler.toml
   npx wrangler secret put AIRLABS_API_KEY   # collez la clé AirLabs
   npx wrangler deploy                       # affiche l'URL https://airportsketch-flights.<compte>.workers.dev
   ```
3. Reportez cette URL dans `FLIGHT_API_PROD` dans `index.html`.

Si le site est servi depuis un autre domaine que `https://phedolro69.github.io`, ajoutez-le à `ALLOWED_ORIGINS` dans `worker/wrangler.toml`.

**En local**, le site appelle automatiquement `http://<hôte>:8787`. Deux options (une seule à la fois sur ce port) :

- **Simulateur (recommandé pour développer)** : vols générés localement, sans clé ni quota AirLabs, sans Node.
  ```bash
  python worker/mock_airlabs.py              # --delay 800 pour simuler un réseau lent
  ```
  Vols déterministes et cohérents avec l'heure courante. Cas de test : `AF1` en vol, `AF2` prévu, `AF3` atterri,
  `AF4` annulé, `AF5` retardé de 45 min, `AF9999` inconnu, compagnie `ZZ` sans vol en cours, `XX` erreur AirLabs (502).
- **Vraie API via le worker** (consomme le quota AirLabs) :
  ```bash
  cd worker
  echo "AIRLABS_API_KEY=votre_cle" > .dev.vars   # fichier ignoré par Git
  npx wrangler dev --ip 0.0.0.0                  # 0.0.0.0 pour tester aussi depuis un téléphone
  ```

---

## Utilisation locale

### 1. Générer les données
Pour mettre à jour ou générer les données localement :
```bash
python scripts/build_data.py --output . --no-html
```
Les fichiers FAA sont mis en cache dans `.cache/faa/` (un téléchargement par cycle AIRAC) ; `--faa-cache ""` désactive le cache.

Pour tester seulement l'extraction des approches d'un aéroport :
```bash
cd scripts && python faa_approaches.py KJFK
```

Pour générer le build complet de production dans `dist/` :
```bash
python scripts/build_data.py --output dist
```

### 2. Lancer le serveur local
En raison des requêtes `fetch()` pour charger les fichiers JSON, ouvrez l'application via un serveur HTTP local :
```bash
# Avec Python
python -m http.server 8000

# Ou avec Node.js
npx serve .
```
Puis accédez à `http://localhost:8000` (ex. `http://localhost:8000/?icao=KJFK`).

Pour la recherche de vols en local, lancez aussi le simulateur : `python worker/mock_airlabs.py` (voir [Service de vols](#service-de-vols-cloudflare-worker)).
