# WHOOP · Live hartslag & HRV (PWA)

Mobile-first web-app die live hartslag en HRV uitleest van je eigen WHOOP 5.0-band via **Web Bluetooth**.
Plain HTML/CSS/JS, geen build-stap. Alle gegevens blijven lokaal (IndexedDB).

> Persoonlijk gebruik. Geen medisch advies. Niet verbonden aan WHOOP, Inc.

## Functies
- **Live**: groot hartslaggetal met zonekleur, grafiek van 60 s, live RMSSD, batterij en verbindingsstatus, automatisch opnieuw verbinden, sessie-opname.
- **HRV-meting**: begeleide meting van 1 of 3 minuten. RMSSD, ln(RMSSD), SDNN, gemiddelde hartslag. Artefactfilter (RR buiten 300–2000 ms of >20% afwijkend van het vorige interval) en vergelijking met je 7-daagse gemiddelde.
- **Ademhaling**: ademhalingsbegeleider (standaard 6/min, instelbaar 4–10) met live hartslag en samenvatting.
- **Geschiedenis**: trendgrafiek (RMSSD, 30 dagen, met 7-daags gemiddelde), lijst, CSV-export per item of alles, verwijderen.
- **Instellingen**: leeftijd / max. hartslag / rusthartslag (zones volgens hartslagreserve), standaard meetduur, thema.
- **Demo-modus** met gesimuleerde hartslag en RR-intervallen, zodat je alles zonder band kunt testen.
- PWA: werkt offline na het eerste bezoek.

## Voorbereiding van de band
1. Open de officiële WHOOP-app en zet **Hartslag uitzenden** (Heart Rate Broadcast) aan.
2. Sluit de WHOOP-app daarna helemaal af.
3. Open deze app in **Bluefy** (iPhone) of **Chrome/Edge** (Android, desktop) en tik op **Verbind met WHOOP**.
   Zie je je band niet? Gebruik **Toon alle apparaten**.

Safari ondersteunt geen Web Bluetooth. Een icoon op het iPhone-beginscherm opent in Safari, dus daar werken alleen demo en geschiedenis. Gebruik voor de live verbinding Bluefy. Let op: Safari en Bluefy hebben elk hun eigen opslag, dus metingen staan in de browser waarin je ze deed.

## Op GitHub Pages zetten
1. Push deze map naar een GitHub-repository (de bestanden staan in de root).
2. Ga op GitHub naar **Settings → Pages**.
3. Kies bij *Source* **Deploy from a branch**, selecteer je branch (bijv. `main`) en map **/ (root)**, en klik op **Save**.
4. Na ongeveer een minuut staat de app op `https://<gebruikersnaam>.github.io/<repository>/`. GitHub Pages gebruikt automatisch HTTPS, en dat is nodig voor Web Bluetooth.

**Netlify** kan ook: sleep de map naar <https://app.netlify.com/drop>.

### Updates uitrollen
Verhoog na een wijziging `VERSION` in `sw.js` (bijv. `whoop-v2`), zodat de service worker de nieuwe bestanden ophaalt.

## Lokaal testen
```sh
python3 -m http.server 8000
# open http://localhost:8000 (localhost telt als beveiligde omgeving)
```

## Bestanden
| Bestand | Inhoud |
|---|---|
| `index.html` | Alle schermen, tabbalk, onboarding |
| `css/styles.css` | Design tokens, donker/licht thema, componenten |
| `js/app.js` | UI-logica, schermen, opslag, export |
| `js/ble.js` | Web Bluetooth, parser voor 0x2A37, batterij, herverbinden |
| `js/demo.js` | Simulator (bouwt echte 0x2A37-pakketten) |
| `js/hrv.js` | Artefactfilter, RMSSD, SDNN |
| `js/db.js` | IndexedDB |
| `js/chart.js` | Canvas-grafieken |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA |
