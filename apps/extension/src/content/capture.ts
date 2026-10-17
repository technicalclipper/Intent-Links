/**
 * Capture — the recorder half of the shared core.
 *
 * Listens to what the creator does and emits a11y descriptors. It never reads
 * geometry, never builds a selector, and never persists a value that redaction
 * flagged. The descriptors it emits are the same shape the executor later
 * resolves against, which is why recording and execution cannot drift apart.
 */

import { describe } from "@intentlink/a11y";
import type { PageContext, TraceEvent, TraceEventType } from "@intentlink/schema";
import { redactValue } from "../shared/redact.js";
import type { ContentMessage } from "../shared/protocol.js";
import { composedParent, composedTarget } from "./dom.js";

type Emit = (event: Omit<TraceEvent, "seq">) => void;

/** Host → stable app identity, so one trace can span several products. */
export function appIdentity(host: string): string {
  const h = host.toLowerCase();

  /*
   * Only the cases where the hostname is genuinely misleading. The fallback
   * below handles everything else correctly, and a product that claims to
   * work on any web app should not carry a list it has to be taught.
   */
  if (h === "console.cloud.google.com") return "gcp-console";
  if (h.endsWith(".atlassian.net") || h.endsWith(".atlassian.com")) return "jira";

  /*
   * On some hosts the subdomain IS the product, not the tenant.
   *
   * Collapsing to the registrable label makes acme.slack.com and
   * globex.slack.com one app, which is right. It also made mail.google.com
   * and www.google.com one app, which is not: a recording that began with a
   * Google search and ended in Gmail looked like one application throughout.
   */
  if (h.endsWith(".google.com")) {
    const product = h.slice(0, -".google.com".length).split(".").pop();
    if (product && product !== "www") return product;
  }

  // Otherwise the registrable label, so acme.slack.com and globex.slack.com
  // are one app, and studio.youtube.com and www.youtube.com are both
  // "youtube".
  const parts = h.split(".").filter(Boolean);
  if (parts.length < 2) return h;

  // Two-part public suffixes (.co.uk, .com.au) would otherwise yield "co".
  const last = parts[parts.length - 1]!;
  const secondLast = parts[parts.length - 2]!;
  const isCompoundSuffix =
    parts.length >= 3 && ["co", "com", "net", "org", "gov", "ac"].includes(secondLast) && last.length === 2;

  return isCompoundSuffix ? parts[parts.length - 3]! : secondLast;
}

/**
 * Replace anything that looks like an identifier with a placeholder, so routes
 * generalize across tenants and records. /projects/8812/settings becomes
 * /projects/:id/settings, which is what a recorded step should be keyed on.
 */
export function routeTemplate(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      if (/^\d+$/.test(segment)) return ":id";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
        return ":uuid";
      }
      if (/^[0-9a-f]{16,}$/i.test(segment)) return ":hash";
      // Mixed alphanumerics of real length are usually ids too (C01ABCDEF).
      if (segment.length >= 8 && /\d/.test(segment) && /[A-Za-z]/.test(segment)) return ":key";
      return segment;
    })
    .join("/");
}

export function pageContext(): PageContext {
  const ctx: PageContext = {
    app: appIdentity(location.hostname),
    origin: location.origin,
    path: location.pathname,
  };
  const template = routeTemplate(location.pathname);
  if (template !== location.pathname) ctx.routeTemplate = template;
  if (document.title) ctx.title = document.title.slice(0, 512);
  const lang = document.documentElement.getAttribute("lang");
  if (lang) ctx.lang = lang.slice(0, 16);
  return ctx;
}

/** Controls whose change is the interesting event, not their keystrokes. */
function isToggleLike(el: Element): boolean {
  const role = el.getAttribute("role");
  if (role === "switch" || role === "checkbox" || role === "radio") return true;
  const tag = el.tagName.toLowerCase();
  if (tag !== "input") return false;
  const type = (el.getAttribute("type") || "").toLowerCase();
  return type === "checkbox" || type === "radio";
}

function opFor(el: Element): TraceEventType {
  if (isToggleLike(el)) return "toggle";
  const tag = el.tagName.toLowerCase();
  if (tag === "select") return "select";
  if (tag === "textarea") return "fill";
  if (tag === "input") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return ["button", "submit", "reset", "image", "file"].includes(type) ? "click" : "fill";
  }
  if (el.getAttribute("contenteditable") === "true") return "fill";
  return "click";
}

/**
 * The element a human would say they interacted with. A click usually lands on
 * an inner span or svg; the meaningful target is the nearest ancestor that
 * carries a real role and an accessible name.
 */
/** Page regions. Real controls live inside them; they are never the target. */
const CONTAINER_ROLES = new Set([
  "search",
  "navigation",
  "main",
  "banner",
  "contentinfo",
  "complementary",
  "region",
  "form",
  "group",
  "list",
  "toolbar",
  "menubar",
  "tablist",
  "dialog",
  "document",
  "application",
]);

function interactiveAncestor(start: Element | null): Element | null {
  let node: Element | null = start;
  let hops = 0;
  while (node && hops++ < 12) {
    const role = node.getAttribute("role")?.trim().toLowerCase();
    const tag = node.tagName.toLowerCase();
    /*
     * Roles that are containers, not controls.
     *
     * "none" and "presentation" mean the author took the element out of the
     * accessibility tree. Landmarks mean it is a REGION of the page. Either
     * way it is not the thing a person clicked, and capturing it produces a
     * descriptor that cannot be acted on: a recording of YouTube's search box
     * captured role="search" - the landmark wrapping the input - and the
     * executor clicked the region instead of typing in the field.
     */
    const container =
      role === "none" ||
      role === "presentation" ||
      CONTAINER_ROLES.has(role ?? "");
    const interactive =
      (role && !container) ||
      ["a", "button", "input", "select", "textarea", "summary", "label"].includes(tag) ||
      node.hasAttribute("tabindex") ||
      node.getAttribute("contenteditable") === "true";
    if (interactive) return node;
    node = composedParent(node);
  }
  return start;
}

export class Recorder {
  private readonly emit: Emit;
  private readonly startedAt: number;
  private active = false;

  /**
   * Last value per field, so we emit on commit rather than per key. A Map,
   * not a WeakMap, because a click elsewhere has to find and commit it.
   */
  private readonly pending = new Map<Element, string>();
  /** Fields whose typing a click already committed (see commitOthers). */
  private readonly committedByClick = new WeakSet<Element>();
  private lastRoute = "";

  constructor(emit: Emit, now: number = Date.now()) {
    this.emit = emit;
    this.startedAt = now;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    document.addEventListener("click", this.onClick, true);
    document.addEventListener("change", this.onChange, true);
    /*
     * `input` as well as `change`, because contenteditable never fires
     * `change` at all. Gmail's message body and recipient field are
     * contenteditable, so a whole email could be typed and the recording kept
     * only the clicks around it - the receiver then had a step for clicking an
     * autocomplete suggestion that does not exist until something is typed.
     *
     * It fires per keystroke, which is fine: only the latest value is held,
     * and it is committed on blur or Enter like any other field.
     */
    document.addEventListener("input", this.onInput, true);
    document.addEventListener("focusout", this.onFocusOut, true);
    document.addEventListener("keydown", this.onKeyDown, true);
    this.noteNavigation();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    document.removeEventListener("click", this.onClick, true);
    document.removeEventListener("change", this.onChange, true);
    document.removeEventListener("input", this.onInput, true);
    document.removeEventListener("focusout", this.onFocusOut, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
  }

  /** SPA route changes are navigations even though no document load happens. */
  noteNavigation(): void {
    if (!this.active) return;
    // A nested frame changing its own URL is not the person navigating, and
    // with the script in every frame those would otherwise flood the trace.
    if (window.top !== window.self) return;
    // Nor is the browser's own prefetching. A real recording opened with
    // Chrome fetching google.com/search/warmup.html, which then became the
    // page the receiver was sent to.
    if (/\b(warmup|newtab|blank)\b/.test(location.pathname)) return;
    const here = location.pathname + location.search;
    if (here === this.lastRoute) return;
    this.lastRoute = here;
    this.emit({ t: this.elapsed(), type: "navigate", page: pageContext(), redacted: false });
  }

  private elapsed(): number {
    return Math.max(0, Date.now() - this.startedAt);
  }

  private record(el: Element, type: TraceEventType, rawValue?: string): void {
    const target = describe(el, { includeValue: false });
    const { value, redacted, redactionReason } = redactValue(rawValue, el);

    const event: Omit<TraceEvent, "seq"> = {
      t: this.elapsed(),
      type,
      page: pageContext(),
      target,
      redacted,
    };
    if (value !== undefined) event.value = value;
    if (redactionReason) event.redactionReason = redactionReason;

    this.emit(event);
  }

  private readonly onClick = (ev: Event): void => {
    if (!this.active || !ev.isTrusted) return;
    const el = interactiveAncestor(composedTarget(ev));
    if (!el) return;
    // A toggle's `change` carries the resulting state; its click would only
    // duplicate the event with a stale value.
    if (isToggleLike(el)) return;
    this.commitOthers(el);
    this.record(el, "click");
  };

  /**
   * Commit typing in any OTHER field before recording a click.
   *
   * Typing was committed on focusout, and suggestion lists deliberately keep
   * focus in the field: Gmail's To box stays focused while you click a
   * contact. So "type ada, pick Beschi" was recorded as "pick Beschi, type
   * ada" - the typing only landed when focus finally moved to Subject - and
   * the receiver was asked to click a suggestion before typing anything to
   * summon it. What was typed, was typed before the click; record it so.
   */
  private commitOthers(clicked: Element): void {
    for (const [field, value] of this.pending) {
      if (field === clicked || field.contains(clicked)) continue;
      this.pending.delete(field);
      this.committedByClick.add(field);
      this.record(field, "fill", value);
    }
  }

  private readonly onChange = (ev: Event): void => {
    if (!this.active || !ev.isTrusted) return;
    const el = composedTarget(ev);
    if (!el) return;
    const type = opFor(el);
    if (type === "fill") {
      // Handled on focusout, so a field edited in several bursts is one event.
      this.pending.set(el, currentValue(el) ?? "");
      return;
    }
    this.record(el, type, currentValue(el));
  };

  private readonly onInput = (ev: Event): void => {
    if (!this.active || !ev.isTrusted) return;
    const el = composedTarget(ev);
    if (!el || opFor(el) !== "fill") return;
    // Held, not emitted: a field edited in several bursts is one event.
    this.pending.set(el, currentValue(el) ?? "");
  };

  private readonly onFocusOut = (ev: Event): void => {
    if (!this.active) return;
    const el = composedTarget(ev);
    if (!el || !this.pending.has(el)) return;
    const value = this.pending.get(el);
    this.pending.delete(el);
    // Picking a suggestion clears the typed text. That emptying is the
    // picker's doing, not the person's, and recording it would replay as
    // "clear the To field" right after filling it.
    if (value === "" && this.committedByClick.has(el)) return;
    this.record(el, "fill", value);
  };

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if (!this.active || !ev.isTrusted || ev.key !== "Enter") return;
    const el = composedTarget(ev);
    if (!el) return;
    // Enter commits a field and often submits; capture the value before the
    // page navigates away and focusout never fires.
    if (this.pending.has(el)) {
      const value = this.pending.get(el);
      this.pending.delete(el);
      this.record(el, "fill", value);
    }
    this.record(el, "submit");
  };
}

function currentValue(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") {
    return (el as HTMLInputElement).value;
  }
  if (tag === "select") {
    const select = el as HTMLSelectElement;
    const opt = select.selectedOptions[0];
    return opt?.textContent?.trim() || select.value;
  }
  if (el.getAttribute("contenteditable") === "true") {
    return el.textContent?.trim();
  }
  return undefined;
}

/* --------------------------------- wiring --------------------------------- */

/*
 * Events are written to sessionStorage first, then sent.
 *
 * chrome.runtime.sendMessage is async, and the events most worth keeping are
 * the ones that NAVIGATE - pressing Enter in a search box, clicking a result.
 * The page tore down before the message landed, so a recording of "search for
 * a channel and open a video" kept the typing and lost both the submit and
 * the click that followed it. The receiver then had a workflow that typed a
 * query and stopped.
 *
 * sessionStorage is synchronous, so it is already written when the page goes
 * away, and it survives navigation within the same tab and origin. The next
 * page's content script drains whatever is still there.
 */
const BUFFER_KEY = "intentlink:pending";

function readBuffer(): Array<Omit<TraceEvent, "seq">> {
  try {
    const raw = sessionStorage.getItem(BUFFER_KEY);
    return raw ? (JSON.parse(raw) as Array<Omit<TraceEvent, "seq">>) : [];
  } catch {
    return [];
  }
}

function writeBuffer(events: Array<Omit<TraceEvent, "seq">>): void {
  try {
    sessionStorage.setItem(BUFFER_KEY, JSON.stringify(events));
  } catch {
    // Storage disabled or full. The send below is then the only path, which
    // is what the behaviour was before.
  }
}

let flushing = false;

async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const pending = readBuffer();
    if (pending.length === 0) return;
    await chrome.runtime.sendMessage({ type: "capture:events", events: pending });
    // Only drop what was sent: an event captured while this was in flight
    // stays queued.
    writeBuffer(readBuffer().slice(pending.length));
  } catch {
    // Worker asleep or restarting. The buffer keeps them for the next attempt.
  } finally {
    flushing = false;
  }
}

const send = (message: ContentMessage): void => {
  if (message.type === "capture:event") {
    writeBuffer([...readBuffer(), message.event]);
    void flush();
    return;
  }
  chrome.runtime.sendMessage(message).catch(() => {
    /* worker restarting; non-capture messages are retried by their caller */
  });
};

export function installRecorder(): Recorder {
  const recorder = new Recorder((event) => send({ type: "capture:event", event }));

  // Anything the previous page could not hand over before it went away.
  void flush();
  // And one more attempt as this page leaves, for events captured just now.
  window.addEventListener("pagehide", () => void flush());

  // SPA navigation: patched history plus popstate covers both directions.
  const notify = () => recorder.noteNavigation();
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function (...args) {
    origPush.apply(this, args as never);
    notify();
  };
  history.replaceState = function (...args) {
    origReplace.apply(this, args as never);
    notify();
  };
  window.addEventListener("popstate", notify);

  return recorder;
}
