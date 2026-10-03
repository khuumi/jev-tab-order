<div align="center">
  <img src="store-assets/social-preview-1280x640.png" alt="Jev Tab Order" width="640" height="320">

# Jev Tab Order

[English](README.md) | [日本語](README.ja.md)

[![Chrome Web Store Version](https://img.shields.io/chrome-web-store/v/afbcjklgfmfokamphkgclkocfhgablka.svg)](https://chromewebstore.google.com/detail/jev-tab-order/afbcjklgfmfokamphkgclkocfhgablka)
[![Chrome Web Store Users](https://img.shields.io/chrome-web-store/users/afbcjklgfmfokamphkgclkocfhgablka.svg)](https://chromewebstore.google.com/detail/jev-tab-order/afbcjklgfmfokamphkgclkocfhgablka)
[![Chrome Web Store Rating](https://img.shields.io/chrome-web-store/rating/afbcjklgfmfokamphkgclkocfhgablka.svg)](https://chromewebstore.google.com/detail/jev-tab-order/afbcjklgfmfokamphkgclkocfhgablka)
[![GitHub Stars](https://img.shields.io/github/stars/proshunsuke/jev-tab-order.svg)](https://github.com/proshunsuke/jev-tab-order)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/)
[![License](https://img.shields.io/github/license/proshunsuke/jev-tab-order.svg)](https://github.com/proshunsuke/jev-tab-order)

<a href="https://chromewebstore.google.com/detail/jev-tab-order/afbcjklgfmfokamphkgclkocfhgablka">
  <img src="https://developer.chrome.com/static/docs/webstore/branding/image/iNEddTyWiMfLSwFD6qGq.png" alt="Available in the Chrome Web Store" width="248" height="75">
</a>

</div>

A Chrome extension that uses [Jev](https://typesafe.ai/) to organize tabs and groups in the current window by meaning and your sorting rules. Pinned tabs and existing group memberships stay intact.

**Organize the entire window with bounded Jev requests.** Planning uses staged requests; larger workloads are split automatically.

## Getting Started

1. Install the extension from the [Chrome Web Store](https://chromewebstore.google.com/detail/jev-tab-order/afbcjklgfmfokamphkgclkocfhgablka).
2. Open the extension's settings and select a Jev provider and save its settings.
3. Click the toolbar icon in the window you want to organize. No popup opens; the icon shows “…” while running and “✓” on completion, then clears the badge after three seconds. You can also use the page context menu or a configured shortcut.

See [supported languages](locales/).

For installation from source, see [Manual Installation](#manual-installation).

### Settings

Select where to run Jev. Existing settings continue to use OpenRouter with the same saved key.

| Provider       | Endpoint                                    | Default model            | API key                  |
| -------------- | ------------------------------------------- | ------------------------ | ------------------------ |
| OpenRouter     | `https://openrouter.ai/api/alpha/decisions` | `~typesafe/jev-latest`   | Required: OpenRouter key |
| TypeSafe       | `https://api.typesafe.ai/v1/systemone`      | `jev-latest`             | Required: TypeSafe key   |
| Custom / Local | Full URL you provide                        | Omitted unless specified | Optional                 |

- **Model**: Override the provider default with a compatible Jev model identifier. Leave blank to use the default; Custom / Local sends no model when blank.
- **Decision endpoint URL**: Custom / Local uses this exact HTTP or HTTPS URL. Include the API path; no path is appended. The endpoint must accept `{ state, questions, model? }` and return `{ answers }` with Jev choice/score semantics. A generic chat-completions endpoint is not compatible. URL credentials, query parameters, and fragments are rejected. Requests do not follow redirects.
- **API key**: Stored on this device only. The key is cleared when switching providers or changing the custom endpoint origin (same-origin path changes keep it) to avoid sending a key to another service. Custom / Local omits the Authorization header when blank. Save and Test connection request access to the TypeSafe or custom origin; denying access prevents saving or testing. Chrome grants host access, not access limited to the API path. HTTP is allowed only without an API key, including for localhost. Any endpoint using a key must use HTTPS.
- **Test connection**: Uses the currently entered provider, endpoint, model, and key without requiring a save. Organization and previews use saved settings. Organization and preview split large workloads into bounded requests; undo sends none.

- **Sorting rules**: Leave blank to use the defaults. Custom text replaces the entire default rule. Example: “Put official documentation before tutorials. Order groups as Development, Research, Personal.”
- **Allow new groups**: New groups require this setting to be enabled, multiple related ungrouped tabs, and available Chrome built-in AI for naming. Use the preparation button in settings if the model needs an initial download.

<img src="store-assets/screenshots/en/01-settings.png" alt="Jev Tab Order — Settings" width="640">

## How It Works

The extension collects the window's tab information, asks Jev for judgments, then turns those answers into a layout and applies it through Chrome.

1. **Collect information — extension:** Read tab titles, URLs, current positions, and group memberships. Prepare the rules and group names alongside them. Pinned tabs are excluded from Jev's input; page bodies are not read. URL credentials, query strings, and fragments are removed before sending.
2. **Judge meaning — Jev:** Evaluate questions in **requests bounded by serialized size**: which existing group an ungrouped tab fits, which tabs or groups belong next to each other, how early or late each should appear under the rules. Candidates include domains or group names to make the choices clear. Jev returns choices and numeric priority scores, with probabilities and confidence.
3. **Build the layout — extension:** Use accepted choices to assign ungrouped tabs and gather related items into adjacent sets. Sort within and between those sets using Jev's scores, with lower scores placed earlier. Answers below the acceptance thresholds are ignored; ties preserve their previous order, and items without an accepted score keep their slot in that sorting step. Layout assembly runs locally; ranking can request additional bounded comparisons.
4. **Name new groups — Chrome's local AI, when enabled:** If the setting allows new groups and Jev confidently clusters the tabs, related ungrouped tabs can form a group. Chrome's built-in AI generates its name from tab titles. If naming is unavailable, those tabs remain adjacent without a new group.
5. **Validate and apply — extension:** Check that the plan preserves every tab, pinned tabs, and existing group memberships, then move tabs and groups through Chrome APIs. Preview stops before applying; undo restores the saved layout without calling Jev.

For example, if Jev selects “GitHub” as an ungrouped tab's destination and the answer passes the acceptance thresholds, the extension adds that tab to the existing GitHub group. Jev supplies the judgment; the extension performs the browser operation.

### What the Jev Request Contains

With OpenRouter selected, the extension uses native `fetch` to send JSON to `POST https://openrouter.ai/api/alpha/decisions` with `model: "~typesafe/jev-latest"`. The body contains shared context (`state`) and multiple judgments (`questions`). **Each API call contains a bounded batch of questions**. Planning resolves structure before preparing ranking questions.

- **`state` — information to judge:** The active rules, web tab IDs, titles, sanitized URLs, and group memberships; existing group names and member IDs; and the current sequence of groups and ungrouped tabs. Each planning stage sends only its relevant context.
- **`questions` — what to decide:** Each question contains `type` (Choice or Score), `instructions` (the judgment to make under the rules), and `criteria` (available choices or ordered scoring levels).

| Judgment                                                       | Type                  | Requested answer                                                                                                                               |
| -------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing group for each ungrouped tab                          | **Choice** (`choice`) | A group ID, with its name attached to the option, or `none` to leave the tab ungrouped                                                         |
| Adjacent tab                                                   | **Choice** (`choice`) | An earlier candidate tab ID, with its domain attached, or `self` for no match. Candidates are from the same existing group, or both ungrouped. |
| Adjacent group or ungrouped tab                                | **Choice** (`choice`) | An earlier candidate's ID, with its group name or domain attached, or `self` to keep it separate                                               |
| Position priority for each tab and each group or ungrouped tab | **Score** (`score`)   | A score on five levels: earliest, early, middle/no specified order, late, latest                                                               |

Choice returns the selected ID in `choice`; the extension uses it to connect tabs or assign a destination group. Score returns a value from **0 to 4**, potentially fractional, rather than a final tab position. The extension uses it as a sorting priority or as a local comparison during merge sorting. Both include `probabilities` and `confidence`, which the extension checks before using the answer. Score also includes `legend`, mapping level numbers to their descriptions.

### Staged Request Example

Two unpinned tabs start in different containers: tab `1` (GitHub) belongs to group `7` (GitHub), and tab `2` (GitHub Docs) is ungrouped. The first request resolves membership. Block adjacency uses a separate compact context. The examples omit the transport's model field; fixed instructions are English and user rules are sent unchanged.

**Structural request:**

```json
{
  "state": {
    "rules": "Add GitHub tabs to the GitHub group. Put documentation first.",
    "tabs": [
      {
        "id": "1",
        "title": "GitHub",
        "url": "https://github.com/",
        "groupId": 7
      },
      {
        "id": "2",
        "title": "GitHub Docs",
        "url": "https://docs.github.com/",
        "groupId": -1
      }
    ],
    "groups": [
      {
        "key": "group_7",
        "title": "GitHub",
        "tabIds": ["1"]
      }
    ],
    "blocks": [
      {
        "key": "group_7",
        "title": "GitHub",
        "tabIds": ["1"]
      },
      {
        "key": "topic_2",
        "title": "",
        "tabIds": ["2"]
      }
    ]
  },
  "questions": {
    "membership_2": {
      "type": "choice",
      "instructions": "According to state.rules, select an existing group for ungrouped tab 2 (Domain: docs.github.com), or none.",
      "criteria": {
        "none": "Keep ungrouped",
        "group_7": "Group name: \"GitHub\""
      }
    }
  },
  "model": "~typesafe/jev-latest"
}
```

If membership selects `group_7`, both tabs become peers. A later request ranks only those final peers, retaining the container name and final membership:

```json
{
  "state": {
    "rules": "Add GitHub tabs to the GitHub group. Put documentation first.",
    "container": {
      "key": "group_7",
      "title": "GitHub"
    },
    "tabs": [
      {
        "key": "1",
        "id": "1",
        "title": "GitHub",
        "url": "https://github.com/",
        "groupId": 7
      },
      {
        "key": "2",
        "id": "2",
        "title": "GitHub Docs",
        "url": "https://docs.github.com/",
        "groupId": 7
      }
    ]
  },
  "questions": {
    "rank_tab_1": {
      "type": "score",
      "instructions": "Rate the position of tab 1 among the complete ranking peers in state.tabs under state.rules; earlier is lower. Use the middle level if no order is specified.",
      "criteria": [
        "Earliest priority under the rules",
        "Early priority under the rules",
        "Middle priority or no distinguished order under the rules",
        "Late priority under the rules",
        "Latest priority under the rules"
      ]
    },
    "rank_tab_2": {
      "type": "score",
      "instructions": "Rate the position of tab 2 among the complete ranking peers in state.tabs under state.rules; earlier is lower. Use the middle level if no order is specified.",
      "criteria": [
        "Earliest priority under the rules",
        "Early priority under the rules",
        "Middle priority or no distinguished order under the rules",
        "Late priority under the rules",
        "Latest priority under the rules"
      ]
    }
  }
}
```

Score answers use the five-level `legend` and probability distribution described above. One final block needs no block-ranking request. With multiple final blocks, a separate request uses compact block descriptors. New-group naming waits until ranking completes.

## Privacy

See the [Privacy Policy](PRIVACY.md).

## Development

### Setup

Use a Node.js version supported by [package.json](package.json); the [CI workflow](.github/workflows/test.yml) uses Node.js 24. Run these commands from the project directory:

```fish
npm ci
```

### Common Commands

```fish
npm run dev          # Start Chrome development mode with hot reload
npm run build        # Build the Chrome extension
npm run typecheck    # Check TypeScript types
npm run lint:check   # Check lint without changing files
npm run format:check # Check formatting without changing files
```

### Manual Installation

After completing setup:

1. Run `npm run build`.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select `dist/chrome-mv3`.
4. Open the extension's settings, enter your API key, and click **Save settings**.

After rebuilding, reload the extension from `chrome://extensions` to use the updated build.

### Unit Tests

The shared transport tests run against OpenRouter, TypeSafe, and Custom / Local. Additional tests cover model overrides, keyless local requests, URL validation, permission requests, and migration of existing settings.

```fish
npm run test:unit
```

### E2E Tests

Install Playwright's Chromium before the first run:

```fish
npx playwright install chromium
npm run test:e2e
```

## Releases

See the [release guide](.agents/skills/jev-tab-order-release/SKILL.md) for preparation and publishing procedures, and [CHANGELOG.md](CHANGELOG.md) for release notes.

### Request budgets

The provider abstraction measures the UTF-8 JSON body, including model, rules, context, and questions, against a conservative 64,000-byte budget. `createJudge` accepts `maxRequestBytes` for integrations with smaller custom/local context windows. This is an input-size estimate, not a model tokenizer guarantee. Token-limit responses (HTTP 413 or recognized HTTP 400 errors) trigger further splitting; unrelated failures are not retried. A minimum useful request that still cannot fit returns the input-limit error.

Planning is staged: resolve membership and adjacency, construct final containers, rank tabs within those containers, rank final blocks, then name new groups. Tab ranking includes only eligible peers in the final container, including each prospective new group when creation is enabled. Block ranking uses compact descriptors: key, existing group title, original position, and up to three representative titles and sanitized URLs. It does not duplicate the rich window state.

When the complete ranking peer set fits, five-level priority questions share that context. The batching layer never removes peers from a score question. If that context cannot fit, or the provider rejects it for size, the planner switches to stable merge sorting with two-peer comparisons. Each merge compares opposing partition heads under the same rules. Local comparison scores are used only to choose the next head; they are never treated as global ranks. Ties and uncertain comparisons take the left head. The deterministic comparison schedule also defines behavior for non-transitive model preferences. A pair that cannot fit returns the input-limit error. Singleton containers need no ranking request. Large rankings can require O(n log n) comparison requests.

Choice questions retain full state when it fits and may scope to targets, offered candidates, and explicitly referenced group/block members otherwise. Tab adjacency does not expand an entire existing group just because its target is a member. Oversized adjacency choices search ordered candidate partitions for the earliest confident match; oversized membership choices compare confident partition winners. Naming starts only after all required decisions resolve. A cancelled run never applies a partial plan. Structural comparisons may still be quadratic. Model judgments can vary with context; deterministic fixtures verify reconciliation rather than identical live-model answers across strategies.
