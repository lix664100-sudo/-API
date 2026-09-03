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

test("smart image storage treats authenticated file download links as temporary", () => {
  assert.equal(
    shouldMirrorImageUrl("https://one.aishare.icu/backend-api/files/file_123/download", {
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
  assert.equal(attempts, 1);
});

test("multiple images are mirrored in parallel and keep their input order", async () => {
  const started = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const urls = [1, 2, 3].map((id) => `https://claude.midjourneye.com/gemini/images/gg-dl/parallel-${id}`);

  const pending = mirrorImageUrls(urls, {
    publicBaseUrl: "https://api.example.test",
    imageStorage: { mode: "smart", autoCleanup: false, retentionDays: 7 }
  }, {
    attempts: 1,
    downloadImage: async (source) => {
      started.push(source);
      if (started.length === urls.length) release();
      await gate;
      return { buffer: Buffer.from([started.indexOf(source) + 1]), contentType: "image/png" };
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(started.length, urls.length);
  release();
  const mirrored = await pending;
  assert.equal(mirrored.length, urls.length);
  assert.ok(mirrored.every((url) => url.startsWith("https://api.example.test/uploads/results/")));
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
  assert.equal(calls[0].options.timeoutMs, 90000);
  const filename = path.basename(new URL(url).pathname);
  assert.deepEqual(await readFile(path.join(resultImageDir, filename)), imageBytes);
});

test("image mirroring can reject a downloaded copy of the input image", async () => {
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6]);
  let validated = 0;

  await assert.rejects(
    () => mirrorImageUrls([
      "https://claude.midjourneye.com/gemini/images/gg-dl/duplicate-input"
    ], {
      imageStorage: { mode: "smart", autoCleanup: false, retentionDays: 7 }
    }, {
      attempts: 1,
      downloadImage: async () => ({ buffer: imageBytes, contentType: "image/png" }),
      validateDownload: ({ buffer, source }) => {
        validated += 1;
        assert.equal(source, "https://claude.midjourneye.com/gemini/images/gg-dl/duplicate-input");
        assert.deepEqual(buffer, imageBytes);
        throw Object.assign(new Error("上游返回的图片与原图相同，等待重新获取最终生成图。"), {
          code: "DUPLICATE_INPUT_IMAGE_RESULT"
        });
      }
    }),
    (error) => error.code === "DUPLICATE_INPUT_IMAGE_RESULT"
  );

  assert.equal(validated, 1);
});
