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
import {
  getAmazonAdsProfiles,
  getSponsoredProductsCampaigns,
  getSponsoredProductsCampaignsWithRaw,
  logSafeAmazonAdsSupabaseError
} from "./amazon-ads-client.service";
import {
  listSavedAmazonAdsCampaigns,
  saveAmazonAdsCampaigns
} from "./amazon-ads-campaign.service";
import {
  getFirstAmazonAdsProfile,
  listAmazonAdsProfiles,
  saveAmazonAdsProfiles
} from "./amazon-ads-profile.service";
import {
  deleteAmazonAdsTokens,
  getAmazonAdsAccessToken,
  saveAmazonAdsRefreshToken
} from "./amazon-ads-token.service";
import { AmazonAdsConnection, AmazonAdsStoredProfile } from "./amazon-ads.types";

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
    message,
    safeHint: "Check amazon_ads table schema and service role key."
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

function getSafeAmazonAdsUnknownErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return getSafeAmazonAdsErrorMessage(error);
  }

  return "Amazon Ads request failed. Please check your configuration and try again.";
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

async function findAmazonAdsConnectionForCampaigns(
  sellerId: string
): Promise<{ ok: true; connection: AmazonAdsConnection | null } | { ok: false }> {
  try {
    let query = supabase
      .from("amazon_ads_connections")
      .select("*")
      .eq("status", "connected")
      .order("connected_at", { ascending: false })
      .limit(1);

    if (sellerId !== "default") {
      query = query.eq("seller_id", sellerId);
    }

    const { data, error } = await query.maybeSingle<AmazonAdsConnection>();

    if (error) {
      logSafeAmazonAdsSupabaseError("Could not load Amazon Ads connection for campaigns.", error);
      return { ok: false };
    }

    return { ok: true, connection: data };
  } catch (error) {
    logger.warn("Could not reach Supabase for Amazon Ads campaigns connection lookup.", {
      sellerId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });
    return { ok: false };
  }
}

async function loadAmazonAdsCampaignContext(
  sellerId: string
): Promise<
  | { ok: true; connection: AmazonAdsConnection; profile: AmazonAdsStoredProfile }
  | { ok: false; status: number; message: string; database?: boolean }
> {
  const lookup = await findAmazonAdsConnectionForCampaigns(sellerId);

  if (!lookup.ok) {
    return {
      ok: false,
      status: 503,
      database: true,
      message: "Could not load Amazon Ads connection for campaigns."
    };
  }

  if (!lookup.connection) {
    return {
      ok: false,
      status: 404,
      message: "No connected Amazon Ads account found. Connect Amazon Ads first."
    };
  }

  const profile = await getFirstAmazonAdsProfile(lookup.connection.id);

  if (!profile) {
    return {
      ok: false,
      status: 404,
      message: "No Amazon Ads profile found. Reconnect Amazon Ads to sync profiles."
    };
  }

  return {
    ok: true,
    connection: lookup.connection,
    profile
  };
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
        connected_at: new Date().toISOString()
      })
      .select("*")
      .single<AmazonAdsConnection>();

    if (error || !connection) {
      if (error) {
        logSafeAmazonAdsSupabaseError("Could not save Amazon Ads connection.", error);
      }
      sendDatabaseFailure(res, "Could not save Amazon Ads connection in Supabase.");
      return;
    }

    await saveAmazonAdsRefreshToken(connection.id, tokenResponse);

    try {
      const profiles = await getAmazonAdsProfiles(tokenResponse.access_token, connection.region, connection.id);
      await saveAmazonAdsProfiles(connection.id, profiles);

      res.json({
        ok: true,
        message: "Amazon Ads account connected successfully",
        profilesCount: profiles.length
      });
      return;
    } catch (profileError) {
      logger.warn("Amazon Ads connected, but profile sync failed safely.", {
        connectionId: connection.id,
        message: getSafeAmazonAdsUnknownErrorMessage(profileError)
      });

      res.json({
        ok: true,
        message: "Amazon Ads account connected successfully, but profiles could not be synced yet.",
        profilesCount: 0
      });
      return;
    }
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

export async function getAmazonAdsCampaigns(req: Request, res: Response): Promise<void> {
  const sellerId = typeof req.query.sellerId === "string" && req.query.sellerId.trim()
    ? req.query.sellerId.trim()
    : "default";

  try {
    const context = await loadAmazonAdsCampaignContext(sellerId);

    if (!context.ok) {
      if (context.database) {
        sendDatabaseFailure(res, context.message);
        return;
      }
      sendBeginnerError(res, context.status, context.message);
      return;
    }

    const accessToken = await getAmazonAdsAccessToken(context.connection.id);
    const campaigns = await getSponsoredProductsCampaigns({
      accessToken,
      region: context.connection.region,
      profileId: context.profile.profile_id,
      connectionId: context.connection.id
    });

    res.json({
      ok: true,
      sellerId,
      profileId: context.profile.profile_id,
      campaigns
    });
  } catch (error) {
    logger.warn("Amazon Ads campaigns request failed safely.", {
      sellerId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Could not load Amazon Ads campaigns.",
      details: getSafeAmazonAdsUnknownErrorMessage(error)
    });
  }
}

export async function postAmazonAdsSyncCampaigns(req: Request, res: Response): Promise<void> {
  const sellerId = typeof req.query.sellerId === "string" && req.query.sellerId.trim()
    ? req.query.sellerId.trim()
    : "default";

  try {
    const context = await loadAmazonAdsCampaignContext(sellerId);

    if (!context.ok) {
      if (context.database) {
        sendDatabaseFailure(res, context.message);
        return;
      }
      sendBeginnerError(res, context.status, context.message);
      return;
    }

    const accessToken = await getAmazonAdsAccessToken(context.connection.id);
    const campaigns = await getSponsoredProductsCampaignsWithRaw({
      accessToken,
      region: context.connection.region,
      profileId: context.profile.profile_id,
      connectionId: context.connection.id
    });

    const syncedCount = await saveAmazonAdsCampaigns({
      connectionId: context.connection.id,
      profileId: context.profile.profile_id,
      sellerId: context.connection.seller_id ?? sellerId,
      campaigns
    });

    res.json({
      ok: true,
      sellerId,
      profileId: context.profile.profile_id,
      syncedCount
    });
  } catch (error) {
    logger.warn("Amazon Ads campaign sync failed safely.", {
      sellerId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Could not sync Amazon Ads campaigns.",
      details: getSafeAmazonAdsUnknownErrorMessage(error)
    });
  }
}

export async function getAmazonAdsSavedCampaigns(req: Request, res: Response): Promise<void> {
  const sellerId = typeof req.query.sellerId === "string" && req.query.sellerId.trim()
    ? req.query.sellerId.trim()
    : "default";

  try {
    const context = await loadAmazonAdsCampaignContext(sellerId);

    if (!context.ok) {
      if (context.database) {
        sendDatabaseFailure(res, context.message);
        return;
      }
      sendBeginnerError(res, context.status, context.message);
      return;
    }

    const campaigns = await listSavedAmazonAdsCampaigns({
      connectionId: context.connection.id,
      profileId: context.profile.profile_id
    });

    res.json({
      ok: true,
      sellerId,
      profileId: context.profile.profile_id,
      campaigns
    });
  } catch (error) {
    logger.warn("Saved Amazon Ads campaigns request failed safely.", {
      sellerId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Could not load saved Amazon Ads campaigns.",
      details: getSafeAmazonAdsUnknownErrorMessage(error)
    });
  }
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
    logSafeAmazonAdsSupabaseError("Could not disconnect Amazon Ads.", error);
    sendDatabaseFailure(res, "Could not disconnect Amazon Ads in Supabase.");
    return;
  }

  res.json({
    ok: true,
    message: "Amazon Ads account disconnected."
  });
}

export async function getAmazonAdsDbHealth(_req: Request, res: Response): Promise<void> {
  const tableNames = [
    "amazon_ads_connections",
    "amazon_ads_tokens",
    "amazon_ads_profiles",
    "amazon_ads_api_logs"
  ] as const;

  const tables: Record<(typeof tableNames)[number], boolean> = {
    amazon_ads_connections: false,
    amazon_ads_tokens: false,
    amazon_ads_profiles: false,
    amazon_ads_api_logs: false
  };

  for (const tableName of tableNames) {
    try {
      const { error } = await supabase.from(tableName).select("id", {
        count: "exact",
        head: true
      });

      if (error) {
        logSafeAmazonAdsSupabaseError(`Amazon Ads db-health failed for ${tableName}.`, error);
        tables[tableName] = false;
        continue;
      }

      tables[tableName] = true;
    } catch (error) {
      logger.warn(`Amazon Ads db-health could not reach ${tableName}.`, {
        message: getSafeAmazonAdsUnknownErrorMessage(error)
      });
      tables[tableName] = false;
    }
  }

  const ok = Object.values(tables).every(Boolean);

  res.status(ok ? 200 : 503).json({
    ok,
    tables
  });
}
