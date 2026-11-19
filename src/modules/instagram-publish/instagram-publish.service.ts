import axios from "axios";
import { createSocialContentLogEntry } from "../social-content-log/social-content-log.service";

// Publishes one photo to the connected Instagram professional account through the Instagram API
// (Facebook Login for Business / system-user token). Only runs when INSTAGRAM_PUBLISH_ENABLED=true.
// The token is read from INSTAGRAM_ACCESS_TOKEN and is never logged or returned.

const GRAPH_VERSION = process.env.INSTAGRAM_GRAPH_VERSION?.trim() || "v27.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export type InstagramStatus = {
  configured: boolean;
  publishEnabled: boolean;
  hasToken: boolean;
  hasUserId: boolean;
  username: string | null;
  error: string | null;
};

function getConfig() {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN?.trim() ?? "";
  const userId = process.env.INSTAGRAM_USER_ID?.trim() ?? "";
  const publishEnabled = process.env.INSTAGRAM_PUBLISH_ENABLED?.trim().toLowerCase() === "true";
  return { token, userId, publishEnabled };
}

function metaErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const metaError = (error.response?.data as { error?: { message?: string; code?: number } } | undefined)?.error;
    if (metaError?.message) {
      return `Instagram said: ${metaError.message}${metaError.code ? ` (code ${metaError.code})` : ""}`;
    }
    return `Instagram request failed (${error.response?.status ?? "no response"}).`;
  }
  return error instanceof Error ? error.message : "Unknown Instagram error.";
}

export async function getInstagramStatus(): Promise<InstagramStatus> {
  const { token, userId, publishEnabled } = getConfig();
  const status: InstagramStatus = {
    configured: Boolean(token && userId),
    publishEnabled,
    hasToken: Boolean(token),
    hasUserId: Boolean(userId),
    username: null,
    error: null
  };

  if (!status.configured) {
    return status;
  }

  try {
    const res = await axios.get(`${GRAPH_BASE}/${encodeURIComponent(userId)}`, {
      params: { fields: "username", access_token: token },
      timeout: 15000
    });
    status.username = typeof res.data?.username === "string" ? res.data.username : null;
  } catch (error) {
    status.error = metaErrorMessage(error);
  }

  return status;
}

export async function publishInstagramTestPhoto(input: {
  imageUrl: string;
  caption: string;
  title?: string;
  sellerId: string;
}): Promise<{ mediaId: string; permalink: string | null; logId: string }> {
  const { token, userId, publishEnabled } = getConfig();

  if (!publishEnabled) {
    throw new Error("Instagram publishing is switched off. Set INSTAGRAM_PUBLISH_ENABLED=true to allow a test post.");
  }
  if (!token || !userId) {
    throw new Error("Instagram is not configured. Set INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_USER_ID.");
  }

  try {
    // 1. Create the media container. Instagram downloads the image from the public URL.
    const container = await axios.post(
      `${GRAPH_BASE}/${encodeURIComponent(userId)}/media`,
      new URLSearchParams({ image_url: input.imageUrl, caption: input.caption, access_token: token }),
      { timeout: 30000 }
    );
    const creationId = String(container.data?.id ?? "");
    if (!creationId) {
      throw new Error("Instagram did not return a media container id.");
    }

    // 2. Wait until the container is ready (photos are usually instant).
    let ready = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const check = await axios.get(`${GRAPH_BASE}/${encodeURIComponent(creationId)}`, {
        params: { fields: "status_code", access_token: token },
        timeout: 15000
      });
      const code = String(check.data?.status_code ?? "");
      if (code === "FINISHED") {
        ready = true;
        break;
      }
      if (code === "ERROR" || code === "EXPIRED") {
        throw new Error(`Instagram could not process the image (${code}).`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!ready) {
      throw new Error("Instagram did not finish processing the image in time. Nothing was published.");
    }

    // 3. Publish.
    const published = await axios.post(
      `${GRAPH_BASE}/${encodeURIComponent(userId)}/media_publish`,
      new URLSearchParams({ creation_id: creationId, access_token: token }),
      { timeout: 30000 }
    );
    const mediaId = String(published.data?.id ?? "");
    if (!mediaId) {
      throw new Error("Instagram did not return a published media id.");
    }

    let permalink: string | null = null;
    try {
      const info = await axios.get(`${GRAPH_BASE}/${encodeURIComponent(mediaId)}`, {
        params: { fields: "permalink", access_token: token },
        timeout: 15000
      });
      permalink = typeof info.data?.permalink === "string" ? info.data.permalink : null;
    } catch {
      permalink = null;
    }

    const today = new Date().toISOString().slice(0, 10);
    const logRow = await createSocialContentLogEntry({
      sellerId: input.sellerId,
      platform: "INSTAGRAM",
      contentType: "Photo",
      title: input.title ?? "Instagram post",
      sku: null,
      asin: null,
      status: "POSTED",
      plannedDate: today,
      postedDate: today,
      notes: `Published through the API. Media id ${mediaId}.${permalink ? ` ${permalink}` : ""}`
    });

    return { mediaId, permalink, logId: logRow.id };
  } catch (error) {
    throw new Error(metaErrorMessage(error));
  }
}

async function waitForContainer(creationId: string, token: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const check = await axios.get(`${GRAPH_BASE}/${encodeURIComponent(creationId)}`, {
      params: { fields: "status_code", access_token: token },
      timeout: 15000
    });
    const code = String(check.data?.status_code ?? "");
    if (code === "FINISHED") return;
    if (code === "ERROR" || code === "EXPIRED") throw new Error(`Instagram could not process the image (${code}).`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Instagram did not finish processing in time. Nothing was published.");
}

// Publishes one photo, or a carousel when 2 or more image URLs are given. Used by the auto-poster.
// Does not write the post log: the caller does that. Refuses to run unless publishing is switched on.
export async function publishInstagramPost(input: {
  imageUrls: string[];
  videoUrl?: string | null;
  caption: string;
}): Promise<{ mediaId: string; permalink: string | null }> {
  const { token, userId, publishEnabled } = getConfig();
  if (!publishEnabled) throw new Error("Instagram publishing is switched off (INSTAGRAM_PUBLISH_ENABLED is not true).");
  if (!token || !userId) throw new Error("Instagram is not configured.");
  if (input.imageUrls.length === 0 && !input.videoUrl) throw new Error("No media to publish.");

  try {
    let creationId: string;
    if (input.videoUrl) {
      const reel = await axios.post(
        `${GRAPH_BASE}/${encodeURIComponent(userId)}/media`,
        new URLSearchParams({ media_type: "REELS", video_url: input.videoUrl, caption: input.caption, share_to_feed: "true", access_token: token }),
        { timeout: 30000 }
      );
      creationId = String(reel.data?.id ?? "");
      if (!creationId) throw new Error("Instagram did not return a media container id.");
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const check = await axios.get(`${GRAPH_BASE}/${encodeURIComponent(creationId)}`, { params: { fields: "status_code", access_token: token }, timeout: 15000 });
        const code = String(check.data?.status_code ?? "");
        if (code === "FINISHED") break;
        if (code === "ERROR" || code === "EXPIRED") throw new Error(`Instagram could not process the video (${code}).`);
        if (attempt === 59) throw new Error("Instagram did not finish processing the video in time. Nothing was published.");
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    } else if (input.imageUrls.length === 1) {
      const container = await axios.post(
        `${GRAPH_BASE}/${encodeURIComponent(userId)}/media`,
        new URLSearchParams({ image_url: input.imageUrls[0], caption: input.caption, access_token: token }),
        { timeout: 30000 }
      );
      creationId = String(container.data?.id ?? "");
    } else {
      const children: string[] = [];
      for (const url of input.imageUrls.slice(0, 10)) {
        const child = await axios.post(
          `${GRAPH_BASE}/${encodeURIComponent(userId)}/media`,
          new URLSearchParams({ image_url: url, is_carousel_item: "true", access_token: token }),
          { timeout: 30000 }
        );
        const childId = String(child.data?.id ?? "");
        if (!childId) throw new Error("Instagram did not return a carousel item id.");
        await waitForContainer(childId, token);
        children.push(childId);
      }
      const parent = await axios.post(
        `${GRAPH_BASE}/${encodeURIComponent(userId)}/media`,
        new URLSearchParams({ media_type: "CAROUSEL", children: children.join(","), caption: input.caption, access_token: token }),
        { timeout: 30000 }
      );
      creationId = String(parent.data?.id ?? "");
    }
    if (!creationId) throw new Error("Instagram did not return a media container id.");
    if (!input.videoUrl) await waitForContainer(creationId, token);

    const published = await axios.post(
      `${GRAPH_BASE}/${encodeURIComponent(userId)}/media_publish`,
      new URLSearchParams({ creation_id: creationId, access_token: token }),
      { timeout: 30000 }
    );
    const mediaId = String(published.data?.id ?? "");
    if (!mediaId) throw new Error("Instagram did not return a published media id.");

    let permalink: string | null = null;
    try {
      const info = await axios.get(`${GRAPH_BASE}/${encodeURIComponent(mediaId)}`, {
        params: { fields: "permalink", access_token: token },
        timeout: 15000
      });
      permalink = typeof info.data?.permalink === "string" ? info.data.permalink : null;
    } catch {
      permalink = null;
    }
    return { mediaId, permalink };
  } catch (error) {
    throw new Error(metaErrorMessage(error));
  }
}

// ---- Comments (read recent comments, post a reply) ----

export type IgComment = { id: string; mediaId: string; permalink: string | null; username: string | null; text: string; timestamp: string | null };

export async function fetchRecentInstagramComments(mediaLimit = 8, commentLimit = 25): Promise<IgComment[]> {
  const { token, userId } = getConfig();
  if (!token || !userId) throw new Error("Instagram is not configured.");
  try {
    const media = await axios.get(`${GRAPH_BASE}/${encodeURIComponent(userId)}/media`, {
      params: { fields: "id,permalink,timestamp", limit: mediaLimit, access_token: token },
      timeout: 20000
    });
    const out: IgComment[] = [];
    for (const m of (media.data?.data ?? []) as { id: string; permalink?: string }[]) {
      const res = await axios.get(`${GRAPH_BASE}/${encodeURIComponent(m.id)}/comments`, {
        params: { fields: "id,text,username,timestamp", limit: commentLimit, access_token: token },
        timeout: 20000
      });
      for (const c of (res.data?.data ?? []) as { id: string; text?: string; username?: string; timestamp?: string }[]) {
        if (c.id && c.text) out.push({ id: c.id, mediaId: m.id, permalink: m.permalink ?? null, username: c.username ?? null, text: c.text, timestamp: c.timestamp ?? null });
      }
    }
    return out;
  } catch (error) {
    throw new Error(metaErrorMessage(error));
  }
}

export async function replyToInstagramComment(commentId: string, message: string): Promise<string> {
  const { token, publishEnabled } = getConfig();
  if (!publishEnabled) throw new Error("Instagram posting is switched off (INSTAGRAM_PUBLISH_ENABLED is not true).");
  try {
    const res = await axios.post(
      `${GRAPH_BASE}/${encodeURIComponent(commentId)}/replies`,
      new URLSearchParams({ message, access_token: token }),
      { timeout: 20000 }
    );
    return String(res.data?.id ?? "");
  } catch (error) {
    throw new Error(metaErrorMessage(error));
  }
}
