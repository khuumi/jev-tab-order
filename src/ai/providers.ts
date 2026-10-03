import type { DecisionSettings, Judge } from "@/src/types";

export const PROVIDERS = {
  openrouter: {
    endpoint: "https://openrouter.ai/api/alpha/decisions",
    model: "~typesafe/jev-latest",
  },
  typesafe: { endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-latest" },
  custom: { endpoint: "", model: "" },
};
type JevRequest = { state: Parameters<Judge>[0]; questions: Parameters<Judge>[1] };
export type DecisionProvider = {
  maxRequestBytes: number;
  requestBytes: (request: JevRequest) => number;
  decide: (request: JevRequest) => Promise<unknown>;
};

export const resolveProvider = (settings: DecisionSettings) => {
  const provider = settings.provider ?? "openrouter";
  const defaults = PROVIDERS[provider];
  if (!defaults) throw new Error("invalidEndpoint");
  const endpoint = provider === "custom" ? (settings.endpoint ?? "").trim() : defaults.endpoint;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("invalidEndpoint");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.protocol === "http:" && settings.apiKey.trim())
  )
    throw new Error("invalidEndpoint");
  return { endpoint: url.href, model: settings.model?.trim() || defaults.model };
};

// Call directly from a click/submit handler: Chrome requires a user gesture.
export const requestProviderAccess = (settings: DecisionSettings) => {
  const { endpoint } = resolveProvider(settings);
  if ((settings.provider ?? "openrouter") === "openrouter") return Promise.resolve(true);
  return chrome.permissions.request({ origins: [`${new URL(endpoint).origin}/*`] });
};

export const createDecisionProvider = (
  settings: DecisionSettings,
  signal: AbortSignal,
): DecisionProvider => {
  const { endpoint, model } = resolveProvider(settings);
  const apiKey = settings.apiKey.trim();
  if (!apiKey && (settings.provider ?? "openrouter") !== "custom") throw new Error("missingKey");
  const payload = ({ state, questions }: JevRequest) =>
    JSON.stringify({ ...(model ? { model } : {}), state, questions });
  return {
    // Conservative serialized UTF-8 input budget, including model and state.
    // Smaller context windows are handled by token-limit splitting below.
    maxRequestBytes: 64000,
    requestBytes: (request) => new TextEncoder().encode(payload(request)).length,
    decide: async ({ state, questions }) => {
      if (!Object.keys(questions).length) return { answers: {} };
      if (signal.aborted) throw new Error("cancelled");
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal.addEventListener("abort", cancel, { once: true });
      const timeout = setTimeout(cancel, 25000);
      try {
        let response: Response;
        try {
          response = await fetch(endpoint, {
            method: "POST",
            headers: {
              ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
              "Content-Type": "application/json",
            },
            signal: controller.signal,
            redirect: "error",
            body: payload({ state, questions }),
          });
        } catch {
          throw new Error(signal.aborted ? "cancelled" : "networkError");
        }
        if (signal.aborted) throw new Error("cancelled");
        if (!response.ok) {
          let tokenLimit = response.status === 413;
          if (response.status === 400) {
            try {
              const body = await response.json();
              tokenLimit =
                body?.detail?.error_type === "max_tokens_exceeded" ||
                /context[_ ](?:length|window)|max(?:imum)?[_ ](?:context|tokens)|too many tokens|token limit|input.*(?:too long|exceed)/i.test(
                  String(body?.error?.code ?? "") + " " + String(body?.error?.message ?? ""),
                );
            } catch {
              if (signal.aborted) throw new Error("cancelled");
            }
          }
          throw new Error(
            tokenLimit
              ? "tokenLimit"
              : response.status === 401 || response.status === 403
                ? "invalidKey"
                : response.status === 429
                  ? "rateLimited"
                  : "apiError",
            { cause: { httpStatus: response.status } },
          );
        }
        let data: unknown;
        try {
          data = await response.json();
        } catch {
          throw new Error(
            signal.aborted
              ? "cancelled"
              : controller.signal.aborted
                ? "networkError"
                : "invalidResponse",
          );
        }
        if (signal.aborted) throw new Error("cancelled");
        return data;
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", cancel);
      }
    },
  };
};

export const updateCustomEndpoint = (settings: DecisionSettings, endpoint: string) => {
  const origin = (value: string) => {
    try {
      return new URL(value).origin;
    } catch {
      return undefined;
    }
  };
  return {
    ...settings,
    endpoint,
    apiKey: origin(settings.endpoint ?? "") === origin(endpoint) ? settings.apiKey : "",
  };
};
