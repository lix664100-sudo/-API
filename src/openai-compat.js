function errorType(status) {
  if (status === 429) return "rate_limit_error";
  if (status >= 400 && status < 500) return "invalid_request_error";
  return "api_error";
}

export function openAIErrorPayload({ status = 500, message = "请求失败", code = null, param = null, legacy = {} } = {}) {
  const safeStatus = Number.isFinite(Number(status)) ? Number(status) : 500;
  const safeMessage = String(message || "请求失败");
  return {
    ...legacy,
    ok: false,
    message: safeMessage,
    ...(code ? { code } : {}),
    error: {
      message: safeMessage,
      type: errorType(safeStatus),
      param,
      code: code || null
    }
  };
}

function completionChunk(completion, delta, finishReason) {
  return {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason
    }]
  };
}

function usageChunk(completion) {
  if (!completion.usage || typeof completion.usage !== "object") return null;
  return {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
    choices: [],
    usage: completion.usage
  };
}

export function chatCompletionSseBody(completion = {}) {
  const content = completion.choices?.[0]?.message?.content ?? "";
  const first = completionChunk(
    completion,
    { role: "assistant", content: String(content) },
    null
  );
  const last = completionChunk(completion, {}, "stop");
  const usage = usageChunk(completion);
  const events = [first, last, ...(usage ? [usage] : [])];
  return `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
}
