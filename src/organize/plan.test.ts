import { describe, expect, it, vi } from "vitest";
import { buildPlan, validatePlan } from "@/src/organize/plan";
import { DEFAULT_SETTINGS, effectiveRules, DEFAULT_RULES } from "@/src/settings/state";
import type { Choice, Judge, Plan, Snapshot } from "@/src/types";
const before: Snapshot = {
  windowId: 1,
  groups: [{ id: 7, title: "Development", color: "blue", collapsed: true }],
  tabs: [
    { id: 1, index: 0, title: "Pinned", url: "https://pinned.test/", pinned: true, groupId: -1 },
    { id: 2, index: 1, title: "Docs", url: "https://docs.test/", pinned: false, groupId: 7 },
    { id: 3, index: 2, title: "Issue", url: "https://issue.test/", pinned: false, groupId: -1 },
    { id: 4, index: 3, title: "Trip A", url: "https://trip.test/a", pinned: false, groupId: -1 },
    { id: 5, index: 4, title: "Trip B", url: "https://trip.test/b", pinned: false, groupId: -1 },
  ],
};
const judge: Judge = async (_state, questions) =>
  Object.fromEntries(
    Object.entries(questions).map(([id, q]) => {
      if (q.type === "score")
        return [
          id,
          {
            type: "score",
            score: 2,
            confidence: 1,
            legend: Object.fromEntries(q.criteria.map((level, i) => [String(i), level])),
            probabilities: { "0": 0, "1": 0, "2": 1, "3": 0, "4": 0 },
          },
        ];
      const choice =
        id === "membership_3"
          ? "group_7"
          : id.startsWith("membership_")
            ? "none"
            : id === "topic_5"
              ? "4"
              : id.startsWith("topic_")
                ? "self"
                : id.startsWith("related_")
                  ? "self"
                  : id === "create"
                    ? "yes"
                    : "keep";
      return [
        id,
        {
          type: "choice",
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(q.criteria).map((k) => [k, k === choice ? 1 : 0]),
          ),
        } satisfies Choice,
      ];
    }),
  );
it("keeps an existing group from absorbing adjacency choices for ungrouped tabs", async () => {
  const source: Snapshot = {
    ...before,
    tabs: [
      { ...before.tabs[1], url: "https://trip.test/grouped", index: 0 },
      { ...before.tabs[3], index: 1 },
      { ...before.tabs[3], id: 6, url: "https://other.test/", index: 2 },
      { ...before.tabs[4], index: 3 },
    ],
  };
  const result = await buildPlan(
    source,
    DEFAULT_SETTINGS,
    async (state, questions) => {
      const answers = await judge(state, questions);
      for (const [key, question] of Object.entries(questions)) {
        if (!key.startsWith("topic_") || question.type !== "choice") continue;
        const target = source.tabs.find((tab) => tab.id === Number(key.slice(6)))!;
        // Simulate Jev selecting the earliest matching domain from the offered candidates.
        const match = source.tabs.find(
          (tab) =>
            String(tab.id) in question.criteria &&
            new URL(tab.url).hostname === new URL(target.url).hostname,
        );
        const choice = match ? String(match.id) : "self";
        answers[key] = {
          type: "choice",
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(question.criteria).map((id) => [id, id === choice ? 1 : 0]),
          ),
        };
      }
      return answers;
    },
    async () => "Unused",
    () => {},
  );
  expect(result.blocks.map((block) => block.tabIds)).toEqual([[2], [4, 5], [6]]);
});
describe("organization constraints", () => {
  it("labels choices and targets without repeating private URL components", async () => {
    const source: Snapshot = {
      ...before,
      groups: [{ ...before.groups[0], title: 'GitHub "work"' }],
      tabs: before.tabs.map((tab) => ({
        ...tab,
        url:
          tab.id === 4
            ? "https://PRIVATE_USER:PRIVATE_PASSWORD@github.com/repo?PRIVATE_QUERY#PRIVATE_FRAGMENT"
            : tab.id === 5
              ? "https://proshunsuke.github.io/"
              : tab.url,
      })),
    };
    const inspect = vi.fn<Judge>(async (state, questions) => {
      if (questions.membership_5)
        expect(questions.membership_5).toMatchObject({
          instructions: expect.stringContaining("Domain: proshunsuke.github.io"),
          criteria: { none: "Keep ungrouped", group_7: 'Group name: "GitHub \\"work\\""' },
        });
      if (questions.topic_5)
        expect(questions.topic_5).toMatchObject({
          instructions: expect.stringContaining("Domain: proshunsuke.github.io"),
          criteria: {
            self: "No matching candidate",
            "3": "Domain: issue.test",
            "4": "Domain: github.com",
          },
        });
      if (questions.related_topic_5)
        expect(questions.related_topic_5).toMatchObject({
          criteria: {
            self: "Keep separate",
            group_7: 'Group name: "GitHub \\"work\\""',
            topic_3: "Domain: issue.test",
            topic_4: "Domain: github.com",
          },
        });
      expect(JSON.stringify({ state, questions })).not.toContain("PRIVATE_");
      return judge(state, questions);
    });
    const result = await buildPlan(
      source,
      DEFAULT_SETTINGS,
      inspect,
      async () => "Unused",
      () => {},
    );
    expect(inspect).toHaveBeenCalledTimes(5);
    expect(result.blocks.map((block) => block.tabIds)).toEqual([
      [2, 3],
      [4, 5],
    ]);
  });

  it("keeps memberships, adds an ungrouped tab, creates only related ungrouped tabs", async () => {
    const result = await buildPlan(
      before,
      { ...DEFAULT_SETTINGS, allowNewGroups: true },
      judge,
      async () => "Travel",
      () => {},
    );
    expect(result.blocks).toEqual([
      { key: "group_7", groupId: 7, title: "Development", tabIds: [2, 3] },
      { key: "topic_4", title: "Travel", tabIds: [4, 5], create: true },
    ]);
    expect(result.before).toEqual(before);
  });
  it("enforces creation disabled despite a yes from Jev", async () => {
    const result = await buildPlan(
      before,
      DEFAULT_SETTINGS,
      judge,
      async () => {
        throw new Error("must not call");
      },
      () => {},
    );
    expect(result.blocks[1]).toEqual({ key: "topic_4", title: "", tabIds: [4, 5], create: false });
  });
  it("leaves new clusters ungrouped when local naming fails", async () => {
    const result = await buildPlan(
      before,
      { ...DEFAULT_SETTINGS, allowNewGroups: true },
      judge,
      async () => {
        throw new Error("unavailable");
      },
      () => {},
    );
    expect(result.warnings).toEqual(["namingSkipped"]);
    expect(result.blocks[1].create).toBe(false);
  });
  it("replaces default rules completely", () => {
    expect(effectiveRules({ ...DEFAULT_SETTINGS, rules: "  URLs ascending  " })).toBe(
      "URLs ascending",
    );
    expect(effectiveRules({ ...DEFAULT_SETTINGS, rules: "   " })).toBe(DEFAULT_RULES);
  });
  it("rejects moving an existing group member outside its group", () => {
    const plan: Plan = {
      before,
      settings: DEFAULT_SETTINGS,
      warnings: [],
      blocks: [{ key: "all", title: "", tabIds: [2, 3, 4, 5] }],
    };
    expect(() => validatePlan(plan)).toThrow("invalidPlan");
  });
  it("rejects duplicates or omitted tabs", () => {
    const plan: Plan = {
      before,
      settings: DEFAULT_SETTINGS,
      warnings: [],
      blocks: [{ key: "group", groupId: 7, title: "", tabIds: [2, 3, 4, 4] }],
    };
    expect(() => validatePlan(plan)).toThrow("invalidPlan");
  });
});

it("places related groups adjacent without changing their memberships", async () => {
  const source: Snapshot = {
    windowId: 1,
    groups: [7, 8, 9].map((id) => ({ id, title: String(id), color: "blue", collapsed: false })),
    tabs: [7, 8, 9].map((id, index) => ({
      id,
      groupId: id,
      index,
      pinned: false,
      title: String(id),
      url: `https://example.test/${id}`,
    })),
  };
  const match: Judge = async (state, questions) => {
    const answers = await judge(state, questions);
    if (questions.related_group_9)
      answers.related_group_9 = {
        type: "choice",
        choice: "group_7",
        confidence: 1,
        probabilities: { self: 0, group_7: 1, group_8: 0 },
      };
    return answers;
  };
  const result = await buildPlan(
    source,
    DEFAULT_SETTINGS,
    match,
    async () => "Unused",
    () => {},
  );
  expect(result.blocks.map((block) => ({ group: block.groupId, tabs: block.tabIds }))).toEqual([
    { group: 7, tabs: [7] },
    { group: 9, tabs: [9] },
    { group: 8, tabs: [8] },
  ]);
});

it.each([true, false])(
  "uses the user setting to authorize new groups: %s",
  async (allowNewGroups) => {
    const naming = vi.fn(async () => "Travel");
    const result = await buildPlan(
      { ...before, groups: [], tabs: before.tabs.slice(3) },
      { ...DEFAULT_SETTINGS, allowNewGroups },
      async (state, questions) => {
        expect(questions).not.toHaveProperty("create");
        const answers = await judge(state, questions);
        // A stale/global veto must have no influence on the user's permission.
        answers.create = { type: "choice", choice: "no", confidence: 1, probabilities: { no: 1 } };
        return answers;
      },
      naming,
      () => {},
    );
    expect(result.blocks).toEqual([
      {
        key: "topic_4",
        title: allowNewGroups ? "Travel" : "",
        tabIds: [4, 5],
        create: allowNewGroups,
      },
    ]);
    expect(naming).toHaveBeenCalledTimes(allowNewGroups ? 1 : 0);
  },
);

it("leaves confidently unrelated tabs ungrouped when new groups are allowed", async () => {
  const naming = vi.fn(async () => "Unused");
  const source: Snapshot = {
    ...before,
    groups: [],
    tabs: [
      { ...before.tabs[3], title: "Travel plans", url: "https://travel.test/" },
      { ...before.tabs[4], title: "Database reference", url: "https://database.test/" },
    ],
  };
  const result = await buildPlan(
    source,
    { ...DEFAULT_SETTINGS, allowNewGroups: true },
    async (state, questions) => {
      expect(questions).not.toHaveProperty("create");
      const answers = await judge(state, questions);
      answers.topic_5 = {
        type: "choice",
        choice: "self",
        confidence: 1,
        probabilities: { self: 1, "4": 0 },
      };
      return answers;
    },
    naming,
    () => {},
  );
  expect(result.blocks).toEqual([
    { key: "topic_4", title: "", tabIds: [4], create: false },
    { key: "topic_5", title: "", tabIds: [5], create: false },
  ]);
  expect(naming).not.toHaveBeenCalled();
  expect(result.warnings).toEqual([]);
});

it.each(["none", "uncertainMembership", "uncertainTopic", "self"])(
  "preserves separate tabs for %s decisions",
  async (mode) => {
    const result = await buildPlan(
      before,
      DEFAULT_SETTINGS,
      async (state, questions) => {
        const answers = await judge(state, questions);
        if (questions.membership_3 && (mode === "none" || mode === "uncertainMembership")) {
          answers.membership_3 = {
            type: "choice",
            choice: mode === "none" ? "none" : "group_7",
            confidence: mode === "none" ? 1 : 0.1,
            probabilities: { none: mode === "none" ? 1 : 0, group_7: mode === "none" ? 0 : 1 },
          };
        }
        if (questions.topic_5 && (mode === "self" || mode === "uncertainTopic")) {
          answers.topic_5 = {
            type: "choice",
            choice: mode === "self" ? "self" : "4",
            confidence: mode === "self" ? 1 : 0.1,
            probabilities: { self: mode === "self" ? 1 : 0, "4": mode === "self" ? 0 : 1 },
          };
        }
        return answers;
      },
      async () => {
        throw Error("unexpected naming");
      },
      () => {},
    );
    expect(result.blocks.map((b) => b.tabIds)).toEqual(
      mode === "none" || mode === "uncertainMembership" ? [[2], [3], [4, 5]] : [[2, 3], [4], [5]],
    );
  },
);

it("keeps pinned and non-web metadata out of judge requests and never groups non-web tabs", async () => {
  const source = structuredClone(before);
  source.tabs.push({
    id: 6,
    index: 5,
    pinned: false,
    groupId: -1,
    title: "PRIVATE_INTERNAL",
    url: "chrome://settings/private",
  });
  const states: unknown[] = [];
  const result = await buildPlan(
    source,
    DEFAULT_SETTINGS,
    async (state, questions) => {
      states.push({ state, questions });
      expect(questions).not.toHaveProperty("membership_1");
      expect(questions).not.toHaveProperty("membership_6");
      expect(questions).not.toHaveProperty("topic_6");
      return judge(state, questions);
    },
    async () => "Unused",
    () => {},
  );
  expect(result.blocks.map((b) => b.tabIds)).toEqual([[2, 3], [4, 5], [6]]);
  expect(JSON.stringify(states)).not.toMatch(/pinned\.test|PRIVATE_INTERNAL|settings\/private/);
});

it("passes only custom rules through every planning stage", async () => {
  const rules = "Only reverse alphabetical order; never create groups";
  const result = await buildPlan(
    before,
    { ...DEFAULT_SETTINGS, rules },
    async (state, questions) => {
      expect(state).toHaveProperty("rules", rules);
      return judge(state, questions);
    },
    async () => "Unused",
    () => {},
  );
  expect(result.settings.rules).toBe(rules);
});

it("handles an empty window and more than 200 movable tabs", async () => {
  const empty = { windowId: 1, tabs: [], groups: [] };
  expect(
    await buildPlan(
      empty,
      DEFAULT_SETTINGS,
      judge,
      async () => "Unused",
      () => {},
    ),
  ).toEqual({ before: empty, settings: DEFAULT_SETTINGS, blocks: [], warnings: [] });
  const tabs = Array.from({ length: 201 }, (_, i) => ({ ...before.tabs[2], id: i, index: i }));
  const large = await buildPlan(
    { ...empty, tabs },
    DEFAULT_SETTINGS,
    judge,
    async () => "Unused",
    () => {},
  );
  expect(large.blocks.flatMap((block) => block.tabIds)).toHaveLength(201);
});

it.each([
  ["empty block", [{ key: "empty", title: "", tabIds: [] }]],
  ["missing tab", [{ key: "group", title: "Development", groupId: 7, tabIds: [2, 3, 4] }]],
  ["unknown group", [{ key: "group", title: "Development", groupId: 99, tabIds: [2, 3, 4, 5] }]],
  [
    "pinned tab included",
    [{ key: "group", title: "Development", groupId: 7, tabIds: [1, 2, 3, 4, 5] }],
  ],
  [
    "duplicate group",
    [
      { key: "a", title: "", groupId: 7, tabIds: [2] },
      { key: "b", title: "", groupId: 7, tabIds: [3, 4, 5] },
    ],
  ],
  [
    "existing group recreated",
    [{ key: "a", title: "", groupId: 7, create: true, tabIds: [2, 3, 4, 5] }],
  ],
] as const)("rejects invalid plans: %s", (_name, blocks) => {
  const plan = {
    before,
    settings: DEFAULT_SETTINGS,
    warnings: [],
    blocks: structuredClone(blocks),
  } as unknown as Plan;
  expect(() => validatePlan(plan)).toThrow("invalidPlan");
});

it.each([
  ["blank name", " ", [3, 4, 5]],
  ["long name", "x".repeat(61), [3, 4, 5]],
  ["single member", "Travel", [3]],
] as const)("rejects new group with %s", (_name, title, ids) => {
  const plan: Plan = {
    before,
    settings: { ...DEFAULT_SETTINGS, allowNewGroups: true },
    warnings: [],
    blocks: [
      { key: "existing", groupId: 7, title: "Development", tabIds: [2] },
      { key: "new", create: true, title, tabIds: [...ids] },
      ...[3, 4, 5]
        .filter((id) => !(ids as readonly number[]).includes(id))
        .map((id) => ({ key: String(id), title: "", tabIds: [id] })),
    ],
  };
  expect(() => validatePlan(plan)).toThrow("invalidPlan");
});

it.each(["chain", "self", "uncertain"])(
  "handles related-group %s decisions without merging memberships",
  async (mode) => {
    const source: Snapshot = {
      windowId: 1,
      groups: [7, 8, 9, 10].map((id) => ({
        id,
        title: String(id),
        color: "blue",
        collapsed: true,
      })),
      tabs: [7, 8, 9, 10].map((id, index) => ({
        id,
        index,
        groupId: id,
        pinned: false,
        title: String(id),
        url: `https://example.test/${id}`,
      })),
    };
    const result = await buildPlan(
      source,
      DEFAULT_SETTINGS,
      async (state, questions) => {
        const answers = await judge(state, questions);
        for (const [key, parent] of [
          ["related_group_9", "group_7"],
          ["related_group_10", "group_9"],
        ]) {
          if (questions[key]) {
            const choice = mode === "self" ? "self" : parent;
            answers[key] = {
              type: "choice",
              choice,
              confidence: mode === "uncertain" ? 0.29 : 1,
              probabilities: Object.fromEntries(
                Object.keys(questions[key].criteria).map((key) => [key, key === choice ? 1 : 0]),
              ),
            };
          }
        }
        return answers;
      },
      async () => "Unused",
      () => {},
    );
    expect(result.blocks).toEqual(
      (mode === "chain" ? [7, 9, 10, 8] : [7, 8, 9, 10]).map((id) => ({
        key: `group_${id}`,
        groupId: id,
        title: String(id),
        tabIds: [id],
      })),
    );
  },
);

it.each([4, 50, 100, 201])(
  "plans %s tabs within bounded HTTP requests including memberships and grouping",
  async (count) => {
    const { createJudge } = await import("@/src/ai/jev");
    const source: Snapshot = {
      windowId: 1,
      groups: [{ id: 7, title: "Docs", color: "blue", collapsed: false }],
      tabs: Array.from({ length: count }, (_, index) => ({
        id: index + 10,
        index,
        groupId: index < 2 ? 7 : -1,
        pinned: false,
        title: `Tab ${index}`,
        url: `https://example.test/${index}`,
      })),
    };
    const fetch = vi.fn(async (_url, init: RequestInit) => {
      const { questions } = JSON.parse(String(init.body));
      return Response.json({
        answers: Object.fromEntries(
          Object.entries(
            questions as Record<
              string,
              { type: string; criteria: Record<string, string> | string[] }
            >,
          ).map(([id, q]) => {
            if (q.type === "score")
              return [
                id,
                {
                  type: "score",
                  score: 0,
                  confidence: 1,
                  legend: Object.fromEntries(Object.entries(q.criteria)),
                  probabilities: { "0": 1, "1": 0, "2": 0, "3": 0, "4": 0 },
                },
              ];
            const choice =
              id === "create"
                ? "yes"
                : id.startsWith("membership_")
                  ? "none"
                  : id.startsWith("rank_")
                    ? "0"
                    : "self";
            return [
              id,
              {
                type: "choice",
                choice,
                confidence: 1,
                probabilities: Object.fromEntries(
                  Object.keys(q.criteria).map((key) => [key, key === choice ? 1 : 0]),
                ),
              },
            ];
          }),
        ),
      });
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const result = await buildPlan(
        source,
        { ...DEFAULT_SETTINGS, allowNewGroups: true },
        createJudge({ apiKey: "test-key" }, new AbortController().signal),
        async () => "Group",
        () => {},
      );
      if (count === 4) expect(fetch).toHaveBeenCalledTimes(5);
      if (count > 4) expect(fetch.mock.calls.length).toBeGreaterThan(1);
      for (const call of fetch.mock.calls)
        expect(new TextEncoder().encode(String(call[1].body)).length).toBeLessThanOrEqual(64000);
      expect(result.blocks.flatMap((block) => block.tabIds)).toEqual(
        source.tabs.map((tab) => tab.id),
      );
      expect(result.blocks[0].groupId).toBe(7);
      if (count > 4) return;
      const payload = JSON.parse(String(fetch.mock.calls[0][1].body));
      expect(payload.state.tabs).toHaveLength(count);
      expect(payload.state.groups[0].tabIds).toEqual(["10", "11"]);
      expect(payload.state.blocks[0].tabIds).toEqual(["10", "11"]);
      expect(JSON.stringify(payload.state).match(/"title":"Tab 0"/g)).toHaveLength(1);
      for (const [key, question] of Object.entries(
        payload.questions as Record<string, { type: string; criteria: unknown[] }>,
      )) {
        if (key.startsWith("rank_")) {
          expect(question.type).toBe("score");
          expect(question.criteria).toHaveLength(5);
        }
      }
      expect(payload.questions).not.toHaveProperty("rank_tab_10");
      expect(payload.questions).not.toHaveProperty("rank_block_group_7");
      expect(payload.questions).toHaveProperty("membership_12");
      expect(payload.questions).toHaveProperty("topic_13");
      expect(Object.keys(payload.questions).length).toBeLessThan(count * 5 + 1);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it("makes no request for a window with no eligible tabs", async () => {
  const noJudge = vi.fn<Judge>();
  await buildPlan(
    { windowId: 1, groups: [], tabs: [before.tabs[0]] },
    DEFAULT_SETTINGS,
    noJudge,
    async () => "Unused",
    () => {},
  );
  expect(noJudge).not.toHaveBeenCalled();
});

it("ignores topic associations that cross the final group boundary", async () => {
  const result = await buildPlan(
    before,
    DEFAULT_SETTINGS,
    async (state, questions) => {
      const answers = await judge(state, questions);
      answers.topic_4 = {
        type: "choice",
        choice: "2",
        confidence: 1,
        probabilities: { "2": 1, self: 0 },
      };
      return answers;
    },
    async () => "Unused",
    () => {},
  );
  expect(result.blocks.map((block) => block.tabIds)).toEqual([
    [2, 3],
    [4, 5],
  ]);
});

it("accepts moderate-confidence memberships and adjacency from Jev", async () => {
  const result = await buildPlan(
    before,
    DEFAULT_SETTINGS,
    async (state, questions) => {
      const answers = await judge(state, questions);
      answers.membership_3 = {
        type: "choice",
        choice: "group_7",
        confidence: 0.3,
        probabilities: { group_7: 0.65, none: 0.35 },
      };
      answers.topic_5 = {
        type: "choice",
        choice: "4",
        confidence: 0.3,
        probabilities: { "4": 0.65, self: 0.35 },
      };
      return answers;
    },
    async () => "Unused",
    () => {},
  );
  expect(result.blocks.map((block) => block.tabIds)).toEqual([
    [2, 3],
    [4, 5],
  ]);
});

it("ranks tabs only against final container peers after membership resolves", async () => {
  const states: { state: unknown; questions: Record<string, unknown> }[] = [];
  await buildPlan(
    before,
    DEFAULT_SETTINGS,
    async (state, questions) => {
      states.push({ state, questions });
      return judge(state, questions);
    },
    async () => "Unused",
    () => {},
  );
  const ranking = states.filter(({ questions }) =>
    Object.keys(questions).some((key) => key.startsWith("rank_tab_")),
  );
  expect(ranking).toHaveLength(2);
  expect(ranking[0].state).toMatchObject({ tabs: [{ id: "2" }, { id: "3" }] });
  expect(ranking[1].state).toMatchObject({ tabs: [{ id: "4" }, { id: "5" }] });
  expect(
    ranking.every(
      ({ state }) => !("blocks" in (state as object)) && !("groups" in (state as object)),
    ),
  ).toBe(true);
  const blocks = states.find(({ questions }) =>
    Object.keys(questions).some((key) => key.startsWith("rank_block_")),
  )!;
  expect(blocks.state).not.toHaveProperty("tabs");
  expect(blocks.state).toMatchObject({
    blocks: [
      { key: "group_7", representatives: [{ id: "2" }, { id: "3" }] },
      { key: "topic_4", representatives: [{ id: "4" }, { id: "5" }] },
    ],
  });
});

it.each([false, true])(
  "plans realistic oversized metadata through bounded requests before naming (grouped: %s)",
  async (grouped) => {
    const { createJudge } = await import("@/src/ai/jev");
    const { createDecisionProvider } = await import("@/src/ai/providers");
    const { describe: describeTab } = await import("@/src/tabs/snapshot");
    const source: Snapshot = {
      windowId: 1,
      groups: grouped
        ? [7, 8].map((id) => ({
            id,
            title: `Engineering ${id}`,
            color: "blue" as const,
            collapsed: false,
          }))
        : [],
      tabs: Array.from({ length: 240 }, (_, index) => ({
        id: index + 1,
        index,
        pinned: false,
        groupId: grouped ? (index < 120 ? 7 : 8) : -1,
        title: `Production architecture documentation ${index}: distributed systems, observability, incident response and performance tuning for enterprise services`,
        url: `https://documentation.example.test/engineering/platform/distributed-systems/observability/incident-response/performance/production-services/reference/${index}/detailed-design?tracking=private`,
      })),
    };
    const settings = { ...DEFAULT_SETTINGS, apiKey: "test", allowNewGroups: true };
    const signal = new AbortController().signal;
    const provider = createDecisionProvider(settings, signal);
    expect(
      provider.requestBytes({ state: { tabs: source.tabs.map(describeTab) }, questions: {} }),
    ).toBeGreaterThan(64000);
    let completedRanking = false;
    const naming = vi.fn(async () => {
      expect(completedRanking).toBe(true);
      return "Engineering";
    });
    const fetch = vi.fn(async (_url, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      expect(provider.requestBytes(payload)).toBeLessThanOrEqual(64000);
      expect(naming).not.toHaveBeenCalled();
      const answers = await judge(payload.state, payload.questions);
      for (const [key, question] of Object.entries(
        payload.questions as Record<string, import("@/src/types").Question>,
      )) {
        if (key.startsWith("topic_") && question.type === "choice") {
          const choice = Object.keys(question.criteria).find((key) => key !== "self") ?? "self";
          answers[key] = {
            type: "choice",
            choice,
            confidence: 1,
            probabilities: Object.fromEntries(
              Object.keys(question.criteria).map((key) => [key, key === choice ? 1 : 0]),
            ),
          };
        }
      }
      return Response.json({ answers });
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const realJudge = createJudge(settings, signal);
      const result = await buildPlan(
        source,
        settings,
        async (state, questions) => {
          const answers = await realJudge(state, questions);
          if (Object.keys(questions).some((key) => key.startsWith("rank_tab_")))
            completedRanking = true;
          return answers;
        },
        naming,
        () => {},
      );
      const ids = result.blocks.flatMap((block) => block.tabIds);
      expect(ids).toHaveLength(240);
      expect(new Set(ids).size).toBe(240);
      expect(fetch.mock.calls.length).toBeGreaterThan(1);
      expect(naming).toHaveBeenCalledTimes(grouped ? 0 : 1);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it.each(["tokenLimit", "cancelled", "invalidKey"])(
  "never names a group when later block ranking fails with %s",
  async (message) => {
    const naming = vi.fn(async () => "Travel");
    await expect(
      buildPlan(
        before,
        { ...DEFAULT_SETTINGS, allowNewGroups: true },
        async (state, questions) => {
          if (Object.keys(questions).some((key) => key.startsWith("rank_block_")))
            throw new Error(message);
          return judge(state, questions);
        },
        naming,
        () => {},
      ),
    ).rejects.toThrow(message);
    expect(naming).not.toHaveBeenCalled();
  },
);

it("ranks prospective new groups against their own clustering peers", async () => {
  const source: Snapshot = {
    windowId: 1,
    groups: [],
    tabs: [4, 5, 6, 7].map((id, index) => ({ ...before.tabs[3], id, index })),
  };
  const contexts: unknown[] = [];
  await buildPlan(
    source,
    { ...DEFAULT_SETTINGS, allowNewGroups: true },
    async (state, questions) => {
      if (Object.keys(questions).some((key) => key.startsWith("rank_tab_"))) contexts.push(state);
      const answers = await judge(state, questions);
      if (questions.topic_7)
        answers.topic_7 = {
          type: "choice",
          choice: "6",
          confidence: 1,
          probabilities: { self: 0, "4": 0, "5": 0, "6": 1 },
        };
      return answers;
    },
    async () => "Related",
    () => {},
  );
  expect(contexts).toHaveLength(2);
  expect(contexts[0]).toMatchObject({ tabs: [{ id: "4" }, { id: "5" }] });
  expect(contexts[1]).toMatchObject({ tabs: [{ id: "6" }, { id: "7" }] });
});

it("keeps original peer order when an earlier tab joins a later existing group", async () => {
  const source = {
    ...before,
    tabs: before.tabs
      .map((tab) => ({ ...tab, index: tab.id === 3 ? 1 : tab.id === 2 ? 2 : tab.index }))
      .sort((a, b) => a.index - b.index),
  };
  let inspected = false;
  await buildPlan(
    source,
    DEFAULT_SETTINGS,
    async (state, questions) => {
      if (questions.rank_tab_2) {
        expect(state).toMatchObject({
          tabs: [
            { id: "3", groupId: 7 },
            { id: "2", groupId: 7 },
          ],
        });
        inspected = true;
      }
      return judge(state, questions);
    },
    async () => "Unused",
    () => {},
  );
  expect(inspected).toBe(true);
});

it("runs independent structural judgments and container rankings in three request waves", async () => {
  const pending: { questions: Parameters<Judge>[1]; finish: () => Promise<void> }[] = [];
  const naming = vi.fn(async () => "Travel");
  const parallelJudge: Judge = (state, questions) =>
    new Promise((resolve) => {
      pending.push({ questions, finish: async () => resolve(await judge(state, questions)) });
    });
  const plan = buildPlan(
    before,
    { ...DEFAULT_SETTINGS, allowNewGroups: true },
    parallelJudge,
    naming,
    () => {},
  );
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  expect(pending[0].questions).toHaveProperty("membership_3");
  expect(pending[1].questions).toHaveProperty("related_topic_3");
  await Promise.all(pending.splice(0).map((request) => request.finish()));
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  expect(
    pending.every(({ questions }) =>
      Object.keys(questions).every((key) => key.startsWith("rank_tab_")),
    ),
  ).toBe(true);
  expect(naming).not.toHaveBeenCalled();
  // Completion order cannot change the assembly of independently ranked containers.
  await pending.pop()!.finish();
  await pending.pop()!.finish();
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  expect(pending[0].questions).toHaveProperty("rank_block_group_7");
  expect(naming).not.toHaveBeenCalled();
  await pending.pop()!.finish();
  const result = await plan;
  expect(result.blocks.map((block) => block.tabIds)).toEqual([
    [2, 3],
    [4, 5],
  ]);
  expect(naming).toHaveBeenCalledTimes(1);
});

it("waits for started sibling judgments before reporting a stage failure", async () => {
  let finishSibling: (() => void) | undefined;
  let finishedSibling = false;
  const naming = vi.fn(async () => "Unused");
  const failingJudge: Judge = async (_state, questions) => {
    if (questions.membership_3) throw new Error("invalidKey");
    await new Promise<void>((resolve) => {
      finishSibling = resolve;
    });
    finishedSibling = true;
    return {};
  };
  const plan = buildPlan(before, DEFAULT_SETTINGS, failingJudge, naming, () => {});
  const outcome = plan.catch((error: Error) => {
    expect(finishedSibling).toBe(true);
    return error.message;
  });
  await vi.waitFor(() => expect(finishSibling).toBeDefined());
  finishSibling!();
  expect(await outcome).toBe("invalidKey");
  expect(naming).not.toHaveBeenCalled();
});
