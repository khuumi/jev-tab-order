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
  const scores = async (items: Peer[], comparison = false) => {
    const questions = Object.fromEntries(
      items.map((peer) => [
        `rank_${kind}_${peer.key}`,
        {
          type: "score",
          instructions: comparison
            ? `Compare ${kind} ${peer.key} with the other peer in state.${kind}s under state.rules. Earlier is lower; use equal middle levels when no order is specified. These are local comparison scores, not global positions.`
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
  // No partition score is promoted to a global rank. Stable merge sort explicitly
  // compares opposing partition heads, reconciling every partition. Ties and
  // uncertain comparisons take the left head. The schedule is deterministic,
  // even when model preferences are non-transitive. A rejected pair is the
  // minimum useful semantic unit and its error propagates unchanged.
  const sort = async (items: Peer[]): Promise<Peer[]> => {
    if (items.length < 2) return items;
    const middle = Math.ceil(items.length / 2);
    const left = await sort(items.slice(0, middle));
    const right = await sort(items.slice(middle));
    const result: Peer[] = [];
    let a = 0;
    let b = 0;
    while (a < left.length && b < right.length) {
      const pair = [left[a], right[b]];
      const ranks = await scores(pair, true);
      const ordered = orderByRank(pair, (peer) => ranks.get(peer.key));
      result.push(ordered[0] === left[a] ? left[a++] : right[b++]);
    }
    return [...result, ...left.slice(a), ...right.slice(b)];
  };
  return new Map((await sort(peers)).map((peer, index) => [peer.key, index]));
};
