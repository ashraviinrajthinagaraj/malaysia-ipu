# Daily check: official school closure announcements (Bernama only)

This procedure is run every evening by a scheduled task. It keeps
`docs/data/announcements.json` up to date so the site shows official haze
school closures correctly. Follow it exactly.

## Hard rules

1. **Bernama only.** Use only articles on `bernama.com` (https). Never use any
   other website, social media post or news outlet, even to confirm. If a closure
   is not reported by Bernama, it is not added.
2. **Never guess.** Add or change an entry only when the Bernama article states the
   area and the dates (or a start date and a number of days). If anything is
   unclear, do not add it; mention it in the run summary instead.
3. **Only official decisions.** An announcement must come from an authority:
   the Ministry of Education (KPM) or the Education Minister, a state government
   or its education committee chairman (Exco), a State Education Department (JPN),
   a District Education Office (PPD), or a state or national haze/disaster
   committee. Appeals, opinions, parents' requests, and other countries' closures
   are ignored.
4. **Only haze closures of schools** (and the educational institutions the
   announcement names). Closures for other reasons are ignored.
5. Only edit `docs/data/announcements.json`. Never delete past entries.

## Steps

1. Read `docs/data/announcements.json` to see the current entries, and
   `docs/data/boundaries.json` for the exact state and district names
   (fields `state` and `district`).
2. Search Bernama for haze school closure news from the **last 3 days**, in
   Bahasa Melayu and English. Use several searches, for example:
   - `Bernama sekolah ditutup jerebu`
   - `Bernama penutupan sekolah jerebu dilanjutkan`
   - `Bernama sekolah dibuka semula jerebu`
   - `Bernama PdPR jerebu`
   - `Bernama schools closed haze`
   - `Bernama schools reopen haze`
   Restrict searches to bernama.com where the search tool allows it, and drop
   every result that is not on bernama.com.
3. Open each relevant Bernama article and note: the authority, the announcement
   date, the area (whole state, listed districts, or listed schools), the
   dates, what is covered and not covered, home-based learning (PdPR), and
   exceptions.
4. Work out the dates:
   - Explicit dates: use them.
   - "N days from Monday" (or another start day): count N consecutive days from
     that start date. Example: announced Saturday 17 Oct, "five more days from
     Monday" = 19 Oct to 23 Oct.
   - "Until further notice": set `until_further_notice: true`, `from` = the
     first closed day, and `to` = tomorrow's date. On each later run, while
     Bernama has not reported a reopening, move `to` forward to the next day.
   - The dates are Malaysia dates (`YYYY-MM-DD`).
5. Update the file:
   - **New closure:** add an entry (see the format below). The `id` is
     `<area-slug>-<from-date>`, for example `johor-2026-10-19` or
     `johor-batu-pahat-2026-10-21`.
   - **Extension:** add a new entry for the new dates, with `previous`
     describing the closure it extends.
   - **Early reopening:** set `to` on the existing entry to the day before
     schools reopen, add the Bernama article to its `sources`, and explain in
     `dates_note`.
   - **Same closure reported again:** do not add a duplicate; you may add the
     new Bernama link to `sources`.
   - Always set `checked_at` to the current Malaysia time
     (e.g. `2026-10-18T22:45:00+08:00`). Set `updated_at` and the entry's
     `added_at` when closures change.
6. Area names must match `boundaries.json` exactly:
   - Whole states: `"area": {"states": ["Johor"]}`.
   - Districts: `"area": {"state": "Johor", "districts": ["Batu Pahat", "Muar"]}`.
   - Schools are added only when the article gives KPM school codes:
     `"area": {"school_codes": ["JBA0001"]}`. Otherwise mention them in the summary.
   - State names in the boundaries include `W.P. Kuala Lumpur`, `W.P. Putrajaya`,
     `W.P. Labuan` and `Pulau Pinang`.
7. Validate, then test:
   ```
   python3 scripts/check_announcements.py
   python3 -m unittest discover -s tests
   node --test tests/logic.test.js
   ```
   If validation fails, fix the entry. If you cannot make it valid without
   guessing, remove your new entry and report it in the summary.
8. Commit and push (only `docs/data/announcements.json`):
   ```
   git add docs/data/announcements.json
   git commit -m "Closures check <date>: <short summary>"
   git pull --rebase origin main
   git push origin HEAD:main
   ```
   Push even when only `checked_at` changed, so the site shows when the last
   check happened.
9. Finish with a short summary: what Bernama reported, what changed, the links
   used, and anything skipped and why.

## Entry format

```json
{
  "id": "johor-2026-10-19",
  "area": { "states": ["Johor"] },
  "from": "2026-10-19",
  "to": "2026-10-23",
  "dates_note": "Five more days starting Monday 19 October.",
  "covers": "All schools and educational institutions throughout Johor.",
  "not_covered": "Private educational institutions and childcare centres decide for themselves.",
  "learning": "Home-based teaching and learning (PdPR) continues.",
  "exceptions": "Limited exemptions for exam candidates, coordinated with JPNJ.",
  "announced_by": "Name, role, body",
  "announced_on": "2026-10-17",
  "previous": "Extends the closure from 12 to 16 October.",
  "sources": [
    { "title": "Exact Bernama headline", "url": "https://www.bernama.com/...", "published": "2026-10-17T22:09:00+08:00", "language": "en" }
  ],
  "added_at": "2026-10-18T08:45:00+08:00"
}
```
Optional fields may be left out when the article does not mention them.
`until_further_notice: true` is added only for open-ended closures.
