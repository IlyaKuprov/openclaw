import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createModelExecSchema, execSchema, nodeExecSchema } from "./bash-tools.schemas.js";
import { isCodeModeExecControlTool } from "./code-mode-control-tools.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import { createLazyExecTool } from "./lazy-exec-tool.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
  ToolSearchRuntime,
} from "./tool-search.js";

function hostTargets(schema: { properties: { host?: unknown } }): string[] | undefined {
  return (schema.properties.host as { enum?: string[] } | undefined)?.enum;
}

describe("lazy exec model schema", () => {
  it.each([
    {
      name: "auto with sandbox",
      defaults: { host: "auto" as const, sandbox: {} as never },
      expected: ["auto", "sandbox"],
    },
    {
      name: "auto without sandbox",
      defaults: { host: "auto" as const },
      expected: ["auto", "gateway", "node"],
    },
    {
      name: "gateway pinned",
      defaults: { host: "gateway" as const },
      expected: ["gateway"],
    },
    {
      name: "sandbox pinned",
      defaults: { host: "sandbox" as const, sandbox: {} as never },
      expected: ["sandbox"],
    },
    {
      name: "node pinned",
      defaults: { host: "node" as const },
      expected: ["node"],
    },
  ])("advertises only policy-authorized targets for $name", ({ defaults, expected }) => {
    const schema = createModelExecSchema(defaults);

    expect(hostTargets(schema)).toEqual(expected);
    expect(schema.properties.host.description).toBe(
      `Policy-authorized exec target (${expected.join("|")}).`,
    );
  });

  it("preserves the full internal parser schema and node-only presentation", () => {
    createModelExecSchema({ host: "auto" });

    expect(hostTargets(execSchema)).toEqual(["auto", "sandbox", "gateway", "node"]);
    expect(hostTargets(nodeExecSchema)).toEqual(["node"]);
  });

  it("refuses to build an empty pinned-sandbox model schema", () => {
    expect(() => createModelExecSchema({ host: "sandbox" })).toThrow(
      'tools.exec.host="sandbox" requires an active sandbox runtime',
    );
  });

  it("keeps explicit presentation parameters authoritative", () => {
    const parameters = Type.Object({ command: Type.String() });

    expect(createLazyExecTool({ host: "gateway" }, { parameters }).parameters).toBe(parameters);
  });

  it("projects one raw exec schema through direct, Tool Search, and Code Mode", async () => {
    const tool = createLazyExecTool({ host: "auto" });
    const toolSearchCatalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({ catalogRef: toolSearchCatalogRef, tools: [tool] });
    const toolSearchRuntime = new ToolSearchRuntime(
      { catalogRef: toolSearchCatalogRef },
      resolveToolSearchConfig({ tools: { toolSearch: true } } as never),
    );
    const described = await toolSearchRuntime.describe("exec");

    const codeModeCatalogRef = createToolSearchCatalogRef();
    const config = { tools: { codeMode: true } } as never;
    const codeModeTools = createCodeModeTools({
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef: codeModeCatalogRef,
    });
    const compacted = applyCodeModeCatalog({
      tools: [...codeModeTools, tool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef: codeModeCatalogRef,
    });
    const outerExec = compacted.tools.find(isCodeModeExecControlTool);
    const nestedExec = codeModeCatalogRef.current?.entries.find(
      (entry) => entry.id === "openclaw:core:exec",
    );

    expect(described.parameters).toBe(tool.parameters);
    expect(nestedExec?.parameters).toBe(tool.parameters);
    expect(hostTargets(tool.parameters as never)).toEqual(["auto", "gateway", "node"]);
    expect(isCodeModeExecControlTool(nestedExec?.tool as never)).toBe(false);
    expect(outerExec?.parameters).toHaveProperty("properties.code");
    expect(outerExec?.parameters).toHaveProperty("properties.language");
    expect(outerExec?.parameters).not.toHaveProperty("properties.host");
  });
});
