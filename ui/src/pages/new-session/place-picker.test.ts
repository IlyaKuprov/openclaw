/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { readDraftEnvironments } from "./discovery.ts";
import { resolvePlacePickerSections } from "./place-picker-sections.ts";
import { renderPlaceSelect } from "./place-picker.ts";

describe("Where picker", () => {
  it("uses node presence only until an authoritative environment catalog arrives", () => {
    const execNodes = [
      {
        nodeId: "usable",
        displayName: "Usable",
        connected: true,
        canExec: true,
        canBrowse: false,
      },
      {
        nodeId: "disconnected",
        displayName: "Disconnected",
        connected: false,
        canExec: true,
        canBrowse: false,
      },
      {
        nodeId: "no-exec",
        displayName: "No exec",
        connected: true,
        canExec: false,
        canBrowse: false,
      },
    ];

    expect(
      resolvePlacePickerSections({ environments: null, execNodes, cloudProfiles: [] }).deviceNodes,
    ).toEqual([execNodes[0]]);
    expect(
      resolvePlacePickerSections({ environments: [], execNodes, cloudProfiles: [] }).deviceNodes,
    ).toEqual([]);
  });

  it("groups usable places from server-owned trust and session-host facts", () => {
    const container = document.createElement("div");
    const connectedExecNodes = [
      "macbook",
      "legacy",
      "trust-only",
      "host-only",
      "disposable",
      "session-host",
      "missing-environment",
      "malformed",
      "wrong-type",
    ].map((nodeId) => ({
      nodeId,
      displayName: nodeId,
      connected: true,
      canExec: true,
      canBrowse: false,
    }));
    render(
      renderPlaceSelect({
        browseAvailable: true,
        folder: "",
        workspace: "/workspace",
        sessions: [],
        execNodes: [
          ...connectedExecNodes,
          {
            nodeId: "offline",
            displayName: "Offline Mac",
            connected: false,
            canExec: false,
            canBrowse: false,
          },
          {
            nodeId: "no-exec",
            displayName: "No exec",
            connected: true,
            canExec: false,
            canBrowse: false,
          },
        ],
        environments: readDraftEnvironments([
          { id: "gateway", type: "local", trust: "persistent", sessionHost: true },
          {
            id: "node:macbook",
            type: "node",
            trust: "persistent",
            sessionHost: false,
          },
          { id: "node:legacy", type: "node" },
          { id: "node:trust-only", type: "node", trust: "persistent" },
          { id: "node:host-only", type: "node", sessionHost: false },
          {
            id: "node:disposable",
            type: "node",
            trust: "disposable",
            sessionHost: false,
          },
          {
            id: "node:session-host",
            type: "node",
            trust: "persistent",
            sessionHost: true,
          },
          {
            id: "node:offline",
            type: "node",
            trust: "persistent",
            sessionHost: false,
          },
          {
            id: "node:no-exec",
            type: "node",
            trust: "persistent",
            sessionHost: false,
          },
          { id: "node:malformed", type: "node", trust: "unknown" },
          { id: "node:wrong-type", type: "local" },
        ]),
        gatewayName: "Studio",
        cloudProfiles: [
          { id: "aws", providerId: "crabbox", trust: "disposable", sessionHost: true },
          { id: "legacy", providerId: "static-ssh" },
          { id: "local", providerId: "ssh", trust: "persistent", sessionHost: true },
          { id: "peripheral", providerId: "ssh", trust: "disposable", sessionHost: false },
        ],
        cloudProfileId: "",
        execNode: "",
        syncFolder: "/workspace",
        worktree: false,
        worktreeVisible: false,
        worktreeAvailable: true,
        branches: null,
        branchesLoading: false,
        baseRef: "",
        worktreeName: "",
        submitting: false,
        pendingCloud: false,
        showDestinations: true,
        popoverOpen: true,
        popoverHiding: false,
        browserTarget: null,
        browserListing: null,
        browserLoading: false,
        browserError: null,
        browserPathDraft: "",
        usableBrowserPath: null,
        onGuardTransition: vi.fn(),
        onPopoverShow: vi.fn(),
        onPopoverHide: vi.fn(),
        onPopoverAfterHide: vi.fn(),
        onSelectExecNode: vi.fn(),
        onSelectCloudProfile: vi.fn(),
        onApplyFolder: vi.fn(),
        onBrowse: vi.fn(),
        onBrowserPathDraftChange: vi.fn(),
        onBrowserNavigate: vi.fn(),
        onBrowserBack: vi.fn(),
        onClose: vi.fn(),
        onToggleWorktree: vi.fn(),
        onBaseRefInput: vi.fn(),
        onWorktreeNameInput: vi.fn(),
      }),
      container,
    );

    const titles = [...container.querySelectorAll(".new-session-page__menu-title")].map((element) =>
      element.textContent?.trim(),
    );
    expect(titles).toEqual(["Folder", "This gateway", "Your devices", "Cloud"]);
    expect(container.querySelector('[data-value="node:macbook"]')).not.toBeNull();
    expect(container.querySelector('[data-value="node:legacy"]')).not.toBeNull();
    for (const nodeId of [
      "trust-only",
      "host-only",
      "disposable",
      "session-host",
      "missing-environment",
      "malformed",
      "wrong-type",
      "offline",
      "no-exec",
    ]) {
      expect(container.querySelector(`[data-value="node:${nodeId}"]`)).toBeNull();
    }
    expect(container.querySelector('[data-value="cloud:aws"]')).not.toBeNull();
    expect(container.querySelector('[data-value="cloud:legacy"]')).not.toBeNull();
    expect(container.querySelector('[data-value="cloud:local"]')).toBeNull();
    expect(container.querySelector('[data-value="cloud:peripheral"]')).toBeNull();
    expect(container.textContent).not.toMatch(/persistent|disposable/u);

    const gateway = container.querySelector('[data-value="gateway"]');
    expect(gateway?.lastElementChild?.classList.contains("session-menu__check")).toBe(true);
  });
});
