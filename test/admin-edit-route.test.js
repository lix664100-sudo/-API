import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const adminHtml = await readFile(new URL("../admin/index.html", import.meta.url), "utf8");

function loadFunction(name, nextName, context) {
  const start = adminHtml.indexOf(`function ${name}`);
  const end = adminHtml.indexOf(`function ${nextName}`, start);
  assert.ok(start >= 0 && end > start, `${name} must exist in the admin page`);
  return vm.runInNewContext(`(${adminHtml.slice(start, end).trim()})`, context);
}

test("image edit defaults follow the configured chat image priority", () => {
  const channel = {
    id: "shareai",
    type: "shareai",
    settings: { enabledAbilities: { drawing: true, chatplus: true } }
  };
  const channelAbilityEnabled = (item, ability) => item.settings.enabledAbilities[ability] !== false;
  const defaultEditRouteValue = loadFunction("defaultEditRouteValue", "editAbilityForValues", {
    channelAbilityEnabled,
    defaultModelForChannel: () => 1
  });

  assert.equal(
    defaultEditRouteValue("auto", [channel], { imageSourcePriority: "chatplus" }),
    "chatplus:auto"
  );
  assert.equal(
    defaultEditRouteValue("shareai", [channel], { imageSourcePriority: "drawing" }),
    "drawing:1"
  );
});

test("selecting an account does not overwrite a valid manual model choice", () => {
  assert.doesNotMatch(
    adminHtml,
    /if \(!selectedEditAccountValue\) return;\s*const account = accounts\.find[\s\S]*?setFieldValue\("routeModel", nextRoute\)/
  );
});
