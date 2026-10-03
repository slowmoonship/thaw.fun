import assert from "node:assert/strict";
import test from "node:test";
import { CommandRunner } from "../src/command-runner.js";
import { CommandError } from "../src/errors.js";

test("passes hostile-looking input as a literal argument without a shell", async () => {
  const value = "name; touch /tmp/never-executed-$(whoami)";
  const result = await new CommandRunner().run(process.execPath, ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", value]);
  assert.deepEqual(JSON.parse(result.stdout), [value]);
});

test("shows only a fixed operator hint for a fragmented signer prompt while retaining parseable stdout", async () => {
  const hints: string[] = [];
  const script = "process.stderr.write('Enter wallet pass'); setTimeout(() => { process.stderr.write('word: do-not-print-me\\n'); process.stdout.write('{\\\"result\\\":\\\"ok\\\"}'); }, 10)";
  const result = await new CommandRunner().run(process.execPath, ["-e", script], {
    operatorPasswordPrompt: true,
    operatorPromptSink: (hint) => { hints.push(hint); },
  });
  assert.deepEqual(JSON.parse(result.stdout), { result: "ok" });
  assert.equal(hints.length, 2);
  assert.match(hints[1]!, /Signer password or passphrase/);
  assert.ok(hints.every((hint) => !hint.includes("do-not-print-me") && !hint.includes("Enter wallet")));
});

test("redacts signer command output on failure", async () => {
  const hints: string[] = [];
  await assert.rejects(
    () => new CommandRunner().run(process.execPath, ["-e", "process.stderr.write('Password: do-not-print-me\\n'); process.exit(1)"], {
      operatorPasswordPrompt: true,
      operatorPromptSink: (hint) => { hints.push(hint); },
      redactFailureOutput: true,
    }),
    (error: unknown) => error instanceof CommandError && error.stderr === "" && error.stdout === "" && !error.message.includes("do-not-print-me"),
  );
  assert.ok(hints.every((hint) => !hint.includes("do-not-print-me")));
});
