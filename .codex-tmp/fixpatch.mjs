import { readFileSync, writeFileSync } from "node:fs";
const file = ".codex-tmp/patch-chatplus.mjs";
let src = readFileSync(file, "utf8");
const oldFn = `function apply(oldText, newText, label) {
  let needle = oldText, replacement = newText;
  if (isCRLF && !src.includes(needle)) {
    needle = needle.replace(/\\n/g, "\\r\\n");
    replacement = replacement.replace(/\\n/g, "\\r\\n");
  }
  const found = src.split(needle).length - 1;
  if (found !== 1) throw new Error(\`[\${label}] expected 1 occurrence, found \${found}\`);
  src = src.replace(needle, replacement);
  applied += 1;
  console.log(\`ok: \${label}\`);
}`;
const newFn = `function apply(oldText, newText, label) {
  const variants = [
    [oldText, newText],
    [oldText.replace(/\\r?\\n/g, "\\n"), newText.replace(/\\r?\\n/g, "\\n")],
    [oldText.replace(/\\r?\\n/g, "\\r\\n"), newText.replace(/\\r?\\n/g, "\\r\\n")]
  ];
  for (const [needle, replacement] of variants) {
    const found = src.split(needle).length - 1;
    if (found === 1) {
      src = src.replace(needle, replacement);
      applied += 1;
      console.log(\`ok: \${label}\`);
      return;
    }
    if (found > 1) throw new Error(\`[\${label}] ambiguous: \${found} occurrences\`);
  }
  throw new Error(\`[\${label}] no match found\`);
}`;
const normalize = (text) => text.replace(/\r\n/g, "\n");
src = normalize(src);
if (!src.includes(normalize(oldFn))) throw new Error("old apply() not found");
src = src.replace(normalize(oldFn), newFn);
writeFileSync(file, src);
console.log("apply() updated");
