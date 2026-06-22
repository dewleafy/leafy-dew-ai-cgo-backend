import axios from "axios";
import { logAmazonApiCall } from "../audit/audit.service";
import { retry } from "../../utils/retry";
import { AmazonConnection, MarketplaceParticipation } from "./amazon.types";
import { getValidAmazonAccessToken } from "./amazon-token.service";

const SP_API_ENDPOINTS = {
  NA: "https://sellingpartnerapi-na.amazon.com",
  EU: "https://sellingpartnerapi-eu.amazon.com",
  FE: "https://sellingpartnerapi-fe.amazon.com"
} as const;

export async function testAmazonConnection(connection: AmazonConnection): Promise<{ ok: boolean }> {
  await getAmazonMarketplaceParticipations(connection);
  return { ok: true };
}

export async function getAmazonMarketplaceParticipations(
  connection: AmazonConnection
): Promise<MarketplaceParticipation[]> {
  const startedAt = Date.now();
  const endpoint = "/sellers/v1/marketplaceParticipations";
  const accessToken = await getValidAmazonAccessToken(connection.id);

  try {
    const response = await retry(() =>
      axios.get<{ payload?: MarketplaceParticipation[] }>(
        `${SP_API_ENDPOINTS[connection.region]}${endpoint}`,
        {
          headers: {
            "x-amz-access-token": accessToken,
            "user-agent": "LeafyDewAI-CGO/0.1.0"
          }
        }
      )
    );

    await logAmazonApiCall({
      connectionId: connection.id,
      sellerId: connection.seller_id,
      endpoint,
      method: "GET",
      statusCode: response.status,
      success: true,
      durationMs: Date.now() - startedAt
    });

    return response.data.payload ?? [];
  } catch (error) {
    const statusCode = axios.isAxiosError(error) ? error.response?.status : undefined;
    const errorMessage = axios.isAxiosError(error)
      ? error.response?.data?.message ?? error.message
      : "Unknown Amazon API error.";

    await logAmazonApiCall({
      connectionId: connection.id,
      sellerId: connection.seller_id,
      endpoint,
      method: "GET",
      statusCode,
      success: false,
      errorMessage,
      durationMs: Date.now() - startedAt
    });

    // TODO: Add AWS SigV4 request signing before relying on live SP-API calls in production.
    throw new Error(`Amazon SP-API request failed: ${errorMessage}`);
  }
}
