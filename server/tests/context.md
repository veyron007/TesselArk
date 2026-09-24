# API test context

- Tests start the Express app with an in-memory SQLite database and make HTTP requests against a random local port.
- Keep tests focused on cross-module effects, company scope, role decisions, idempotency and GST evidence boundaries. Use synthetic fixtures only.
- Run with `npm test`; `node --test --experimental-test-coverage server/tests/*.test.js` reports Node coverage.
