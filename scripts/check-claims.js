import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const CLAIMS_FILE = resolve(process.cwd(), "docs", "claims.json");

if (!existsSync(CLAIMS_FILE)) {
  console.error(`Claims file not found at ${CLAIMS_FILE}`);
  process.exit(1);
}

const raw = readFileSync(CLAIMS_FILE, "utf-8");
let claims;
try {
  claims = JSON.parse(raw);
} catch (err) {
  console.error("Invalid JSON in docs/claims.json:", err);
  process.exit(1);
}

if (!Array.isArray(claims) || claims.length === 0) {
  console.error("docs/claims.json must be a non-empty array of claims");
  process.exit(1);
}

let failures = 0;
console.log(`Checking ${claims.length} documentation claims against test files...\n`);

for (const claim of claims) {
  const { id, claim: claimText, testFile, testName } = claim;
  if (!id || !claimText || !testFile || !testName) {
    console.error(`Malformed claim object: ${JSON.stringify(claim)}`);
    failures++;
    continue;
  }

  const filePath = resolve(process.cwd(), testFile);
  if (!existsSync(filePath)) {
    console.error(`[FAIL] ${id}: Test file does not exist: ${testFile}`);
    failures++;
    continue;
  }

  const content = readFileSync(filePath, "utf-8");
  if (!content.includes(testName)) {
    console.error(
      `[FAIL] ${id}: Test name not found in ${testFile}\n  Expected: "${testName}"\n  Claim: "${claimText}"`
    );
    failures++;
    continue;
  }

  console.log(`[PASS] ${id}: Verified in ${testFile}`);
}

if (failures > 0) {
  console.error(`\n${failures} claim verification(s) failed.`);
  process.exit(1);
}

console.log(`\nAll ${claims.length} documentation claims verified successfully!`);
