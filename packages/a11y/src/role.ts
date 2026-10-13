/**
 * Role resolution: explicit ARIA role, else the implicit role from the tag.
 *
 * Deliberately a lookup table rather than a full ARIA-in-HTML implementation.
 * It covers the controls real workflows touch; anything unmapped falls back to
 * "generic", and resolution then leans on name + section + structure instead.
 */

const INPUT_TYPE_ROLES: Record<string, string> = {
  button: "button",
  submit: "button",
  reset: "button",
  image: "button",
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  number: "spinbutton",
  search: "searchbox",
  email: "textbox",
  tel: "textbox",
  text: "textbox",
  url: "textbox",
  password: "textbox",
  date: "textbox",
  "datetime-local": "textbox",
  month: "textbox",
  week: "textbox",
  time: "textbox",
  file: "button",
  color: "textbox",
};

const TAG_ROLES: Record<string, string> = {
  a: "link",
  area: "link",
  article: "article",
  aside: "complementary",
  button: "button",
  datalist: "listbox",
  dd: "definition",
  details: "group",
  dialog: "dialog",
  dt: "term",
  fieldset: "group",
  figure: "figure",
  footer: "contentinfo",
  form: "form",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  header: "banner",
  hr: "separator",
  img: "img",
  li: "listitem",
  main: "main",
  menu: "list",
  nav: "navigation",
  ol: "list",
  option: "option",
  output: "status",
  p: "paragraph",
  progress: "progressbar",
  section: "region",
  select: "combobox",
  summary: "button",
  table: "table",
  tbody: "rowgroup",
  td: "cell",
  textarea: "textbox",
  tfoot: "rowgroup",
  th: "columnheader",
  thead: "rowgroup",
  tr: "row",
  ul: "list",
};

export const LANDMARK_ROLES = new Set([
  "banner", "complementary", "contentinfo", "form", "main",
  "navigation", "region", "search", "dialog", "alertdialog",
]);

/**
 * Roles that explicitly remove an element from the accessibility tree.
 *
 * YouTube and other component-heavy apps wrap real controls in these, and a
 * recording that captured the wrapper produced a descriptor nothing could
 * ever resolve: role "none", with the right name, matching no control.
 */
export const PRESENTATIONAL_ROLES = new Set(["none", "presentation"]);

export function resolveRole(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) {
    const first = explicit.trim().split(/\s+/)[0]?.toLowerCase();
    // Fall through to the implicit role: a presentational wrapper around a
    // button is still, structurally, whatever its tag says it is.
    if (first && !PRESENTATIONAL_ROLES.has(first)) return first;
  }

  const tag = el.tagName.toLowerCase();

  if (tag === "input") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return INPUT_TYPE_ROLES[type] ?? "textbox";
  }

  // <a> is only a link when it has an href; otherwise it is generic.
  if (tag === "a" || tag === "area") {
    return el.hasAttribute("href") ? "link" : "generic";
  }

  // A select with multiple/size renders as a listbox, not a combobox.
  if (tag === "select") {
    const size = Number(el.getAttribute("size") || "0");
    return el.hasAttribute("multiple") || size > 1 ? "listbox" : "combobox";
  }

  return TAG_ROLES[tag] ?? "generic";
}

/** Heading level, for descriptors that are or sit under a heading. */
export function headingLevel(el: Element): number | undefined {
  const aria = el.getAttribute("aria-level");
  if (aria && /^\d+$/.test(aria)) {
    const n = Number(aria);
    if (n >= 1 && n <= 6) return n;
  }
  const m = /^h([1-6])$/i.exec(el.tagName);
  return m && m[1] ? Number(m[1]) : undefined;
}
