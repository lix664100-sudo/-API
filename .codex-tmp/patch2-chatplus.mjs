import { readFileSync, writeFileSync } from "node:fs";
const file = "src/channels/chatplus.js";
let src = readFileSync(file, "utf8");
let applied = 0;

function escapeRegExpLine(line) {
  return line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function apply(oldText, newText, label) {
  const needleLines = oldText.replace(/\r\n/g, "\n").split("\n");
  const pattern = new RegExp(needleLines.map(escapeRegExpLine).join("\\r?\\n"), "g");
  const matches = [...src.matchAll(pattern)];
  if (matches.length === 0) throw new Error(`[${label}] no match found`);
  if (matches.length > 1) throw new Error(`[${label}] ambiguous: ${matches.length} occurrences`);
  const match = matches[0];
  const matchedText = match[0];
  const crlfCount = (matchedText.match(/\r\n/g) || []).length;
  const bareLfCount = (matchedText.match(/(?<!\r)\n/g) || []).length;
  const eol = crlfCount > bareLfCount ? "\r\n" : "\n";
  const replacement = newText.replace(/\r\n/g, "\n").split("\n").join(eol);
  src = src.slice(0, match.index) + replacement + src.slice(match.index + matchedText.length);
  applied += 1;
  console.log(`ok: ${label}`);
}

apply(
  `function isExplicitAuthSessionError(error) {
  const text = \`\${error?.message || ""} \${error?.body || ""} \${error?.upstreamText || ""}\`;
  return /\\b401\\b|身份验证失败|请重新登录|重新登陆|未登录|未登陆|登录.{0,8}(?:失效|过期)|会话.{0,8}(?:失效|过期)|其他设备登|聊天记录.{0,12}(?:删除|已删除)|换车继续聊|unauthorized|session expired/i.test(text);
}`,
  `function isExplicitAuthSessionError(error) {
  const text = \`\${error?.message || ""} \${error?.body || ""} \${error?.upstreamText || ""}\`;
  return /\\b401\\b|身份验证失败|请重新登录|重新登陆|未登录|未登陆|登录.{0,8}(?:失效|过期)|会话.{0,8}(?:失效|过期)|其他设备登|聊天记录.{0,12}(?:删除|已删除)|换车继续聊|unauthorized|session expired/i.test(text);
}

// 只有"账号被挤下线"这类账号级别的故障才触发快速失败；
// 共享车位自己的认证失败(401/403)仍然按车位故障处理，不能冒充账号掉线。
function isAccountKickError(error) {
  if (error?.authScope === "car" || error?.carPoolUnavailable === true) return false;
  const text = \`\${error?.message || ""} \${error?.body || ""} \${error?.upstreamText || ""}\`;
  return /其他设备登|在其他设备|被挤下线|挤下线/.test(text);
}`,
  "P1 isAccountKickError helper"
);

apply(
  `        if (retryableCarError) {
          if (isAuthSessionError(error)) {
            authKickAttempts += 1;
            if (authKickAttempts >= AUTH_KICK_FAST_FAIL_LIMIT) {
              throw accountSessionContentionError(errors);
            }
          }
          await this.rememberProCarsUnavailable(error);
          await this.rememberAuthFailedCar(selected, error);
          await this.sessionLock(async () => {
            this.invalidateSharedPortalSession();
            this.resetSession();
          });
        }`,
  `        if (retryableCarError) {
          if (isAccountKickError(error)) {
            authKickAttempts += 1;
            if (authKickAttempts >= AUTH_KICK_FAST_FAIL_LIMIT) {
              throw accountSessionContentionError(errors);
            }
          }
          await this.rememberProCarsUnavailable(error);
          await this.rememberAuthFailedCar(selected, error);
          await this.sessionLock(async () => {
            this.invalidateSharedPortalSession();
            this.resetSession();
          });
        }`,
  "P2 prepareChatSession kick scope"
);

apply(
  `        const retryableCarError = selected && (isAuthSessionError(error) || isCarPlanMismatchError(error));
        if (retryableCarError) {
          if (isAuthSessionError(error)) {
            authKickAttempts += 1;
            if (authKickAttempts >= AUTH_KICK_FAST_FAIL_LIMIT) {
              throw accountSessionContentionError(errors);
            }
          }
          await this.rememberProCarsUnavailable(error);
          await this.rememberAuthFailedCar(selected, error);
          await this.invalidatePreparedChatSession(preparedSession);
          recordCarError(error.message || "调用失败");
          continue;
        }`,
  `        const retryableCarError = selected && (isAuthSessionError(error) || isCarPlanMismatchError(error));
        if (retryableCarError) {
          if (isAccountKickError(error)) {
            authKickAttempts += 1;
            if (authKickAttempts >= AUTH_KICK_FAST_FAIL_LIMIT) {
              throw accountSessionContentionError(errors);
            }
          }
          await this.rememberProCarsUnavailable(error);
          await this.rememberAuthFailedCar(selected, error);
          await this.invalidatePreparedChatSession(preparedSession);
          recordCarError(error.message || "调用失败");
          continue;
        }`,
  "P3 sendConversation kick scope"
);

apply(
  `        if (Number(error.status || error.statusCode || 0) === 400) throw error;
        if (isAuthSessionError(error)) {
          authKickAttempts += 1;`,
  `        if (Number(error.status || error.statusCode || 0) === 400) throw error;
        if (isAccountKickError(error)) {
          authKickAttempts += 1;`,
  "P4 standalone kick scope"
);

apply(
  `      reportShareAiPortalFailure({
        proxyUrl: proxyUrlFor(this.account),
        url: this.baseUrl
      });
      this.resetSession();
      await this.performPortalLogin(options);
      this.carId = carId;`,
  `      reportShareAiPortalFailure({
        proxyUrl: proxyUrlFor(this.account),
        url: this.baseUrl
      });
      this.invalidateSharedPortalSession();
      this.resetSession();
      await this.performPortalLogin(options);
      this.carId = carId;`,
  "P5 enterCar route switch invalidates pool"
);

apply(
  `      await this.sessionLock(async () => {
        this.resetSession();
        await this.performPortalLogin(options);
      });
      return this.loadAccountUsages(options, true);`,
  `      await this.sessionLock(async () => {
        this.invalidateSharedPortalSession();
        this.resetSession();
        await this.performPortalLogin(options);
      });
      return this.loadAccountUsages(options, true);`,
  "P6 usages connection retry invalidates pool"
);

apply(
  `        await this.sessionLock(async () => {
          await this.performPortalLogin({ timeoutSec });
          this.carId = carId;`,
  `        await this.sessionLock(async () => {
          this.invalidateSharedPortalSession();
          await this.performPortalLogin({ timeoutSec });
          this.carId = carId;`,
  "P7 socket auth retry invalidates pool"
);

writeFileSync(file, src);
console.log(`done: ${applied} replacements applied`);
