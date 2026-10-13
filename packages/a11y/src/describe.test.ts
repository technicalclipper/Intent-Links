import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { ElementDescriptor } from "@intentlink/schema";
import { describe as describeEl } from "./describe.js";
import { resolveRole } from "./role.js";
import { accessibleName } from "./accname.js";

function dom(html: string) {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return document;
}
const pick = (html: string, sel: string) => {
  const el = dom(html).querySelector(sel);
  assert.ok(el, `selector ${sel} matched nothing`);
  return el as unknown as Element;
};

/* ---------------------------------- roles --------------------------------- */

test("resolves implicit roles for the controls workflows touch", () => {
  assert.equal(resolveRole(pick(`<button>Go</button>`, "button")), "button");
  assert.equal(resolveRole(pick(`<input type="checkbox">`, "input")), "checkbox");
  assert.equal(resolveRole(pick(`<input type="email">`, "input")), "textbox");
  assert.equal(resolveRole(pick(`<textarea></textarea>`, "textarea")), "textbox");
  assert.equal(resolveRole(pick(`<select></select>`, "select")), "combobox");
  assert.equal(resolveRole(pick(`<select multiple></select>`, "select")), "listbox");
});

test("an anchor without href is not a link", () => {
  assert.equal(resolveRole(pick(`<a href="/x">x</a>`, "a")), "link");
  assert.equal(resolveRole(pick(`<a>x</a>`, "a")), "generic");
});

test("explicit role wins over the tag", () => {
  assert.equal(resolveRole(pick(`<div role="switch">x</div>`, "div")), "switch");
});

/* ------------------------------ accessible name --------------------------- */

test("name precedence follows the spec order", () => {
  const byLabelledby = pick(
    `<span id="t">Billing</span><input aria-labelledby="t" aria-label="ignored">`,
    "input",
  );
  assert.deepEqual(accessibleName(byLabelledby), {
    name: "Billing",
    source: "aria-labelledby",
  });

  const byAriaLabel = pick(`<input aria-label="Budget amount">`, "input");
  assert.equal(accessibleName(byAriaLabel).source, "aria-label");

  const byLabelFor = pick(
    `<label for="a">Channel name</label><input id="a">`,
    "input",
  );
  assert.deepEqual(accessibleName(byLabelFor), {
    name: "Channel name",
    source: "label",
  });

  const byText = pick(`<button>Create channel</button>`, "button");
  assert.deepEqual(accessibleName(byText), {
    name: "Create channel",
    source: "text",
  });

  const byPlaceholder = pick(`<input placeholder="Search">`, "input");
  assert.equal(accessibleName(byPlaceholder).source, "placeholder");
});

test("a wrapping label does not duplicate the control's own text", () => {
  const el = pick(`<label>Make private<input type="checkbox"></label>`, "input");
  assert.equal(accessibleName(el).name, "Make private");
});

/* -------------------------------- descriptors ----------------------------- */

test("describes a real-shaped settings toggle", () => {
  const el = pick(
    `<main>
       <h2>Permissions</h2>
       <div role="group">
         <label for="ext">Allow external invites</label>
         <input id="ext" role="switch" type="checkbox" aria-checked="true">
       </div>
     </main>`,
    "#ext",
  );
  const d = ElementDescriptor.parse(describeEl(el));
  assert.equal(d.role, "switch");
  assert.equal(d.name, "Allow external invites");
  assert.equal(d.nameSource, "label");
  assert.equal(d.section, "Permissions");
  assert.equal(d.landmark, "main");
  assert.equal(d.checked, true);
});

test("describes a required field inside a modal, with its section", () => {
  const el = pick(
    `<div role="dialog" aria-modal="true">
       <fieldset><legend>Create a channel</legend>
         <label for="n">Channel name</label>
         <input id="n" required value="inc-payments">
       </fieldset>
     </div>`,
    "#n",
  );
  const d = ElementDescriptor.parse(describeEl(el));
  assert.equal(d.section, "Create a channel");
  assert.equal(d.landmark, "dialog");
  assert.equal(d.required, true);
  assert.equal(d.value, "inc-payments");
});

test("value can be withheld at the call site (redaction happens upstream)", () => {
  const el = pick(`<input aria-label="API token" value="test-token-placeholder">`, "input");
  const d = describeEl(el, { includeValue: false });
  assert.equal(d.value, undefined);
});

/* ------------------------- the invariants that matter --------------------- */

test("a descriptor is always schema-valid, so no geometry can leak in", () => {
  const el = pick(`<button class="btn-primary" style="left:412px">Save</button>`, "button");
  const d = describeEl(el);
  assert.doesNotThrow(() => ElementDescriptor.parse(d));
  assert.equal(JSON.stringify(d).includes("412"), false);
});

test("describing the same element twice is byte-identical", () => {
  const html = `<main><h3>Budget scope</h3><label for="b">Budget amount</label><input id="b" value="5000"></main>`;
  const a = describeEl(pick(html, "#b"));
  const b = describeEl(pick(html, "#b"));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("ordinal appears only when role+name is genuinely ambiguous", () => {
  const unique = pick(`<button>Save</button><button>Cancel</button>`, "button");
  assert.equal(describeEl(unique).ordinal, undefined);

  const doc = dom(
    `<table>
       <tr role="row"><td>acme-prod</td><td><button>Remove</button></td></tr>
       <tr role="row"><td>acme-sandbox</td><td><button>Remove</button></td></tr>
     </table>`,
  );
  const removes = Array.from(doc.querySelectorAll("button")) as unknown as Element[];
  const second = describeEl(removes[1]!);
  assert.equal(second.ordinal, 1);
  // ...and nearby text gives resolution something better than the ordinal.
  assert.ok(second.nearby?.some((n) => n.includes("acme-sandbox")));
});

test("a presentational wrapper reports its structural role, not none", () => {
  // YouTube wraps real controls in role="none". A descriptor of
  // role "none" with the right name matches no control anywhere, so the
  // recorded step could never be resolved.
  const el = pick(`<div role="none"><span>Light theme</span></div>`, "div");
  assert.notEqual(describeEl(el).role, "none");

  const button = pick(`<button role="presentation">Light theme</button>`, "button");
  assert.equal(describeEl(button).role, "button");
});
