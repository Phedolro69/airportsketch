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
