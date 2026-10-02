# Plein Axe — diagrammes de pistes et suivi de vols

> Anciennement *AirportSketch* : le dépôt, l'adresse du site (`/airportsketch/`) et le worker (`airportsketch-flights`) gardent ce nom technique.

Générateur et visualiseur interactif de schémas de pistes d'aéroports avec orientation géographique réelle, seuils décalés, dimensions à l'échelle et fréquences radio, approches IFR par piste pour les aéroports américains, dossier de vol en direct et carte du vol (position de l'avion et aéroports le long de la route).

Un aéroport peut être ouvert directement par URL : `?icao=KJFK`.

## Utilisation du site

- **Recherche** : bascule **Vol / Aéroport** en haut du bandeau. En mode Aéroport, code OACI (`LFPG`), IATA (`CDG`), nom ou ville ; en mode Vol, numéro de vol (`AF173`, `AFR173`). Dans les listes de suggestions : **↑ / ↓** pour se déplacer, **Entrée** pour ouvrir (le premier aéroport si rien n'est surligné), **Échap** pour fermer.
- **Diagramme** : nom de l'aéroport en titre (dans la pastille d'info sur mobile), pistes à l'échelle orientées au nord géographique. Glisser pour déplacer, molette ou pincement pour zoomer, ⟲ pour recentrer, ⛶ pour le plein écran. Les pistes de moins de 2 000 m sont masquées par défaut ; le bouton « Afficher petites pistes » en haut du diagramme les montre, en violet pâle (un aéroport qui n'a que des petites pistes les affiche toujours).
- **Vol sélectionné** : le dossier de vol (horaires, retards, portes, progression) s'affiche en mode Vol ; en mode Aéroport il est mis de côté et réapparaît en revenant sur Vol. Les boutons *Diagramme départ · Diagramme arrivée · Carte* en haut de la zone principale restent disponibles dans les deux modes ; *Carte* ramène sur l'onglet Vol.
- **Aide** : le bouton « Que faire avec cette app ? » de l'en-tête présente toutes les fonctions.
- **Partage** : l'adresse suit ce qui est affiché (`?icao=KJFK`, `?flight=AF173`).

## Architecture des données

L'application utilise une architecture statique pré-compilée :

1. **Index de recherche léger (`data/search_index.json`)** :
   - Contient les métadonnées de base (ICAO, nom, IATA, type, pays, nombre de pistes) pour les ~11 400 aéroports avec pistes répertoriées, plus les coordonnées des ~1 800 aéroports « éligibles » de la carte du vol (voir [Carte du vol](#carte-du-vol)).
   - Pèse ~250 Ko gzippé (~1,6 Mo brut) pour un chargement instantané au lancement.
   - Permet l'autocomplétion instantanée avec priorité aux grands aéroports internationaux.

2. **Fiches unitaires par aéroport (`data/airports/{ICAO}.json`)** :
   - Fichiers individuels légers (~1 Ko en général, jusqu'à ~10 Ko pour les grands aéroports américains) chargés uniquement à la demande lors de la sélection.
   - Contient le détail complet : coordonnées précises des seuils de pistes, longueurs/largeurs, seuils décalés, et fréquences radio.
   - Les pistes de moins de 2000 m sont masquées par défaut quand l'aéroport a aussi des pistes plus longues ; le bouton « Afficher petites pistes » en haut du diagramme les montre, en violet pâle.
   - Pour les aéroports américains, les **approches IFR par seuil de piste** (voir [Approches IFR](#approches-ifr-faa) ci-dessous).

3. **Job nocturne automatisé (GitHub Actions)** :
   - Le workflow [`.github/workflows/nightly-update.yml`](.github/workflows/nightly-update.yml) s'exécute chaque nuit à **03h00 UTC**.
   - Il télécharge les dernières données OurAirports et FAA, génère le site et le déploie sur **GitHub Pages** sous forme d'artefact sans polluer l'historique Git.
   - Il se déclenche aussi à chaque push sur `main` qui modifie `index.html`, `style.css`, `js/`, `scripts/` ou le workflow.
   - La source de GitHub Pages doit être réglée sur **GitHub Actions** (Settings → Pages) : en « Deploy from a branch », le déploiement automatique de la branche écraserait le site sans le dossier `data/` (ignoré par Git).

4. **Recherche de vols & dossier de vol (AirLabs)** :
   - Le mode **Vol** de la recherche propose les vols en direct de la compagnie saisie (ex : `AF1…`), et le vol connu le plus proche (dernier ou prochain) quand le vol n'est pas en l'air.
   - Les données viennent de l'API [AirLabs](https://airlabs.co), appelée via un petit proxy **Cloudflare Worker** (`worker/`) qui garde la clé secrète et met les réponses en cache partagé Workers KV (10 min pour les vols en direct et pour un vol, 5 min pour une position) et protège le quota AirLabs (voir [Quota AirLabs](#quota-airlabs)).
   - Un vol peut être partagé par URL : `?flight=AF173`.
   - Un vol s'affiche sur une **carte** : position réelle de l'avion et aéroports le long de la route (voir [Carte du vol](#carte-du-vol)).

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

## Carte du vol

Quand un vol est sélectionné, des boutons en haut de la zone principale basculent entre les **diagrammes des aéroports de départ et d'arrivée** et la **carte du vol** (ex. *Diagramme CDG · Diagramme LYS · Carte*). Sur ordinateur, la carte s'ouvre toute seule à la sélection d'un vol ; sur mobile, via « Voir la route sur la carte » dans le dossier de vol.

Pour un vol en cours, le dossier de vol affiche une **barre de progression** et le **temps de vol restant**, calculés à partir du décollage réel et de l'arrivée estimée (actualisés toutes les 30 s), ainsi que la liste repliable des **aéroports le long de la route**.

**Ce que la carte montre**
- **l'avion à sa position réelle**, orienté selon son cap, avec altitude, vitesse sol et cap en haut à gauche (position reçue à l'ouverture de la carte, puis **estimée toutes les 20 s** par navigation à l'estime : l'avion avance le long de la route estimée vers l'arrivée à sa vitesse sol, déduite de l'heure d'arrivée si besoin, sans aucun appel au service ; le résumé indique « position estimée à hh:mm:ss » et l'heure de la dernière position reçue) ;
- **Parcouru** (trait plein discret) : route estimée du départ jusqu'à l'avion, **estimation** ;
- **Reste à parcourir** (pointillés) : route estimée de l'avion jusqu'à l'arrivée, **estimation** ;
- départ et arrivée : un clic ouvre le diagramme de pistes de l'aéroport ;
- **zoom sémantique** : zoomer fort (au-delà de 600 px par degré) près d'un aéroport de la carte ouvre son diagramme (molette ignorée 600 ms après la bascule, pour ne pas zoomer aussitôt le diagramme) ; dézoomer nettement ce diagramme (sous la moitié de son cadrage) ramène à la carte, centrée sur l'aéroport. Un diagramme ouvert autrement (bouton, recherche) ne renvoie pas à la carte. Zoom maximal de la carte : 1 500 px par degré (~75 m par pixel) ;
- **aéroports le long de la route** (étiquettes « Ville - CODE », aussi listés dans le dossier de vol dans l'ordre de passage, avec la distance latérale à gauche ou à droite ; un clic ouvre leur diagramme) : la route (départ → avion → arrivée si la position est connue) est échantillonnée tous les 50 nm, et en chaque point on retient les aéroports éligibles situés dans le **couloir** réglable de ± 100 à 300 nm, plus toujours les 2 plus proches (dégagements océaniques : Shannon, Keflavik, Gander…). Un `large_airport` dont la plus longue piste fait moins de 2 800 m est traité ici comme un `medium_airport` (champ `route_type` de l'index ; la recherche et la fiche de l'aéroport gardent le type OurAirports). Éligibles : grands aéroports, et aéroports moyens dont la plus longue piste fait au moins 2 500 m (coordonnées ajoutées à `search_index.json` pour ces ~1 800 aéroports). Grands aéroports en jaune vif, moyens en jaune pâle ;
- réglages (mémorisés dans le navigateur) : codes **OACI** (par défaut) ou IATA, largeur du couloir ;
- au survol d'un aéroport : nom, codes, type, nombre de pistes et piste la plus longue (hors pistes de moins de 2 000 m), approches IFR pour les terrains américains, et mini-diagramme des pistes ;
- pour un vol qui n'est pas en l'air (prévu, atterri, annulé) ou dont la position est indisponible : seule la **route directe estimée** est tracée, avec un message.

> Ni le **plan de vol déposé** ni la **trajectoire depuis le décollage** ne sont affichés : le plan n'est pas public vol par vol, et les réseaux ADS-B ouverts (adsb.lol, adsb.fi, airplanes.live, OpenSky) refusent les requêtes venant de Cloudflare — testé en octobre 2026. Une vraie trajectoire nécessiterait une API commerciale (ex. FlightAware AeroAPI). Information indicative, à ne pas utiliser pour la navigation.

**Données de position** : route `/track?callsign=AFR556` du worker (`worker/position.js`), qui interroge AirLabs `/flights` (même clé que la recherche de vols) : position, altitude, vitesse et cap actuels de l'avion. Quand la fiche du vol (`/flight`) contient déjà la position (cas d'AirLabs pour un vol en cours), le site l'utilise directement, sans appeler `/track`. Cache KV partagé de 5 min.

**Fond de carte** : dessiné par le site, sans tuiles, clé ni bibliothèque. Source [Natural Earth](https://www.naturalearthdata.com) 1:50m (domaine public, via le paquet `world-atlas`), converti par `scripts/make_world.py` en `scripts/assets/world.json` (255 Ko, ~90 Ko gzippé, versionné), copié dans `data/world.json` par `build_data.py` et chargé seulement à l'ouverture de la carte. Projection Mercator, répétée en longitude (les vols transpacifiques traversent la ligne de changement de date sans coupure). Pour régénérer le fond (changer la résolution) : `python scripts/make_world.py`.

**Limites** : seuls les vols en cours ont une position ; le trajet tracé est une estimation (grand cercle, ou route contournant la Russie, l'Ukraine et le Bélarus) et non la route réelle ; pas de noms d'airways.

---

### Routes estimées : jamais au-dessus de la Russie, de l'Ukraine ni du Bélarus

Toutes les routes estimées (tracé, avancée de l'avion toutes les 20 s, liste des aéroports le long de la route, vols de démo, simulateur local) évitent ces trois espaces aériens :

- **Plus court chemin** : si le grand cercle traverse une zone, le site calcule le plus court trajet qui la contourne (graphe de visibilité sur la sphère entre les coins des contours, algorithme A*). Ce trajet devient la route estimée.
- **Couloirs imposés** (réalité opérationnelle, plus long que le plus court chemin) : Europe → Japon/Corée par la Turquie, Erevan et Urumqi ; Japon/Corée → Europe par le Pacifique nord, le détroit de Béring et le Groenland. Chaque tronçon est lui aussi contourné si besoin.
- **Position de l'avion** : si la position reçue est à moins de 60 nm de la route estimée, l'avion est calé dessus ; sinon la route passe par sa position réelle.
- **Code** : `scripts/airspace.py` construit les zones (Natural Earth, simplifiées à 0,15°) et la matrice de visibilité, écrites dans `world.json` (clé `avoid`, relu par `make_world.py`) et `worker/avoid.json`. Le routeur JavaScript du site (bloc `airspace-router` de `js/airspace-router.js`) est recopié dans `worker/airspace.js` par `python scripts/sync_airspace.py` (`--check` vérifie qu'il est à jour).
- **Test** : `python scripts/airspace.py` calcule 24 routes (CDG↔NRT, FRA→PVG, HEL→PEK…) et vérifie, sur les contours **complets** et non simplifiés, qu'aucun point à moins de 5 nm n'est dans une zone.

## Météo (METAR / TAF)

- **Source** : API Data de NOAA Aviation Weather Center (`aviationweather.gov/api`), gratuite et sans clé, couverture mondiale (environ 97 % des grands aéroports et 80 % des moyens ont un METAR). Elle n'envoie pas d'en-têtes CORS : le site passe par la route `GET /wx?ids=LFPG,KJFK[&taf=1]` du worker (`worker/weather.js`), qui renvoie un format compact (METAR, et TAF si `taf=1`). Aucun lien avec le quota AirLabs ; cache en mémoire du worker (METAR 5 min, TAF 15 min), aucune écriture KV ; 150 codes OACI au plus par requête.
- **Carte du vol** : le départ, l'arrivée et les aéroports affichés le long de la route sont colorés selon la catégorie de vol de leur METAR — **VFR** vert, **MVFR** bleu, **IFR** rouge, **LIFR** magenta ; la taille du point indique le type d'aéroport (grand / moyen). Sans METAR, l'aéroport garde sa couleur neutre. La légende et la liste du dossier de vol (pastille devant chaque code) reprennent ces couleurs.
- **Infobulle au survol** (PC) et **fiche de l'aéroport** (panneau latéral) : catégorie, vent, visibilité, nuages, phénomènes, température / point de rosée, QNH, METAR brut, puis TAF décodé période par période. Une pastille de catégorie figure aussi sous le titre du diagramme.
- **Simulateur local** (`worker/mock_airlabs.py`) : la route `/wx` renvoie par défaut une météo simulée (hors ligne, même format compact que le worker), déterministe par aéroport et par heure, avec un mélange de VFR / MVFR / IFR / LIFR et des aéroports sans METAR ou sans TAF. `&mock=fog|mist|rain|snow|storm|gusty|hot|cavok` force la météo de tous les aéroports demandés (ou `--wx-scenario fog` au lancement), `ZZZZ` n'a ni METAR ni TAF, `XXXX` provoque une erreur 502. `--wx real` interroge NOAA pour de vrai.

## NOTAM

- **Source** : [SkyLink API](https://skylinkapi.com/docs/v3/notams/) (flux FAA SWIM, NOTAM mondiaux), offre gratuite de 1 000 appels par mois : secret `SKYLINK_API_KEY` du worker (`npx wrangler secret put SKYLINK_API_KEY`). Sans ce secret, la section NOTAM n'apparaît pas. La FAA NMS-API (gratuite, accès demandé à notams@faa.gov) pourra remplacer SkyLink dans `worker/notam.js` sans changer le format de réponse.
- **Route** `GET /notam?id=LFPG` : un aéroport par requête, réservée au **mode réel** (code d'accès) pour protéger le quota ; cache KV 6 h par aéroport (absences comprises) ; au plus `NOTAM_DAILY_BUDGET` appels réels par jour (25 par défaut, soit ~750 par mois). Les NOTAM « checklist » (`QK…`) sont écartés.
- **Importance**, calculée par le site (`classifyNotam` dans `js/app.js`) d'après le code Q (sujet + état), à défaut d'après le texte : **critique** (rouge) — aérodrome ou piste fermés, piste raccourcie, ILS / approche hors service ; **important** (orange) — voie de circulation fermée, radionavigation, balisage, obstacles, espace aérien, carburant, procédures ; **information** (gris, repliée) — le reste. Seuls les NOTAM en vigueur ou commençant dans les 24 h sont montrés (« À venir »).
- **Affichage** : fiche de l'aéroport (sous la météo) et, dans le dossier de vol, un résumé « NOTAM 2 critiques · 3 importants » sous le départ et l'arrivée, qui ouvre l'aéroport.
- **Simulateur local** : `/notam` renvoie 7 NOTAM fictifs couvrant les trois niveaux (dont un à venir) ; `ZZZZ` n'en a aucun, `XXXX` provoque une erreur 502.

## Mise en page grand écran

À partir de 1 360 px de large, les infos et les pistes de l'aéroport s'affichent dans un **deuxième panneau latéral**, à droite du premier : le dossier de vol et sa liste d'aéroports restent sous les yeux pendant qu'on clique d'un aéroport à l'autre. Sur écran plus étroit ou téléphone, tout reste dans le panneau unique (onglet « Détails & Pistes »).

## Thème clair / sombre

Le site est sombre par défaut. Le bouton ☀ / ☾ de l'en-tête (et la ligne « Thème » des réglages de la carte, avec les codes et le couloir) bascule en **mode clair** pour toute l'application : panneaux, carte (fond Natural Earth clair), schéma des pistes, infobulles, aide. Le choix est mémorisé dans le navigateur (`pleinaxe.theme`) et appliqué avant le premier affichage, sans clignotement.

- **CSS** : toutes les couleurs neutres et pastel passent par des variables (`--n-…` pour la palette neutre, nommée d'après sa valeur sombre, `--p-…` pour les pastels, `--ov` / `--ps` / `--pp` / `--pd` pour les voiles translucides). Le thème clair (`:root[data-theme="light"]`) les redéfinit ; pour un nouvel élément, utiliser ces variables plutôt qu'une couleur en dur.
- **Canvas** : les couleurs de la carte (`MAP_THEMES`) et du schéma de pistes (`DIAGRAM_THEMES`) ont une version par thème, appliquées par `applyTheme()`.
- **Barres de défilement** : fines et violettes, dans les deux thèmes.

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

Routes du worker : `/live`, `/flight` et `/track` (AirLabs avec le code d'accès, démo sinon), `/config` (mode actif et vols de démo) et `/usage` (appels AirLabs du jour et budget). Le worker est déployé à la main (`npx wrangler deploy`) : le workflow GitHub ne met à jour que le site.

### Mode démo et données réelles

Par défaut, **tous les visiteurs voient 20 vols de démonstration** : fictifs mais réalistes (vraies routes, horaires recalculés par rapport à l'heure actuelle, vols en cours avec position, prévus, retardé, atterri, annulé), générés par le worker (`worker/demo.js`) **sans aucun appel à AirLabs**. Le site l'indique clairement (encart « Mode démo » sous la recherche de vol, étiquette DÉMO dans le dossier, légende de la carte), et en mode démo la liste des vols s'affiche dès le clic dans le champ.

Les **vraies données** (AirLabs) sont réservées au propriétaire, et c'est le worker qui en décide :
1. enregistrer un code secret : `cd worker && npx wrangler secret put LIVE_ACCESS_CODE` ;
2. ouvrir une fois le site avec `?code=VOTRE_CODE` : le navigateur retient le code (le paramètre est aussitôt retiré de l'adresse) et l'envoie au worker (en-tête `X-Access-Code`) ; une pastille « Données réelles » apparaît dans l'en-tête ;
3. `?code=off` revient à la démo.

Sans le bon code, le worker sert la démo, quoi que fasse le site. Pour ouvrir les vraies données à tous (offre payante par exemple) : `DATA_MODE = "live"` dans `worker/wrangler.toml` (ou dans le tableau de bord Cloudflare), puis `npx wrangler deploy`. La route `/config` indique le mode actif.

### Quota AirLabs

L'offre gratuite d'AirLabs est de **1 000 requêtes par mois**. Seules les requêtes absentes du cache comptent ; le worker les protège (`worker/budget.js`) :
- **caches partagés** (Workers KV) : 10 min pour la liste des vols d'une compagnie et pour une fiche de vol, 5 min pour une position ; le site garde aussi la liste 10 min ;
- **pas de rappel du service** pour suivre l'avion : la position fournie par `/flight` est réutilisée, puis extrapolée toutes les 20 s dans le navigateur ;
- **budget quotidien** `DAILY_BUDGET` (30 par défaut, dans `wrangler.toml`) : au-delà, plus aucun appel à AirLabs jusqu'au lendemain (UTC), les vols déjà en cache restent servis et le site affiche « Limite quotidienne de suivi des vols atteinte » ;
- **limite par visiteur** : 10 appels réels par minute et par adresse IP (binding Cloudflare Rate Limiting `LIMITER`) ;
- **quota mensuel épuisé** côté AirLabs : message « Quota mensuel du service de vols épuisé ».

Suivi de la consommation du jour : `https://airportsketch-flights.<compte>.workers.dev/usage`. Pour plus de volume, AirLabs propose une offre payante (25 000 requêtes/mois).

**En local**, le site appelle automatiquement `http://<hôte>:8787`. Deux options (une seule à la fois sur ce port) :

- **Simulateur (recommandé pour développer)** : vols générés localement, sans clé ni quota AirLabs, sans Node.
  ```bash
  python worker/mock_airlabs.py              # --delay 800 pour simuler un réseau lent
  ```
  Vols déterministes et cohérents avec l'heure courante. Cas de test : `AF1` en vol, `AF2` prévu, `AF3` atterri,
  `AF4` annulé, `AF5` retardé de 45 min, `AF9999` inconnu, compagnie `ZZ` sans vol en cours, `XX` erreur AirLabs (502).
  `/track` simule la position des vols en cours (sans historique, comme en production) ;
  `AF429` simule un quota AirLabs atteint (503), `ZZZ…` un vol sans position.
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

## Couches de la carte du vol

Deux couches facultatives, activables dans les réglages de la carte :

- **Zones de conflit** : `scripts/build_conflict_zones.py` lit chaque nuit les bulletins CZIB actifs de l'EASA (page publique, texte parsé : FIR concernées, recommandation, validité) et dessine les FIR correspondantes (contours du [VATSpy Data Project](https://github.com/vatsimnetwork/vatspy-data-project), CC-BY-SA 4.0). Rouge = « ne pas opérer », orange = prudence. Résultat : `data/conflict_zones.json`. Si l'EASA change sa mise en page, le script échoue et le site est déployé sans la couche.

Données indicatives : ne pas utiliser pour la navigation.
