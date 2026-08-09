// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readDraftCloudProfiles, readDraftEnvironments } from "./discovery.ts";

describe("readDraftCloudProfiles", () => {
  it("keeps closed profile summaries in stable order", () => {
    expect(
      readDraftCloudProfiles([
        null,
        42,
        {
          id: " zeta ",
          providerId: " static-ssh ",
          trust: "disposable",
          sessionHost: true,
          settings: { token: "hidden" },
        },
        { id: "aws", providerId: "crabbox", trust: "disposable", sessionHost: true },
        { id: "legacy", providerId: "static-ssh" },
        { id: "", providerId: "crabbox", trust: "disposable", sessionHost: true },
        { id: "missing-provider" },
        { id: "bad-trust", providerId: "crabbox", trust: "unknown" },
        { id: "bad-host", providerId: "crabbox", sessionHost: "yes" },
      ]),
    ).toEqual([
      { id: "aws", providerId: "crabbox", trust: "disposable", sessionHost: true },
      { id: "legacy", providerId: "static-ssh" },
      { id: "zeta", providerId: "static-ssh", trust: "disposable", sessionHost: true },
    ]);
  });
});

describe("readDraftEnvironments", () => {
  it("keeps legacy and enriched placement hints while rejecting malformed hints", () => {
    expect(
      readDraftEnvironments([
        { id: "gateway", type: "local", trust: "persistent", sessionHost: true },
        {
          id: "node:macbook",
          type: "node",
          trust: "persistent",
          sessionHost: false,
          platform: " darwin ",
        },
        { id: "node:legacy", type: "node" },
        { id: "node:trust-only", type: "node", trust: "persistent" },
        { id: "node:host-only", type: "node", sessionHost: false },
        { id: "node:bad-trust", type: "node", trust: "unknown" },
        { id: "node:bad-host", type: "node", sessionHost: "no" },
      ]),
    ).toEqual([
      { id: "gateway", type: "local", trust: "persistent", sessionHost: true },
      { id: "node:host-only", type: "node", sessionHost: false },
      { id: "node:legacy", type: "node" },
      {
        id: "node:macbook",
        type: "node",
        trust: "persistent",
        sessionHost: false,
        platform: "darwin",
      },
      { id: "node:trust-only", type: "node", trust: "persistent" },
    ]);
  });
});
