---
id: mvxtt8yp
name: calendar-anchored-windows
kind: feature
horizon: later
parent: kyeb086y
adrs: []
features: []
created: 2026-08-18T00:53:20Z
updated: 2026-08-18T00:53:20Z
---
Add calendar-anchored --since tokens beside the rolling windows: today, this-week, this-month, each meaning 'since the boundary turned' rather than 'n units back from now'. A rolling window cannot express the question they answer — on a Monday morning --since 7d reaches into the previous Tuesday, so 'what moved this sprint' comes back smeared with four days that belong to the week before. Single hyphenated tokens, not quoted prose ('this week' forces shell quoting, which is friction for a human and a bug farm for an agent composing a command string). Boundaries anchor to UTC midnight with ISO weeks starting Monday, stated plainly in the help, because Nahel has no local-timezone concept and a boundary that silently means something else near midnight is a rendered lie. Deliberately EXCLUDES 'yesterday': --since is a lower bound only, so --since yesterday would mean 'from the start of yesterday onward' and quietly include all of today — the word promises a bounded day and delivers a day and a half. yesterday becomes honest only alongside an --until upper bound, which is a separate delta this node does not take on. Follows the shipped since-relative-windows work (0t9c51j9), which put every --since consumer on one shared resolver; these tokens extend that resolver and inherit every verb at once.
