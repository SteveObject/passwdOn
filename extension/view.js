import { loadVault, lockVault, openVault } from "./vault.js";

export function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

export function showError(node, error) {
  node.textContent = error ? error.message || "操作失败，请重试。" : "";
  node.hidden = !error;
}

export function mountVault({ onOpen, onClose }) {
  const gate = document.querySelector("#gate");
  const lock = document.querySelector("#lock");
  const error = document.querySelector("#app-error");
  let expires;
  let timer;
  let state;

  function render(result) {
    clearTimeout(timer);
    if (result.state === "open") {
      state = "open";
      gate.hidden = true;
      gate.replaceChildren();
      lock.hidden = false;
      scheduleExpiry(result.until);
      onOpen(result.data);
      return;
    }
    expires = undefined;
    lock.hidden = true;
    onClose();
    if (state === result.state) return;
    state = result.state;
    gate.hidden = false;
    const creating = state === "new";
    const form = element("form");
    const label = element("label", null, "主密码");
    const password = element("input");
    password.type = "password";
    password.required = true;
    password.autocomplete = creating ? "new-password" : "current-password";
    label.append(password);
    form.append(label);
    let confirmation;
    if (creating) {
      const confirmLabel = element("label", null, "确认主密码");
      confirmation = element("input");
      confirmation.type = "password";
      confirmation.required = true;
      confirmation.autocomplete = "new-password";
      confirmLabel.append(confirmation);
      form.append(confirmLabel);
    }
    const submit = element("button", "primary", creating ? "创建密码库" : "解锁");
    submit.type = "submit";
    const formError = element("p", "error");
    formError.setAttribute("role", "alert");
    formError.hidden = true;
    form.append(submit, formError);
    gate.replaceChildren(
      element("h1", null, creating ? "创建本地密码库" : "解锁密码库"),
      element("p", "muted", creating ? "请选择至少 12 个字符的主密码。主密码无法找回。" : "输入主密码以访问此浏览器中保存的账号。"),
      form
    );
    if (!creating) password.focus();

    form.addEventListener("submit", async event => {
      event.preventDefault();
      showError(formError);
      if (creating && password.value !== confirmation.value) {
        showError(formError, new Error("两次输入的主密码不一致。"));
        return;
      }
      submit.disabled = true;
      try {
        render(await openVault(password.value, creating));
      } catch (failure) {
        showError(formError, failure);
      } finally {
        submit.disabled = false;
      }
    });
  }

  function scheduleExpiry(until) {
    expires = until;
    clearTimeout(timer);
    timer = setTimeout(checkExpiry, Math.max(0, until - Date.now()));
  }

  function checkExpiry() {
    if (state !== "open" || expires > Date.now()) return;
    // Drop rendered secrets immediately even if this page was suspended past the deadline.
    onClose();
    refresh();
  }

  async function refresh(touch = false) {
    try {
      const result = await loadVault({ refresh: touch });
      showError(error);
      render(result);
    } catch (failure) {
      state = undefined;
      lock.hidden = true;
      onClose();
      showError(error, failure);
    }
  }

  lock.addEventListener("click", async () => {
    try {
      await lockVault();
      await refresh();
    } catch (failure) {
      showError(error, failure);
    }
  });
  chrome.storage.session.onChanged.addListener(changes => {
    if (!changes.unlock || state !== "open") return;
    const session = changes.unlock.newValue;
    if (session) {
      scheduleExpiry(session.until);
    } else {
      onClose();
      refresh();
    }
  });
  document.addEventListener("visibilitychange", checkExpiry);
  return { refresh, render };
}
