# HF-36: do not lose dist-only fixes during a core rebuild

A source checkout does not contain every behavior of an installed OpenClaw
package if an operator patched `dist` after installation. Building a new
package from source alone can therefore silently remove a still-live fix.
This is an operator reapplication gate, not an automatic core patch.

Before deploying a rebuilt package:

1. Inventory every **live** entry in the operator's `HOTFIXES.md`, especially
   entries whose Locate/Apply evidence names a live `dist` edit. Compare the
   outgoing installed package and the candidate package by behavior and exact
   owned values. Do not infer correctness from matching file names or bundle
   hashes: bundler output names move between builds.
2. For each entry, check a distinctive compiled marker in the outgoing and
   candidate bundles, then compare the behavior-defining values and run its
   entry-specific Validate gate. A missing marker is a rejection; a present
   marker is only a lead, not acceptance.
3. In this 2026.9.5 line, HF-46 is an example of a live dist-level patch:
   verify that the candidate compaction cap is **40000** characters and the
   derived fit-search bound is **39999** (and exercise its compaction proof),
   rather than assuming that its source port or a `MAX_...` symbol guarantees
   the installed bundle contains it.
4. Keep the exact outgoing installed tree as rollback. Do not swap the live
   package when any live entry is missing from the candidate; reapply the
   behavior at the new version's owning source, rebuild, and repeat all checks.

The historical HF-23 incident prompted this gate: a dist/manifest-only model
metadata patch vanished during a source rebuild. This fork-only PR preserves
HF-36 independently of the other local hotfixes, but does not run at build
or deployment time. The operator's `HOTFIXES.md` remains the authority for
which entries are live on a particular installation.
