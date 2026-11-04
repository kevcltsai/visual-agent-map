// Drives one test-vault Obsidian instance over the Chrome DevTools Protocol.
// The `obsidian` CLI talks through a single per-user socket that the most recently launched instance takes over, so it
// cannot address several test instances. Each harness-launched profile instead exposes its own DevTools port, which
// Chromium records in <vault>/.vam-app/DevToolsActivePort. Nothing here focuses a window or touches the screen.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export const devToolsPortFile = vault => join(resolve(vault), ".vam-app", "DevToolsActivePort");

async function pageTarget(vault) {
  const file = devToolsPortFile(vault);
  if (!existsSync(file)) throw new Error(`No DevTools port for ${vault}. Launch it with the test harness (it adds --remote-debugging-port).`);
  const port = Number(readFileSync(file, "utf8").split("\n")[0]);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid DevTools port file: ${file}`);
  let targets;
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); }
  catch { throw new Error(`Obsidian for ${vault} is not answering on DevTools port ${port}; it may have quit.`); }
  const page = targets.find(target => target.type === "page" && target.url.startsWith("app://obsidian.md/index.html"));
  if (!page) throw new Error(`No Obsidian main window on DevTools port ${port}.`);
  return page;
}

// Waits until the instance answers and the vault's workspace has loaded.
export async function waitForInstance(vault, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const cdp = await connectCdp(vault);
      try { if (await cdp.evaluate("!!globalThis.app?.workspace?.layoutReady")) return; }
      finally { cdp.close(); }
    } catch (error) { last = error; }
    await delay(500);
  }
  throw new Error(`Timed out waiting for Obsidian on ${vault}: ${last?.message ?? "workspace not ready"}`);
}

const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const NAMED_KEYS = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" }, escape: { key: "Escape", code: "Escape", vk: 27 },
  tab: { key: "Tab", code: "Tab", vk: 9 }, backspace: { key: "Backspace", code: "Backspace", vk: 8 }, delete: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32, text: " " }, arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 }, arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 }, arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 }, end: { key: "End", code: "End", vk: 35 }, pageup: { key: "PageUp", code: "PageUp", vk: 33 }, pagedown: { key: "PageDown", code: "PageDown", vk: 34 }
};

// Turns "Mod+Enter" into the fields of Input.dispatchKeyEvent. `Mod` is Meta on darwin and Ctrl elsewhere. Unknown names throw.
export function parseKeyCombo(combo, platform = process.platform) {
  const parts = String(combo).split("+");
  const name = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    const lower = part.toLowerCase();
    const bit = lower === "mod" ? (platform === "darwin" ? MODIFIER_BITS.meta : MODIFIER_BITS.ctrl)
      : lower === "cmd" || lower === "meta" ? MODIFIER_BITS.meta : MODIFIER_BITS[lower === "control" ? "ctrl" : lower];
    if (!bit) throw new Error(`Unknown modifier "${part}" in key combo "${combo}".`);
    modifiers |= bit;
  }
  const named = NAMED_KEYS[name.toLowerCase()];
  if (named) return { key: named.key, code: named.code, windowsVirtualKeyCode: named.vk, modifiers, text: named.text ?? "" };
  const fn = /^F([1-9]|1[0-2])$/i.exec(name);
  if (fn) return { key: `F${fn[1]}`, code: `F${fn[1]}`, windowsVirtualKeyCode: 111 + Number(fn[1]), modifiers, text: "" };
  if (/^[a-z]$/i.test(name)) {
    const hasCommand = modifiers & (MODIFIER_BITS.ctrl | MODIFIER_BITS.meta);
    return { key: name, code: `Key${name.toUpperCase()}`, windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0), modifiers, text: hasCommand ? "" : name };
  }
  if (/^[0-9]$/.test(name)) {
    const hasCommand = modifiers & (MODIFIER_BITS.ctrl | MODIFIER_BITS.meta);
    return { key: name, code: `Digit${name}`, windowsVirtualKeyCode: name.charCodeAt(0), modifiers, text: hasCommand ? "" : name };
  }
  throw new Error(`Unknown key "${name}" in key combo "${combo}".`);
}

// Trusted (isTrusted) mouse and keyboard input; in-page dispatched events do not trigger Obsidian's or VAM's handlers.
export function createInput(send, platform = process.platform) {
  const mouse = (type, x, y) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  return {
    async click(x, y) {
      await mouse("mousePressed", x, y);
      await mouse("mouseReleased", x, y);
    },
    async press(combo) {
      const { key, code, windowsVirtualKeyCode, modifiers, text } = parseKeyCombo(combo, platform);
      const event = { key, code, windowsVirtualKeyCode, modifiers };
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event });
      if (text) await send("Input.dispatchKeyEvent", { type: "char", ...event, text, unmodifiedText: text });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
    }
  };
}

// Clicks the centre of the first element matching `selector` that has a size; throws (sending nothing) when none does.
export async function clickSelector(cdp, selector) {
  const point = await cdp.evaluate(`(()=>{for(const el of document.querySelectorAll(${JSON.stringify(selector)})){const r=el.getBoundingClientRect();if(r.width>0&&r.height>0)return {x:r.left+r.width/2,y:r.top+r.height/2}}return null})()`);
  if (!point) throw new Error(`No visible element matches selector: ${selector}`);
  await cdp.click(point.x, point.y);
  return point;
}

export async function connectCdp(vault) {
  const page = await pageTarget(vault);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = () => fail(new Error("DevTools connection failed.")); });
  let nextId = 0;
  const pending = new Map();
  const exceptions = [];
  const consoleMessages = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { done, fail } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) fail(new Error(message.error.message)); else done(message.result);
    } else if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      exceptions.push(details.exception?.description ?? details.text);
    } else if (message.method === "Runtime.consoleAPICalled") {
      const { type, args } = message.params;
      consoleMessages.push({ level: type, text: args.map(arg => arg.value ?? arg.description ?? "").join(" ") });
    }
  };
  const send = (method, params = {}) => new Promise((done, fail) => {
    const id = ++nextId;
    pending.set(id, { done, fail });
    socket.send(JSON.stringify({ id, method, params }));
  });
  // Enabling Runtime replays the exceptions and console messages buffered since the page started.
  await send("Runtime.enable");
  return {
    ...createInput(send),
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    },
    async screenshot(path) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(path, Buffer.from(data, "base64"));
      return path;
    },
    errors: () => [...exceptions],
    console: level => consoleMessages.filter(message => !level || message.level === level),
    clear() { exceptions.length = 0; consoleMessages.length = 0; },
    close: () => socket.close()
  };
}

// Leaves Restricted Mode for a harness vault without clicking "Trust author": that button reloads the window, which can
// bring Obsidian to the front. The leftover trust prompt is dismissed through its own cancel button so the Modal closes
// properly and pops its Escape keymap scope; removing only its DOM left that scope on top of the window stack, where it
// swallowed the view's shortcuts (the first ⌘Z did nothing). The result reports any scope still left behind.
export const trustExpression = `(async()=>{const depth=()=>app.keymap.getWindowStack(activeWindow).prevScopes.length;const before=depth();const prompts=app.plugins.isEnabled()?[]:[...document.querySelectorAll(".modal-container.mod-confirmation")].filter(m=>m.querySelector("button.mod-cancel"));prompts.forEach(m=>m.querySelector("button.mod-cancel").click());if(!app.plugins.isEnabled())await app.plugins.setEnable(true);for(const id of JSON.parse(await app.vault.adapter.read(app.vault.configDir+"/community-plugins.json")))if(!app.plugins.enabledPlugins.has(id))await app.plugins.enablePluginAndSave(id);const after=depth();return {enabled:[...app.plugins.enabledPlugins],prompts:document.querySelectorAll(".modal-container.mod-confirmation").length,scopesBefore:before,scopesAfter:after,leakedScopes:after-(before-prompts.length)}})()`;

// Throws when trusting left a prompt open or a keymap scope on the window stack, so a harness run never continues
// with shortcuts blocked.
export function assertTrusted(result) {
  if (result.prompts !== 0 || result.leakedScopes !== 0) throw new Error(`Trusting the vault left ${result.prompts} prompt(s) and ${result.leakedScopes} keymap scope(s) behind: ${JSON.stringify(result)}`);
  return result;
}

export const usage = `Usage: node scripts/obsidian-cdp.mjs --vault=<path> <command>
  wait                 wait until the instance answers and its workspace is ready
  trust                leave Restricted Mode and enable the vault's plugins
  eval <expression>    evaluate JavaScript in the app window (promises are awaited) and print the JSON value
  click <selector>     click the centre of the first visible element matching a CSS selector (trusted mouse input)
  key <combo>          press a key combo such as Mod+Enter, F2, Escape (Mod = Meta on macOS, Ctrl elsewhere)
  screenshot <file>    save a PNG of the app window without focusing it
  errors               print uncaught exceptions captured since the window loaded`;

async function cli(args) {
  const vaultArg = args.find(arg => arg.startsWith("--vault="));
  const [command, value] = args.filter(arg => !arg.startsWith("--vault="));
  if (!vaultArg || !command) throw new Error(usage);
  const vault = vaultArg.slice("--vault=".length);
  if (command === "wait") return waitForInstance(vault);
  const cdp = await connectCdp(vault);
  try {
    if (command === "eval" && value) return process.stdout.write(`${JSON.stringify(await cdp.evaluate(value))}\n`);
    if (command === "trust") return process.stdout.write(`${JSON.stringify(assertTrusted(await cdp.evaluate(trustExpression)))}\n`);
    if (command === "click" && value) return process.stdout.write(`${JSON.stringify(await clickSelector(cdp, value))}\n`);
    if (command === "key" && value) { await cdp.press(value); return process.stdout.write(`${value}\n`); }
    if (command === "screenshot" && value) return process.stdout.write(`${await cdp.screenshot(resolve(value))}\n`);
    if (command === "errors") {
      await delay(200);
      const errors = cdp.errors();
      return process.stdout.write(errors.length ? `${errors.join("\n")}\n` : "No errors captured.\n");
    }
    throw new Error(usage);
  } finally { cdp.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
