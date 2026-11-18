import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { z } from "zod";
import { getFeaturedAsin, listShopItems, setFeaturedProduct } from "./public-shop.service";

// Public, no login. Read-only list of products that are safe to show on the link-in-bio page.
export const publicShopRouter = Router();

publicShopRouter.get(
  ["", "/"],
  asyncHandler(async (req, res) => {
    const brand = req.query.brand === "Ziro Kart" ? "Ziro Kart" : "Leafy Dew";
    const [items, featuredAsin] = await Promise.all([listShopItems(brand), getFeaturedAsin(brand)]);
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({ ok: true, brand, featuredAsin, items });
  })
);

// Owner-only (behind login): choose the product shown at the top of /shop. Mounted at /api/shop-feature.
export const shopFeatureRouter = Router();

const featureSchema = z.object({ asin: z.string().trim().regex(/^B0[A-Z0-9]{8}$/).nullable() });

shopFeatureRouter.put(
  ["", "/"],
  asyncHandler(async (req, res) => {
    const parsed = featureSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, message: "Send an ASIN like B0HFZZ4Z5T, or null to clear." });
      return;
    }
    const done = await setFeaturedProduct(parsed.data.asin);
    if (!done) {
      res.status(404).json({ ok: false, message: "That product is not in the list or is not marked OK." });
      return;
    }
    res.json({ ok: true });
  })
);
