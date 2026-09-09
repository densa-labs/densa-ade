# Third-party development dependencies

P0M0 has no product runtime dependencies. Exact development dependency versions, transitive licenses, registry locations and integrity values are recorded in [the inventory](docs/dependency-inventory.json) and `package-lock.json`.

| Direct dependency | Version | License | Purpose |
| --- | --- | --- | --- |
| TypeScript | 5.9.3 | Apache-2.0 | Strict type checking, declarations, AST architecture checks |
| ESLint | 10.9.1 | MIT | Source linting |
| typescript-eslint | 8.68.0 | MIT | TypeScript ESLint parser and recommended rules |

The inventory also includes transitive MIT, ISC, BSD-2-Clause, Apache-2.0 and any other exact package license declarations. Retain each package's license/copyright notices if redistributing it; Apache-2.0 components additionally require applicable NOTICE retention and modification notices. Development packages are not currently bundled in a product. Reinventory every lockfile change and determine distribution obligations before packaging.

Node and npm are externally installed development tools, not bundled release artifacts. Their upstream notices must be inventoried if a later milestone ships them. Code - OSS source is absent. P12 owns upstream SHA/license and patch notices; P16 owns actual distribution obligations. This file does not assert that a downstream fork or signed application exists.
