import { afterEach, expect, it, vi } from "vitest";
import { createJudge } from "@/src/ai/jev";
import { PROVIDERS, requestProviderAccess, resolveProvider } from "@/src/ai/providers";

afterEach(() => vi.unstubAllGlobals());
const questions = {
  q: { type: "choice" as const, instructions: "Choose", criteria: { a: "A", b: "B" } },
};
const answers = {
  q: { type: "choice", choice: "a", confidence: 1, probabilities: { a: 1, b: 0 } },
};
it.each(["openrouter", "typesafe"] as const)(
  "uses %s defaults and requires its key",
  (provider) => {
    expect(resolveProvider({ provider, apiKey: "" })).toEqual(PROVIDERS[provider]);
    expect(() => createJudge({ provider, apiKey: "" }, new AbortController().signal)).toThrow(
      "missingKey",
    );
  },
);
it.each([
  "",
  "ftp://localhost/decide",
  "file:///decide",
  "https://key:secret@example.com/decide",
  "https://example.com/decide?key=secret",
  "https://example.com/decide#fragment",
])("rejects invalid custom endpoint %s before fetching", (endpoint) => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(() =>
    createJudge({ provider: "custom", endpoint, apiKey: "" }, new AbortController().signal),
  ).toThrow("invalidEndpoint");
  expect(fetch).not.toHaveBeenCalled();
});
it("omits credentials and model for a keyless local endpoint", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ answers }));
  vi.stubGlobal("fetch", fetch);
  expect(
    await createJudge(
      { provider: "custom", endpoint: "http://localhost:8000/decide", apiKey: "" },
      new AbortController().signal,
    )({}, questions),
  ).toEqual(answers);
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe("http://localhost:8000/decide");
  expect(new Headers(init.headers).has("Authorization")).toBe(false);
  expect(JSON.parse(init.body)).toEqual({ state: {}, questions });
});
it.each(["openrouter", "typesafe", "custom"] as const)(
  "supports a model override for %s",
  async (provider) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ answers }));
    vi.stubGlobal("fetch", fetch);
    await createJudge(
      { provider, apiKey: " key ", endpoint: "https://custom.test/decide", model: " test-jev " },
      new AbortController().signal,
    )({}, questions);
    expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe("test-jev");
    expect(new Headers(fetch.mock.calls[0][1].headers).get("Authorization")).toBe("Bearer key");
  },
);
it("requests only the custom origin synchronously and returns a denial", async () => {
  const request = vi.fn().mockResolvedValue(false);
  vi.stubGlobal("chrome", { permissions: { request } });
  const result = requestProviderAccess({
    provider: "custom",
    endpoint: "http://localhost:8000/decide",
    apiKey: "",
  });
  expect(request).toHaveBeenCalledWith({ origins: ["http://localhost:8000/*"] });
  expect(await result).toBe(false);
});
it.each(["openrouter", "typesafe"] as const)(
  "does not prompt for built-in %s",
  async (provider) => {
    const request = vi.fn();
    vi.stubGlobal("chrome", { permissions: { request } });
    expect(await requestProviderAccess({ provider, apiKey: "key" })).toBe(true);
    expect(request).not.toHaveBeenCalled();
  },
);
