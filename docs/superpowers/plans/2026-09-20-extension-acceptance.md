# Extension acceptance implementation plan

Goal: complete #24/#25 and build truthful, artifact-bound evidence for #22/#48.
Architecture: Rust owns comparisons and image artifacts; Python transports ABI results; VS Code owns loading state and presentation. Extend the existing installed-VSIX/external-runtime acceptance job. Do not merge or release.

1. Loading (#24): add pending/error model rendering regression in reviewWebviewModel.test.ts; fail it; render an explicit in-panel status before any diff controls. Open pending models, request review, refresh on result, and reject stale asynchronous updates in extension.ts. Test and independently review.
2. Images (#25): exercise a changed tracked PNG through the actual live server; assert returned artifact paths exist and output is compared. Fix demonstrated presentation/transport defects only. Check metric-layout wrapping and capture the actual panel.
3. Media (#22/#48): extend realSuite.ts to capture dark/light/high-contrast/narrow layouts, native diff and a short actual workflow recording. Record candidate provenance and per-file SHA256 in a new capture manifest; reject stale identities in validation. Keep historical captures explicitly historical rather than inventing identities. Do not advertise the unpublished candidate as released.
4. Run extension/review-shell tests and CI, inspect actual captures, obtain independent review, update docs/owner issues. Post-publication verification requires a separately authorized release.

Review focus: pending→ready/error, stale response after switching files, missing image artifacts, constrained width with long paths, stale capture identity.
