import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, getSettings, saveSettings } from "@/src/settings/state";

afterEach(() => vi.unstubAllGlobals());
it("migrates legacy settings to OpenRouter without losing the key or rules", async () => {
  const settings = { apiKey: "key", rules: "rules", allowNewGroups: true };
  vi.stubGlobal("chrome", { storage: { local: { get: async () => ({ settings }) } } });
  expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, ...settings });
});
it.each(["openrouter", "typesafe", "custom"] as const)(
  "persists and reloads %s configuration",
  async (provider) => {
    let stored: unknown;
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          set: async (value: unknown) => {
            stored = value;
          },
          get: async () => stored,
        },
      },
    });
    const settings = {
      ...DEFAULT_SETTINGS,
      provider,
      apiKey: " key ",
      model: " jev-test ",
      endpoint: " http://localhost:8000/decide ",
    };
    await saveSettings(settings);
    expect(await getSettings()).toEqual({
      ...settings,
      apiKey: "key",
      model: "jev-test",
      endpoint: "http://localhost:8000/decide",
    });
  },
);
it("does not overwrite saved settings with an invalid custom endpoint", async () => {
  const set = vi.fn();
  vi.stubGlobal("chrome", { storage: { local: { set } } });
  await expect(
    saveSettings({ ...DEFAULT_SETTINGS, provider: "custom", endpoint: "invalid" }),
  ).rejects.toThrow("invalidEndpoint");
  expect(set).not.toHaveBeenCalled();
});
