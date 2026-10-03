import { settleAll } from "@/src/ai/concurrent";
import { isConfident } from "@/src/ai/jev";
import { effectiveRules } from "@/src/settings/state";
import { describe, isEligible } from "@/src/tabs/snapshot";
import { rankPeers } from "@/src/organize/ranking";
import { orderByRank } from "@/src/organize/order";
import type { Block, Judge, Plan, Question, Settings, Snapshot, Tab } from "@/src/types";

export const buildPlan = async (
  before: Snapshot,
  settings: Settings,
  judge: Judge,
  name: (titles: string[]) => Promise<string>,
  report: (key: string) => void,
): Promise<Plan> => {
  const tabs = before.tabs.filter((tab) => !tab.pinned);
  const rules = effectiveRules(settings);
  const warnings: string[] = [];
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const groups: Block[] = before.groups
    .map((group) => ({
      key: `group_${group.id}`,
      groupId: group.id,
      title: group.title,
      tabIds: tabs.filter((tab) => tab.groupId === group.id).map((tab) => tab.id),
    }))
    .filter((group) => group.tabIds.length);
  const available = tabs.filter((tab) => tab.groupId === -1);
  const candidates = tabs.filter(isEligible);
  const originals: Block[] = [
    ...groups,
    ...available.map((tab) => ({ key: `topic_${tab.id}`, title: "", tabIds: [tab.id] })),
  ].sort((a, b) => byId.get(a.tabIds[0])!.index - byId.get(b.tabIds[0])!.index);
  const tabLabels = new Map(candidates.map((tab) => [tab.id, domainLabel(tab)]));
  const blockLabels = new Map(
    originals.map((block) => [
      block.key,
      block.groupId !== undefined
        ? `Group name: ${JSON.stringify(block.title)}`
        : tabLabels.get(block.tabIds[0])!,
    ]),
  );
  const state = {
    rules,
    tabs: candidates.map((tab) => ({ ...describe(tab), groupId: tab.groupId })),
    groups: groups.map((group) => ({
      key: group.key,
      title: group.title,
      tabIds: group.tabIds.map(String),
    })),
    blocks: originals.map((block) => ({
      key: block.key,
      title: block.title,
      tabIds: block.tabIds.map(String),
    })),
  };
  const questions: Record<string, Question> = {};
  const relationships: Record<string, Question> = {};
  if (candidates.length) {
    for (const [index, tab] of candidates.entries()) {
      if (tab.groupId === -1 && groups.length)
        questions[`membership_${tab.id}`] = {
          type: "choice",
          instructions: `According to state.rules, select an existing group for ungrouped tab ${tab.id} (${tabLabels.get(tab.id)}), or none.`,
          criteria: {
            none: "Keep ungrouped",
            ...Object.fromEntries(groups.map((group) => [group.key, blockLabels.get(group.key)!])),
          },
        };
      const preceding = candidates.slice(0, index).filter((other) => other.groupId === tab.groupId);
      if (preceding.length)
        questions[`topic_${tab.id}`] = {
          type: "choice",
          instructions: `According to state.rules, select the earliest candidate tab to place adjacent to tab ${tab.id} (${tabLabels.get(tab.id)}), or self.`,
          criteria: {
            self: "No matching candidate",
            ...Object.fromEntries(
              preceding.map((other) => [String(other.id), tabLabels.get(other.id)!]),
            ),
          },
        };
    }
    for (const [index, block] of originals.entries()) {
      if (!block.tabIds.some((id) => isEligible(byId.get(id)!))) continue;
      const preceding = originals
        .slice(0, index)
        .filter((other) => other.tabIds.some((id) => isEligible(byId.get(id)!)));
      if (preceding.length)
        relationships[`related_${block.key}`] = {
          type: "choice",
          instructions: `According to state.rules, select the earliest candidate block to place adjacent to block ${block.key} (${blockLabels.get(block.key)}), or self.`,
          criteria: {
            self: "Keep separate",
            ...Object.fromEntries(
              preceding.map((other) => [other.key, blockLabels.get(other.key)!]),
            ),
          },
        };
    }
  }
  report("classifying");
  // Questions are independent; the judge partitions them under its request budget.
  // Membership/tab adjacency and compact block adjacency are independent.
  const [structure, relationshipsAnswered] = await settleAll([
    Object.keys(questions).length ? judge(state, questions) : Promise.resolve({}),
    Object.keys(relationships).length
      ? judge(
          {
            rules,
            tabs: [],
            groups: [],
            blocks: originals.map((block) => compactBlock(block, byId)),
          },
          relationships,
        )
      : Promise.resolve({}),
  ]);
  const answers: Awaited<ReturnType<Judge>> = { ...structure, ...relationshipsAnswered };
  const remaining: Tab[] = [];
  for (const tab of available) {
    const answer = answers[`membership_${tab.id}`];
    const group =
      answer && isConfident(answer) && groups.find((group) => group.key === answer.choice);
    if (group) group.tabIds.push(tab.id);
    else remaining.push(tab);
  }
  report("sorting");
  const containers = [...groups.map((group) => group.tabIds.map((id) => byId.get(id)!)), remaining];
  const clusters = containers.map((container) => {
    const roots = new Map<number, number>();
    const buckets = new Map<number, Tab[]>();
    // Membership decisions may put an earlier ungrouped tab into a later group.
    for (const tab of [...container].sort((a, b) => a.index - b.index)) {
      const answer = answers[`topic_${tab.id}`];
      const parent = answer && isConfident(answer) ? Number(answer.choice) : tab.id;
      // Ignore associations across final containers; never move an existing member.
      const root = roots.get(parent) ?? tab.id;
      roots.set(tab.id, root);
      buckets.set(root, [...(buckets.get(root) ?? []), tab]);
    }
    return [...buckets.values()];
  });
  const rankingContainers = containers.slice(0, groups.length).map((tabs, index) => ({
    tabs,
    key: groups[index].key,
    title: groups[index].title,
    groupId: groups[index].groupId!,
  }));
  const prospectiveGroups = settings.allowNewGroups
    ? clusters[groups.length].filter((cluster) => cluster.length >= 2 && cluster.every(isEligible))
    : [];
  const prospectiveIds = new Set(
    prospectiveGroups.flatMap((cluster) => cluster.map((tab) => tab.id)),
  );
  for (const cluster of prospectiveGroups)
    rankingContainers.push({
      tabs: cluster,
      key: `topic_${cluster[0].id}`,
      title: "",
      groupId: -1,
    });
  rankingContainers.push({
    tabs: remaining.filter((tab) => !prospectiveIds.has(tab.id)),
    key: "ungrouped",
    title: "",
    groupId: -1,
  });
  const tabRanks = new Map<string, number | undefined>();
  // Independent containers use separate peer context, with at most four active
  // rankings. This keeps small windows from waiting on each container in turn.
  for (let offset = 0; offset < rankingContainers.length; offset += 4) {
    const results = await settleAll(
      rankingContainers.slice(offset, offset + 4).map(async (container) => {
        const peers = [...container.tabs]
          .sort((a, b) => a.index - b.index)
          .filter(isEligible)
          .map((tab) => ({ key: String(tab.id), ...describe(tab), groupId: container.groupId }));
        return rankPeers(peers, "tab", rules, judge, {
          key: container.key,
          title: container.title,
        });
      }),
    );
    for (const result of results) for (const [key, rank] of result) tabRanks.set(key, rank);
  }
  const rankedClusters = clusters.map((buckets, index) => {
    const ranked = buckets.map((cluster) =>
      orderByRank(cluster, (tab) => tabRanks.get(String(tab.id))),
    );
    // Ungrouped clusters become separate blocks, ranked together in the next stage.
    if (index === groups.length) return ranked;
    return orderByRank(ranked, (cluster) =>
      minimumRank(cluster.map((tab) => tabRanks.get(String(tab.id)))),
    );
  });
  groups.forEach((group, index) => {
    group.tabIds = rankedClusters[index].flatMap((cluster) => cluster.map((tab) => tab.id));
  });
  const allowCreate = settings.allowNewGroups;
  const ungrouped: Block[] = [];
  for (const cluster of rankedClusters[groups.length]) {
    const tabIds = cluster.map((tab) => tab.id);
    const title = "";
    const first = [...cluster].sort((a, b) => a.index - b.index)[0];
    ungrouped.push({ key: `topic_${first.id}`, title, tabIds, create: !!title });
  }
  report("sortingGroups");
  const blocks = [...groups, ...ungrouped].sort(
    (a, b) =>
      Math.min(...a.tabIds.map((id) => byId.get(id)!.index)) -
      Math.min(...b.tabIds.map((id) => byId.get(id)!.index)),
  );
  const aliases = new Map<string, string>();
  for (const block of blocks) {
    aliases.set(block.key, block.key);
    for (const id of block.tabIds) aliases.set(`topic_${id}`, block.key);
  }
  const roots = new Map<string, string>();
  const buckets = new Map<string, Block[]>();
  for (const block of blocks) {
    const answer = answers[`related_${block.key}`];
    const parent = answer && isConfident(answer) ? aliases.get(answer.choice) : undefined;
    const root = parent ? (roots.get(parent) ?? block.key) : block.key;
    roots.set(block.key, root);
    buckets.set(root, [...(buckets.get(root) ?? []), block]);
  }
  const blockRanks = await rankPeers(
    blocks
      .filter((block) => block.tabIds.some((id) => isEligible(byId.get(id)!)))
      .map((block) => compactBlock(block, byId)),
    "block",
    rules,
    judge,
  );
  const blockRank = (block: Block) => blockRanks.get(block.key);
  const orderedBuckets = [...buckets.values()].map((bucket) => orderByRank(bucket, blockRank));
  const blocksInOrder = orderByRank(orderedBuckets, (bucket) =>
    minimumRank(bucket.map(blockRank)),
  ).flat();
  for (const block of ungrouped) {
    const cluster = block.tabIds.map((id) => byId.get(id)!);
    if (allowCreate && cluster.length >= 2 && cluster.every(isEligible)) {
      report("naming");
      try {
        block.title = await name(cluster.map((tab) => tab.title));
        block.create = !!block.title;
      } catch {
        if (!warnings.includes("namingSkipped")) warnings.push("namingSkipped");
      }
    }
  }
  const plan = { before, blocks: blocksInOrder, warnings, settings };
  validatePlan(plan);
  return plan;
};

// Every block has a bounded semantic description regardless of member count.
const compactBlock = (block: Block, byId: Map<number, Tab>) => ({
  key: block.key,
  title: block.title,
  position: Math.min(...block.tabIds.map((id) => byId.get(id)!.index)),
  representatives: block.tabIds
    .map((id) => byId.get(id)!)
    .filter(isEligible)
    .slice(0, 3)
    .map(describe),
});

const domainLabel = (tab: Tab) => {
  try {
    return `Domain: ${new URL(tab.url).hostname}`;
  } catch {
    return "Domain unavailable";
  }
};

const minimumRank = (values: (number | undefined)[]) => {
  const known = values.filter((value): value is number => value !== undefined);
  return known.length ? Math.min(...known) : undefined;
};

export const validatePlan = (plan: Plan) => {
  const expected = plan.before.tabs.filter((t) => !t.pinned);
  const actual = plan.blocks.flatMap((b) => b.tabIds);
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    expected.some((t) => !actual.includes(t.id))
  )
    throw new Error("invalidPlan");
  const groups = new Set<number>();
  for (const block of plan.blocks) {
    if (!block.tabIds.length) throw new Error("invalidPlan");
    if (block.groupId !== undefined) {
      if (
        groups.has(block.groupId) ||
        !plan.before.groups.some((g) => g.id === block.groupId) ||
        block.create
      )
        throw new Error("invalidPlan");
      groups.add(block.groupId);
    }
    if (
      block.create &&
      (!plan.settings.allowNewGroups ||
        !block.title.trim() ||
        block.title.length > 60 ||
        block.tabIds.length < 2)
    )
      throw new Error("invalidPlan");
    for (const id of block.tabIds) {
      const tab = expected.find((t) => t.id === id)!;
      if (tab.groupId !== -1 && block.groupId !== tab.groupId) throw new Error("invalidPlan");
      if (tab.groupId === -1 && (block.groupId !== undefined || block.create) && !isEligible(tab))
        throw new Error("invalidPlan");
    }
  }
};
