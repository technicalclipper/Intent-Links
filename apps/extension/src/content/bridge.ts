/**
 * The bridge between a consent page and the extension.
 *
 * The consent page is ordinary server-rendered HTML, served to anyone with the
 * link whether or not they have the extension. It cannot call into the
 * extension directly, and the extension should not trust a page that claims it
 * may - so the contact between them is deliberately narrow:
 *
 *   page -> extension   one message, carrying a link id and nothing else
 *   extension -> page   one attribute, so the button can say what is missing
 *                       rather than failing silently
 *
 * Everything that matters about the IntentLink - the workflow, the policy, the
 * boundaries - is fetched from the server by id. Nothing the page says about
 * what it is allowed to do is believed, because a page could say anything.
 */

import type { ContentMessage } from "../shared/protocol.js";

/** Messages are only honoured from a page that IS an IntentLink consent page. */
function isConsentPageOrigin(apiBase: string): boolean {
  try {
    return new URL(apiBase).origin === location.origin;
  } catch {
    return false;
  }
}

export function installBridge(): void {
  // Tells the page's Run button that there is something to talk to. The page
  // only reads it; it carries no capability.
  document.documentElement.dataset["intentlinkExtension"] = "1";

  window.addEventListener("message", (event: MessageEvent) => {
    // A page can postMessage anything, including pretending to be us, so the
    // sender has to be this same page rather than an embedded frame.
    if (event.source !== window) return;

    const data = event.data as { type?: unknown; linkId?: unknown; api?: unknown };
    if (data?.type !== "intentlink:run") return;
    if (typeof data.linkId !== "string" || typeof data.api !== "string") return;

    /*
     * The api base has to be this page's own origin. Otherwise any site could
     * post a run message naming an API it controls, and the extension would
     * happily fetch a workflow and a policy from an attacker and execute them
     * in the victim's session.
     */
    if (!isConsentPageOrigin(data.api)) return;

    chrome.runtime
      .sendMessage({
        type: "bridge:run",
        linkId: data.linkId,
        api: data.api,
      } satisfies ContentMessage)
      .catch(() => {
        /* worker asleep; the user can retry from the panel */
      });
  });
}
