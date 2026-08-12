# Social / intranet post — Argentina open production dashboard

Written for a technical audience (petroleum engineers, geoscientists, data
people). Copy the body below. Short variant follows for a comment or teaser.

---

## Main post

**Two thirds of Argentina's oil now comes from rock we couldn't produce fifteen years ago. Here is every well that did it.**

→ **https://buggy69.github.io/argentina-oil-gas/**

Argentina's Secretaría de Energía makes every operator declare production well
by well, month by month — and publishes the lot, openly licensed. **17,775,911
well-months. 85,417 wells. 2006 to 2025.** It is one of the most complete public
production records anywhere, and almost nobody uses it, because it arrives as
several gigabytes of CSV with Spanish column names and the interesting
attributes scattered across three separate filings.

So I put a dashboard on top of it. Filter by basin, formation, operator, fluid
type, resource type or well trajectory and you get monthly series, distributions,
a map of all 84,239 located wells, and decline type curves. No login, no install,
runs on a phone.

**What the data says**

The unconventional share of Argentine oil, month by month:

| Dec 2015 | Dec 2018 | Dec 2021 | Dec 2024 | **Dec 2025** |
|---|---|---|---|---|
| 5.5% | 16.2% | 37.9% | 59.1% | **67.7%** |

That is a national production base rebuilt inside a decade, and you can watch it
happen one month at a time.

The well-level contrast is just as blunt. **Median cumulative oil: 37,000 m³ for
a horizontal well, 5,988 m³ for a vertical one.** Note *median* — the horizontal
mean is 43,370 m³, and the gap between the two tells you how long the right tail
runs. In Neuquina, the **top 5% of wells hold 29% of all the oil ever produced
there**. Any average you quote for this basin is describing a distribution it
does not have.

And because the fracture filings (*Adjunto IV*) join to production on `idpozo`,
lateral length, stage count, proppant tonnage, fluid volume and treating pressure
sit alongside the barrels. Proppant intensity against realised cumulative oil is
one chart, not a week of data wrangling.

**How it works, for those who care**

No server. No database. No accounts. The browser downloads Parquet and queries it
itself: a 40 KB summary paints the overview in about a second, ~8 MB of
pre-aggregated cube drives every filter, and the full 17.8 M-row history is
sharded into 256 files by well — so opening one well's entire life costs a single
~400 KB request. The map's geography is compiled in from Natural Earth; there is
not one third-party request on the page, so nothing about it can be broken by
someone else's outage.

Before any of it was built, the pipeline was reconciled against the publisher's
own independently-produced monthly series: **agreement of −0.0% to −0.4% by basin
over 240 months.** The barrel factor (6.28981 bbl/m³) and the gas unit (10³ m³,
not 10⁶ — a genuine trap in this dataset) were re-derived from the publisher's
own redundant columns rather than assumed.

**What it does not claim**

Trajectory is not in the production data at all. It is reconstructed from two
sources — reported lateral length in the fracture filings, and the naming
convention that marks wells `(h)` horizontal or `(d)` directional. That gives
2,819 horizontal, 3,581 directional and 1,114 vertical wells, and leaves
**77,903 (91.2%) genuinely *Unknown*, which are left Unknown rather than
imputed.** The measurement always wins where it exists; the name speaks only for
wells with no fracture record, and both are exposed as separate filters so you
can see which evidence any number rests on. Every horizontal-versus-vertical
comparison above is really a comparison inside the unconventional population, and
the page says so.

Likewise: `idpozo` is a wellbore **×** producing formation, not a wellbore. A
missing month is null, not zero. And the source's real defects — negative volumes
from retroactive corrections, a handful of rows claiming more production hours
than the month physically contains — are reported rather than quietly cleaned. If
a dashboard cannot tell you where its numbers are weak, it is a rumour with a
chart on it.

Full pipeline, verification suite and site are open:
https://github.com/Buggy69/argentina-oil-gas

Independent personal project on public data — not an SLB product, not reviewed or
endorsed by either publisher. Happy to go into the data model or the verification
with anyone interested.

---

## Short variant (comment, teaser, chat)

Argentina publishes every operator's production, well by well, month by month,
openly licensed — 17.8 million well-months going back to 2006. I turned all of it
into an interactive dashboard:

**https://buggy69.github.io/argentina-oil-gas/**

Unconventional oil went from **5.5% of national production in Dec 2015 to 67.7%
in Dec 2025**. Median cumulative oil is 37,000 m³ per horizontal well against
5,988 m³ per vertical. Completion data (lateral, stages, proppant, fluid) joins
on `idpozo`, so intensity against realised production is one chart.

Reconciled to the publisher's own monthly series within 0.4% per basin, and it
says plainly which 91.2% of wells have unknown trajectory rather than guessing.

Runs entirely in your browser — no server, no login. Open source, public data.
Personal project, not an SLB product.

---

## Notes before posting

- **Pre-empt one misreading.** The Overview tile shows **17.7%** unconventional,
  which is cumulative across twenty years — not today. Today's monthly figure is
  67.7%. If someone quotes the tile as "Argentina is 17.7% unconventional", that
  is the confusion.
- Figures are from the 2026-08-10 snapshot. The site refreshes weekly, so the
  December 2025 numbers are stable but well counts drift upward.
- If posting somewhere that renders no tables, the share row reads fine inline:
  5.5% (2015) → 16.2% (2018) → 37.9% (2021) → 59.1% (2024) → 67.7% (2025).
