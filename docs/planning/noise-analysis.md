# Noise Analysis Sections in Incident Summary (FMN-156)

The Best-Practice Assessment's Noise Analyzer ranks the noisiest instances and metric/outage descriptions across the tenant's incident history (30-day window) and emits per-row recommendations. After operator QA, the standalone Noise Analysis tab was folded into the BPA's Incident Summary tab as three new sections:

- **Noise Summary** (counts + thresholds)
- **Top Noisy Instances**
- **Top Noisy Metrics (per outage description)**

Each Top Noisy Instances row carries a non-empty Recommendation column to help operators find the alerting rules that need tuning before they swamp the next shift.

The analyzer runs as an ancillary analyzer to `incidents` in the BPA's analyzer pipeline (see `SECTION_ANCILLARY_ANALYZER_KEYS`). No separate Settings toggle - it ships with the BPA Audit feature itself.

See also: [FMN-156 ticket on Plane](https://app.plane.so/myrug/projects/).
