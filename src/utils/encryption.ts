import crypto from "crypto";
import { env } from "../config/env";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const base64Key = Buffer.from(env.ENCRYPTION_KEY, "base64");
  if (base64Key.length === 32) {
    return base64Key;
  }

  const hexKey = Buffer.from(env.ENCRYPTION_KEY, "hex");
  if (hexKey.length === 32) {
    return hexKey;
  }

  throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes.");
}

export function encryptText(plainText: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH
  });

  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(":");
}

export function decryptText(encryptedText: string): string {
  const [ivBase64, authTagBase64, encryptedBase64] = encryptedText.split(":");

  if (!ivBase64 || !authTagBase64 || !encryptedBase64) {
    throw new Error("Encrypted text has an invalid format.");
  }

  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivBase64, "base64"), {
    authTagLength: AUTH_TAG_LENGTH
  });
  decipher.setAuthTag(Buffer.from(authTagBase64, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64, "base64")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}

export function createSignedState(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", getEncryptionKey())
    .update(body)
    .digest("base64url");

  return `${body}.${signature}`;
}

export function verifySignedState<T extends Record<string, unknown>>(state: string): T {
  const [body, signature] = state.split(".");

  if (!body || !signature) {
    throw new Error("Invalid OAuth state.");
  }

  const expectedSignature = crypto
    .createHmac("sha256", getEncryptionKey())
    .update(body)
    .digest("base64url");

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    throw new Error("Invalid OAuth state signature.");
  }

  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
}
