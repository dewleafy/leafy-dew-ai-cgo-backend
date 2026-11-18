import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { listShopItems } from "./public-shop.service";

// Public, no login. Read-only list of products that are safe to show on the link-in-bio page.
export const publicShopRouter = Router();

publicShopRouter.get(
  ["", "/"],
  asyncHandler(async (req, res) => {
    const brand = req.query.brand === "Ziro Kart" ? "Ziro Kart" : "Leafy Dew";
    const items = await listShopItems(brand);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ ok: true, brand, items });
  })
);
