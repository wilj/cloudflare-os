// Models this deployment offers ready-made in the Add Model dialog.
//
// Everything here is reached through OpenRouter, which the app talks to as the `openai` provider
// with `apiUrl` overridden. Without this list a user must, per model, pick "Other OpenAI…",
// hand-type the model id, invent a display name, and paste the same API URL into a collapsed
// "Advanced Settings" panel — four free-text fields, repeated, for every model and every user.
//
// Deliberately no prices, context windows or output limits. Those come from pi's OpenRouter catalog
// at runtime (see catalogModel() in workshop-backend), which self-updates on a pi bump; duplicating
// them here would create a second copy to go stale, and an `outputLimit` in particular is load
// bearing for compaction budgets and easy to get catastrophically wrong.

export type CuratedModel = {
  // The provider-side model id. Also becomes the stored record's primary key.
  id: string;
  name: string;
  // Shown under the name so the trade-off is visible at the moment of choosing.
  note: string;
};

// Every model here is reached at this base URL.
export const CURATED_API_URL = "https://openrouter.ai/api/v1";

// The provider these are configured as. OpenRouter speaks the OpenAI Responses API, which is what
// this provider's handle builds.
export const CURATED_PROVIDER = "openai" as const;

// Ordered as presented. `gpt-5.6-luna` leads because it is the intended default: see
// DEFAULT_CURATED_MODEL_ID.
export const CURATED_MODELS: CuratedModel[] = [
  {
    id: "openai/gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    note: "Everyday driver. Fast and inexpensive.",
  },
  {
    id: "openai/gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    note: "More capable, for work that needs it.",
  },
  {
    id: "google/gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro",
    note: "Science, analysis and computational work.",
  },
  {
    id: "minimax/minimax-m3",
    name: "MiniMax M3",
    note: "Bulk generation. Very long outputs.",
  },
  {
    id: "deepseek/deepseek-v4-flash-0731",
    name: "DeepSeek V4 Flash",
    // Worth stating plainly: this model cannot read images at all. It is the cheapest option and a
    // reasonable default for text work, but a pasted screenshot will be dropped from the prompt.
    note: "Cheapest. Text only — cannot read images.",
  },
];

// Preselected after a curated add, so the text-only model does not become the default purely by
// sorting first in storage.
export const DEFAULT_CURATED_MODEL_ID = "openai/gpt-5.6-luna";
