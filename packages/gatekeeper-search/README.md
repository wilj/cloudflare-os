# Web Search gatekeeper

Gives agents and Gadgets `search()` over the open web, through a [SearXNG](https://github.com/searxng/searxng)
instance the deployment runs. It is the counterpart to the `webFetch` agent tool: `webFetch`
retrieves a URL you already have, this finds the URL.

## Why a gatekeeper

The agent's tool list is fixed in the Workshop backend, and Gadget code cannot make network
requests. A gatekeeper is the supported route to an outside service for both, and it is how every
other search in this product works — Linear's `searchIssues`, Notion's `search`, ZoomInfo's
`searchCompanies`. The agent reads `types.txt` through `describeBinding` and then calls
`env.WEB_SEARCH.search(...)` from `executeCode`.

## Shape

Ambient and auto-provisioned, following Scheduled Tasks and the Context Library:

| | |
|---|---|
| Account | minted on demand (`autoProvisionsAccount`), no connect flow, no credentials |
| Session | one singleton per workspace, `tsType: "WebSearchSession"` |
| Actions | none — every call is a read, authorized as an observation after the fetch |
| Resources | none; there are no URL-addressed resources to grant |
| Sharing | collaborators are accepted, because results come from the public web rather than from the owner's account |

## Configuration

`SEARXNG_URL` — base URL of the SearXNG instance, default `http://searxng:8080`. That is a
container-network address, so under standalone workerd this Worker needs private-network egress;
the deployment grants it through `privateNetworkWorkers` in its generator config.

Which engines answer, and any API keys they need, are SearXNG's `settings.yml` — deliberately not
this package's business. Changing search provider is a config edit, not a code change. The instance
must have `json` in `search.formats` or every query fails with a 403.

## Boundaries worth keeping

* **Errors carry a status and nothing else.** The upstream URL names an internal host, and an engine
  error body can contain that engine's API key. Neither belongs in a message an agent reads back to
  a user. `__tests__/searxng.test.ts` holds that line.
* **`types.txt` and `types.ts` must agree.** `types.txt` is what the model is handed; a drift
  between them is a lie the agent has no way to check.

## Build & test

```
pnpm --filter @gadgets/gatekeeper-search test
pnpm --filter @gadgets/gatekeeper-search types:check
```
