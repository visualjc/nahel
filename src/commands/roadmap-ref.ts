import { ID_PATTERN } from "../schema/id";
import { resolveRoadmapNode, type StoreLayout } from "../store/layout";
import { UsageError } from "./item";

/**
 * The roadmap layer's shared reference resolution. It lives in its own module
 * because all three verb families need it — `roadmap node` links nodes to
 * nodes, `roadmap map` attaches a map to one, and their dispatcher is the same
 * command — and importing it from any one of them would close a cycle.
 */

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
