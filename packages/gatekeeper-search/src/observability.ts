import { createObservabilityContext } from "@gadgets/backend-utils/observability-context";

/** Observability fields emitted by the Web Search gatekeeper. */
export type SearchObservabilityFields = {
  accountId: string;
  engines: string;
  operation: string;
  resultCount: number;
  status: number;
  vendorId: string;
};

/** Ambient observability fields for one Web Search operation. */
export const obsContext = createObservabilityContext<SearchObservabilityFields>();

export const VENDOR_ID = "search";
