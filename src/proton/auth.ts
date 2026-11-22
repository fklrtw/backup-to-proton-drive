import * as readline from 'node:readline/promises';
import { CryptoProxy, updateServerTime } from '@protontech/crypto';
import { Api as ProtonCryptoEndpointApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import { computeKeyPassword, getSrp } from '@protontech/crypto/srp';

import { formatProtonAppVersionHeader } from '../format.ts';
import type { StorageEncryptionOptions } from '../storageEncryption.ts';
import type { ApplicationConfiguration, PersistedSessionData } from '../types.ts';
import { loadSessionData, saveSessionData } from './sessionStore.ts';
import { generateTotpCode } from './totp.ts';

export { formatProtonAppVersionHeader } from '../format.ts';

/**
 * Raw Proton Core API user key schema returned by `GET /core/v4/users`.
 */
export interface ProtonUserKeyPayload {
  ID: string;
  PrivateKey: string;
  Primary: number;
  Active: number;
}

/**
 * Raw Proton Core API user profile returned by `GET /core/v4/users`.
 */
export interface ProtonUserPayload {
  ID: string;
  Email?: string;
  Name?: string;
  Keys: ProtonUserKeyPayload[];
}

/**
 * Raw Proton Core API key salt entry returned by `GET /core/v4/keys/salts`.
 */
interface ProtonKeySaltPayload {
  ID: string;
  KeySalt: string;
}

interface ProtonAuthInfoResponse {
  Code?: number;
  Error?: string;
  SSOChallengeToken?: string;
  Version?: number;
  Modulus?: string;
  ServerEphemeral?: string;
  Username?: string;
  Salt?: string;
  SRPSession?: string;
}

interface ProtonAuthLoginResponse {
  Code?: number;
  Error?: string;
  UID?: string;
  UserID?: string;
  ServerProof?: string;
  AccessToken?: string;
  RefreshToken?: string;
  Scopes?: string[];
  PasswordMode?: number;
  TwoFactor?: number;
  '2FA'?: {
    Enabled?: number;
    TOTP?: number;
  };
}

interface ProtonAuthRefreshResponse {
  Code?: number;
  Error?: string;
  UID?: string;
  AccessToken?: string;
  RefreshToken?: string;
}

interface ProtonUsersResponse {
  Code?: number;
  Error?: string;
  User?: ProtonUserPayload;
}

interface ProtonKeySaltsResponse {
  Code?: number;
  Error?: string;
  KeySalts?: ProtonKeySaltPayload[];
}

/**
 * Parameters passed to {@link ProtonSessionManager.authenticateWithCredentials}.
 */
export interface CredentialAuthenticationParameters {
  username: string;
  password: string;
  totpSecret?: string | undefined;
  mailboxPassword?: string | undefined;
  twoFactorCodeProvider?: (() => Promise<string>) | undefined;
  mailboxPasswordProvider?: (() => Promise<string>) | undefined;
}

let isProtonCryptoInitialized = false;

/**
 * Initializes the in-process `@protontech/crypto` OpenPGP backend and binds it to `CryptoProxy`.
 * Safe to call repeatedly; subsequent calls are no-ops.
 */
export async function initializeProtonCrypto(): Promise<void> {
  if (isProtonCryptoInitialized) {
    return;
  }

  ProtonCryptoEndpointApi.init({});
  CryptoProxy.setEndpoint(new ProtonCryptoEndpointApi(), async (cryptoEndpoint) => {
    await cryptoEndpoint.clearKeyStore();
  });
  isProtonCryptoInitialized = true;
}

/**
 * Releases the registered `@protontech/crypto` endpoint and clears private key material
 * stored in memory.
 */
export async function releaseProtonCrypto(): Promise<void> {
  if (!isProtonCryptoInitialized) {
    return;
  }
  try {
    await CryptoProxy.releaseEndpoint();
  } finally {
    isProtonCryptoInitialized = false;
  }
}

/**
 * Constructs standard Proton API headers including the mandatory `x-pm-appversion`
 * identification header and optional session credentials.
 *
 * @param appVersionHeader - Value for `x-pm-appversion`.
 * @param session - Optional active session UID and access token.
 * @returns Populated `Headers` object.
 */
export function createProtonApiHeaders(
  appVersionHeader: string,
  session?: { sessionUid: string; accessToken: string },
): Headers {
  const headers = new Headers({
    Accept: 'application/vnd.protonmail.v1+json',
    'x-pm-appversion': appVersionHeader,
  });

  if (session) {
    headers.set('x-pm-uid', session.sessionUid);
    headers.set('Authorization', `Bearer ${session.accessToken}`);
  }

  return headers;
}

/**
 * Synchronizes `@protontech/crypto`'s internal server clock from the HTTP `Date` response
 * header so OpenPGP signature checks do not fail on local clock skew.
 */
export function synchronizeServerTimeFromResponse(response: Response): void {
  const serverDateHeader = response.headers.get('date');
  if (!serverDateHeader) {
    return;
  }
  const parsedServerDate = new Date(serverDateHeader);
  if (!Number.isNaN(parsedServerDate.getTime())) {
    updateServerTime(parsedServerDate);
  }
}

/**
 * Prompts the user interactively on stdin/stdout, hiding typed characters when `hideInput`
 * is `true` and stdin is an interactive TTY.
 *
 * @param promptText - Prompt displayed to the user.
 * @param hideInput - Whether to mask echoed input (used for passwords and secrets).
 * @returns Entered text without trailing newline.
 */
async function promptTerminalInput(promptText: string, hideInput: boolean): Promise<string> {
  if (!hideInput || !process.stdin.isTTY) {
    const readlineInterface = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = await readlineInterface.question(promptText);
      return answer.trimEnd();
    } finally {
      readlineInterface.close();
    }
  }

  return new Promise((resolve, reject) => {
    process.stdout.write(promptText);
    const stdinStream = process.stdin;
    const wasRawMode = stdinStream.isRaw;
    stdinStream.setRawMode(true);
    stdinStream.resume();

    let enteredCharacters = '';

    const cleanup = () => {
      stdinStream.removeListener('data', onData);
      stdinStream.setRawMode(Boolean(wasRawMode));
      stdinStream.pause();
    };

    const onData = (dataChunk: Buffer) => {
      const chunkText = dataChunk.toString('utf8');
      for (const character of chunkText) {
        if (character === '\r' || character === '\n' || character === '\u0004') {
          cleanup();
          process.stdout.write('\n');
          resolve(enteredCharacters);
          return;
        }
        if (character === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(new Error('Interactive login cancelled by user.'));
          return;
        }
        if (character === '\u007f' || character === '\b') {
          if (enteredCharacters.length > 0) {
            enteredCharacters = enteredCharacters.slice(0, -1);
          }
          continue;
        }
        enteredCharacters += character;
      }
    };

    stdinStream.on('data', onData);
  });
}

/**
 * Manages Proton API authentication, SRP login, TOTP 2FA, two-password key unlocking,
 * atomic session persistence, and serialized access token refreshes.
 */
export class ProtonSessionManager {
  public readonly apiBaseUrl: string;
  public readonly appVersionHeader: string;
  private readonly sessionFilePath: string;
  private readonly storageEncryptionOptions: StorageEncryptionOptions;
  private readonly verbose: boolean;
  private sessionData: PersistedSessionData | null;
  private activeRefreshPromise: Promise<PersistedSessionData> | null = null;

  /**
   * Creates a session manager bound to an API host, app version string, session file,
   * and at-rest encryption configuration.
   */
  constructor(options: {
    apiBaseHost: string;
    applicationVersion: string;
    sessionFilePath: string;
    storageEncryptionOptions: StorageEncryptionOptions;
    verbose?: boolean | undefined;
    initialSession?: PersistedSessionData | null;
  }) {
    this.apiBaseUrl = `https://${options.apiBaseHost}`;
    this.appVersionHeader = formatProtonAppVersionHeader(options.applicationVersion);
    this.sessionFilePath = options.sessionFilePath;
    this.storageEncryptionOptions = options.storageEncryptionOptions;
    this.verbose = options.verbose ?? false;
    this.sessionData = options.initialSession ?? null;
  }

  /**
   * Emits a non-sensitive diagnostic line when `--verbose` is enabled.
   */
  public logVerbose(message: string): void {
    if (this.verbose) {
      console.log(`[verbose] ${message}`);
    }
  }

  /**
   * Returns the active session payload or throws if not authenticated yet.
   */
  public getRequiredSession(): PersistedSessionData {
    if (!this.sessionData) {
      throw new Error('No active Proton session is initialized.');
    }
    return this.sessionData;
  }

  /**
   * Performs an authenticated Proton Core JSON API request, automatically refreshing expired
   * access tokens once upon HTTP `401`.
   */
  public async fetchCoreJson<ResponsePayload>(
    endpointPath: string,
    options: {
      method?: 'GET' | 'POST';
      body?: object;
      abortSignal?: AbortSignal | undefined;
    } = {},
  ): Promise<ResponsePayload> {
    const method = options.method ?? 'GET';
    const requestUrl = `${this.apiBaseUrl}/${endpointPath.replace(/^\/+/, '')}`;

    const executeAttempt = async (): Promise<Response> => {
      const currentSession = this.getRequiredSession();
      const headers = createProtonApiHeaders(this.appVersionHeader, {
        sessionUid: currentSession.sessionUid,
        accessToken: currentSession.accessToken,
      });

      const requestInit: RequestInit = {
        method,
        headers,
      };
      if (options.abortSignal) {
        requestInit.signal = options.abortSignal;
      }
      if (options.body !== undefined) {
        headers.set('Content-Type', 'application/json');
        requestInit.body = JSON.stringify(options.body);
      }

      const response = await fetch(requestUrl, requestInit);
      synchronizeServerTimeFromResponse(response);
      return response;
    };

    let response = await executeAttempt();
    if (response.status === 401) {
      this.logVerbose(`Received HTTP 401 on ${method} ${endpointPath}; refreshing access token and retrying...`);
      await this.refreshAccessToken();
      response = await executeAttempt();
    }

    const payload = (await response.json()) as { Code?: number; Error?: string };
    this.logVerbose(
      `${method} ${requestUrl} -> HTTP ${response.status} (Code ${payload.Code ?? 'n/a'})`,
    );
    if (!response.ok || (payload.Code !== undefined && payload.Code !== 1000)) {
      throw new Error(
        `Proton API error on ${method} ${endpointPath} (HTTP ${response.status}, Code ${payload.Code ?? 'unknown'}): ${payload.Error ?? response.statusText}`,
      );
    }

    return payload as ResponsePayload;
  }

  /**
   * Refreshes the active Proton access token using the stored single-use refresh token.
   * Concurrent callers share a single in-flight network request to avoid revoking the token.
   */
  public async refreshAccessToken(): Promise<PersistedSessionData> {
    if (this.activeRefreshPromise) {
      return this.activeRefreshPromise;
    }

    const refreshTask = (async () => {
      this.logVerbose('Refreshing Proton access token via POST /core/v4/auth/refresh...');
      const currentSession = this.getRequiredSession();
      const headers = createProtonApiHeaders(this.appVersionHeader);
      headers.set('Content-Type', 'application/json');
      headers.set('x-pm-uid', currentSession.sessionUid);

      const response = await fetch(`${this.apiBaseUrl}/core/v4/auth/refresh`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ResponseType: 'token',
          GrantType: 'refresh_token',
          RefreshToken: currentSession.refreshToken,
        }),
      });
      synchronizeServerTimeFromResponse(response);

      const payload = (await response.json()) as ProtonAuthRefreshResponse;
      this.logVerbose(
        `POST ${this.apiBaseUrl}/core/v4/auth/refresh -> HTTP ${response.status} (Code ${payload.Code ?? 'n/a'})`,
      );
      if (!response.ok || payload.Code !== 1000 || !payload.AccessToken || !payload.RefreshToken) {
        throw new Error(
          `Failed to refresh Proton session token (HTTP ${response.status}, Code ${payload.Code ?? 'unknown'}): ${payload.Error ?? response.statusText}`,
        );
      }

      const updatedSession: PersistedSessionData = {
        ...currentSession,
        sessionUid: payload.UID ?? currentSession.sessionUid,
        accessToken: payload.AccessToken,
        refreshToken: payload.RefreshToken,
        savedAtIso: new Date().toISOString(),
      };

      this.sessionData = updatedSession;
      await saveSessionData(
        this.sessionFilePath,
        updatedSession,
        this.storageEncryptionOptions,
      );
      this.logVerbose(`Access token refreshed and persisted to ${this.sessionFilePath}`);
      return updatedSession;
    })();

    this.activeRefreshPromise = refreshTask;
    try {
      return await refreshTask;
    } finally {
      this.activeRefreshPromise = null;
    }
  }

  /**
   * Executes full SRP-6a authentication against Proton Core APIs, handles optional 2FA TOTP,
   * unlocks user keys to derive salted key passphrases, and persists the resulting session.
   *
   * @param credentials - Account username, password, and optional 2FA / mailbox password inputs.
   * @returns Newly authenticated and persisted {@link PersistedSessionData}.
   */
  public async authenticateWithCredentials(
    credentials: CredentialAuthenticationParameters,
  ): Promise<PersistedSessionData> {
    await initializeProtonCrypto();

    const baseHeaders = createProtonApiHeaders(this.appVersionHeader);
    baseHeaders.set('Content-Type', 'application/json');

    // Step 1: Fetch SRP challenge info.
    this.logVerbose(
      `Authenticating via ${this.apiBaseUrl}/core/v4/auth/info (appVersion=${this.appVersionHeader})`,
    );
    const authInfoResponse = await fetch(`${this.apiBaseUrl}/core/v4/auth/info`, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        Username: credentials.username,
        Intent: 'Proton',
      }),
    });
    synchronizeServerTimeFromResponse(authInfoResponse);

    const authInfoPayload = (await authInfoResponse.json()) as ProtonAuthInfoResponse;
    this.logVerbose(
      `POST ${this.apiBaseUrl}/core/v4/auth/info -> HTTP ${authInfoResponse.status} (Code ${authInfoPayload.Code ?? 'n/a'}, srpVersion=${authInfoPayload.Version ?? 'n/a'})`,
    );
    if (authInfoPayload.SSOChallengeToken) {
      throw new Error(
        'SSO-managed Proton accounts require SAML browser sign-in and cannot authenticate with SRP credentials.',
      );
    }
    if (
      !authInfoResponse.ok ||
      authInfoPayload.Code !== 1000 ||
      authInfoPayload.Version === undefined ||
      !authInfoPayload.Modulus ||
      !authInfoPayload.ServerEphemeral ||
      !authInfoPayload.Salt ||
      !authInfoPayload.SRPSession
    ) {
      throw new Error(
        `Proton auth/info failed (HTTP ${authInfoResponse.status}, Code ${authInfoPayload.Code ?? 'unknown'}): ${authInfoPayload.Error ?? authInfoResponse.statusText}`,
      );
    }

    // Step 2: Compute SRP-6a client ephemeral and proof.
    const srpProof = await getSrp(
      {
        Version: authInfoPayload.Version,
        Modulus: authInfoPayload.Modulus,
        ServerEphemeral: authInfoPayload.ServerEphemeral,
        ...(authInfoPayload.Username !== undefined ? { Username: authInfoPayload.Username } : {}),
        Salt: authInfoPayload.Salt,
      },
      {
        username: credentials.username,
        password: credentials.password,
      },
      authInfoPayload.Version,
    );

    // Step 3: Submit SRP proof and verify server proof.
    this.logVerbose('Submitting SRP proof via POST /core/v4/auth...');
    const authLoginResponse = await fetch(`${this.apiBaseUrl}/core/v4/auth`, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        Username: credentials.username,
        ClientEphemeral: srpProof.clientEphemeral,
        ClientProof: srpProof.clientProof,
        SRPSession: authInfoPayload.SRPSession,
      }),
    });
    synchronizeServerTimeFromResponse(authLoginResponse);

    const authLoginPayload = (await authLoginResponse.json()) as ProtonAuthLoginResponse;
    if (
      !authLoginResponse.ok ||
      authLoginPayload.Code !== 1000 ||
      !authLoginPayload.UID ||
      !authLoginPayload.AccessToken ||
      !authLoginPayload.RefreshToken ||
      !authLoginPayload.UserID
    ) {
      this.logVerbose(
        `POST ${this.apiBaseUrl}/core/v4/auth -> HTTP ${authLoginResponse.status} (Code ${authLoginPayload.Code ?? 'n/a'})`,
      );
      throw new Error(
        `Proton login failed (HTTP ${authLoginResponse.status}, Code ${authLoginPayload.Code ?? 'unknown'}): ${authLoginPayload.Error ?? authLoginResponse.statusText}`,
      );
    }

    if (authLoginPayload.ServerProof !== srpProof.expectedServerProof) {
      throw new Error('Proton server SRP proof verification failed; aborting authentication.');
    }

    const sessionUid = authLoginPayload.UID;
    const accessToken = authLoginPayload.AccessToken;
    const refreshToken = authLoginPayload.RefreshToken;

    // Step 4: Complete 2FA TOTP verification if required by the account.
    const twoFactorBitmap = authLoginPayload['2FA']?.Enabled ?? authLoginPayload.TwoFactor ?? 0;
    const hasTotpEnabled = (twoFactorBitmap & 1) !== 0;
    const hasFido2Only = (twoFactorBitmap & 2) !== 0 && !hasTotpEnabled;
    const needsTwoFactorScope =
      Array.isArray(authLoginPayload.Scopes) && authLoginPayload.Scopes.includes('twofactor');

    this.logVerbose(
      `POST ${this.apiBaseUrl}/core/v4/auth -> HTTP ${authLoginResponse.status} (passwordMode=${authLoginPayload.PasswordMode ?? 1}, hasTotp=${hasTotpEnabled}, hasFido2Only=${hasFido2Only}, needsTwoFactorScope=${needsTwoFactorScope})`,
    );

    if (hasTotpEnabled || needsTwoFactorScope) {
      if (hasFido2Only) {
        throw new Error(
          'This Proton account enforces FIDO2 hardware keys without TOTP. Enable an authenticator app (TOTP) in Proton settings for CLI/container login.',
        );
      }

      let twoFactorCode: string;
      if (credentials.totpSecret) {
        twoFactorCode = generateTotpCode(credentials.totpSecret);
      } else if (credentials.twoFactorCodeProvider) {
        twoFactorCode = await credentials.twoFactorCodeProvider();
      } else {
        throw new Error(
          'Proton account requires 2FA verification. Run interactive `login` or set PROTON_TOTP_SECRET (or PROTON_TOTP_SECRET_FILE).',
        );
      }

      this.logVerbose(
        `Submitting 2FA verification via POST /core/v4/auth/2fa (method=${credentials.totpSecret ? 'totp_secret' : 'interactive_prompt'})...`,
      );
      const twoFactorHeaders = createProtonApiHeaders(this.appVersionHeader, { sessionUid, accessToken });
      twoFactorHeaders.set('Content-Type', 'application/json');

      const twoFactorResponse = await fetch(`${this.apiBaseUrl}/core/v4/auth/2fa`, {
        method: 'POST',
        headers: twoFactorHeaders,
        body: JSON.stringify({
          TwoFactorCode: twoFactorCode.trim(),
        }),
      });
      synchronizeServerTimeFromResponse(twoFactorResponse);

      const twoFactorPayload = (await twoFactorResponse.json()) as { Code?: number; Error?: string };
      this.logVerbose(
        `POST ${this.apiBaseUrl}/core/v4/auth/2fa -> HTTP ${twoFactorResponse.status} (Code ${twoFactorPayload.Code ?? 'n/a'})`,
      );
      if (!twoFactorResponse.ok || twoFactorPayload.Code !== 1000) {
        throw new Error(
          `Proton 2FA verification failed (HTTP ${twoFactorResponse.status}, Code ${twoFactorPayload.Code ?? 'unknown'}): ${twoFactorPayload.Error ?? twoFactorResponse.statusText}`,
        );
      }
    }

    // Step 5: Resolve mailbox unlocking password for two-password accounts.
    let keyUnlockPassword = credentials.password;
    if (authLoginPayload.PasswordMode === 2) {
      this.logVerbose(
        `Unlocking keys using mailbox password (source=${credentials.mailboxPassword ? 'configured_secret' : 'interactive_prompt'})`,
      );
      if (credentials.mailboxPassword) {
        keyUnlockPassword = credentials.mailboxPassword;
      } else if (credentials.mailboxPasswordProvider) {
        keyUnlockPassword = await credentials.mailboxPasswordProvider();
      } else {
        throw new Error(
          'Proton account uses two-password mode. Run interactive `login` or set PROTON_MAILBOX_PASSWORD (or PROTON_MAILBOX_PASSWORD_FILE).',
        );
      }
    }

    // Step 6: Fetch user keys and salts, verify unlocking succeeds, and persist derived key passphrases.
    const provisionalSession: PersistedSessionData = {
      schemaVersion: 1,
      sessionUid,
      accessToken,
      refreshToken,
      userId: authLoginPayload.UserID,
      email: '',
      keyPassphrasesByKeyId: {},
      primaryKeyPassphrase: '',
      savedAtIso: new Date().toISOString(),
    };
    this.sessionData = provisionalSession;

    const usersResponse = await this.fetchCoreJson<ProtonUsersResponse>('core/v4/users');
    const saltsResponse = await this.fetchCoreJson<ProtonKeySaltsResponse>('core/v4/keys/salts');

    const userPayload = usersResponse.User;
    if (!userPayload) {
      throw new Error('Proton /core/v4/users response did not include a User object.');
    }

    const saltByKeyId = new Map<string, string>();
    for (const saltEntry of saltsResponse.KeySalts ?? []) {
      if (saltEntry.ID && saltEntry.KeySalt) {
        saltByKeyId.set(saltEntry.ID, saltEntry.KeySalt);
      }
    }

    const keyPassphrasesByKeyId: Record<string, string> = {};
    let primaryDerivedKeyPassphrase: string | null = null;
    let activeUserKeysCount = 0;
    let unlockedUserKeysCount = 0;

    for (const userKey of userPayload.Keys ?? []) {
      if (userKey.Active !== 1) {
        continue;
      }
      activeUserKeysCount++;
      const keySalt = saltByKeyId.get(userKey.ID);
      const computedPassphrase = keySalt
        ? await computeKeyPassword(keyUnlockPassword, keySalt)
        : keyUnlockPassword;

      keyPassphrasesByKeyId[userKey.ID] = computedPassphrase;
      if (userKey.Primary === 1 || primaryDerivedKeyPassphrase === null) {
        primaryDerivedKeyPassphrase = computedPassphrase;
      }

      try {
        await CryptoProxy.importPrivateKey({
          armoredKey: userKey.PrivateKey,
          passphrase: computedPassphrase,
        });
        unlockedUserKeysCount++;
      } catch {
        // Continue trying remaining active user keys; validate below.
      }
    }

    this.logVerbose(
      `Unlocked ${unlockedUserKeysCount}/${activeUserKeysCount} active Proton user key(s)`,
    );

    if ((userPayload.Keys?.length ?? 0) > 0 && unlockedUserKeysCount === 0) {
      throw new Error(
        'Failed to unlock Proton user private keys. Verify your password or mailbox password.',
      );
    }

    const finalSession: PersistedSessionData = {
      schemaVersion: 1,
      sessionUid,
      accessToken,
      refreshToken,
      userId: userPayload.ID ?? authLoginPayload.UserID,
      email: userPayload.Email ?? credentials.username,
      keyPassphrasesByKeyId,
      primaryKeyPassphrase: primaryDerivedKeyPassphrase ?? Object.values(keyPassphrasesByKeyId)[0] ?? '',
      savedAtIso: new Date().toISOString(),
    };

    this.sessionData = finalSession;
    await saveSessionData(this.sessionFilePath, finalSession, this.storageEncryptionOptions);
    this.logVerbose(`Persisted session file to ${this.sessionFilePath}`);
    return finalSession;
  }
}

/**
 * Interactive CLI login flow (`backup-to-proton-drive login`) prompting for credentials
 * and writing a persistent encrypted session file for subsequent unattended sync runs.
 *
 * @param configuration - Application configuration containing API host, encryption policy, and `sessionFilePath`.
 */
export async function runInteractiveLogin(configuration: ApplicationConfiguration): Promise<void> {
  const username =
    configuration.headlessCredentials.username ?? (await promptTerminalInput('Proton username or email: ', false));
  if (!username.trim()) {
    throw new Error('Proton username must not be empty.');
  }

  const password =
    configuration.headlessCredentials.password ?? (await promptTerminalInput('Proton password: ', true));
  if (!password) {
    throw new Error('Proton password must not be empty.');
  }

  const storageEncryptionOptions: StorageEncryptionOptions = {
    encryptionKey: configuration.dataEncryptionKey,
    allowPlaintext: configuration.allowPlaintextState,
  };

  const sessionManager = new ProtonSessionManager({
    apiBaseHost: configuration.apiBaseHost,
    applicationVersion: configuration.applicationVersion,
    sessionFilePath: configuration.sessionFilePath,
    storageEncryptionOptions,
    verbose: configuration.verbose,
  });

  const savedSession = await sessionManager.authenticateWithCredentials({
    username: username.trim(),
    password,
    totpSecret: configuration.headlessCredentials.totpSecret,
    mailboxPassword: configuration.headlessCredentials.mailboxPassword,
    twoFactorCodeProvider: async () => {
      const code = await promptTerminalInput('Proton 2FA TOTP code: ', false);
      return code.trim();
    },
    mailboxPasswordProvider: async () => {
      const mailboxPassword = await promptTerminalInput('Proton mailbox password: ', true);
      return mailboxPassword;
    },
  });

  console.log(`Authenticated as ${savedSession.email}. Session saved to ${configuration.sessionFilePath}`);
}

/**
 * Ensures an authenticated {@link ProtonSessionManager} is ready for sync execution:
 * 1. Reuses and validates a persisted session file (refreshing tokens automatically if expired).
 * 2. Falls back to headless credential login when `PROTON_USERNAME` and `PROTON_PASSWORD`
 *    (or `*_FILE` Docker secrets) are supplied.
 *
 * @param configuration - Validated application configuration.
 * @returns Ready-to-use {@link ProtonSessionManager}.
 */
export async function ensureAuthenticatedSession(
  configuration: ApplicationConfiguration,
): Promise<ProtonSessionManager> {
  await initializeProtonCrypto();

  const storageEncryptionOptions: StorageEncryptionOptions = {
    encryptionKey: configuration.dataEncryptionKey,
    allowPlaintext: configuration.allowPlaintextState,
  };

  const existingSession = await loadSessionData(
    configuration.sessionFilePath,
    storageEncryptionOptions,
  );
  if (existingSession) {
    const sessionManager = new ProtonSessionManager({
      apiBaseHost: configuration.apiBaseHost,
      applicationVersion: configuration.applicationVersion,
      sessionFilePath: configuration.sessionFilePath,
      storageEncryptionOptions,
      verbose: configuration.verbose,
      initialSession: existingSession,
    });
    sessionManager.logVerbose(
      `Loaded persisted session from ${configuration.sessionFilePath}; validating via GET /core/v4/users...`,
    );

    try {
      await sessionManager.fetchCoreJson<ProtonUsersResponse>('core/v4/users');
      sessionManager.logVerbose('Existing session validated successfully');
      return sessionManager;
    } catch (sessionValidationError: unknown) {
      const hasHeadlessFallback =
        Boolean(configuration.headlessCredentials.username) &&
        Boolean(configuration.headlessCredentials.password);
      if (!hasHeadlessFallback) {
        const reason =
          sessionValidationError instanceof Error
            ? sessionValidationError.message
            : String(sessionValidationError);
        throw new Error(
          `Persisted session in ${configuration.sessionFilePath} is invalid or expired (${reason}). Re-run the "login" command or configure PROTON_USERNAME and PROTON_PASSWORD.`,
        );
      }
      sessionManager.logVerbose(
        'Existing session validation failed; falling back to configured headless credentials...',
      );
    }
  } else if (configuration.verbose) {
    console.log(
      `[verbose] No persisted session found at ${configuration.sessionFilePath}; checking headless credentials...`,
    );
  }

  const { username, password, totpSecret, mailboxPassword } = configuration.headlessCredentials;
  if (!username || !password) {
    throw new Error(
      `No valid session found at ${configuration.sessionFilePath}. Run "login" interactively first, or provide PROTON_USERNAME and PROTON_PASSWORD (or *_FILE secrets) for headless login.`,
    );
  }

  const freshSessionManager = new ProtonSessionManager({
    apiBaseHost: configuration.apiBaseHost,
    applicationVersion: configuration.applicationVersion,
    sessionFilePath: configuration.sessionFilePath,
    storageEncryptionOptions,
    verbose: configuration.verbose,
  });

  await freshSessionManager.authenticateWithCredentials({
    username,
    password,
    totpSecret,
    mailboxPassword,
  });

  return freshSessionManager;
}
