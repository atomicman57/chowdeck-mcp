# Security and deployment boundaries

- This is unofficial software for an account owner and their explicitly trusted agents. Each hosted Worker shares exactly one account. It has no tenant isolation or per-client order budgets.
- The owner key grants full access. Keep it and the AES key in a secret manager/Worker secret bindings; never put either in a URL, Git repository, logs or ordinary client configuration. Authorize only OAuth requests you initiated and recognize; the consent form displays the client, scope and registered callback.
- `chowdeck.write` can initiate account changes and purchases. Tool `confirm:true` is an agent-side approval contract, not independent proof of human consent. An authorized malicious client can submit it. Restrict who gets credentials; use read-only scope where appropriate.
- Hosted account state is encrypted; OAuth token values are represented by hashes in storage. The local Node fallback session file is permission-restricted but plaintext. Select an encrypted helper or memory-only mode if that is unsuitable.
- Session renewal uses the observed Chowdeck storefront contract. It does not bypass revocation, OTP or service security checks. Never extract account tokens from a browser or copy another user's session.
- Idempotency and duplicate records protect calls through this installation. They cannot prevent a separate client or the Chowdeck app from ordering independently. A timeout after placement can have an unknown outcome; reconcile active orders/history before any new attempt. Never bypass an unknown outcome with a new key.
- Food images come from a restricted set of public CDN origins. They are menu images, not guarantees of delivered appearance.
- The API map includes observed but unimplemented operations and uncaptured request schemas. Public source observation is not proof a route will accept your account's request. Live payment and gift delivery for this development release are unverified.

Report a suspected vulnerability privately through GitHub's security reporting if enabled. Otherwise contact the maintainer privately before disclosing exploitable details; never post account tokens or personal order data in a public issue.
