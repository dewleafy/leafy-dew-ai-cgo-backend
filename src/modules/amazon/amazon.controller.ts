import { Request, Response } from "express";
import { z } from "zod";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import {
  buildAmazonConnectUrl,
  exchangeAuthorizationCode,
  parseAndValidateOAuthState
} from "./amazon-auth.service";
import { deleteAmazonTokens, saveAmazonTokens } from "./amazon-token.service";
import { getAmazonMarketplaceParticipations, testAmazonConnection } from "./amazon-client.service";
import { AmazonConnection, AmazonMarketplace, AmazonRegion } from "./amazon.types";

const sellerQuerySchema = z.object({
  sellerId: z.string().min(1, "sellerId is required")
});

const regionSchema = z.enum(["NA", "EU", "FE"]);

const connectUrlQuerySchema = sellerQuerySchema.extend({
  region: regionSchema.optional()
});

const callbackQuerySchema = z.object({
  spapi_oauth_code: z.string().min(1),
  selling_partner_id: z.string().optional(),
  state: z.string().min(1)
});

type ConnectionLookupResult =
  | { ok: true; connection: AmazonConnection | null }
  | { ok: false; error: "database" };

function sendDatabaseConnectionFailed(res: Response): void {
  res.status(503).json({
    ok: false,
    connected: false,
    error: "Database connection failed",
    message: "Backend could not reach Supabase. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
  });
}

async function findConnectionBySellerId(sellerId: string): Promise<ConnectionLookupResult> {
  try {
    const { data, error } = await supabase
      .from("amazon_connections")
      .select("*")
      .eq("seller_id", sellerId)
      .maybeSingle<AmazonConnection>();

    if (error) {
      logger.warn("Failed to load Amazon connection.", {
        sellerId,
        message: error.message
      });
      return { ok: false, error: "database" };
    }

    return { ok: true, connection: data };
  } catch (error) {
    logger.warn("Failed to reach Supabase while loading Amazon connection.", {
      sellerId,
      message: error instanceof Error ? error.message : "Unknown database error"
    });
    return { ok: false, error: "database" };
  }
}

async function saveMarketplaces(connectionId: string, marketplaces: AmazonMarketplace[]): Promise<void> {
  if (marketplaces.length === 0) {
    return;
  }

  const rows = marketplaces.map((marketplace) => ({
    connection_id: connectionId,
    marketplace_id: marketplace.marketplace_id,
    name: marketplace.name,
    country_code: marketplace.country_code,
    default_currency_code: marketplace.default_currency_code ?? null,
    default_language_code: marketplace.default_language_code ?? null,
    updated_at: new Date().toISOString()
  }));

  const { error } = await supabase.from("amazon_marketplaces").upsert(rows, {
    onConflict: "connection_id,marketplace_id"
  });

  if (error) {
    throw new Error(`Failed to save marketplaces: ${error.message}`);
  }
}

export async function getConnectUrl(req: Request, res: Response): Promise<void> {
  const query = connectUrlQuerySchema.parse(req.query);
  const result = buildAmazonConnectUrl(query.sellerId, query.region as AmazonRegion | undefined);

  res.json({
    connectUrl: result.url
  });
}

export async function handleAmazonCallback(req: Request, res: Response): Promise<void> {
  const query = callbackQuerySchema.parse(req.query);
  const state = parseAndValidateOAuthState(query.state);
  const tokenResponse = await exchangeAuthorizationCode(query.spapi_oauth_code);

  const { data: connection, error } = await supabase
    .from("amazon_connections")
    .upsert(
      {
        seller_id: state.sellerId,
        amazon_seller_id: query.selling_partner_id ?? null,
        region: state.region,
        status: "connected",
        connected_at: new Date().toISOString(),
        disconnected_at: null,
        updated_at: new Date().toISOString()
      },
      { onConflict: "seller_id" }
    )
    .select("*")
    .single<AmazonConnection>();

  if (error || !connection) {
    throw new Error(`Failed to save Amazon connection: ${error?.message ?? "Unknown error"}`);
  }

  await saveAmazonTokens(connection.id, tokenResponse);

  logger.info("Amazon seller connected.", {
    sellerId: state.sellerId,
    amazonSellerId: query.selling_partner_id,
    region: state.region
  });

  res.json({
    message: "Amazon seller account connected successfully.",
    sellerId: state.sellerId,
    amazonSellerId: query.selling_partner_id ?? null,
    region: state.region
  });
}

export async function getAmazonStatus(req: Request, res: Response): Promise<void> {
  try {
    const sellerId = typeof req.query.sellerId === "string" ? req.query.sellerId.trim() : "";

    if (!sellerId) {
      res.json({
        ok: true,
        connected: false,
        message: "No sellerId provided. No Amazon seller account connected yet."
      });
      return;
    }

    const lookup = await findConnectionBySellerId(sellerId);

    if (!lookup.ok) {
      sendDatabaseConnectionFailed(res);
      return;
    }

    const connection = lookup.connection;

    res.json({
      ok: true,
      connected: connection?.status === "connected",
      connection: connection
        ? {
            sellerId: connection.seller_id,
            amazonSellerId: connection.amazon_seller_id,
            region: connection.region,
            status: connection.status,
            connectedAt: connection.connected_at,
            disconnectedAt: connection.disconnected_at
          }
        : null
    });
  } catch (error) {
    logger.warn("Amazon status check failed safely.", {
      message: error instanceof Error ? error.message : "Unknown status error"
    });
    sendDatabaseConnectionFailed(res);
  }
}

export async function postTestConnection(req: Request, res: Response): Promise<void> {
  const body = sellerQuerySchema.parse(req.body);
  const lookup = await findConnectionBySellerId(body.sellerId);

  if (!lookup.ok) {
    sendDatabaseConnectionFailed(res);
    return;
  }

  const connection = lookup.connection;

  if (!connection || connection.status !== "connected") {
    res.status(404).json({ message: "No connected Amazon account found for this sellerId." });
    return;
  }

  const result = await testAmazonConnection(connection);

  res.json({
    message: "Amazon connection test completed.",
    ...result
  });
}

export async function getMarketplaces(req: Request, res: Response): Promise<void> {
  const query = sellerQuerySchema.parse(req.query);
  const lookup = await findConnectionBySellerId(query.sellerId);

  if (!lookup.ok) {
    sendDatabaseConnectionFailed(res);
    return;
  }

  const connection = lookup.connection;

  if (!connection || connection.status !== "connected") {
    res.status(404).json({ message: "No connected Amazon account found for this sellerId." });
    return;
  }

  const participations = await getAmazonMarketplaceParticipations(connection);
  const marketplaces = participations.map((item) => ({
    marketplace_id: item.marketplace.id,
    name: item.marketplace.name,
    country_code: item.marketplace.countryCode,
    default_currency_code: item.marketplace.defaultCurrencyCode,
    default_language_code: item.marketplace.defaultLanguageCode
  }));

  await saveMarketplaces(connection.id, marketplaces);

  res.json({
    marketplaces
  });
}

export async function postDisconnect(req: Request, res: Response): Promise<void> {
  const body = sellerQuerySchema.parse(req.body);
  const lookup = await findConnectionBySellerId(body.sellerId);

  if (!lookup.ok) {
    sendDatabaseConnectionFailed(res);
    return;
  }

  const connection = lookup.connection;

  if (!connection) {
    res.status(404).json({ message: "No Amazon connection found for this sellerId." });
    return;
  }

  await deleteAmazonTokens(connection.id);

  const { error } = await supabase
    .from("amazon_connections")
    .update({
      status: "disconnected",
      disconnected_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", connection.id);

  if (error) {
    throw new Error(`Failed to disconnect Amazon account: ${error.message}`);
  }

  res.json({
    message: "Amazon seller account disconnected.",
    sellerId: body.sellerId
  });
}
