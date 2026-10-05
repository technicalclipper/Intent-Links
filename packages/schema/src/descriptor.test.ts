import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ElementDescriptor,
  FORBIDDEN_DESCRIPTOR_FIELDS,
  PageContext,
} from "./descriptor.js";

test("accepts a minimal a11y descriptor", () => {
  const d = ElementDescriptor.parse({ role: "button", name: "Save" });
  assert.equal(d.role, "button");
  assert.equal(d.name, "Save");
});

test("accepts a rich descriptor captured from a real settings page", () => {
  const d = ElementDescriptor.parse({
    role: "switch",
    name: "Allow external invites",
    nameSource: "label",
    section: "Permissions",
    landmark: "main",
    checked: true,
    path: ["main", "form", "group"],
    nearby: ["Workspace settings"],
  });
  assert.equal(d.checked, true);
  assert.deepEqual(d.path, ["main", "form", "group"]);
});

/**
 * The invariant the whole product rests on. If a coordinate or a selector can
 * enter a descriptor, the recorder has silently become a macro recorder and the
 * cross-environment claim is false. Fail loudly at the type boundary instead.
 */
test("rejects every coordinate / selector / DOM-path field", () => {
  for (const field of FORBIDDEN_DESCRIPTOR_FIELDS) {
    const result = ElementDescriptor.safeParse({
      role: "button",
      name: "Save",
      [field]: field === "x" || field === "y" ? 412 : "whatever",
    });
    assert.equal(
      result.success,
      false,
      `descriptor must reject forbidden field "${field}"`,
    );
  }
});

test("rejects unknown fields generally, not just the known-bad list", () => {
  const result = ElementDescriptor.safeParse({
    role: "button",
    name: "Save",
    somethingNew: "sneaking in",
  });
  assert.equal(result.success, false);
});

test("requires a role", () => {
  assert.equal(ElementDescriptor.safeParse({ name: "Save" }).success, false);
});

test("allows an empty accessible name (icon-only controls are real)", () => {
  assert.equal(ElementDescriptor.safeParse({ role: "button", name: "" }).success, true);
});

test("PageContext carries app identity so traces can cross apps", () => {
  const p = PageContext.parse({
    app: "slack",
    origin: "https://acme.slack.com",
    path: "/admin/settings",
    routeTemplate: "/admin/settings",
    title: "Workspace settings",
  });
  assert.equal(p.app, "slack");
});

test("PageContext rejects a non-URL origin", () => {
  assert.equal(
    PageContext.safeParse({ app: "slack", origin: "acme.slack.com", path: "/" }).success,
    false,
  );
});
