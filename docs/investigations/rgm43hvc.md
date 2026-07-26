# Investigation — docs-log-note-body-key (`rgm43hvc`)

## Symptoms

Four canonical workflow docs instruct agents to run a `nahel log note`
command the CLI refuses outright. `nahel log note --data body="..."` exits 1
with:

    ❌ --data key "body" is reserved for mutation payloads — mutations self-record through `nahel item`/`nahel run`

Affected lines (all `nahel log note` invocations):

- `nahel/workflows/task-lifecycle.md:50` and `:55`
- `nahel/workflows/prd-parse.md:42`
- `nahel/workflows/epic-decompose.md:53`

The `nahel observe --data body=` usages in `bug-lane.md` and `compact.md`
are FINE — `observe` *requires* `body`; the reservation is `log`-only.

## Repro status

Reproduced deterministically:

    $ nahel log note --data body="repro check"
    ❌ --data key "body" is reserved for mutation payloads — mutations self-record through `nahel item`/`nahel run`
    (exit 1)

Repro test: `tests/commands/workflows.test.ts` sweeps every shipped doc in
`nahel/workflows/` and asserts no `nahel log` example uses a reserved
mutation payload key, driven off `MUTATION_PAYLOAD_KEYS` so the test tracks
the source of truth. Red before the fix (4 violations), green after.

## Hypotheses tested

1. **Docs drifted after the reservation was added** — REFUTED. The
   reservation landed 2026-07-18 (`3249203`, PR #12 review: `nahel log`
   refuses `MUTATION_PAYLOAD_KEYS` = `target`/`record`/`body` from
   `src/store/mutate.ts:200`, enforced at `src/commands/log.ts:147`). The
   feature-lane docs landed 2026-07-21 (`bf34d52`) — three days *later*,
   already carrying `--data body=`. The docs were born broken, not drifted.
2. **`body` is the journaled-note convention** — REFUTED. Real journaled
   notes use `summary` (every `note` event in `nahel progress`;
   `afk-run.md` and `review-loop.md` consistently use `--data summary=`).
   `body` is the *observation* payload field (`nahel observe`) and a
   mutation replay key — banned at `log`'s top level so a logged
   observation can never masquerade as a mutation.

## Root cause

`bf34d52` authored the feature-lane workflow docs using `--data body=` for
`nahel log note` examples — the `observe`/mutation payload convention —
three days after `3249203` had reserved `body` (with `target` and `record`)
from `nahel log`. No test scanned doc examples against the CLI's reserved
keys, so the invalid examples shipped. The existing doc tests asserted the
commands *exist* (`nahel log note`) but not that their flags are accepted.

## Fix

Change the four `--data body=` occurrences to `--data summary=` (matching
`afk-run.md`), and add the reserved-key sweep test described above so a doc
can never again instruct a `nahel log` call the CLI rejects.
