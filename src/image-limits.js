export const MAX_INPUT_IMAGE_COUNT = 6;

export function assertInputImageCount(count, message = "") {
  if (count <= MAX_INPUT_IMAGE_COUNT) return;
  const error = new Error(message || `最多只能上传 ${MAX_INPUT_IMAGE_COUNT} 张图片。`);
  error.status = 400;
  throw error;
}
