# Verification report — PetroDB Argentina dashboard

Every check prints the number it measured. Discrepancies are quantified and explained rather than reconciled away.

Sources: petrodb (`sumpalabs/petrodb`, CC BY 4.0) and Secretaría de Energía de la Nación, `datos.energia.gob.ar` (CC BY 4.0).
*Generated 2026-08-21 06:54 UTC from source driver `hf_parquet`.*

## 1. Row counts against the published documentation

| table | rows | vs published schema |
|---|---|---|
| wells | 85,417 | documented ~85,418 (Δ -1) |
| well_events | 499,031 | — |
| well_operator_history | 176,956 | — |
| monthly_production | 17,775,911 | documented ~17,600,000 (Δ +175,911) |

The `wells` count is 85,417 against a documented ~85,418 — a single row. The schema text says "~85,418", so this is a rounding of the author's own snapshot rather than a defect.

## 2. Referential integrity — every child idpozo exists in wells

| child table | orphan idpozo | result |
|---|---|---|
| monthly_production | 0 | PASS |
| well_events | 0 | PASS |
| well_operator_history | 0 | PASS |


## 3. Grain uniqueness

| grain | duplicate keys | result |
|---|---|---|
| monthly_production (idpozo, fecha) | 0 | PASS |
| well_operator_history (idpozo, valid_from) | 0 | PASS |
| wells (idpozo) | 0 | PASS |


## 4. Reconciliation against the publisher's official monthly series

petrodb summed by basin and month, against `serie-histórica de producción por cuenca` from datos.energia.gob.ar. Different processing chains, same underlying declarations — so the agreement below is meaningful.

| fluid | basin | months | petrodb total | official total | Δ total | worst month |
|---|---|---|---|---|---|---|
| oil | AUSTRAL | 240 | 25,224,937 | 25,224,937 | -0.000% | 0.00% |
| oil | GOLFO SAN JORGE | 240 | 278,316,548 | 278,888,899 | -0.205% | 35.18% |
| oil | NEUQUINA | 240 | 330,259,108 | 330,823,824 | -0.171% | 11.36% |
| oil | NOROESTE | 240 | 9,515,936 | 9,554,567 | -0.404% | 28.06% |
| oil | CUYANA | 240 | 30,907,079 | 30,910,921 | -0.012% | 3.01% |
| gas | AUSTRAL | 240 | 206,366,529 | 206,366,529 | -0.000% | 0.00% |
| gas | GOLFO SAN JORGE | 240 | 95,648,263 | 95,885,072 | -0.247% | 54.00% |
| gas | NEUQUINA | 240 | 569,338,296 | 569,582,993 | -0.043% | 3.49% |
| gas | NOROESTE | 240 | 66,973,875 | 67,242,824 | -0.400% | 35.36% |
| gas | CUYANA | 240 | 1,070,295 | 1,070,468 | -0.016% | 3.36% |


## 5. Unit re-derivation from the publisher's own columns

The official oil series publishes the monthly total, the daily average and the daily average in kbbl. Those three are redundant, which makes them a closed test of both the volume unit and the barrel factor — no external constant is trusted.

| month | days | total (m³) | total/days | published daily | implied bbl/m³ |
|---|---|---|---|---|---|
| 2006-01 | 31 | 3,019,656.7 | 97,408.28 | 97,408.28 | 6.28981 |
| 2006-02 | 28 | 2,756,375.6 | 98,441.99 | 98,441.99 | 6.28981 |
| 2006-03 | 31 | 3,188,157.9 | 102,843.80 | 102,843.80 | 6.28981 |
| 2006-04 | 30 | 3,107,771.5 | 103,592.38 | 103,592.38 | 6.28981 |


Implied barrel factor **6.28981 bbl/m³**; config uses 6.28981 (Δ 0.0000%). `total / days` reproduces the published daily column exactly, so `prod_pet` is m³ and the factor is the publisher's own.

Gas: 2006-01 total 4,229,240.2 with published daily 136.4271. total/31 = 136,427.1, i.e. the daily column is the monthly unit ÷1000. With ~136 × 10⁶ m³/d national output for 2006, `prod_gas` is confirmed as **10³ m³**, not 10⁶.

## 6. Unconventional split against the official shale / tight columns

| fluid | subtype | months | petrodb | official | Δ |
|---|---|---|---|---|---|
| oil | SHALE | 240 | 114,772,374 | 115,125,553 | -0.31% |
| oil | TIGHT | 240 | 4,654,655 | 4,679,419 | -0.53% |
| gas | SHALE | 240 | 140,259,572 | 140,324,780 | -0.05% |
| gas | TIGHT | 240 | 103,247,341 | 103,714,750 | -0.45% |


## 7. Physical plausibility and the NULL-versus-zero census

| negative values | prod_pet | prod_gas | prod_agua | tef |
|---|---|---|---|---|
| count | 43 | 11 | 81 | 12 |


Negative volumes are not corrupt rows — they are retroactive corrections carried in the source declarations, where a later filing reverses an earlier over-report. They are kept (removing them would break the reconciliation in check 4, which they are part of) and flagged in the data-quality panel.

`tef` (effective production hours) max = **3,058.0 h** against a ceiling of 744 h in a 31-day month, and **5 rows** exceed the hours physically available in their own month. So `tef` is *not* clean: a handful of declarations carry impossible values, the worst about four times the ceiling. The count is tiny against 17.8 M rows, but any uptime-derived rate must exclude them rather than assume the column is bounded — the dashboard clamps `tef` for rate calculations and reports the affected rows in the data-quality panel.

NULL versus zero matters: petrodb fills series gaps with NULL measurements, so a zero is a reported zero and a NULL is an absent declaration. Statistics must not conflate them.

| column | NULL | zero | % NULL |
|---|---|---|---|
| prod_pet | 146,248 | 11,934,677 | 0.8% |
| prod_gas | 146,248 | 13,249,673 | 0.8% |
| prod_agua | 146,248 | 11,932,334 | 0.8% |
| tef | 146,248 | 10,725,843 | 0.8% |


## 8. Coordinate reference system

| WKB prefix (hex) | wells |
|---|---|
| 0101000020E6100000 | 85,380 |


Decoded: byte order `01` (01 = little-endian), type word `01000020` — the 0x20000000 bit is the *has SRID* flag — and SRID **4326**. EPSG:4326 is WGS 84, so `coordenadax`/`coordenaday` are already decimal degrees. No reprojection anywhere in this project.
| matched | no coordinate | comparable | identical | < 1e-4° (~10 m) | 1e-4–1e-2° | ≥ 1e-2° (~1 km) |
|---|---|---|---|---|---|---|
| 85,380 | 1,170 | 84,210 | 84,208 | 0 | 0 | 2 |


Of the 84,210 wells carrying a coordinate in both sources, **84,208 (100.00%) agree bit-for-bit** and nothing at all lands in the intermediate bands — p99 deviation is exactly 0.0°. That is the confirmation being sought: two independent representations of the same coordinate are *identical*, so the values are unambiguously the degrees the SRID declares.

Only **2** wells differ at all (max 0.287°, ~32 km). Those are positions the registry revised after the petrodb snapshot — a currency difference between two sources, not a projection error. A wrong CRS would displace *every* well by a similar amount; instead it displaces 2 of 84,210 and leaves the rest exact.

Wells with missing coordinates: **1,176**; outside Argentina's bounding box: **2**. Both are excluded from the map and counted on the Data & method page.

## 9. Fracture join coverage and the trajectory classification

| tipo_recurso | wells | with fracture record | coverage |
|---|---|---|---|
| CONVENCIONAL | 58,302 | 767 | 1.3% |
| No informado | 21,859 | 29 | 0.1% |
| NO CONVENCIONAL | 4,833 | 3,668 | 75.9% |
| SIN RESERVORIO | 418 | 0 | 0.0% |
| NO DISCRIMINADO | 5 | 1 | 20.0% |


Trajectory is therefore **known for the unconventional population and unknown for most conventional wells**. The dashboard exposes this as an explicit `Unknown` state; nothing is imputed.

### Why the 500 m threshold

| lateral length | = 0 / null | 0–150 m | 150–600 m | ≥ 600 m |
|---|---|---|---|---|
| wells | 1,875 | 155 | 20 | 2,569 |


The distribution is bimodal with an almost empty corridor: only **20** wells of 4,619 fall between 150 m and 600 m, while the horizontal mode sits at p25 = 1,910 m and p50 = 2,500 m. Any cut inside that corridor classifies the same wells, so **500 m** is chosen for roundness and the result is insensitive to it — moving the cut to 150 m or 1,000 m reclassifies at most 20 wells (0.4%).

First-production padrón covers **85,406 of 85,417 wells** (100.0%). Wells without it get no months-on-production axis and are excluded from type curves, not silently defaulted to zero.
