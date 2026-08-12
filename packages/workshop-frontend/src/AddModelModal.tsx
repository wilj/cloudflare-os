import { useState, useEffect } from 'react'
import { Dialog, Button, Checkbox, Input, Select, SensitiveInput, Collapsible, useKumoToastManager } from '@cloudflare/kumo'
import { AiChatAuthorInfo, AiModelConfig, AiModelProvider, AiGatewayInfo, SUGGESTED_MODELS } from '@gadgets/workshop-shared/api'
import { RpcStub } from 'capnweb'
import {
  CURATED_API_URL, CURATED_MODELS, CURATED_PROVIDER, DEFAULT_CURATED_MODEL_ID,
  QUICK_CURATED_MODEL_ID,
} from './curatedModels'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'

interface AddModelModalProps {
  visible: boolean
  onCancel: () => void
  onSuccess: () => void
  authenticatedApi: RpcStub<AuthenticatedApi>
  aiConfig: AiGatewayInfo | null
  // Ids the user already has configured, so the curated list can mark them. Ticking one again
  // overwrites its stored config, since addModel is an upsert keyed on model id.
  configuredModelIds?: string[]
}

type SelectionType =
  | { type: 'suggested', provider: AiModelProvider, modelId: string, displayName: string }
  | { type: 'custom', provider: AiModelProvider }

const PROVIDER_LABELS: Record<AiModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  cloudflare: 'Cloudflare Workers AI',
  ollama: 'Ollama',
}

// Placeholder hinting at the shape of each provider's API token.
const API_TOKEN_PLACEHOLDERS: Record<AiModelProvider, string> = {
  anthropic: 'sk-ant-...',
  openai: 'sk-...',
  google: 'AIza...',
  cloudflare: 'Cloudflare API token',
  ollama: '(optional)',
}

// Example used in the custom-model placeholders for providers that have no suggested models
// (currently Ollama, which serves whatever the user has pulled locally).
const FALLBACK_EXAMPLE_MODEL = { modelId: 'gemma4:31b', name: 'Gemma 4 31B' }

// Pick an example model to show in the custom-model placeholders for the given provider.
function exampleModel(provider: AiModelProvider): { modelId: string, name: string } {
  const first = Object.entries(SUGGESTED_MODELS[provider])[0]
  return first ? { modelId: first[0], name: first[1].name } : FALLBACK_EXAMPLE_MODEL
}

// Encode a selection into a string value for the Select component.
function encodeSelection(provider: AiModelProvider, modelId?: string): string {
  return modelId ? `${provider}:${modelId}` : `other-${provider}`
}

// Decode a Select value back into a SelectionType.
function decodeSelection(value: string): SelectionType {
  if (value.startsWith('other-')) {
    return { type: 'custom', provider: value.substring(6) as AiModelProvider }
  }
  const colonIndex = value.indexOf(':')
  const provider = value.substring(0, colonIndex) as AiModelProvider
  const modelId = value.substring(colonIndex + 1)
  const displayName = SUGGESTED_MODELS[provider][modelId].name
  return { type: 'suggested', provider, modelId, displayName }
}

// Build the flat list of options for the Select dropdown.
function buildOptions(gatewayMode: boolean, enabledProviders: Set<string> | null) {
  const options: { value: string; label: string; provider: string }[] = []
  const providerOrder = Object.keys(SUGGESTED_MODELS) as AiModelProvider[]

  for (const provider of providerOrder) {
    if (enabledProviders && !enabledProviders.has(provider)) continue

    // In gateway mode, suggested models are already built-in, so don't list them.
    if (!gatewayMode) {
      for (const [modelId, model] of Object.entries(SUGGESTED_MODELS[provider])) {
        options.push({
          value: encodeSelection(provider, modelId),
          label: model.name,
          provider,
        })
      }
    }

    options.push({
      value: encodeSelection(provider),
      label: `Other ${PROVIDER_LABELS[provider] || provider}...`,
      provider,
    })
  }

  return options
}

export default function AddModelModal({
  visible, onCancel, onSuccess, authenticatedApi, aiConfig, configuredModelIds,
}: AddModelModalProps) {
  const toasts = useKumoToastManager()

  const [loading, setLoading] = useState(false)
  const [selection, setSelection] = useState<SelectionType | null>(null)
  const [selectValue, setSelectValue] = useState<string | undefined>(undefined)

  // Form fields (used for custom models)
  const [modelId, setModelId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [accountId, setAccountId] = useState('')
  const [apiUrl, setApiUrl] = useState('')

  // Validation errors
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Advanced settings collapsible state
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // Curated block: tick several, supply the key once.
  const [curatedChecked, setCuratedChecked] = useState<Set<string>>(new Set())
  const [curatedToken, setCuratedToken] = useState('')
  const [curatedLoading, setCuratedLoading] = useState(false)
  const [curatedError, setCuratedError] = useState<string | null>(null)

  const gatewayMode = aiConfig?.enabled === true
  const enabledProviders: Set<string> | null = gatewayMode
    ? new Set(aiConfig.enabledProviders)
    : null

  // Reset all state when dialog closes
  useEffect(() => {
    if (!visible) {
      setSelection(null)
      setSelectValue(undefined)
      setModelId('')
      setDisplayName('')
      setApiToken('')
      setAccountId('')
      setApiUrl('')
      setErrors({})
      setAdvancedOpen(false)
      setCuratedChecked(new Set())
      setCuratedToken('')
      setCuratedLoading(false)
      setCuratedError(null)
    }
  }, [visible])

  const handleModelSelect = (value: string) => {
    setSelectValue(value)
    setErrors({})
    const sel = decodeSelection(value)
    setSelection(sel)

    if (sel.type === 'custom') {
      setModelId('')
      setDisplayName('')
    } else {
      setModelId(sel.modelId)
      setDisplayName(sel.displayName)
    }
    setApiToken('')
    setAccountId('')
    setApiUrl(sel.provider === 'ollama' ? 'http://localhost:11434' : '')
  }

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}

    if (!selection) {
      newErrors.selection = gatewayMode ? 'Please select a provider' : 'Please select a model'
    }

    if (selection?.type === 'custom') {
      if (!modelId.trim()) newErrors.modelId = 'Please enter the model ID'
      if (!displayName.trim()) newErrors.displayName = 'Please enter a display name'
    }

    const isOllama = selection?.provider === 'ollama'
    const isCloudflare = selection?.provider === 'cloudflare'
    const showCredentials = !gatewayMode

    if (showCredentials && selection && !isOllama && !apiToken.trim()) {
      newErrors.apiToken = 'Please enter your API token'
    }

    if (showCredentials && isCloudflare && !accountId.trim()) {
      newErrors.accountId = 'Please enter your Cloudflare account ID'
    }

    if (showCredentials && isOllama && !apiUrl.trim()) {
      newErrors.apiUrl = 'Please enter the Ollama API URL'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const configured = new Set(configuredModelIds ?? [])

  const toggleCurated = (id: string) => {
    setCuratedError(null)
    setCuratedChecked(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  // Adds every ticked model with one shared key. `addModel` performs no network call and does not
  // validate the key, so failures here are transport-level and correlated -- a lost socket rejects
  // the rest identically. allSettled rather than all: an unhandled rejection would be reported to
  // the server by the global error handler.
  const handleCuratedSubmit = async () => {
    if (curatedChecked.size === 0 || !curatedToken.trim() || curatedLoading) return
    setCuratedLoading(true)
    setCuratedError(null)

    const chosen = CURATED_MODELS.filter(m => curatedChecked.has(m.id))
    const results = await Promise.allSettled(chosen.map(model =>
      authenticatedApi.addModel(
        { type: 'agent', id: model.id, name: model.name },
        {
          provider: CURATED_PROVIDER,
          model: model.id,
          apiToken: curatedToken.trim(),
          apiUrl: CURATED_API_URL,
        },
      )))

    const added = chosen.filter((_, i) => results[i].status === 'fulfilled')
    const failed = chosen.length - added.length

    if (added.length > 0) {
      // Only when the user has no default yet. Setting it unconditionally would silently replace a
      // choice they already made -- the same hazard the "already added" marker guards against.
      try {
        if (await authenticatedApi.getPreferredModel() === null
            && added.some(m => m.id === DEFAULT_CURATED_MODEL_ID)) {
          await authenticatedApi.setPreferredModel(DEFAULT_CURATED_MODEL_ID)
        }
        // Chat titles are generated only when a quick model is set, and nothing else in this flow
        // sets one -- today that is discoverable only by clicking a row on the providers page.
        //
        // The cheap model, not the default one: see QUICK_CURATED_MODEL_ID.
        if (await authenticatedApi.getQuickModel() === null) {
          await authenticatedApi.setQuickModel(
            added.find(m => m.id === QUICK_CURATED_MODEL_ID)?.id ?? added[0].id)
        }
      } catch {
        // Preferences are a convenience; the models are already added.
      }
    }

    setCuratedLoading(false)
    if (failed > 0) {
      setCuratedError(added.length > 0
        ? `Added ${added.length}, but ${failed} failed. Check your connection and try again.`
        : 'Could not add the models. Check your connection and try again.')
      if (added.length === 0) return
    }
    toasts.add({
      title: added.length === 1 ? 'Added 1 model' : `Added ${added.length} models`,
      variant: 'success',
    })
    onSuccess()
  }

  const handleSubmit = async () => {
    if (!validate()) return

    setLoading(true)
    try {
      const isSuggested = selection!.type === 'suggested'
      const finalModelId = isSuggested ? selection!.modelId : modelId.trim()
      const finalDisplayName = isSuggested ? selection!.displayName : displayName.trim()

      const profile: AiChatAuthorInfo = {
        type: 'agent',
        id: finalModelId,
        name: finalDisplayName,
      }

      const config: AiModelConfig = {
        provider: selection!.provider,
        model: finalModelId,
        apiToken: gatewayMode ? '' : apiToken.trim(),
        ...(!gatewayMode && accountId.trim() && { accountId: accountId.trim() }),
        ...(!gatewayMode && apiUrl.trim() && { apiUrl: apiUrl.trim() }),
      }

      await authenticatedApi.addModel(profile, config)
      toasts.add({ title: 'AI model added successfully', variant: 'success' })
      onSuccess()
    } catch (error: any) {
      console.error('Failed to add model:', error)
      toasts.add({ title: 'Failed to add model', variant: 'error' })
    } finally {
      setLoading(false)
    }
  }

  const options = buildOptions(gatewayMode, enabledProviders)
  const showCustomFields = selection?.type === 'custom'
  const example = selection ? exampleModel(selection.provider) : null
  const isOllama = selection?.provider === 'ollama'
  const isCloudflare = selection?.provider === 'cloudflare'
  const showCredentials = !gatewayMode

  // Group options by provider for rendering with visual separators.
  const groupedOptions: { provider: string; items: typeof options }[] = []
  for (const opt of options) {
    const last = groupedOptions[groupedOptions.length - 1]
    if (last && last.provider === opt.provider) {
      last.items.push(opt)
    } else {
      groupedOptions.push({ provider: opt.provider, items: [opt] })
    }
  }

  return (
    <Dialog.Root open={visible} onOpenChange={(open) => { if (!open) onCancel() }}>
      <Dialog className="p-6" size="lg">
        <Dialog.Title className="text-lg font-semibold mb-4">
          Add AI Model
        </Dialog.Title>

        <div className="space-y-4">
          {/* Curated models: tick several, supply the key once. Hidden in AI Gateway mode, where
              credentials come from the deployment and addModel rejects unenabled providers. */}
          {!gatewayMode && CURATED_MODELS.length > 0 && (
            <div className="rounded-lg border border-kumo-line p-4">
              <div className="text-sm font-medium mb-1">Recommended models</div>
              <div className="text-xs text-kumo-subtle mb-3">
                Pick any number. They all use one OpenRouter key, entered once.
              </div>

              <div className="space-y-2 mb-4">
                {CURATED_MODELS.map(model => {
                  const already = configured.has(model.id)
                  return (
                    <div key={model.id} className="flex items-start gap-2">
                      <Checkbox
                        checked={curatedChecked.has(model.id)}
                        onCheckedChange={() => toggleCurated(model.id)}
                        disabled={curatedLoading}
                        label={
                          <span className="text-sm">
                            {model.name}
                            {already && (
                              <span className="ml-2 text-xs text-kumo-subtle">Added</span>
                            )}
                            <span className="block text-xs text-kumo-subtle">{model.note}</span>
                          </span>
                        }
                      />
                    </div>
                  )
                })}
              </div>

              <SensitiveInput
                label="OpenRouter API key"
                placeholder="sk-or-v1-..."
                description="One key for all of the above. Get one at openrouter.ai/keys"
                value={curatedToken}
                onChange={(e) => setCuratedToken(e.target.value)}
                className="w-full text-sm"
                disabled={curatedLoading}
              />

              {curatedError && (
                <div className="mt-2 text-xs text-kumo-danger">{curatedError}</div>
              )}

              <Button
                variant="primary"
                className="mt-3 w-full justify-center"
                onClick={handleCuratedSubmit}
                loading={curatedLoading}
                disabled={curatedChecked.size === 0 || !curatedToken.trim()}
              >
                {curatedChecked.size <= 1 ? 'Add model' : `Add ${curatedChecked.size} models`}
              </Button>

              <div className="flex items-center gap-3 mt-4">
                <div className="h-px flex-1 bg-kumo-line" />
                <span className="text-xs text-kumo-subtle">or configure one yourself</span>
                <div className="h-px flex-1 bg-kumo-line" />
              </div>
            </div>
          )}

          {/* Model / Provider selection */}
          <Select
            label={gatewayMode ? 'Select Provider' : 'Select Model'}
            className="w-full text-sm"
            placeholder={gatewayMode ? 'Choose a provider...' : 'Choose an AI model...'}
            value={selectValue}
            onValueChange={(v) => handleModelSelect(v as string)}
            error={errors.selection}
            renderValue={(v) => {
              const opt = options.find(o => o.value === v)
              return opt?.label ?? String(v)
            }}
          >
            {groupedOptions.map((group, groupIndex) => (
              <div key={group.provider}>
                {groupIndex > 0 && (
                  <div className="h-px bg-kumo-line my-1 mx-2" />
                )}
                <div className="px-3 py-1.5 text-xs font-medium text-kumo-subtle select-none">
                  {PROVIDER_LABELS[group.provider as AiModelProvider] || group.provider}
                </div>
                {group.items.map(opt => (
                  <Select.Option key={opt.value} value={opt.value}>
                    {opt.label}
                  </Select.Option>
                ))}
              </div>
            ))}
          </Select>

          {/* Custom model fields */}
          {showCustomFields && (
            <>
              <Input
                label="Model ID"
                placeholder={`e.g., ${example!.modelId}`}
                description={`The model identifier as specified by the provider (e.g., '${example!.modelId}')`}
                value={modelId}
                onChange={(e) => { setModelId(e.target.value); setErrors(prev => ({ ...prev, modelId: '' })) }}
                error={errors.modelId}
                variant={errors.modelId ? 'error' : 'default'}
              />

              <Input
                label="Display Name"
                placeholder={`e.g., ${example!.name}`}
                description="Human-readable name shown in the UI"
                value={displayName}
                onChange={(e) => { setDisplayName(e.target.value); setErrors(prev => ({ ...prev, displayName: '' })) }}
                error={errors.displayName}
                variant={errors.displayName ? 'error' : 'default'}
              />
            </>
          )}

          {/* Cloudflare account ID (the Workers AI REST endpoint is account-scoped) */}
          {showCredentials && isCloudflare && (
            <Input
              label="Cloudflare Account ID"
              placeholder="e.g., 0123456789abcdef0123456789abcdef"
              description="The Cloudflare account to bill for Workers AI usage"
              value={accountId}
              onChange={(e) => { setAccountId(e.target.value); setErrors(prev => ({ ...prev, accountId: '' })) }}
              error={errors.accountId}
              variant={errors.accountId ? 'error' : 'default'}
            />
          )}

          {/* API Token */}
          {showCredentials && selection && (
            <SensitiveInput
              label="API Token"
              placeholder={API_TOKEN_PLACEHOLDERS[selection.provider]}
              description={
                isOllama
                  ? 'Optional for local Ollama access'
                  : isCloudflare
                  ? 'An API token with Workers AI Read + Edit permissions (in the dashboard: Workers AI > Use REST API > Create a Workers AI API Token)'
                  : `Your ${PROVIDER_LABELS[selection.provider]} API token for billing`
              }
              value={apiToken}
              onValueChange={(v) => { setApiToken(v); setErrors(prev => ({ ...prev, apiToken: '' })) }}
              error={errors.apiToken}
              variant={errors.apiToken ? 'error' : 'default'}
            />
          )}

          {/* Ollama API URL (always visible for Ollama) */}
          {showCredentials && isOllama && (
            <Input
              label="API URL"
              placeholder="http://localhost:11434"
              description="URL of your Ollama server"
              value={apiUrl}
              onChange={(e) => { setApiUrl(e.target.value); setErrors(prev => ({ ...prev, apiUrl: '' })) }}
              error={errors.apiUrl}
              variant={errors.apiUrl ? 'error' : 'default'}
            />
          )}

          {/* Advanced Settings for non-Ollama, non-Cloudflare providers */}
          {showCredentials && selection && !isOllama && !isCloudflare && (
            <Collapsible.Root
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
            >
              <Collapsible.DefaultTrigger>Advanced Settings</Collapsible.DefaultTrigger>
              <Collapsible.DefaultPanel>
                <Input
                  label="API URL"
                  placeholder="https://..."
                  description="Override the default API endpoint (useful for proxies like Cloudflare AI Gateway)"
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                />
              </Collapsible.DefaultPanel>
            </Collapsible.Root>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 flex justify-end gap-2">
          <Dialog.Close render={(props) => (
            <Button variant="secondary" {...props} disabled={loading}>
              Cancel
            </Button>
          )} />
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={loading}
            disabled={!selection}
          >
            Add Model
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
