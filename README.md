# Malaysia IPU Dashboard

A simple website that shows the current official Air Pollutant Index (IPU / API) for every Department of Environment (DOE) monitoring station in Malaysia, lets you look up a state, town, school or station, and predicts whether schools in that area may close because of haze.

- **Readings:** DOE's Air Pollutant Index Management System (APIMS), read every hour.
- **History:** DOSM's published monthly air pollution statistics (context only).
- **Closure rule:** the National Haze Action Plan (PTJK) rule KPM has applied since 15 Oct 2026. Schools close immediately once the IPU reaches 200, and outdoor activities stop above 100.
- **Predictions are not announcements.** The site says so on every prediction.

It runs for free on GitHub: a scheduled GitHub Action fetches APIMS every hour, saves the data and republishes the site on GitHub Pages. You don't need a server or database.

---

## Setting it up (about 10 minutes, free)

You need a free GitHub account.

1. **Create a repository.** On github.com, choose **New repository**. Name it, for example `malaysia-ipu`, and make it **Public**. GitHub Pages is free for public repositories.
2. **Upload the files.** In the new repository, choose **Add file → Upload files**. Drag in everything from this folder (`docs`, `scripts`, `tests`, `data_sources`, `README.md`), then choose **Commit changes**.
   - The `.github` folder is hidden on most computers, so it often doesn't upload. If `.github/workflows/update.yml` is missing in the repository after uploading, choose **Add file → Create new file**. Type the name `.github/workflows/update.yml`, paste in the contents of that file from this folder, and commit.
3. **Turn on Pages.** Go to **Settings → Pages**. Under *Build and deployment → Source*, choose **GitHub Actions**.
4. **Allow the workflow to save data.** Go to **Settings → Actions → General → Workflow permissions**, choose **Read and write permissions**, and save.
5. **Run it once.** Open the **Actions** tab and select **Hourly IPU update**. Choose **Run workflow**. After about a minute, the run shows the site address, usually `https://<your-username>.github.io/malaysia-ipu/`.

From then on, it updates automatically at minute 20 of every hour. GitHub sometimes starts scheduled runs a few minutes late.

**If something goes wrong:** open the **Actions** tab. A run with a yellow warning or red cross means APIMS could not be read that hour. The website keeps the last readings and shows a red "Data may be outdated" notice until a later run succeeds. It never relabels old readings as current.

---

## Adding the official school list (recommended)

School search works best with the Ministry of Education's (KPM) official school list, which includes each school's coordinates. I couldn't download it while building this, so the site starts without it. Until you add it, schools and towns are found with OpenStreetMap place search, and the site labels those results as unofficial.

1. Download KPM's school list (*Senarai Sekolah Rendah dan Menengah*) as `.xlsx` or `.csv` from KPM's website or the government open-data portal. Use a version that includes the coordinate columns `KOORDINATXX` and `KOORDINATYY`.
2. In your repository, open the `data_sources/schools/` folder, choose **Add file → Upload files**, and add the file.
3. The next run (or **Run workflow**) builds `docs/data/schools.json`. The search then finds schools by name, and towns and districts by the average position of their schools.

The converter (`scripts/build_schools.py`) also accepts columns named `LATITUDE`/`LONGITUDE`. It skips title rows above the header and fixes swapped coordinate columns. Schools without usable coordinates are counted and left out, never guessed.

---

## How it works

### 1. How APIMS readings are retrieved
The official portal (`https://eqms.doe.gov.my/APIMS/main`) loads its data from two public JSON endpoints. This project calls the same ones, once an hour:

| Endpoint | What it gives |
|---|---|
| `…/api3/publicmapproxy/PUBLIC_DISPLAY/CAQM_MCAQM_Current_Reading/MapServer/0/query` | Latest reading for every station: `STATION_ID`, `STATION_LOCATION`, `STATE_NAME`, `STATE_ID`, `LATITUDE`, `LONGITUDE`, `DATETIME`, `API`, `PARAM_SYMBOL` (dominant pollutant) |
| `…/api3/publicportalapims/apitablehourly?stateid=N&datetime=YYYY-MM-DD HH:00:00` | The last 24 hourly API values for every station in one state, with ISO timestamps |

That is about 17 small requests an hour. The APIMS dataset is listed as public and open on MOSTI's MASTIC open-data register, and bulk historical data can be requested from DOE at btm.doe.gov.my. These endpoints are not a documented API, though. If DOE changes them, updates stop and the site marks its data as outdated. `scripts/fetch_apims.py` is the only file that would need changing.

### 2. Station identifiers, timestamps and coordinates
All three are in the data. One quirk: the map service stores the Malaysia clock time in a field labelled UTC. For example, `1792245600000` means 14:00 Malaysia time, not 14:00 UTC. The fetcher reads it that way. The hourly table uses plain Malaysia-time timestamps, and if it has a newer hour than the map service, that newer reading is used. A missing or negative value is stored as "no reading".

### 3. Matching a school or town to a station
- The reference station is the **nearest station with a current reading**, measured as straight-line distance from the school, town or place.
- The site always shows the distance, and lists the next nearest stations with their readings.
- If the nearest station has no current reading, the site says so and uses the next one.
- It also adds a note when the reference station is more than 40 km away, or when stations within 30 km read 30+ points apart.
- The station reading is always labelled as the reference station's reading, never as a measurement at the school.

A reading counts as current if it is no more than 3 hours old.

### 4. The school-closure rule (`docs/data/rule.json`)
Since **15 Oct 2026**, KPM has followed the National Haze Action Plan (PTJK). Schools in the affected area close **immediately** once the IPU reaches **200**, and outdoor activities stop above **100**. From 8 to 14 Oct 2026, KPM used an interim stricter rule (close from the next day above 180, or above 150 for three consecutive days).

How the site applies the rule:
- **Threshold reached today:** the latest reading at the reference station, or any hourly reading earlier today, is 200 or more.
- **If reached:** "Schools in this area may be closed tomorrow". PTJK closure is immediate, so it may already apply today.
- **If not reached:** "Closure threshold not reached" at the latest available reading.
- **Treatment of exactly 200:** the minister's statement says "reaches 200", while some reports say "exceeds 200". The site counts 200 itself as reaching the threshold.
- **No-school days:** weekends are shown as no-school days. Kedah, Kelantan and Terengganu have Friday–Saturday weekends; all other states have Saturday–Sunday. The 2026 year-end school holidays are also included. Public holidays are not.
- **Unavailable:** with no current reading at the reference station, no prediction is shown.

Closures are actually decided and announced by KPM, JPN and PPD. If the rule changes, edit `rule.json`: the threshold, comparison, dates, wording and sources all live there, and the page reads them from it.

### 5. Limits of the historical data
- **DOSM's monthly air pollution dataset** has national monthly average concentrations (PM2.5, PM10, gases). It is not IPU, not per station, and when this was built its latest month was **December 2024**. The site shows it as a labelled context chart only and never uses it as a current reading. It is refreshed at most weekly.
- **APIMS hourly history:** the site keeps the last 48 hours per station. That is enough for "today" and the 24-hour chart. Long-term station-level history needs a data request to DOE.

---

## Forecast estimate and haze sources

These two features are kept apart from the official data and are labelled on the page.

- **Forecast (estimate, not official):** `scripts/fetch_forecast.py` downloads the CAMS PM2.5 forecast (Copernicus Atmosphere Monitoring Service, via Open-Meteo) for every station at most every 3 hours, and scales it to that station's official IPU over the last 24 hours. It writes `docs/data/forecast.json`. It is never used for the official reading or the school-closure check, which use DOE APIMS only.
- **Where the haze comes from:** `scripts/fetch_sources.py` reads NASA FIRMS satellite fire detections (VIIRS, last 24 hours; anything older than 36 hours is never shown) and the current 10 m wind from the Open-Meteo weather model. It writes `docs/data/sources.json`. The map's "Where the haze comes from" button shows the hotspots and animated wind.

## Air paths, coverage zones and the IPU explainer

- **Where this air came from (model estimate):** `scripts/fetch_sources.py` also saves 3 days of hourly low-level wind (925 hPa, about 800 m up; Open-Meteo) to `docs/data/wind_history.json`. When a school, town, place or your location is selected, the page traces the air backwards through that wind for up to 3 days, shows the path on the map (in "Where the haze comes from" mode, instead of the general wind flow) and counts the fire hotspots within 25 km of the route.
- **Which station covers me:** with "Use my location", the map divides the country into the area closest to each station with a current reading and highlights the one you are in.
- **How the IPU works:** an interactive section near the bottom explains the six pollutants, the 24-hour average and why the IPU lags behind visible haze, using an illustration with made-up numbers.

## Official closure announcements (Bernama only)

- `docs/data/announcements.json` lists official school closures. Every entry needs an area (states, districts or school codes), dates, what it covers, who announced it and at least one **Bernama** source link. The page ignores any entry whose sources are not on bernama.com.
- Where a school or place falls inside an announced closure, the closure check shows **Officially closed** with the dates and the Bernama link, instead of the IPU prediction. Closed areas are hatched on the map, and the header shows a banner.
- `docs/data/boundaries.json` holds the official district boundaries from data.gov.my (simplified with `scripts/build_boundaries.py`), used to find which state and district a place is in.
- `scripts/check_announcements.py` validates the file; the tests run it on every change.
- A scheduled task checks Bernama every hour from about 6 am to 7 pm Malaysia time and updates the file (procedure: `scripts/ANNOUNCEMENTS_CHECK.md`).

## Rule vs reality

`scripts/rule_vs_reality.py` runs every hour. For each official closure (Bernama sources only) it compares the official DOE APIMS readings in the closed area with the national rule (schools close once the IPU reaches 200): the 24 hours and 3 days before the announcement, and the highest reading on each day from 2 days before to the end of the closure. Older hours come from the APIMS hourly table, which keeps about a week, and are saved in `data_cache/closure_hours.json` so they are not lost. The result, `docs/data/rule_reality.json`, is shown under each closure and in the closure check.

## Watch lists, school-day dose and Hear the haze

- **Rising fastest:** stations whose official IPU rose most over the last 6 hours.
- **Unusual readings:** stations that differ by 40 or more (and by at least a third) from the middle value of the other stations within 60 km. Flagged on the map, in the table and on the station card; readings are never changed.
- **School-day dose (estimate):** from the official PM2.5 24-hour average at the reference station, and children's breathing rates from the US EPA Exposure Factors Handbook (chapter 6, table 6-2), compared with the WHO 2021 24-hour guideline (15 µg/m³).
- **Hear the haze:** under the Accessibility button (top right). When switched on, each 24-hour chart gets a Listen button that plays the readings as tones. The setting is remembered on that device.

## Files

```
docs/                    the website (published to GitHub Pages)
  index.html, style.css  page and styles (map-first, responsive)
  vendor/maplibre/       map engine (MapLibre GL JS 4.7.1)
  logic.js               categories, matching, prediction, search (pure functions, tested)
  app.js                 page behaviour, charts, search, hourly re-read of the data
  data/latest.json       current readings (written by the hourly job)
  data/rule.json         closure rule, weekends, holidays, sources
  data/schools.json      KPM school list, once added
  data/dosm_monthly.json DOSM history (written by the job)
scripts/
  fetch_apims.py         reads APIMS; keeps old data and marks it failed if DOE is unreachable
  fetch_dosm.py          downloads DOSM monthly data (weekly)
  build_schools.py       converts the KPM school list (.xlsx/.csv)
data_sources/schools/    put the KPM school list here
tests/                   python3 -m unittest discover -s tests ; node --test tests/logic.test.js
.github/workflows/update.yml   the hourly job
```

Everything uses only the Python standard library and plain JavaScript, so there is nothing to install. The tests run automatically whenever you change code, but not on the hourly runs.

**Running it on your own computer (optional).** You need Python 3 and an internet connection that can reach DOE:
```
python3 scripts/fetch_apims.py
python3 -m http.server 8000 -d docs
```
Then open http://localhost:8000.

## Credits and notices
- Readings: Department of Environment Malaysia, APIMS.
- Map: MapLibre GL JS (BSD-3-Clause, included in `docs/vendor/maplibre`), map tiles from OpenFreeMap (© OpenMapTiles, © OpenStreetMap contributors). If the tiles can't load, the map falls back to a simple Natural Earth outline of Malaysia (`docs/data/malaysia-outline.json`).
- Historical statistics: OpenDOSM (CC BY 4.0).
- Place search: © OpenStreetMap contributors, via the Nominatim service. The site sends at most one search per second, and only when you press Search.
- This is an independent dashboard, not an official government service.
