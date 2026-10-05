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

/** Nearest heading or labelled group above this element — "Budget scope". */
function sectionOf(el: Element): string | undefined {
  let node: Element | null = el.parentElement;
  let hops = 0;
  while (node && hops++ < 20) {
    const labelled = node.getAttribute?.("aria-label");
    if (labelled && labelled.trim()) return labelled.trim().slice(0, 512);

    // A fieldset is named by its legend.
    if (node.tagName.toLowerCase() === "fieldset") {
      const legend = node.querySelector("legend");
      const t = legend?.textContent?.replace(/\s+/g, " ").trim();
      if (t) return t.slice(0, 512);
    }

    // Otherwise the nearest preceding heading within this container.
    const heading = node.querySelector("h1,h2,h3,h4,h5,h6,[role='heading']");
    if (heading && heading !== el) {
      const t = heading.textContent?.replace(/\s+/g, " ").trim();
      if (t) return t.slice(0, 512);
    }
    node = node.parentElement;
  }
  return undefined;
}

/** Nearest enclosing landmark — main, dialog, navigation, banner. */
function landmarkOf(el: Element): string | undefined {
  let node: Element | null = el.parentElement;
  let hops = 0;
  while (node && hops++ < 30) {
    const role = resolveRole(node);
    if (LANDMARK_ROLES.has(role)) return role;
    if (node.hasAttribute?.("aria-modal")) return "dialog";
    node = node.parentElement;
  }
  return undefined;
}

/** Ancestor roles, outermost first. Structural disambiguation only. */
function ancestorPath(el: Element): string[] {
  const out: string[] = [];
  let node: Element | null = el.parentElement;
  while (node && out.length < MAX_ANCESTOR_PATH) {
    const role = resolveRole(node);
    if (role !== "generic") out.push(role);
    node = node.parentElement;
  }
  return out.reverse();
}

/**
 * Text near the element, for when role+name is ambiguous (a "Remove" button on
 * every row of a table). Taken from the nearest row/listitem/group ancestor.
 */
function nearbyText(el: Element): string[] | undefined {
  let node: Element | null = el.parentElement;
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
    node = node.parentElement;
  }
  return undefined;
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
  const pool =
    opts.siblings ??
    (el.ownerDocument ? Array.from(el.ownerDocument.querySelectorAll("*")) : []);
  const twins = pool.filter(
    (c) => resolveRole(c) === role && accessibleName(c).name === name,
  );
  if (twins.length > 1) {
    const idx = twins.indexOf(el);
    if (idx >= 0) d.ordinal = idx;
  }

  return d;
}
