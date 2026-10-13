/**
 * The action performer.
 *
 * This is the only code in the system that touches the page on the agent's
 * behalf, and it is deliberately the least clever. It takes a handle, an
 * operation and an already-authorized value, does exactly that one thing, and
 * reports what it observed. It makes no decisions, consults no policy, and
 * knows nothing about why it was asked.
 *
 * Everything upstream can be wrong and recoverable. A mistake here is a real
 * action in someone's real account, so the rule is: do less, verify more.
 */

import { describe } from "@intentlink/a11y";
import type { ElementDescriptor } from "@intentlink/schema";
import type { ActResult, PerformRequest, Verdict } from "../shared/protocol.js";

/** Native setters, so frameworks see a real change rather than a stray event. */
function setNativeValue(el: Element, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else (el as HTMLInputElement).value = value;
}

/**
 * React and friends listen for input/change rather than observing .value, so a
 * value written without these events is invisible to the application even
 * though the DOM shows it. Silent no-ops are the classic browser-automation
 * failure, and the postcondition check downstream would catch it — but it is
 * cheaper to not create the problem.
 */
function fireInputEvents(el: Element): void {
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function isDetached(el: Element): boolean {
  return !el.isConnected;
}

function isDisabled(el: Element): boolean {
  return (
    el.hasAttribute("disabled") ||
    el.getAttribute("aria-disabled") === "true" ||
    (el as HTMLElement).inert === true
  );
}

/**
 * Which DOM operation this element actually supports.
 *
 * Guessing from the verb was wrong in a way that broke a real run:
 * `set_theme` matched a "set_*" rule, was treated as a fill, and called the
 * native <input> value setter on a button - "Illegal invocation", ten times
 * in a row. Setting a theme is a click on an option, not typing.
 *
 * The element in hand already says what can be done to it, so ask it. The
 * verb only breaks ties the role leaves open.
 */
export function operationFor(el: Element, verb: string, value: string | undefined): PerformRequest["op"] {
  const role = (el.getAttribute("role") || "").toLowerCase();
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();

  if (tag === "select") return "select";
  if (role === "combobox" || role === "listbox") {
    // A real <select> takes a value; a composed combobox is opened by click.
    return tag === "select" ? "select" : "click";
  }
  if (role === "switch" || role === "checkbox" || type === "checkbox" || type === "radio") {
    return "toggle";
  }
  if (tag === "textarea" || el.getAttribute("contenteditable") === "true") return "fill";
  if (tag === "input") {
    return ["button", "submit", "reset", "image", "file"].includes(type) ? "click" : "fill";
  }

  // Radios, options, menu items, links, buttons and anything a component app
  // invented: clicking is what a person does to them, whatever the verb said.
  if (value !== undefined && (role === "textbox" || role === "searchbox")) return "fill";
  return "click";
}

export function performAction(
  el: Element | undefined,
  request: PerformRequest,
): ActResult {
  if (!el || isDetached(el)) {
    // The page moved under us between resolve and act. The server-side token
    // binding would reject the follow-up anyway; failing here is just earlier.
    return { ok: false, reason: "element is no longer on the page" };
  }
  if (isDisabled(el)) {
    return { ok: false, reason: "element is disabled" };
  }

  // The caller's op is a proposal; the element decides what is possible.
  const op = operationFor(el, request.verb, request.value);

  try {
    switch (op) {
      case "click": {
        (el as HTMLElement).click();
        break;
      }

      case "toggle": {
        const input = el as HTMLInputElement;
        const already =
          input.checked === true || el.getAttribute("aria-checked") === "true";
        const want = request.value === undefined ? !already : request.value === "true";
        // Click rather than assigning .checked, so the app's own handler runs.
        if (already !== want) (el as HTMLElement).click();
        break;
      }

      case "fill": {
        if (request.value === undefined) {
          return { ok: false, reason: "fill requires a value" };
        }
        if (el.getAttribute("contenteditable") === "true") {
          (el as HTMLElement).focus();
          el.textContent = request.value;
          fireInputEvents(el);
          break;
        }
        (el as HTMLElement).focus();
        setNativeValue(el, request.value);
        fireInputEvents(el);
        break;
      }

      case "select": {
        if (request.value === undefined) {
          return { ok: false, reason: "select requires a value" };
        }
        const select = el as HTMLSelectElement;
        if (!select.options) return { ok: false, reason: "not a select element" };

        const wanted = request.value.trim().toLowerCase();
        const match = Array.from(select.options).find(
          (opt) =>
            opt.value.toLowerCase() === wanted ||
            (opt.textContent ?? "").trim().toLowerCase() === wanted,
        );
        if (!match) {
          return { ok: false, reason: `no option matching "${request.value}"` };
        }
        select.value = match.value;
        fireInputEvents(select);
        break;
      }

      default:
        return { ok: false, reason: `unsupported operation "${op}"` };
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "action threw" };
  }

  // Re-read immediately so the worker can check the postcondition against what
  // the page actually looks like now, not what we intended it to look like.
  return { ok: true, after: safeDescribe(el) };
}

function safeDescribe(el: Element): ElementDescriptor | undefined {
  try {
    return describe(el);
  } catch {
    return undefined;
  }
}

/* -------------------------------- highlight ------------------------------- */

const OVERLAY_ID = "intentlink-overlay-root";

const VERDICT_COLOR: Record<Verdict, string> = {
  ALLOW: "#2dd4a7",
  APPROVAL: "#f5b544",
  DENY: "#ff5c6c",
};

/**
 * Outlines the element the agent is about to touch, and holds briefly before
 * acting. The pause is a safety feature first — a human watching has time to
 * hit abort — and the clearest beat in the demo second.
 *
 * Reading geometry here is fine and is the one place it is: this draws a box
 * on screen, it never identifies an element. Nothing from here reaches a
 * descriptor.
 */
export function highlight(el: Element | null, verdict: Verdict = "ALLOW"): void {
  let root = document.getElementById(OVERLAY_ID);
  if (!el) {
    root?.remove();
    return;
  }

  if (!root) {
    root = document.createElement("div");
    root.id = OVERLAY_ID;
    Object.assign(root.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "2147483647",
    });
    document.documentElement.appendChild(root);
  }
  root.textContent = "";

  const rect = el.getBoundingClientRect();
  const box = document.createElement("div");
  Object.assign(box.style, {
    position: "fixed",
    left: `${rect.left - 2}px`,
    top: `${rect.top - 2}px`,
    width: `${rect.width + 4}px`,
    height: `${rect.height + 4}px`,
    // 1px and precise. A fat glow reads as a toy; precision reads as an
    // instrument, which is the whole visual thesis.
    border: `1px solid ${VERDICT_COLOR[verdict]}`,
    borderRadius: "3px",
    boxShadow: `0 0 0 3px ${VERDICT_COLOR[verdict]}22`,
    transition: "all 120ms ease-out",
  });
  root.appendChild(box);
}

export function clearHighlight(): void {
  document.getElementById(OVERLAY_ID)?.remove();
}
