import { afterEach, expect, it, vi } from "vitest";
import { createJudge } from "@/src/ai/jev";
import {
  PROVIDERS,
  requestProviderAccess,
  resolveProvider,
  updateCustomEndpoint,
} from "@/src/ai/providers";

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
it("does not prompt for default OpenRouter", async () => {
  const request = vi.fn();
  vi.stubGlobal("chrome", { permissions: { request } });
  expect(await requestProviderAccess({ provider: "openrouter", apiKey: "key" })).toBe(true);
  expect(request).not.toHaveBeenCalled();
});
it("requests TypeSafe access synchronously", async () => {
  const request = vi.fn().mockResolvedValue(true);
  vi.stubGlobal("chrome", { permissions: { request } });
  const result = requestProviderAccess({ provider: "typesafe", apiKey: "key" });
  expect(request).toHaveBeenCalledWith({ origins: ["https://api.typesafe.ai/*"] });
  expect(await result).toBe(true);
});
it.each([
  "http://remote.test/decide",
  "http://localhost:8000/decide",
  "http://127.0.0.1:8000/decide",
])("rejects keys on HTTP endpoint %s before permissions or fetch", (endpoint) => {
  const fetch = vi.fn(),
    request = vi.fn();
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("chrome", { permissions: { request } });
  const settings = { provider: "custom" as const, apiKey: "key", endpoint };
  expect(() => createJudge(settings, new AbortController().signal)).toThrow("invalidEndpoint");
  expect(() => requestProviderAccess(settings)).toThrow("invalidEndpoint");
  expect(fetch).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
it.each(["https://b.test/decide", "https://a.test:8443/decide", "http://a.test/decide", "invalid"])(
  "clears custom credentials when changing origin to %s",
  (endpoint) => {
    expect(
      updateCustomEndpoint(
        { provider: "custom", endpoint: "https://a.test/decide", apiKey: "key-a" },
        endpoint,
      ).apiKey,
    ).toBe("");
  },
);
it("keeps credentials for a path change on the same origin", () => {
  expect(
    updateCustomEndpoint(
      { provider: "custom", endpoint: "https://a.test/decide", apiKey: "key-a" },
      "https://a.test/v2/decide",
    ).apiKey,
  ).toBe("key-a");
});
