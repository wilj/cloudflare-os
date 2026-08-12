// The session interface, mirrored for agents by `types.txt`. Keep the two in step: `types.txt` is
// what `describeBinding` hands the model, and a drift between them is a lie the agent cannot check.

import type { WebSearchOptions, WebSearchResult } from "./searxng.js";

export type { WebSearchOptions, WebSearchResult };
export type WebSearchTimeRange = NonNullable<WebSearchOptions["timeRange"]>;

export interface WebSearchSession {
  search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]>;
}
