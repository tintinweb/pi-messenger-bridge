/**
 * Self-cross-signing bootstrap for matrix-bot-sdk + @matrix-org/matrix-sdk-crypto-nodejs.
 *
 * Mirrors hermes/mautrix-python's pattern (gateway/platforms/matrix.py:775-826).
 * Two paths, depending on which credential the operator supplies:
 *
 * 1. RECOVERY-KEY path (preferred — preserves other @bot Element sessions):
 *    Given the SSSS recovery key from a prior Element-as-@bot "Set up Secure Backup",
 *    fetch the encrypted MSK/SSK/USK privates from the homeserver's account_data,
 *    decrypt them locally with the recovery key, import via
 *    OlmMachine.importSecretsFromSecretStorage (needs >=0.6.0 of the crypto binding),
 *    and POST the returned SignatureUploadRequest. The bot joins the existing
 *    Element-controlled cross-signing identity — no rotation of SSK/MSK on the
 *    homeserver, no orphaning of other @bot sessions.
 *
 * 2. RESET path (fallback — destroys any existing cross-signing on the account):
 *    Generate a fresh MSK/SSK/USK locally via OlmMachine.bootstrapCrossSigning(true),
 *    upload them via /keys/device_signing/upload (UIA via password file), then
 *    POST the device self-signature. The bot becomes the authoritative cross-signer
 *    for the account — useful for greenfield bots with no Element session of their own.
 *
 * If neither credential is supplied, a no-op check confirms an existing self-signature
 * on the homeserver and warns otherwise. Non-fatal by design — any failure leaves the
 * bridge running with an unverified device.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { MatrixClient } from "matrix-bot-sdk";
import { RustEngine } from "matrix-bot-sdk/lib/e2ee/RustEngine.js";
import { SecretStorageItems, SecretStorageKey } from "@matrix-org/matrix-sdk-crypto-nodejs";

// matrix-bot-sdk's RustEngine.processToDeviceRequest pulls txn_id / event_type
// out of `JSON.parse(request.body)`, but `@matrix-org/matrix-sdk-crypto-nodejs` >=
// 0.5.0 moved them out of the body onto the ToDeviceRequest object itself
// (request.txnId / request.eventType). Without this patch the bot-sdk passes
// undefined to client.sendToDevices, napi rejects with "Expect value to be String,
// but received Undefined", the whole sync loop blows up, and the bridge can't
// decrypt incoming messages even when megolm keys are available. Required as
// long as we pin crypto-nodejs >=0.5.0 via npm overrides while matrix-bot-sdk
// stays on its ^0.4.0 pin.
(function patchRustEngineForNewBindings() {
  const proto = (RustEngine as any).prototype;
  if (!proto || proto.__pi_xsign_patched) return;
  proto.processToDeviceRequest = async function (request: any) {
    const body = request.body ? JSON.parse(request.body) : {};
    const txnId = request.txnId ?? request.txn_id ?? body.txn_id;
    const eventType = request.eventType ?? request.event_type ?? body.event_type;
    const messages = body.messages;
    await this.actuallyProcessToDeviceRequest(txnId, eventType, messages);
  };
  proto.__pi_xsign_patched = true;
})();

export interface CrossSignOptions {
  /** Account password for UIA. If omitted, unauthenticated upload is attempted and
   *  failures are logged. Read from PI_MATRIX_ACCOUNT_PASSWORD or the file at
   *  PI_MATRIX_PASSWORD_FILE upstream of this call. Used only by the RESET path. */
  password?: string;
  /** SSSS recovery key (base58, as Element generates it during "Set up Secure Backup").
   *  When present, take the recovery-key import path instead of bootstrap+reset. Read
   *  from PI_MATRIX_RECOVERY_KEY or the file at PI_MATRIX_RECOVERY_KEY_FILE upstream. */
  recoveryKey?: string;
  /** Force a fresh cross-signing identity, invalidating prior trust. Default false.
   *  Ignored if recoveryKey is supplied. */
  reset?: boolean;
  /** Logger override. Defaults to console.{log,warn}. */
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

interface CrossSigningStatus {
  hasMaster: boolean;
  hasSelfSigning: boolean;
  hasUserSigning: boolean;
}

interface OutgoingRequest {
  id: string;
  type: number;
  body: string;
  // ToDeviceRequest extras
  eventType?: string;
  txnId?: string;
}

// Mirrors @matrix-org/matrix-sdk-crypto-nodejs's RequestType enum. Hardcoded to
// avoid taking a dependency on the internal binding (matrix-bot-sdk holds it).
const REQ_KEYS_UPLOAD = 0;
const REQ_KEYS_QUERY = 1;
const REQ_KEYS_CLAIM = 2;
const REQ_TO_DEVICE = 3;
const REQ_SIGNATURE_UPLOAD = 4;
const REQ_ROOM_MESSAGE = 5;
const REQ_KEYS_BACKUP = 6;

const REQ_NAME: Record<number, string> = {
  [REQ_KEYS_UPLOAD]: "KeysUpload",
  [REQ_KEYS_QUERY]: "KeysQuery",
  [REQ_KEYS_CLAIM]: "KeysClaim",
  [REQ_TO_DEVICE]: "ToDevice",
  [REQ_SIGNATURE_UPLOAD]: "SignatureUpload",
  [REQ_ROOM_MESSAGE]: "RoomMessage",
  [REQ_KEYS_BACKUP]: "KeysBackup",
};

/**
 * Read PI_MATRIX_ACCOUNT_PASSWORD, or the contents of the file at PI_MATRIX_PASSWORD_FILE
 * (default ~/.pi/pi-password.txt). Returns undefined if neither resolves to a non-empty
 * string. Refuses files with insecure perms.
 */
export function readAccountPassword(): string | undefined {
  return readSecret(
    "PI_MATRIX_ACCOUNT_PASSWORD",
    "PI_MATRIX_PASSWORD_FILE",
    path.join(os.homedir(), ".pi", "pi-password.txt"),
    "password"
  );
}

/**
 * Read PI_MATRIX_RECOVERY_KEY, or the contents of the file at PI_MATRIX_RECOVERY_KEY_FILE
 * (default ~/.pi/recovery-key.txt). Returns undefined if neither resolves to a non-empty
 * string. Refuses files with insecure perms.
 */
export function readRecoveryKey(): string | undefined {
  return readSecret(
    "PI_MATRIX_RECOVERY_KEY",
    "PI_MATRIX_RECOVERY_KEY_FILE",
    path.join(os.homedir(), ".pi", "recovery-key.txt"),
    "recovery key"
  );
}

function readSecret(envVar: string, fileEnvVar: string, defaultPath: string, label: string): string | undefined {
  const direct = process.env[envVar];
  if (direct && direct.trim()) return direct.trim();

  const filePath = process.env[fileEnvVar] || defaultPath;
  if (!fs.existsSync(filePath)) return undefined;

  try {
    const stats = fs.statSync(filePath);
    const mode = stats.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      console.warn(`[Matrix xsign] ${label} file ${filePath} has insecure perms ${mode.toString(8)} — refusing to read`);
      return undefined;
    }
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content || undefined;
  } catch (err) {
    console.warn(`[Matrix xsign] could not read ${label} file ${filePath}: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Drive bootstrapCrossSigning + drain outgoing requests on the bridge's own
 * OlmMachine. Idempotent: a no-op if the device is already cross-signed.
 */
export async function ensureSelfCrossSigned(
  client: MatrixClient,
  opts: CrossSignOptions = {}
): Promise<{ status: "skipped" | "already" | "bootstrapped"; reason?: string }> {
  const log = opts.log ?? ((m) => console.log(m));
  const warn = opts.warn ?? ((m) => console.warn(m));

  const machine = (client as any).crypto?.engine?.machine;
  if (!machine) {
    return { status: "skipped", reason: "no OlmMachine on client (crypto disabled?)" };
  }

  const botUserId: string = await client.getUserId();

  // RECOVERY-KEY PATH (preferred): import the existing cross-signing identity from
  // SSSS using the operator-supplied recovery key, then sign our device with the
  // imported SSK. Preserves any other @bot session's verification status.
  if (opts.recoveryKey) {
    if (await isDeviceCrossSigned(client, botUserId)) {
      log(`[Matrix xsign] device already cross-signed; ignoring recovery key (use selfCrossSign:"reset" to force rotation)`);
      return { status: "already" };
    }
    log(`[Matrix xsign] importing existing cross-signing identity from SSSS via recovery key`);
    await importViaRecoveryKey(client, machine, botUserId, opts.recoveryKey, log, warn);
    return { status: "bootstrapped" };
  }

  const status: CrossSigningStatus = await machine.crossSigningStatus();
  const alreadyHasIdentity = status.hasMaster && status.hasSelfSigning && status.hasUserSigning;

  // Refuse to silently create a fresh cross-signing identity. Without this guard,
  // a bot with no recoveryKey and no pre-existing local identity would run
  // bootstrapCrossSigning(false), which generates fresh MSK/SSK/USK and uploads
  // them — overwriting any Element-generated cross-signing identity already on
  // the homeserver. That's what happened on @pi's first connect: the dist build
  // predated the recovery-key path, no key was loaded, and the bot orphaned the
  // operator's SSSS Secret Backup. Require an explicit opt-in via reset:true to
  // create a fresh identity; otherwise demand a recovery key.
  if (!alreadyHasIdentity && !opts.reset) {
    const reason = opts.recoveryKey
      ? "recoveryKey supplied but local identity import didn't run (importViaRecoveryKey threw earlier?)"
      : "no recoveryKey on disk and reset not explicitly requested";
    warn(
      `[Matrix xsign] refusing to generate a fresh cross-signing identity. ${reason}. ` +
      `Either (a) set PI_MATRIX_RECOVERY_KEY (or write to ~/.pi/recovery-key.txt) to import ` +
      `an existing Secure Backup identity, or (b) set PI_MATRIX_SELF_CROSS_SIGN=reset to ` +
      `explicitly create a new bot-owned identity (will destroy any existing one).`
    );
    return { status: "skipped", reason: reason };
  }

  if (alreadyHasIdentity && !opts.reset) {
    // Confirm the homeserver's view matches: our device should be signed by our SSK.
    if (await isDeviceCrossSigned(client, botUserId)) {
      log(`[Matrix xsign] device already cross-signed (msk+ssk+usk present locally and signature visible on homeserver)`);
      return { status: "already" };
    }
    log(`[Matrix xsign] local cross-signing keys present but homeserver hasn't recorded our device signature — re-publishing`);
  } else {
    log(`[Matrix xsign] bootstrapping cross-signing (reset=${opts.reset ? "true" : "false"})`);
  }

  // crypto-nodejs >=0.5.0 returns CrossSigningBootstrapRequests; <0.5.0 returned void
  // (silently dropping the upload requests — the bug that motivated this helper).
  const bootstrap: BootstrapRequests = await machine.bootstrapCrossSigning(opts.reset ?? false);
  if (!bootstrap || typeof bootstrap !== "object" || !("uploadSigningKeysReq" in bootstrap)) {
    warn(`[Matrix xsign] bootstrapCrossSigning returned no requests — bridge's crypto-nodejs is probably <0.5.0; pin >=0.6.0 via npm overrides`);
    return { status: "skipped", reason: "binding too old (no CrossSigningBootstrapRequests)" };
  }

  // 1. uploadKeysReq (device keys) — may be undefined if device keys already on server.
  if (bootstrap.uploadKeysReq) {
    const req = bootstrap.uploadKeysReq as any;
    const resp = await client.doRequest("POST", "/_matrix/client/v3/keys/upload", undefined, JSON.parse(req.body));
    await machine.markRequestAsSent(req.id, REQ_KEYS_UPLOAD, JSON.stringify(resp ?? {}));
    log(`[Matrix xsign] uploaded device keys`);
  }

  // 2. uploadSigningKeysReq — a JSON body string for /keys/device_signing/upload.
  //    UIA-protected on every Matrix homeserver (no request ID, no markAsSent needed).
  const signingBody = JSON.parse(bootstrap.uploadSigningKeysReq);
  await postWithUia(
    client,
    "/_matrix/client/v3/keys/device_signing/upload",
    signingBody,
    opts.password,
    log
  );
  log(`[Matrix xsign] uploaded cross-signing keys (master/self-signing/user-signing)`);

  // 3. uploadSignaturesReq — the new device's signature, cross-signed by our new SSK.
  // The Rust SDK wraps the body as `{"signed_keys": {<user>: {<key_id>: signed_device}}}`
  // but POST /_matrix/client/v3/keys/signatures/upload wants the inner object directly.
  const sigReq = bootstrap.uploadSignaturesReq as any;
  const rawSigBody = JSON.parse(sigReq.body);
  const sigBody = rawSigBody.signed_keys ?? rawSigBody;
  const sigResp = await client.doRequest(
    "POST",
    "/_matrix/client/v3/keys/signatures/upload",
    undefined,
    sigBody
  );
  await machine.markRequestAsSent(sigReq.id, REQ_SIGNATURE_UPLOAD, JSON.stringify(sigResp ?? {}));
  log(`[Matrix xsign] uploaded device signatures`);

  // Drain any incidental requests the OlmMachine queued during the above.
  const drained = await drainOutgoingRequests(client, machine, opts.password, log, warn);
  if (drained > 0) log(`[Matrix xsign] drained ${drained} follow-up request(s)`);

  return { status: "bootstrapped" };
}

interface BootstrapRequests {
  uploadKeysReq?: unknown;
  uploadSigningKeysReq: string;
  uploadSignaturesReq: unknown;
}

/**
 * Import the existing cross-signing identity (MSK/SSK/USK private parts) from the
 * homeserver's SSSS using the operator-supplied recovery key, then push the
 * resulting device self-signature.
 *
 * Mirrors the high-level shape of mautrix-python's `verify_with_recovery_key`
 * but spelled out against the JS Rust SDK bindings (matrix-bot-sdk doesn't surface
 * any of these — we go straight to the OlmMachine and the homeserver REST API).
 */
async function importViaRecoveryKey(
  client: MatrixClient,
  machine: any,
  botUserId: string,
  recoveryKey: string,
  log: (m: string) => void,
  warn: (m: string) => void
): Promise<void> {
  const userPath = encodeURIComponent(botUserId);

  // 1. Find the default SSSS key id.
  let defaultKey: any;
  try {
    defaultKey = await client.doRequest("GET", `/_matrix/client/v3/user/${userPath}/account_data/m.secret_storage.default_key`);
  } catch (err) {
    throw new Error(`no m.secret_storage.default_key in account_data — operator hasn't run "Set up Secure Backup" in any Element session: ${(err as Error).message}`);
  }
  const keyId: string | undefined = defaultKey?.key;
  if (!keyId) throw new Error("m.secret_storage.default_key is present but has no .key field");

  // 2. Fetch the SSSS key description (algorithm, mac, passphrase params).
  const keyEventType = `m.secret_storage.key.${keyId}`;
  const keyContent = await client.doRequest("GET", `/_matrix/client/v3/user/${userPath}/account_data/${encodeURIComponent(keyEventType)}`);

  // 3. Derive the SecretStorageKey from the recovery key + the key description.
  //    Throws on invalid recovery key / mac mismatch.
  const ssKey: SecretStorageKey = SecretStorageKey.fromAccountData(recoveryKey, keyEventType, JSON.stringify(keyContent));
  log(`[Matrix xsign] SSSS key ${keyId} validated against recovery key`);

  // 4. Fetch the encrypted cross-signing private keys from account_data.
  //    Each entry is an `m.secret_storage.v1.encrypted` object with the SSSS key id
  //    mapping to {iv, ciphertext, mac}.
  const fetchSecret = async (name: string) => {
    try {
      return await client.doRequest("GET", `/_matrix/client/v3/user/${userPath}/account_data/${encodeURIComponent(name)}`);
    } catch (err) {
      throw new Error(`missing account_data ${name} (no Element session has set up cross-signing yet?): ${(err as Error).message}`);
    }
  };
  const masterEvt = await fetchSecret("m.cross_signing.master");
  const sskEvt = await fetchSecret("m.cross_signing.self_signing");
  const uskEvt = await fetchSecret("m.cross_signing.user_signing");

  // 5. Hand the encrypted blobs to the Rust SDK, which decrypts + imports them.
  //    The Record<string, string> keys are snake_case field names on SecretStorageItems
  //    (master_key / self_signing_key / user_signing_key) per matrix-rust-sdk-crypto-nodejs.
  //    The values are the inner per-key {iv, ciphertext, mac} blob, JSON-encoded — NOT
  //    the full `{"encrypted": {<key_id>: ...}}` event wrapper. The SDK is already keyed
  //    on the SSSS key id we derived; it just wants the cipher bundle.
  // SecretStorageItems gotchas, both load-bearing:
  //   - Record keys are camelCase JS names (masterKey / selfSigningKey / userSigningKey).
  //     The Rust struct is snake_case but napi serializes to camelCase by default;
  //     using snake_case here throws "missing master key" before the constructor returns.
  //   - Values are the FULL account_data event JSON ({"encrypted":{<key_id>:{...}}}),
  //     not the inner cipher bundle. The SDK validates "encrypted" as a field.
  const items = new SecretStorageItems({
    masterKey: JSON.stringify(masterEvt),
    selfSigningKey: JSON.stringify(sskEvt),
    userSigningKey: JSON.stringify(uskEvt),
  });

  const sigReq: any = await machine.importSecretsFromSecretStorage(ssKey, items);
  log(`[Matrix xsign] imported MSK/SSK/USK from SSSS`);

  // 6. Upload the device self-signature so the homeserver records our device as
  //    cross-signed by the (now locally-known) SSK private.
  if (sigReq && sigReq.body) {
    const rawBody = JSON.parse(sigReq.body);
    const body = rawBody.signed_keys ?? rawBody;
    const resp = await client.doRequest("POST", "/_matrix/client/v3/keys/signatures/upload", undefined, body);
    if (sigReq.id) {
      await machine.markRequestAsSent(sigReq.id, REQ_SIGNATURE_UPLOAD, JSON.stringify(resp ?? {}));
    }
    log(`[Matrix xsign] uploaded device signature against imported SSK`);
  } else {
    warn(`[Matrix xsign] importSecretsFromSecretStorage returned no SignatureUploadRequest — device may already be signed locally; verify via /keys/query`);
  }

  // 7. Drain any incidental KeysQuery/KeysUpload the import surfaced.
  const drained = await drainOutgoingRequests(client, machine, undefined, log, warn);
  if (drained > 0) log(`[Matrix xsign] drained ${drained} follow-up request(s)`);
}

/**
 * Query /_matrix/client/v3/keys/query for our own user and check whether our
 * device carries a signature from our self_signing_keys's ed25519 keyid.
 */
async function isDeviceCrossSigned(client: MatrixClient, botUserId: string): Promise<boolean> {
  const machine = (client as any).crypto?.engine?.machine;
  const deviceId: string = machine?.deviceId?.toString?.() ?? "";
  if (!deviceId) return false;
  try {
    const resp = await client.doRequest(
      "POST",
      "/_matrix/client/v3/keys/query",
      undefined,
      { device_keys: { [botUserId]: [] }, timeout: 5000 }
    );

    const ssk = resp?.self_signing_keys?.[botUserId];
    const sskKeyId = ssk?.keys ? Object.keys(ssk.keys)[0] : undefined; // e.g. "ed25519:BASE64"
    if (!sskKeyId) return false;

    const device = resp?.device_keys?.[botUserId]?.[deviceId];
    const sigs = device?.signatures?.[botUserId];
    if (!sigs) return false;

    return Object.prototype.hasOwnProperty.call(sigs, sskKeyId);
  } catch {
    return false;
  }
}

/**
 * Drain machine.outgoingRequests() until empty, dispatching each through the
 * MatrixClient's HTTP layer. UIA (401 with `flows`) on KeysUpload is the
 * expected path for device_signing/upload — caught and retried with password.
 *
 * Returns the count of requests handled.
 */
async function drainOutgoingRequests(
  client: MatrixClient,
  machine: any,
  password: string | undefined,
  log: (m: string) => void,
  warn: (m: string) => void
): Promise<number> {
  let handled = 0;
  // Hard cap to avoid an infinite loop if the machine never drains (shouldn't happen).
  for (let iter = 0; iter < 20; iter++) {
    const reqs: OutgoingRequest[] = await machine.outgoingRequests();
    if (!reqs || reqs.length === 0) break;

    for (const req of reqs) {
      const typeName = REQ_NAME[req.type] ?? `Unknown(${req.type})`;
      try {
        const response = await dispatch(client, req, password, log);
        const responseJson = JSON.stringify(response ?? {});
        await machine.markRequestAsSent(req.id, req.type, responseJson);
        handled++;
        log(`[Matrix xsign] sent ${typeName} (${req.id.slice(0, 8)}) → ack`);
      } catch (err) {
        warn(`[Matrix xsign] ${typeName} (${req.id.slice(0, 8)}) failed: ${(err as Error).message}`);
        // Don't markRequestAsSent on failure — the machine will surface it again next iteration.
        // Bail out of the loop to avoid hammering the homeserver.
        return handled;
      }
    }
  }
  return handled;
}

async function dispatch(
  client: MatrixClient,
  req: OutgoingRequest,
  password: string | undefined,
  log: (m: string) => void
): Promise<any> {
  const body = req.body ? JSON.parse(req.body) : {};

  switch (req.type) {
    case REQ_KEYS_UPLOAD:
      // POST /_matrix/client/v3/keys/upload — may UIA for cross-signing keys upload.
      return postWithUia(client, "/_matrix/client/v3/keys/upload", body, password, log);

    case REQ_KEYS_QUERY:
      return client.doRequest("POST", "/_matrix/client/v3/keys/query", undefined, body);

    case REQ_KEYS_CLAIM:
      return client.doRequest("POST", "/_matrix/client/v3/keys/claim", undefined, body);

    case REQ_TO_DEVICE: {
      const eventType = req.eventType ?? "m.room.encrypted";
      const txnId = req.txnId ?? `xsign-${Date.now()}-${req.id.slice(0, 6)}`;
      // body.messages is { [userId]: { [deviceId]: contentJson } }
      return client.doRequest(
        "PUT",
        `/_matrix/client/v3/sendToDevice/${encodeURIComponent(eventType)}/${encodeURIComponent(txnId)}`,
        undefined,
        body
      );
    }

    case REQ_SIGNATURE_UPLOAD:
      return client.doRequest("POST", "/_matrix/client/v3/keys/signatures/upload", undefined, body);

    case REQ_ROOM_MESSAGE:
      // Not expected during cross-signing; ignore body details for now.
      throw new Error("RoomMessage request unexpected during cross-signing drain");

    case REQ_KEYS_BACKUP:
      // Not expected; we don't manage backups here.
      throw new Error("KeysBackup request unexpected during cross-signing drain");

    default:
      throw new Error(`Unknown request type ${req.type}`);
  }
}

/**
 * Wrap a POST that may return 401 + UIA flows. On 401 with m.login.password
 * available, retry once with the password from opts. Otherwise rethrow.
 */
async function postWithUia(
  client: MatrixClient,
  endpoint: string,
  body: any,
  password: string | undefined,
  log: (m: string) => void
): Promise<any> {
  try {
    return await client.doRequest("POST", endpoint, undefined, body);
  } catch (err) {
    const e = err as any;
    const status = e?.statusCode ?? e?.body?.errcode ? (e?.body ? 401 : undefined) : undefined;
    const respBody = e?.body ?? e?.response?.body;

    // matrix-bot-sdk surfaces 401 UIA either via thrown error with statusCode or via
    // an error body containing "flows". Tolerate both shapes.
    const flows: Array<{ stages?: string[] }> | undefined = respBody?.flows;
    const session: string | undefined = respBody?.session;

    const isUia = (status === 401 || flows) && Array.isArray(flows) && flows.length > 0;
    if (!isUia) throw err;

    if (!password) {
      throw new Error("UIA required but no PI_MATRIX_ACCOUNT_PASSWORD / password file available");
    }

    const passwordFlow = flows.some((f) => Array.isArray(f.stages) && f.stages.includes("m.login.password"));
    if (!passwordFlow) {
      throw new Error(`UIA required but m.login.password not in offered flows: ${JSON.stringify(flows)}`);
    }

    const botUserId = await client.getUserId();
    log(`[Matrix xsign] UIA required on ${endpoint} — retrying with m.login.password`);

    const authBody = {
      ...body,
      auth: {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: botUserId },
        password,
        session,
      },
    };
    return await client.doRequest("POST", endpoint, undefined, authBody);
  }
}
