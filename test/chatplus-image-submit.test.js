import assert from "node:assert/strict";
import test from "node:test";
import { ChatplusClient } from "../src/channels/chatplus.js";

function response(body, status = 200) {
  return { status, headers: {}, body: JSON.stringify(body) };
}

function submissionClient(id, intercept = async () => undefined) {
  const calls = [];
  const client = new ChatplusClient({
    config: {},
    channel: { settings: { baseUrl: `https://${id}.example.test` } },
    account: { id, username: id, password: "test" }
  });
  client.carId = `${id}-car`;
  client.prepareChatSession = async () => ({
    route: { key: "gpt", model: "gpt-5-6-thinking" },
    selected: { carId: client.carId, carType: "chatgpt" },
    init: {}
  });
  client.ensureConversationUpdates = async () => {};
  client.uploadChatImages = async () => [{
    part: { content_type: "image_asset_pointer", asset_pointer: "file-service://original" },
    attachment: { id: "original", mimeType: "image/png" }
  }];
  client.http = async (path, options = {}) => {
    calls.push({ path, ...options });
    const overridden = await intercept(path, options);
    if (overridden) return overridden;
    switch (path) {
      case "/backend-api/f/conversation/prepare":
        return response({ conduit_token: `${id}-conduit` });
      case "/backend-api/sentinel/chat-requirements/prepare":
        return response({ prepare_token: `${id}-prepare` });
      case "/backend-api/sentinel/chat-requirements/finalize":
        assert.equal(options.body.prepare_token, `${id}-prepare`);
        return response({ token: `${id}-requirements` });
      case "/backend-api/f/conversation":
      case "/backend-api/conversation":
        return {
          status: 200,
          headers: {},
          body: `data: ${JSON.stringify({
            type: "resume_conversation_token",
            conversation_id: `${id}-conversation`,
            token: "test-resume"
          })}\n\ndata: [DONE]\n\n`
        };
      default:
        assert.fail(`Unexpected request: ${path}`);
    }
  };
  return { client, calls };
}

test("GPT image submission prepares credentials and retains the uploaded attachment", async () => {
  const { client, calls } = submissionClient("image-flow");
  const result = await client.sendConversation("Change the background", {
    imageGeneration: true,
    files: [{}]
  });
  assert.equal(result.conversationId, "image-flow-conversation");
  assert.equal(result.submissionConfirmed, true);
  assert.deepEqual(calls.map(call => call.path), [
    "/backend-api/f/conversation/prepare",
    "/backend-api/sentinel/chat-requirements/prepare",
    "/backend-api/sentinel/chat-requirements/finalize",
    "/backend-api/f/conversation"
  ]);
  const prepare = calls[0];
  const submit = calls.at(-1);
  assert.equal(prepare.body.messages, undefined);
  assert.equal(prepare.body.parent_message_id, submit.body.parent_message_id);
  assert.equal(submit.body.client_prepare_state, "success");
  assert.equal(submit.body.model, "gpt-5-6-thinking");
  assert.equal(submit.body.messages[0].content.content_type, "multimodal_text");
  assert.equal(submit.body.messages[0].metadata.attachments[0].id, "original");
  assert.equal(submit.headers["x-conduit-token"], "image-flow-conduit");
  assert.equal(submit.headers["OpenAI-Sentinel-Chat-Requirements-Token"], "image-flow-requirements");
});

test("ordinary chat continues to use its existing submission flow", async () => {
  const { client, calls } = submissionClient("ordinary-chat");
  await client.sendConversation("Hello");
  assert.deepEqual(calls.map(call => call.path), ["/backend-api/conversation"]);
  assert.equal(calls[0].body.messages[0].content.content_type, "text");
});

test("missing preparation credentials never submit an image or retry on another car", async () => {
  const { client, calls } = submissionClient("missing-credentials", async path => {
    if (path.endsWith("/finalize")) return response({});
  });
  await assert.rejects(client.sendConversation("Draw", { imageGeneration: true }), error => {
    assert.equal(error.code, "CHAT_IMAGE_PREPARATION_FAILED");
    assert.equal(error.imageSubmissionAttempted, undefined);
    return true;
  });
  assert.equal(calls.length, 3);
  assert.equal(calls.some(call => call.path.endsWith("/conversation")), false);
});

test("a rejected modern submission is not resubmitted through the legacy endpoint", async () => {
  const { client, calls } = submissionClient("rejected-submit", async path => {
    if (path === "/backend-api/f/conversation") {
      return response({ detail: { message: "Forbidden" } }, 403);
    }
  });
  await assert.rejects(client.sendConversation("Draw", { imageGeneration: true }));
  assert.equal(calls.filter(call => call.path.endsWith("/conversation")).length, 1);
  assert.equal(calls.some(call => call.path === "/backend-api/conversation"), false);
});

test("two image accounts prepare and submit concurrently without exchanging credentials", { timeout: 5000 }, async () => {
  let arrivals = 0;
  let release;
  const bothPreparing = new Promise(resolve => { release = resolve; });
  const intercept = async path => {
    if (!path.endsWith("/finalize")) return;
    arrivals += 1;
    if (arrivals === 2) release();
    await bothPreparing;
  };
  const probes = [submissionClient("parallel-a", intercept), submissionClient("parallel-b", intercept)];
  const results = await Promise.all(probes.map(({ client }) => client.sendConversation("Draw", {
    imageGeneration: true
  })));
  assert.equal(arrivals, 2);
  for (const [index, { client, calls }] of probes.entries()) {
    const submit = calls.at(-1);
    assert.equal(results[index].conversationId, `${client.account.id}-conversation`);
    assert.equal(submit.headers["x-conduit-token"], `${client.account.id}-conduit`);
    assert.equal(submit.headers["OpenAI-Sentinel-Chat-Requirements-Token"], `${client.account.id}-requirements`);
  }
});

test("one account cannot switch cars while its previous image is still uploading", { timeout: 5000 }, async () => {
  const { client } = submissionClient("upload-lock");
  let entries = 0;
  let releaseUpload;
  let reportUpload;
  const uploadStarted = new Promise(resolve => { reportUpload = resolve; });
  const uploadHeld = new Promise(resolve => { releaseUpload = resolve; });
  const prepare = client.prepareChatSession;
  client.prepareChatSession = async (...args) => {
    entries += 1;
    return prepare(...args);
  };
  client.uploadChatImages = async () => {
    if (entries === 1) {
      reportUpload();
      await uploadHeld;
    }
    return [];
  };
  const first = client.sendConversation("First image", { imageGeneration: true, files: [{}] });
  await uploadStarted;
  const second = client.sendConversation("Second image", { imageGeneration: true, files: [{}] });
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(entries, 1);
  } finally {
    releaseUpload();
  }
  await Promise.all([first, second]);
  assert.equal(entries, 2);
});
