// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// The curated block: tick several models, supply the OpenRouter key once, add them all.
//
// The point of the block is that a user never types a model id, a display name, or the API URL —
// on this deployment that was four free-text fields per model, per user. So the assertions worth
// making are about what reaches `addModel` without anyone typing it.

import { act, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const toastAdd = vi.fn<(toast: unknown) => void>()

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
      Close: ({ render }: { render: (props: object) => ReactElement }) =>
        render({ 'aria-label': 'Close' }),
    },
  )
  const Collapsible = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      DefaultTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      DefaultPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    },
  )
  const Select = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    { Option: ({ children }: { children: ReactNode }) => <div>{children}</div> },
  )
  return {
    Dialog,
    Collapsible,
    Select,
    Checkbox: ({ label, checked, onCheckedChange, disabled }: {
      label: ReactNode; checked?: boolean; onCheckedChange?: () => void; disabled?: boolean
    }) => (
      <button
        type="button"
        data-testid="curated-checkbox"
        data-checked={checked ? 'true' : 'false'}
        disabled={disabled}
        onClick={() => onCheckedChange?.()}
      >{label}</button>
    ),
    Button: ({ children, onClick, disabled }: {
      children: ReactNode; onClick?: () => void; disabled?: boolean
    }) => <button type="button" onClick={onClick} disabled={disabled}>{children}</button>,
    Input: ({ label }: { label?: ReactNode }) => <label>{label}</label>,
    SensitiveInput: ({ label, value, onChange }: {
      label?: ReactNode; value?: string
      onChange?: (e: { target: { value: string } }) => void
    }) => (
      <input
        aria-label={typeof label === 'string' ? label : 'key'}
        value={value ?? ''}
        onChange={(e) => onChange?.({ target: { value: e.target.value } })}
      />
    ),
    useKumoToastManager: () => ({ add: toastAdd }),
  }
})

const { default: AddModelModal } = await import('./AddModelModal')
const { CURATED_API_URL, CURATED_MODELS, DEFAULT_CURATED_MODEL_ID, QUICK_CURATED_MODEL_ID } =
  await import('./curatedModels')

let container: HTMLDivElement
let root: Root

function makeApi(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    addModel: vi.fn<() => Promise<void>>(async () => {}),
    getPreferredModel: vi.fn<() => Promise<string | null>>(async () => null),
    setPreferredModel: vi.fn<() => Promise<void>>(async () => {}),
    getQuickModel: vi.fn<() => Promise<string | null>>(async () => null),
    setQuickModel: vi.fn<() => Promise<void>>(async () => {}),
    ...overrides,
  } as unknown as RpcStub<AuthenticatedApi> & Record<string, ReturnType<typeof vi.fn>>
}

async function render(api: RpcStub<AuthenticatedApi>, props: Record<string, unknown> = {}) {
  await act(async () => {
    root.render(
      <AddModelModal
        visible
        onCancel={() => {}}
        onSuccess={props.onSuccess as () => void ?? (() => {})}
        authenticatedApi={api}
        aiConfig={(props.aiConfig as never) ?? { enabled: false }}
        configuredModelIds={props.configuredModelIds as string[] | undefined}
      />,
    )
  })
}

const checkboxes = () =>
  Array.from(container.querySelectorAll('[data-testid="curated-checkbox"]')) as HTMLButtonElement[]

const buttonSaying = (text: RegExp) =>
  Array.from(container.querySelectorAll('button'))
    .find(b => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined

async function click(el: HTMLElement) {
  await act(async () => { el.click() })
  await act(async () => {})
}

async function typeKey(value: string) {
  const input = container.querySelector('input') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  toastAdd.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe('curated models', () => {
  it('adds every ticked model with one key, and no typed ids or URLs', async () => {
    const api = makeApi()
    await render(api)

    await click(checkboxes()[0])
    await click(checkboxes()[1])
    await typeKey('sk-or-v1-secret')
    await click(buttonSaying(/^Add 2 models$/)!)

    expect(api.addModel).toHaveBeenCalledTimes(2)
    for (const call of (api.addModel as ReturnType<typeof vi.fn>).mock.calls) {
      const [profile, config] = call as [{ id: string }, { apiToken: string; apiUrl: string }]
      // The URL is the thing a user previously had to find behind "Advanced Settings", and the
      // dialog used to wipe it on every selection change.
      expect(config.apiUrl).toBe(CURATED_API_URL)
      expect(config.apiToken).toBe('sk-or-v1-secret')
      expect(CURATED_MODELS.some(m => m.id === profile.id)).toBe(true)
    }
  })

  it('sets the recommended default only when the user has none', async () => {
    const api = makeApi()
    await render(api)
    await click(checkboxes()[0])
    await typeKey('sk-or-v1-secret')
    await click(buttonSaying(/^Add model$/)!)

    expect(api.setPreferredModel).toHaveBeenCalledWith(DEFAULT_CURATED_MODEL_ID)
  })

  it('leaves an existing default alone', async () => {
    // Overwriting it would silently replace a choice the user already made.
    const api = makeApi({
      getPreferredModel: vi.fn<() => Promise<string | null>>(async () => 'something/they-picked'),
    })
    await render(api)
    await click(checkboxes()[0])
    await typeKey('sk-or-v1-secret')
    await click(buttonSaying(/^Add model$/)!)

    expect(api.setPreferredModel).not.toHaveBeenCalled()
  })

  it('sets a quick model when none is set, so chat titles generate', async () => {
    const api = makeApi()
    await render(api)
    await click(checkboxes()[0])
    await typeKey('sk-or-v1-secret')
    await click(buttonSaying(/^Add model$/)!)

    expect(api.setQuickModel).toHaveBeenCalled()
  })

  // Titles are throwaway work the user never asked for. Spending the everyday driver on them cost
  // 3.3x more per output token and put them behind that model's rate limit, so titles failed while
  // ordinary chat worked. The quick slot takes the cheap model whenever it was added.
  it('gives the quick slot to the cheap model, not the default one', async () => {
    const quickIndex = CURATED_MODELS.findIndex(m => m.id === QUICK_CURATED_MODEL_ID)
    const defaultIndex = CURATED_MODELS.findIndex(m => m.id === DEFAULT_CURATED_MODEL_ID)
    expect(quickIndex).toBeGreaterThanOrEqual(0)
    expect(quickIndex).not.toBe(defaultIndex)

    const api = makeApi()
    await render(api)
    await click(checkboxes()[defaultIndex])
    await click(checkboxes()[quickIndex])
    await typeKey('sk-or-v1-secret')
    await click(buttonSaying(/^Add 2 models$/)!)

    expect(api.setQuickModel).toHaveBeenCalledWith(QUICK_CURATED_MODEL_ID)
    // ...while the everyday driver still becomes the model chat actually uses.
    expect(api.setPreferredModel).toHaveBeenCalledWith(DEFAULT_CURATED_MODEL_ID)
  })

  it('marks models the user already has', async () => {
    const api = makeApi()
    await render(api, { configuredModelIds: [CURATED_MODELS[0].id] })
    expect(container.textContent).toContain('Added')
  })

  it('cannot submit without both a selection and a key', async () => {
    const api = makeApi()
    await render(api)
    expect(buttonSaying(/^Add model$/)!.disabled).toBe(true)

    await click(checkboxes()[0])
    expect(buttonSaying(/^Add model$/)!.disabled).toBe(true)

    await typeKey('sk-or-v1-secret')
    expect(buttonSaying(/^Add model$/)!.disabled).toBe(false)
  })

  it('reports a partial failure instead of claiming success', async () => {
    let calls = 0
    const api = makeApi({
      addModel: vi.fn<() => Promise<void>>(
        async () => { if (++calls === 2) throw new Error('connection lost') }),
    })
    await render(api)
    await click(checkboxes()[0])
    await click(checkboxes()[1])
    await typeKey('sk-or-v1-secret')
    await click(buttonSaying(/^Add 2 models$/)!)

    expect(container.textContent).toContain('1 failed')
  })

  it('is hidden in AI Gateway mode, where the deployment supplies credentials', async () => {
    const api = makeApi()
    await render(api, { aiConfig: { enabled: true, enabledProviders: ['openai'] } })
    expect(checkboxes()).toHaveLength(0)
  })
})
