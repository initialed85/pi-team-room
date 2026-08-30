import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = await mkdtemp(join("/tmp", "pi-team-room-test-"));
const statePath = join(stateDir, "state.json");
process.env.PI_TEAM_ROOM_STATE = statePath;
process.env.PI_TEAM_ROOM_HEARTBEAT_MS = "25";
process.env.PI_TEAM_ROOM_WAKE = "1";
process.env.PI_TEAM_ROOM_AUTO_CHECKPOINT_MIN_MS = "1";

// Use Pi's own transpiler and bundled peer dependencies. The runtime network
// dependency is installed from package.json; only core Pi peers need wiring for
// the harness, which works with both the Linux and macOS Pi installs.
const piBin = execFileSync("sh", ["-lc", "command -v pi"], { encoding: "utf8" }).trim();
const piCli = realpathSync(piBin);
const piRoot = resolve(dirname(piCli), "../..");
const jitiPath = join(piRoot, "node_modules", "jiti", "lib", "jiti.mjs");
const bundledModules = join(piRoot, "node_modules");
const localModules = join(root, "node_modules");
let madeModulesLink = false;
const madePeerLinks = [];
if (!existsSync(localModules)) {
  await symlink(bundledModules, localModules, "dir");
  madeModulesLink = true;
} else {
  for (const [source, target] of [
    [join(bundledModules, "typebox"), join(localModules, "typebox")],
    [join(bundledModules, "@earendil-works", "pi-tui"), join(localModules, "@earendil-works", "pi-tui")],
  ]) {
    if (existsSync(target)) continue;
    await mkdir(dirname(target), { recursive: true });
    await symlink(source, target, "dir");
    madePeerLinks.push(target);
  }
}

try {
  const { createJiti } = await import(pathToFileURL(jitiPath).href);
  const jiti = createJiti(import.meta.url);
  const extension = await jiti.import(join(root, "extension.ts"));

  function makePeer(id, name, idle = true, project = "/tmp/team-room") {
    const stub = {
      handlers: {},
      tools: {},
      commands: {},
      sendCalls: [],
      appendCalls: [],
      renderers: {},
      widgetCalls: [],
      on(event, handler) { this.handlers[event] = handler; },
      registerTool(tool) { this.tools[tool.name] = tool; },
      registerCommand(command, definition) { this.commands[command] = definition; },
      registerEntryRenderer(type, renderer) { this.renderers[type] = renderer; },
      appendEntry(type, data) { this.appendCalls.push({ type, data }); },
      async sendMessage(message, options) { this.sendCalls.push({ message, options }); },
      async exec(command, args) {
        if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: `${project}\n`, stderr: "" };
        if (command === "git" && args[0] === "branch") return { code: 0, stdout: "main\n", stderr: "" };
        return { code: 1, stdout: "", stderr: "" };
      },
    };
    extension.default(stub);
    stub.ctx = {
      cwd: project,
      hasUI: true,
      sessionManager: {
        getSessionId: () => id,
        getSessionName: () => name,
        getBranch: () => [],
      },
      isIdle: () => idle,
      ui: {
        notify() {},
        setWidget(widgetId, lines) { stub.widgetCalls.push({ widgetId, lines }); },
      },
    };
    return stub;
  }

  async function call(peer, params) {
    const result = await peer.tools.team_room.execute("test-call", params, undefined, undefined, peer.ctx);
    return result.content[0].text;
  }

  const alpha = makePeer("aaaaaaaa-1111-2222-3333-444444444444", "alpha", true, "/tmp/project-alpha");
  const bravo = makePeer("bbbbbbbb-1111-2222-3333-444444444444", "bravo", true, "/tmp/project-bravo");
  await alpha.handlers.session_start({}, alpha.ctx);
  assert.ok(alpha.widgetCalls.length > 0, "session start renders the live widget");
  assert.match(await call(alpha, { action: "focus", text: "auth refactor" }), /Focus updated/);
  assert.match(await call(alpha, { action: "update", text: "found the flaky test" }), /Shared/);

  // Project paths are labels only: peers in different repositories still share one room.
  await bravo.handlers.session_start({}, bravo.ctx);
  const pulse = await call(bravo, { action: "pulse" });
  assert.match(pulse, /alpha/);
  assert.match(pulse, /project-alpha/);
  assert.match(pulse, /flaky test/);

  assert.match(await call(bravo, { action: "ask", agent: "alpha", text: "which test is flaky?" }), /Question sent/);
  const injected = await alpha.handlers.before_agent_start({ systemPrompt: "BASE" }, alpha.ctx);
  assert.match(injected.systemPrompt, /^BASE/);
  assert.match(injected.systemPrompt, /which test is flaky/);
  assert.match(injected.systemPrompt, /untrusted teammate notes/);
  const alphaAfterPrompt = JSON.parse(readFileSync(statePath, "utf8")).sessions.find((session) => session.id === alpha.ctx.sessionManager.getSessionId());
  assert.equal(alphaAfterPrompt.focus, "auth refactor", "explicit focus survives the next prompt boundary");

  const inbox = await call(alpha, { action: "inbox" });
  const messageId = inbox.match(/\[question ([0-9a-f]{8})\]/)?.[1];
  assert.ok(messageId, "inbox includes a short message id");
  assert.match(await call(alpha, { action: "reply", messageId, text: "the refresh-token test" }), /Reply sent/);
  assert.match(await call(bravo, { action: "inbox" }), /refresh-token test/);

  await call(bravo, { action: "remember", text: "use vitest for team-room tests" });
  assert.match(await call(alpha, { action: "history", query: "vitest" }), /vitest/);

  // Direct questions wake idle peers, but do not interrupt a busy peer.
  const charlie = makePeer("cccccccc-1111-2222-3333-444444444444", "charlie", true, "/tmp/project-charlie");
  await charlie.handlers.session_start({}, charlie.ctx);
  await call(alpha, { action: "ask", agent: "charlie", text: "is the branch ready?" });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 140));
  const wake = charlie.sendCalls.find((entry) => entry.message?.content?.includes("is the branch ready"));
  assert.ok(wake, "idle peer receives an automatic wake");
  assert.equal(wake.message.customType, "pi-team-room-wake");
  assert.equal(wake.options.triggerTurn, true);
  assert.match(wake.message.content, /untrusted teammate note/);
  const stateAfterWake = JSON.parse(readFileSync(statePath, "utf8"));
  const wakeMessage = stateAfterWake.messages.find((message) => message.text === "is the branch ready?");
  assert.ok(wakeMessage?.deliveredAt, "wake marks the message delivered");
  assert.equal(wakeMessage.readAt, undefined, "wake leaves the message unread");
  assert.equal(charlie.sendCalls.filter((entry) => entry.message?.content?.includes("is the branch ready")).length, 1);

  const delta = makePeer("dddddddd-1111-2222-3333-444444444444", "delta", false, "/tmp/project-delta");
  await delta.handlers.session_start({}, delta.ctx);
  await call(alpha, { action: "ask", agent: "delta", text: "how far along are you?" });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 140));
  assert.equal(delta.sendCalls.length, 0, "busy peer is never interrupted");
  const stateAfterBusy = JSON.parse(readFileSync(statePath, "utf8"));
  const busyMessage = stateAfterBusy.messages.find((message) => message.text === "how far along are you?");
  assert.equal(busyMessage.deliveredAt, undefined, "busy peer message remains pending");

  // A terminal 🐈 message is delivered passively and cannot trigger a reply loop.
  const echo = makePeer("eeeeeeee-1111-2222-3333-444444444444", "echo", true, "/tmp/project-echo");
  await echo.handlers.session_start({}, echo.ctx);
  await call(alpha, { action: "ask", agent: "echo", text: "🐈" });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 140));
  assert.equal(echo.sendCalls.length, 0, "terminal signal does not wake a peer");
  const stateAfterDone = JSON.parse(readFileSync(statePath, "utf8"));
  const doneMessage = stateAfterDone.messages.find((message) => message.text === "🐈");
  assert.ok(doneMessage?.deliveredAt, "terminal signal is marked delivered");
  assert.equal((await call(echo, { action: "reply", messageId: doneMessage.id.slice(0, 8), text: "thanks" })).includes("do not reply"), true);

  // Summary cards, widgets, and shutdown breadcrumbs are durable/local UI behavior.
  await call(bravo, { action: "update", text: "bravo delivered the cross-project test" });
  await alpha.commands.team.handler("", alpha.ctx);
  assert.equal(alpha.appendCalls.at(-1)?.type, "pi-team-room-summary");
  assert.ok(alpha.renderers["pi-team-room-summary"], "summary entry renderer is registered");
  assert.ok(alpha.widgetCalls.at(-1)?.lines.some((line) => line.includes("cross-project test")));

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  await alpha.handlers.session_shutdown({}, alpha.ctx);
  assert.equal(alpha.widgetCalls.at(-1)?.lines, undefined, "shutdown clears the widget");
  const finalState = JSON.parse(readFileSync(statePath, "utf8"));
  const alphaState = finalState.sessions.find((session) => session.id === alpha.ctx.sessionManager.getSessionId());
  assert.match(alphaState.checkpoint.text, /^\[auto\]/, "shutdown leaves an automatic checkpoint");
  assert.equal(finalState.version, 1);
  assert.ok(finalState.messages.every((message) => message.id && message.kind && message.createdAt));

  await bravo.handlers.session_shutdown({}, bravo.ctx);
  await charlie.handlers.session_shutdown({}, charlie.ctx);
  await delta.handlers.session_shutdown({}, delta.ctx);
  await echo.handlers.session_shutdown({}, echo.ctx);
  // Let any heartbeat callbacks already in flight finish before removing the
  // temporary state directory.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  console.log("pi-team-room integration harness: PASS");
} finally {
  for (const link of madePeerLinks.reverse()) await rm(link, { recursive: true, force: true });
  if (madeModulesLink) await rm(localModules, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
}
