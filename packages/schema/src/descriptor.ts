import { z } from "zod";

/**
 * ElementDescriptor — the keystone of IntentLink.
 *
 * A coordinate-free, selector-free description of a UI element, derived from
 * the accessibility tree that every browser already computes. The SAME shape is
 * produced by the recorder (describing what the creator touched) and consumed
 * by the executor (describing candidates to resolve against). That symmetry is
 * why recording and execution share one core module, and why the product works
 * on any web app with zero per-app integration.
 *
 * INVARIANT: this type carries no x/y, no CSS selector, no XPath, no DOM path.
 * The schema is `.strict()` so such fields are rejected at the boundary rather
 * than quietly tolerated. Enforced by descriptor.test.ts.
 */

export const NameSource = z.enum([
  "aria-label",
  "aria-labelledby",
  "label",
  "text",
  "title",
  "placeholder",
  "alt",
  "value",
]);
export type NameSource = z.infer<typeof NameSource>;

export const TriState = z.union([z.boolean(), z.literal("mixed")]);

export const ElementDescriptor = z
  .object({
    /** Computed ARIA role, e.g. "button", "textbox", "switch", "link". */
    role: z.string().min(1).max(64),

    /** Computed accessible name. The primary identity of the element. */
    name: z.string().max(512),

    /** Where the accessible name came from — weights fuzzy matching. */
    nameSource: NameSource.optional(),

    /** Nearest enclosing heading or group label, e.g. "Budget scope". */
    section: z.string().max(512).optional(),

    /** Nearest landmark: main, navigation, dialog, form, banner... */
    landmark: z.string().max(64).optional(),

    /** Heading level, when the element is or sits under a heading. */
    level: z.number().int().min(1).max(6).optional(),

    /** Current value for inputs. Always passed through redaction first. */
    value: z.string().max(4096).optional(),

    checked: TriState.optional(),
    expanded: z.boolean().optional(),
    selected: z.boolean().optional(),
    disabled: z.boolean().optional(),
    required: z.boolean().optional(),
    readonly: z.boolean().optional(),

    /**
     * Disambiguation only, never identity. When several elements share the
     * same role+name (table rows, list items), the 0-based index among them.
     * Resolution prefers richer signals and falls back to ordinal last.
     */
    ordinal: z.number().int().min(0).optional(),

    /** Nearby text used to disambiguate otherwise identical descriptors. */
    nearby: z.array(z.string().max(256)).max(8).optional(),

    /** Ancestor roles, outermost first, for structural disambiguation. */
    path: z.array(z.string().max(64)).max(12).optional(),
  })
  .strict();

export type ElementDescriptor = z.infer<typeof ElementDescriptor>;

/**
 * Fields that must never appear in a descriptor. Kept as data so the guard in
 * descriptor.test.ts and the API boundary can both assert against one list.
 */
export const FORBIDDEN_DESCRIPTOR_FIELDS = [
  "x",
  "y",
  "top",
  "left",
  "width",
  "height",
  "bounds",
  "rect",
  "selector",
  "cssSelector",
  "xpath",
  "domPath",
  "nodeId",
  "elementId",
  "innerHTML",
  "outerHTML",
] as const;

/** Page the descriptor was captured on / is being resolved against. */
export const PageContext = z
  .object({
    /** Stable app identity: "slack", "jira", "gcp-console", else hostname. */
    app: z.string().min(1).max(64),
    origin: z.string().url().max(512),
    path: z.string().max(2048),
    /** Generalized path with ids replaced: /projects/:id/settings */
    routeTemplate: z.string().max(2048).optional(),
    title: z.string().max(512).optional(),
    lang: z.string().max(16).optional(),
  })
  .strict();

export type PageContext = z.infer<typeof PageContext>;
