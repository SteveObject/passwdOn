import { siteOrigin, updateVault } from "./vault.js";
import { element, mountVault, showError } from "./view.js";

const $ = selector => document.querySelector(selector);
const library = $("#library");
const groups = $("#groups");
const list = $("#accounts");
const search = $("#search");
const dialog = $("#editor");
const form = $("#edit-form");
const fields = $("#edit-fields");
const editError = $("#edit-error");
const remove = $("#remove");
const save = $("#save");
const cancel = $("#cancel");
const all = "all";
let selected = all;
let data;

const vault = mountVault({
  onOpen(next) {
    data = next;
    library.hidden = false;
    renderLibrary();
  },
  onClose() {
    data = undefined;
    library.hidden = true;
    if (dialog.open) dialog.close();
    fields.replaceChildren();
    search.value = "";
    groups.replaceChildren();
    list.replaceChildren();
    selected = all;
  }
});

function renderLibrary() {
  const group = data.groups.find(item => item.id === selected);
  if (!group && selected !== all) selected = null;
  $("#group-title").textContent = group?.name || (selected === all ? "全部账号" : "未分组");
  $("#edit-group").hidden = !group;
  groups.replaceChildren();
  for (const { id, name } of [{ id: all, name: "全部账号" }, { id: null, name: "未分组" }, ...data.groups]) {
    const count = data.accounts.filter(item => id === all || item.groupId === id).length;
    const button = element("button", "quiet", name + "  " + count);
    if (id === selected) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => {
      selected = id;
      renderLibrary();
      groups.querySelector('[aria-current="true"]').focus();
    });
    groups.append(button);
  }
  renderAccounts();
}

function renderAccounts() {
  const query = search.value.trim().toLocaleLowerCase();
  const visible = data.accounts.filter(account =>
    (selected === all || account.groupId === selected) &&
    [account.title, account.username, account.origin].some(value => value.toLocaleLowerCase().includes(query))
  );
  list.replaceChildren();
  for (const account of visible) {
    const group = data.groups.find(item => item.id === account.groupId);
    const row = element("div", "account-row");
    const summary = element("div");
    summary.append(
      element("strong", null, account.title || account.username),
      element("small", null, [account.origin, account.title && account.username, group?.name].filter(Boolean).join(" · "))
    );
    const button = element("button", "quiet", "编辑");
    button.setAttribute("aria-label", "编辑 " + (account.title || account.username));
    button.addEventListener("click", () => openEditor("account", account));
    row.append(summary, button);
    list.append(row);
  }
  if (visible.length === 0) {
    list.append(element("p", "empty", query ? "没有匹配的账号。" : "这个分组暂无账号。"));
  }
}

function addField(labelText, name, value, { type = "text", required = false, placeholder = "", hint } = {}) {
  const label = element("label", null, labelText);
  const input = element("input");
  Object.assign(input, { name, type, value, required, placeholder, spellcheck: false });
  input.autocomplete = type === "password" ? "new-password" : "off";
  label.append(input);
  if (hint) label.append(element("small", null, hint));
  if (type === "password") {
    const control = element("div", "password-control");
    const reveal = element("button", "quiet", "显示");
    reveal.type = "button";
    reveal.addEventListener("click", () => {
      const visible = input.type === "password";
      input.type = visible ? "text" : "password";
      reveal.textContent = visible ? "隐藏" : "显示";
    });
    control.append(label, reveal);
    fields.append(control);
  } else {
    fields.append(label);
  }
}

let edit;
function openEditor(kind, item) {
  edit = { kind, id: item?.id };
  const account = kind === "account";
  $("#editor-title").textContent = (item ? "编辑" : account ? "新增" : "新建") + (account ? "账号" : "分组");
  fields.replaceChildren();
  remove.hidden = !item;
  showError(editError);

  if (account) {
    addField("名称", "title", item?.title ?? "", { placeholder: "如 工作账号" });
    addField("站点地址", "origin", item?.origin ?? "", {
      type: "url", required: true, placeholder: "https://app.example.com",
      hint: "以协议、完整主机名和端口匹配。路径会自动忽略。"
    });
    addField("账号", "username", item?.username ?? "");
    addField("密码", "password", item?.password ?? "", { type: "password", required: true });
    const label = element("label", null, "分组");
    const select = element("select");
    select.name = "groupId";
    for (const group of [{ id: "", name: "未分组" }, ...data.groups]) {
      const option = element("option", null, group.name);
      option.value = group.id;
      select.append(option);
    }
    select.value = (item ? item.groupId : selected === all ? null : selected) ?? "";
    label.append(select);
    fields.append(label);
  } else {
    addField("分组名称", "name", item?.name ?? "", { required: true });
  }
  dialog.showModal();
}

function updateItem(draft, current, values) {
  const items = current.kind === "account" ? draft.accounts : draft.groups;
  const index = items.findIndex(item => item.id === current.id);
  if (current.id && index === -1) throw new Error("此条目已在另一个窗口删除。");
  if (current.kind === "group") {
    const name = values.get("name").trim();
    if (!name) throw new Error("请输入分组名称。");
    if (draft.groups.some(group => group.id !== current.id && group.name === name)) {
      throw new Error("已有同名分组。");
    }
    const group = { id: current.id || crypto.randomUUID(), name };
    if (index === -1) items.push(group);
    else items[index] = group;
    return;
  }

  const origin = siteOrigin(values.get("origin").trim());
  if (!origin) throw new Error("请输入有效的 HTTP 或 HTTPS 站点地址。");
  const title = values.get("title").trim();
  const username = values.get("username");
  if (!title && !username.trim()) throw new Error("请至少填写名称或账号。");
  const groupId = values.get("groupId") || null;
  if (groupId && !draft.groups.some(group => group.id === groupId)) {
    throw new Error("所选分组已删除，请重新选择分组。");
  }
  const account = { id: current.id || crypto.randomUUID(), title, origin, username, password: values.get("password"), groupId };
  if (index === -1) items.push(account);
  else items[index] = account;
}

async function change(callback) {
  if (save.disabled || !edit) return;
  save.disabled = true;
  remove.disabled = true;
  cancel.disabled = true;
  showError(editError);
  try {
    await updateVault(callback);
    if (dialog.open) dialog.close();
    await vault.refresh();
  } catch (error) {
    if (dialog.open) showError(editError, error);
  } finally {
    save.disabled = false;
    remove.disabled = false;
    cancel.disabled = false;
  }
}

form.addEventListener("submit", event => {
  event.preventDefault();
  const current = edit;
  const values = new FormData(form);
  change(draft => updateItem(draft, current, values));
});
remove.addEventListener("click", () => {
  const current = edit;
  const account = current.kind === "account";
  if (!confirm(account ? "删除此账号及其保存的密码？" : "删除此分组？分组内的账号将移到「未分组」。")) return;
  change(draft => {
    if (account) {
      draft.accounts = draft.accounts.filter(item => item.id !== current.id);
    } else {
      draft.groups = draft.groups.filter(item => item.id !== current.id);
      for (const item of draft.accounts) {
        if (item.groupId === current.id) item.groupId = null;
      }
    }
  });
});

dialog.addEventListener("close", () => {
  // A close event can arrive after a dialog has already been reopened.
  if (dialog.open) return;
  edit = undefined;
  fields.replaceChildren();
});
dialog.addEventListener("cancel", event => {
  if (save.disabled) event.preventDefault();
});
cancel.addEventListener("click", () => dialog.close());
$("#new-group").addEventListener("click", () => openEditor("group"));
$("#edit-group").addEventListener("click", () => openEditor("group", data.groups.find(group => group.id === selected)));
$("#new-account").addEventListener("click", () => openEditor("account"));
search.addEventListener("input", renderAccounts);
chrome.storage.local.onChanged.addListener(changes => {
  if (changes.vault && data) vault.refresh();
});
vault.refresh(true);
