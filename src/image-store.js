import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const rootDir = process.cwd();
export const resultImageDir = path.resolve(rootDir, process.env.RESULT_IMAGE_DIR || "outputs/results");
let runtimePublicBaseUrl = "";

const contentTypeExt = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif"
};

function extFromContentType(contentType = "") {
  return contentTypeExt[String(contentType).split(";")[0].trim().toLowerCase()] || ".png";
}

function publicBaseUrl(config = {}) {
  return String(process.env.PUBLIC_BASE_URL || config.publicBaseUrl || runtimePublicBaseUrl || "").replace(/\/+$/, "");
}

function localResultUrl(filename, config = {}) {
  const pathname = `/uploads/results/${filename}`;
  const base = publicBaseUrl(config);
  return base ? `${base}${pathname}` : pathname;
}

async function downloadImage(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "ShareAI-API/1.0"
    }
  });
  if (!response.ok) throw new Error(`图片转存失败：${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error("图片转存失败：上游返回的不是图片。");
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, contentType };
}

export async function mirrorImageUrl(url, config = {}) {
  const source = String(url || "").trim();
  if (!source || source.startsWith("/uploads/results/")) return source;
  const { buffer, contentType } = await downloadImage(source);
  await mkdir(resultImageDir, { recursive: true });
  const filename = `${Date.now()}-${randomUUID()}${extFromContentType(contentType)}`;
  await writeFile(path.join(resultImageDir, filename), buffer);
  return localResultUrl(filename, config);
}

export async function mirrorImageUrls(urls = [], config = {}) {
  const results = [];
  for (const url of Array.isArray(urls) ? urls : []) {
    try {
      results.push(await mirrorImageUrl(url, config));
    } catch {
      results.push(url);
    }
  }
  return results;
}

export function setRuntimePublicBaseUrl(value) {
  if (!value || process.env.PUBLIC_BASE_URL) return;
  runtimePublicBaseUrl = String(value).replace(/\/+$/, "");
}
