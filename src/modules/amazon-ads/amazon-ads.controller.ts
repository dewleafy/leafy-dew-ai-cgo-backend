import { Request, Response } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import {
  buildAmazonAdsConnectUrl,
  exchangeAmazonAdsAuthorizationCode,
  getAmazonAdsConfigCheck as readAmazonAdsConfigCheck,
  parseAmazonAdsState
} from "./amazon-ads-auth.service";
import { getAmazonAdsProfiles } from "./amazon-ads-client.service";
import { listAmazonAdsProfiles, saveAmazonAdsProfiles } from "./amazon-ads-profile.service";
import {
  deleteAmazonAdsTokens,
  getAmazonAdsAccessToken,
  saveAmazonAdsRefreshToken
} from "./amazon-ads-token.service";
import { AmazonAdsConnection } from "./amazon-ads.types";

const sellerQuerySchema = z.object({
  sellerId: z.string().min(1)
});

const connectQuerySchema = z.object({
  sellerId: z.string().min(1).optional()
});

const callbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1).optional()
});

function sendDatabaseFailure(res: Response, message = "Could not reach Supabase. Check your database settings."): void {
  res.status(503).json({
    ok: false,
    error: "Database connection failed",
    message
  });
}

function sendBeginnerError(res: Response, status: number, message: string): void {
  res.status(status).json({
    ok: false,
    message
  });
}

function getSafeAmazonAdsErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Please check your Amazon Ads credentials and try again.";
  }

  const secretValues = [
    env.AMAZON_ADS_CLIENT_SECRET,
    env.AMAZON_ADS_CLIENT_ID,
    env.ENCRYPTION_KEY,
    env.SUPABASE_SERVICE_ROLE_KEY
  ].filter((value): value is string => Boolean(value));

  return secretValues.reduce(
    (message, secretValue) => message.replaceAll(secretValue, "[REDACTED]"),
    error.message
  );
}

async function findAmazonAdsConnectionBySellerId(
  sellerId: string
): Promise<{ ok: true; connection: AmazonAdsConnection | null } | { ok: false }> {
  try {
    const { data, error } = await supabase
      .from("amazon_ads_connections")
      .select("*")
      .eq("seller_id", sellerId)
      .maybeSingle<AmazonAdsConnection>();

    if (error) {
      logger.warn("Could not load Amazon Ads connection.", {
        sellerId,
        message: error.message
      });
      return { ok: false };
    }

    return { ok: true, connection: data };
  } catch (error) {
    logger.warn("Could not reach Supabase for Amazon Ads connection lookup.", {
      sellerId,
      message: error instanceof Error ? error.message : "Unknown database error"
    });
    return { ok: false };
  }
}

export async function getAmazonAdsConfigCheck(_req: Request, res: Response): Promise<void> {
  res.json(readAmazonAdsConfigCheck());
}

export async function getAmazonAdsConnectUrl(req: Request, res: Response): Promise<void> {
  try {
    const query = connectQuerySchema.parse(req.query);
    const result = buildAmazonAdsConnectUrl(query.sellerId);

    res.json({
      ok: true,
      authorizationUrl: result.authorizationUrl,
      state: result.state
    });
  } catch (error) {
    sendBeginnerError(
      res,
      400,
      error instanceof Error
        ? error.message
        : "Could not create Amazon Ads connection URL. Check Amazon Ads environment variables."
    );
  }
}

export async function handleAmazonAdsCallback(req: Request, res: Response): Promise<void> {
  try {
    const query = callbackQuerySchema.parse(req.query);
    const state = query.state
      ? parseAmazonAdsState(query.state)
      : {
          sellerId: undefined,
          region: env.AMAZON_ADS_REGION,
          nonce: null
        };

    if (!query.state) {
      logger.warn("Amazon Ads callback did not include OAuth state. Continuing with default region.", {
        region: env.AMAZON_ADS_REGION
      });
    }

    const tokenResponse = await exchangeAmazonAdsAuthorizationCode(query.code);

    const { data: connection, error } = await supabase
      .from("amazon_ads_connections")
      .insert({
        seller_id: state.sellerId ?? null,
        region: state.region,
        status: "connected",
        state_nonce: state.nonce,
        connected_at: new Date().toISOString(),
        disconnected_at: null,
        updated_at: new Date().toISOString()
      })
      .select("*")
      .single<AmazonAdsConnection>();

    if (error || !connection) {
      sendDatabaseFailure(res, "Could not save Amazon Ads connection in Supabase.");
      return;
    }

    await saveAmazonAdsRefreshToken(connection.id, tokenResponse);

    const profiles = await getAmazonAdsProfiles(tokenResponse.access_token, connection.region, connection.id);
    await saveAmazonAdsProfiles(connection.id, profiles);

    res.json({
      ok: true,
      message: "Amazon Ads account connected successfully",
      profilesCount: profiles.length
    });
  } catch (error) {
    logger.warn("Amazon Ads callback failed safely.", {
      message: getSafeAmazonAdsErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Amazon Ads authorization failed",
      details: getSafeAmazonAdsErrorMessage(error)
    });
  }
}

export async function getAmazonAdsStatus(req: Request, res: Response): Promise<void> {
  const sellerId = typeof req.query.sellerId === "string" ? req.query.sellerId.trim() : "";

  if (!sellerId) {
    res.json({
      ok: true,
      connected: false,
      message: "No sellerId provided. No Amazon Ads account connected yet."
    });
    return;
  }

  const lookup = await findAmazonAdsConnectionBySellerId(sellerId);

  if (!lookup.ok) {
    sendDatabaseFailure(res);
    return;
  }

  const connection = lookup.connection;

  res.json({
    ok: true,
    connected: connection?.status === "connected",
    connection: connection
      ? {
          sellerId: connection.seller_id,
          region: connection.region,
          status: connection.status,
          connectedAt: connection.connected_at,
          disconnectedAt: connection.disconnected_at
        }
      : null
  });
}

export async function getAmazonAdsProfilesController(req: Request, res: Response): Promise<void> {
  const query = sellerQuerySchema.safeParse(req.query);

  if (!query.success) {
    sendBeginnerError(res, 400, "sellerId is required to load Amazon Ads profiles.");
    return;
  }

  const lookup = await findAmazonAdsConnectionBySellerId(query.data.sellerId);

  if (!lookup.ok) {
    sendDatabaseFailure(res);
    return;
  }

  if (!lookup.connection) {
    sendBeginnerError(res, 404, "No Amazon Ads connection found for this sellerId.");
    return;
  }

  const profiles = await listAmazonAdsProfiles(lookup.connection.id);

  res.json({
    ok: true,
    profiles
  });
}

export async function postAmazonAdsTestConnection(req: Request, res: Response): Promise<void> {
  const body = sellerQuerySchema.safeParse(req.body);

  if (!body.success) {
    sendBeginnerError(res, 400, "sellerId is required to test Amazon Ads connection.");
    return;
  }

  const lookup = await findAmazonAdsConnectionBySellerId(body.data.sellerId);

  if (!lookup.ok) {
    sendDatabaseFailure(res);
    return;
  }

  if (!lookup.connection || lookup.connection.status !== "connected") {
    sendBeginnerError(res, 404, "No connected Amazon Ads account found for this sellerId.");
    return;
  }

  const accessToken = await getAmazonAdsAccessToken(lookup.connection.id);
  const profiles = await getAmazonAdsProfiles(accessToken, lookup.connection.region, lookup.connection.id);
  await saveAmazonAdsProfiles(lookup.connection.id, profiles);

  res.json({
    ok: true,
    message: "Amazon Ads connection test completed.",
    profilesFound: profiles.length
  });
}

export async function postAmazonAdsDisconnect(req: Request, res: Response): Promise<void> {
  const body = sellerQuerySchema.safeParse(req.body);

  if (!body.success) {
    sendBeginnerError(res, 400, "sellerId is required to disconnect Amazon Ads.");
    return;
  }

  const lookup = await findAmazonAdsConnectionBySellerId(body.data.sellerId);

  if (!lookup.ok) {
    sendDatabaseFailure(res);
    return;
  }

  if (!lookup.connection) {
    sendBeginnerError(res, 404, "No Amazon Ads connection found for this sellerId.");
    return;
  }

  await deleteAmazonAdsTokens(lookup.connection.id);

  const { error } = await supabase
    .from("amazon_ads_connections")
    .update({
      status: "disconnected",
      disconnected_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", lookup.connection.id);

  if (error) {
    sendDatabaseFailure(res, "Could not disconnect Amazon Ads in Supabase.");
    return;
  }

  res.json({
    ok: true,
    message: "Amazon Ads account disconnected."
  });
}
