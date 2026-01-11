# Logic Drift Example

This example intentionally changes refund logic without updating policy docs.

- Code: `src/billing/refund.js`
- Policy: `docs/refund-policy.md`, `legal/terms.md`

The code uses 7 days, but the policy says 30 days.
