import { loginFields } from "./login-fields.js";
import { loadVault, matchingAccounts, siteOrigin } from "./vault.js";
import { element, mountVault } from "./view.js";

const picker = document.querySelector("#picker");
const site = document.querySelector("#site");
const detection = document.querySelector("#detection");
const matches = document.querySelector("#matches");
const scanButton = document.querySelector("#scan");
const activeTabs = chrome.tabs.query({ active: true, currentWindow: true });

const messages = {
  login: "已识别登录字段。选择账号即可填入。",
  username: "已识别账号字段。进入密码步骤后可再次填入。",
  password: "已识别密码字段。选择账号即可填入。",
  ambiguous: "发现多个登录区域。请先点击要填入的字段，再打开扩展。",
  missing: "未识别到可填充的登录字段。",
  moved: "页面已切换，请关闭并重新打开扩展。",
  changed: "登录表单已变化，请重新识别后再填入。"
};

let scanId = 0;
const vault = mountVault({
  onOpen(data) {
    picker.hidden = false;
    scan(data);
  },
  onClose() {
    scanId += 1;
    picker.hidden = true;
    matches.replaceChildren();
    detection.textContent = "";
  }
});

document.querySelector("#manage").addEventListener("click", () => chrome.runtime.openOptionsPage());
scanButton.addEventListener("click", () => vault.refresh(true));

async function scan(data) {
  const id = ++scanId;
  matches.replaceChildren();
  detection.textContent = "正在识别登录字段…";
  try {
    const [tab] = await activeTabs;
    if (id !== scanId) return;
    const origin = siteOrigin(tab?.url);
    site.textContent = origin || "当前页面不可填充";
    scanButton.disabled = !origin;
    if (!origin) {
      detection.textContent = "请打开要登录的网页后再试。";
      return;
    }
    const accounts = matchingAccounts(data.accounts, origin);
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: loginFields, args: [origin]
    });
    if (id !== scanId) return;
    const status = probe.result?.status;
    detection.textContent = messages[status] || messages.missing;
    const canFill = ["login", "username", "password"].includes(status);
    if (accounts.length === 0) {
      matches.append(element("p", "empty", "此站点没有已保存的账号。"));
    }
    for (const { id: accountId, title, username, groupId } of accounts) {
      const group = data.groups.find(item => item.id === groupId);
      const button = element("button", "match");
      const details = element("span");
      details.append(element("strong", null, title || username), element("small", null, [username, group?.name].filter(Boolean).join(" · ")));
      button.append(details, element("span", null, "填入"));
      button.type = "button";
      button.disabled = !canFill || (status === "username" && !username);
      button.addEventListener("click", () => fill(tab.id, origin, probe.documentId, accountId, status));
      matches.append(button);
    }
  } catch {
    if (id === scanId) detection.textContent = "无法读取当前页面。请在普通网页上重新打开扩展。";
  }
}

let filling = false;

async function fill(tabId, origin, documentId, id, status) {
  if (filling || !documentId) return;
  filling = true;
  const currentScan = scanId;
  try {
    const current = await loadVault({ refresh: true });
    if (current.state !== "open") {
      vault.render(current);
      return;
    }
    const account = matchingAccounts(current.data.accounts, origin).find(item => item.id === id);
    if (!account) {
      vault.render(current);
      return;
    }
    if (currentScan !== scanId) return;
    const credentials = { username: account.username };
    if (status !== "username") credentials.password = account.password;
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId, documentIds: [documentId] },
      func: loginFields,
      args: [origin, credentials, status]
    });
    if (currentScan !== scanId) return;
    const result = injected.result?.status;
    detection.textContent = {
      login: "已填入账号和密码。",
      username: "已填入账号。进入密码步骤后可再次打开扩展。",
      password: "已填入密码。"
    }[result] || messages[result] || messages.missing;
  } catch {
    if (currentScan === scanId) detection.textContent = "页面可能已切换，请重新打开扩展再试。";
  } finally {
    filling = false;
  }
}

vault.refresh(true);
