# WHOOP · Live hartslag & HRV (PWA)

Mobile-first web-app die live hartslag en HRV uitleest van je eigen WHOOP 5.0-band via **Web Bluetooth**.
Plain HTML/CSS/JS, geen build-stap. Alle gegevens blijven lokaal (IndexedDB).

> Persoonlijk gebruik. Geen medisch advies. Niet verbonden aan WHOOP, Inc.

## Functies
- **Vandaag**: herstel (%), inspanning (0–21), slaap t.o.v. behoefte, inspanningsdoel op basis van herstel, stress, calorieën, rusthartslag, HRV, ademfrequentie, VO₂max-schatting, tijd in zones, slaapbehoefte met bedtijdadvies en een dagboek.
- **Live**: hartslag met zonekleur, grafiek van 60 s, live RMSSD, stressmonitor, inspanning en kcal. Trainingen opnemen per activiteit. Automatisch opnieuw verbinden.
- **Meten**
  - *HRV*: begeleide meting van 1 of 3 min met RMSSD, ln(RMSSD), SDNN, hartslag en ademfrequentie. Artefactfilter en vergelijking met je 7-daagse gemiddelde.
  - *Ademhaling*: ademhalingsbegeleider (4–10/min) met live hartslag en een samenvatting.
  - *Nacht*: slaapmeting met slaapfases (wakker/licht/diep/REM, hypnogram), inslaaptijd, efficiëntie, wakker-momenten, slaapcycli, slaapprestatie, laagste hartslag, nachtelijke HRV, ademfrequentie en herstel.
    - Houdt een iPhone wakker met een stille video-loop als Wake Lock ontbreekt.
    - Bewaart elke minuut tussentijds. Een onderbroken nacht (herladen, crash) kun je opslaan of hervatten.
    - Geen nachtmeting gedaan? Dan kun je je slaap handmatig invoeren.
- **Trends**: grafieken over 30 dagen (herstel, HRV, rusthartslag, inspanning, slaap, ademhaling), een weekrapport, een gezondheidsmonitor t.o.v. je eigen basis, dagboekinzichten, geschiedenis en CSV-export (metingen en dagen).
- **Instellingen**: zones (leeftijd, max- en rusthartslag), lichaam (voor kcal), slaapbehoefte, meetduur, thema en voorbeelddata.
- **Demo-modus** en **voorbeelddata van 3 weken**, zodat je alles zonder band kunt bekijken.

### Hoe de scores worden berekend (eigen benaderingen, niet die van WHOOP)
| Maat | Methode |
|---|---|
| Herstel | ln(RMSSD) en rusthartslag als z-score t.o.v. je laatste 30 dagen (zelfde soort meting), plus slaap. Kalibreert na 3 metingen. |
| Inspanning | Edwards-TRIMP (minuten × zonegewicht), omgezet naar 0–21 met 21·(1−e^(−TRIMP/180)) |
| Zones | Hartslagreserve (Karvonen). Max. hartslag via 208 − 0,7 × leeftijd (Tanaka), tenzij je die zelf invult. |
| Calorieën | Keytel e.a. (2005) bij inspanning, anders Mifflin-St Jeor |
| VO₂max | Uth–Sørensen: 15,3 × max. hartslag / rusthartslag |
| Ademfrequentie | Spectrale piek (0,1–0,5 Hz) van de respiratoire sinusaritmie in RR-intervallen |
| Slaapfases | Per minuut: hartslag, RMSSD (5 min) en hartslag-instabiliteit, genormaliseerd t.o.v. je eigen nacht. Diep = lage, stabiele hartslag met hoge HRV. REM = hogere, wisselende hartslag met lage HRV. Wakker = duidelijke piek. Inslapen = eerste 10 rustige minuten. Daarna gladgestreken. |
| Slaapprestatie / consistentie | Geslapen uren ÷ slaapbehoefte; spreiding van bed- en opsta-tijden (7 dagen) |
| Stress | Hartslag boven rust en daling van de live-RMSSD t.o.v. je basis, schaal 0–3 |

### Niet mogelijk via Web Bluetooth
ECG, bloeddruk, SpO₂, huidtemperatuur, onregelmatig-hartritmemeldingen, stappen en 24/7-meting op de achtergrond. De band deelt via Bluetooth alleen hartslag en RR-intervallen, en een webpagina kan niet op de achtergrond blijven meten. Voor slaap moet de pagina daarom open blijven (scherm zwart, telefoon aan de oplader). De slaapfases zijn een schatting zonder bewegingsdata en geen slaaplab.

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
| `js/metrics.js` | Herstel, inspanning, stress, kcal, VO₂max, ademfrequentie, nachtanalyse |
| `js/db.js` | IndexedDB |
| `js/chart.js` | Canvas-grafieken |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA |
| `assets/keepawake.mp4` | Stille video om een iPhone 's nachts wakker te houden |
