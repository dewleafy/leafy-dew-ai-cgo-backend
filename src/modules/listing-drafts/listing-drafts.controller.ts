import { Request, Response } from "express";
import {
  createActionForListingDraft,
  generateListingDrafts,
  getListingDraftSummary,
  listListingDrafts
} from "./listing-drafts.service";

function sellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

function limitFromQuery(req: Request): number {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
  const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 100;
  return Math.min(Math.max(limit, 1), 500);
}

function sendDraftError(res: Response, error?: unknown): void {
  if (error instanceof Error && error.message === "DRAFT_NOT_FOUND") {
    res.status(404).json({ ok: false, message: "Listing draft not found." });
    return;
  }

  res.status(503).json({
    ok: false,
    message: "Could not use Listing Draft System. Run listing_drafts.sql in Supabase and check service role access."
  });
}

export async function getListingDraftSummaryRoute(req: Request, res: Response): Promise<void> {
  try {
    res.json(await getListingDraftSummary(sellerIdFromQuery(req)));
  } catch (error) {
    sendDraftError(res, error);
  }
}

export async function listListingDraftsRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  try {
    const rows = await listListingDrafts({ sellerId, limit: limitFromQuery(req) });
    res.json({ ok: true, sellerId, count: rows.length, rows });
  } catch (error) {
    sendDraftError(res, error);
  }
}

export async function generateListingDraftsRoute(req: Request, res: Response): Promise<void> {
  try {
    res.json(await generateListingDrafts(sellerIdFromQuery(req)));
  } catch (error) {
    sendDraftError(res, error);
  }
}

export async function createListingDraftActionRoute(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id || "").trim();
  if (!id) {
    res.status(400).json({ ok: false, message: "Draft id is required." });
    return;
  }

  try {
    const result = await createActionForListingDraft(id);
    res.json({ ok: true, ...result });
  } catch (error) {
    sendDraftError(res, error);
  }
}
