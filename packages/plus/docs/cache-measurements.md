# Cache measurements: reader/writer contract

The monitor's sparse request measurements are separate from Session accounting.
A stored accounting zero is not evidence that an endpoint reported zero. Missing,
legacy, partial, inconsistent and unknown-version observations cannot establish
a supported cache shortfall. An inclusive-input ratio uses the same measurable
population in numerator and denominator; an empty or zero denominator is unavailable.

Local shortfalls are estimates from a compatible measured prefix, bounded by the
current inclusive input. They are not historical read drops or a provider cause.
Provider-reported diagnostics remain separately attributed estimates. Receiving
the native OpenAI extension does not establish support on a compatible proxy;
opening the monitor never enables diagnostic options or makes provider probes.

## Compatibility

| Surface | Accepted candidate behavior |
| --- | --- |
| Ledger schema 1/2 | Additive migration; historical numeric accounting remains legacy/unknown presence. No reconstructed sparse usage. |
| Ledger schema 3 | Current request observation storage. |
| Unknown ledger schema | Refuse opening before migration or metadata writes. |
| `analysis_delta` absent/1/2 | Upgrade the materialized change indexes/triggers to version 3. No request/fact payload rewrite. |
| `analysis_delta` 3 | Current request/fact deltas, prefix-dependency invalidation and SQL REPLACE preimages. |
| Unknown `analysis_delta` | Refuse opening without rewriting the database. |
| Observation 1 | Decode the allow-listed measurement fields. Invalid/incomplete fields cannot establish usable coverage. |
| Unknown/malformed observation | Preserve original storage; expose unavailable measurement, never reinterpret it as current. |
| Fingerprint 2 / comparison policy 1 | Compare observed wire identity; source annotations are presentation only. |
| Legacy/unknown fingerprint or policy | No supported identity-based diagnosis; omitted wire fields cannot be recovered. |

**Mixed-version writers and downgrade are unsupported.** An older binary may
overwrite a schema marker; additive columns do not make it safe. These checks
authorize no release activation, rollback, reset or live-state migration. Use
fresh fixtures or copies for migration verification.

## Read caches and invalidation

Request/fact indexes retain one change mark per live row and one reset mark per
Session/entity. Append and in-place updates load only changed payloads. Deletion,
identity movement and pruning may reload the affected Session. Compressed
fingerprint descendants reload after a prefix/base edit, not an unrelated
metadata edit. SQLite triggers cover direct SQL and other connections.
Replacement preimages use the primary/unique indexes, including connections
with recursive triggers off. An ignored duplicate may conservatively invalidate
its Session, without changing the returned facts.

The ledger-local report cache retains at most 32 entries and 8 MiB of accounted
serialized content; this is **not a JavaScript heap bound**. Oversize answers
are computed but not retained. Reuse requires the same ledger revision, query
and live host state/agent values. Advancing time also checks exclusive data
cutoffs, inclusive write expiry, comparison windows and facet edge hours;
reverse time or a changed lower window rebuilds the answer.

The separate Session-analysis cache has its own count/content limits. Neither
cache promises constant append CPU: merging arrays and rebuilding selected
aggregates can still traverse retained data. Paging bounds transport populations,
not the amount of historical context required for a correct cold analysis.
