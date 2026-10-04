import assert from "node:assert";
import { extractListingDetails, scoreListingCompleteness } from "../src/modules/listing-details/listing-details.rules";
const d = extractListingDetails({
  attributes: {
    item_name: [{ value: "Leafy Dew Premium Cotton Rug For Living Room Soft Anti Slip 5x7 Feet Grey Colour" }],
    bullet_point: [{ value: "a" }, { value: "b" }, { value: "c" }, { value: "d" }, { value: "e" }],
    product_description: [{ value: "x".repeat(120) }],
    generic_keyword: [{ value: "rug carpet mat" }],
    brand: [{ value: "Leafy Dew" }],
    main_product_image_locator: [{ media_location: "https://img/1.jpg" }],
    other_product_image_locator_1: [{ media_location: "https://img/2.jpg" }]
  },
  summaries: [{ asin: "B0X", productType: "RUG", status: ["BUYABLE"] }],
  offers: [{ price: { amount: "499.00" } }],
  issues: [{ severity: "WARNING" }]
});
assert.equal(d.imageUrls.length, 2); assert.equal(d.price, 499); assert.equal(d.bullets.length, 5);
const s = scoreListingCompleteness(d);
assert(s.missing.includes("7+ images")); assert.equal(s.score, 90);
const empty = scoreListingCompleteness(extractListingDetails({}));
assert.equal(empty.score, 10); // only "No Amazon errors" passes
console.log("listing-details tests passed");
