import type { DecisionProvider } from "@/src/ai/providers";
import type { Answer, Choice, Judge, Question } from "@/src/types";

type State = Parameters<Judge>[0];
type Questions = Parameters<Judge>[1];
type Options = { maxRequestBytes?: number; onRequest?: (count: number) => void };

// Questions are independent of answers. Resolve each exactly once unless its
// request is rejected for size; never retry authentication/network/rate errors.
export const decideBatches = async (
  provider: DecisionProvider,
  state: State,
  questions: Questions,
  signal: AbortSignal,
  parse: (value: unknown, questions: Questions) => Record<string, Answer>,
  options: Options = {},
) => {
  const budget = options.maxRequestBytes ?? provider.maxRequestBytes;
  if (!Number.isFinite(budget) || budget <= 0) throw new Error("tokenLimit");
  let requests = 0;
  const run = async (
    entries: [string, Question][],
    scoped: boolean,
  ): Promise<Record<string, Answer>> => {
    if (signal.aborted) throw new Error("cancelled");
    let limitError = new Error("tokenLimit");
    const batch = Object.fromEntries(entries);
    const context = scoped ? scopeState(state, batch) : state;
    const fits = provider.requestBytes({ state: context, questions: batch }) <= budget;
    if (fits) {
      try {
        options.onRequest?.(++requests);
        const result = parse(await provider.decide({ state: context, questions: batch }), batch);
        if (signal.aborted) throw new Error("cancelled");
        return result;
      } catch (error) {
        if (signal.aborted) throw new Error("cancelled");
        if (!(error instanceof Error) || error.message !== "tokenLimit") throw error;
        limitError = error;
      }
    }
    if (entries.length > 1) {
      // If context alone exceeds the budget, no question split can retain it.
      // Rank questions need their full peer context. Never silently return
      // scores from a reduced window when no full-context batch can fit.
      if (!scoped && !fits && provider.requestBytes({ state, questions: {} }) > budget) {
        if (entries.some(([, question]) => question.type === "score")) throw limitError;
        return run(entries, true);
      }
      if (fits) {
        // A provider rejected our estimate: halve only the failed work.
        const middle = Math.ceil(entries.length / 2);
        return {
          ...(await run(entries.slice(0, middle), false)),
          ...(await run(entries.slice(middle), false)),
        };
      }
      // Pack questions against the original window context first. A smaller
      // question batch must not lose peers just because the aggregate is large.
      const answers: Record<string, Answer> = {};
      let pending: [string, Question][] = [];
      for (const entry of entries) {
        if (signal.aborted) throw new Error("cancelled");
        const trial = Object.fromEntries([...pending, entry]);
        if (
          pending.length &&
          provider.requestBytes({
            state: scoped ? scopeState(state, trial) : state,
            questions: trial,
          }) > budget
        ) {
          Object.assign(answers, await run(pending, scoped));
          pending = [];
        }
        pending.push(entry);
      }
      if (pending.length) Object.assign(answers, await run(pending, scoped));
      return answers;
    }
    if (
      !scoped &&
      provider.requestBytes({ state: scopeState(state, batch), questions: batch }) <
        provider.requestBytes({ state, questions: batch })
    )
      return run(entries, true);
    const [id, question] = entries[0];
    // Planner choices include a neutral option. Keep it in every partition;
    // preserve candidate order instead of truncating the candidate universe.
    if (question.type !== "choice") throw limitError;
    const neutral = Object.hasOwn(question.criteria, "self")
      ? "self"
      : Object.hasOwn(question.criteria, "none")
        ? "none"
        : undefined;
    const candidates = orderedCandidates(state, id, question).filter(([key]) => key !== neutral);
    if (!neutral || candidates.length < 2) throw limitError;
    const middle = Math.ceil(candidates.length / 2);
    const fragment = (items: [string, string][]): [string, Question][] => [
      [
        id,
        {
          ...question,
          criteria: { [neutral]: question.criteria[neutral], ...Object.fromEntries(items) },
        },
      ],
    ];
    const left = (await run(fragment(candidates.slice(0, middle)), false))[id];
    // Adjacency asks for the earliest matching candidate. A confident match
    // in the earlier partition cannot be superseded by a later candidate.
    if (neutral === "self" && confidentMatch(left, neutral)) return { [id]: left };
    const right = (await run(fragment(candidates.slice(middle)), false))[id];
    if (neutral === "self") return { [id]: confidentMatch(right, neutral) ? right : left };
    const finalists = [left, right].filter((answer) => confidentMatch(answer, neutral));
    if (!finalists.length) return { [id]: left };
    if (finalists.length === 1) return { [id]: finalists[0] };
    // Membership has no earliest-match policy. Compare the partition winners
    // together rather than choosing a group based on request order.
    if (candidates.length === 2) throw limitError;
    return run(
      fragment(finalists.map((answer) => [answer.choice, question.criteria[answer.choice]])),
      false,
    );
  };
  return Object.keys(questions).length ? run(Object.entries(questions), false) : {};
};

const confidentMatch = (answer: Answer, neutral: string): answer is Choice =>
  answer.type === "choice" &&
  answer.choice !== neutral &&
  answer.confidence >= 0.3 &&
  answer.probabilities[answer.choice] >= 0.5;

// Only choice questions may project planner-shaped state. Scores compare
// against their surrounding set and must retain the original context.
// Include the target, every offered
// candidate, and the members of referenced groups/blocks, with original order.
const scopeState = (state: State, questions: Questions): State => {
  if (Object.values(questions).some((question) => question.type === "score")) return state;
  if (
    !state ||
    Array.isArray(state) ||
    typeof state !== "object" ||
    !Array.isArray(state.tabs) ||
    !Array.isArray(state.groups) ||
    !Array.isArray(state.blocks)
  )
    return state;
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const [id, question] of Object.entries(questions)) {
    for (const key of [id, ...(question.type === "choice" ? Object.keys(question.criteria) : [])]) {
      if (/^\d+$/.test(key)) ids.add(key);
      const tab = key.match(
        /^(?:membership_|topic_|rank_tab_|rank_block_topic_|related_topic_)(\d+)$/,
      );
      if (tab) ids.add(tab[1]);
      const block = key.match(/(?:group_|topic_)\d+$/)?.[0];
      if (block) keys.add(block);
    }
  }
  const selected = (entry: State) =>
    entry &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    (keys.has(String(entry.key)) ||
      (Array.isArray(entry.tabIds) && entry.tabIds.some((id) => ids.has(String(id)))));
  const groups = state.groups.filter(selected);
  const blocks = state.blocks.filter(selected);
  for (const entry of [...groups, ...blocks]) {
    if (entry && typeof entry === "object" && !Array.isArray(entry) && Array.isArray(entry.tabIds))
      entry.tabIds.forEach((id) => ids.add(String(id)));
  }
  return {
    ...state,
    groups,
    blocks,
    tabs: state.tabs.filter(
      (tab) => tab && typeof tab === "object" && !Array.isArray(tab) && ids.has(String(tab.id)),
    ),
  };
};

// Numeric JSON object keys are enumerated by ID, not original tab position.
// Earliest-match partitions must follow the original state order.
const orderedCandidates = (
  state: State,
  id: string,
  question: Extract<Question, { type: "choice" }>,
) => {
  const entries = Object.entries(question.criteria);
  if (!state || typeof state !== "object" || Array.isArray(state)) return entries;
  const source = id.startsWith("topic_")
    ? state.tabs
    : id.startsWith("related_")
      ? state.blocks
      : undefined;
  if (!Array.isArray(source)) return entries;
  const positions = new Map(
    source.flatMap((entry, index) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? [[String(id.startsWith("topic_") ? entry.id : entry.key), index] as const]
        : [],
    ),
  );
  return entries.sort(([a], [b]) => (positions.get(a) ?? -1) - (positions.get(b) ?? -1));
};
