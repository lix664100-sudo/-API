import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Fastify from "fastify";
import multipart from "@fastify/multipart";

import { createErpMediaCatalog } from "../src/erp-media-catalog.js";
import { loadErpMediaConfig } from "../src/erp-media-config.js";
import { createBoundedGate, registerErpMediaRoutes } from "../src/erp-media-routes.js";
import { createErpMediaStore } from "../src/erp-media-store.js";

function pngBytes() {
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16, 1)]);
}

function mp4Bytes() {
  return Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom", "ascii"), Buffer.alloc(52, 2)]);
}

function multipartPayload(fields, file) {
  const boundary = `----erp-media-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
  ));
  chunks.push(file.bytes);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function setup(configOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "erp-media-routes-"));
  const config = {
    ...loadErpMediaConfig({}, root),
    publicBaseUrl: "https://media.example.test",
    minimumFreeBytes: 1,
    minimumFreePercent: 0,
    readBytesPerSecond: 1024 * 1024 * 1024,
    writeBytesPerSecond: 1024 * 1024 * 1024,
    ...configOverrides,
  };
  const catalog = createErpMediaCatalog({ databaseFile: config.databaseFile });
  const store = createErpMediaStore({ config, catalog });
  const app = Fastify({ logger: false });
  await app.register(multipart);
  app.get("/existing-api", async () => ({ ok: true }));
  await registerErpMediaRoutes(app, {
    config,
    catalog,
    store,
    requireApiKey: async (request, reply) => {
      if (request.headers["x-api-key"] !== "secret") {
        return reply.code(401).send({ ok: false, message: "unauthorized" });
      }
    },
  });
  await app.ready();
  return {
    app,
    catalog,
    store,
    root,
    async close() {
      await app.close();
      catalog.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function upload(app, { key = "image-key", kind = "image", file } = {}) {
  const body = multipartPayload({ installId: "install-1", mediaKind: kind }, file || {
    filename: "image.png",
    contentType: "image/png",
    bytes: pngBytes(),
  });
  return app.inject({
    method: "POST",
    url: "/v1/erp-media",
    headers: {
      "x-api-key": "secret",
      "idempotency-key": key,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });
}

test("upload requires the existing API key and reuses an idempotent result", async () => {
  const context = await setup();
  try {
    const unauthorizedBody = multipartPayload({ installId: "install-1", mediaKind: "image" }, {
      filename: "image.png",
      contentType: "image/png",
      bytes: pngBytes(),
    });
    const unauthorized = await context.app.inject({
      method: "POST",
      url: "/v1/erp-media",
      headers: { "content-type": unauthorizedBody.contentType, "idempotency-key": "key" },
      payload: unauthorizedBody.payload,
    });
    assert.equal(unauthorized.statusCode, 401);

    const first = await upload(context.app);
    const second = await upload(context.app);
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(first.json().data.id, second.json().data.id);
    assert.equal(first.json().data.url.startsWith("https://media.example.test/erp-media/"), true);
  } finally {
    await context.close();
  }
});

test("public image supports GET and HEAD but not a guessed filename", async () => {
  const context = await setup();
  try {
    const uploaded = (await upload(context.app)).json().data;
    const pathname = new URL(uploaded.url).pathname;
    const get = await context.app.inject({ method: "GET", url: pathname });
    assert.equal(get.statusCode, 200);
    assert.equal(get.headers["content-type"], "image/png");
    assert.deepEqual(get.rawPayload, pngBytes());
    const head = await context.app.inject({ method: "HEAD", url: pathname });
    assert.equal(head.statusCode, 200);
    assert.equal(head.rawPayload.length, 0);
    const guessed = await context.app.inject({ method: "GET", url: pathname.replace(/\.png$/, "-other.png") });
    assert.equal(guessed.statusCode, 404);
  } finally {
    await context.close();
  }
});

test("public video returns a single byte range and rejects invalid ranges", async () => {
  const context = await setup();
  try {
    const bytes = mp4Bytes();
    const response = await upload(context.app, {
      key: "video-key",
      kind: "video",
      file: { filename: "video.mp4", contentType: "video/mp4", bytes },
    });
    assert.equal(response.statusCode, 200);
    const pathname = new URL(response.json().data.url).pathname;
    const partial = await context.app.inject({
      method: "GET",
      url: pathname,
      headers: { range: "bytes=4-11" },
    });
    assert.equal(partial.statusCode, 206);
    assert.equal(partial.headers["accept-ranges"], "bytes");
    assert.equal(partial.headers["content-range"], `bytes 4-11/${bytes.length}`);
    assert.deepEqual(partial.rawPayload, bytes.subarray(4, 12));
    const invalid = await context.app.inject({
      method: "GET",
      url: pathname,
      headers: { range: `bytes=${bytes.length}-` },
    });
    assert.equal(invalid.statusCode, 416);
  } finally {
    await context.close();
  }
});

test("bounded media gate rejects work after its short queue is full", async () => {
  const gate = createBoundedGate(1, 1);
  const releaseFirst = await gate.acquire();
  const second = gate.acquire();
  await assert.rejects(gate.acquire(), (error) => error.code === "MEDIA_BUSY");
  releaseFirst();
  const releaseSecond = await second;
  releaseSecond();
  assert.deepEqual(gate.stats().running, 0);
});

test("30 uploads, video ranges and the existing API run together without escaping their gates", async () => {
  const context = await setup();
  try {
    const uploads = await Promise.all(Array.from({ length: 30 }, (_, index) => upload(context.app, {
      key: `parallel-image-${index}`,
      file: {
        filename: `image-${index}.png`,
        contentType: "image/png",
        bytes: pngBytes(index + 1),
      },
    })));
    assert.equal(uploads.every((response) => response.statusCode === 200), true);

    const video = await upload(context.app, {
      key: "parallel-video",
      kind: "video",
      file: { filename: "video.mp4", contentType: "video/mp4", bytes: mp4Bytes() },
    });
    const pathname = new URL(video.json().data.url).pathname;
    const work = await Promise.all([
      ...Array.from({ length: 20 }, (_, index) => context.app.inject({
        method: "GET",
        url: pathname,
        headers: { range: `bytes=${index}-${index + 3}` },
      })),
      ...Array.from({ length: 30 }, () => context.app.inject({ method: "GET", url: "/existing-api" })),
    ]);
    assert.equal(work.slice(0, 20).every((response) => response.statusCode === 206), true);
    assert.equal(work.slice(20).every((response) => response.statusCode === 200 && response.json().ok), true);
    assert.equal(context.catalog.stats().reduce((sum, row) => sum + row.count, 0), 31);
  } finally {
    await context.close();
  }
});

test("closing a public media connection releases the file so A cleanup can remove it", async () => {
  const context = await setup({ readBytesPerSecond: 64 * 1024 });
  try {
    const bytes = Buffer.concat([mp4Bytes(), Buffer.alloc(256 * 1024, 3)]);
    const uploaded = await upload(context.app, {
      key: "connection-close-video",
      kind: "video",
      file: { filename: "video.mp4", contentType: "video/mp4", bytes },
    });
    const data = uploaded.json().data;
    const media = context.catalog.getByPublicId(data.id);
    await context.app.listen({ host: "127.0.0.1", port: 0 });
    const address = context.app.server.address();
    await new Promise((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${address.port}${new URL(data.url).pathname}`, (response) => {
        response.once("data", () => {
          request.destroy();
          resolve();
        });
      });
      request.once("error", (error) => {
        if (error?.code === "ECONNRESET") resolve();
        else reject(error);
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(context.store.isActive(media.id), false);
    const cleaned = await context.store.cleanupExpired({ cutoff: Date.now() + 1_000 });
    assert.equal(cleaned.deletedCount, 1);
    const missing = await context.app.inject({ method: "GET", url: new URL(data.url).pathname });
    assert.equal(missing.statusCode, 404);
  } finally {
    await context.close();
  }
});
