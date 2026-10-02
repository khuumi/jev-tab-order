import type { Settings } from "@/src/types";
import { test, expect } from "@/e2e/fixtures";

test("compact settings fit one screen and preserve editing and disclosures", async ({
  context,
  extensionId,
  serviceWorker,
}, testInfo) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 650 });
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.getByRole("heading", { name: "Jev Tab Order · Settings" })).toBeVisible();
  const rules = page.getByLabel("Sorting rules", { exact: true });
  await expect(rules).toBeEnabled();
  await expect(rules).toHaveAttribute("placeholder", "Enter sorting rules here");
  const defaultRules = page.locator("details").filter({ hasText: "View default rules" });
  await expect(defaultRules).not.toHaveAttribute("open", "");
  await page.getByLabel("Allow new groups", { exact: true }).check();
  await expect(page.getByText(/Chrome AI is/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("settings.png"), fullPage: true });
  await page.getByText("View default rules", { exact: true }).click();
  await expect(defaultRules).toHaveAttribute("open", "");
  await expect(defaultRules.getByText(/The URL domains are the same/)).toBeVisible();
  await page.getByText("View default rules", { exact: true }).click();
  await page.getByLabel("Allow new groups", { exact: true }).uncheck();
  await expect(page.getByText(/Chrome AI is/)).toHaveCount(0);
  await page.getByLabel("API key", { exact: true }).fill("test-key");
  await rules.fill("Keep matching domains adjacent.");
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Settings saved");
  expect(
    await serviceWorker.evaluate(async () => (await chrome.storage.local.get("settings")).settings),
  ).toEqual({
    apiKey: "test-key",
    rules: "Keep matching domains adjacent.",
    allowNewGroups: false,
    provider: "openrouter",
    model: "",
    endpoint: "",
  });
  await page.setViewportSize({ width: 360, height: 640 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const provider of ["openrouter", "typesafe", "custom"] as const) {
  test(`${provider} connection uses unsaved configuration and saves it`, async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(page.getByLabel("API key", { exact: true })).toBeEnabled();
    await page.getByLabel("API key", { exact: true }).fill("old-key");
    if (provider !== "openrouter") {
      await page.getByLabel("Jev provider", { exact: true }).selectOption(provider);
      await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
    }
    const endpoint =
      provider === "openrouter"
        ? "https://openrouter.ai/api/alpha/decisions"
        : provider === "typesafe"
          ? "https://api.typesafe.ai/v1/systemone"
          : "http://localhost:8000/decide";
    if (provider === "custom") {
      await page.getByLabel("Decision endpoint URL", { exact: true }).fill(endpoint);
      // Mock only the permission dialog; verify the requested origin below.
      await page.evaluate(() => {
        chrome.permissions.request = async (permissions) => {
          (globalThis as typeof globalThis & { requestedOrigins?: string[] }).requestedOrigins =
            permissions.origins;
          return true;
        };
      });
    } else {
      await page.getByLabel("API key", { exact: true }).fill("provider-key");
    }
    await page.getByLabel("Model (optional)", { exact: true }).fill("jev-test");
    let requests = 0;
    await context.route(endpoint, async (route) => {
      requests++;
      const body = route.request().postDataJSON();
      expect(body.model).toBe("jev-test");
      expect(body.state).toEqual({ connectionTest: true });
      expect(route.request().headers().authorization).toBe(
        provider === "custom" ? undefined : "Bearer provider-key",
      );
      await route.fulfill({
        json: {
          answers: {
            connection: {
              type: "choice",
              choice: "connected",
              confidence: 1,
              probabilities: { connected: 1, other: 0 },
            },
          },
        },
      });
    });
    await page.getByRole("button", { name: "Test connection", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Connected to Jev");
    expect(requests).toBe(1);
    if (provider === "custom")
      expect(
        await page.evaluate(
          () =>
            (globalThis as typeof globalThis & { requestedOrigins?: string[] }).requestedOrigins,
        ),
      ).toEqual(["http://localhost:8000/*"]);
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Settings saved");
    const saved = await serviceWorker.evaluate(
      async () => (await chrome.storage.local.get<{ settings: Settings }>("settings")).settings,
    );
    expect(saved.provider).toBe(provider);
    expect(saved.model).toBe("jev-test");
    expect(saved.apiKey).toBe(provider === "custom" ? "" : "provider-key");
    await page.reload();
    await expect(page.getByLabel("Jev provider", { exact: true })).toHaveValue(provider);
    await expect(page.getByLabel("Model (optional)", { exact: true })).toHaveValue("jev-test");
    if (provider === "custom")
      await expect(page.getByLabel("Decision endpoint URL", { exact: true })).toHaveValue(endpoint);
  });
}

test("denied custom access leaves saved settings unchanged and sends no request", async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.getByLabel("Jev provider", { exact: true }).selectOption("custom");
  await page
    .getByLabel("Decision endpoint URL", { exact: true })
    .fill("http://localhost:8000/decide");
  await page.evaluate(() => {
    chrome.permissions.request = async () => false;
    globalThis.fetch = async () => {
      throw Error("unexpected fetch");
    };
  });
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Endpoint access was denied");
  expect(
    await serviceWorker.evaluate(async () => (await chrome.storage.local.get("settings")).settings),
  ).toBeUndefined();
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Endpoint access was denied");
});
