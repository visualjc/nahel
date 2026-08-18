---
id: kvty1m76
name: dispatch-default-host
kind: feature
horizon: next
parent: kyeb086y
adrs: []
features: []
created: 2026-08-09T23:17:56Z
updated: 2026-08-09T23:17:56Z
---
Make the dispatch routing 'default' resolve to the host — the agentic tool nahel is currently running inside — instead of a hard-coded agent name. Today the routing map pins default to a specific external agent (e.g. 'default: agent=cursor-agent model=auto'), which is wrong in kind: the sensible fallback for an unrouted responsibility is whatever agent is already driving the session, not a fixed third-party CLI. Scope: (1) introduce a 'host' sentinel value for routing entries that resolves at dispatch time to the running agent tool (detect from environment, e.g. Claude Code vs codex vs cursor-agent); (2) make 'default: host' the shipped/init default; (3) keep explicit agent pins working unchanged for named responsibilities like implementation/review. Motivation: a stale-config confusion during an agent discussion showed how easy it is for a pinned default to silently point at the wrong agent — host-relative default removes that class of misrouting.
