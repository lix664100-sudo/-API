import test from "node:test";
import assert from "node:assert/strict";

import {
  curlTlsCompatibilityArgs,
  runCurlWithTlsCompatibilityRetry
} from "../src/channels/chatplus.js";

function curlError(code, message = "") {
  const error = new Error(message || `curl ${code}`);
  error.curlCode = code;
  error.code = `CURL_${code}`;
  return error;
}

test("聊天请求正常时不会额外重试", async () => {
  const calls = [];
  const result = await runCurlWithTlsCompatibilityRetry(async (args, input, options) => {
    calls.push({ args, input, options });
    return "ok";
  }, ["-sS", "https://one.example.test/login"], "request-body", { abortWhen: null });

  assert.equal(result, "ok");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["-sS", "https://one.example.test/login"]);
});

test("安全连接失败时只用兼容模式重试一次", async () => {
  const calls = [];
  const result = await runCurlWithTlsCompatibilityRetry(async (args, input) => {
    calls.push({ args, input });
    if (calls.length === 1) {
      throw curlError(35, "OpenSSL SSL_connect: SSL_ERROR_SYSCALL");
    }
    return "recovered";
  }, ["-sS", "-X", "POST", "https://one.example.test/frontend-api/login"], "same-body");

  assert.equal(result, "recovered");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].input, "same-body");
  assert.equal(calls[1].input, "same-body");
  assert.deepEqual(calls[1].args.slice(0, 4), [
    "--http1.1",
    "--tlsv1.2",
    "--tls-max",
    "1.2"
  ]);
});

test("代理、超时等其他错误不会被当成安全连接问题重复提交", async () => {
  let calls = 0;
  await assert.rejects(
    runCurlWithTlsCompatibilityRetry(async () => {
      calls += 1;
      throw curlError(97, "connection to proxy closed");
    }, ["https://one.example.test/"]),
    /proxy closed/
  );
  assert.equal(calls, 1);
});

test("兼容模式仍失败时会留下已尝试恢复的标记", async () => {
  let calls = 0;
  await assert.rejects(
    runCurlWithTlsCompatibilityRetry(async () => {
      calls += 1;
      throw curlError(35, "SSL_ERROR_SYSCALL");
    }, ["https://one.example.test/"]),
    (error) => {
      assert.equal(error.tlsCompatibilityRetryAttempted, true);
      assert.equal(error.code, "CURL_TLS_CONNECT_ERROR");
      assert.match(error.message, /已自动使用兼容方式重试/);
      return true;
    }
  );
  assert.equal(calls, 2);
});

test("兼容参数不会修改原请求参数", () => {
  const original = ["-sS", "https://one.example.test/"];
  const compatible = curlTlsCompatibilityArgs(original);

  assert.deepEqual(original, ["-sS", "https://one.example.test/"]);
  assert.deepEqual(compatible.slice(0, 4), ["--http1.1", "--tlsv1.2", "--tls-max", "1.2"]);
});
