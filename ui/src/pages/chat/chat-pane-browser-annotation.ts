import type {
  BrowserAnnotationDraft,
  BrowserAnnotationEvent,
} from "../../components/browser/browser-annotation.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { releaseChatAttachmentPayload } from "./attachment-payload-store.ts";
import { canAdmitBrowserAnnotation } from "./browser-annotation-admission.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { chatAttachmentFromDataUrl } from "./components/chat-attachments.ts";

/** Adopts one complete browser annotation without mixing generated context into the user's draft. */
export function receiveBrowserAnnotation(
  state: ChatPageHost | null | undefined,
  active: boolean,
  event: Event,
): boolean {
  if (!state || !active || event.defaultPrevented || !(event instanceof CustomEvent)) {
    return false;
  }
  const detail = event.detail as BrowserAnnotationDraft | null;
  if (
    !detail ||
    typeof detail.modelContext !== "string" ||
    typeof detail.dataUrl !== "string" ||
    !detail.card
  ) {
    return false;
  }
  if (!canAdmitBrowserAnnotation(state.chatAttachments, detail.modelContext)) {
    // A rejected capture remains editable in the browser panel for a later retry.
    (event as BrowserAnnotationEvent).rejection = "limit";
    return false;
  }
  const attachment = chatAttachmentFromDataUrl(detail.dataUrl, detail.fileName || "annotation");
  if (!attachment) {
    return false;
  }
  event.preventDefault();
  state.chatAttachments = [
    ...state.chatAttachments,
    {
      ...attachment,
      browserAnnotation: {
        modelContext: detail.modelContext,
        title: detail.card.title,
        displayUrl: detail.card.displayUrl,
        markedRegionCount: detail.card.markedRegionCount,
        inspectedElement: detail.card.inspectedElement,
      },
    },
  ];
  state.requestUpdate?.();
  return true;
}

/** Releases only annotation-owned payloads when a pane's state is discarded. */
export function releasePaneBrowserAnnotations(
  state: ChatPageHost,
  releasePayload = releaseChatAttachmentPayload,
): void {
  const released = new Set<string>();
  const release = (attachments: readonly ChatAttachment[]) => {
    for (const attachment of attachments) {
      if (!attachment.browserAnnotation || released.has(attachment.id)) {
        continue;
      }
      released.add(attachment.id);
      releasePayload(attachment.id);
    }
  };
  release(state.chatAttachments);
  for (const fallback of Object.values(state.chatComposerFallbackByScope)) {
    release(fallback.attachments);
  }
}
