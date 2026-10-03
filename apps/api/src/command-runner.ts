import { spawn } from "node:child_process";
import { CommandError } from "./errors.js";

export interface CommandResult {
  executable: string;
  args: readonly string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: "ignore" | "inherit";
  displayOutput?: boolean;
  redactFailureOutput?: boolean;
  operatorPasswordPrompt?: boolean;
  operatorPromptSink?: (message: string) => void;
}

const OPERATOR_WAITING = "[thaw.fun] Waiting for a signer password prompt in this terminal (input is hidden).\n";
const OPERATOR_PROMPT = "[thaw.fun] Signer password or passphrase: ";

class PasswordPromptScanner {
  private pending = "";

  constructor(private readonly emit: (message: string) => void) {}

  accept(chunk: string): void {
    this.pending = (this.pending + chunk).slice(-512);
    const prompt = /\b(?:password|passphrase)\b[^\r\n]{0,100}[:?]/i.exec(this.pending);
    if (prompt) {
      this.emit(OPERATOR_PROMPT);
      this.pending = this.pending.slice(prompt.index + prompt[0].length);
    }
    const newline = Math.max(this.pending.lastIndexOf("\n"), this.pending.lastIndexOf("\r"));
    if (newline >= 0) this.pending = this.pending.slice(newline + 1);
  }
}

export interface CommandRunnerLike {
  run(executable: string, args: readonly string[], options?: RunOptions): Promise<CommandResult>;
}

export class CommandRunner implements CommandRunnerLike {
  run(executable: string, args: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const promptSink = options.operatorPromptSink ?? ((message: string) => process.stderr.write(message));
      const stdoutPrompt = options.operatorPasswordPrompt ? new PasswordPromptScanner(promptSink) : undefined;
      const stderrPrompt = options.operatorPasswordPrompt ? new PasswordPromptScanner(promptSink) : undefined;
      if (options.operatorPasswordPrompt) promptSink(OPERATOR_WAITING);
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs ?? 120_000);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
        stdoutPrompt?.accept(chunk);
        if (options.displayOutput) process.stdout.write(chunk);
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
        stderrPrompt?.accept(chunk);
        if (options.displayOutput) process.stderr.write(chunk);
      });
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0 || timedOut) {
          reject(new CommandError(executable, args, code, options.redactFailureOutput ? "" : stdout, options.redactFailureOutput ? "" : stderr, timedOut));
          return;
        }
        resolve({ executable, args, exitCode: code, stdout, stderr, durationMs: Date.now() - started });
      });
    });
  }
}
