# AirportSketch - Airport Diagram Generator

Générateur et visualiseur interactif de schémas de pistes d'aéroports avec orientation géographique réelle, seuils décalés, dimensions à l'échelle et fréquences radio.

## Architecture des données

L'application utilise une architecture statique pré-compilée :

1. **Index de recherche léger (`data/search_index.json`)** :
   - Contient uniquement les métadonnées de base (ICAO, nom, IATA, type, pays, nombre de pistes) pour les ~11 400 aéroports avec pistes répertoriées.
   - Pèse ~230 Ko gzippé (~1,5 Mo brut) pour un chargement instantané au lancement.
   - Permet l'autocomplétion instantanée avec priorité aux grands aéroports internationaux.

2. **Fiches unitaires par aéroport (`data/airports/{ICAO}.json`)** :
   - Fichiers individuels très légers (~1 Ko chacun) chargés uniquement à la demande lors de la sélection.
   - Contient le détail complet : coordonnées précises des seuils de pistes, longueurs/largeurs, seuils décalés, et fréquences radio.

3. **Job nocturne automatisé (GitHub Actions)** :
   - Le workflow [`.github/workflows/nightly-update.yml`](.github/workflows/nightly-update.yml) s'exécute chaque nuit à **03h00 UTC**.
   - Il télécharge les dernières données OurAirports, génère le site et le déploie sur **GitHub Pages** sous forme d'artefact sans polluer l'historique Git.

4. **Recherche de vols & dossier de vol (AirLabs)** :
   - Le mode **Vol** de la recherche propose les vols en direct de la compagnie saisie (ex : `AF1…`), et le vol connu le plus proche (dernier ou prochain) quand le vol n'est pas en l'air.
   - Les données viennent de l'API [AirLabs](https://airlabs.co), appelée via un petit proxy **Cloudflare Worker** (`worker/`) qui garde la clé secrète et met les réponses en cache partagé Workers KV (2 min pour les vols en direct, 1 min pour un vol).
   - Un vol peut être partagé par URL : `?flight=AF173`.

---

## Service de vols (Cloudflare Worker)

1. Créez un compte sur [airlabs.co](https://airlabs.co) et récupérez votre clé d'API.
2. Déployez le proxy (compte Cloudflare gratuit requis) :
   ```bash
   cd worker
   npx wrangler login
   npx wrangler kv namespace create FLIGHT_CACHE   # puis reportez l'id' dans wrangler.toml
   npx wrangler secret put AIRLABS_API_KEY   # collez la clé AirLabs
   npx wrangler deploy                       # affiche l'URL https://airportsketch-flights.<compte>.workers.dev
   ```
3. Reportez cette URL dans `FLIGHT_API_PROD` dans `index.html`.

Si le site est servi depuis un autre domaine que `https://phedolro69.github.io`, ajoutez-le à `ALLOWED_ORIGINS` dans `worker/wrangler.toml`.

**En local**, le site appelle automatiquement `http://<hôte>:8787` :
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
Puis accédez à `http://localhost:8000`.
