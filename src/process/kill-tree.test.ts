// Kill tree tests cover process tree termination and platform-specific fallbacks.
import { EventEmitter } from "node:events";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";

const { readdirSyncMock, readFileSyncMock, spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  readdirSyncMock: vi.fn((..._args: unknown[]) => [] as string[]),
  readFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readdirSync: (...args: unknown[]) => readdirSyncMock(...args),
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
}));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawn: (...args: unknown[]) => spawnMock(...args),
      spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
    },
  );
});

let killProcessTree: typeof import("./kill-tree.js").killProcessTree;
let signalProcessTree: typeof import("./kill-tree.js").signalProcessTree;

function expectTaskkillCall(index: number, args: string[]) {
  expect(spawnMock.mock.calls[index]).toStrictEqual([
    "taskkill",
    args,
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  ]);
}

/** A `/proc/<pid>/stat` line whose positional fields carry ppid and start time. */
function mockProcStat(params: { pid: number; ppid: number; startToken: string }) {
  const betweenPpidAndStartTime = Array.from({ length: 17 }, () => "0").join(" ");
  return {
    pid: params.pid,
    stat: `${params.pid} (bash cmd) S ${params.ppid} ${betweenPpidAndStartTime} ${params.startToken}`,
  };
}

function mockIsProcessGroupLeader(...pids: number[]) {
  spawnSyncMock.mockImplementation((command: string, args: string[]) => {
    if (command === "ps" && args[0] === "-p" && args[2] === "-o" && args[3] === "pgid=") {
      const pid = Number.parseInt(args[1] ?? "", 10);
      if (pids.includes(pid)) {
        return { status: 0, stdout: String(pid) };
      }
    }
    return { status: 1, stdout: "" };
  });
}

describe("killProcessTree", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    ({ killProcessTree, signalProcessTree } = await import("./kill-tree.js"));
  });

  beforeEach(() => {
    readdirSyncMock.mockReset();
    readdirSyncMock.mockReturnValue([]);
    readFileSyncMock.mockReset();
    readFileSyncMock.mockImplementation(() => {
      throw new Error("proc unavailable");
    });
    spawnMock.mockReset();
    spawnSyncMock.mockClear();
    killSpy = vi.spyOn(process, "kill");
    vi.useFakeTimers();
  });

  afterEach(() => {
    killSpy.mockRestore();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("on Windows skips delayed force-kill when PID is already gone", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 4242 && signal === 0) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("win32", async () => {
      killProcessTree(4242, { graceMs: 25 });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expectTaskkillCall(0, ["/T", "/PID", "4242"]);

      await vi.advanceTimersByTimeAsync(25);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
  });

  it("on Windows force-kills after grace period only when PID still exists", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 5252 && signal === 0) {
        return true;
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("win32", async () => {
      killProcessTree(5252, { graceMs: 10 });

      await vi.advanceTimersByTimeAsync(10);

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expectTaskkillCall(0, ["/T", "/PID", "5252"]);
      expectTaskkillCall(1, ["/F", "/T", "/PID", "5252"]);
    });
  });

  it("on Windows force-kills immediately when graceful taskkill refuses a live process tree", async () => {
    const gracefulTaskkill = new EventEmitter();
    spawnMock.mockReturnValueOnce(gracefulTaskkill);
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("win32", async () => {
      killProcessTree(4711, { graceMs: 30_000 });

      expectTaskkillCall(0, ["/T", "/PID", "4711"]);
      gracefulTaskkill.emit("close", 128);

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expectTaskkillCall(1, ["/F", "/T", "/PID", "4711"]);
    });
  });

  it("on Windows does not force-kill a disappeared or reused PID after taskkill fails", async () => {
    const gracefulTaskkill = new EventEmitter();
    spawnMock.mockReturnValueOnce(gracefulTaskkill);
    let processWasReused = false;
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 4712 && signal === 0 && !processWasReused) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("win32", async () => {
      killProcessTree(4712, { graceMs: 25 });
      gracefulTaskkill.emit("close", 128);
      expect(spawnMock).toHaveBeenCalledTimes(1);

      processWasReused = true;
      await vi.advanceTimersByTimeAsync(25);

      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
  });

  it("on Windows force-kills only once when taskkill failure races the grace timer", async () => {
    const gracefulTaskkill = new EventEmitter();
    spawnMock.mockReturnValueOnce(gracefulTaskkill);
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("win32", async () => {
      killProcessTree(4713, { graceMs: 20 });
      gracefulTaskkill.emit("close", 128);
      await vi.advanceTimersByTimeAsync(20);

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expectTaskkillCall(1, ["/F", "/T", "/PID", "4713"]);
    });
  });

  it("on Windows waits for the grace timer when graceful taskkill cannot start", async () => {
    const gracefulTaskkill = new EventEmitter();
    spawnMock.mockReturnValueOnce(gracefulTaskkill);
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("win32", async () => {
      killProcessTree(4714, { graceMs: 15 });
      expect(() => gracefulTaskkill.emit("error", new Error("spawn ENOENT"))).not.toThrow();
      gracefulTaskkill.emit("close", -4058);
      expect(spawnMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(15);

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expectTaskkillCall(1, ["/F", "/T", "/PID", "4714"]);
    });
  });

  it("on Windows keeps an explicitly requested failed tree signal single-shot", async () => {
    const gracefulTaskkill = new EventEmitter();
    spawnMock.mockReturnValueOnce(gracefulTaskkill);

    await withMockedPlatform("win32", async () => {
      signalProcessTree(4715, "SIGTERM");
      gracefulTaskkill.emit("close", 128);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expectTaskkillCall(0, ["/T", "/PID", "4715"]);
    });
  });

  it("on Unix sends SIGTERM first and skips SIGKILL when process exits", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -3333 && signal === 0) {
        throw new Error("ESRCH");
      }
      if (pid === 3333 && signal === 0) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("linux", async () => {
      mockIsProcessGroupLeader(3333);
      killProcessTree(3333, { graceMs: 10 });

      await vi.advanceTimersByTimeAsync(10);

      expect(killSpy).toHaveBeenCalledWith(-3333, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-3333, "SIGKILL");
      expect(killSpy).not.toHaveBeenCalledWith(3333, "SIGKILL");
    });
  });

  it("on Unix sends SIGKILL after grace period when process is still alive", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -4444 && signal === 0) {
        return true;
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("linux", async () => {
      mockIsProcessGroupLeader(4444);
      killProcessTree(4444, { graceMs: 5 });

      await vi.advanceTimersByTimeAsync(5);

      expect(killSpy).toHaveBeenCalledWith(-4444, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(-4444, "SIGKILL");
    });
  });

  it("on Unix force-kills synchronously without SIGTERM or delayed escalation", async () => {
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("linux", async () => {
      mockIsProcessGroupLeader(4949);
      killProcessTree(4949, { force: true });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenCalledWith(-4949, "SIGKILL");
      expect(killSpy).not.toHaveBeenCalledWith(-4949, "SIGTERM");
    });
  });

  it("on Unix force-kills a live detached group even after the parent pid exits", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -4545 && signal === 0) {
        return true;
      }
      if (pid === 4545 && signal === 0) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("linux", async () => {
      mockIsProcessGroupLeader(4545);
      killProcessTree(4545, { graceMs: 5 });

      await vi.advanceTimersByTimeAsync(5);

      expect(killSpy).toHaveBeenCalledWith(-4545, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(-4545, "SIGKILL");
      expect(killSpy).not.toHaveBeenCalledWith(4545, "SIGKILL");
    });
  });

  it("on Unix skips group kill when detached:false to avoid SIGTERMing the parent's own process group (#71662)", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 5555 && signal === 0) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("linux", async () => {
      killProcessTree(5555, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);

      // Direct pid kill is fine. Group kill (`-pid`) is FORBIDDEN here because
      // when the child wasn't spawned detached, its process group is the
      // gateway's group — `-pid` would SIGTERM the gateway itself.
      expect(killSpy).toHaveBeenCalledWith(5555, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-5555, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-5555, "SIGKILL");
    });
  });

  it("on Unix signals descendants explicitly when detached:false rules out group kill", async () => {
    // 5555 is the shell the supervisor spawned; 5556 is what the shell forked
    // and 5557 is that process's own child. Without group kill they are only
    // reachable one PID at a time.
    const parents = new Map([
      [5555, 1],
      [5556, 5555],
      [5557, 5556],
      [6001, 1],
    ]);
    readdirSyncMock.mockReturnValue([...parents.keys()].map(String));
    readFileSyncMock.mockImplementation((filePath: unknown) => {
      const pid = Number(String(filePath).replace("/proc/", "").replace("/stat", ""));
      const ppid = parents.get(pid);
      if (ppid === undefined) {
        throw new Error("proc unavailable");
      }
      return `${pid} (bash cmd) S ${ppid} ${pid} ${pid} 0`;
    });
    killSpy.mockImplementation((() => true) as typeof process.kill);

    await withMockedPlatform("linux", async () => {
      signalProcessTree(5555, "SIGKILL", { detached: false });

      expect(killSpy).toHaveBeenCalledWith(5556, "SIGKILL");
      expect(killSpy).toHaveBeenCalledWith(5557, "SIGKILL");
      expect(killSpy).toHaveBeenCalledWith(5555, "SIGKILL");
      // Group kill stays forbidden: the child shares the gateway's group.
      expect(killSpy).not.toHaveBeenCalledWith(-5555, "SIGKILL");
      // An unrelated process must not be signaled.
      expect(killSpy).not.toHaveBeenCalledWith(6001, "SIGKILL");
    });
  });

  it("on Unix force-kills a descendant that outlived the root it was signaled with", async () => {
    // SIGTERM ends the shell but not the process it forked. That process is
    // reparented to init, so it can no longer be found from the root PID and
    // only the remembered identity keeps it reachable for the force phase.
    let rootAlive = true;
    const mockProcessTable = () => {
      const table = rootAlive
        ? [
            mockProcStat({ pid: 7010, ppid: 1, startToken: "100" }),
            mockProcStat({ pid: 7011, ppid: 7010, startToken: "200" }),
          ]
        : [mockProcStat({ pid: 7011, ppid: 1, startToken: "200" })];
      readdirSyncMock.mockReturnValue(table.map((entry) => String(entry.pid)));
      readFileSyncMock.mockImplementation((filePath: unknown) => {
        const pid = Number(String(filePath).replace("/proc/", "").replace("/stat", ""));
        const found = table.find((entry) => entry.pid === pid);
        if (!found) {
          throw new Error("proc unavailable");
        }
        return found.stat;
      });
    };
    mockProcessTable();
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 && pid === 7010 && !rootAlive) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("linux", async () => {
      killProcessTree(7010, { graceMs: 10, detached: false });
      expect(killSpy).toHaveBeenCalledWith(7011, "SIGTERM");

      // The shell exits on SIGTERM; its TERM-resistant child is reparented.
      rootAlive = false;
      mockProcessTable();
      await vi.advanceTimersByTimeAsync(10);

      expect(killSpy).toHaveBeenCalledWith(7011, "SIGKILL");
    });
  });

  it("on Unix never force-kills a remembered PID that another process has reused", async () => {
    let rootAlive = true;
    const mockProcessTable = () => {
      const table = rootAlive
        ? [
            mockProcStat({ pid: 7020, ppid: 1, startToken: "100" }),
            mockProcStat({ pid: 7021, ppid: 7020, startToken: "200" }),
          ]
        : // Same PID, different process: the original descendant is gone.
          [mockProcStat({ pid: 7021, ppid: 1, startToken: "999" })];
      readdirSyncMock.mockReturnValue(table.map((entry) => String(entry.pid)));
      readFileSyncMock.mockImplementation((filePath: unknown) => {
        const pid = Number(String(filePath).replace("/proc/", "").replace("/stat", ""));
        const found = table.find((entry) => entry.pid === pid);
        if (!found) {
          throw new Error("proc unavailable");
        }
        return found.stat;
      });
    };
    mockProcessTable();
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 && pid === 7020 && !rootAlive) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("linux", async () => {
      killProcessTree(7020, { graceMs: 10, detached: false });
      rootAlive = false;
      mockProcessTable();
      await vi.advanceTimersByTimeAsync(10);

      expect(killSpy).not.toHaveBeenCalledWith(7021, "SIGKILL");
    });
  });

  it("on Unix signals the descendants of a root whose PID a previous termination also used", async () => {
    // The first tree leaves a TERM-resistant child behind, so its root PID is
    // still remembered when an unrelated process reuses that PID. Reading the
    // stale memory as "this tree is already known" would skip discovery and
    // leak the new tree's own children, which is the bug this file exists for.
    let reused = false;
    const mockProcessTable = () => {
      const table = reused
        ? [
            mockProcStat({ pid: 7031, ppid: 1, startToken: "200" }),
            mockProcStat({ pid: 7030, ppid: 1, startToken: "555" }),
            mockProcStat({ pid: 7032, ppid: 7030, startToken: "300" }),
          ]
        : [
            mockProcStat({ pid: 7030, ppid: 1, startToken: "100" }),
            mockProcStat({ pid: 7031, ppid: 7030, startToken: "200" }),
          ];
      readdirSyncMock.mockReturnValue(table.map((entry) => String(entry.pid)));
      readFileSyncMock.mockImplementation((filePath: unknown) => {
        const pid = Number(String(filePath).replace("/proc/", "").replace("/stat", ""));
        const found = table.find((entry) => entry.pid === pid);
        if (!found) {
          throw new Error("proc unavailable");
        }
        return found.stat;
      });
    };
    mockProcessTable();
    killSpy.mockImplementation((() => true) as typeof process.kill);

    await withMockedPlatform("linux", async () => {
      killProcessTree(7030, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);

      reused = true;
      mockProcessTable();
      killSpy.mockClear();
      killProcessTree(7030, { graceMs: 10, detached: false });

      expect(killSpy).toHaveBeenCalledWith(7032, "SIGTERM");
      await vi.advanceTimersByTimeAsync(10);
      expect(killSpy).toHaveBeenCalledWith(7032, "SIGKILL");
    });
  });

  it("on Unix still force-kills a live root when process discovery is unavailable", async () => {
    // Neither procfs nor ps can enumerate here. Losing the escalation would
    // leave a child that ignored SIGTERM running for good.
    readdirSyncMock.mockImplementation(() => {
      throw new Error("proc unavailable");
    });
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "" });
    killSpy.mockImplementation((() => true) as typeof process.kill);

    await withMockedPlatform("linux", async () => {
      killProcessTree(7040, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);

      expect(killSpy).toHaveBeenCalledWith(7040, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(7040, "SIGKILL");
      expect(killSpy).not.toHaveBeenCalledWith(-7040, "SIGKILL");
    });
  });

  it("on Unix never re-signals a remembered descendant that has no start time", async () => {
    // `ps -eo pid=,ppid=` carries no start time. Two empty tokens must not
    // compare equal, or a PID reused during the grace window inherits the kill.
    let rootAlive = true;
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command !== "ps" || args[0] !== "-eo") {
        return { status: 1, stdout: "" };
      }
      if (args[1] === "pid=,ppid=,lstart=") {
        return { status: 1, stdout: "" };
      }
      return {
        status: 0,
        stdout: rootAlive ? "7050 1\n7051 7050\n" : "7051 1\n",
      };
    });
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 && pid === 7050 && !rootAlive) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("darwin", async () => {
      killProcessTree(7050, { graceMs: 10, detached: false });
      expect(killSpy).toHaveBeenCalledWith(7051, "SIGTERM");

      rootAlive = false;
      await vi.advanceTimersByTimeAsync(10);

      expect(killSpy).not.toHaveBeenCalledWith(7051, "SIGKILL");
    });
  });

  it("on Unix bounds the ps descendant probe with a signal the target cannot ignore", async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "" });
    killSpy.mockImplementation((() => true) as typeof process.kill);

    await withMockedPlatform("darwin", async () => {
      signalProcessTree(7030, "SIGKILL", { detached: false });
    });

    // `timeout` alone only signals the child and keeps waiting for it to exit.
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "ps",
      ["-eo", "pid=,ppid=,lstart="],
      expect.objectContaining({ killSignal: "SIGKILL", timeout: 500 }),
    );
  });

  it("on Unix uses group kill when the omitted option resolves to a group leader", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -6666 && signal === 0) {
        throw new Error("ESRCH");
      }
      if (pid === 6666 && signal === 0) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("linux", async () => {
      mockIsProcessGroupLeader(6666);
      killProcessTree(6666, { graceMs: 10 });
      await vi.advanceTimersByTimeAsync(10);

      expect(killSpy).toHaveBeenCalledWith(-6666, "SIGTERM");
    });
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("ps ENOENT");
      },
    ],
    ["exits non-zero", () => ({ status: 1, stdout: "" })],
    ["returns non-numeric output", () => ({ status: 0, stdout: "not-a-pgid" })],
    ["returns empty output", () => ({ status: 0, stdout: "" })],
  ])("on Unix falls back to single-pid kill when ps %s", async (_label, psResult) => {
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("darwin", async () => {
      spawnSyncMock.mockImplementation(psResult);
      killProcessTree(8888, { graceMs: 10 });
      await vi.advanceTimersByTimeAsync(10);

      expect(killSpy).toHaveBeenCalledWith(8888, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-8888, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-8888, "SIGKILL");
    });
  });

  it("on Unix falls back to single-pid kill when ps returns different PGID", async () => {
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("linux", async () => {
      spawnSyncMock.mockImplementation((command: string, args: string[]) => {
        if (command === "ps" && args[0] === "-p" && args[2] === "-o" && args[3] === "pgid=") {
          const pid = Number.parseInt(args[1] ?? "", 10);
          if (pid === 9999) {
            return { status: 0, stdout: "12345\n" };
          }
        }
        return { status: 1, stdout: "" };
      });
      killProcessTree(9999, { graceMs: 10 });
      await vi.advanceTimersByTimeAsync(10);

      expect(killSpy).toHaveBeenCalledWith(9999, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-9999, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-9999, "SIGKILL");
    });
  });

  it("on Linux reads process-group ownership from procfs without spawning ps", async () => {
    killSpy.mockImplementation(() => true);
    readFileSyncMock.mockReturnValue("7777 (shell worker) S 1 7777 7777 0");

    await withMockedPlatform("linux", async () => {
      signalProcessTree(7777, "SIGTERM");

      expect(killSpy).toHaveBeenCalledWith(-7777, "SIGTERM");
      expect(spawnSyncMock).not.toHaveBeenCalled();
    });
  });

  it("on Unix sends a single requested tree signal without scheduling escalation", async () => {
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("linux", async () => {
      mockIsProcessGroupLeader(7777);
      signalProcessTree(7777, "SIGTERM");

      await vi.advanceTimersByTimeAsync(60_000);

      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenCalledWith(-7777, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-7777, "SIGKILL");
    });
  });

  it("on Windows maps requested tree signals to taskkill force mode", async () => {
    await withMockedPlatform("win32", async () => {
      signalProcessTree(8888, "SIGTERM");
      signalProcessTree(8888, "SIGKILL");

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expectTaskkillCall(0, ["/T", "/PID", "8888"]);
      expectTaskkillCall(1, ["/F", "/T", "/PID", "8888"]);
    });
  });

  it("on Windows exposes taskkill completion", async () => {
    const taskkillChild = new EventEmitter();
    spawnMock.mockReturnValueOnce(taskkillChild);

    await withMockedPlatform("win32", async () => {
      const completed = vi.fn();
      signalProcessTree(8989, "SIGKILL", { onComplete: completed });
      await Promise.resolve();
      expect(completed).not.toHaveBeenCalled();

      taskkillChild.emit("close", 0);
      await Promise.resolve();

      expect(completed).toHaveBeenCalledOnce();
      expectTaskkillCall(0, ["/F", "/T", "/PID", "8989"]);
    });
  });

  it("on Windows bounds taskkill completion when no event arrives", async () => {
    const taskkillChild = new EventEmitter();
    spawnMock.mockReturnValueOnce(taskkillChild);

    await withMockedPlatform("win32", async () => {
      const completed = vi.fn();
      signalProcessTree(9090, "SIGKILL", { onComplete: completed });

      await vi.advanceTimersByTimeAsync(2_999);
      expect(completed).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(completed).toHaveBeenCalledOnce();
      expectTaskkillCall(0, ["/F", "/T", "/PID", "9090"]);
    });
  });

  it("on Windows force-kills synchronously without delayed taskkill", async () => {
    await withMockedPlatform("win32", async () => {
      killProcessTree(9999, { force: true });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expectTaskkillCall(0, ["/F", "/T", "/PID", "9999"]);
    });
  });

  it("on Windows ignores async taskkill spawn errors", async () => {
    const taskkillChild = new EventEmitter();
    spawnMock.mockReturnValueOnce(taskkillChild);

    await withMockedPlatform("win32", async () => {
      killProcessTree(9191, { force: true });

      expect(() => taskkillChild.emit("error", new Error("spawn ENOENT"))).not.toThrow();
      expectTaskkillCall(0, ["/F", "/T", "/PID", "9191"]);
    });
  });
});
