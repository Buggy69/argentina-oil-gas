# How it works

A walk through the machinery, at the level of what is actually happening rather
than what the code says. Written for someone who knows the physics and is
building fluency with the engineering.

## 1. What a "static site" actually is

There is no server here. Not "a small server" — none. GitHub Pages is a file
host: it receives `GET /data/agg_monthly.parquet` and returns those bytes. It
never runs any of our code.

That sounds like a limitation and is mostly a liberation:

- **Nothing to keep alive.** No process to crash, no database to patch, no bill.
- **Nothing to attack.** There is no query for anyone to inject into, because
  there is no server-side query.
- **It scales for free.** A thousand simultaneous readers is a thousand file
  downloads from a CDN, which is what CDNs exist for.

The cost is that every computation has to happen in the reader's browser. Which
raises the obvious question: how do you query 17.8 million rows in a browser?

## 2. Why the data is columnar

A row-oriented format stores record 1's every field, then record 2's, and so on.
To sum one column you must read past every other column.

Parquet is column-oriented: all 17.8 million `prod_pet` values sit contiguously,
then all the `prod_gas` values. Summing oil touches only the oil bytes. A chart
that needs 3 of 11 columns reads roughly 3/11 of the file.

Contiguity also means the values compress well — a column of dates or of basin
names is enormously more repetitive than a row mixing dates, names and floats.
The 143 MB of source Parquet re-encodes to 97 MB with ZSTD after column pruning,
and the aggregate cube crushes 17.8 M rows into 4.5 MB.

The same idea is repeated *inside* the browser. `site/js/store.js` decodes each
column into a flat `Float64Array`, and each categorical column into an
`Int32Array` of dictionary codes plus a string table. Filtering is then integer
comparison over contiguous memory. The alternative — 296,154 JavaScript objects
— costs about a hundred megabytes and makes the garbage collector do most of the
work of every keystroke.

## 3. Row groups, and why sorting is not cosmetic

A Parquet file is divided into **row groups**, and the footer records, per row
group and per column, the minimum and maximum value it contains.

That footer is a map. A reader can download it (a few kilobytes), decide from
the statistics which row groups could possibly contain the rows it wants, and
then fetch only those byte ranges with HTTP `Range` requests — a standard header
every CDN honours.

This is why `04_build_web_data.py` writes Tier C **sorted by `idpozo`**. Sorted,
one well's rows land in one or two row groups, and the min/max statistics exclude
all the others. Unsorted, that well's rows are scattered through every row group,
no statistics can exclude anything, and reading one well means reading the whole
file.

Two things had to be true before that theory produced the practice, and both
were wrong in the first version:

**The reader has to actually prune.** The obvious implementation asks hyparquet
for the file and filters rows in JavaScript. That is correct and it downloads
every byte — the pruning never happens, because nothing ever consulted the
statistics. `loadWellHistory` now reads the footer itself, compares `idpozo`
against each row group's min/max, and reads only the row ranges that can match.

**Row-group size is the resolution of the pruning.** A row group is the smallest
unit that can be skipped, so it decides the floor on what one query costs. At
50,000 rows per group each group was ~300 KB and one well pulled 10.4 MB across
twenty files. At 5,000 rows, plus only fetching the years the well actually
produced in, the same well costs **1.2 MB in 14 requests, 219 ms** — 1.1% of the
tier. The whole Tier C grew 97 → 105 MB in exchange, which is the right way to
trade when the file is read over HTTP rather than from disk.

Same bytes, same format, same reader. Sort order and row-group size are the
entire difference between a 1 MB request and a 105 MB one.

> Note: `python -m http.server` does **not** implement Range — it returns 200
> and the whole file. So this optimisation is invisible in local development and
> only demonstrable against the deployed site. That is why the verification step
> insists on testing the live URL.

## 4. The three tiers, and why loading order is the user experience

| Tier | What | When |
|---|---|---|
| A | `summary.json`, 40 KB gzipped | fetched first; renders the overview with no engine at all |
| B | cube + wells + type curves, ~8 MB | fetched in parallel behind it; powers all interaction |
| C | 97 MB of history | never loaded whole — only ranges, only on demand |

The ordering matters more than the sizes. If the page waited for all 8 MB before
drawing anything, it would be blank for several seconds on a phone. Instead the
first meaningful paint needs 40 KB, and the heavier tier arrives while the reader
is already reading.

## 5. Why not DuckDB-WASM

The plan originally called for DuckDB compiled to WebAssembly — a real SQL engine
in the browser, and a genuinely impressive thing. It was dropped after measuring
it: the WASM binary is 34–39 MB uncompressed, roughly 10 MB over the wire.

Against that, the work it would do is aggregating a 296 k-row pre-aggregated
cube, which plain JavaScript does in single-digit milliseconds. Paying 10 MB on a
phone for that is a bad trade. hyparquet reads the same files in 58 KB.

The abstraction in `site/js/query.js` exists so this stays a reversible decision:
views ask for data with a *structured spec*, never a SQL string, so the thing
compiling that spec can be swapped without touching a view.

## 6. Temporal joins — the part that is easy to get quietly wrong

Two attributes change over time, and they change in different shapes.

**Operator** is stored as explicit intervals: `valid_from`, `valid_to` per run.
Matching a production month to its operator is a range predicate. The open-ended
run has a NULL `valid_to`, hence the coalesce to a far-future date — miss that
and every well's most recent operator silently vanishes.

**Well state** is stored only at *transitions* — a row exists for the month
something changed, and nothing in between. The state in any other month is
carried forward from the last change. That is an `ASOF JOIN`: match the most
recent row at or before the probe date. A correlated subquery gives the same
answer and is orders of magnitude slower over 17.8 M rows.

The guard at the end of `03_enrich.py` is worth understanding. A range join
whose intervals overlap silently *duplicates* rows — and duplicated well-months
inflate every total downstream while looking completely normal. Asserting that
the output row count still equals the input's is a two-line check that catches
the entire class of error.

## 7. Where the numbers were checked

`02_verify.py` reconciles this pipeline's output against a series the publisher
computes independently. The agreement (−0.0% to −0.4% by basin over 240 months)
is meaningful precisely because the two numbers travel different routes to the
same place.

Two habits are worth stealing from it:

- **Re-derive constants instead of importing them.** The official oil series
  publishes monthly total, daily average, and daily average in kbbl. Those three
  are redundant, so dividing the first by the days in the month must reproduce
  the second, and their ratio must give the barrel factor. It does, exactly:
  6.28981 bbl/m³ — the publisher's own number, not a textbook's.
- **Report the distribution, not the extreme.** The first version of the
  coordinate check printed the maximum deviation, saw 0.287°, and would have
  read as a failure. The distribution showed 84,208 of 84,210 wells matching
  *bit-for-bit* with two revised outliers. A wrong projection displaces every
  well; two moved wells are a currency difference. The maximum alone could not
  tell those apart.

## 8. The seams built for later

Two abstractions exist to make a future migration cheap:

- `tools/sources/` — no pipeline stage names a file path. Each asks a driver for
  a SQL expression to put after `FROM`. Local Parquet, remote Parquet over HTTPS,
  and a stubbed SQL database all satisfy the same interface, selected by one line
  in `config.toml`.
- `site/js/query.js` — no view names a file, a URL, or an engine. Views submit a
  structured spec. Today it compiles against typed arrays; tomorrow it can
  compile to SQL and be posted to an endpoint.

Neither costs anything today. Both are the kind of thing that is nearly free to
put in at the start and expensive to retrofit.
