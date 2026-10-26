import assert from "node:assert/strict";
import test from "node:test";

import { styles } from "../src/reviewWebviewStyles";

test("review diff source cells wrap instead of clipping changed text", () => {
  const css = styles();

  assert.match(
    css,
    /\.diff-row code \{[^}]*white-space:pre-wrap;[^}]*overflow:visible;[^}]*overflow-wrap:anywhere;[^}]*text-overflow:clip;/u,
  );
  assert.doesNotMatch(
    css,
    /\.diff-row code \{[^}]*overflow:hidden;[^}]*text-overflow:ellipsis;/u,
  );
});
