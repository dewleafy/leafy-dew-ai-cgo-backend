export type AmazonSpRegion = "NA" | "EU" | "FE";

export type AmazonSpConnectionRow = {
  id: string;
  seller_id: string;
  amazon_seller_id: string | null;
  marketplace_id: string;
  region: AmazonSpRegion;
  refresh_token_encrypted: string | null;
  token_status: string;
  last_connected_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type AmazonSpListingRow = {
  id: string;
  seller_id: string;
  amazon_seller_id: string | null;
  marketplace_id: string;
  sku: string;
  asin: string | null;
  product_name: string | null;
  listing_status: string | null;
  fulfillment_channel: string | null;
  price: number | string | null;
  currency: string | null;
  quantity: number | null;
  product_type: string | null;
  main_image_url: string | null;
  raw_payload: Record<string, unknown> | null;
  last_synced_at: string;
  created_at: string;
  updated_at: string;
};

export type AmazonSpOrderRow = {
  id: string;
  seller_id: string;
  marketplace_id: string;
  amazon_order_id: string;
  purchase_date: string | null;
  order_status: string | null;
  fulfillment_channel: string | null;
  sales_channel: string | null;
  order_total_amount: number | string | null;
  order_total_currency: string | null;
  number_of_items_shipped: number | null;
  number_of_items_unshipped: number | null;
  raw_payload: Record<string, unknown> | null;
  last_synced_at: string;
  created_at: string;
  updated_at: string;
};

export type AmazonSpOrderItemRow = {
  id: string;
  seller_id: string;
  amazon_order_id: string;
  order_item_id: string;
  asin: string | null;
  sku: string | null;
  title: string | null;
  quantity_ordered: number | null;
  quantity_shipped: number | null;
  item_price_amount: number | string | null;
  item_price_currency: string | null;
  item_tax_amount: number | string | null;
  promotion_discount_amount: number | string | null;
  raw_payload: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export type AmazonSpTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
};

export type AmazonSpOAuthState = {
  sellerId?: string;
  nonce: string;
  marketplaceId: string;
  region: AmazonSpRegion;
  createdAt: string;
};

export type SafeAmazonSpListing = {
  id: string;
  sellerId: string;
  amazonSellerId: string | null;
  marketplaceId: string;
  sku: string;
  asin: string | null;
  productName: string | null;
  listingStatus: string | null;
  fulfillmentChannel: string | null;
  price: number | null;
  currency: string | null;
  quantity: number | null;
  productType: string | null;
  mainImageUrl: string | null;
  imageUrl: string | null;
  amazonImageUrl: string | null;
  imageSource: string | null;
  lastImageSyncAt: string | null;
  images: string[];
  imageStatus: "AVAILABLE" | "MISSING_FROM_SOURCE";
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type SafeAmazonSpOrder = {
  id: string;
  sellerId: string;
  marketplaceId: string;
  amazonOrderId: string;
  purchaseDate: string | null;
  orderStatus: string | null;
  fulfillmentChannel: string | null;
  salesChannel: string | null;
  orderTotalAmount: number | null;
  orderTotalCurrency: string | null;
  numberOfItemsShipped: number | null;
  numberOfItemsUnshipped: number | null;
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
};
