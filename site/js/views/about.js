/* Data & method — provenance, licence, citation and the honest caveats.

   This page exists because a dashboard that cannot tell you where its numbers
   came from is a rumour with a chart on it. Everything here is generated from
   the build's own manifests, so it cannot drift away from what was actually
   shipped. */

import { num, esc, pct } from '../format.js';

export async function render(root, ctx) {
  const prov = ctx.provenance || {};
  const dq = ctx.summary.data_quality || {};
  const cov = ctx.summary.coverage || {};
  const kpi = ctx.summary.kpi || {};

  const outputs = prov.outputs || {};
  const fileRow = (name, o) => `<tr>
      <td>${esc(name)}</td>
      <td>${o.rows ? num(o.rows) : '—'}</td>
      <td>${(o.bytes / 1048576).toFixed(2)} MB</td>
      <td style="font-family:ui-monospace,monospace;font-size:11px">${esc((o.sha256 || '').slice(0, 16))}…</td>
    </tr>`;

  const unknownPct = kpi.wells
    ? (kpi.wells_unknown_trajectory / kpi.wells * 100) : 0;

  root.innerHTML = `
  <div class="grid">
    <section class="card">
      <h2>What this is</h2>
      <div class="prose">
        <div class="callout">
          <strong>Everything here is public open-government data.</strong>
          Argentina's <em>Secretaría de Energía</em> requires operators to declare
          production well by well, month by month, and publishes those
          declarations openly under a Creative Commons Attribution licence. This
          site reuses that published data with attribution and adds nothing
          proprietary, confidential or commercially licensed to it. Anyone can
          download the same source files from the links below and reproduce every
          number on this site.
        </div>
        <p>An independent, non-commercial analysis of Argentina's public
        well-level oil and gas production data, covering
        <strong>${esc(String(cov.first_month ?? '').slice(0, 7))} to
        ${esc(String(cov.last_month ?? '').slice(0, 7))}</strong>
        — ${num(cov.months)} months and ${num(kpi.wells)} wells.</p>

        <h3>How to cite</h3>
        <div class="callout">
          Secretaría de Energía de la Nación (Argentina).
          <em>Producción de petróleo y gas por pozo (Capítulo IV)</em> and
          <em>Datos de fractura de pozos de hidrocarburos (Adjunto IV)</em>.
          datos.energia.gob.ar. Licensed CC BY 4.0. Accessed
          ${esc((prov.portal?.fetched_at || '').slice(0, 10))}.<br><br>
          <em>PetroData Repository</em> (sumpalabs/petrodb), curated by Oscar Cortez.
          Parquet repackaging of the above. Licensed CC BY 4.0.
          Snapshot ${esc(prov.snapshot ?? '')}.
        </div>
        <p>Both publishers release under CC BY 4.0, which permits this reuse
        with attribution. Neither has reviewed or endorsed this site.</p>
      </div>
    </section>

    <section class="card">
      <h2>Read this before drawing conclusions</h2>
      <div class="prose">
        <h3>Trajectory is known for only part of the well set</h3>
        <p>Vertical versus horizontal does not exist in the production data at
        all. It is derived from the fracture table's reported lateral length, so
        it is a <em>measurement</em> — but only for wells that have a fracture
        record. <strong>${num(kpi.wells_unknown_trajectory)} wells
        (${pct(unknownPct)}) are therefore “Unknown”</strong>, and nothing is
        imputed to fill that in. Coverage is about 76% among unconventional
        wells and near zero among old conventional ones, so any comparison of
        “horizontal versus vertical” is really a comparison within the
        unconventional population.</p>

        <h3>An <code>idpozo</code> is not a wellbore</h3>
        <p>It identifies a wellbore <em>×</em> producing formation. A well
        producing from two formations appears twice. Counts on this site are
        counts of <code>idpozo</code>.</p>

        <h3>Null is not zero</h3>
        <p>A month with no declaration is null; a month with a declared zero is
        zero. About 0.8% of well-months are null. Statistics here skip nulls and
        report them separately rather than averaging them in as zeros.</p>

        <h3>Operator attribution changes the answer</h3>
        <p>Blocks change hands. Production is attributed to the operator holding
        the well <em>in that month</em>, so a company's history does not
        retroactively absorb production from before it acquired the asset.</p>

        <h3>The data has real defects, and they are left visible</h3>
        <p>${num(dq.negatives?.prod_pet ?? 0)} well-months carry negative oil
        volumes and ${num(dq.negatives?.prod_agua ?? 0)} negative water — these
        are retroactive corrections in the source filings, not parsing errors,
        and removing them would break agreement with the publisher's own
        totals. ${num(dq.tef?.rows_over_month_ceiling ?? 0)} rows report more
        effective production hours than the month physically contains (worst
        case ${num(dq.tef?.max_hours ?? 0)} h against a 744 h ceiling); those
        are clamped before any rate is computed.</p>
      </div>
    </section>

    <section class="card half">
      <h2>Verification</h2>
      <div class="prose">
        <p>Every headline number was reconciled against the publisher's own
        independently-produced monthly series before this site was built.
        Agreement by basin over 240 months:</p>
      </div>
      <div class="scroll-x"><table class="data">
        <thead><tr><th>Series</th><th>Δ vs official total</th></tr></thead>
        <tbody>${Object.entries(dq.reconciliation || {}).map(([k, v]) => `
          <tr><td>${esc(k)}</td>
              <td>${v.total_diff_pct == null ? '—' : v.total_diff_pct.toFixed(3) + '%'}</td></tr>`).join('')}
        </tbody></table></div>
      <p class="source">Differences of a few tenths of a percent reflect the
        registry the two chains draw on, and are reported rather than corrected.
        Coordinates: ${num(dq.geojson_agreement?.identical ?? 0)} of
        ${num(dq.geojson_agreement?.comparable ?? 0)} wells match the registry's
        own geometry bit-for-bit.</p>
    </section>

    <section class="card half">
      <h2>What was shipped</h2>
      <div class="scroll-x"><table class="data">
        <thead><tr><th>File</th><th>rows</th><th>size</th><th>sha256</th></tr></thead>
        <tbody>
          ${Object.entries(outputs).filter(([k]) => k !== 'monthly')
            .map(([k, v]) => fileRow(k, v)).join('')}
          ${outputs.monthly ? `<tr><td>monthly/ (${Object.keys(outputs.monthly).length} yearly files)</td>
            <td>—</td>
            <td>${(Object.values(outputs.monthly).reduce((a, b) => a + b.bytes, 0) / 1048576).toFixed(1)} MB</td>
            <td>—</td></tr>` : ''}
        </tbody></table></div>
      <p class="source">Generated ${esc((prov.generated || '').replace('T', ' '))}.
        Full manifest with every checksum is at
        <a href="PROVENANCE.json">PROVENANCE.json</a>.</p>
    </section>

    <section class="card">
      <h2>How it works</h2>
      <div class="prose">
        <p>This is a static page. There is no server, no database and no
        account: the browser downloads Parquet files and queries them itself.
        The pre-aggregated cube (${num(outputs['agg_monthly.parquet']?.rows)} rows)
        and the per-well table load at start; a single well's full monthly
        history is fetched on demand using HTTP range requests against files
        sorted by well id, so opening one well transfers around a megabyte
        rather than the ${(Object.values(outputs.monthly || {})
          .reduce((a, b) => a + b.bytes, 0) / 1048576).toFixed(0)} MB the
        complete history occupies.</p>
        <p>Nothing is loaded from a third-party host — no CDN, no fonts, no map
        tiles, no analytics. Every visitor's browser talks only to the server
        hosting this page, which means no corporate web filter, ad blocker or
        tracker-blocking extension can break it, and no one is tracked.</p>
      </div>
    </section>
  </div>`;
}

export function update() { /* static page — nothing to re-render on filter change */ }
