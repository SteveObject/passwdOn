import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { matchingAccounts } from "../extension/vault.js";

const simulated = process.argv.includes("--simulate-extension");
const scoped = { origin: "https://app.example.com:8443" };
assert.deepEqual(matchingAccounts([scoped], scoped.origin + "/auth"), [scoped]);
for (const address of ["http://app.example.com:8443", "https://app.example.com", "https://app.example.com.other.test:8443"]) {
  assert.deepEqual(matchingAccounts([scoped], address), []);
}

async function waitFor(operation, description) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const result = await operation();
    if (result) return result;
    await delay(50);
  }
  throw new Error("Timed out waiting for " + description);
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const { id, result, error, method, params, sessionId } = JSON.parse(event.data);
    if (method) listeners.get(method)?.(params, sessionId);
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (error) entry.reject(new Error(entry.method + ": " + error.message));
    else entry.resolve(result);
  });
  const listeners = new Map();
  return {
    close: () => socket.close(),
    on: (method, handler) => listeners.set(method, handler),
    call(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { method, resolve, reject });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    }
  };
}

const profile = await mkdtemp(join(tmpdir(), "passwdon-test-"));
const extension = fileURLToPath(new URL("../extension", import.meta.url));
const fixture = createServer(async (request, response) => {
  if (simulated && request.headers.host.startsWith("vault.localhost:")) {
    const path = new URL(request.url, "http://localhost").pathname.slice(1);
    if (path === "test-chrome.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(`(${simulateChrome.toString()})();`);
      return;
    }
    const content = /^[\w-]+\.(html|js|css)$/.test(path) && await readFile(join(extension, path), "utf8").catch(() => null);
    if (!content) {
      response.writeHead(404).end();
      return;
    }
    if (path.endsWith(".html")) {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(content.replace("<head>", '<head><script src="/test-chrome.js"></script>'));
    } else {
      response.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : "text/css");
      response.end(content);
    }
    return;
  }
  const password = request.url === "/signup" ? "new-password" : "current-password";
  const fields = {
    "/identify": '<input id="user" autocomplete="username">',
    "/password": '<input id="pass" type="password" autocomplete="current-password">',
    "/change": '<input id="pass" type="password" autocomplete="current-password"><input type="password" autocomplete="new-password">'
  }[request.url] ?? `<input id="user" autocomplete="username"><input id="pass" type="password" autocomplete="${password}">`;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><title>Login fixture</title><form>${fields}<button>Sign in</button></form>`);
});
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
const port = fixture.address().port;
const origin = name => `http://${name}.localhost:${port}`;
const browser = spawn(process.env.CHROMIUM ?? "chromium", [
  "--headless", "--disable-dev-shm-usage", "--no-first-run",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  ...(simulated ? [] : ["--enable-unsafe-extension-debugging", `--load-extension=${extension}`]),
  ...(process.env.PASSWDON_CHROMIUM_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
  "about:blank"
], { stdio: ["ignore", "ignore", "ignore"] });
const exited = new Promise(resolve => {
  browser.once("exit", resolve);
  browser.once("error", resolve);
});
let cdp;

try {
  const portFile = await waitFor(async () => {
    if (browser.exitCode !== null) throw new Error("Chromium exited with code " + browser.exitCode);
    return readFile(join(profile, "DevToolsActivePort"), "utf8").catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  }, "Chromium debugger");
  const [debugPort, browserPath] = portFile.trim().split("\n");
  cdp = await connect(`ws://127.0.0.1:${debugPort}${browserPath}`);
  const targets = async () => (await cdp.call("Target.getTargets")).targetInfos;
  let extensionId;
  if (!simulated) {
    const { extensions } = await cdp.call("Extensions.getExtensions");
    extensionId = extensions.find(item => item.name === "passwdOn")?.id;
    assert.ok(extensionId, "Extension not loaded. Use Chromium with unpacked extensions enabled or pass --simulate-extension.");
  }
  const base = simulated ? origin("vault") : "chrome-extension://" + extensionId;
  let loginPage;
  if (simulated) {
    cdp.on("Runtime.bindingCalled", async ({ payload }, sessionId) => {
      const { func, args } = JSON.parse(payload);
      const result = await loginPage(`(${func})(...${JSON.stringify(args)})`);
      await cdp.call("Runtime.evaluate", { expression: `window.finishInjection(${JSON.stringify(result)})` }, sessionId);
    });
  }

  async function attach(targetId) {
    const { sessionId } = await cdp.call("Target.attachToTarget", { targetId, flatten: true });
    if (simulated) await cdp.call("Runtime.addBinding", { name: "injectIntoLoginPage" }, sessionId);
    return async expression => {
      const result = await cdp.call("Runtime.evaluate", {
        expression, awaitPromise: true, returnByValue: true
      }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
  }

  const { targetId: managerId } = await cdp.call("Target.createTarget", { url: base + "/manager.html" });
  const manager = await attach(managerId);
  const click = (page, selector) => page(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
  const visible = (page, selector) => page(`Boolean(document.querySelector(${JSON.stringify(selector)})?.checkVisibility())`);
  const master = "test master password only";
  await waitFor(() => visible(manager, "#gate form"), "setup form");
  await manager(`for (const input of document.querySelectorAll("#gate input")) input.value = ${JSON.stringify(master)};`);
  await click(manager, "#gate button");
  await waitFor(() => visible(manager, "#library"), "unlocked manager");

  await click(manager, "#new-group");
  await manager('document.querySelector("[name=name]").value = "内部工具"');
  await click(manager, "#save");
  await waitFor(() => manager('document.querySelector("#groups").textContent.includes("内部工具")'), "saved group");

  async function addAccount(title, host, password) {
    await click(manager, "#new-account");
    const values = { title, origin: origin(host) + "/login", username: "same-user", password };
    await manager(`
      for (const [name, value] of Object.entries(${JSON.stringify(values)})) {
        document.querySelector('[name="' + name + '"]').value = value;
      }
      document.querySelector("[name=groupId]").selectedIndex = 1;
    `);
    await click(manager, "#save");
    await waitFor(() => manager(`document.querySelector("#accounts").textContent.includes(${JSON.stringify(title)})`), "saved account");
  }

  await addAccount("站点 A", "a", "alpha-secret");
  await addAccount("站点 A 管理员", "a", "admin-secret");
  await addAccount("站点 B", "b", "beta-secret");

  const record = await manager('chrome.storage.local.get("vault").then(result => result.vault)');
  assert.equal(record.version, 1);
  assert.equal(typeof record.ciphertext, "string");
  assert.doesNotMatch(JSON.stringify(record), /same-user|secret|内部工具/);

  await click(manager, "#lock");
  await waitFor(() => visible(manager, "#gate input"), "lock screen");
  assert.equal(await manager('chrome.storage.session.get("unlock").then(result => result.unlock === undefined)'), true);
  await manager('document.querySelector("#gate input").value = "incorrect password"');
  await click(manager, "#gate button");
  await waitFor(() => visible(manager, "#gate .error"), "wrong password rejection");
  await manager(`document.querySelector("#gate input").value = ${JSON.stringify(master)}`);
  await click(manager, "#gate button");
  await waitFor(() => visible(manager, "#library"), "reopened vault");

  async function popupFor(url) {
    const { targetId } = await cdp.call("Target.createTarget", { url });
    const page = await attach(targetId);
    await waitFor(() => page('document.title === "Login fixture"'), "login fixture");
    let popupId;
    if (simulated) {
      loginPage = page;
      ({ targetId: popupId } = await cdp.call("Target.createTarget", { url: base + "/popup.html?" + encodeURIComponent(url) }));
    } else {
      await cdp.call("Target.activateTarget", { targetId });
      await cdp.call("Extensions.triggerAction", { id: extensionId, targetId });
      const popup = await waitFor(async () => (await targets()).find(item => item.url === base + "/popup.html"), "action popup");
      popupId = popup.targetId;
    }
    const panel = await attach(popupId);
    await waitFor(() => panel('document.querySelector("#detection")?.textContent.startsWith("已识别") || document.querySelector("#detection")?.textContent.startsWith("未识别")'), "login scan");
    return { panel, page, close: () => cdp.call("Target.closeTarget", { targetId: popupId }) };
  }

  const first = await popupFor(origin("a") + "/login");
  assert.deepEqual(await first.panel('[...document.querySelectorAll(".match strong")].map(item => item.textContent)'), ["站点 A", "站点 A 管理员"]);
  assert.equal(await first.page('document.querySelector("#pass").value'), "");
  await click(first.panel, ".match:nth-child(2)");
  await waitFor(() => first.page('document.querySelector("#pass").value === "admin-secret"'), "selected account fill");
  assert.equal(await first.page('document.querySelector("#user").value'), "same-user");
  await first.close();

  const second = await popupFor(origin("b") + "/login");
  assert.deepEqual(await second.panel('[...document.querySelectorAll(".match strong")].map(item => item.textContent)'), ["站点 B"]);
  await click(second.panel, ".match");
  await waitFor(() => second.page('document.querySelector("#pass").value === "beta-secret"'), "other subdomain fill");
  await second.close();

  const unknown = await popupFor(origin("c") + "/login");
  assert.equal(await unknown.panel('document.querySelectorAll(".match").length'), 0);
  await unknown.close();

  const signup = await popupFor(origin("a") + "/signup");
  assert.equal(await signup.panel('document.querySelectorAll(".match:enabled").length'), 0);
  assert.equal(await signup.page('document.querySelector("#pass").value'), "");
  await signup.close();

  const changePassword = await popupFor(origin("a") + "/change");
  assert.equal(await changePassword.panel('document.querySelectorAll(".match:enabled").length'), 0);
  await changePassword.close();

  const usernameStep = await popupFor(origin("b") + "/identify");
  await click(usernameStep.panel, ".match");
  await waitFor(() => usernameStep.page('document.querySelector("#user").value === "same-user"'), "username-only fill");
  await usernameStep.close();

  const passwordStep = await popupFor(origin("b") + "/password");
  await click(passwordStep.panel, ".match");
  await waitFor(() => passwordStep.page('document.querySelector("#pass").value === "beta-secret"'), "password-only fill");
  await passwordStep.close();

  await manager('[...document.querySelectorAll("#groups button")].find(button => button.textContent.includes("内部工具")).click()');
  await click(manager, "#edit-group");
  await manager('document.querySelector("[name=name]").value = "工作"');
  await click(manager, "#save");
  await waitFor(() => manager('document.querySelector("#group-title").textContent === "工作"'), "group rename");
  await click(manager, "#edit-group");
  await manager('window.confirm = () => true;');
  await click(manager, "#remove");
  await waitFor(() => manager('document.querySelector("#group-title").textContent === "未分组"'), "group removal");
  assert.equal(await manager('document.querySelectorAll(".account-row").length'), 3);

  console.log(`PASS (${simulated ? "simulated extension APIs" : "loaded extension"}): encrypted storage, lock/unlock, group management, same-site choice, origin isolation, login, signup, password changes and two-step forms`);
} finally {
  if (cdp) await Promise.race([cdp.call("Browser.close").catch(() => {}), exited, delay(1000)]);
  cdp?.close();
  if (!cdp) browser.kill();
  fixture.close();
  if (await Promise.race([exited.then(() => false), delay(1000, true)])) {
    browser.kill("SIGKILL");
    await exited;
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5 });
}

function simulateChrome() {
  function area(prefix) {
    const listeners = [];
    const fire = (key, value) => {
      for (const listener of listeners) listener({ [key]: { newValue: value } });
    };
    return {
      onChanged: { addListener: listener => listeners.push(listener) },
      async get(key) {
        const value = localStorage.getItem(prefix + key);
        return value === null ? {} : { [key]: JSON.parse(value) };
      },
      async set(data) {
        for (const [key, value] of Object.entries(data)) {
          localStorage.setItem(prefix + key, JSON.stringify(value));
          fire(key, value);
        }
      },
      async remove(key) {
        localStorage.removeItem(prefix + key);
        fire(key, undefined);
      }
    };
  }
  chrome.storage = { local: area("local:"), session: area("session:") };
  chrome.tabs = {
    query: async () => [{ id: 1, url: decodeURIComponent(location.search.slice(1)) }]
  };
  chrome.scripting = {
    executeScript({ func, args }) {
      return new Promise(resolve => {
        window.finishInjection = result => resolve([{ documentId: "test-document", result }]);
        injectIntoLoginPage(JSON.stringify({ func: func.toString(), args }));
      });
    }
  };
}
