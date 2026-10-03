import { settleAll } from "@/src/ai/concurrent";
import { orderByRank, rankOf } from "@/src/organize/order";
import type { Judge, Question } from "@/src/types";

const levels = [
  "Earliest priority under the rules",
  "Early priority under the rules",
  "Middle priority or no distinguished order under the rules",
  "Late priority under the rules",
  "Latest priority under the rules",
];
type Peer = { key: string } & Record<string, Parameters<Judge>[0]>;

export const rankPeers = async (
  peers: Peer[],
  kind: "tab" | "block",
  rules: string,
  judge: Judge,
  container?: { key: string; title: string },
) => {
  const scores = async (items: Peer[], scope: "full" | "partition" | "comparison" = "full") => {
    const questions = Object.fromEntries(
      items.map((peer) => [
        `rank_${kind}_${peer.key}`,
        {
          type: "score",
          instructions:
            scope === "comparison"
              ? `Compare ${kind} ${peer.key} with the other peer in state.${kind}s under state.rules. Earlier is lower; use equal middle levels when no order is specified. These are local comparison scores, not global positions.`
              : scope === "partition"
                ? `Rank ${kind} ${peer.key} within this partition in state.${kind}s under state.rules; earlier is lower. Use equal middle levels if no order is specified. These are local partition scores and require reconciliation with other partitions.`
                : `Rate the position of ${kind} ${peer.key} among the complete ranking peers in state.${kind}s under state.rules; earlier is lower. Use the middle level if no order is specified.`,
          criteria: levels,
        } satisfies Question,
      ]),
    );
    const answers = await judge(
      { rules, ...(container ? { container } : {}), [`${kind}s`]: items },
      questions,
    );
    return new Map(items.map((peer) => [peer.key, rankOf(answers[`rank_${kind}_${peer.key}`])]));
  };
  if (peers.length < 2) return new Map(peers.map((peer) => [peer.key, 2]));
  try {
    return await scores(peers);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "tokenLimit" || peers.length < 2)
      throw error;
  }
  // Sort the largest partitions that fit, using their scores only locally.
  // Merge opposing heads to reconcile those partitions into a global order.
  // Two independent subtrees run concurrently; deeper recursion stays serial
  // so partition failures cannot create an unbounded number of requests.
  // Ties/uncertainty take the left head, with a deterministic merge schedule.
  const sort = async (items: Peer[], retry = true, parallel = false): Promise<Peer[]> => {
    if (items.length < 2) return items;
    if (retry || items.length === 2) {
      try {
        const ranks = await scores(items, items.length === 2 ? "comparison" : "partition");
        return orderByRank(items, (peer) => ranks.get(peer.key));
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "tokenLimit" || items.length === 2)
          throw error;
      }
    }
    const middle = Math.ceil(items.length / 2);
    const [left, right] = parallel
      ? await settleAll([sort(items.slice(0, middle)), sort(items.slice(middle))])
      : [await sort(items.slice(0, middle)), await sort(items.slice(middle))];
    const result: Peer[] = [];
    let a = 0;
    let b = 0;
    while (a < left.length && b < right.length) {
      const pair = [left[a], right[b]];
      const ranks = await scores(pair, "comparison");
      const ordered = orderByRank(pair, (peer) => ranks.get(peer.key));
      result.push(ordered[0] === left[a] ? left[a++] : right[b++]);
    }
    return [...result, ...left.slice(a), ...right.slice(b)];
  };
  return new Map((await sort(peers, false, true)).map((peer, index) => [peer.key, index]));
};
