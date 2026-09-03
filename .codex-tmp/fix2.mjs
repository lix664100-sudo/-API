import { readFileSync, writeFileSync } from "node:fs";
const path = "src/portal-session-pool.js";
let s = readFileSync(path, "utf8");
const oldFn = `export function shareSessionFromCookies(cookies = []) {
  for (const cookie of cookies) {
    const text = String(cookie || "").trim();
    if (/^share-session=/i.test(text)) return text.slice("share-session=".length).trim();
  }
  return "";
}`;
const newFn = `export function shareSessionFromCookies(cookies = []) {
  for (const cookie of cookies) {
    const text = String(cookie || "").trim().split(";")[0].trim();
    if (/^share-session=/i.test(text)) return text.slice("share-session=".length).trim();
  }
  return "";
}`;
if (!s.includes(oldFn)) throw new Error("shareSessionFromCookies not found");
s = s.replace(oldFn, newFn);
writeFileSync(path, s);
console.log("fixed shareSessionFromCookies");

const testPath = "test/portal-session-pool.test.js";
let t = readFileSync(testPath, "utf8");
const oldStub = `test("上传初始化返回登录失效错误时按鉴权失败处理", async () => {
  const { client } = makeChatClient({ session: "SESS-A" });
  await client.loginPortal();
  client.json = async () => ({ message: "身份验证失败，请重新登录" });
  const file = {
    toBuffer: async () => Buffer.from("fake-image-bytes"),`;
const newStub = `test("上传初始化返回登录失效错误时按鉴权失败处理", async () => {
  const { client } = makeChatClient({ session: "SESS-A" });
  await client.loginPortal();
  client.json = async () => ({ message: "身份验证失败，请重新登录" });
  const file = {
    toBuffer: async () => Buffer.from("auth-shaped-failure-bytes"),`;
if (!t.includes(oldStub)) throw new Error("test stub not found");
t = t.replace(oldStub, newStub);
writeFileSync(testPath, t);
console.log("fixed test buffer");
