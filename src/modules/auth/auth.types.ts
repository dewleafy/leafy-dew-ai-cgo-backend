export type AuthStatusResponse = {
  ok: true;
  /** True when APP_PASSWORD is set on the server, i.e. login is being enforced. */
  enabled: boolean;
  /** True when login is off, or the request carries a valid token. */
  authenticated: boolean;
};

export type AuthLoginResponse = {
  ok: true;
  enabled: boolean;
  token?: string;
  expiresAt?: string;
};
