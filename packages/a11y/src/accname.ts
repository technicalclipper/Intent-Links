/**
 * Accessible name computation.
 *
 * A pragmatic subset of the accname spec, in the spec's own precedence order.
 * The name is the PRIMARY IDENTITY of an element in IntentLink — it is what a
 * recorded step is matched against on a different tenant, a different UI
 * version, or a different locale — so the source of the name is reported too,
 * and resolution weights a label-derived name above a text-derived one.
 */

import type { NameSource } from "@intentlink/schema";

export interface AccName {
  name: string;
  source?: NameSource;
}

const MAX_NAME = 512;

function clean(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

function textOf(el: Element): string {
  // textContent, not innerText: no layout dependency, so the same markup gives
  // the same name in a background tab as in a visible one.
  return clean(el.textContent);
}

function idRefs(el: Element, attr: string): Element[] {
  const raw = el.getAttribute(attr);
  if (!raw) return [];
  const doc = el.ownerDocument;
  if (!doc) return [];
  const out: Element[] = [];
  for (const id of raw.trim().split(/\s+/)) {
    const node = doc.getElementById(id);
    if (node) out.push(node);
  }
  return out;
}

/** Labels pointing at this control, via `for=` or by wrapping it. */
function labelsFor(el: Element): Element[] {
  const out: Element[] = [];
  const id = el.getAttribute("id");
  const doc = el.ownerDocument;
  if (id && doc) {
    out.push(
      ...Array.from(doc.querySelectorAll(`label[for="${CSS_escape(id)}"]`)),
    );
  }
  let p: Element | null = el.parentElement;
  while (p) {
    if (p.tagName.toLowerCase() === "label") {
      out.push(p);
      break;
    }
    p = p.parentElement;
  }
  return out;
}

/** Minimal CSS.escape — attribute selectors only need quotes handled. */
function CSS_escape(v: string): string {
  return v.replace(/["\\]/g, "\\$&");
}

export function accessibleName(el: Element): AccName {
  // 1. aria-labelledby
  const refs = idRefs(el, "aria-labelledby");
  if (refs.length) {
    const name = clean(refs.map(textOf).join(" "));
    if (name) return { name, source: "aria-labelledby" };
  }

  // 2. aria-label
  const ariaLabel = clean(el.getAttribute("aria-label"));
  if (ariaLabel) return { name: ariaLabel, source: "aria-label" };

  // 3. <label for> / wrapping <label>
  const labels = labelsFor(el);
  if (labels.length) {
    // A wrapping label includes the control's own text; strip it so a checkbox
    // inside <label>Enabled</label> is named "Enabled", not "Enabled Enabled".
    const own = textOf(el);
    const text = clean(
      labels
        .map((l) => {
          const t = textOf(l);
          return own && t.endsWith(own) ? t.slice(0, -own.length) : t;
        })
        .join(" "),
    );
    if (text) return { name: text, source: "label" };
  }

  const tag = el.tagName.toLowerCase();

  // 4. alt, for images
  if (tag === "img" || (tag === "input" && el.getAttribute("type") === "image")) {
    const alt = clean(el.getAttribute("alt"));
    if (alt) return { name: alt, source: "alt" };
  }

  // 5. Content, for roles named by their contents
  const text = textOf(el);
  if (text && tag !== "input" && tag !== "textarea" && tag !== "select") {
    return { name: text, source: "text" };
  }

  // 6. value, for push buttons
  if (tag === "input") {
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "button" || type === "submit" || type === "reset") {
      const v = clean(el.getAttribute("value"));
      if (v) return { name: v, source: "value" };
    }
  }

  // 7. placeholder — weak, but common on search fields with no visible label
  const placeholder = clean(el.getAttribute("placeholder"));
  if (placeholder) return { name: placeholder, source: "placeholder" };

  // 8. title — last resort
  const title = clean(el.getAttribute("title"));
  if (title) return { name: title, source: "title" };

  return { name: "" };
}

/**
 * How much to trust a name when matching. A label survives a redesign; raw
 * text content often doesn't, and a placeholder is barely identity at all.
 */
export const NAME_SOURCE_WEIGHT: Record<string, number> = {
  "aria-labelledby": 1.0,
  "aria-label": 1.0,
  label: 1.0,
  alt: 0.9,
  text: 0.8,
  value: 0.8,
  title: 0.6,
  placeholder: 0.5,
};
