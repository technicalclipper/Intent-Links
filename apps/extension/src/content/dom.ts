/**
 * DOM traversal that sees the whole page.
 *
 * Modern apps hide most of their controls inside shadow roots - YouTube is
 * built on Polymer web components, and so are large parts of Chrome's own
 * surfaces - and neither `querySelectorAll` nor a document-level event target
 * crosses that boundary on its own.
 *
 * Both halves of the product depend on getting this right:
 *
 *   recording  - events RETARGET as they cross a shadow boundary, so a listener
 *                on `document` sees the shadow HOST, not the button the person
 *                actually clicked. Every step inside a web component would be
 *                recorded as "clicked <ytd-settings-panel>".
 *   executing  - querySelectorAll stops at the shadow boundary, so the resolver
 *                would simply not see the control it is looking for and report
 *                that nothing on the page could satisfy the step.
 */

/**
 * Duck-typed element check.
 *
 * `instanceof Element` compares against the constructor of ONE realm, so it
 * returns false for a perfectly good element that came from an iframe - and
 * iframes are exactly where a composed path leads. nodeType is the same in
 * every realm.
 */
function isElement(node: unknown): node is Element {
  return (
    typeof node === "object" &&
    node !== null &&
    (node as Node).nodeType === 1
  );
}

/** Guard: elements that expose an open shadow root. */
function shadowRootOf(el: Element): ShadowRoot | null {
  // Closed roots are deliberately unreachable; nothing can be done about those
  // and pretending otherwise would be worse than reporting the element missing.
  return (el as Element & { shadowRoot: ShadowRoot | null }).shadowRoot ?? null;
}

/**
 * querySelectorAll that descends into open shadow roots.
 *
 * Depth-bounded because component trees nest deeply and a pathological page
 * should degrade to "found less" rather than hanging the content script.
 */
export function deepQueryAll(
  selector: string,
  root: ParentNode = document,
  maxDepth = 12,
): Element[] {
  const found: Element[] = [];
  const seen = new Set<ParentNode>();

  const walk = (node: ParentNode, depth: number): void => {
    if (depth > maxDepth || seen.has(node)) return;
    seen.add(node);

    for (const el of Array.from(node.querySelectorAll(selector))) {
      found.push(el);
    }

    // Any element in this scope may host its own tree.
    for (const el of Array.from(node.querySelectorAll("*"))) {
      const shadow = shadowRootOf(el);
      if (shadow) walk(shadow, depth + 1);
    }
  };

  walk(root, 0);
  return found;
}

/**
 * The element a person actually interacted with.
 *
 * `event.target` is retargeted to the nearest ancestor in the listener's own
 * tree, so inside a web component it names the host. composedPath() keeps the
 * original chain, and its first entry is the real element.
 */
export function composedTarget(event: Event): Element | null {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  for (const node of path) {
    if (isElement(node)) return node;
  }
  return isElement(event.target) ? event.target : null;
}

/**
 * Walk up from an element through shadow boundaries.
 *
 * parentElement stops at a shadow root, so a plain upward walk cannot find the
 * dialog or landmark a control sits inside when that control lives in a
 * component. Stepping onto the host continues the ascent.
 */
export function composedParent(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  // Likewise duck-typed: a ShadowRoot is recognised by having a host, which
  // holds across realms where instanceof does not.
  const root = el.getRootNode?.();
  const host = (root as ShadowRoot | undefined)?.host;
  return isElement(host) ? host : null;
}
