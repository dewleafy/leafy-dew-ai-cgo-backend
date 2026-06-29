import axios from "axios";
import { getAmazonSpEndpoint } from "./amazon-sp-auth.service";
import { AmazonSpRegion } from "./amazon-sp.types";
import { safeErrorMessage, smallDelay } from "./amazon-sp-utils";

export async function amazonSpGet<T>(input: {
  path: string;
  query?: Record<string, string | number | undefined>;
  accessToken: string;
  region: AmazonSpRegion;
}): Promise<T> {
  const url = new URL(input.path, getAmazonSpEndpoint(input.region));
  Object.entries(input.query ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  const headers = {
    "x-amz-access-token": input.accessToken,
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": "LeafyDew/1.0"
  };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await axios.get<T>(url.toString(), { headers });
      return response.data;
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (attempt < 3 && (status === 429 || (status !== undefined && status >= 500))) {
        await smallDelay(700 * attempt);
        continue;
      }
      throw new Error(safeErrorMessage(error));
    }
  }

  throw new Error("Amazon SP-API request failed.");
}
