# Native pull-request workflow

Create or update a pull request only with the user current authorization.

1. Confirm the branch is not protected, the remote target, and exact commits and diff to publish.
2. Push only the approved branch; do not alter protected branches.
3. Write a concise Japanese summary, changed surface, verification evidence, known limits, and any security review result.
4. Inspect the created pull request and report its URL and current CI/review status.

Do not state that native hooks protect actions outside trusted Codex sessions. A pull request is not a substitute for user approval or underlying sandbox permissions.
