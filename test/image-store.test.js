import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.RESULT_IMAGE_DIR = path.join(os.tmpdir(), `shareai-image-store-test-${process.pid}`);

const {
  mirrorImageUrls,
  resultImageDir,
  shouldMirrorImageUrl
} = await import("../src/image-store.js");

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test.after(async () => {
  await rm(resultImageDir, { recursive: true, force: true });
});

test("smart image storage treats Gemini result links as temporary", () => {
  assert.equal(
    shouldMirrorImageUrl("https://claude.midjourneye.com/gemini/images/gg-dl/generated-image", {
      imageStorage: { mode: "smart" }
    }),
    true
  );
});

test("required image mirroring saves the result locally", async () => {
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  globalThis.fetch = async () => new Response(imageBytes, {
    status: 200,
    headers: { "content-type": "image/png" }
  });

  const [url] = await mirrorImageUrls([
    "https://claude.midjourneye.com/gemini/images/gg-dl/generated-image"
  ], {
    publicBaseUrl: "https://api.example.test",
    imageStorage: { mode: "smart", autoCleanup: false, retentionDays: 7 }
  });

  assert.match(url, /^https:\/\/api\.example\.test\/uploads\/results\/.+\.png$/);
  const filename = path.basename(new URL(url).pathname);
  assert.deepEqual(await readFile(path.join(resultImageDir, filename)), imageBytes);
});

test("required image mirroring fails instead of returning a broken upstream link", async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response("Internal Server Error", {
      status: 500,
      headers: { "content-type": "text/plain" }
    });
  };

  await assert.rejects(
    () => mirrorImageUrls([
      "https://claude.midjourneye.com/gemini/images/gg-dl/generated-image"
    ], {
      imageStorage: { mode: "smart", autoCleanup: false, retentionDays: 7 }
    }),
    /500/
  );
  assert.equal(attempts, 2);
});

test("Gemini image mirroring can use an authenticated channel downloader", async () => {
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 5, 6, 7, 8]);
  const calls = [];
  const [url] = await mirrorImageUrls([
    "https://claude.midjourneye.com/gemini/images/gg-dl/authenticated-image"
  ], {
    publicBaseUrl: "https://api.example.test",
    imageStorage: { mode: "smart", autoCleanup: false, retentionDays: 7 }
  }, {
    attempts: 1,
    downloadImage: async (source, options) => {
      calls.push({ source, options });
      return { buffer: imageBytes, contentType: "image/png" };
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, "https://claude.midjourneye.com/gemini/images/gg-dl/authenticated-image");
  assert.equal(calls[0].options.timeoutMs, 30000);
  const filename = path.basename(new URL(url).pathname);
  assert.deepEqual(await readFile(path.join(resultImageDir, filename)), imageBytes);
});
