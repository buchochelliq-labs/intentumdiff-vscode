import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Fake-server coverage catalogue, optionally restricted to an external runtime's languages.
 * Querying a runtime here does not change the suite into real-engine acceptance.
 */
export function readContractLanguages(extensionRoot: string, python?: string): string[] {
  let value: unknown;
  if (python !== undefined) {
    if (!python.trim()) throw new Error("INTENTUMDIFF_TEST_PYTHON must name a Python executable");
    try {
      value = JSON.parse(execFileSync(python, ["-c",
        "import json; from intentumdiff import SemanticDiffer; " +
        "d = SemanticDiffer(); print(json.dumps(d.supported_languages())); d.close()",
      ], { cwd: extensionRoot, encoding: "utf8", timeout: 30000,
        maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
    } catch (error) {
      throw new Error("Cannot query INTENTUMDIFF_TEST_PYTHON. Select an interpreter with " +
        "the candidate intentumdiff package and Rust library installed, or unset it for " +
        "fake-server contract coverage.", { cause: error });
    }
  } else {
    value = JSON.parse(fs.readFileSync(path.join(extensionRoot,
      "test", "fixtures", "contract-languages.json"), "utf8"));
  }
  if (!Array.isArray(value) || value.length === 0 ||
      !value.every(item => typeof item === "string" && /^[a-z0-9-]+$/.test(item))) {
    throw new Error("Integration languages must be a nonempty array of language identifiers");
  }
  return [...new Set(value as string[])].sort();
}

export interface LanguageSmokeFile {
  language: string;
  kind: "addition" | "deletion" | "modification" | "style" | "guardrail" | "parse" | "refactoring";
  path: string;
}

export function buildLanguageSmokeFiles(languages: string[]): LanguageSmokeFile[] {
  const kinds: LanguageSmokeFile["kind"][] = [
    "addition",
    "deletion",
    "modification",
    "style",
    "guardrail",
    "parse",
    "refactoring",
  ];
  if (languages.length === 0) throw new Error("Smoke scenarios require at least one language");
  return Array.from({ length: Math.max(languages.length, kinds.length) }, (_, index) => {
    const language = languages[index % languages.length];
    const kind = kinds[index % kinds.length];
    const slug = `${language.replace(/[^a-z0-9_-]/giu, "_")}-${kind}`;
    return {
      language,
      kind,
      path: kind === "addition"
        ? `language-smoke-added/${slug}.txt`
        : `language-smoke/${slug}.txt`,
    };
  });
}
