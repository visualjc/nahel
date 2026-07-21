---
name: setup-routing
description: Detect available agent CLIs and models, then write the responsibility routing map via the CLI
args: ""
---

# Workflow: setup-routing

Load and follow this workflow to set (or refresh) the responsibility routing
map: which agent CLI and/or model this project prefers for each kind of
judgment — `architecture`, `implementation`, `review` — plus a `default`.
The map is ADVISORY in this phase (ADR-0015): `nahel brief` surfaces it so
interactive sessions can honor it (e.g. spawning implementation subagents on
the mapped model); nothing blocks on it. Enforcement arrives with autonomous
dispatch.

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
4. Confirm the proposal with the human, then write it as one replacement —
   `config set` swaps the whole section, so state every entry you intend
   to keep:

       nahel config set routing --data '{
         "architecture":   {"agent": "claude", "model": "<model>"},
         "implementation": {"agent": "claude"},
         "review":         {"agent": "codex"},
         "default":        {"agent": "claude"}
       }'

   Only the responsibilities above exist — the CLI rejects any other key.
5. Verify: `nahel brief` now shows the routing map. It is committed config,
   so a fresh clone gets the same map with zero local setup.

Fallback (degraded environment): if the `nahel` CLI is unavailable, report
the detected CLIs and the proposed map as notes, but make NO state
mutations — routing lives in CLI-maintained config.
