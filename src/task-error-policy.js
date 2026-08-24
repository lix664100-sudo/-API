export function isImagePolicyFailureMessage(content) {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  if (!text) return false;
  return /(?:violate|violates|violating).{0,160}(?:guardrails|policy|policies|content)/i.test(text)
    || /(?:guardrails|content policy|safety policy|safety system).{0,160}(?:image|content|request|third-party)/i.test(text)
    || /similarity to third-party content/i.test(text)
    || /(?:内容安全|安全拦截|上游渠道内容安全拦截|违规)/.test(text);
}

export function shouldPersistReturnedErrorTask(error = {}, payload = {}) {
  const code = String(
    error?.code
      || payload?.code
      || error?.responseJson?.code
      || error?.task?.responseJson?.code
      || ""
  ).trim().toUpperCase();
  return code !== "CONCURRENCY_LIMIT" || Boolean(error?.task?.id);
}
