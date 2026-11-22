# Native rebuild evidence

The pinned amd64 source rebuild is an evidence job, not a release replacement step.

- Source: nx.js commit `a649611a1a4daca09924cd1a436c7ca786f91592`, downloaded from the immutable [codeload archive](https://codeload.github.com/TooTallNate/nx.js/tar.gz/a649611a1a4daca09924cd1a436c7ca786f91592)
- Source archive SHA-256: `0477b6b094b69984f97cac3f2a84fef352e2e7bdb01387596425662b2a7622d3`
- SDK image: `ghcr.io/tootallnate/pacman-packages@sha256:92880d77878639768fe3696800104d68de1dfec65802bf7915689dd7bd718e53`
- Rebuilt executable SHA-256: `de6c168e821eadd5af89d9eb47c6a54bd8ea9d39a4be9cce1abc25b3136cb5d5`
- Distributed expected executable SHA-256: `d19416181cc10974ac8b44f902fb0232f032f78e38021f7dbce1dcc3c2834cb6`
- Raw program bytes: `55603200`

Conclusion: native source-to-runtime is **not verified**. The rebuilt executable digest does not equal the distributed expected digest, so the rebuild script fails closed and does not replace `runtime/nxjs-preroll.nro-code.gz`.

The generated `native-rebuild-report.json` records the source revision, release project commit when available, pinned inputs, both digests, NRO size/build-id, and the explicit mismatch reason. A missing report is represented in the release manifest as schema 1 / `status: not-run`; a mismatch is evidence of an attempted rebuild, never a native pass.

The CI evidence job uses the pinned image, downloads and verifies the archive, runs the existing rebuild script, uploads the report and log, and is non-gating only for this expected digest mismatch. Unexpected rebuild errors remain failures. This evidence does not claim hardware playback, commercial-game validation, or any additional native capability.
