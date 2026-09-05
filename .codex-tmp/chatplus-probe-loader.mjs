export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith("/src/channels/chatplus.js")) return result;
  return {
    ...result,
    source: String(result.source).replaceAll("。\\\"", "。\"")
  };
}
