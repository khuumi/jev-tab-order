import { afterEach, expect, it, vi } from "vitest";
import { createDecisionProvider } from "@/src/ai/providers";
import { createJudge } from "@/src/ai/jev";
import { buildPlan } from "@/src/organize/plan";
import { DEFAULT_SETTINGS } from "@/src/settings/state";
import type { Question, Snapshot } from "@/src/types";

afterEach(() => vi.unstubAllGlobals());
const respond = (questions: Record<string, Question>) =>
  Response.json({
    answers: Object.fromEntries(
      Object.entries(questions).map(([id, question]) => {
        if (question.type === "score")
          return [
            id,
            {
              type: "score",
              score: 2,
              confidence: 1,
              legend: Object.fromEntries(question.criteria.map((value, index) => [index, value])),
              probabilities: { 0: 0, 1: 0, 2: 1, 3: 0, 4: 0 },
            },
          ];
        const choice =
          id === "create"
            ? "yes"
            : id.startsWith("topic_")
              ? (Object.keys(question.criteria).find((key) => key !== "self") ?? "self")
              : "self" in question.criteria
                ? "self"
                : "none" in question.criteria
                  ? "none"
                  : Object.keys(question.criteria)[0];
        return [
          id,
          {
            type: "choice",
            choice,
            confidence: 1,
            probabilities: Object.fromEntries(
              Object.keys(question.criteria).map((key) => [key, key === choice ? 1 : 0]),
            ),
          },
        ];
      }),
    ),
  });
const scores = Object.fromEntries(
  Array.from({ length: 16 }, (_, i) => [
    `rank_tab_${i}`,
    {
      type: "score" as const,
      instructions: "Order by rules",
      criteria: ["first", "early", "middle", "late", "last"],
    },
  ]),
);

it.each(["openrouter", "typesafe", "custom"] as const)(
  "bounds %s requests and preserves the plan across boundaries",
  async (provider) => {
    const source: Snapshot = {
      windowId: 1,
      groups: [],
      tabs: Array.from({ length: 240 }, (_, i) => ({
        id: i + 1,
        index: i,
        pinned: false,
        groupId: -1,
        title: `Related page ${i}`,
        url: `https://example.test/${i}`,
      })),
    };
    let budget = 100000000;
    const fetch = vi.fn(async (_url, init: RequestInit) => {
      expect(new TextEncoder().encode(String(init.body)).length).toBeLessThanOrEqual(budget);
      return respond(JSON.parse(String(init.body)).questions);
    });
    vi.stubGlobal("fetch", fetch);
    const settings = {
      ...DEFAULT_SETTINGS,
      provider,
      endpoint: "http://localhost/decide",
      apiKey: provider === "custom" ? "" : "test",
      allowNewGroups: true,
    };
    const plan = (maxRequestBytes: number) =>
      buildPlan(
        source,
        settings,
        createJudge(settings, new AbortController().signal, { maxRequestBytes }),
        async () => "Related",
        () => {},
      );
    const single = await plan(budget);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockClear();
    budget = 16000;
    expect(await plan(budget)).toEqual(single);
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
  },
);

it("splits only token-limit failures and reports each request", async () => {
  const progress = vi.fn();
  const fetch = vi.fn(async (_url, init: RequestInit) => {
    const questions = JSON.parse(String(init.body)).questions;
    return Object.keys(questions).length > 4
      ? Response.json(
          { error: { code: "context_length_exceeded", message: "Context limit" } },
          { status: 400 },
        )
      : respond(questions);
  });
  vi.stubGlobal("fetch", fetch);
  const answers = await createJudge({ apiKey: "test" }, new AbortController().signal, {
    onRequest: progress,
  })({}, scores);
  expect(Object.keys(answers)).toEqual(Object.keys(scores));
  expect(fetch).toHaveBeenCalledTimes(7);
  expect(progress.mock.calls.map(([count]) => count)).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

it.each([401, 429, 500])("does not retry HTTP %s", async (status) => {
  const fetch = vi.fn(async () => new Response("", { status }));
  vi.stubGlobal("fetch", fetch);
  await expect(
    createJudge({ apiKey: "test" }, new AbortController().signal)({}, scores),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("cancels between batches without returning a partial plan", async () => {
  const controller = new AbortController();
  const fetch = vi.fn(async (_url, init: RequestInit) =>
    respond(JSON.parse(String(init.body)).questions),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(
    createJudge({ apiKey: "test" }, controller.signal, {
      maxRequestBytes: 500,
      onRequest: (count) => {
        if (count === 2) controller.abort();
      },
    })({}, scores),
  ).rejects.toThrow("cancelled");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("stops if an indivisible request cannot fit", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    createJudge({ apiKey: "test" }, new AbortController().signal, { maxRequestBytes: 10 })(
      {},
      scores,
    ),
  ).rejects.toThrow("tokenLimit");
  expect(fetch).not.toHaveBeenCalled();
});

it("partitions adjacency in original position order rather than numeric ID order", async () => {
  const ids = [90, 80, 70, 60, 50, 40, 30, 20, 10, 500];
  const state = {
    rules: "Choose the earliest matching tab",
    tabs: ids.map((id) => ({ id, title: "Related", groupId: -1 })),
    groups: [],
    blocks: ids.map((id) => ({ key: `topic_${id}`, tabIds: [String(id)] })),
  };
  const questions = {
    topic_500: {
      type: "choice" as const,
      instructions: "Select the earliest matching candidate",
      criteria: {
        self: "Separate",
        ...Object.fromEntries(ids.slice(0, -1).map((id) => [String(id), "Related"])),
      },
    },
  };
  const fetch = vi.fn(async (_url, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    const criteria = payload.questions.topic_500.criteria;
    if (Object.keys(criteria).length > 4) return new Response("", { status: 413 });
    const choice = payload.state.tabs
      .find((tab: { id: number }) => String(tab.id) in criteria)
      .id.toString();
    return Response.json({
      answers: {
        topic_500: {
          type: "choice",
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(criteria).map((key) => [key, key === choice ? 1 : 0]),
          ),
        },
      },
    });
  });
  vi.stubGlobal("fetch", fetch);
  const answers = await createJudge({ apiKey: "test" }, new AbortController().signal)(
    state,
    questions,
  );
  expect(answers.topic_500).toMatchObject({ choice: "90" });
  expect(fetch.mock.calls.length).toBeGreaterThan(1);
});

it("compares membership partition winners rather than picking the first group", async () => {
  const criteria = {
    none: "Ungrouped",
    ...Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`group_${index + 1}`, `Group ${index + 1}`]),
    ),
  };
  const fetch = vi.fn(async (_url, init: RequestInit) => {
    const question = JSON.parse(String(init.body)).questions.membership_9;
    const keys = Object.keys(question.criteria);
    if (keys.length > 3) return new Response("", { status: 413 });
    const choice = keys.at(-1)!;
    return Response.json({
      answers: {
        membership_9: {
          type: "choice",
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
        },
      },
    });
  });
  vi.stubGlobal("fetch", fetch);
  const answers = await createJudge({ apiKey: "test" }, new AbortController().signal)(
    {},
    {
      membership_9: { type: "choice", instructions: "Choose the best group", criteria },
    },
  );
  expect(answers.membership_9).toMatchObject({ choice: "group_8" });
  const last = JSON.parse(String(fetch.mock.calls.at(-1)![1].body));
  expect(Object.keys(last.questions.membership_9.criteria)).toEqual(["none", "group_4", "group_8"]);
});

it("keeps scoped targets, candidates, and their group members", async () => {
  const state = {
    rules: "Compare titles",
    tabs: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 9 }],
    groups: [{ key: "group_7", tabIds: ["2", "3"], title: "Related" }],
    blocks: [
      { key: "topic_1", tabIds: ["1"] },
      { key: "group_7", tabIds: ["2", "3"] },
      { key: "topic_9", tabIds: ["9"] },
    ],
  };
  const payloads: { state: typeof state }[] = [];
  const fetch = vi.fn(async (_url, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    payloads.push(payload);
    return payload.state.tabs.length > 3
      ? new Response("", { status: 413 })
      : respond(payload.questions);
  });
  vi.stubGlobal("fetch", fetch);
  await createJudge({ apiKey: "test" }, new AbortController().signal)(state, {
    membership_1: {
      type: "choice",
      instructions: "Choose a group",
      criteria: { none: "Ungrouped", group_7: "Related" },
    },
    rank_tab_9: scores.rank_tab_0,
  });
  expect(payloads[1].state).toEqual(state);
  expect(payloads[2].state.tabs).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  expect(payloads[2].state.groups).toEqual(state.groups);
  expect(payloads[3].state).toEqual(state);
  expect(payloads[4].state.tabs).toEqual([{ id: 9 }]);
});

it.each(["budget", "tokenLimit"])(
  "retains full window context while splitting questions after %s",
  async (trigger) => {
    const state = {
      rules: "Rank each block by its position among state.blocks",
      tabs: [11, 22, 33, 44].map((id) => ({ id, title: `Tab ${id}` })),
      groups: [],
      blocks: [11, 22, 33, 44].map((id) => ({ key: `topic_${id}`, tabIds: [String(id)] })),
    };
    const questions = Object.fromEntries(
      state.blocks.map((block) => [
        `rank_block_${block.key}`,
        { ...scores.rank_tab_0, instructions: `Rank ${block.key} among state.blocks` },
      ]),
    );
    const settings = { apiKey: "test" };
    const signal = new AbortController().signal;
    const provider = createDecisionProvider(settings, signal);
    // The full state fits with two questions, but the aggregate does not.
    const budget = provider.requestBytes({
      state,
      questions: Object.fromEntries(Object.entries(questions).slice(0, 2)),
    });
    expect(provider.requestBytes({ state, questions })).toBeGreaterThan(budget);
    let rejectLarge = false;
    const fetch = vi.fn(async (_url, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      if (trigger === "budget" && rejectLarge)
        expect(provider.requestBytes(payload)).toBeLessThanOrEqual(budget);
      // A context-sensitive responder catches both missing blocks and an
      // altered ordering; the prior responder ignored state entirely.
      expect(payload.state).toEqual(state);
      if (trigger === "tokenLimit" && rejectLarge && Object.keys(payload.questions).length > 2)
        return new Response("", { status: 413 });
      const response = await respond(payload.questions).json();
      for (const [id, answer] of Object.entries(response.answers)) {
        const index = payload.state.blocks.findIndex(
          (block: { key: string }) => `rank_block_${block.key}` === id,
        );
        Object.assign(answer as object, {
          score: index,
          probabilities: Object.fromEntries(
            [0, 1, 2, 3, 4].map((level) => [level, level === index ? 1 : 0]),
          ),
        });
      }
      return Response.json(response);
    });
    vi.stubGlobal("fetch", fetch);
    const baseline = await createJudge(settings, signal)(state, questions);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockClear();
    rejectLarge = true;
    const batched = await createJudge(settings, signal, {
      maxRequestBytes: trigger === "budget" ? budget : undefined,
    })(state, questions);
    expect(batched).toEqual(baseline);
    expect(fetch).toHaveBeenCalledTimes(trigger === "budget" ? 2 : 3);
  },
);

it("scopes only a question that cannot fit with the full state", async () => {
  const state = {
    rules: "Rank by rules",
    tabs: Array.from({ length: 10 }, (_, id) => ({ id, title: "Context ".repeat(30) })),
    groups: [],
    blocks: Array.from({ length: 10 }, (_, id) => ({ key: `topic_${id}`, tabIds: [String(id)] })),
  };
  const questions = {
    rank_tab_1: scores.rank_tab_0,
    rank_tab_9: { ...scores.rank_tab_0, instructions: "Detailed ranking instruction ".repeat(20) },
  };
  const settings = { apiKey: "test" };
  const signal = new AbortController().signal;
  const provider = createDecisionProvider(settings, signal);
  const budget = provider.requestBytes({ state, questions: { rank_tab_1: questions.rank_tab_1 } });
  expect(provider.requestBytes({ state, questions: {} })).toBeLessThan(budget);
  const payloads: { state: typeof state; questions: Record<string, Question> }[] = [];
  const fetch = vi.fn(async (_url, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    payloads.push(payload);
    expect(provider.requestBytes(payload)).toBeLessThanOrEqual(budget);
    return respond(payload.questions);
  });
  vi.stubGlobal("fetch", fetch);
  const answers = await createJudge(settings, signal, { maxRequestBytes: budget })(
    state,
    questions,
  );
  expect(Object.keys(answers)).toEqual(Object.keys(questions));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(payloads[0].state).toEqual(state);
  expect(payloads[1].state.tabs).toEqual([state.tabs[9]]);
  expect(payloads[1].state.blocks).toEqual([state.blocks[9]]);
});

it("packs scoped questions together when full context alone exceeds the budget", async () => {
  const state = {
    rules: "Rank by rules",
    tabs: Array.from({ length: 20 }, (_, id) => ({ id, title: "Context ".repeat(30) })),
    groups: [],
    blocks: Array.from({ length: 20 }, (_, id) => ({ key: `topic_${id}`, tabIds: [String(id)] })),
  };
  const questions = { rank_tab_1: scores.rank_tab_0, rank_tab_9: scores.rank_tab_0 };
  const settings = { apiKey: "test" };
  const signal = new AbortController().signal;
  const provider = createDecisionProvider(settings, signal);
  const budget = 1500;
  expect(provider.requestBytes({ state, questions: {} })).toBeGreaterThan(budget);
  const fetch = vi.fn(async (_url, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    expect(provider.requestBytes(payload)).toBeLessThanOrEqual(budget);
    expect(payload.state.tabs).toEqual([state.tabs[1], state.tabs[9]]);
    return respond(payload.questions);
  });
  vi.stubGlobal("fetch", fetch);
  await createJudge(settings, signal, { maxRequestBytes: budget })(state, questions);
  expect(fetch).toHaveBeenCalledTimes(1);
});
