import * as fs from 'node:fs';
import { Readable } from 'node:stream';
import {
  CryptoProxy,
  toPublicKeyReference,
  type PrivateKeyReference,
  type PublicKeyReference,
} from '@protontech/crypto';
import { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp } from '@protontech/crypto/srp';
import {
  DriveEventType,
  FeatureFlags,
  MemoryCache,
  NodeType,
  NullFeatureFlagProvider,
  OpenPGPCryptoWithCryptoProxy,
  ProtonDriveClient,
  type FeatureFlagProvider,
  type Logger,
  type MetricEvent,
  type NodeEntity,
  type ProtonDriveAccount,
  type ProtonDriveAccountAddress,
  type ProtonDriveClientContructorParameters,
  type ProtonDriveHTTPClient,
  type ProtonDriveHTTPClientBlobRequest,
  type ProtonDriveHTTPClientJsonRequest,
  type Telemetry,
} from '@protontech/drive-sdk';

import { inferMediaType } from '../format.ts';
import type {
  DriveTreeEvent,
  LocalFileEntry,
  ProtonDriveAdapter,
  RawRemoteNode,
} from '../types.ts';
import {
  createProtonApiHeaders,
  ProtonSessionManager,
  synchronizeServerTimeFromResponse,
  type ProtonUserKeyPayload,
  type ProtonUserPayload,
} from './auth.ts';

interface ProtonAddressKeyPayload {
  ID: string;
  PrivateKey?: string | null;
  Token?: string | null;
  Signature?: string | null;
  Primary: number;
  Active: number;
}

interface ProtonAddressPayload {
  ID: string;
  Email: string;
  Status: number;
  Send: number;
  Priority: number;
  Order: number;
  Keys?: ProtonAddressKeyPayload[];
}

interface ProtonAddressesResponse {
  Code?: number;
  Addresses?: ProtonAddressPayload[];
}

interface ProtonUsersApiResponse {
  Code?: number;
  User?: ProtonUserPayload;
}

interface ProtonPublicKeysResponse {
  Code?: number;
  Address?: {
    Keys?: Array<{
      PublicKey?: string;
    }>;
  } | null;
}

interface ProtonAuthModulusResponse {
  Code?: number;
  Modulus?: string;
  ModulusID?: string;
}

/**
 * Combines an optional caller `AbortSignal` with a per-request millisecond timeout signal.
 */
function combineRequestSignals(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) {
    return timeoutSignal;
  }
  return AbortSignal.any([signal, timeoutSignal]);
}

/**
 * Creates a lightweight telemetry adapter routing SDK logs appropriately without flooding
 * standard output during normal backup runs unless `DEBUG=1` is set.
 */
function createSdkTelemetry(isDebugEnabled: boolean): Telemetry<MetricEvent> {
  return {
    getLogger(loggerName: string): Logger {
      return {
        debug(message: string): void {
          if (isDebugEnabled) {
            console.debug(`[sdk:${loggerName}] ${message}`);
          }
        },
        info(message: string): void {
          if (isDebugEnabled) {
            console.info(`[sdk:${loggerName}] ${message}`);
          }
        },
        warn(message: string): void {
          console.warn(`[sdk:${loggerName}] ${message}`);
        },
        error(message: string, error?: unknown): void {
          if (error !== undefined) {
            console.error(`[sdk:${loggerName}] ${message}`, error);
          } else {
            console.error(`[sdk:${loggerName}] ${message}`);
          }
        },
      };
    },
    recordMetric(): void {
      // Metrics are intentionally kept local and not exported externally.
    },
  };
}

/**
 * Strips query parameters before logging a Proton API or storage URL so temporary URL tokens
 * or download parameters are never printed.
 *
 * @param rawUrl - Full request URL string.
 * @returns Sanitized `origin + pathname` string.
 */
function sanitizeUrlForLogging(rawUrl: string): string {
  try {
    const parsedUrl = new URL(rawUrl);
    return `${parsedUrl.origin}${parsedUrl.pathname}`;
  } catch {
    return rawUrl.split('?')[0] ?? rawUrl;
  }
}

/**
 * Creates a `ProtonDriveHTTPClient` backed by Node.js `fetch`, attaching Proton's required
 * `x-pm-appversion` header, synchronizing server clock headers, supporting both JSON and
 * multipart `FormData` payloads, and refreshing expired access tokens transparently on `401`.
 *
 * @param sessionManager - Active authenticated session manager.
 * @param verbose - Enables credential-safe HTTP request diagnostics.
 * @returns SDK-compatible {@link ProtonDriveHTTPClient}.
 */
export function createProtonHttpClient(
  sessionManager: ProtonSessionManager,
  verbose = false,
): ProtonDriveHTTPClient {
  return {
    async fetchJson(request: ProtonDriveHTTPClientJsonRequest): Promise<Response> {
      const sanitizedUrl = sanitizeUrlForLogging(request.url);
      const executeAttempt = async (): Promise<Response> => {
        const activeSession = sessionManager.getRequiredSession();
        const headers = new Headers(request.headers);
        headers.set('x-pm-appversion', sessionManager.appVersionHeader);
        headers.set('x-pm-uid', activeSession.sessionUid);
        headers.set('Authorization', `Bearer ${activeSession.accessToken}`);

        const requestInit: RequestInit = {
          method: request.method,
          headers,
          signal: combineRequestSignals(request.timeoutMs, request.signal),
        };

        if (request.json !== undefined) {
          requestInit.body = JSON.stringify(request.json);
        } else if (request.body !== undefined) {
          // Preserve FormData multipart boundary by never overwriting Content-Type manually.
          requestInit.body = request.body as BodyInit;
        }

        const response = await fetch(request.url, requestInit);
        synchronizeServerTimeFromResponse(response);
        if (verbose) {
          console.log(`[verbose] HTTP ${request.method} ${sanitizedUrl} -> ${response.status}`);
        }
        return response;
      };

      let response = await executeAttempt();
      if (response.status === 401) {
        if (verbose) {
          console.log(`[verbose] HTTP 401 on ${sanitizedUrl}, refreshing access token and retrying...`);
        }
        await sessionManager.refreshAccessToken();
        response = await executeAttempt();
      }
      return response;
    },

    async fetchBlob(request: ProtonDriveHTTPClientBlobRequest): Promise<Response> {
      const sanitizedUrl = sanitizeUrlForLogging(request.url);
      const headers = new Headers(request.headers);
      headers.set('x-pm-appversion', sessionManager.appVersionHeader);

      // Attach session auth only when targeting Proton's API host without a storage token.
      if (!headers.has('pm-storage-token') && request.url.startsWith(sessionManager.apiBaseUrl)) {
        const activeSession = sessionManager.getRequiredSession();
        headers.set('x-pm-uid', activeSession.sessionUid);
        headers.set('Authorization', `Bearer ${activeSession.accessToken}`);
      }

      const requestInit: RequestInit = {
        method: request.method,
        headers,
        signal: combineRequestSignals(request.timeoutMs, request.signal),
      };

      if (request.body !== undefined) {
        requestInit.body = request.body as BodyInit;
      }

      const response = await fetch(request.url, requestInit);
      synchronizeServerTimeFromResponse(response);
      if (verbose) {
        console.log(`[verbose] HTTP ${request.method} ${sanitizedUrl} -> ${response.status}`);
      }
      return response;
    },
  };
}

/**
 * Creates a `ProtonDriveAccount` implementation unlocking the user's Proton UserKeys
 * and AddressKeys via `@protontech/crypto` and resolving public keys for signature checks.
 *
 * @param sessionManager - Active authenticated session manager.
 * @returns SDK-compatible {@link ProtonDriveAccount}.
 */
export function createProtonDriveAccount(sessionManager: ProtonSessionManager): ProtonDriveAccount {
  let cachedUnlockedAddressesPromise: Promise<ProtonDriveAccountAddress[]> | null = null;
  const cachedPublicKeysByEmail = new Map<string, PublicKeyReference[]>();

  async function unlockUserKeys(userKeys: readonly ProtonUserKeyPayload[]): Promise<PrivateKeyReference[]> {
    const activeSession = sessionManager.getRequiredSession();
    const unlockedUserKeys: PrivateKeyReference[] = [];

    for (const userKey of userKeys) {
      if (userKey.Active !== 1 || !userKey.PrivateKey) {
        continue;
      }

      const passphrase =
        activeSession.keyPassphrasesByKeyId[userKey.ID] ?? activeSession.primaryKeyPassphrase;

      try {
        const importedUserKey = await CryptoProxy.importPrivateKey({
          armoredKey: userKey.PrivateKey,
          passphrase,
        });
        unlockedUserKeys.push(importedUserKey);
      } catch {
        // Skip keys that cannot be unlocked with the stored passphrase; validated if empty below.
      }
    }

    if (unlockedUserKeys.length === 0 && userKeys.some((userKey) => userKey.Active === 1)) {
      throw new Error('Failed to unlock any active Proton user private key.');
    }

    return unlockedUserKeys;
  }

  async function unlockAddressKey(
    addressKey: ProtonAddressKeyPayload,
    unlockedUserKeys: readonly PrivateKeyReference[],
  ): Promise<PrivateKeyReference | null> {
    if (addressKey.Active !== 1 || !addressKey.PrivateKey) {
      return null;
    }

    const activeSession = sessionManager.getRequiredSession();

    if (addressKey.Token) {
      const decryptionResult = await CryptoProxy.decryptMessage({
        armoredMessage: addressKey.Token,
        decryptionKeys: [...unlockedUserKeys],
        ...(addressKey.Signature
          ? {
              armoredSignature: addressKey.Signature,
              verificationKeys: [...unlockedUserKeys],
            }
          : {}),
        format: 'utf8',
      });

      return CryptoProxy.importPrivateKey({
        armoredKey: addressKey.PrivateKey,
        passphrase: decryptionResult.data,
      });
    }

    const candidatePassphrases = new Set<string>([
      activeSession.primaryKeyPassphrase,
      ...Object.values(activeSession.keyPassphrasesByKeyId),
    ]);

    for (const passphrase of candidatePassphrases) {
      try {
        return await CryptoProxy.importPrivateKey({
          armoredKey: addressKey.PrivateKey,
          passphrase,
        });
      } catch {
        // Try next candidate passphrase for legacy unsalted address keys.
      }
    }

    return null;
  }

  async function loadAllAddresses(): Promise<ProtonDriveAccountAddress[]> {
    const [usersResponse, addressesResponse] = await Promise.all([
      sessionManager.fetchCoreJson<ProtonUsersApiResponse>('core/v4/users'),
      sessionManager.fetchCoreJson<ProtonAddressesResponse>('core/v4/addresses'),
    ]);

    const userKeys = usersResponse.User?.Keys ?? [];
    const unlockedUserKeys = await unlockUserKeys(userKeys);

    const rawAddresses = (addressesResponse.Addresses ?? []).filter(
      (addressEntry) => addressEntry.Status === 1,
    );
    rawAddresses.sort((firstAddress, secondAddress) => {
      const priorityDifference = (firstAddress.Priority ?? firstAddress.Order) - (secondAddress.Priority ?? secondAddress.Order);
      return priorityDifference;
    });

    const unlockedAddresses: ProtonDriveAccountAddress[] = [];

    for (const addressEntry of rawAddresses) {
      const unlockedKeys: Array<{ id: string; key: PrivateKeyReference }> = [];
      let primaryKeyIndex = 0;

      for (const addressKey of addressEntry.Keys ?? []) {
        const unlockedKey = await unlockAddressKey(addressKey, unlockedUserKeys);
        if (!unlockedKey) {
          continue;
        }
        if (addressKey.Primary === 1) {
          primaryKeyIndex = unlockedKeys.length;
        }
        unlockedKeys.push({
          id: addressKey.ID,
          key: unlockedKey,
        });
      }

      if (unlockedKeys.length > 0) {
        unlockedAddresses.push({
          email: addressEntry.Email,
          addressId: addressEntry.ID,
          primaryKeyIndex,
          keys: unlockedKeys,
        });
      }
    }

    if (unlockedAddresses.length === 0) {
      throw new Error('No enabled Proton Drive address with unlocked private keys was found.');
    }

    return unlockedAddresses;
  }

  async function getUnlockedAddresses(): Promise<ProtonDriveAccountAddress[]> {
    if (!cachedUnlockedAddressesPromise) {
      cachedUnlockedAddressesPromise = loadAllAddresses().catch((loadError: unknown) => {
        cachedUnlockedAddressesPromise = null;
        throw loadError;
      });
    }
    return cachedUnlockedAddressesPromise;
  }

  return {
    async getOwnPrimaryAddress(): Promise<ProtonDriveAccountAddress> {
      const addresses = await getUnlockedAddresses();
      const primaryAddress = addresses[0];
      if (!primaryAddress) {
        throw new Error('No primary Proton address is available.');
      }
      return primaryAddress;
    },

    async getOwnAddresses(): Promise<ProtonDriveAccountAddress[]> {
      return getUnlockedAddresses();
    },

    async getOwnAddress(emailOrAddressId: string): Promise<ProtonDriveAccountAddress> {
      const addresses = await getUnlockedAddresses();
      const normalizedQuery = emailOrAddressId.toLowerCase();
      const matchingAddress = addresses.find(
        (addressEntry) =>
          addressEntry.addressId === emailOrAddressId ||
          addressEntry.email.toLowerCase() === normalizedQuery,
      );
      if (!matchingAddress) {
        throw new Error(`No own Proton address found matching "${emailOrAddressId}".`);
      }
      return matchingAddress;
    },

    async hasProtonAccount(email: string): Promise<boolean> {
      const publicKeys = await this.getPublicKeys(email);
      return publicKeys.length > 0;
    },

    async getPublicKeys(email: string, forceRefresh = false): Promise<PublicKeyReference[]> {
      const normalizedEmail = email.toLowerCase();
      if (!forceRefresh) {
        const cachedKeys = cachedPublicKeysByEmail.get(normalizedEmail);
        if (cachedKeys) {
          return cachedKeys;
        }
      }

      const ownAddresses = await getUnlockedAddresses();
      const matchingOwnAddress = ownAddresses.find(
        (addressEntry) => addressEntry.email.toLowerCase() === normalizedEmail,
      );
      if (matchingOwnAddress) {
        const ownPublicKeys = await Promise.all(
          matchingOwnAddress.keys.map((keyEntry) => toPublicKeyReference(keyEntry.key)),
        );
        cachedPublicKeysByEmail.set(normalizedEmail, ownPublicKeys);
        return ownPublicKeys;
      }

      const activeSession = sessionManager.getRequiredSession();
      const queryUrl = `${sessionManager.apiBaseUrl}/core/v4/keys/all?Email=${encodeURIComponent(email)}&InternalOnly=1`;

      let response = await fetch(queryUrl, {
        method: 'GET',
        headers: createProtonApiHeaders(sessionManager.appVersionHeader, {
          sessionUid: activeSession.sessionUid,
          accessToken: activeSession.accessToken,
        }),
      });
      synchronizeServerTimeFromResponse(response);

      if (response.status === 401) {
        const refreshedSession = await sessionManager.refreshAccessToken();
        response = await fetch(queryUrl, {
          method: 'GET',
          headers: createProtonApiHeaders(sessionManager.appVersionHeader, {
            sessionUid: refreshedSession.sessionUid,
            accessToken: refreshedSession.accessToken,
          }),
        });
        synchronizeServerTimeFromResponse(response);
      }

      if (!response.ok) {
        throw new Error(`Failed to fetch public keys for "${email}": HTTP ${response.status}`);
      }

      const payload = (await response.json()) as ProtonPublicKeysResponse;
      const armoredKeys = payload.Address?.Keys ?? [];
      const importedPublicKeys: PublicKeyReference[] = [];

      for (const keyEntry of armoredKeys) {
        if (!keyEntry.PublicKey) {
          continue;
        }
        try {
          const importedKey = await CryptoProxy.importPublicKey({ armoredKey: keyEntry.PublicKey });
          importedPublicKeys.push(importedKey);
        } catch {
          // Skip unparseable external keys safely.
        }
      }

      cachedPublicKeysByEmail.set(normalizedEmail, importedPublicKeys);
      return importedPublicKeys;
    },
  };
}

/**
 * Creates the `SRPModule` adapter required by `ProtonDriveClient` backed by
 * `@protontech/crypto/srp` and Proton's `/core/v4/auth/modulus` endpoint.
 */
export function createProtonSrpModule(
  sessionManager: ProtonSessionManager,
): ProtonDriveClientContructorParameters['srpModule'] {
  return {
    async getSrp(
      version: number,
      modulus: string,
      serverEphemeral: string,
      salt: string,
      password: string,
    ) {
      const proof = await getSrp(
        {
          Version: version,
          Modulus: modulus,
          ServerEphemeral: serverEphemeral,
          Salt: salt,
        },
        { password },
        version,
      );

      return {
        expectedServerProof: proof.expectedServerProof,
        clientProof: proof.clientProof,
        clientEphemeral: proof.clientEphemeral,
      };
    },

    async getSrpVerifier(password: string) {
      const modulusResponse =
        await sessionManager.fetchCoreJson<ProtonAuthModulusResponse>('core/v4/auth/modulus');
      if (!modulusResponse.Modulus || !modulusResponse.ModulusID) {
        throw new Error('Proton /core/v4/auth/modulus did not return Modulus and ModulusID.');
      }

      const verifier = await getRandomSrpVerifier({ Modulus: modulusResponse.Modulus }, { password });
      return {
        modulusId: modulusResponse.ModulusID,
        version: verifier.version,
        salt: verifier.salt,
        verifier: verifier.verifier,
      };
    },

    computeKeyPassword,
    generateKeySalt,
  };
}

/**
 * Converts a `@protontech/drive-sdk` `NodeEntity` into the sync engine's {@link RawRemoteNode}.
 */
function convertNodeEntityToRawNode(nodeEntity: NodeEntity): RawRemoteNode {
  const resolvedName = nodeEntity.name.ok ? nodeEntity.name.value : nodeEntity.name.error.name;
  const activeRevision = nodeEntity.activeRevision;
  const rawSha1 = activeRevision?.claimedDigests?.sha1;

  return {
    nodeUid: nodeEntity.uid,
    parentNodeUid: nodeEntity.parentUid ?? null,
    name: resolvedName,
    nodeType: nodeEntity.type === NodeType.Folder ? 'folder' : 'file',
    treeEventScopeId: nodeEntity.treeEventScopeId,
    isTrashed: Boolean(nodeEntity.trashTime),
    sha1Hash: rawSha1 ? rawSha1.toLowerCase() : null,
    sizeInBytes: activeRevision?.claimedSize ?? null,
    modificationTimeMs: (activeRevision?.claimedModificationTime ?? nodeEntity.modificationTime).getTime(),
  };
}

/**
 * Production implementation of {@link ProtonDriveAdapter} backed directly by `@protontech/drive-sdk`'s
 * `ProtonDriveClient`.
 */
export class SdkProtonDriveAdapter implements ProtonDriveAdapter {
  private readonly client: ProtonDriveClient;

  /**
   * Instantiates the Proton Drive SDK client from an authenticated {@link ProtonSessionManager}.
   */
  constructor(options: {
    sessionManager: ProtonSessionManager;
    apiBaseHost: string;
    enableSmallFileUpload?: boolean;
    debugLogging?: boolean;
  }) {
    const isDebugEnabled =
      Boolean(options.debugLogging) ||
      process.env.DEBUG === '1' ||
      process.env.LOG_LEVEL?.toLowerCase() === 'debug';

    const featureFlagProvider: FeatureFlagProvider = options.enableSmallFileUpload
      ? {
          isEnabled: async (flagName: FeatureFlags) => flagName === FeatureFlags.DriveSmallFileUpload,
        }
      : new NullFeatureFlagProvider();

    this.client = new ProtonDriveClient({
      httpClient: createProtonHttpClient(options.sessionManager, isDebugEnabled),
      entitiesCache: new MemoryCache(),
      cryptoCache: new MemoryCache(),
      account: createProtonDriveAccount(options.sessionManager),
      openPGPCryptoModule: new OpenPGPCryptoWithCryptoProxy(CryptoProxy),
      srpModule: createProtonSrpModule(options.sessionManager),
      featureFlagProvider,
      config: {
        baseUrl: options.apiBaseHost,
        language: 'en',
        clientUid: 'backup-to-proton-drive',
      },
      telemetry: createSdkTelemetry(isDebugEnabled),
    });
  }

  public async getMyFilesRootFolder(): Promise<RawRemoteNode> {
    const rootNode = await this.client.getMyFilesRootFolder();
    return convertNodeEntityToRawNode(rootNode);
  }

  public async listFolderChildren(
    parentNodeUid: string,
    abortSignal?: AbortSignal,
  ): Promise<RawRemoteNode[]> {
    const childUids: string[] = [];
    for await (const childNodeUid of this.client.iterateFolderChildrenNodeUids(
      parentNodeUid,
      undefined,
      abortSignal,
    )) {
      childUids.push(childNodeUid);
    }

    if (childUids.length === 0) {
      return [];
    }

    const childNodes: RawRemoteNode[] = [];
    for await (const maybeNode of this.client.iterateNodes(childUids, abortSignal)) {
      if ('missingUid' in maybeNode) {
        continue;
      }
      childNodes.push(convertNodeEntityToRawNode(maybeNode));
    }

    return childNodes;
  }

  public async getNodesByUids(
    nodeUids: string[],
    abortSignal?: AbortSignal,
  ): Promise<Map<string, RawRemoteNode | null>> {
    const resultByUid = new Map<string, RawRemoteNode | null>();
    if (nodeUids.length === 0) {
      return resultByUid;
    }

    for await (const maybeNode of this.client.iterateNodes(nodeUids, abortSignal)) {
      if ('missingUid' in maybeNode) {
        resultByUid.set(maybeNode.missingUid, null);
      } else {
        resultByUid.set(maybeNode.uid, convertNodeEntityToRawNode(maybeNode));
      }
    }

    return resultByUid;
  }

  public async getNodeHierarchy(nodeUid: string): Promise<RawRemoteNode[]> {
    const hierarchy = await this.client.getNodeHierarchy(nodeUid);
    return hierarchy.map(convertNodeEntityToRawNode);
  }

  public async getLatestEventId(treeEventScopeId: string, abortSignal?: AbortSignal): Promise<string> {
    // Calling iterateEvents without `lastEventId` immediately yields a FastForward event
    // containing the current head event cursor ID.
    for await (const driveEvent of this.client.iterateEvents(treeEventScopeId, undefined, abortSignal)) {
      if (driveEvent.type === DriveEventType.FastForward) {
        return driveEvent.eventId;
      }
    }
    throw new Error(`Unable to determine latest event ID for tree scope ${treeEventScopeId}.`);
  }

  public async *iterateEvents(
    treeEventScopeId: string,
    lastEventId: string,
    abortSignal?: AbortSignal,
  ): AsyncIterable<DriveTreeEvent> {
    for await (const driveEvent of this.client.iterateEvents(treeEventScopeId, lastEventId, abortSignal)) {
      if (driveEvent.type === DriveEventType.NodeCreated) {
        yield {
          type: 'node_created',
          nodeUid: driveEvent.nodeUid,
          parentNodeUid: driveEvent.parentNodeUid,
          isTrashed: driveEvent.isTrashed,
          eventId: driveEvent.eventId,
        };
      } else if (driveEvent.type === DriveEventType.NodeUpdated) {
        yield {
          type: 'node_updated',
          nodeUid: driveEvent.nodeUid,
          parentNodeUid: driveEvent.parentNodeUid,
          isTrashed: driveEvent.isTrashed,
          eventId: driveEvent.eventId,
        };
      } else if (driveEvent.type === DriveEventType.NodeDeleted) {
        yield {
          type: 'node_deleted',
          nodeUid: driveEvent.nodeUid,
          parentNodeUid: driveEvent.parentNodeUid,
          eventId: driveEvent.eventId,
        };
      } else if (driveEvent.type === DriveEventType.FastForward) {
        yield {
          type: 'fast_forward',
          eventId: driveEvent.eventId,
        };
      } else if (driveEvent.type === DriveEventType.TreeRefresh) {
        yield {
          type: 'tree_refresh',
          eventId: driveEvent.eventId,
        };
      } else if (driveEvent.type === DriveEventType.TreeRemove) {
        yield {
          type: 'tree_remove',
          eventId: driveEvent.eventId,
        };
      }
    }
  }

  public async createFolder(
    parentNodeUid: string,
    folderName: string,
    modificationTime?: Date,
  ): Promise<RawRemoteNode> {
    const createdFolder = await this.client.createFolder(parentNodeUid, folderName, modificationTime);
    return convertNodeEntityToRawNode(createdFolder);
  }

  public async uploadNewFile(
    parentNodeUid: string,
    localFile: LocalFileEntry,
    abortSignal?: AbortSignal,
  ): Promise<{ nodeUid: string; revisionUid: string }> {
    const fileUploader = await this.client.getFileUploader(
      parentNodeUid,
      localFile.relativePath.split('/').pop() ?? localFile.relativePath,
      {
        mediaType: inferMediaType(localFile.absolutePath),
        expectedSize: localFile.sizeInBytes,
        expectedSha1: localFile.sha1Hash,
        modificationTime: localFile.modificationTime,
        overrideExistingDraftByOtherClient: true,
      },
      abortSignal,
    );

    const fileReadStream = fs.createReadStream(localFile.absolutePath);
    const webReadableStream = Readable.toWeb(fileReadStream) as unknown as ReadableStream;
    try {
      const uploadController = await fileUploader.uploadFromStream(webReadableStream, []);
      const completionResult = await uploadController.completion();
      return {
        nodeUid: completionResult.nodeUid,
        revisionUid: completionResult.nodeRevisionUid,
      };
    } catch (uploadError) {
      fileReadStream.destroy();
      throw uploadError;
    }
  }

  public async uploadFileRevision(
    existingNodeUid: string,
    localFile: LocalFileEntry,
    abortSignal?: AbortSignal,
  ): Promise<{ nodeUid: string; revisionUid: string }> {
    const revisionUploader = await this.client.getFileRevisionUploader(
      existingNodeUid,
      {
        mediaType: inferMediaType(localFile.absolutePath),
        expectedSize: localFile.sizeInBytes,
        expectedSha1: localFile.sha1Hash,
        modificationTime: localFile.modificationTime,
        overrideExistingDraftByOtherClient: true,
      },
      abortSignal,
    );

    const fileReadStream = fs.createReadStream(localFile.absolutePath);
    const webReadableStream = Readable.toWeb(fileReadStream) as unknown as ReadableStream;
    try {
      const uploadController = await revisionUploader.uploadFromStream(webReadableStream, []);
      const completionResult = await uploadController.completion();
      return {
        nodeUid: completionResult.nodeUid,
        revisionUid: completionResult.nodeRevisionUid,
      };
    } catch (uploadError) {
      fileReadStream.destroy();
      throw uploadError;
    }
  }

  public async renameNode(nodeUid: string, newName: string): Promise<RawRemoteNode> {
    const renamedNode = await this.client.renameNode(nodeUid, newName);
    return convertNodeEntityToRawNode(renamedNode);
  }

  public async moveNode(
    nodeUid: string,
    newParentNodeUid: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    for await (const moveResult of this.client.moveNodes([nodeUid], newParentNodeUid, abortSignal)) {
      if (!moveResult.ok) {
        throw moveResult.error;
      }
    }
  }

  public async trashNodes(
    nodeUids: string[],
    abortSignal?: AbortSignal,
  ): Promise<Array<{ nodeUid: string; succeeded: boolean; errorMessage?: string | undefined }>> {
    if (nodeUids.length === 0) {
      return [];
    }

    const results: Array<{ nodeUid: string; succeeded: boolean; errorMessage?: string | undefined }> = [];
    for await (const trashResult of this.client.trashNodes(nodeUids, abortSignal)) {
      if (trashResult.ok) {
        results.push({ nodeUid: trashResult.uid, succeeded: true });
      } else {
        results.push({
          nodeUid: trashResult.uid,
          succeeded: false,
          errorMessage: trashResult.error.message,
        });
      }
    }
    return results;
  }
}
