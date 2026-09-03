# Third-party notices

This repository is a **thin downstream of Code-OSS** with Densa ADE code layered on top.
License boundaries are deliberately kept explicit:

- **Densa-written code** (Densa ADE Core, CLI, protocol, built-in Densa ADE extension,
  downstream overlays, docs, and scripts in this repository) is licensed under the
  **Apache License, Version 2.0**. See [`LICENSE`](LICENSE).
- **Upstream Code-OSS code** (`microsoft/vscode`, checked out separately under
  `code-oss/upstream/` and never vendored into this repository) remains under its
  original **MIT License from Microsoft Corporation**.
- **Modified Code-OSS files of any kind** — including direct workbench patches,
  `product.json` deltas derived from upstream defaults, and build/packaging files
  adapted from upstream — **retain Microsoft's MIT notice** alongside the Densa ADE
  Apache-2.0 overlay notice. Per Apache-2.0 §4(c), upstream copyright, patent,
  trademark, and attribution notices are preserved in Source form.

When in doubt, preserve both notices. Do not remove Microsoft's MIT notice from any
file derived from Code-OSS.

---

## 1. Code-OSS (microsoft/vscode) — MIT License

- **Project:** Code-OSS, the open-source distribution of VS Code
- **Upstream repository:** https://github.com/microsoft/vscode.git
- **License:** MIT License
- **Copyright holder:** Microsoft Corporation
- **Local checkout (ignored, not vendored):** `code-oss/upstream/`
- **Pin and sync workflow:** [`code-oss/UPSTREAM.md`](code-oss/UPSTREAM.md),
  [`code-oss/upstream.json`](code-oss/upstream.json)

The full upstream MIT notice is reproduced verbatim below and must remain in this
file for as long as this repository tracks, builds on, or distributes Code-OSS:

```text
MIT License

Copyright (c) Microsoft Corporation. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### How the MIT notice is preserved for modified Code-OSS files

Every direct upstream patch listed in [`code-oss/PATCHES.md`](code-oss/PATCHES.md) and
tracked in [`code-oss/patches/inventory.json`](code-oss/patches/inventory.json) keeps:

1. the original Microsoft copyright line (`Copyright (c) Microsoft Corporation`)
   at the top of each modified upstream file, and
2. a short Densa ADE overlay comment directly below it, for example:

```text
// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See THIRD_PARTY_NOTICES.md.
// ---
// Densa ADE downstream change (Apache-2.0). See code-oss/PATCHES.md.
// Reason: <why an extension contribution could not do the job>.
// Upstream area: <e.g. vs/workbench/contrib/...>.
// Test on upstream merge: <how to verify>.
```

Build-time `product.json` overlays derived from upstream defaults follow the same
rule: the generated file carries both the MIT attribution and the Densa ADE
Apache-2.0 overlay statement. See
[`code-oss/product.overlay.json`](code-oss/product.overlay.json).

---

## 2. Densa ADE (Densa Labs) — Apache License 2.0

- **Project:** Densa ADE
- **Copyright holder:** Densa Labs
- **License:** Apache License, Version 2.0 (`SPDX-License-Identifier: Apache-2.0`)
- **License file:** [`LICENSE`](LICENSE)

New source files written by Densa Labs should carry the standard header:

```text
Copyright 2026 Densa Labs
SPDX-License-Identifier: Apache-2.0
```

---

## 3. Other third-party dependencies

Runtime and development dependencies are declared in `package.json` /
`package-lock.json` (npm) and in the upstream Code-OSS checkout when present.
Dependency licenses are reviewed at release time per `AGENTS.md` §15 and are not
duplicated here unless a dependency requires explicit attribution in distributed
artifacts. The Phase 13 release packaging milestone collects the final
third-party license notices for the distributable macOS application.
