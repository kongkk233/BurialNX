# Native rebuild evidence

The pinned amd64 source rebuild is an evidence job, not a release replacement step.

## Distributed artifact lineage

The distributed native blob is traceable to the historical BurialNX PR commit that introduced it, but that lineage is not an exact source-to-runtime rebuild proof:

- Historical distribution commit: `201be25721f124a6f4512ac391a60ce41d921b85` (`feat: add real video and audio media playback`)
- Historical repository: [`ETCHDEV/BurialNX`](https://github.com/ETCHDEV/BurialNX)
- Artifact path: `runtime/nxjs-preroll.nro-code.gz`
- Historical/current Git blob SHA-1: `d58651b6478db5ab4a90a2b8c3482b0efdc26102`
- Current gzip SHA-256: `aed903bf861be6e7baaa9dda3522dfeda60b2c4646a7d7dc9557101247d92874`

The historical manifest records an ARM Mac devkitPro build claim and signed host-tool verification claim, but the repository does not contain the original ARM toolchain binaries, signature transcript, standalone NRO, or build log. The current CI therefore does not upgrade native provenance merely because the distributed blob's Git lineage is known.

## Pinned rebuild inputs

- Source: nx.js commit `a649611a1a4daca09924cd1a436c7ca786f91592`, downloaded from the immutable [codeload archive](https://codeload.github.com/TooTallNate/nx.js/tar.gz/a649611a1a4daca09924cd1a436c7ca786f91592)
- Source archive SHA-256: `0477b6b094b69984f97cac3f2a84fef352e2e7bdb01387596425662b2a7622d3`
- SDK image: `ghcr.io/tootallnate/pacman-packages@sha256:92880d77878639768fe3696800104d68de1dfec65802bf7915689dd7bd718e53`
- CI Node tool: `v22.22.2`, Linux x64 archive SHA-256 `88fd1ce767091fd8d4a99fdb2356e98c819f93f3b1f8663853a2dee9b438068a`
- Upstream stock release executable SHA-256 (control only): `3fbafb0da26d7ba6e8a2c1be208d575559419b231365debda5046a81ed8df1a6`
- Rebuilt executable SHA-256: `de6c168e821eadd5af89d9eb47c6a54bd8ea9d39a4be9cce1abc25b3136cb5d5`
- Rebuilt NRO SHA-256: `af2bac9f6d5ce6463c46f2204c4ef9bb513067cf57d44c429f6af3e1419e392f`
- Rebuilt ELF BuildID: `95f1db2053fc07070d8ac6348dbd5e53dbc17777`
- Distributed expected executable SHA-256: `d19416181cc10974ac8b44f902fb0232f032f78e38021f7dbce1dcc3c2834cb6`
- Distributed ELF BuildID: `a7fa807f9fe38328a28c9573fc1d7ddb530c5fc1`
- Raw program bytes: `55603200`

Conclusion: native source-to-runtime is **not verified**. The rebuilt executable digest does not equal the distributed expected digest, so the rebuild script fails closed and does not replace `runtime/nxjs-preroll.nro-code.gz`.

The generated `native-rebuild-report.json` records the source revision, the 40-character release project commit, pinned inputs, build host architecture and compiler/linker version lines, both digests, NRO size/build-id, and the explicit mismatch reason. CI supplies the release commit explicitly because the pinned container does not include `git`; a supplied pass/mismatch report without that binding is rejected by the release verifier. A missing report is represented in the release manifest as schema 1 / `status: not-run`; a mismatch is evidence of an attempted rebuild, never a native pass.

The CI evidence job uses the pinned image, downloads and verifies the archive, runs the existing rebuild script, uploads the report and log, and is non-gating only for this expected digest mismatch. Unexpected rebuild errors remain failures. This evidence does not claim hardware playback, commercial-game validation, or any additional native capability.
