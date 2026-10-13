/**
 * describe(el) → ElementDescriptor
 *
 * The shared core. The recorder calls this on the element the creator touched;
 * the executor calls it on every candidate it is considering. One function, two
 * directions — which is why the two halves of the product can never drift apart.
 *
 * It must never read geometry. Nothing here touches getBoundingClientRect.
 */

import type { ElementDescriptor } from "@intentlink/schema";
import { accessibleName } from "./accname.js";
import { headingLevel, LANDMARK_ROLES, resolveRole } from "./role.js";

const MAX_ANCESTOR_PATH = 12;
const MAX_NEARBY = 4;

/**
 * Walk up, crossing shadow boundaries.
 *
 * parentElement returns null at the top of a shadow root, so a control inside
 * a web component would report no section and no landmark - it would look
 * context-free even when it sits in a labelled dialog. Stepping onto the host
 * continues the ascent into the document that contains the component.
 */
function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  // Recognised by shape rather than instanceof: a ShadowRoot from an iframe
  // belongs to another realm, where instanceof ShadowRoot is false.
  const host = (el.getRootNode?.() as ShadowRoot | undefined)?.host;
  return host && (host as Node).nodeType === 1 ? host : null;
}

export interface DescribeOptions {
  /** Include the element's current value. Redaction runs separately, upstream. */
  includeValue?: boolean;
  /** Disambiguate against this candidate set rather than the whole document. */
  siblings?: Element[];
}

function isTriState(v: string | null): boolean | "mixed" | undefined {
  if (v === null) return undefined;
  if (v === "mixed") return "mixed";
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6";

function headingText(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase();
  const isHeading = /^h[1-6]$/.test(tag) || el.getAttribute("role") === "heading";
  if (!isHeading) return undefined;
  const text = el.textContent?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 512) : undefined;
}

/**
 * Nearest heading or labelled group above this element — "Budget scope".
 *
 * Deliberately avoids querySelector on each ancestor. The obvious version
 * asked every ancestor for a heading anywhere beneath it, which scans that
 * ancestor's whole SUBTREE - and near the root that is the entire document.
 * Repeated per candidate it is quadratic: a benchmark on a few hundred
 * controls did not finish in five minutes.
 *
 * A heading describing an element precedes it, so looking at preceding
 * siblings at each level finds the same answer in time proportional to the
 * siblings rather than the document.
 */
function sectionOf(el: Element): string | undefined {
  let node: Element | null = parentOf(el);
  let hops = 0;

  while (node && hops++ < 12) {
    const labelled = node.getAttribute?.("aria-label");
    if (labelled && labelled.trim()) return labelled.trim().slice(0, 512);

    // A fieldset is named by its legend, which is its first child by spec.
    if (node.tagName.toLowerCase() === "fieldset") {
      for (const child of Array.from(node.children)) {
        if (child.tagName.toLowerCase() === "legend") {
          const t = child.textContent?.replace(/\s+/g, " ").trim();
          if (t) return t.slice(0, 512);
          break;
        }
      }
    }

    // Headings that precede this subtree, nearest first.
    let sibling: Element | null = node.previousElementSibling;
    let scanned = 0;
    while (sibling && scanned++ < 20) {
      const direct = headingText(sibling);
      if (direct) return direct;
      // A wrapper whose leading content is a heading, e.g. <div><h2>…</h2>…
      const nested = sibling.firstElementChild;
      if (nested) {
        const text = headingText(nested);
        if (text) return text;
      }
      sibling = sibling.previousElementSibling;
    }

    // Or a heading among this container's own leading children.
    for (const child of Array.from(node.children).slice(0, 8)) {
      if (child === el) break;
      const text = headingText(child);
      if (text) return text;
    }

    node = parentOf(node);
  }
  return undefined;
}

/** Nearest enclosing landmark — main, dialog, navigation, banner. */
function landmarkOf(el: Element): string | undefined {
  let node: Element | null = parentOf(el);
  let hops = 0;
  while (node && hops++ < 30) {
    const role = resolveRole(node);
    if (LANDMARK_ROLES.has(role)) return role;
    if (node.hasAttribute?.("aria-modal")) return "dialog";
    node = parentOf(node);
  }
  return undefined;
}

/** Ancestor roles, outermost first. Structural disambiguation only. */
function ancestorPath(el: Element): string[] {
  const out: string[] = [];
  let node: Element | null = parentOf(el);
  while (node && out.length < MAX_ANCESTOR_PATH) {
    const role = resolveRole(node);
    if (role !== "generic") out.push(role);
    node = parentOf(node);
  }
  return out.reverse();
}

/**
 * Text near the element, for when role+name is ambiguous (a "Remove" button on
 * every row of a table). Taken from the nearest row/listitem/group ancestor.
 */
function nearbyText(el: Element): string[] | undefined {
  let node: Element | null = parentOf(el);
  let hops = 0;
  while (node && hops++ < 6) {
    const role = resolveRole(node);
    if (role === "row" || role === "listitem" || role === "group" || role === "cell") {
      const text = node.textContent?.replace(/\s+/g, " ").trim();
      if (text) {
        const own = el.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const rest = own ? text.replace(own, " ").replace(/\s+/g, " ").trim() : text;
        if (rest) {
          return rest
            .split(/\s{2,}|[|•·]/)
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, MAX_NEARBY)
            .map((s) => s.slice(0, 256));
        }
      }
    }
    node = parentOf(node);
  }
  return undefined;
}

/** The nearest grouping ancestor's controls, or nothing. Bounded on purpose. */
function twinPool(el: Element): Element[] {
  let node: Element | null = parentOf(el);
  let hops = 0;
  while (node && hops++ < 6) {
    const role = resolveRole(node);
    if (["table", "list", "rowgroup", "group", "listbox", "menu", "form"].includes(role)) {
      const found = Array.from(node.querySelectorAll("*"));
      // A pathological container is not worth disambiguating within.
      return found.length <= 500 ? found : [];
    }
    node = parentOf(node);
  }
  return [];
}

function valueOf(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") {
    const v = (el as unknown as { value?: string }).value;
    return typeof v === "string" ? v.slice(0, 4096) : undefined;
  }
  if (tag === "select") {
    const sel = el as unknown as { selectedOptions?: ArrayLike<Element>; value?: string };
    const opt = sel.selectedOptions?.[0];
    const label = opt?.textContent?.replace(/\s+/g, " ").trim();
    return (label || sel.value || undefined)?.slice(0, 4096);
  }
  if (el.getAttribute("contenteditable") === "true") {
    return el.textContent?.replace(/\s+/g, " ").trim().slice(0, 4096);
  }
  const valuenow = el.getAttribute("aria-valuenow");
  return valuenow ?? undefined;
}

export function describe(el: Element, opts: DescribeOptions = {}): ElementDescriptor {
  const role = resolveRole(el);
  const { name, source } = accessibleName(el);

  const d: ElementDescriptor = { role, name };

  if (source) d.nameSource = source;

  const section = sectionOf(el);
  if (section) d.section = section;

  const landmark = landmarkOf(el);
  if (landmark) d.landmark = landmark;

  const level = headingLevel(el);
  if (level) d.level = level;

  if (opts.includeValue !== false) {
    const v = valueOf(el);
    if (v !== undefined && v !== "") d.value = v;
  }

  const checked =
    isTriState(el.getAttribute("aria-checked")) ??
    (el.hasAttribute("checked") || (el as unknown as { checked?: boolean }).checked
      ? true
      : undefined);
  if (checked !== undefined) d.checked = checked;

  const expanded = isTriState(el.getAttribute("aria-expanded"));
  if (typeof expanded === "boolean") d.expanded = expanded;

  const selected = isTriState(el.getAttribute("aria-selected"));
  if (typeof selected === "boolean") d.selected = selected;

  if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") {
    d.disabled = true;
  }
  if (el.hasAttribute("required") || el.getAttribute("aria-required") === "true") {
    d.required = true;
  }
  if (el.hasAttribute("readonly") || el.getAttribute("aria-readonly") === "true") {
    d.readonly = true;
  }

  const path = ancestorPath(el);
  if (path.length) d.path = path;

  const nearby = nearbyText(el);
  if (nearby?.length) d.nearby = nearby;

  // Ordinal is identity of last resort: only when role+name alone is ambiguous.
  /*
   * Ordinals are NOT computed here when a pool is supplied.
   *
   * The pool version called accessibleName on every pool member for every
   * candidate, and resolve() passes the whole candidate list as the pool - so
   * n candidates cost n^2 accessible-name computations. On a few hundred
   * controls that was 500ms; on six hundred it was eighty seconds.
   *
   * resolve() has the whole described set in one place and assigns ordinals in
   * a single pass, which is linear. A direct caller with no pool gets the
   * bounded container scan below, since that is a last-resort disambiguator
   * off any hot path.
   */
  if (!opts.siblings) {
    const pool = twinPool(el);
    const twins = pool.filter(
      (c) => resolveRole(c) === role && accessibleName(c).name === name,
    );
    if (twins.length > 1) {
      const idx = twins.indexOf(el);
      if (idx >= 0) d.ordinal = idx;
    }
  }

  return d;
}
