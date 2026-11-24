const VAULT_KEY = "vault";
const SESSION_KEY = "unlock";
const IDLE_LIMIT = 10 * 60_000;
const ITERATIONS = 600_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const encode = bytes => btoa(String.fromCharCode(...bytes));
const decode = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));

async function deriveKey(password, salt) {
  const material = await crypto.subtle.importKey(
    "raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
    material, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
  );
}

async function encrypt(data, key, salt) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(data))
  );
  // Chunk the conversion so large vaults do not exceed the function argument limit.
  const bytes = new Uint8Array(ciphertext);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return { version: 1, salt, iv: encode(iv), ciphertext: btoa(binary) };
}

async function decrypt(record, key) {
  if (record.version !== 1) throw new Error("此扩展版本无法打开密码库。");
  const bytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decode(record.iv) }, key, decode(record.ciphertext)
  );
  return JSON.parse(decoder.decode(bytes));
}

async function saveSession(key, salt) {
  const raw = await crypto.subtle.exportKey("raw", key);
  const until = Date.now() + IDLE_LIMIT;
  await chrome.storage.session.set({ [SESSION_KEY]: { key: encode(new Uint8Array(raw)), salt, until } });
  return until;
}

async function readSession() {
  const { [VAULT_KEY]: record } = await chrome.storage.local.get(VAULT_KEY);
  const { [SESSION_KEY]: session } = await chrome.storage.session.get(SESSION_KEY);
  if (!record) return { state: "new" };
  if (session?.salt !== record.salt || session.until <= Date.now()) {
    if (session) await chrome.storage.session.remove(SESSION_KEY);
    return { state: "locked" };
  }
  const key = await crypto.subtle.importKey("raw", decode(session.key), "AES-GCM", true, ["encrypt", "decrypt"]);
  return { state: "open", record, key, session };
}

export async function loadVault({ refresh = false } = {}) {
  return navigator.locks.request(VAULT_KEY, async () => {
    const opened = await readSession();
    if (opened.state !== "open") return { state: opened.state };
    const { record, key, session } = opened;
    const data = await decrypt(record, key);
    const until = refresh ? await saveSession(key, record.salt) : session.until;
    return { state: "open", data, until };
  });
}

export async function openVault(password, creating = false) {
  return navigator.locks.request(VAULT_KEY, async () => {
    const { [VAULT_KEY]: record } = await chrome.storage.local.get(VAULT_KEY);
    if (creating) {
      if (record) throw new Error("密码库已创建，请重新打开扩展后解锁。");
      if ([...password].length < 12) throw new Error("主密码至少需要 12 个字符。");
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey(password, salt);
      const data = { groups: [], accounts: [] };
      await chrome.storage.local.set({ [VAULT_KEY]: await encrypt(data, key, encode(salt)) });
      return { state: "open", data, until: await saveSession(key, encode(salt)) };
    }
    if (!record) throw new Error("还没有密码库，请重新打开扩展并创建。");
    if (record.version !== 1) throw new Error("此扩展版本无法打开密码库。");
    const key = await deriveKey(password, decode(record.salt));
    let data;
    try {
      data = await decrypt(record, key);
    } catch {
      throw new Error("主密码不正确，或密码库已损坏。");
    }
    return { state: "open", data, until: await saveSession(key, record.salt) };
  });
}

export async function updateVault(change) {
  return navigator.locks.request(VAULT_KEY, async () => {
    const opened = await readSession();
    if (opened.state !== "open") throw new Error("密码库已锁定，请先解锁。");
    const { record, key } = opened;
    const data = await decrypt(record, key);
    change(data);
    await chrome.storage.local.set({ [VAULT_KEY]: await encrypt(data, key, record.salt) });
    return { state: "open", data, until: await saveSession(key, record.salt) };
  });
}

export function lockVault() {
  return navigator.locks.request(VAULT_KEY, () => chrome.storage.session.remove(SESSION_KEY));
}

export function siteOrigin(address) {
  try {
    const url = new URL(address);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.origin;
  } catch {
    // The caller displays the address validation error.
  }
  return null;
}

export function matchingAccounts(accounts, address) {
  const origin = siteOrigin(address);
  return origin ? accounts.filter(account => account.origin === origin) : [];
}
