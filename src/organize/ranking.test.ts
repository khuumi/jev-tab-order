import { afterEach, expect, it, vi } from "vitest";
import { rankPeers } from "@/src/organize/ranking";
import { orderByRank } from "@/src/organize/order";
import { createJudge } from "@/src/ai/jev";
import { createDecisionProvider } from "@/src/ai/providers";
import type { Question } from "@/src/types";

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
  const judge = vi.fn(async () => {
    throw new Error("tokenLimit");
  });
  await expect(rankPeers(peers, "block", rules, judge)).rejects.toThrow("tokenLimit");
  expect(judge.mock.calls).toHaveLength(2);
});
