import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { CORE_EVENT_TYPES } from "../../src/schema/events";
import { appendEvent, newSessionSegmentId } from "../../src/store/journal";
import { readItem } from "../../src/store/layout";
import { mutate, replayPending } from "../../src/store/mutate";
import { validateStore } from "../../src/validate";
import {
  createItem,
  findingsFor,
  healItemWrites,
  sabotageItemWrites,
  setupFixture,
} from "./helpers";

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

describe("validate — journal-ahead divergence and --repair (kill-injected crash window)", () => {
  test("detect → repair → clean: a record behind its latest mutation event is found, replayed, and revalidates silently", async () => {
    const fixture = await setupFixture(dirs);
    const v1 = await createItem(fixture, {}, "version one\n");

    // Kill-inject the crash window: journal the update, lose the record write.
    await sabotageItemWrites(fixture.layout.itemsDir);
    const v2 = { ...v1, status: "in-progress" as const, updated: fixture.env.now() };
    expect(
      mutate(fixture.agent, {
        target: "item",
        eventType: CORE_EVENT_TYPES.itemUpdated,
        frontmatter: v2,
        body: "version two\n",
      }),
    ).rejects.toThrow();
    await healItemWrites(fixture.layout.itemsDir);

    // Detect: the divergence is an error pointing at --repair.
    const findings = findingsFor(await validateStore(fixture.layout), "journal.divergence");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain(v1.id);
    expect(findings[0]!.fix).toContain("--repair");

    // Detection alone never mutates: the record is still v1 on disk.
    const before = await readItem(fixture.layout, v1.id);
    expect(before.frontmatter).toEqual(v1);
    expect(before.body).toBe("version one\n");

    // Repair replays the store's journaled mutation; the store is then clean.
    const repaired = await replayPending(fixture.layout);
    expect(repaired.map((r) => `${r.target}:${r.id}`)).toEqual([`item:${v1.id}`]);
    const after = await readItem(fixture.layout, v1.id);
    expect(after.frontmatter).toEqual(v2);
    expect(after.body).toBe("version two\n");
    expect(await validateStore(fixture.layout)).toEqual([]);
  });

  test("a record that was never materialized at all (crash on create) is divergent", async () => {
    const fixture = await setupFixture(dirs);
    await sabotageItemWrites(fixture.layout.itemsDir);
    const { makeFrontmatter } = await import("../store/helpers");
    const v1 = makeFrontmatter(fixture.env);
    expect(
      mutate(fixture.agent, {
        target: "item",
        eventType: CORE_EVENT_TYPES.itemCreated,
        frontmatter: v1,
        body: "born in the journal\n",
      }),
    ).rejects.toThrow();
    await healItemWrites(fixture.layout.itemsDir);

    const findings = findingsFor(await validateStore(fixture.layout), "journal.divergence");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain(v1.id);
  });

  test("a mutation event whose payload cannot be replayed is reported, never thrown", async () => {
    const fixture = await setupFixture(dirs);
    await appendEvent(fixture.layout, fixture.env, {
      type: CORE_EVENT_TYPES.itemUpdated,
      actor: fixture.agent.actor,
      item: "zzzzzzzz",
      payload: { target: "item", record: { id: "not a valid record" }, body: 42 },
      session: newSessionSegmentId(fixture.env),
    });

    const findings = findingsFor(await validateStore(fixture.layout), "journal.payload");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain("replay");
  });
});
