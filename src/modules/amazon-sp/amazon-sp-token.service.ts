import crypto from "crypto";
import { env } from "../../config/env";
import { supabase } from "../../db/supabase";
import { refreshAmazonSpAccessToken } from "./amazon-sp-auth.service";
import { logSafeAmazonSpError } from "./amazon-sp-utils";

type TokenRow = {
  refresh_token_encrypted: string | null;
};

export const AMAZON_SP_ENV_CONNECTION_ID = "__SP_API_REFRESH_TOKEN_ENV__";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getSpEncryptionKey(): Buffer {
  const rawKey = env.SP_API_TOKEN_ENCRYPTION_KEY || env.ENCRYPTION_KEY;
  const base64Key = Buffer.from(rawKey, "base64");
  if (base64Key.length === 32) return base64Key;

  const hexKey = Buffer.from(rawKey, "hex");
  if (hexKey.length === 32) return hexKey;

  throw new Error("SP-API token encryption key must decode to exactly 32 bytes.");
}

function encryptSpToken(plainText: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getSpEncryptionKey(), iv, {
    authTagLength: AUTH_TAG_LENGTH
  });
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(":");
}

function decryptSpToken(encryptedText: string): string {
  const [ivBase64, authTagBase64, encryptedBase64] = encryptedText.split(":");
  if (!ivBase64 || !authTagBase64 || !encryptedBase64) {
    throw new Error("Encrypted SP-API token has an invalid format.");
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, getSpEncryptionKey(), Buffer.from(ivBase64, "base64"), {
    authTagLength: AUTH_TAG_LENGTH
  });
  decipher.setAuthTag(Buffer.from(authTagBase64, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64, "base64")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}

export async function getAmazonSpAccessToken(connectionId: string): Promise<string> {
  if (connectionId === AMAZON_SP_ENV_CONNECTION_ID) {
    if (!env.SP_API_REFRESH_TOKEN) {
      throw new Error("SP-API refresh token is not configured.");
    }

    const refreshed = await refreshAmazonSpAccessToken(env.SP_API_REFRESH_TOKEN);
    return refreshed.access_token;
  }

  const { data, error } = await supabase
    .from("amazon_sp_connections")
    .select("refresh_token_encrypted")
    .eq("id", connectionId)
    .single<TokenRow>();

  if (error || !data?.refresh_token_encrypted) {
    if (error) logSafeAmazonSpError("Could not load Amazon SP-API refresh token.", error);

    if (!env.SP_API_REFRESH_TOKEN) {
      throw new Error("SP-API refresh token is not configured.");
    }

    const refreshed = await refreshAmazonSpAccessToken(env.SP_API_REFRESH_TOKEN);
    return refreshed.access_token;
  }

  const refreshToken = decryptSpToken(data.refresh_token_encrypted);
  const refreshed = await refreshAmazonSpAccessToken(refreshToken);
  return refreshed.access_token;
}

export function encryptAmazonSpRefreshToken(refreshToken: string): string {
  return encryptSpToken(refreshToken);
}
