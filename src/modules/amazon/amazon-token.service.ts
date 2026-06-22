import { supabase } from "../../db/supabase";
import { decryptText, encryptText } from "../../utils/encryption";
import { LwaTokenResponse } from "./amazon.types";
import { refreshAccessToken } from "./amazon-auth.service";

type TokenRow = {
  id: string;
  connection_id: string;
  encrypted_access_token: string;
  encrypted_refresh_token: string | null;
  expires_at: string;
};

export async function saveAmazonTokens(connectionId: string, tokenResponse: LwaTokenResponse): Promise<void> {
  const expiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString();

  const { error } = await supabase.from("amazon_tokens").upsert(
    {
      connection_id: connectionId,
      encrypted_access_token: encryptText(tokenResponse.access_token),
      encrypted_refresh_token: tokenResponse.refresh_token ? encryptText(tokenResponse.refresh_token) : undefined,
      token_type: tokenResponse.token_type,
      expires_at: expiresAt,
      updated_at: new Date().toISOString()
    },
    { onConflict: "connection_id" }
  );

  if (error) {
    throw new Error(`Failed to save Amazon tokens: ${error.message}`);
  }
}

export async function getValidAmazonAccessToken(connectionId: string): Promise<string> {
  const { data, error } = await supabase
    .from("amazon_tokens")
    .select("id, connection_id, encrypted_access_token, encrypted_refresh_token, expires_at")
    .eq("connection_id", connectionId)
    .single<TokenRow>();

  if (error || !data) {
    throw new Error("No Amazon tokens found for this connection.");
  }

  const expiresAt = new Date(data.expires_at).getTime();
  const shouldRefresh = expiresAt - Date.now() < 60_000;

  if (!shouldRefresh) {
    return decryptText(data.encrypted_access_token);
  }

  if (!data.encrypted_refresh_token) {
    throw new Error("Amazon refresh token is missing. Reconnect this seller account.");
  }

  const refreshToken = decryptText(data.encrypted_refresh_token);
  const refreshed = await refreshAccessToken(refreshToken);

  await saveAmazonTokens(connectionId, {
    ...refreshed,
    refresh_token: refreshed.refresh_token ?? refreshToken
  });

  return refreshed.access_token;
}

export async function deleteAmazonTokens(connectionId: string): Promise<void> {
  const { error } = await supabase.from("amazon_tokens").delete().eq("connection_id", connectionId);

  if (error) {
    throw new Error(`Failed to delete Amazon tokens: ${error.message}`);
  }
}
