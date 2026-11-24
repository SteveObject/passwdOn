// Chrome serializes this function into the active top-level document.
export function loginFields(expectedOrigin, credentials, expectedStatus) {
  if (location.origin !== expectedOrigin) return { status: "moved" };

  const fields = [...document.querySelectorAll("input")];
  const active = document.activeElement;
  const available = input => {
    const style = getComputedStyle(input);
    const { width, height } = input.getBoundingClientRect();
    return input.isConnected && !input.matches(":disabled") && !input.readOnly &&
      width > 0 && height > 0 && style.visibility === "visible" &&
      input.checkVisibility?.({ opacityProperty: true }) !== false &&
      !input.closest("[inert], [aria-hidden=true]");
  };
  const tokens = input => input.autocomplete.toLowerCase().split(/\s+/);
  const identifier = input => [input.name, input.id, input.getAttribute("aria-label")].join(" ");
  const usernameField = input => ["text", "email", "tel"].includes(input.type) &&
    !tokens(input).some(token => ["one-time-code", "new-password", "current-password"].includes(token)) &&
    !/\b(otp|captcha|verification)\b/i.test(identifier(input)) && available(input);
  const passwords = fields.filter(input => input.type === "password" && available(input));
  const isNewPassword = input => tokens(input).includes("new-password") ||
    /(new|confirm|repeat|verify)[_ -]*(pass(word)?|pwd)|(pass(word)?|pwd)[_ -]*(new|confirm|repeat|2)/i.test(identifier(input));

  const candidates = passwords.flatMap(password => {
    const related = fields.filter(input => input.form === password.form);
    const relatedPasswords = passwords.filter(input => input.form === password.form);
    if (relatedPasswords.some(isNewPassword) ||
        (relatedPasswords.length > 1 && !tokens(password).includes("current-password"))) {
      return [];
    }
    const before = related.slice(0, related.indexOf(password)).filter(usernameField);
    const username = before.findLast(input => tokens(input).includes("username")) ??
      before.findLast(input => /user|login|account|email|mail|identifier|账号|帐号|用户名|邮箱/i.test(identifier(input))) ??
      (password.form ? before.at(-1) : before.findLast(input => input.parentElement === password.parentElement));
    return [{ password, username }];
  });

  if (passwords.length === 0) {
    const usernames = fields.filter(input => usernameField(input) && tokens(input).includes("username"));
    for (const username of usernames) candidates.push({ username });
  }

  const focused = candidates.find(candidate => candidate.password === active || candidate.username === active);
  const target = focused ?? (candidates.length === 1 ? candidates[0] : null);
  if (!target) return { status: candidates.length ? "ambiguous" : "missing" };
  const status = target.password ? (target.username ? "login" : "password") : "username";
  if (!credentials) return { status };
  if (status !== expectedStatus) return { status: "changed" };

  const setInput = (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  // Fill only the selected document and avoid sending the password if username handling replaced the form.
  const form = target.password?.form;
  const filledUsername = target.username && credentials.username !== "";
  if (filledUsername) setInput(target.username, credentials.username);
  if (target.password) {
    if (location.origin !== expectedOrigin || !available(target.password) || target.password.form !== form ||
        target.password.type !== "password" || isNewPassword(target.password)) {
      return { status: "changed" };
    }
    setInput(target.password, credentials.password);
  }
  return { status: target.password && !filledUsername ? "password" : status };
}
