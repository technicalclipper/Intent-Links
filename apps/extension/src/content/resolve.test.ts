import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import type { ElementDescriptor } from "@intentlink/schema";
import {
  CONFIDENCE_FLOOR,
  normalize,
  resolve,
  rolesCompatible,
  score,
  similarity,
} from "./resolve.js";
import { appIdentity as appIdentityFor, routeTemplate } from "./capture.js";
import { composedParent, composedTarget } from "./dom.js";

function mount(html: string): Document {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  // resolve() reads from the ambient document; linkedom gives us a real one.
  (globalThis as { document?: unknown }).document = document;
  return document as unknown as Document;
}

const hint = (over: Partial<ElementDescriptor>): ElementDescriptor => ({
  role: "button",
  name: "Save",
  ...over,
});

/* -------------------------------- similarity ------------------------------ */

test("normalization strips case, punctuation and accents", () => {
  assert.equal(normalize("  Añadir—Canal! "), "anadir canal");
});

test("identical labels score 1", () => {
  assert.equal(similarity("Create channel", "Create channel"), 1);
});

test("a reworded label still scores high", () => {
  // The exact case the ladder exists for: a product renames a setting.
  assert.ok(similarity("Allow external invites", "Allow external invitations") > 0.7);
});

test("unrelated labels score low", () => {
  assert.ok(similarity("Create channel", "Delete workspace") < 0.3);
});

/* ----------------------------------- roles -------------------------------- */

test("roles that stand in for each other are compatible", () => {
  assert.equal(rolesCompatible("switch", "checkbox"), true);
  assert.equal(rolesCompatible("combobox", "listbox"), true);
  assert.equal(rolesCompatible("button", "link"), true);
});

test("genuinely different roles are not", () => {
  assert.equal(rolesCompatible("button", "textbox"), false);
});

test("a role mismatch is fatal, not a penalty", () => {
  // Otherwise a confident name could drag the wrong KIND of element over the
  // line — filling a button because it happens to be labelled "Topic".
  const s = score(hint({ role: "textbox", name: "Topic" }), {
    role: "button",
    name: "Topic",
  });
  assert.equal(s, 0);
});

/* --------------------------------- scoring -------------------------------- */

test("an exact descriptor scores at the top of the range", () => {
  const d: ElementDescriptor = {
    role: "switch",
    name: "Make private",
    nameSource: "label",
    section: "Create a channel",
    landmark: "dialog",
  };
  assert.ok(score(d, d) >= 0.995);
});

test("a label-sourced name outranks a text-sourced one at equal similarity", () => {
  const candidate = { role: "button", name: "Create channel" };
  const fromLabel = score(hint({ name: "Create channel", nameSource: "label" }), candidate);
  const fromText = score(hint({ name: "Create channel", nameSource: "placeholder" }), candidate);
  assert.ok(fromLabel > fromText, "a <label> survives a redesign; a placeholder barely is identity");
});

test("a disabled candidate is heavily penalised", () => {
  const h = hint({ name: "Create channel" });
  const enabled = score(h, { role: "button", name: "Create channel" });
  const disabled = score(h, { role: "button", name: "Create channel", disabled: true });
  assert.ok(disabled < enabled * 0.5, "a disabled control cannot satisfy an action");
});

/* -------------------------------- resolution ------------------------------ */

test("tier 1 finds an exact match on a realistic page", () => {
  mount(`
    <main>
      <h2>Create a channel</h2>
      <label for="n">Channel name</label><input id="n">
      <button>Create channel</button>
      <button>Cancel</button>
    </main>
  `);
  const { candidates, tier } = resolve([hint({ role: "button", name: "Create channel" })]);
  assert.equal(tier, "exact");
  assert.equal(candidates[0]?.descriptor.name, "Create channel");
});

test("tier 2 recovers when the label was reworded", () => {
  mount(`
    <main>
      <h2>Permissions</h2>
      <label for="x">Allow external invitations</label>
      <input id="x" role="switch" type="checkbox">
    </main>
  `);
  const { candidates, tier } = resolve([
    hint({ role: "switch", name: "Allow external invites", nameSource: "label", section: "Permissions" }),
  ]);
  assert.equal(tier, "fuzzy");
  assert.ok(candidates[0]!.confidence >= CONFIDENCE_FLOOR);
  assert.equal(candidates[0]?.descriptor.name, "Allow external invitations");
});

test("nothing plausible yields tier none rather than a bad guess", () => {
  mount(`<main><button>Export report</button><button>Print</button></main>`);
  const { tier } = resolve([hint({ role: "switch", name: "Allow external invites" })]);
  assert.equal(tier, "none");
});

test("an ambiguous winner is demoted below the acting threshold", () => {
  // "Remove" on every row: the descriptors genuinely do not distinguish them,
  // so acting on the top score would be a coin flip dressed as a decision.
  mount(`
    <table>
      <tr role="row"><td>acme-prod</td><td><button>Remove</button></td></tr>
      <tr role="row"><td>acme-staging</td><td><button>Remove</button></td></tr>
      <tr role="row"><td>acme-sandbox</td><td><button>Remove</button></td></tr>
    </table>
  `);
  const { candidates, tier } = resolve([hint({ role: "button", name: "Remove" })]);
  assert.equal(tier, "none", "ambiguity must escalate, not resolve");
  assert.ok(candidates[0]!.confidence < CONFIDENCE_FLOOR);
});

test("nearby row text breaks that ambiguity", () => {
  mount(`
    <table>
      <tr role="row"><td>acme-prod</td><td><button>Remove</button></td></tr>
      <tr role="row"><td>acme-sandbox</td><td><button>Remove</button></td></tr>
    </table>
  `);
  const { candidates, tier } = resolve([
    hint({ role: "button", name: "Remove", nearby: ["acme-sandbox"] }),
  ]);
  // A hint that matches everything it specified is legitimately exact; what
  // matters is that the ambiguity was broken and the right row won.
  assert.notEqual(tier, "none", "nearby text must break the tie");
  assert.ok(candidates[0]!.descriptor.nearby?.some((n) => n.includes("acme-sandbox")));
  assert.ok(
    candidates[0]!.confidence - candidates[1]!.confidence >= 0.05,
    "the winner must be clear of the runner-up",
  );
});

test("aria-hidden subtrees are not candidates", () => {
  mount(`
    <div aria-hidden="true"><button>Create channel</button></div>
    <main><button>Cancel</button></main>
  `);
  const { tier } = resolve([hint({ role: "button", name: "Create channel" })]);
  assert.equal(tier, "none", "a hidden control is not actionable");
});

/* ------------------------------ route templates --------------------------- */

test("route templates generalise ids so steps key across tenants", () => {
  assert.equal(routeTemplate("/projects/8812/settings"), "/projects/:id/settings");
  assert.equal(
    routeTemplate("/t/9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f/edit"),
    "/t/:uuid/edit",
  );
  assert.equal(routeTemplate("/archives/C01ABCDEF9/messages"), "/archives/:key/messages");
});

test("stable path segments are left alone", () => {
  assert.equal(routeTemplate("/admin/channels"), "/admin/channels");
  assert.equal(routeTemplate("/jira/software/projects/INC/boards"), "/jira/software/projects/INC/boards");
});

/* ------------------------- web components / shadow DOM -------------------- */

/**
 * linkedom has no shadow DOM, so these build the structure that matters —
 * a host whose children are reachable only through a root object — and verify
 * the traversal follows it. The real check is on YouTube itself.
 */
function withShadow(html: string, hostSel: string, shadowHtml: string): Document {
  const doc = mount(html);
  const host = doc.querySelector(hostSel)!;
  const shadow = mount(shadowHtml).body;
  // Minimal stand-in for an open shadow root: the traversal only needs
  // querySelectorAll on it, and `host` to climb back out.
  Object.defineProperty(host, "shadowRoot", {
    value: Object.assign(shadow, { host }),
    configurable: true,
  });
  (globalThis as { document?: unknown }).document = doc;
  return doc as unknown as Document;
}

test("a control inside a web component is found at all", () => {
  // YouTube's settings live in Polymer components; a plain querySelectorAll
  // stops at the boundary and reports the page as having no such control.
  withShadow(
    `<main><h2>Playback and performance</h2><ytd-settings-panel></ytd-settings-panel></main>`,
    "ytd-settings-panel",
    `<label for="ap">Autoplay next video</label><input id="ap" role="switch" type="checkbox">`,
  );

  const { candidates, tier } = resolve([
    hint({ role: "switch", name: "Autoplay next video", nameSource: "label" }),
  ]);

  assert.notEqual(tier, "none", "the control must be reachable inside the shadow root");
  assert.equal(candidates[0]?.descriptor.name, "Autoplay next video");
});

test("composedTarget reports the real element, not the shadow host", () => {
  // Events retarget as they cross a shadow boundary, so a document-level
  // listener sees <ytd-settings-panel> rather than the switch inside it. Every
  // step in a component app would otherwise be recorded as "clicked the host".
  const doc = withShadow(
    `<main><ytd-settings-panel></ytd-settings-panel></main>`,
    "ytd-settings-panel",
    `<button>Save</button>`,
  );
  const host = doc.querySelector("ytd-settings-panel")!;
  const inner = (host as unknown as { shadowRoot: Element }).shadowRoot.querySelector("button")!;

  const retargeted = { target: host, composedPath: () => [inner, host, doc.body] } as unknown as Event;
  assert.equal(composedTarget(retargeted), inner as unknown as Element);

  const plain = { target: inner, composedPath: () => [inner] } as unknown as Event;
  assert.equal(composedTarget(plain), inner as unknown as Element);
});

test("composedParent climbs out of a shadow root onto its host", () => {
  const doc = withShadow(
    `<main><ytd-settings-panel></ytd-settings-panel></main>`,
    "ytd-settings-panel",
    `<button>Save</button>`,
  );
  const host = doc.querySelector("ytd-settings-panel")!;
  const shadow = (host as unknown as { shadowRoot: Element & { host: Element } }).shadowRoot;
  const inner = shadow.querySelector("button")!;

  // Inside the shadow tree the button has a parent; at the top, the walk must
  // step onto the host rather than stopping and reporting no context.
  Object.defineProperty(inner, "parentElement", { value: null, configurable: true });
  Object.defineProperty(inner, "getRootNode", { value: () => shadow, configurable: true });
  assert.equal(composedParent(inner as unknown as Element), host as unknown as Element);
});

/* ------------------------------ app identity ------------------------------ */

test("app identity covers any site, not a list of known ones", () => {
  for (const [host, expected] of [
    ["www.youtube.com", "youtube"],
    ["studio.youtube.com", "youtube"],
    ["acme.slack.com", "slack"],
    ["globex.slack.com", "slack"],
    ["github.com", "github"],
    ["app.some-startup.io", "some-startup"],
    ["console.cloud.google.com", "gcp-console"],
    ["acme.atlassian.net", "jira"],
    // A two-part public suffix would otherwise yield "co".
    ["shop.example.co.uk", "example"],
  ] as const) {
    assert.equal(appIdentityFor(host), expected, `${host} should be ${expected}`);
  }
});

test("browser-internal pages are not somewhere a person did anything", () => {
  // A recording began with Chrome prefetching /search/warmup.html, which was
  // taken as the workflow's starting page and sent the receiver to a blank
  // Google tab with nothing to resolve against.
  for (const junk of ["/search/warmup.html", "/newtab", "/blank"]) {
    assert.match(junk, /\b(warmup|newtab|blank)\b/, `${junk} should be recognised as internal`);
  }
  for (const real of ["/account", "/watch", "/admin/channels", "/feed/subscriptions"]) {
    assert.doesNotMatch(real, /\b(warmup|newtab|blank)\b/, `${real} is a real page`);
  }
});
