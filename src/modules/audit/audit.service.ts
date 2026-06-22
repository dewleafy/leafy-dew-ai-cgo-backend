import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";

type ApiLogInput = {
  connectionId?: string;
  sellerId?: string;
  endpoint: string;
  method: string;
  statusCode?: number;
  success: boolean;
  errorMessage?: string;
  durationMs?: number;
};

export async function logAmazonApiCall(input: ApiLogInput): Promise<void> {
  const { error } = await supabase.from("amazon_api_logs").insert({
    connection_id: input.connectionId ?? null,
    seller_id: input.sellerId ?? null,
    endpoint: input.endpoint,
    method: input.method,
    status_code: input.statusCode ?? null,
    success: input.success,
    error_message: input.errorMessage ?? null,
    duration_ms: input.durationMs ?? null
  });

  if (error) {
    logger.warn("Failed to write Amazon API audit log.", {
      message: error.message,
      endpoint: input.endpoint
    });
  }
}
