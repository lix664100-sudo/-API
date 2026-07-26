import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const { ChatplusClient, generateGrokStatsigId } = await import("../src/channels/chatplus.js");

test("Grok 请求校验可在本地生成，并且内容能完整复算", () => {
  const method = "POST";
  const path = "/rest/app-chat/conversations/new";
  const nowUnix = 1785033600;
  const encoded = generateGrokStatsigId(method, path, { nowUnix, randomKey: 0x5a });
  const decoded = Buffer.from(encoded, "base64");

  assert.equal(encoded.length, 94);
  assert.equal(decoded.length, 70);
  assert.equal(decoded[0], 0x5a);
  assert.equal(
    decoded.subarray(1, 49).map((byte) => byte ^ 0x5a).toString("base64"),
    "t2ODAFY4ozXd0K2Y8MdI2XfxTDiJoakZPuoaKfcQn8VuasZMcKliyhA1pJ+o1oMf"
  );
  const timestampBytes = decoded.subarray(49, 53).map((byte) => byte ^ 0x5a);
  const number = nowUnix - 1682924400;
  assert.equal(timestampBytes.readUInt32LE(0), number);
  const expectedDigest = createHash("sha256")
    .update(
      `${method}!${path}!${number}obfiowerehiring`
      + "3bab9506b851eb851eb840e8f5c28f5c28f80e8f5c28f5c28f806b851eb851eb8400"
    )
    .digest()
    .subarray(0, 16);
  const actualDigest = decoded.subarray(53, 69).map((byte) => byte ^ 0x5a);
  assert.deepEqual(actualDigest, expectedDigest);
  assert.equal(decoded[69] ^ 0x5a, 0x03);
});

function client() {
  const testClient = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: {
      id: "shareai",
      type: "shareai",
      settings: {
        baseUrl: "https://www.chatplus.cc",
        defaultChatModel: "grok",
        chatModels: [
          {
            key: "grok",
            name: "Grok",
            carType: "grok",
            model: "",
            strategy: "balanced",
            carTier: "auto",
            enabled: true,
            default: true
          }
        ]
      }
    },
    account: { id: "grok-test", username: "test@example.test", password: "test" },
    sessionLock: async (work) => work()
  });
  testClient.grokStatsigId = async () => Buffer.alloc(70, 1).toString("base64");
  return testClient;
}

function fakeImageFile(overrides = {}) {
  return {
    filename: "source.png",
    mimetype: "image/png",
    toBuffer: async () => Buffer.from("image-bytes"),
    ...overrides
  };
}

function grokImageResponse(url = "users/test/generated/final-image") {
  return JSON.stringify({
    result: {
      conversationId: "grok-conversation",
      response: {
        streamingImageGenerationResponse: {
          imageId: "grok-image",
          imageUrl: url,
          progress: 100,
          moderated: false
        }
      }
    }
  });
}

const route = { key: "grok", strategy: "balanced", model: "" };
const selected = { carId: "grok-car", carType: "grok" };

test("Grok 文生图会开启图片生成并解析最终图片", async () => {
  const testClient = client();
  let request = null;
  testClient.http = async (path, options) => {
    request = { path, options };
    return { status: 200, headers: {}, body: grokImageResponse() };
  };

  const result = await testClient.sendGrokConversation(
    "画一只猫",
    { files: [], imageGeneration: true, image_count: 1 },
    route,
    selected
  );

  assert.equal(request.path, "/rest/app-chat/conversations/new");
  assert.equal(request.options.body.message, "Drawing: 画一只猫");
  assert.equal(request.options.body.modelName, "grok-4");
  assert.equal(request.options.body.enableImageGeneration, true);
  assert.equal(request.options.body.imageGenerationCount, 1);
  assert.equal(request.options.headers.referer, "https://www.chatplus.cc/imagine");
  assert.equal(request.options.headers["x-statsig-id"], Buffer.alloc(70, 1).toString("base64"));
  assert.deepEqual(result.imageUrls, [
    "https://assets.grok.com/users/test/generated/final-image"
  ]);
  assert.equal(result.model, "grok");
});

test("Grok 参考图会上传到 Imagine 并提交图片编辑", async () => {
  const testClient = client();
  const calls = [];
  testClient.http = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === "/grok/http/upload-file-v2/direct") {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          fileMetadata: {
            fileMetadataId: "asset-source",
            fileUri: "https://assets.grok.com/users/test/source.png"
          }
        })
      };
    }
    if (path === "/rest/app-chat/conversations/new") {
      return { status: 200, headers: {}, body: grokImageResponse() };
    }
    throw new Error(`unexpected request: ${path}`);
  };

  const result = await testClient.sendGrokConversation(
    "换成海边背景",
    {
      files: [fakeImageFile()],
      imageGeneration: true,
      image_count: 1,
      size: "1024x1536"
    },
    route,
    selected
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.rawBody, true);
  assert.match(calls[0].options.headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.match(calls[0].options.body.toString("utf8"), /name="file"; filename="source\.png"/);
  assert.match(calls[0].options.body.toString("utf8"), /IMAGINE_SELF_UPLOAD_FILE_SOURCE/);

  const body = calls[1].options.body;
  assert.equal(body.modelName, "imagine-image-edit");
  assert.equal(body.message, "换成海边背景");
  assert.equal(body.enableImageGeneration, true);
  assert.equal(body.mediaGenInput.imageToImage.prompt, "换成海边背景");
  assert.equal(body.mediaGenInput.imageToImage.aspectRatio, "2:3");
  assert.deepEqual(body.mediaGenInput.imageToImage.inputAssets, ["asset-source"]);
  assert.equal(body.responseMetadata.modelConfigOverride.modelMap.imageEditModel, "imagine");
  assert.deepEqual(result.imageUrls, [
    "https://assets.grok.com/users/test/generated/final-image"
  ]);
});

test("Grok 新上传接口不可用时会自动改用兼容接口", async () => {
  const testClient = client();
  const calls = [];
  testClient.http = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === "/grok/http/upload-file-v2/direct" || path === "/http/upload-file-v2/direct") {
      return { status: 404, headers: {}, body: "not found" };
    }
    if (path === "/rest/app-chat/upload-file") {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ fileMetadataId: "legacy-asset" })
      };
    }
    throw new Error(`unexpected request: ${path}`);
  };

  const upload = await testClient.uploadGrokImage(fakeImageFile());

  assert.equal(upload.id, "legacy-asset");
  assert.deepEqual(calls.map((call) => call.path), [
    "/grok/http/upload-file-v2/direct",
    "/http/upload-file-v2/direct",
    "/rest/app-chat/upload-file"
  ]);
  assert.equal(calls[2].options.body.fileName, "source.png");
  assert.equal(calls[2].options.body.fileMimeType, "image/png");
  assert.equal(calls[2].options.body.fileSource, "IMAGINE_SELF_UPLOAD_FILE_SOURCE");
  assert.equal(calls[2].options.body.content, Buffer.from("image-bytes").toString("base64"));
});

test("Grok 只返回预览图时不能误报成功", async () => {
  const testClient = client();
  testClient.http = async () => ({
    status: 200,
    headers: {},
    body: JSON.stringify({
      result: {
        conversationId: "grok-preview-only",
        response: {
          streamingImageGenerationResponse: {
            imageUrl: "users/test/generated/image-part-1",
            progress: 60,
            moderated: false
          }
        }
      }
    })
  });

  await assert.rejects(
    () => testClient.sendGrokConversation(
      "预览图测试",
      { files: [], imageGeneration: true },
      route,
      selected
    ),
    (error) => error.status === 502 && error.code === "INVALID_UPSTREAM_RESPONSE"
  );
});

test("Grok 图片提交遇到 403 会刷新网页签名后重试一次", async () => {
  const testClient = client();
  const forceValues = [];
  let requestCount = 0;
  testClient.grokStatsigId = async (_method, _path, force) => {
    forceValues.push(force);
    return Buffer.alloc(70, force ? 2 : 1).toString("base64");
  };
  testClient.http = async (path, options = {}) => {
    assert.equal(path, "/rest/app-chat/conversations/new");
    requestCount += 1;
    if (requestCount === 1) {
      assert.equal(options.headers["x-statsig-id"], Buffer.alloc(70, 1).toString("base64"));
      return { status: 403, headers: {}, body: "forbidden" };
    }
    assert.equal(options.headers["x-statsig-id"], Buffer.alloc(70, 2).toString("base64"));
    return { status: 200, headers: {}, body: grokImageResponse() };
  };

  const result = await testClient.sendGrokConversation(
    "签名刷新测试",
    { files: [], imageGeneration: true },
    route,
    selected
  );

  assert.equal(requestCount, 2);
  assert.deepEqual(forceValues, [undefined, true]);
  assert.equal(result.imageUrls.length, 1);
});

test("Grok 参考图会在上传前检查格式和大小", async () => {
  const testClient = client();
  testClient.http = async () => {
    throw new Error("不应发送网络请求");
  };

  await assert.rejects(
    () => testClient.uploadGrokImage(fakeImageFile({ mimetype: "image/gif" })),
    (error) => error.status === 400 && error.noRetry === true
  );
  await assert.rejects(
    () => testClient.uploadGrokImage(fakeImageFile({
      toBuffer: async () => Buffer.alloc(25 * 1024 * 1024 + 1)
    })),
    (error) => error.status === 400 && error.noRetry === true
  );
});
