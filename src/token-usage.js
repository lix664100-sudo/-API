import {
  countChatCompletionTokens,
  countTokens
} from "gpt-tokenizer/model/gpt-4o";

const TOKENIZER = "o200k_base";
const IMAGE_ONLY_PROMPT = "请描述图片内容。";

function contentPartText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (part.image_url || part.type === "image_url" || part.type === "input_image") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.text?.value === "string") return part.text.value;
  return String(part.content || part.input_text || "");
}

function messageText(message = {}) {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map(contentPartText).filter(Boolean).join("\n").trim();
  return contentPartText(content).trim();
}

function messageRole(value) {
  const role = String(value || "user").trim().toLowerCase();
  return role || "user";
}

function normalizedMessages(input = {}) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const normalized = messages
    .map((message) => ({
      role: messageRole(message?.role),
      content: messageText(message),
      ...(message?.name ? { name: String(message.name) } : {})
    }))
    .filter((message) => message.content);
  if (normalized.length) return normalized;

  const direct = String(input.message || input.prompt || input.content || "").trim();
  if (direct) return [{ role: "user", content: direct }];
  return estimatedImageCount(input) ? [{ role: "user", content: IMAGE_ONLY_PROMPT }] : [];
}

function messageImageCount(messages = []) {
  let total = 0;
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    total += message.content.filter((part) => (
      part?.image_url || part?.type === "image_url" || part?.type === "input_image"
    )).length;
  }
  return total;
}

export function estimatedImageCount(input = {}) {
  const files = Array.isArray(input.files) ? input.files.length : input.file ? 1 : 0;
  const messages = Array.isArray(input.messages) ? input.messages : [];
  return files + messageImageCount(messages);
}

export function estimateChatTokenUsage(input = {}, outputText = "") {
  const messages = normalizedMessages(input);
  const promptTokens = messages.length
    ? countChatCompletionTokens({ messages })
    : 0;
  const completionTokens = countTokens(String(outputText || ""));
  const imageCount = estimatedImageCount(input);

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    estimated: true,
    tokenizer: TOKENIZER,
    text_only: true,
    image_count: imageCount
  };
}
