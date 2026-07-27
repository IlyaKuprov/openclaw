// Argv tests cover CLI argument parsing helpers and platform-specific normalization.
import { describe, expect, it } from "vitest";
import {
  buildParseArgv,
  getFlagValue,
  getCommandPositionalsWithRootOptions,
  getCommandPathWithRootOptions,
  getPrimaryCommand,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasFlag,
  isHelpOrVersionInvocation,
  isRootHelpInvocation,
  isRootVersionInvocation,
  normalizeGeneratedHelpCommandArgv,
  normalizeRootHelpTargetArgv,
  normalizeRootLogLevelArgv,
  normalizeRootNoColorArgv,
  shouldMigrateStateFromPath,
} from "./argv.js";

function cliArgv(args = ""): string[] {
  return ["node", "openclaw", ...(args ? args.split(" ") : [])];
}

function createArgvCase<TExpected>(name: string, argv: string[], expected: TExpected) {
  return { name, argv, expected };
}

function createRawArgvCase(name: string, rawArgs: readonly string[], expected: readonly string[]) {
  return { name, rawArgs, expected };
}

describe("argv helpers", () => {
  it.each([
    createArgvCase(
      "known command group help command help flag",
      cliArgv("backup help --help"),
      cliArgv("backup help"),
    ),
    createArgvCase(
      "known command group help command short help flag",
      cliArgv("--profile work backup help -h"),
      cliArgv("--profile work backup help"),
    ),
    createArgvCase(
      "leaf positional help remains untouched",
      cliArgv("docs help --help"),
      cliArgv("docs help --help"),
    ),
    createArgvCase(
      "known command group help target",
      cliArgv("plugins help list"),
      cliArgv("plugins list --help"),
    ),
    createArgvCase(
      "known command group help target help flag",
      cliArgv("plugins help list --help"),
      cliArgv("plugins list --help"),
    ),
    createArgvCase(
      "unknown plugin command group help target",
      cliArgv("external-plugin help inspect"),
      cliArgv("external-plugin inspect --help"),
    ),
    createArgvCase(
      "unknown plugin command group help target help flag",
      cliArgv("external-plugin help inspect --help"),
      cliArgv("external-plugin inspect --help"),
    ),
    createArgvCase(
      "generated help target with trailing root option",
      cliArgv("memory help status --no-color"),
      cliArgv("--no-color memory status --help"),
    ),
    createArgvCase(
      "extra help positionals remain untouched",
      cliArgv("backup help missing extra --help"),
      cliArgv("backup help missing extra --help"),
    ),
    createArgvCase(
      "terminator help flag remains untouched",
      cliArgv("backup help -- --help"),
      cliArgv("backup help -- --help"),
    ),
  ])("normalizes generated help commands: $name", ({ argv, expected }) => {
    expect(normalizeGeneratedHelpCommandArgv(argv)).toEqual(expected);
  });

  it.each([
    createArgvCase("root help target", cliArgv("help plugins"), cliArgv("plugins --help")),
    createArgvCase(
      "root help target with help flag",
      cliArgv("help plugins --help"),
      cliArgv("plugins --help"),
    ),
    createArgvCase(
      "root option before help target",
      cliArgv("--profile work help memory"),
      cliArgv("--profile work memory --help"),
    ),
    createArgvCase("bare root help remains untouched", cliArgv("help"), cliArgv("help")),
    createArgvCase(
      "root help self-help remains untouched",
      cliArgv("help --help"),
      cliArgv("help --help"),
    ),
    createArgvCase(
      "nested root help target",
      cliArgv("help plugins list"),
      cliArgv("plugins list --help"),
    ),
    createArgvCase(
      "nested root help target with help flag",
      cliArgv("help plugins list --help"),
      cliArgv("plugins list --help"),
    ),
    createArgvCase(
      "nested root help target with trailing root option",
      cliArgv("help memory status --no-color"),
      cliArgv("--no-color memory status --help"),
    ),
  ])("normalizes root help targets: $name", ({ argv, expected }) => {
    expect(normalizeRootHelpTargetArgv(argv)).toEqual(expected);
  });

  it.each([
    createArgvCase(
      "subcommand trailing no-color",
      cliArgv("doctor --no-color --post-upgrade --json"),
      cliArgv("--no-color doctor --post-upgrade --json"),
    ),
    createArgvCase(
      "keeps existing root options first",
      cliArgv("--profile work doctor --no-color --lint --json"),
      cliArgv("--profile work --no-color doctor --lint --json"),
    ),
    createArgvCase(
      "keeps no-color after possible command option value",
      cliArgv("doctor --lint --json --no-color"),
      cliArgv("doctor --lint --json --no-color"),
    ),
    createArgvCase(
      "flag terminator leaves no-color positional",
      cliArgv("doctor -- --no-color"),
      cliArgv("doctor -- --no-color"),
    ),
    createArgvCase(
      "command option value remains literal",
      cliArgv("agent --message --no-color"),
      cliArgv("agent --message --no-color"),
    ),
    createArgvCase(
      "assigned command option value does not block no-color",
      cliArgv("agent --message=hello --no-color"),
      cliArgv("--no-color agent --message=hello"),
    ),
  ])("normalizes root --no-color before command parsing: $name", ({ argv, expected }) => {
    expect(normalizeRootNoColorArgv(argv)).toEqual(expected);
  });

  it("allows final command metadata to lift no-color after boolean command flags", () => {
    const argv = cliArgv("doctor --lint --json --no-color");

    expect(
      normalizeRootNoColorArgv(argv, {
        shouldPreserveNoColor: ({ remainingArgs, noColorIndex }) =>
          remainingArgs[noColorIndex - 1] === "--message",
      }),
    ).toEqual(cliArgv("--no-color doctor --lint --json"));
  });

  it.each([
    createArgvCase(
      "subcommand trailing log-level",
      cliArgv("doctor --log-level debug --json"),
      cliArgv("--log-level debug doctor --json"),
    ),
    createArgvCase(
      "subcommand trailing log-level equals form",
      cliArgv("doctor --log-level=trace --json"),
      cliArgv("--log-level=trace doctor --json"),
    ),
    createArgvCase(
      "keeps existing root options first",
      cliArgv("--profile work doctor --log-level debug"),
      cliArgv("--profile work --log-level debug doctor"),
    ),
    createArgvCase(
      "keeps log-level after possible command option value",
      cliArgv("agent --message --log-level debug"),
      cliArgv("agent --message --log-level debug"),
    ),
    createArgvCase(
      "flag terminator leaves log-level positional",
      cliArgv("nodes run -- --log-level debug"),
      cliArgv("nodes run -- --log-level debug"),
    ),
    createArgvCase(
      "missing value remains command scoped",
      cliArgv("doctor --log-level --json"),
      cliArgv("doctor --log-level --json"),
    ),
  ])("normalizes root --log-level before command parsing: $name", ({ argv, expected }) => {
    expect(normalizeRootLogLevelArgv(argv)).toEqual(expected);
  });

  it("allows final command metadata to lift log-level after boolean command flags", () => {
    const argv = cliArgv("doctor --lint --json --log-level debug");

    expect(
      normalizeRootLogLevelArgv(argv, {
        shouldPreserveLogLevel: ({ remainingArgs, logLevelIndex }) =>
          remainingArgs[logLevelIndex - 1] === "--message",
      }),
    ).toEqual(cliArgv("--log-level debug doctor --lint --json"));
  });

  it("preserves log-level when final command metadata owns the option", () => {
    const argv = cliArgv("plugin-cmd --log-level debug");

    expect(
      normalizeRootLogLevelArgv(argv, {
        shouldPreserveLogLevel: ({ remainingArgs, logLevelIndex }) =>
          remainingArgs[logLevelIndex] === "--log-level",
      }),
    ).toEqual(argv);
  });

  it.each([
    createArgvCase("root help command", cliArgv("help"), true),
    createArgvCase("root help command with target", cliArgv("help matrix"), true),
    createArgvCase("nested help command", cliArgv("matrix encryption help"), true),
    createArgvCase("known subcommand root help command", cliArgv("config help"), true),
    createArgvCase("known leaf command positional help", cliArgv("docs help"), false),
    createArgvCase(
      "known subcommand leaf positional help",
      cliArgv("config set some.path help"),
      false,
    ),
    createArgvCase("unknown plugin command help", cliArgv("external-plugin tools help"), true),
    createArgvCase("help flag", cliArgv("matrix encryption --help"), true),
    createArgvCase("help as option value", cliArgv("agent --message help"), false),
    createArgvCase("help after terminator", cliArgv("nodes invoke -- help"), false),
    createArgvCase("help flag after terminator", cliArgv("nodes invoke -- --help"), false),
    createArgvCase("version flag after terminator", cliArgv("nodes invoke -- --version"), false),
  ])("detects help/version invocations: $name", ({ argv, expected }) => {
    expect(isHelpOrVersionInvocation(argv)).toBe(expected);
  });

  it.each([
    createArgvCase("root --version", cliArgv("--version"), true),
    createArgvCase("root -V", cliArgv("-V"), true),
    createArgvCase("root -v alias with profile", cliArgv("--profile work -v"), true),
    createArgvCase("subcommand version flag", cliArgv("status --version"), false),
    createArgvCase("unknown root flag with version", cliArgv("--unknown --version"), false),
  ])("detects root-only version invocations: $name", ({ argv, expected }) => {
    expect(isRootVersionInvocation(argv)).toBe(expected);
  });

  it.each([
    createArgvCase("root --help", cliArgv("--help"), true),
    createArgvCase("root -h", cliArgv("-h"), true),
    createArgvCase("root --help with profile", cliArgv("--profile work --help"), true),
    createArgvCase("subcommand --help", cliArgv("status --help"), false),
    createArgvCase("help before subcommand token", cliArgv("--help status"), false),
    createArgvCase(
      "help after -- terminator",
      cliArgv("nodes invoke -- device.status --help"),
      false,
    ),
    createArgvCase("unknown root flag before help", cliArgv("--unknown --help"), false),
    createArgvCase("unknown root flag after help", cliArgv("--help --unknown"), false),
  ])("detects root-only help invocations: $name", ({ argv, expected }) => {
    expect(isRootHelpInvocation(argv)).toBe(expected);
  });

  it.each([
    createArgvCase("single command with trailing flag", cliArgv("status --json"), ["status"]),
    createArgvCase("two-part command", cliArgv("agents list"), ["agents", "list"]),
    createArgvCase("terminator cuts parsing", cliArgv("status -- ignored"), ["status"]),
  ])("extracts command path: $name", ({ argv, expected }) => {
    expect(getCommandPathWithRootOptions(argv, 2)).toEqual(expected);
  });

  it("extracts command path while skipping known root option values", () => {
    expect(
      getCommandPathWithRootOptions(
        cliArgv("--profile work --container demo --no-color config validate"),
        2,
      ),
    ).toEqual(["config", "validate"]);
  });

  it("extracts routed config get positionals with interleaved root options", () => {
    expect(
      getCommandPositionalsWithRootOptions(
        cliArgv("config get --log-level debug update.channel --json"),
        {
          commandPath: ["config", "get"],
          booleanFlags: ["--json"],
        },
      ),
    ).toEqual(["update.channel"]);
  });

  it("extracts routed config unset positionals with interleaved root options", () => {
    expect(
      getCommandPositionalsWithRootOptions(cliArgv("config unset --profile work update.channel"), {
        commandPath: ["config", "unset"],
      }),
    ).toEqual(["update.channel"]);
  });

  it("returns null when routed command sees unknown options", () => {
    expect(
      getCommandPositionalsWithRootOptions(cliArgv("config get --mystery value update.channel"), {
        commandPath: ["config", "get"],
        booleanFlags: ["--json"],
      }),
    ).toBeNull();
  });

  it.each([
    createArgvCase("returns first command token", cliArgv("agents list"), "agents"),
    createArgvCase("returns null when no command exists", cliArgv(""), null),
    createArgvCase("skips known root option values", cliArgv("--log-level debug status"), "status"),
  ])("returns primary command: $name", ({ argv, expected }) => {
    expect(getPrimaryCommand(argv)).toBe(expected);
  });

  it.each([
    {
      name: "detects flag before terminator",
      argv: cliArgv("status --json"),
      flag: "--json",
      expected: true,
    },
    {
      name: "ignores flag after terminator",
      argv: cliArgv("-- --json"),
      flag: "--json",
      expected: false,
    },
  ])("parses boolean flags: $name", ({ argv, flag, expected }) => {
    expect(hasFlag(argv, flag)).toBe(expected);
  });

  it.each([
    createArgvCase("value in next token", cliArgv("status --timeout 5000"), "5000"),
    createArgvCase("value in equals form", cliArgv("status --timeout=2500"), "2500"),
    createArgvCase("missing value", cliArgv("status --timeout"), null),
    createArgvCase("next token is another flag", cliArgv("status --timeout --json"), null),
    createArgvCase("flag appears after terminator", cliArgv("-- --timeout=99"), undefined),
    createArgvCase(
      "repeated flag uses final value",
      cliArgv("status --timeout 100 --timeout=200"),
      "200",
    ),
    createArgvCase(
      "missing repeated value remains invalid",
      cliArgv("status --timeout --timeout 200"),
      null,
    ),
  ])("extracts flag values: $name", ({ argv, expected }) => {
    expect(getFlagValue(argv, "--timeout")).toBe(expected);
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(cliArgv("status --verbose"))).toBe(true);
    expect(getVerboseFlag(cliArgv("status --debug"))).toBe(false);
    expect(getVerboseFlag(cliArgv("status --debug"), { includeDebug: true })).toBe(true);
  });

  it.each([
    createArgvCase("missing flag", cliArgv("status"), undefined),
    createArgvCase("missing value", cliArgv("status --timeout"), null),
    createArgvCase("valid positive integer", cliArgv("status --timeout 5000"), 5000),
    createArgvCase(
      "valid signed decimal positive integer",
      cliArgv("status --timeout +5000"),
      5000,
    ),
    createArgvCase("invalid integer", cliArgv("status --timeout nope"), null),
    createArgvCase("non-decimal integer", cliArgv("status --timeout 0x10"), null),
    createArgvCase("partial integer", cliArgv("status --timeout 5s"), null),
    createArgvCase("zero", cliArgv("status --timeout 0"), null),
    createArgvCase("negative integer", cliArgv("status --timeout -5"), null),
    createArgvCase(
      "repeated value uses final valid integer",
      cliArgv("status --timeout nope --timeout 5000"),
      5000,
    ),
    createArgvCase(
      "repeated value rejects final invalid integer",
      cliArgv("status --timeout 5000 --timeout nope"),
      null,
    ),
  ])("parses positive integer flag values: $name", ({ argv, expected }) => {
    expect(getPositiveIntFlagValue(argv, "--timeout")).toBe(expected);
  });

  it.each([
    createRawArgvCase("keeps plain node argv", cliArgv("status"), cliArgv("status")),
    createRawArgvCase(
      "keeps version-suffixed node binary",
      ["node-22", "openclaw", "status"],
      ["node-22", "openclaw", "status"],
    ),
    createRawArgvCase(
      "keeps windows versioned node exe",
      ["node-22.2.0.exe", "openclaw", "status"],
      ["node-22.2.0.exe", "openclaw", "status"],
    ),
    createRawArgvCase(
      "keeps dotted node binary",
      ["node-22.2", "openclaw", "status"],
      ["node-22.2", "openclaw", "status"],
    ),
    createRawArgvCase(
      "keeps dotted node exe",
      ["node-22.2.exe", "openclaw", "status"],
      ["node-22.2.exe", "openclaw", "status"],
    ),
    createRawArgvCase(
      "keeps absolute versioned node path",
      ["/usr/bin/node-22.2.0", "openclaw", "status"],
      ["/usr/bin/node-22.2.0", "openclaw", "status"],
    ),
    createRawArgvCase(
      "keeps node24 shorthand",
      ["node24", "openclaw", "status"],
      ["node24", "openclaw", "status"],
    ),
    createRawArgvCase(
      "keeps absolute node24 shorthand",
      ["/usr/bin/node24", "openclaw", "status"],
      ["/usr/bin/node24", "openclaw", "status"],
    ),
    createRawArgvCase(
      "keeps windows node24 exe",
      ["node24.exe", "openclaw", "status"],
      ["node24.exe", "openclaw", "status"],
    ),
    createRawArgvCase(
      "keeps nodejs binary",
      ["nodejs", "openclaw", "status"],
      ["nodejs", "openclaw", "status"],
    ),
    createRawArgvCase(
      "prefixes fallback when first arg is not a node launcher",
      ["node-dev", "openclaw", "status"],
      cliArgv("node-dev openclaw status"),
    ),
    createRawArgvCase(
      "prefixes fallback when raw args start at program name",
      ["openclaw", "status"],
      cliArgv("status"),
    ),
    createRawArgvCase(
      "keeps bun execution argv",
      ["bun", "src/entry.ts", "status"],
      ["bun", "src/entry.ts", "status"],
    ),
  ] as const)("builds parse argv from raw args: $name", ({ rawArgs, expected }) => {
    const parsed = buildParseArgv([...rawArgs]);
    expect(parsed).toEqual([...expected]);
  });

  it.each([
    { argv: cliArgv("status"), expected: true },
    { argv: cliArgv("health"), expected: false },
    { argv: cliArgv("sessions"), expected: false },
    { argv: cliArgv("--profile work status"), expected: true },
    { argv: cliArgv("--log-level=debug models list"), expected: true },
    { argv: cliArgv("config get update"), expected: false },
    { argv: cliArgv("config unset update"), expected: false },
    { argv: cliArgv("models list"), expected: true },
    { argv: cliArgv("models status"), expected: true },
    { argv: cliArgv("update status --json"), expected: false },
    { argv: cliArgv("agent --message hi"), expected: true },
    { argv: cliArgv("agents list"), expected: true },
    { argv: cliArgv("message send"), expected: true },
  ] as const)("decides when to migrate state: $argv", ({ argv, expected }) => {
    const commandPath = getCommandPathWithRootOptions([...argv], 2);
    expect(shouldMigrateStateFromPath(commandPath)).toBe(expected);
  });

  it.each([
    { path: ["status"], expected: true },
    { path: ["update", "status"], expected: false },
    { path: ["config", "get"], expected: false },
    { path: ["agent"], expected: true },
    { path: ["models", "status"], expected: true },
    { path: ["agents", "list"], expected: true },
  ])("reuses command path for migrate state decisions: $path", ({ path, expected }) => {
    expect(shouldMigrateStateFromPath(path)).toBe(expected);
  });
});
