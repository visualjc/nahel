---
name: migrate-roadmap
description: Adopt a store's existing backlog into the roadmap layer — journal the selected set, then create the nodes it names
args: "<product-node-slug>"
---

# Workflow: migrate-roadmap

Load and follow this workflow **once per store**, to give a store that has
work items but no roadmap its first one. Nothing here invents intent: the
roadmap layer starts by adopting the intent the backlog is already carrying.
After this runs, new intent is charted one node at a time with the ordinary
`roadmap node` verb — there is never a second migration.

Before any `nahel` command: if you are an agent, set
`NAHEL_ACTOR=agent:<your-id>` so every journal event carries your identity.

Three rules hold throughout.

**Coverage, not a count.** *Every* roadmap-shaped backlog item in the store at
migration time gets a node. There is no target number: a migration that
produced "about eight nodes" has counted, not covered.

**The selection is a judgment, and the CLI never judges** (HC1) — it derives
and renders. Deciding which backlog items are roadmap-shaped is the
**migrating agent's** call, which is exactly why step 3 writes the whole call
down before step 5 acts on it.

**Migration writes node records only.** The node names the item it covers and
nothing is ever written back onto the item; never hand-edit anything under
`nahel/`.

1. Enumerate the candidates **from the store**:

       nahel status

   Every line is `<name>  <type>  <status>  lane=<lane>  id=<id>`. Your
   candidate set is every item at status `backlog`, read off that output.

   Do **not** start from `docs/roadmap.md`, from a PRD's list, or from a
   previous session's notes. Those are a **snapshot** of the day they were
   written, and the gap between such a list and the store is the whole reason
   this step names a command instead of a document.

2. Judge each candidate. **Roadmap-shaped** means the item states *product
   intent*: a capability of the product someone outside the codebase would
   notice, which the roadmap still carries after the work is done.
   **Work-shaped** means it states a task — a defect, a chore, a refactor, or
   a piece of a feature that already exists.

   The item's `type` is evidence, not the answer. Common shapes:

   - a `feature` item stating a capability nobody has built yet — **include**,
     including the deliberately-future ones. A node whose horizon is `later`
     is still coverage; leaving it out because it is far off is a count.
   - a `bug` item — **exclude**: a defect in shipped behaviour is work, not
     roadmap intent, however large it is.
   - a `chore` — **exclude**, same reason.
   - a `feature`-typed item parented under an existing epic — **exclude**: it
     is a piece of work under that feature, and the parent is what earns a
     node.
   - an item not at `backlog` — **exclude**: migration covers the backlog, and
     an item already delivered or dropped is not intent waiting to be placed.

   Every candidate you excluded that a reasonable reviewer could have included
   is a **near-miss**, and it needs a **one-line reason**. The test is simple:
   if you had to think about it, it is a near-miss. Excluding something in
   silence is the failure this step exists to prevent — a reviewer can argue
   with a reason, but cannot see an omission.

3. Journal the selected set. This event is the **first** act of the migration:

       nahel log roadmap.migration-selected \
         --data included='["<item-id>","<item-id>","<item-id>"]' \
         --data excluded='[{"id":"<item-id>","reason":"<why this one is work, not roadmap intent>"}]'

   `included` is every id that gets a node; `excluded` is every near-miss with
   its reason. Write it **before the first node exists** — **journal order**
   is what proves the call was made rather than reverse-engineered. A set
   logged after the nodes proves nothing: a reviewer can no longer tell the
   judgment from its result.

   So get it complete before you log it. Re-read step 1's output one last
   time; a set you have to correct afterwards is a set the first event got
   wrong, and that is what the journal will show.

   `nahel log` prints the id of the event it wrote — that line is your
   confirmation the set landed.

   **Do not batch this step and the node creations into one script** — and do
   not trust composition to take long enough either: two ordinary invocations
   share a second easily.

   **Wait until the clock has left the selection's second** before creating
   the first node. One deliberate pause, made on purpose, is the only thing
   that makes the ordering true rather than likely. Journal timestamps are
   second-precision and every CLI invocation writes its own segment, so two
   acts in the same second have **no provable order**. A same-second tie
   **fails the migration**, and cannot be repaired by an explanatory note —
   the ordering IS the audit trail, so a migration that cannot prove its own
   order has not been made. Step 6 accepts or fails it on exactly that test.

4. Create the product node — one per store:

       nahel roadmap node new product <product-node-slug> --horizon now \
         --intent "<what this product is, a paragraph — not a PRD>" \
         --design-doc <repo-relative path to the product design doc>

   The design doc is the permanent statement of what the product is (in
   nahel's own store, `docs/roadmap.md`). Product design docs are updated in
   place forever; unlike a PRD, none is ever archived.

5. Create one feature node per **included** id — every id in the set, and no
   id the set does not name:

       nahel roadmap node new feature <slug> --horizon <now|next|later> \
         --parent <product-node-slug> --epic <item-id> \
         --intent "<the roadmap-level statement of this feature>"

   `--epic` records the item this node covers. The reference is **one-way**
   and canonical — it lives on the node, and no work-item record is written at
   all. Reuse the item's own name as the slug where it already reads as one,
   so a reader can trace node and item without a lookup. The horizon is a
   judgment like the selection: `now` for what is being worked, `later` for
   the deliberately-future ones you still covered.

6. Check the coverage in both directions — either one alone passes a broken
   migration:

       nahel roadmap
       nahel roadmap node show <slug>

   Every included id must have a node (`epic=<item-id>` on the node is the
   trace back), and every node must name an included id — **no orphan** node,
   and **nothing invented** that the logged set never selected. If the two
   disagree, the nodes are what you fix; the set is already journaled.

   Then accept — or fail — the migration on its journal order:

       nahel progress

   The rendered position is the **quick look**: your
   `roadmap.migration-selected` line should sit **above every**
   `roadmap.node-created` line. It is not the acceptance. A same-second tie
   breaks on the random event id, so the wrong order renders as the right one
   about half the time, and an eyeballed timeline would pass it.

   The acceptance is **strict timestamp inequality**: read the leading `ts` of
   the selection line, then the leading `ts` of every `roadmap.node-created`
   line, and each of those must be **strictly later**. Equal timestamps are a
   same-second tie, and a same-second tie **fails the migration** — it
   cannot be repaired by an explanatory note. No CLI verb unmakes a node, so a
   failed migration stops here and is reported as failed; what the store does
   about it is a decision above this workflow.

7. Prove the direction, then leave the store clean:

       git diff --stat -- nahel/items/
       nahel validate

   `git diff` over `nahel/items/` must print **nothing**. A single modified
   item record means the migration went the wrong way — the roadmap points at
   work items, never the reverse — and that is a bug to undo, not a diff to
   commit.

   Then journal the act, so the next session reads why the tree looks like
   this without replaying the whole migration:

       nahel log note --data summary="migrated <store>: <n> feature nodes under <product-node-slug>, <n> near-misses excluded"

Fallback (degraded environment): if the `nahel` CLI is unavailable, the
judgment may proceed — but make NO node or journal mutations; report the
selected set and every near-miss with its reason so a CLI-equipped session can
record them in that order. A selection nobody journaled is a migration nobody
can audit, which is the one thing this workflow exists to prevent.
