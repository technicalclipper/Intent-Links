/**
 * Content script entry.
 *
 * Wires the recorder and the executor into one page, and holds the only state
 * that must not leave it: the handle→Element map from the last resolve. Handles
 * are page-local and meaningless anywhere else, which is deliberate — the
 * worker can ask for "handle 12" but cannot describe an element it was never
 * offered, and nothing resembling a selector crosses the boundary.
 */

import type { ElementDescriptor } from "@intentlink/schema";
import { installRecorder, pageContext } from "./capture.js";
import { compactTree, resolve, CONFIDENCE_FLOOR } from "./resolve.js";
import { clearHighlight, highlight, performAction } from "./perform.js";
import type { AssertRequest, AssertResult, ContentMessage, WorkerMessage } from "../shared/protocol.js";

const recorder = installRecorder();

/** Valid only until the next resolve; never persisted, never sent upstream. */
let handles = new Map<number, Element>();

function send(message: ContentMessage): void {
  chrome.runtime.sendMessage(message).catch(() => {
    /* worker asleep or restarting */
  });
}

/* ------------------------------- assertions ------------------------------- */

/**
 * Verification by independent read-back. The point is to check what the PAGE
 * says, not what the action returned — a tool call that completes without
 * error is the single most common way browser automation lies.
 */
function checkAssertion(assertion: AssertRequest): AssertResult {
  const hint = assertion.target;
  if (!hint) {
    const text = document.body?.textContent ?? "";
    if (assertion.expect.textContains) {
      const found = text.includes(assertion.expect.textContains);
      return { passed: found, actual: found ? "present" : "absent" };
    }
    return { passed: false, actual: "no target and no text expectation" };
  }

  const { candidates } = resolve([hint as ElementDescriptor], { limit: 1 });
  const best = candidates[0];

  if (assertion.expect.exists !== undefined) {
    const exists = Boolean(best) && best!.confidence >= CONFIDENCE_FLOOR;
    return {
      passed: exists === assertion.expect.exists,
      actual: exists ? "found" : "not found",
    };
  }

  if (!best) return { passed: false, actual: "element not found" };
  const d = best.descriptor;

  if (assertion.expect.valueEquals !== undefined) {
    const actual = d.value ?? "";
    return { passed: actual === assertion.expect.valueEquals, actual };
  }
  if (assertion.expect.checked !== undefined) {
    const actual = d.checked;
    return { passed: actual === assertion.expect.checked, actual: String(actual) };
  }
  if (assertion.expect.textContains !== undefined) {
    const actual = d.name;
    return {
      passed: actual.includes(assertion.expect.textContains),
      actual,
    };
  }

  return { passed: false, actual: "no expectation specified" };
}

/* --------------------------------- routing -------------------------------- */

chrome.runtime.onMessage.addListener((message: WorkerMessage, _sender, respond) => {
  switch (message.type) {
    case "capture:start":
      recorder.start();
      return respond({ ok: true });

    case "capture:stop":
      recorder.stop();
      return respond({ ok: true });

    case "resolve:request": {
      const { candidates, tier, handles: found } = resolve(
        message.hints.map((h) => h as ElementDescriptor),
      );
      handles = found;
      // The compact tree only travels when the deterministic tiers came up
      // short — tier 3 is the expensive path and should stay off the hot one.
      const needsAssist = tier === "none";
      respond({
        candidates,
        page: pageContext(),
        ...(needsAssist ? { tree: compactTree() } : {}),
      });
      return true;
    }

    case "act:request": {
      const el = handles.get(message.action.handle);
      const result = performAction(el, message.action);
      clearHighlight();
      respond(result);
      return true;
    }

    case "assert:request":
      respond(checkAssertion(message.assertion));
      return true;

    case "highlight": {
      if (!message.descriptor) {
        clearHighlight();
        return respond({ ok: true });
      }
      const { candidates, handles: found } = resolve([message.descriptor], { limit: 1 });
      handles = found;
      const best = candidates[0];
      highlight(best ? (found.get(best.handle) ?? null) : null, message.verdict ?? "ALLOW");
      return respond({ ok: true });
    }

    default:
      return respond({ ok: false });
  }
});

// A page that loads while a recording is already running has to opt in itself;
// the worker's broadcast went out before this script existed.
chrome.runtime
  .sendMessage({ type: "content:ready", page: pageContext() } satisfies ContentMessage)
  .then((reply: { recording?: boolean } | undefined) => {
    if (reply?.recording) recorder.start();
  })
  .catch(() => {
    /* worker asleep; it will broadcast capture:start when it wakes */
  });
