import { render, type TemplateResult } from "lit";
import { describe, expect, it } from "vitest";
import "./new-session-page.ts";

type TestNewSessionPage = {
  renderDraftBlock(): TemplateResult;
  showCloudDraftOwnershipLost(): void;
};

describe("new session page outcomes", () => {
  it("renders the ownership-lost cloud outcome", () => {
    const page = document.createElement(
      "openclaw-new-session-page",
    ) as unknown as TestNewSessionPage;
    const host = document.createElement("div");

    page.showCloudDraftOwnershipLost();
    render(page.renderDraftBlock(), host);

    expect(host.querySelector(".new-session-page__error")?.textContent).toContain(
      "Another window took over this cloud session. Check recent sessions before starting this task again.",
    );
  });
});
