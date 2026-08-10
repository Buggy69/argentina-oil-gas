# Data dictionary

Source column identifiers are Spanish, exactly as the publisher issues them.
This maps each to its meaning and unit. Derived fields are marked **[derived]**
with the rule that produces them.

## Units, once and for all

| Quantity | Stored unit | Note |
|---|---|---|
| Oil | **m³** | `1 m³ = 6.28981 bbl` — re-derived from the publisher's own redundant columns, not taken from a reference |
| Gas | **10³ m³** | "Mm³" in Argentine usage means *thousands*, not millions. `1 × 10³ m³ = 35.3147 Mcf` |
| Water, injection | m³ | |
| `tef` | hours | effective production time in the month; ceiling is 744 h |
| Depth, lateral | m | |
| Proppant | tonnes | national + imported, summed |
| Coordinates | degrees | WGS 84 (EPSG:4326), confirmed by decoding the geometry's SRID |

Nothing is ever stored converted. Oilfield units are a display-time toggle, so
there is exactly one number of record.

## `wells` — one row per `idpozo`

**`idpozo` is a wellbore × producing formation, not a wellbore.** A well producing
from two formations appears twice. Every "well count" on the site counts `idpozo`.

| Column | Meaning |
|---|---|
| `idpozo` | integer identity of the wellbore × formation pair; the primary key |
| `sigla` | human-readable well code (e.g. `YPF.BLO.x-8`); a label, and mutable |
| `formprod` | producing formation — the one encoded in the identity |
| `formacion` | geological formation as reported |
| `area`, `cod_area` | permit / concession area |
| `yacimiento` | field |
| `cuenca` | sedimentary basin |
| `provincia` | province |
| `clasificacion`, `subclasificacion` | regulatory classification (Exploración, Desarrollo …) |
| `tipo_recurso` | CONVENCIONAL / NO CONVENCIONAL / No informado / SIN RESERVORIO |
| `sub_tipo_recurso` | SHALE / TIGHT / No informado |
| `cota` | surface elevation, m a.s.l. |
| `profundidad` | final well depth, m |
| `coordenadax` / `coordenaday` | longitude / latitude, WGS 84 degrees |
| `geom` | geometry as WKB, SRID 4326 |
| `adjiv_fecha_inicio_perf` … `_fin_term` | spud, drilling end, completion start, completion end |
| `pet_inicial`, `gas_inicial`, `agua_inicial` | initial test rates (m³/d, 10³ m³/d, m³/d) |
| `has_production` | false for registry wells that never produced |

## `monthly_production` — one row per (`idpozo`, `fecha`)

| Column | Meaning |
|---|---|
| `fecha` | measurement month, first day of month |
| `prod_pet` | oil produced in the month, m³ |
| `prod_gas` | gas produced, 10³ m³ |
| `prod_agua` | water produced, m³ |
| `iny_agua`, `iny_gas`, `iny_co2`, `iny_otro` | injection volumes |
| `tef` | *Tiempo Efectivo de Producción* — effective production hours |
| `vida_util` | declared remaining useful life, months |

**Null is not zero.** Gaps in a well's series carry NULL measurements; a declared
zero is a real zero. About 0.8% of well-months are NULL. Statistics skip NULLs
and report them separately.

## `well_operator_history` / `well_events`

| Column | Meaning |
|---|---|
| `idempresa` | operator code — **VARCHAR**, not an integer (`Z001`, `APEA`) |
| `empresa` | operator display name |
| `valid_from`, `valid_to` | inclusive month bounds of one operator run; `valid_to` NULL = still current |
| `tipoestado` | operational state (`Extracción Efectiva`, `Parado Transitoriamente` …) |
| `tipoextraccion` | lift method (`Bombeo Mecánico`, `Surgente` …) |
| `tipopozo` | **well type by fluid** (`Petrolífero`, `Gasífero`, `Inyección de Agua`) — this is *not* trajectory |

## Fracture table (Adjunto IV) — one row per fracture job

Joined to production on `idpozo`. Covers 4,604 of 85,417 wells (76% of
unconventional wells, ~1% of conventional).

| Column | Meaning |
|---|---|
| `longitud_rama_horizontal_m` | lateral length, m — the source of trajectory |
| `cantidad_fracturas` | number of fracture stages |
| `tipo_terminacion` | completion type (`Punzado` = plug-and-perf …) |
| `arena_bombeada_nacional_tn` / `_importada_tn` | proppant pumped, tonnes, domestic / imported |
| `agua_inyectada_m3` | fluid volume, m³ |
| `presion_maxima_psi` | maximum treating pressure, psi |
| `potencia_equipos_fractura_hp` | pump power, hp |
| `fecha_inicio_fractura` / `_fin_` | job start / end |

## Derived fields

| Field | Rule |
|---|---|
| **`trajectory`** **[derived]** | no fracture record → `Unknown`; lateral ≥ 500 m → `Horizontal`; else `Vertical`. The 500 m cut sits inside an almost empty corridor in the distribution — only 20 of 4,604 wells fall between 150 m and 600 m — so the classification is insensitive to it. **Never imputed for wells without a record.** |
| `lateral_m` **[derived]** | `max` across jobs — a property of the wellbore, so it does not sum |
| `stages`, `proppant_t`, `frac_water_m3` **[derived]** | `sum` across jobs — consumed per job, so they do |
| `max_pressure_psi` **[derived]** | `max` across jobs — an observed peak |
| `proppant_kg_per_m` **[derived]** | `proppant_t × 1000 / lateral_m`; NULL when lateral is 0 |
| `stage_spacing_m` **[derived]** | `lateral_m / stages` |
| `gor_m3_m3` **[derived]** | `cum_gas × 1000 / cum_oil` (the ×1000 converts 10³ m³ → m³) |
| `first_prod_declared` **[derived]** | first-production month from the official padrón |
| `first_prod_month` **[derived]** | first month with non-zero oil or gas in this dataset |
| `operator_asof` **[derived]** | operator holding the well **in that month**, by range join |
| `well_fluid_asof` **[derived]** | `tipopozo` in force that month, by ASOF join (events record only transitions) |
| `operator_latest` **[derived]** | most recent operator — a different question, and a different answer |
| `tef` (in `prod_monthly`) **[derived]** | clamped to the hours available in the month; five source rows exceed it, worst case 3,058 h |

## Statistical conventions

- **p10 is the LOW value.** p10 < p50 < p90. Stated on the page itself, because
  the reserves convention runs the other way.
- **Unit of observation is always declared.** A statistic over well-months and a
  statistic over wells answer different questions; the Statistics page names
  which one is on screen.
- **Well counts are per month.** A well recurs in every month it produces, so
  counts may be summed across categories within a month but never along time.
