# V-model fixtures

Everything here comes from `C:\repos\acc_project`. Three files are byte-for-byte copies of its
exports; three are produced by running its own code and capturing the output. **Nothing is
hand-authored, and nothing may be hand-edited** - regenerate instead:

```
python backend/api/vmodel_fixtures/tools/build_vmodel_fixtures.py --acc-project C:/repos/acc_project
```

That script needs acc_project's check dependencies (`asammdf==8.8.9`, `numpy==2.2.6`) on the
interpreter that runs it, because the verdicts are produced by executing the checks.

Generated 2026-08-19.

| Fixture | How | Source (acc_project) | Bytes | sha256 |
|---|---|---|---|---|
| `requirements/acc-system-requirements.json` | copied verbatim | `Reqs/export/json/acc-system-requirements.json` | 73983 | `bdbb62ac6a884c04828616a65f1106e0252a3061804e12b9523c53a4e50fb587` |
| `test_specs/acc-system-test-specs.json` | copied verbatim | `TestSpecs/acc-system-test-specs.json` | 85056 | `49676a69c029a8f182d87dc33b29f3d663736a9a6e7d9ec171c0e40136e4f3ac` |
| `signals/acc-signal-catalogue.json` | copied verbatim | `Reqs/export/json/acc-signal-catalogue.json` | 42373 | `4666cb37f86b2d98e1eb151d8b8c0fb1720664b6ad32e7806a40dca967d98279` |
| `test_impls/acc-test-impls.json` | generated | `TestImpl/registry.py + module sources` | 331945 | `83b29424d1431a0275d57e4abec419a118b4e85a1392f14e18ed6e14529e8ab3` |
| `results/acc-traces.json` | generated | `Data/**/*.mf4 (digest + size only)` | 13898 | `728a569095bc2db09a08b2ce8017248f2857946f1176ca38550d1611e212c2e0` |
| `results/acc-verdicts.json` | generated | `python -m TestImpl.cli --dir Data --json` | 426538 | `c66e8c5c6464d54e2fcc56251f76f594b81fd89dabe5c60fca141537ef4961f8` |
| `figures/F1-system-boundary.svg` | copied verbatim | `Reqs/export/figures/F1-system-boundary.svg` | 11277 | `24bd7fb81e074f185722910648ce2fa15319d12cca635ca6a15c0261fbd83f84` |
| `figures/F2-state-machine.svg` | copied verbatim | `Reqs/export/figures/F2-state-machine.svg` | 8818 | `c1fd9e44c8f6825295da0af149832a49d29363e9609bb2bf1ec0a5ec7d3a8550` |
| `figures/F3-clearance-geometry.svg` | copied verbatim | `Reqs/export/figures/F3-clearance-geometry.svg` | 10464 | `fce986ccc4ead08cfe4e09350116c1a02d786ce879f0646c0965e8a114b22ad6` |
| `figures/F4-follow-brake-trace.svg` | copied verbatim | `Reqs/export/figures/F4-follow-brake-trace.svg` | 8489 | `fa9bb1455b0ab8e49ab013f838c8217fe87790b7c14a94f373f0e916e4888d27` |
| `figures/F5-cutin-cutout-geometry.svg` | copied verbatim | `Reqs/export/figures/F5-cutin-cutout-geometry.svg` | 12187 | `1720110d1820c822e510637e82951978ea3a00f73c9867ed5b2ae1bdc5c47fa0` |
| `figures/F6-operating-envelope.svg` | copied verbatim | `Reqs/export/figures/F6-operating-envelope.svg` | 8640 | `a1f0e21f8632a5ef7ef12340485b0d368feccd3aaa28c50e298f24484b9f6637` |

## What each fixture contains

- **`requirements/acc-system-requirements.json`** - 37 requirements, schema `1.0.0`, declared set
  hash `9589ad52aaee7316b3b4a0f7ae9008889338a5d1d8293ca24392346c649ab0cc`.
  Chapters: Functional-HMI 13, Performance 12, Safety-Fault-Handling 12.
  Status: Approved 23, Reviewed 7, Draft 4, Obsolete 2, Rejected 1.
  Verification tag: DERIVED 22, VERIFIED-PRIMARY 7, UNVERIFIED-2018 6, VERIFIED-SECONDARY 2.
  The export carries no `last_change` key, so that field stays null on seeded items.
- **`test_specs/acc-system-test-specs.json`** - 9 test cases, every
  `pass_criteria` entry machine-evaluable. `impl_ref` is null on all nine in the source data;
  the link to an implementation is made through the shared requirement id instead.
- **`test_impls/acc-test-impls.json`** - 9 implementations. Each carries its
  file digests, the full source text of its module plus the two shared helpers
  (`verdict.py`, `trace.py`), and the `CheckSpec` dataclass read off the module - the declared
  bound, its unit, window, scope and `verification_tag`.
- **`signals/acc-signal-catalogue.json`** - 65 signals with unit, raster,
  role and enum map, extracted from a real MF4.
- **`results/acc-traces.json`** - 37 catalogue traces: real sha256 and size
  per file, the scenario directory, and the `TRC-...` key derived from the filename's own
  12-hex content digest. No MF4 is parsed.
- **`results/acc-verdicts.json`** - 333 verdicts = 37 traces x
  9 checks, captured from `python -m TestImpl.cli --dir Data --json`
  (exit code 1, which is expected).
  Status distribution: FAIL 7, INCONCLUSIVE 130, PASS 196.
  The seven FAILs are all `TC-ACC-SYS-PRF-020` measuring an achieved deceleration of up to
  3.824 m/s^2 against a 3.5 m/s^2 bound. That failure is the finding the demo exists to show;
  a `measured: 0.00 PASS` there would mean the ingest read the wrong signal.
- **`figures/F1..F6*.svg`** - the six requirement figures, served by
  `GET /api/v1/vmodel/figures/{figure_id}`.

## How it gets into Mongo

`backend/api/vmodel_seed.py` ingests all of it as artifact version `v0001` of each kind plus
baseline `BL-0001`, at application startup and from `POST /api/v1/vmodel/seed`. Only one
version of each set exists: acc_project has published one, the historical all-Draft
requirement registers were not recoverable, and a second version is deliberately **not**
synthesised to make the version dimension look busy.
