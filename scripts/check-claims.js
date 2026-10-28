import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const CLAIMS_FILE = resolve(process.cwd(), "docs", "claims.json");
// Written by `pnpm test`: a claim only counts when its test ran and passed, not merely when its name appears
const REPORT_FILE = resolve(process.cwd(), "test-results", "vitest.json");

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

if (!existsSync(REPORT_FILE)) {
  console.error(`Vitest report not found at ${REPORT_FILE}. Run \`pnpm test\` first.`);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(readFileSync(REPORT_FILE, "utf-8"));
} catch (err) {
  console.error("Invalid JSON in the Vitest report:", err);
  process.exit(1);
}

const resultsByFile = new Map(
  (report.testResults ?? []).map((file) => [resolve(file.name), file.assertionResults ?? []])
);

let failures = 0;
console.log(`Checking ${claims.length} documentation claims against the Vitest report...\n`);

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

  const matches = (resultsByFile.get(filePath) ?? []).filter(
    (t) => t.title === testName || (t.fullName ?? "").includes(testName)
  );
  if (matches.length === 0) {
    console.error(
      `[FAIL] ${id}: Test did not run in ${testFile}\n  Expected: "${testName}"\n  Claim: "${claimText}"`
    );
    failures++;
    continue;
  }

  const notPassed = matches.find((t) => t.status !== "passed");
  if (notPassed) {
    console.error(
      `[FAIL] ${id}: Test ${notPassed.status} in ${testFile}\n  Test: "${testName}"\n  Claim: "${claimText}"`
    );
    failures++;
    continue;
  }

  console.log(`[PASS] ${id}: Test passed in ${testFile}`);
}

if (failures > 0) {
  console.error(`\n${failures} claim verification(s) failed.`);
  process.exit(1);
}

console.log(`\nAll ${claims.length} documentation claims verified successfully!`);
