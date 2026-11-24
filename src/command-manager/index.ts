export interface Command {
  execute(): void;
  undo(): void;
}

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
type CommandCtor = new (...args: any[]) => Command;

// biome-ignore lint/complexity/noBannedTypes: <explanation>
export class CommandManager<R extends Record<string, CommandCtor> = {}> {
  #commands = new Map<string, CommandCtor>();
  #undoStack: Command[] = [];
  #redoStack: Command[] = [];

  constructor(initialCommands: R = {} as R) {
    for (const [name, command] of Object.entries(initialCommands)) {
      this.#commands.set(name, command);
    }
  }

  registerCommand<K extends string, C extends CommandCtor>(
    name: K,
    command: C
  ): CommandManager<R & Record<K, C>> {
    this.#commands.set(name, command);
    return this as unknown as CommandManager<R & Record<K, C>>;
  }

  executeCommand<K extends keyof R & string>(name: K, ...args: ConstructorParameters<R[K]>): void {
    const Ctor = this.#commands.get(name);
    if (!Ctor) throw new Error(`Command "${name}" not found.`);

    const command = new Ctor(...args);
    command.execute(); // throws → not recorded
    this.#undoStack.push(command);
    this.#redoStack.length = 0; // new action invalidates redo
  }

  undo(): boolean {
    const command = this.#undoStack.pop();
    if (!command) return false;
    command.undo();
    this.#redoStack.push(command);
    return true;
  }

  redo(): boolean {
    const command = this.#redoStack.pop();
    if (!command) return false;
    command.execute();
    this.#undoStack.push(command);
    return true;
  }

  get canUndo(): boolean {
    return this.#undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.#redoStack.length > 0;
  }

  get commandNames(): (keyof R & string)[] {
    return [...this.#commands.keys()];
  }
}
