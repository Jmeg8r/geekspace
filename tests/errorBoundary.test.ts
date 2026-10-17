// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ErrorBoundary } from "../src/components/common/ErrorBoundary";

// WHAT: one component throwing while rendering shows a fallback instead of unmounting the
// whole window (the 2026-10-17 blank-window bug). See docs/changes/2026-10-17-function-sync/.

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let shouldThrow = true;

function Flaky() {
  if (shouldThrow) throw new Error("ArgumentValidationError: Value does not match validator");
  return createElement("p", null, "page content");
}

function render(onError = vi.fn()) {
  act(() => {
    root.render(
      createElement(ErrorBoundary, {
        onError,
        fallback: (error: Error, reset: () => void) =>
          createElement("div", null, createElement("p", null, `failed: ${error.message}`), createElement("button", { onClick: reset }, "retry")),
        children: createElement(Flaky),
      }),
    );
  });
  return onError;
}

beforeEach(() => {
  shouldThrow = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // React reports caught render errors on console.error; the boundary's job is what we assert.
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("renders the fallback instead of an empty root when a child throws", () => {
    const onError = render();
    expect(container.textContent).toContain("failed: ArgumentValidationError");
    expect(container.innerHTML).not.toBe("");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("reset re-renders the children once the cause is gone", () => {
    render();
    shouldThrow = false;
    act(() => container.querySelector("button")!.click());
    expect(container.textContent).toBe("page content");
  });
});
