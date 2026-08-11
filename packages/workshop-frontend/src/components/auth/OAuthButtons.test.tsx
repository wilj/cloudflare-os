// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// Sign-in failures, and how they are reported.
//
// The case that motivated this: a first sign-in from a mobile device shows the provider's consent
// screen, which keeps the pop-up in front long enough for the browser to freeze the original tab
// and close its WebSocket. The gatekeeper completes and the server logs a successful login, but the
// token travels over `attempt.wait()`, so the client never receives it. Reporting the raw transport
// error ("Peer closed WebSocket: 1006") tells the user their credentials were rejected, which is
// both wrong and unactionable.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RpcStub } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import OAuthButtons from "./OAuthButtons";

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const VENDORS = [{ vendorId: "forgejo", displayName: "Forgejo" }] as never;

// Stands in for the whole RPC session: the login attempt rejects with `err`.
function stubRejecting(err: unknown): RpcStub<PublicApi> {
  return {
    startGatekeeperLogin: async () => ({
      url: "https://forge.example/authorize",
      attempt: { wait: () => Promise.reject(err), [Symbol.dispose]: () => {} },
    }),
  } as unknown as RpcStub<PublicApi>;
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function mount(stub: RpcStub<PublicApi>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<OAuthButtons rpcStub={stub} vendors={VENDORS} />);
  });
  return container;
}

function signInButton(): HTMLButtonElement {
  const button = Array.from(container!.querySelectorAll("button"))
      .find(b => (b.textContent ?? "").includes("Continue with Forgejo"));
  if (!button) throw new Error("sign-in button not rendered");
  return button as HTMLButtonElement;
}

// Clicking starts an async chain; flushing once more lets its rejection settle into state.
async function clickAndSettle(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {});
}

const shownText = () => container!.textContent ?? "";

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

const popupOpens = () =>
    vi.spyOn(window, "open").mockReturnValue({ closed: false, close: () => {} } as never);

describe("sign-in failures", () => {
  it("reports a dropped connection as interrupted, not as a failed sign-in", async () => {
    popupOpens();
    await mount(stubRejecting(new Error("Peer closed WebSocket: 1006 ")));
    await clickAndSettle(signInButton());

    expect(shownText()).toContain("Lost the connection while signing in");
    // The transport detail is what made this read as a credentials problem.
    expect(shownText()).not.toContain("1006");
    expect(shownText()).not.toContain("WebSocket");
  });

  it("still shows a real sign-in error verbatim", async () => {
    // Connection errors are the exception, not a blanket suppression: an actual refusal has to keep
    // saying what went wrong.
    popupOpens();
    await mount(stubRejecting(new Error("Account is not permitted to sign in")));
    await clickAndSettle(signInButton());

    expect(shownText()).toContain("Account is not permitted to sign in");
  });

  it("still reports a blocked pop-up, which is the user's to fix", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    await mount(stubRejecting(new Error("never reached")));
    await clickAndSettle(signInButton());

    expect(shownText()).toContain("Pop-up blocked");
  });

  it("leaves the button usable, so the retry it advises is possible", async () => {
    // Retrying is the whole remedy: consent is already granted by then, so the second attempt is
    // quick enough that the tab is never frozen. A button stuck loading would strand the user on
    // advice they cannot follow.
    popupOpens();
    await mount(stubRejecting(new Error("Peer closed WebSocket: 1006 ")));
    const button = signInButton();
    await clickAndSettle(button);

    expect(shownText()).toContain("Lost the connection while signing in");
    expect(signInButton().disabled).toBe(false);
  });
});
