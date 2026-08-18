# Investigation — 2xtxgmqy: `progress --since 7d` is refused

## Symptom

```
$ nahel progress --since 7d
❌ invalid --since "7d" — must be an ISO-8601 UTC timestamp with second precision: YYYY-MM-DDTHH:MM:SSZ
usage: nahel progress [--item <id>] [--since <iso>] [--limit <n>]
```

The same window works on the sibling verbs:

```
$ nahel standup --since 7d     # accepted
$ nahel decisions --since 30d  # accepted
```

Found by reading `nahel --help` from bare bash: the top-level listing
advertises `--since 7d|24h|ISO` for `standup` one line above `progress`,
so `7d` reads as the flag's language across the CLI.

## Repro status

Reproduced deterministically. `--since 7d` exits 1 on `progress` and 0 on
`standup` against the same store.

## Root cause

Three commands take `--since`, and one of them parses it differently.

- `standup` (src/commands/standup.ts:55) and `decisions`
  (src/views/decision-query.ts:144) call `resolveSince()`
  (src/views/standup.ts:82), which accepts a relative span (`7d`, `24h`) or
  an ISO-8601 UTC timestamp, resolving the relative form against
  `ctx.env.now()`.
- `progress` (src/commands/progress.ts:59) instead validates the raw string
  against `journalEventSchema.shape.ts` — the journal's own storage format.
  A stored event's `ts` is necessarily absolute, so that schema can only ever
  accept a timestamp. `7d` is not a defect in the resolver; it never reaches
  the resolver.

The schema was a reasonable local choice ("the filter's contract is the
journal's own format") that became wrong once `resolveSince` existed and two
other verbs adopted it. The usage line `--since <iso>` and the error text
faithfully describe the narrow parser, so nothing surfaced the divergence.

## Hypotheses tested

1. *The resolver rejects `7d` under `progress`'s clock.* — FALSE. `progress`
   never calls the resolver; the schema check throws first, before the store
   is even opened.
2. *`progress` has no clock to resolve a relative window against.* — FALSE.
   `CommandContext.env.now()` is available exactly as in `standup`, which
   resolves the window in the command and hands the view a resolved cutoff
   (ADR-0004 / hard constraint 1: the view never sees a clock).

## Fix

Route `progress --since` through `resolveSince`, resolved in the command from
`ctx.env.now()` before the store is opened — the `standup` shape — and state
the accepted forms in the usage line and in the refusal. `ProgressQuery.since`
keeps receiving an absolute timestamp, so the view layer is untouched.
