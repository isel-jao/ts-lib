import { describe, expect, it } from "vitest";
import { type Command, CommandManager } from "./index.js";

class Counter {
  value = 0;
}

class Increment implements Command {
  constructor(
    private counter: Counter,
    private amount = 1
  ) {}
  execute() {
    this.counter.value += this.amount;
  }
  undo() {
    this.counter.value -= this.amount;
  }
}

class Fail implements Command {
  execute(): void {
    throw new Error("boom");
  }
  undo() {}
}

const setup = () => {
  const counter = new Counter();
  const manager = new CommandManager({ increment: Increment });
  return { counter, manager };
};

describe("CommandManager", () => {
  describe("constructor", () => {
    it("starts empty with no arguments", () => {
      const manager = new CommandManager();
      expect(manager.commandNames).toEqual([]);
      expect(manager.canUndo).toBe(false);
      expect(manager.canRedo).toBe(false);
    });

    it("registers initial commands", () => {
      const manager = new CommandManager({ increment: Increment, fail: Fail });
      expect(manager.commandNames).toEqual(["increment", "fail"]);
    });
  });

  describe("registerCommand", () => {
    it("adds a command and returns the same manager", () => {
      const manager = new CommandManager();
      const result = manager.registerCommand("increment", Increment);
      expect(result).toBe(manager);
      expect(result.commandNames).toEqual(["increment"]);
    });

    it("supports chaining", () => {
      const manager = new CommandManager()
        .registerCommand("increment", Increment)
        .registerCommand("fail", Fail);
      expect(manager.commandNames).toEqual(["increment", "fail"]);
    });

    it("overwrites a command registered under the same name", () => {
      const counter = new Counter();
      const manager = new CommandManager({ increment: Increment });
      manager.registerCommand("increment", Fail);
      expect(() => manager.executeCommand("increment", counter)).toThrow("boom");
      expect(manager.commandNames).toEqual(["increment"]);
    });
  });

  describe("executeCommand", () => {
    it("constructs the command with the given args and executes it", () => {
      const { counter, manager } = setup();
      manager.executeCommand("increment", counter, 5);
      expect(counter.value).toBe(5);
      expect(manager.canUndo).toBe(true);
    });

    it("throws for an unknown command", () => {
      const manager = new CommandManager();
      // @ts-expect-error unknown command name
      expect(() => manager.executeCommand("missing")).toThrow('Command "missing" not found.');
    });

    it("does not record a command whose execute throws", () => {
      const manager = new CommandManager({ fail: Fail });
      expect(() => manager.executeCommand("fail")).toThrow("boom");
      expect(manager.canUndo).toBe(false);
    });

    it("clears the redo stack", () => {
      const { counter, manager } = setup();
      manager.executeCommand("increment", counter);
      manager.undo();
      expect(manager.canRedo).toBe(true);

      manager.executeCommand("increment", counter, 2);
      expect(manager.canRedo).toBe(false);
      expect(manager.redo()).toBe(false);
      expect(counter.value).toBe(2);
    });

    it("keeps the redo stack when execute throws", () => {
      const counter = new Counter();
      const manager = new CommandManager({ increment: Increment, fail: Fail });
      manager.executeCommand("increment", counter);
      manager.undo();

      expect(() => manager.executeCommand("fail")).toThrow("boom");
      expect(manager.canRedo).toBe(true);
    });
  });

  describe("undo", () => {
    it("returns false when there is nothing to undo", () => {
      const { manager } = setup();
      expect(manager.undo()).toBe(false);
    });

    it("undoes the last command and moves it to the redo stack", () => {
      const { counter, manager } = setup();
      manager.executeCommand("increment", counter, 3);
      expect(manager.undo()).toBe(true);
      expect(counter.value).toBe(0);
      expect(manager.canUndo).toBe(false);
      expect(manager.canRedo).toBe(true);
    });

    it("undoes commands in LIFO order", () => {
      const log: string[] = [];
      class Log implements Command {
        constructor(private id: string) {}
        execute() {
          log.push(`do ${this.id}`);
        }
        undo() {
          log.push(`undo ${this.id}`);
        }
      }
      const manager = new CommandManager({ log: Log });
      manager.executeCommand("log", "a");
      manager.executeCommand("log", "b");
      manager.undo();
      manager.undo();
      expect(log).toEqual(["do a", "do b", "undo b", "undo a"]);
    });
  });

  describe("redo", () => {
    it("returns false when there is nothing to redo", () => {
      const { manager } = setup();
      expect(manager.redo()).toBe(false);
    });

    it("re-executes the same command instance", () => {
      const instances: Command[] = [];
      class Tracked implements Command {
        executions = 0;
        constructor() {
          instances.push(this);
        }
        execute() {
          this.executions++;
        }
        undo() {}
      }
      const manager = new CommandManager({ tracked: Tracked });
      manager.executeCommand("tracked");
      manager.undo();
      manager.redo();
      expect(instances).toHaveLength(1);
      expect((instances[0] as Tracked).executions).toBe(2);
    });

    it("moves the command back to the undo stack", () => {
      const { counter, manager } = setup();
      manager.executeCommand("increment", counter, 4);
      manager.undo();
      expect(manager.redo()).toBe(true);
      expect(counter.value).toBe(4);
      expect(manager.canUndo).toBe(true);
      expect(manager.canRedo).toBe(false);
    });

    it("supports multiple undo/redo round trips", () => {
      const { counter, manager } = setup();
      manager.executeCommand("increment", counter, 1);
      manager.executeCommand("increment", counter, 10);
      manager.executeCommand("increment", counter, 100);

      manager.undo();
      manager.undo();
      expect(counter.value).toBe(1);

      manager.redo();
      expect(counter.value).toBe(11);

      manager.undo();
      manager.undo();
      expect(counter.value).toBe(0);
      expect(manager.canUndo).toBe(false);

      manager.redo();
      manager.redo();
      manager.redo();
      expect(counter.value).toBe(111);
      expect(manager.canRedo).toBe(false);
    });
  });
});
