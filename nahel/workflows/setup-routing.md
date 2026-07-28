---
name: setup-routing
description: Detect available agent CLIs and models, then write the responsibility routing map via the CLI
args: ""
---

# Workflow: setup-routing

Load and follow this workflow to set (or refresh) the responsibility routing
map: which agent CLI and/or model this project prefers for each kind of
judgment — `architecture`, `implementation`, `review` — plus a `default`.
The map is ADVISORY to interactive sessions (ADR-0015): `nahel brief` surfaces
it so they can honor it (e.g. spawning implementation subagents on the mapped
model); nothing blocks on it. It is ENFORCED by `nahel dispatch`, which
refuses to launch anything a route does not name.

Before any `nahel` command: if you are an agent, set
`NAHEL_ACTOR=agent:<your-id>` so every journal event carries your identity.

1. Detect the available agent CLIs: check PATH for `claude`, `codex`,
   `cursor-agent`, and `opencode` (`command -v <name>`), noting the version
   of each one present (`<name> --version`).
2. Determine the models each detected CLI can run — its help output, model
   listing, or configuration. Ask the human about anything you cannot probe
   (subscription tiers, org policy).
3. Propose the map — judgment, not detection: which executor should own each
   responsibility, and which is the default. A single-CLI environment is
   fine (everything routes to the default); when two vendors are available,
   cross-vendor review (one vendor implements, the other reviews) is worth
   proposing. Each entry names an `agent` (the CLI), a `model`, or both;
   omit a responsibility rather than inventing an empty entry.

   With two vendors, name BOTH review slots: `review` is the reviewer the
   loop spawns, and the optional `review2` names the second slot's vendor —
   the one driving the loop, reviewing under its own actor
   (`nahel/workflows/review-loop.md` step 1). Naming it makes the pairing
   checkable: `nahel validate` warns (`routing.review-same-vendor`) when both
   slots land on one vendor, which is a review loop that cannot sign
   anything off.
4. Confirm the proposal with the human, then write it as one replacement —
   `config set` swaps the whole section, so state every entry you intend
   to keep:

       nahel config set routing --data '{
         "architecture":   {"agent": "claude", "model": "<model>"},
         "implementation": {"agent": "claude"},
         "review":         {"agent": "codex"},
         "review2":        {"agent": "claude"},
         "default":        {"agent": "claude"}
       }'

   Only the keys above exist — the CLI rejects any other. `review2` and
   `default` are slots rather than responsibilities: neither is dispatchable
   (`nahel dispatch review2` is refused), so route work through
   `architecture`, `implementation`, and `review`.
   An `agent` must be one `nahel dispatch` knows how to invoke — `claude`,
   `codex`, or `cursor-agent`; anything else (opencode today) is fine to
   detect and report, but routing to it makes dispatch refuse. A route with
   no `agent` at all is advisory-only for the same reason: dispatch needs a
   CLI to spawn.
5. Verify: `nahel brief` now shows the routing map. It is committed config,
   so a fresh clone gets the same map with zero local setup.
6. Only if a detected CLI is not on PATH under its own name, or needs
   standing flags, record how to invoke it — the shipped defaults otherwise
   need no config at all:

       nahel config set dispatch --data '{
         "claude": {"binary": "/opt/homebrew/bin/claude", "args": ["-p"], "model_flag": "--model"}
       }'

   The section replaces wholesale per agent kind, and the prompt is always
   passed as the trailing argument (ADR-0016 addendum).

Fallback (degraded environment): if the `nahel` CLI is unavailable, report
the detected CLIs and the proposed map as notes, but make NO state
mutations — routing lives in CLI-maintained config.
