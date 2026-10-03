import { afterEach, expect, it, vi } from "vitest";
import { rankPeers } from "@/src/organize/ranking";
import { orderByRank } from "@/src/organize/order";
import { createJudge } from "@/src/ai/jev";
import { createDecisionProvider } from "@/src/ai/providers";
import type { Judge, Question } from "@/src/types";

const peers = Array.from({ length: 24 }, (_, index) => ({
  key: `topic_${index}`,
  title: `Priority ${23 - index}`,
  priority: 23 - index,
  representatives: [
    {
      title: "Documentation for production services ".repeat(3),
      url: "https://docs.example.test/architecture/distributed-systems",
    },
  ],
}));
const rules = "Earlier priority first";
afterEach(() => vi.unstubAllGlobals());

it.each(["budget", "413", "contextLength"])(
  "reconciles block rankings after %s with context-sensitive comparisons",
  async (trigger) => {
    const settings = { apiKey: "test" };
    const signal = new AbortController().signal;
    const provider = createDecisionProvider(settings, signal);
    let restricted = false;
    const budget = 2500;
    const fetch = vi.fn(async (_url, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      if (restricted && trigger === "budget")
        expect(provider.requestBytes(payload)).toBeLessThanOrEqual(budget);
      expect(payload.state).not.toHaveProperty("tabs");
      const context = payload.state.blocks as typeof peers;
      if (restricted && trigger !== "budget" && context.length > 2)
        return trigger === "413"
          ? new Response("", { status: 413 })
          : Response.json({ error: { code: "context_length_exceeded" } }, { status: 400 });
      const ordered = [...context].sort((a, b) => a.priority - b.priority);
      return Response.json({
        answers: Object.fromEntries(
          Object.entries(payload.questions as Record<string, Question>).map(([key, question]) => {
            const target = context.find((peer) => key === `rank_block_${peer.key}`)!;
            expect(target).toBeDefined();
            // Relative positions depend on the complete supplied comparison set.
            // Fixed scores would miss broken reconciliation of local ranks.
            const score = (4 * ordered.indexOf(target)) / (ordered.length - 1);
            return [
              key,
              {
                type: "score",
                score,
                confidence: 1,
                legend: Object.fromEntries(Object.entries(question.criteria)),
                probabilities: Object.fromEntries(
                  [0, 1, 2, 3, 4].map((level) => [level, Math.max(0, 1 - Math.abs(level - score))]),
                ),
              },
            ];
          }),
        ),
      });
    });
    vi.stubGlobal("fetch", fetch);
    const baseline = await rankPeers(peers, "block", rules, createJudge(settings, signal));
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockClear();
    restricted = true;
    const batched = await rankPeers(
      peers,
      "block",
      rules,
      createJudge(settings, signal, { maxRequestBytes: trigger === "budget" ? budget : undefined }),
    );
    expect(orderByRank(peers, (peer) => batched.get(peer.key))).toEqual(
      orderByRank(peers, (peer) => baseline.get(peer.key)),
    );
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
    for (const call of fetch.mock.calls) {
      const payload = JSON.parse(String(call[1].body));
      if (payload.state.blocks.length === 2)
        expect(
          Object.values(payload.questions).every((q) =>
            (q as Question).instructions.includes("local comparison scores"),
          ),
        ).toBe(true);
    }
  },
);

it.each(["invalidKey", "networkError", "rateLimited", "cancelled", "invalidResponse"])(
  "does not retry %s",
  async (message) => {
    const judge = vi.fn(async () => {
      throw new Error(message);
    });
    await expect(rankPeers(peers, "block", rules, judge)).rejects.toThrow(message);
    expect(judge).toHaveBeenCalledTimes(1);
  },
);

it("propagates a minimum pair failure without accepting a singleton score", async () => {
  const judge = vi.fn<Judge>(async () => {
    throw new Error("tokenLimit");
  });
  await expect(rankPeers(peers, "block", rules, judge)).rejects.toThrow("tokenLimit");
  const contexts = judge.mock.calls.map(([state]) => (state as { blocks: typeof peers }).blocks);
  expect(contexts.some((items) => items.length === 2)).toBe(true);
  expect(contexts.every((items) => items.length >= 2)).toBe(true);
});

it("uses fitting 120-peer partitions for 240 peers and reconciles them with bounded requests", async () => {
  const large = Array.from({ length: 240 }, (_, index) => ({
    ...peers[0],
    key: `topic_${index}`,
    priority: 239 - index,
    representatives: [
      {
        title:
          "Production architecture documentation for distributed systems, observability, performance and incident response reference".slice(
            0,
            120,
          ),
        url: "https://documentation.example.test/engineering/platform/distributed-systems/observability/incident-response/performance/production-services/reference/detailed-design".slice(
          0,
          160,
        ),
      },
    ],
  }));
  const settings = { apiKey: "test" };
  const signal = new AbortController().signal;
  const provider = createDecisionProvider(settings, signal);
  expect(provider.requestBytes({ state: { rules, blocks: large }, questions: {} })).toBeGreaterThan(
    64000,
  );
  let budget = 1000000;
  const contexts: (typeof large)[] = [];
  const fetch = vi.fn(async (_url, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    expect(provider.requestBytes(payload)).toBeLessThanOrEqual(budget);
    const context = payload.state.blocks as typeof large;
    contexts.push(context);
    const ordered = [...context].sort((a, b) => a.priority - b.priority);
    return Response.json({
      answers: Object.fromEntries(
        Object.entries(payload.questions as Record<string, Question>).map(([key, question]) => {
          const target = context.find((peer) => key === `rank_block_${peer.key}`)!;
          const score = (4 * ordered.indexOf(target)) / (ordered.length - 1);
          return [
            key,
            {
              type: "score",
              score,
              confidence: 1,
              legend: Object.fromEntries(Object.entries(question.criteria)),
              probabilities: Object.fromEntries(
                [0, 1, 2, 3, 4].map((level) => [level, Math.max(0, 1 - Math.abs(level - score))]),
              ),
            },
          ];
        }),
      ),
    });
  });
  vi.stubGlobal("fetch", fetch);
  const baseline = await rankPeers(
    large,
    "block",
    rules,
    createJudge(settings, signal, { maxRequestBytes: budget }),
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockClear();
  contexts.length = 0;
  budget = 64000;
  const result = await rankPeers(large, "block", rules, createJudge(settings, signal));
  expect(orderByRank(large, (peer) => result.get(peer.key))).toEqual(
    orderByRank(large, (peer) => baseline.get(peer.key)),
  );
  expect(contexts.some((context) => context.length === 120)).toBe(true);
  expect(contexts.every((context) => [120, 2].includes(context.length))).toBe(true);
  expect(fetch.mock.calls.length).toBeLessThan(240);
});

it("starts fitting sibling partitions concurrently without changing reconciliation order", async () => {
  const partitions: { items: typeof peers; finish: () => void }[] = [];
  let gated = true;
  const judge: Judge = async (state, questions) => {
    const items = (state as { blocks: typeof peers }).blocks;
    if (items.length === peers.length) throw new Error("tokenLimit");
    if (gated && items.length === 12)
      await new Promise<void>((resolve) => partitions.push({ items, finish: resolve }));
    const ordered = [...items].sort((a, b) => a.priority - b.priority);
    return Object.fromEntries(
      Object.entries(questions).map(([key, question]) => {
        const item = items.find((peer) => key === `rank_block_${peer.key}`)!;
        const score = (4 * ordered.indexOf(item)) / (ordered.length - 1);
        return [
          key,
          {
            type: "score",
            score,
            confidence: 1,
            legend: Object.fromEntries(Object.entries(question.criteria)),
            probabilities: {},
          },
        ];
      }),
    );
  };
  const ranking = rankPeers(peers, "block", rules, judge);
  await vi.waitFor(() => expect(partitions).toHaveLength(2));
  expect(partitions.map(({ items }) => items.length)).toEqual([12, 12]);
  gated = false;
  partitions[1].finish();
  partitions[0].finish();
  const ranks = await ranking;
  expect(orderByRank(peers, (peer) => ranks.get(peer.key))).toEqual([...peers].reverse());
});
