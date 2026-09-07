/** An error whose message is meant for the user, not a stack trace. */
export class CliError extends Error {
  constructor(message, { hint, code = 1 } = {}) {
    super(message);
    this.name = "CliError";
    this.hint = hint;
    this.code = code;
  }
}

export class AuthRequiredError extends CliError {
  constructor(message = "You are not signed in.") {
    super(message, { hint: "Run `powerfarm login` to authenticate.", code: 4 });
    this.name = "AuthRequiredError";
  }
}
