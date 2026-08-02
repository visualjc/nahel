import { ID_PATTERN } from "../schema/id";
import { resolveRoadmapNode, type StoreLayout } from "../store/layout";
import { UsageError } from "./item";

/**
 * The roadmap layer's shared reference resolution and text hardening. Both live
 * in their own module because all three verb families need them — `roadmap
 * node` links nodes to nodes, `roadmap map` attaches a map to one, `roadmap
 * ticket` writes the map's index lines, and their dispatcher is the same
 * command — and importing them from any one of those would close a cycle.
 */

/**
 * Refuse an embedded CR or LF in a text the layer renders as ONE line: a map's
 * destination, its fog and out-of-scope entries, a decision, a close's reason.
 * Each is written back as a single row — in the map's index sections, in
 * `ticket show`'s fields, as the decision observation's first line — so a
 * smuggled newline would forge extra rows in every one of those renderings, and
 * the store would be reporting entries nobody wrote.
 *
 * Bodies are deliberately exempt and stay multi-line: a ticket's question and a
 * map's notes are prose, and the record's markdown body is where prose belongs.
 */
export function requireSingleLine(value: string, flag: string): string {
  if (/[\r\n]/.test(value)) {
    throw new UsageError(
      `${flag} must be one line — the text carries an embedded newline, and this field is rendered as a ` +
        "single row (the map's index sections, `nahel roadmap ticket show`). Prose belongs in a record " +
        "body: a ticket's --question, a map's --notes.",
    );
  }
  return value;
}

/** How many guesses a missed ref is offered before the full list is the answer. */
const NEAR_MISS_CAP = 5;

/** The shortest prefix worth calling a resemblance — two letters resemble everything. */
const NEAR_MISS_PREFIX = 3;

/** How many leading characters two strings share. */
function sharedPrefix(a: string, b: string): number {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  return shared;
}

/**
 * The stored slugs a missed ref resembles (F3: "unknown refs … name the
 * near-miss slugs"). Resemblance is deliberately mechanical rather than a
 * distance score: either slug contains the other, or they share a three-letter
 * prefix. A typo, a truncation, and a forgotten suffix are what actually happens
 * at a prompt, and a rule with no tuning constants derives the same guesses on
 * every machine.
 *
 * Alphabetical and capped, so the list neither wobbles nor sprawls — the caller
 * points at `nahel roadmap` for the complete enumeration.
 */
export function nearMissNames(names: readonly string[], ref: string): string[] {
  const needle = ref.toLowerCase();
  return [...new Set(names)]
    .filter((name) => {
      const candidate = name.toLowerCase();
      return (
        candidate.includes(needle) ||
        needle.includes(candidate) ||
        sharedPrefix(candidate, needle) >= NEAR_MISS_PREFIX
      );
    })
    .sort()
    .slice(0, NEAR_MISS_CAP);
}

/**
 * Resolve a node reference to an id. A slug must name a node that exists —
 * there is nothing else it could mean. A well-formed id is recorded as given
 * even when no record carries it yet: the node may arrive by a later merge
 * (ADR-0012), and a dangling ref is `validate`'s business, never a refusal.
 */
export async function resolveNodeRef(
  layout: StoreLayout,
  ref: string,
  what: string,
): Promise<string> {
  const record = await resolveRoadmapNode(layout, ref);
  if (record !== null) return record.frontmatter.id;
  if (ID_PATTERN.test(ref)) return ref;
  throw new UsageError(
    `${what} ${JSON.stringify(ref)} does not name a roadmap node — pass an existing node's slug, or its id`,
  );
}
