import { resolveProvider } from "@/src/ai/providers";
import type { Settings } from "@/src/types";
export const DEFAULT_RULES = `Rearrange ungrouped tabs among themselves and grouped tabs among themselves to be adjacent according to the following rules: Rules listed higher have higher priority.
- The URL domains are the same
- The parts of the URLs after the domain are similar
- The page titles are semantically similar

Add ungrouped tabs to existing groups according to the following rule:
- The existing group name is semantically similar to the URL and page title

Preserve the original order when the judgment is ambiguous.`;
export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  rules: "",
  allowNewGroups: false,
  provider: "openrouter",
  model: "",
  endpoint: "",
};
export const getSettings = async (): Promise<Settings> => {
  const { settings } = await chrome.storage.local.get<{ settings?: Settings }>("settings");
  return {
    apiKey: typeof settings?.apiKey === "string" ? settings.apiKey : "",
    rules: typeof settings?.rules === "string" ? settings.rules : "",
    allowNewGroups: settings?.allowNewGroups === true,
    provider:
      settings?.provider === "typesafe" || settings?.provider === "custom"
        ? settings.provider
        : "openrouter",
    model: typeof settings?.model === "string" ? settings.model : "",
    endpoint: typeof settings?.endpoint === "string" ? settings.endpoint : "",
  };
};
export const saveSettings = async (settings: Settings) => {
  if (
    settings.rules.length > 2000 ||
    settings.apiKey.length > 1000 ||
    (settings.model?.length ?? 0) > 200 ||
    (settings.endpoint?.length ?? 0) > 2000
  )
    throw new Error("settingsTooLong");
  resolveProvider(settings);
  await chrome.storage.local.set({
    settings: {
      ...settings,
      apiKey: settings.apiKey.trim(),
      rules: settings.rules.trim(),
      provider: settings.provider ?? "openrouter",
      model: settings.model?.trim() ?? "",
      endpoint: settings.endpoint?.trim() ?? "",
    },
  });
};
export const effectiveRules = (settings: Settings) => settings.rules.trim() || DEFAULT_RULES;
