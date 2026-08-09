/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type {
  BrowserAnnotationDraft,
  BrowserAnnotationEvent,
} from "../../components/browser/browser-annotation.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayload,
} from "./attachment-payload-store.ts";
import { canAdmitBrowserAnnotation } from "./browser-annotation-admission.ts";
import {
  receiveBrowserAnnotation,
  releasePaneBrowserAnnotations,
} from "./chat-pane-browser-annotation.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

function annotation(id: string, modelContext = `Context ${id}`): ChatAttachment {
  return {
    id,
    mimeType: "image/png",
    browserAnnotation: {
      modelContext,
      title: `Page ${id}`,
      displayUrl: "example.com",
      markedRegionCount: 1,
      inspectedElement: false,
    },
  };
}

function draft(modelContext: string): BrowserAnnotationDraft {
  return {
    modelContext,
    dataUrl: "data:image/png;base64,aGVsbG8=",
    fileName: "annotated-page.png",
    card: {
      title: "Example",
      displayUrl: "example.com",
      markedRegionCount: 1,
      inspectedElement: false,
    },
  };
}

describe("browser annotation admission", () => {
  it("includes the candidate in both the four-card and 8,000-character bounds", () => {
    expect(canAdmitBrowserAnnotation([], "x".repeat(8_000))).toBe(true);
    expect(canAdmitBrowserAnnotation([], "x".repeat(8_001))).toBe(false);
    expect(
      canAdmitBrowserAnnotation(
        [annotation("one"), annotation("two"), annotation("three")],
        "fourth",
      ),
    ).toBe(true);
    expect(
      canAdmitBrowserAnnotation(
        [annotation("one"), annotation("two"), annotation("three"), annotation("four")],
        "fifth",
      ),
    ).toBe(false);
  });

  it("marks an active-pane rejection without allocating or consuming the capture", () => {
    const state = {
      chatAttachments: [
        annotation("one"),
        annotation("two"),
        annotation("three"),
        annotation("four"),
      ],
      requestUpdate: vi.fn(),
    } as unknown as ChatPageHost;
    const event = new CustomEvent<BrowserAnnotationDraft>("openclaw:browser-annotation", {
      detail: draft("Rejected context"),
      cancelable: true,
    });
    expect(receiveBrowserAnnotation(state, true, event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect((event as BrowserAnnotationEvent).rejection).toBe("limit");
    expect(state.chatAttachments).toHaveLength(4);
  });
});

describe("browser annotation pane teardown", () => {
  it("deduplicates current and fallback annotations while preserving ordinary payloads", () => {
    const stored = (attachment: ChatAttachment, payload: string) =>
      registerChatAttachmentPayload({
        attachment,
        dataUrl: payload,
        file: new File([payload], `${attachment.id}.png`, { type: attachment.mimeType }),
      });
    const shared = stored(annotation("shared"), "data:image/png;base64,c2hhcmVk");
    const fallback = stored(annotation("fallback"), "data:image/png;base64,ZmFsbGJhY2s=");
    const ordinary = stored(
      { id: "ordinary", mimeType: "image/png" },
      "data:image/png;base64,b3JkaW5hcnk=",
    );
    const state = {
      chatAttachments: [shared, ordinary],
      chatComposerFallbackByScope: {
        fallback: {
          attachments: [shared, fallback, ordinary],
          message: "",
          sequence: 1,
          storageFailed: false,
        },
      },
    } as unknown as ChatPageHost;

    const releasePayload = vi.fn((id: string) => releaseChatAttachmentPayload(id));
    releasePaneBrowserAnnotations(state, releasePayload);

    expect(releasePayload.mock.calls.map(([id]) => id)).toEqual(["shared", "fallback"]);
    expect(getChatAttachmentDataUrl(shared)).toBeNull();
    expect(getChatAttachmentDataUrl(fallback)).toBeNull();
    expect(getChatAttachmentDataUrl(ordinary)).not.toBeNull();
    releaseChatAttachmentPayload(ordinary.id);
  });
});
