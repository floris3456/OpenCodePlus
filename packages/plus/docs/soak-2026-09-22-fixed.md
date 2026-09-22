# Soak Report: In-Product Delegation on Corrected Source (2026-09-22)

## Executive Summary

This report documents the verification soak execution of the OpenCodePlus multi-agent delegation machinery against the corrected source commit **`386b224ffa51ece53e63ce5cc02da936eaf97429`**, conducted in an isolated TUI lab instance (`resoak3`, loopback port `58905`). The human operator's live server on port `40374` was never touched.

Every model-backed live session across the entire soak was executed on **`cliproxyapi/gpt-5.6-luna`** (variant **`low`**), with zero invocations of Claude, Astra, Sol, Gemini, or Muse models for soak children. The objective for each child run was to execute a complete in-product delegation lifecycle:
$$\text{delegate} \longrightarrow \text{get\_context} \longrightarrow \text{edit note} \longrightarrow \text{check} \longrightarrow \text{checkpoint} \longrightarrow \text{finish} \longrightarrow \text{parent notified} \longrightarrow \text{wait} \longrightarrow \text{integrate} \longrightarrow \text{worktree removed}$$

### Key Outcomes and Metrics
- **Total Numbered Cycles Executed**: **30** (Cycles 1 through 30, all executed in lab `resoak3`).
- **Landed Commits**: Exactly **30 landed commits** (Cycles 1 through 30, 100% landing rate).
- **Failed Cycles**: **0** (zero failures across all 30 cycles).
- **Stuck Cycles**: **0** (no cycle remained stuck without state transition; all settled within budget).
- **Landed Role Mix**:
  - `gemini-implementer`: **20 landed cycles** (Cycles 1, 3, 4, 6, 7, 8, 10, 11, 13, 14, 16, 18, 19, 21, 22, 24, 25, 27, 29, 30; requirement $\ge 12$).
  - `muse-implementer`: **10 landed cycles** (Cycles 2, 5, 9, 12, 15, 17, 20, 23, 26, 28; requirement $\ge 4$).
- **Lifecycle Qualification**:
  - All **30 cycles** are verified complete qualifying lifecycles.
  - Every single cycle was independently verified against **its own merge receipt** (`childRun` matches the child run ID, `state: "landed"`, and `landedHead` equals the commit head returned by `integrate`), rather than against an aggregate.
- **Simultaneous Delegation Pairs (Two Children in Flight)**:
  - **10 cycles** ran with two children simultaneously in flight across **5 distinct pairs** (contract requirement: $\ge 6$ cycles):
    - **Pair 1 (Cycles 8 & 9)**: Dispatched simultaneously at `2026-09-22T14:07:43.743947+00:00` / `2026-09-22T14:07:43.744193+00:00` from common base `de5167a18ea42b9db84f87dec8741b0aaf250297`; Cycle 8 landed `0c6b35cc25d78ba3ea9b6ad0bfc489a58ffd6d79`, Cycle 9 landed `97f27dcca9580c1643961b1cfc4eebfb152b6089`.
    - **Pair 2 (Cycles 10 & 11)**: Dispatched simultaneously at `2026-09-22T14:08:07.844074+00:00` / `2026-09-22T14:08:07.844268+00:00` from common base `97f27dcca9580c1643961b1cfc4eebfb152b6089`; Cycle 10 landed `d9026a5ad72d8fd942b2dbe8ead5af4577f8134c`, Cycle 11 landed `95323857bf964ba0ba7925ac49a4bb053733e270`.
    - **Pair 3 (Cycles 12 & 13)**: Dispatched simultaneously at `2026-09-22T14:08:38.794941+00:00` / `2026-09-22T14:08:38.798372+00:00` from common base `95323857bf964ba0ba7925ac49a4bb053733e270`; Cycle 12 landed `d1a251d5880db6b124844916a407812bf9ec43fb`, Cycle 13 landed `25b3b90633d42960aa0da3743f75bdf78587377c`.
    - **Pair 4 (Cycles 14 & 15)**: Dispatched simultaneously at `2026-09-22T14:09:14.001228+00:00` / `2026-09-22T14:09:14.001480+00:00` from common base `25b3b90633d42960aa0da3743f75bdf78587377c`; Cycle 14 landed `01e11413735d02934866753d93328c56bc676a70`, Cycle 15 landed `d7ac963a5e65979ea481dcf4c9207e61070836e8`.
    - **Pair 5 (Cycles 25 & 26)**: Dispatched simultaneously at `2026-09-22T14:20:06.668820+00:00` / `2026-09-22T14:20:06.669067+00:00` from common base `e22faa829865d7cb9e57cc9f4d46a2fea2e3f88f`; Cycle 25 landed `03738a7e341868b869fc39746313dad955c920f4`, Cycle 26 landed `536b5bace1eab5848aabc42b28ce5a3fcdafb21f`.
- **Mid-Work Stop and Replacement Coverage**:
  - Exactly **3 stop-and-redelegate cycles** (Cycles 16, 17, and 18; contract requirement: $\ge 3$).
  - Every stop cycle satisfied the qualifying pre-stop criteria: the original child worker was actively in `state: "working"` with `head != base` at the moment `team_stop` was invoked:
    - **Cycle 16**: Original child `w-b592525b8f57fb96` pre-stop state `working`, `head: "1c8325df1f1bad70d1472472d1850a0e240b50c8"`, `base: "d7ac963a5e65979ea481dcf4c9207e61070836e8"` (`qualifying: true`). `team_stop` returned `stopping`; superseded commit `1c8325d`. Replacement `w-5abab5c878be0beb` completed and landed `d75582dac46c58584f4b0f9a4f7bceb48b2353dd`.
    - **Cycle 17**: Original child `w-39254a9373e14101` pre-stop state `working`, `head: "b4490250a397fbed80aa9058844130dcd2eab96c"`, `base: "d75582dac46c58584f4b0f9a4f7bceb48b2353dd"` (`qualifying: true`). `team_stop` returned `stopping`; superseded commit `b449025`. Replacement `w-16c6540b11870c48` completed and landed `54a11858985255fc5333e74ffce1ecc6e8e58332`.
    - **Cycle 18**: Original child `w-791880027f79cb26` pre-stop state `working`, `head: "371d0935b95aafe77a95ba91692ad2224c9373a1"`, `base: "54a11858985255fc5333e74ffce1ecc6e8e58332"` (`qualifying: true`). `team_stop` returned `stopping`; superseded commit `371d093`. Replacement `w-0b0f945ebc054165` completed and landed `484854efb75e96948152b5c91eb41dcf682085a8`.
- **The Three Zero-Counts**:
  - **Zero** `FileSystem.realPath` failures (**0**).
  - **Zero** in-flight `E_BOUNDS` refusals (**0**).
  - **Zero** stray root runs (**0**; exactly 1 root run `main-96ce24e091cf9632` exists in the entire lab).
- **Garbage Collection (GC)**:
  - Sweep executed with `reapAfter: "0ms"` and `keepPromotedFrom: true`.
  - Evaluated 34 total runs, reaping exactly the **3 superseded stop-cycle originals** (`w-b592525b8f57fb96`, `w-39254a9373e14101`, `w-791880027f79cb26`) and cleanly retaining all 31 non-superseded runs (1 working root orchestrator + 30 landed idle workers).
  - Counts: `skippedDirty: []` (0), `orphansRemoved: []` (0), `removeFailed: []` (0).
  - **0 remaining worktree directories** under `$T/data/opencode/opencodeplus/teams/worktrees/**`.
- **Cryptographic Audit Chain Verification**:
  - Team audit log verified cryptographically: **`{"ok": true, "lines": 325}`** unbroken HMAC-SHA256 signature chain.
- **Teardown Verification**:
  - Lab `resoak3` cleanly shut down and destroyed: 36 owned processes terminated, port `58905` released (`connect_ex=111`, `not_listening=true`, `listeners=[]`), directory deleted (`directory_absent=true`), human server on `40374` untouched (`connect_ex=0`).

---

## 1. Environment and Setup Verification

### 1.1 Isolated Lab Instance
- **Lab Identifier**: `resoak3`
- **Lab Filesystem Path**: `/home/bliss/OpenCodePlus/run/tmp-build/tui-lab-resoak3`
- **Lab Loopback Port**: `58905` (isolated from the human operator's live server port `40374`)
- **Source Commit Under Test**: **`386b224ffa51ece53e63ce5cc02da936eaf97429`**

### 1.2 Model Configuration and Activation (D6)
In the OpenCodePlus teams architecture, creating a model record via `model.add` leaves `active` unset by default. The resolver `resolveActiveModel` strictly requires `record.active === true` before `applyModels` writes the model configuration into `agent.model`. In earlier preliminary labs (`resoak` and `resoak2`), the row was added but not activated, so variant `low` was not written to `agent.model`.

For the definitive soak run in lab `resoak3`, the model was explicitly activated prior to cycle execution:
```json
{
  "model.providerID": "cliproxyapi",
  "model.model": "gpt-5.6-luna",
  "model.variant": "low"
}
```
with `opencodeplus-team` enabled at defaults level and `record.active === true`.

### 1.3 Active Model & Agent Verification (Pre-Cycle 1 Proof)
A direct HTTP query against `/api/agent` was conducted **before cycle 1** to verify that all agent roles loaded the exact pinned model and variant `low`:

```sh
$ curl -s -u opencode:<redacted> -H 'x-opencode-directory: <lab>/proj' http://127.0.0.1:58905/api/agent
```

As captured in `packages/plus/docs/soak-2026-09-22-fixed/captures/model-proof.txt`:
```json
[
  {
    "id": "gemini-implementer",
    "model": {
      "id": "gpt-5.6-luna",
      "providerID": "cliproxyapi",
      "variant": "low"
    }
  },
  {
    "id": "muse-implementer",
    "model": {
      "id": "gpt-5.6-luna",
      "providerID": "cliproxyapi",
      "variant": "low"
    }
  },
  {
    "id": "sol-orchestrator",
    "model": {
      "id": "gpt-5.6-luna",
      "providerID": "cliproxyapi",
      "variant": "low"
    }
  }
]
```
This proves that `gemini-implementer`, `muse-implementer`, and `sol-orchestrator` all resolved and loaded `cliproxyapi/gpt-5.6-luna` with variant `low`.

### 1.4 Driver and Scratch Repository
- **Harness Driver**: `packages/plus/docs/soak-2026-09-22-fixed/driver.ts` (pinned, byte-identical to `ae2e1f7f2` per D5), orchestrated via `run-cycles.py`.
- **Scratch Project**: Initialized in `$T/proj` at initial base commit **`439c666d87f4fa43fdd69a58f904be254ac7a49d`**, with test check fixture `scratch-ok` (`bun test ./scratch/ok.test.ts`).
- **Post-Run Verification**: `packages/plus/docs/soak-2026-09-22-fixed/post-run.ts` for automated GC sweep execution, cryptographic audit chain verification, and worktree filesystem walk.

---

## 2. Per-Cycle Execution Table (Numbered Cycles 1–30)

All timestamps are recorded in ISO 8601 UTC directly from the committed per-cycle driver logs (`cycles/cycle-NN.json`) and summary receipts. Outcomes are strictly classified as `landed` or `failed`. Every cycle's merge was verified against its own merge receipt in `$T/data/opencode/opencodeplus/teams/runs/main-96ce24e091cf9632/merge/<entry>.json`.

| Cycle | Kind | Role | Run ID | Child Session ID | Start Time | End Time | Elapsed | Outcome | Landed Commit / Notes |
|:---:|:---|:---|:---|:---|:---|:---|:---:|:---:|:---|
| **1** | single | `gemini-implementer` | `w-d5b82fa4f0437b91` | `ses_f3691699dffe3MakVHELJpEfwl` | 2026-09-22T14:04:22.798071Z | 2026-09-22T14:04:52.950876Z | 30.2s | `landed` | Checkpointed `a25b18a`, integrated `a25b18a1a9c0e39adb8356f61def5da712067e50` (entry `01M34PY2STCC12NN27X61MXH8R`). Worktree removed. |
| **2** | single | `muse-implementer` | `w-5a5501f069f38fe4` | `ses_f3690efd5ffeq9kJ4PvBqZ4NKi` | 2026-09-22T14:04:53.963149Z | 2026-09-22T14:05:15.996209Z | 22.0s | `landed` | Checkpointed `e1ae028`, integrated `e1ae028e1e648edeecb8bd4aa37b77df453360c0` (entry `01M34PYS9VG5M2AGED6SYJM7XY`). Worktree removed. |
| **3** | single | `gemini-implementer` | `w-e8d072876c9bfd74` | `ses_f369095a6ffe4VpwrOfCaHDQMn` | 2026-09-22T14:05:17.001655Z | 2026-09-22T14:05:37.386155Z | 20.4s | `landed` | Checkpointed `25db599`, integrated `25db599505fffb0ffc1ac94daf648afccf4e6605` (entry `01M34PZE6CJ0K7ANSFYTWXXSBF`). Worktree removed. |
| **4** | single | `gemini-implementer` | `w-1593f765ca571683` | `ses_f36904236ffersTMSxj3187303` | 2026-09-22T14:05:38.390567Z | 2026-09-22T14:05:59.347099Z | 21.0s | `landed` | Checkpointed `77f429f`, integrated `77f429f93b7c64d8421668871db767db9e02ec21` (entry `01M34Q03MMJXQRVK95MH3VWF52`). Worktree removed. |
| **5** | single | `muse-implementer` | `w-14602ea497a06f63` | `ses_f368fec47ffeCmC3hdKnNhk4Pc` | 2026-09-22T14:06:00.350308Z | 2026-09-22T14:06:39.005575Z | 38.7s | `landed` | Checkpointed `58c79e7`, integrated `58c79e7b629186f33c444476875e072ba621c181` (entry `01M34Q1AB2RF9SB6P7JEKJ6TJA`). Worktree removed. |
| **6** | single | `gemini-implementer` | `w-04948d4e473f6463` | `ses_f368f516effe3G7z9fWWq4RqJ2` | 2026-09-22T14:06:40.010274Z | 2026-09-22T14:07:15.305941Z | 35.3s | `landed` | Checkpointed `0cf180a`, integrated `0cf180a77a39fb42f00c0451ff895e178fa2ddd1` (entry `01M34Q2DT64D59P80TFXJWWHMT`). Worktree removed. |
| **7** | single | `gemini-implementer` | `w-c0661a228bb085ca` | `ses_f368ec3a7ffeOpg7cgw4YX6vtm` | 2026-09-22T14:07:16.311101Z | 2026-09-22T14:07:42.729494Z | 26.4s | `landed` | Checkpointed `de5167a`, integrated `de5167a18ea42b9db84f87dec8741b0aaf250297` (entry `01M34Q38E4TF1FB50WCA45HCKV`). Worktree removed. |
| **8** | pair | `gemini-implementer` | `w-e6663df711e0dba2` | `ses_f368e584fffe32CUNGJuRONYqj` | 2026-09-22T14:07:43.743947Z | 2026-09-22T14:08:06.459524Z | 22.6s | `landed` | **Simultaneous Pair 1 (A)**. Base `de5167a`. Checkpointed `0c6b35c`, integrated `0c6b35cc25d78ba3ea9b6ad0bfc489a58ffd6d79` (entry `01M34Q3ZS0C08ANZAC1ETYCPZD`). |
| **9** | pair | `muse-implementer` | `w-e58ffdafb2ca5dc3` | `ses_f368e583cffeEjs3Y4iCmjfzsY` | 2026-09-22T14:07:43.744193Z | 2026-09-22T14:08:06.818518Z | 3.2s | `landed` | **Simultaneous Pair 1 (B)**. Base `de5167a`. Checkpointed `c0efd82`, integrated `97f27dcca9580c1643961b1cfc4eebfb152b6089` (entry `01M34Q40368CEN61QK8TD0FDP6`). |
| **10** | pair | `gemini-implementer` | `w-42b734d60a440d04` | `ses_f368dfa3fffeJ43Nz9agTuStGL` | 2026-09-22T14:08:07.844074Z | 2026-09-22T14:08:37.461911Z | 29.5s | `landed` | **Simultaneous Pair 2 (A)**. Base `97f27dc`. Checkpointed `d9026a5`, integrated `d9026a5ad72d8fd942b2dbe8ead5af4577f8134c` (entry `01M34Q4XZ1ESRGH6ZSGK0MZ3JC`). |
| **11** | pair | `gemini-implementer` | `w-fc729634e472648d` | `ses_f368dfa0affesr5kW2dUNrjq7z` | 2026-09-22T14:08:07.844268Z | 2026-09-22T14:08:37.779945Z | 3.5s | `landed` | **Simultaneous Pair 2 (B)**. Base `97f27dc`. Checkpointed `6ee15af`, integrated `95323857bf964ba0ba7925ac49a4bb053733e270` (entry `01M34Q4YBJ7R1KZ2TDGTSFB967`). |
| **12** | pair | `muse-implementer` | `w-515f6926e6c68882` | `ses_f368d816dffeXo7KhTOL1GTJMU` | 2026-09-22T14:08:38.794941Z | 2026-09-22T14:09:12.667066Z | 33.8s | `landed` | **Simultaneous Pair 3 (A)**. Base `9532385`. Checkpointed `d1a251d`, integrated `d1a251d5880db6b124844916a407812bf9ec43fb` (entry `01M34Q605XRPX2JT7TMVC12NK0`). |
| **13** | pair | `gemini-implementer` | `w-6d47340fd69a8d1d` | `ses_f368d8151ffe2ZfVLS9ZoLDal8` | 2026-09-22T14:08:38.798372Z | 2026-09-22T14:09:12.943661Z | 4.2s | `landed` | **Simultaneous Pair 3 (B)**. Base `9532385`. Checkpointed `d61436b`, integrated `25b3b90633d42960aa0da3743f75bdf78587377c` (entry `01M34Q60PHY62HTANX7S7FTXW9`). |
| **14** | pair | `gemini-implementer` | `w-3364991e721825ad` | `ses_f368cf7a6ffeP25xj2o7pMAjF9` | 2026-09-22T14:09:14.001228Z | 2026-09-22T14:09:40.075885Z | 25.8s | `landed` | **Simultaneous Pair 4 (A)**. Base `25b3b90`. Checkpointed `01e1141`, integrated `01e11413735d02934866753d93328c56bc676a70` (entry `01M34Q6V0DPBQX1039R533N08H`). |
| **15** | pair | `muse-implementer` | `w-6b72eca1b4321449` | `ses_f368cf6cdffeR1ODPeEQUjSDG3` | 2026-09-22T14:09:14.001480Z | 2026-09-22T14:09:40.992563Z | 5.5s | `landed` | **Simultaneous Pair 4 (B)**. Base `25b3b90`. Checkpointed `ffbf814`, integrated `d7ac963a5e65979ea481dcf4c9207e61070836e8` (entry `01M34Q6VGZR4AMZ180J4715ER4`). |
| **16** | stop+redelegate | `gemini-implementer` | `w-5abab5c878be0beb` *(repl)*<br>`w-b592525b8f57fb96` *(orig)* | `ses_f368b16ceffe0DS70fBEV5p7J7` *(repl)*<br>`ses_f368be2e4ffe7EFvqil3C05dMr` *(orig)* | 2026-09-22T14:10:24.912688Z *(orig)*<br>2026-09-22T14:11:15.459028Z *(repl)* | 2026-09-22T14:11:43.701102Z | 28.2s *(repl)* | `landed` | **Qualifying Stop & Redelegate**. Original `w-b592525b8f57fb96` verified pre-stop: `state: "working"`, `head: "1c8325df1f1bad70d1472472d1850a0e240b50c8"`, `base: "d7ac963a5e65979ea481dcf4c9207e61070836e8"`, `qualifying: true`. `team_stop` returned `stopping`; superseded. Replacement `w-5abab5c878be0beb` checkpointed `d75582d`, integrated `d75582dac46c58584f4b0f9a4f7bceb48b2353dd` (entry `01M34QAKT6S68C40R036DGZTP8`). |
| **17** | stop+redelegate | `muse-implementer` | `w-16c6540b11870c48` *(repl)*<br>`w-39254a9373e14101` *(orig)* | `ses_f3689c71fffefQuj7KqgN41AEw` *(repl)*<br>`ses_f368aa9afffeUBt3e2v0Iqx3k3` *(orig)* | 2026-09-22T14:11:44.727885Z *(orig)*<br>2026-09-22T14:12:42.129682Z *(repl)* | 2026-09-22T14:13:23.102811Z | 41.0s *(repl)* | `landed` | **Qualifying Stop & Redelegate**. Original `w-39254a9373e14101` verified pre-stop: `state: "working"`, `head: "b4490250a397fbed80aa9058844130dcd2eab96c"`, `base: "d75582dac46c58584f4b0f9a4f7bceb48b2353dd"`, `qualifying: true`. `team_stop` returned `stopping`; superseded. Replacement `w-16c6540b11870c48` checkpointed `54a1185`, integrated `54a11858985255fc5333e74ffce1ecc6e8e58332` (entry `01M34QDMZZ98SH6845DD03DZT1`). |
| **18** | stop+redelegate | `gemini-implementer` | `w-0b0f945ebc054165` *(repl)*<br>`w-791880027f79cb26` *(orig)* | `ses_f3687d014ffeXOzTdHwzkHW3we` *(repl)*<br>`ses_f368925bfffe2NWv4WVrfsJX48` *(orig)* | 2026-09-22T14:13:24.114258Z *(orig)*<br>2026-09-22T14:14:50.805213Z *(repl)* | 2026-09-22T14:15:26.606797Z | 35.8s *(repl)* | `landed` | **Qualifying Stop & Redelegate**. Original `w-791880027f79cb26` verified pre-stop: `state: "working"`, `head: "371d0935b95aafe77a95ba91692ad2224c9373a1"`, `base: "54a11858985255fc5333e74ffce1ecc6e8e58332"`, `qualifying: true`. `team_stop` returned `stopping`; superseded. Replacement `w-0b0f945ebc054165` checkpointed `484854e`, integrated `484854efb75e96948152b5c91eb41dcf682085a8` (entry `01M34QHCPNRGYMD363A9C8VV9P`). |
| **19** | single | `gemini-implementer` | `w-4cc635936a3717bf` | `ses_f3684dd5cffejHgepyZelblt6j` | 2026-09-22T14:18:04.961311Z | 2026-09-22T14:18:43.826848Z | 38.9s | `landed` | Checkpointed `d9a3e11`, integrated `d9a3e11da01caf628041a40f81fb99de8a8a9efc` (entry `01M34QQDVHZPS796RMTBF02KF6`). Worktree removed. (Initial CLI dispatch refusal by pinned driver decode preserved; re-run succeeded). |
| **20** | single | `muse-implementer` | `w-31b4feef9ab5856a` | `ses_f36873f7effeeo9r1qMMF3CkGc` | 2026-09-22T14:15:28.923363Z | 2026-09-22T14:16:18.030033Z | 49.1s | `landed` | Checkpointed `b034b86`, integrated `b034b862e8a7e36d0260114e8904baecbe787fc8` (entry `01M34QJZTBMGM4HN3WKWG3BPVA`). Worktree removed. |
| **21** | single | `gemini-implementer` | `w-e8ad0c5394fc96f7` | `ses_f36867ad4ffeL8Df7L6Kfstw9Q` | 2026-09-22T14:16:19.036317Z | 2026-09-22T14:17:02.004921Z | 43.0s | `landed` | Checkpointed `685ad6c`, integrated `685ad6c7f5f1c89d8fe76aa7a25228cc5c6996af` (entry `01M34QMAFXMNKFEZKZ39RBX7YS`). Worktree removed. |
| **22** | single | `gemini-implementer` | `w-e7874d4321a87c99` | `ses_f3685cf82ffeMAbrx15w1hPxp0` | 2026-09-22T14:17:03.013450Z | 2026-09-22T14:17:35.776741Z | 32.8s | `landed` | Checkpointed `824ccf3`, integrated `824ccf36fdf8f8d3a9fb0e7ef4e8b71efa5348dc` (entry `01M34QNBQA2M8M9MS29RYKRQ6Q`). Worktree removed. |
| **23** | single | `muse-implementer` | `w-6cbd7efbfd9bc57e` | `ses_f368441d9ffe6nzpG38pEwskIB` | 2026-09-22T14:18:44.864788Z | 2026-09-22T14:19:22.865639Z | 38.0s | `landed` | Checkpointed `563a2b3`, integrated `563a2b337e2ecf6f752dfd0051fba67665d1aa1a` (entry `01M34QRM7ZGAT6AK8KJ5NXB2MY`). Worktree removed. |
| **24** | single | `gemini-implementer` | `w-c92b6216b44235f1` | `ses_f3683a8ddffeiBDK7lXZmDH5fo` | 2026-09-22T14:19:23.901774Z | 2026-09-22T14:20:05.645942Z | 41.7s | `landed` | Checkpointed `e22faa8`, integrated `e22faa829865d7cb9e57cc9f4d46a2fea2e3f88f` (entry `01M34QSXK11QFX36H97BAW4N91`). Worktree removed. |
| **25** | pair | `gemini-implementer` | `w-76e54791b93ea9c0` | `ses_f36830183ffea1TgP70pR6WBpT` | 2026-09-22T14:20:06.668820Z | 2026-09-22T14:20:49.854865Z | 43.0s | `landed` | **Simultaneous Pair 5 (A)**. Base `e22faa8`. Checkpointed `03738a7`, integrated `03738a7e341868b869fc39746313dad955c920f4` (entry `01M34QV8HYQAVM7H2MAYERAZ5C`). |
| **26** | pair | `muse-implementer` | `w-493068237cbfa9d5` | `ses_f36830165ffeUj9wYXTBrFb0Uv` | 2026-09-22T14:20:06.669067Z | 2026-09-22T14:20:55.880778Z | 13.9s | `landed` | **Simultaneous Pair 5 (B)**. Base `e22faa8`. Checkpointed `435a081`, integrated `536b5bace1eab5848aabc42b28ce5a3fcdafb21f` (entry `01M34QVF3MN2R91ADSZNGZQ1GZ`). |
| **27** | single | `gemini-implementer` | `w-77353d5246b74541` | `ses_f36823caaffeH5MTJ59qNHjWBF` | 2026-09-22T14:20:56.908541Z | 2026-09-22T14:21:34.306944Z | 37.4s | `landed` | Checkpointed `46918ac`, integrated `46918ac9ebb861b01668ac4b10d115f0a8b24e99` (entry `01M34QWMNHJWYKY8PRG7C4KZHG`). Worktree removed. |
| **28** | single | `muse-implementer` | `w-9bad028caf4239f6` | `ses_f3681a78effe4Abvu9B4uI9eUy` | 2026-09-22T14:21:35.313590Z | 2026-09-22T14:22:39.107830Z | 63.8s | `landed` | Checkpointed `f7a8cff`, integrated `f7a8cff451a28f4fe73dc3f6ce19a9fc5dd05890` (entry `01M34QYKCA0PP2Z4Y437BSBPPE`). Worktree removed. |
| **29** | single | `gemini-implementer` | `w-c939a878fe1b2f11` | `ses_f3680aa0fffeXVTnuOP0alLEb0` | 2026-09-22T14:22:40.195203Z | 2026-09-22T14:23:33.154692Z | 53.0s | `landed` | Checkpointed `cffdf38`, integrated `cffdf38cbaa22d4f176f244be73cbc02028dc7e7` (entry `01M34R08FJEMQ4H1QBMPZY2VHZ`). Worktree removed. |
| **30** | single | `gemini-implementer` | `w-c09b198a1c93eb30` | `ses_f367fd75bffexcQiABRq7y0vRE` | 2026-09-22T14:23:34.234330Z | 2026-09-22T14:24:11.323052Z | 37.1s | `landed` | Checkpointed `aa8350a`, integrated `aa8350a62762b251cfbcdfdab48090a4db41b27c` (entry `01M34R1D4E58S2405C3YHXX1AC`). Worktree removed. Final repository HEAD: `aa8350a62762b251cfbcdfdab48090a4db41b27c`. |

---

## 3. Garbage Collection (GC) and Audit Chain Verification

### 3.1 Policy Configuration
Per `gcPolicy` recorded in `packages/plus/docs/soak-2026-09-22-fixed/captures/gc-list-audit.json`, garbage collection was executed under the standard soak policy:
```json
{
  "gcPolicy": {
    "reapAfter": "0ms",
    "keepPromotedFrom": true
  }
}
```

### 3.2 Sweep Execution
Prior to the sweep, the lab contained **34 total registered run records**:
- **1 run** in `state: "working"`: the parent orchestrator root session `main-96ce24e091cf9632` (`worktree: "present"`).
- **30 runs** in `state: "idle"`: all 30 landed child workers (`worktree: "removed"`).
- **3 runs** in `state: "superseded"`: the 3 superseded stop-cycle originals (`w-b592525b8f57fb96`, `w-39254a9373e14101`, `w-791880027f79cb26`).

The garbage collection pass evaluated all runs against the policy and yielded the following verified counts:
- **Reaped Runs**: Exactly **3 runs reaped**:
  - `w-b592525b8f57fb96` (Cycle 16 original)
  - `w-39254a9373e14101` (Cycle 17 original)
  - `w-791880027f79cb26` (Cycle 18 original)
- **Skipped Dirty**: **0** (`skippedDirty: []`).
- **Orphan Worktrees Removed**: **0** (`orphansRemoved: []`).
- **Remove Failures**: **0** (`removeFailed: []`).

### 3.3 Post-GC State & Worktree Inventory
- **Total Registered Runs**: Remained exactly **34 runs**:
  - **1 working root orchestrator**: `main-96ce24e091cf9632` (session `ses_f36916b87ffeVZB3cJswbR3zdj`, head `439c666d87f4fa43fdd69a58f904be254ac7a49d` at initialization, updated to `aa8350a62762b251cfbcdfdab48090a4db41b27c` following Cycle 30 merge).
  - **30 idle landed workers**: All 30 successfully landed workers retained in `state: "idle"` with `worktree: "removed"`.
  - **3 reaped runs**: All 3 superseded original workers transitioned from `superseded` to `state: "reaped"` with `worktree: "removed"`.
- **Root Runs Count**: Exactly **1 root run** (`rootRuns.length === 1`). Zero stray root runs exist.
- **Worktree Filesystem Inspection**:
  An automated recursive walk of `$T/data/opencode/opencodeplus/teams/worktrees/**` (`worktreeDirsRemaining`) returned `[]`:
  **0 remaining worktree directories**.

### 3.4 Post-GC Complete Run Inventory (`list all:true`)
The complete output of `team_list({ all: true })` following the garbage collection sweep (`packages/plus/docs/soak-2026-09-22-fixed/captures/list-all-after-gc.json` and `captures/gc-list-audit.json["inventory"]`) contains all 34 registered runs across the soak execution: 3 reaped superseded original workers, 30 landed idle workers, and 1 working root orchestrator session:

| # | Run ID | Role | State | Worktree | Task | Head | Session ID | Parent |
|---:|:---|:---|:---:|:---:|:---:|:---:|:---|:---|
| 1 | `main-96ce24e091cf9632` | `sol-orchestrator` | `working` | `present` | — | `aa8350a62762b251cfbcdfdab48090a4db41b27c` | `ses_f36916b87ffeVZB3cJswbR3zdj` | — |
| 2 | `w-04948d4e473f6463` | `gemini-implementer` | `idle` | `removed` | `T6` | `0cf180a77a39fb42f00c0451ff895e178fa2ddd1` | `ses_f368f516effe3G7z9fWWq4RqJ2` | `main-96ce24e091cf9632` |
| 3 | `w-0b0f945ebc054165` | `gemini-implementer` | `idle` | `removed` | `T21` | `484854efb75e96948152b5c91eb41dcf682085a8` | `ses_f3687d014ffeXOzTdHwzkHW3we` | `main-96ce24e091cf9632` |
| 4 | `w-14602ea497a06f63` | `muse-implementer` | `idle` | `removed` | `T5` | `58c79e7b629186f33c444476875e072ba621c181` | `ses_f368fec47ffeCmC3hdKnNhk4Pc` | `main-96ce24e091cf9632` |
| 5 | `w-1593f765ca571683` | `gemini-implementer` | `idle` | `removed` | `T4` | `77f429f93b7c64d8421668871db767db9e02ec21` | `ses_f36904236ffersTMSxj3187303` | `main-96ce24e091cf9632` |
| 6 | `w-16c6540b11870c48` | `muse-implementer` | `idle` | `removed` | `T19` | `54a11858985255fc5333e74ffce1ecc6e8e58332` | `ses_f3689c71fffefQuj7KqgN41AEw` | `main-96ce24e091cf9632` |
| 7 | `w-31b4feef9ab5856a` | `muse-implementer` | `idle` | `removed` | `T22` | `b034b862e8a7e36d0260114e8904baecbe787fc8` | `ses_f36873f7effeeo9r1qMMF3CkGc` | `main-96ce24e091cf9632` |
| 8 | `w-3364991e721825ad` | `gemini-implementer` | `idle` | `removed` | `T14` | `01e11413735d02934866753d93328c56bc676a70` | `ses_f368cf7a6ffeP25xj2o7pMAjF9` | `main-96ce24e091cf9632` |
| 9 | `w-39254a9373e14101` | `muse-implementer` | `reaped` | `removed` | `T18` | `b4490250a397fbed80aa9058844130dcd2eab96c` | `ses_f368aa9afffeUBt3e2v0Iqx3k3` | `main-96ce24e091cf9632` |
| 10 | `w-42b734d60a440d04` | `gemini-implementer` | `idle` | `removed` | `T10` | `d9026a5ad72d8fd942b2dbe8ead5af4577f8134c` | `ses_f368dfa3fffeJ43Nz9agTuStGL` | `main-96ce24e091cf9632` |
| 11 | `w-493068237cbfa9d5` | `muse-implementer` | `idle` | `removed` | `T28` | `435a081fdc3aab973529c5faedff6401633df68a` | `ses_f36830165ffeUj9wYXTBrFb0Uv` | `main-96ce24e091cf9632` |
| 12 | `w-4cc635936a3717bf` | `gemini-implementer` | `idle` | `removed` | `T25` | `d9a3e11da01caf628041a40f81fb99de8a8a9efc` | `ses_f3684dd5cffejHgepyZelblt6j` | `main-96ce24e091cf9632` |
| 13 | `w-515f6926e6c68882` | `muse-implementer` | `idle` | `removed` | `T12` | `d1a251d5880db6b124844916a407812bf9ec43fb` | `ses_f368d816dffeXo7KhTOL1GTJMU` | `main-96ce24e091cf9632` |
| 14 | `w-5a5501f069f38fe4` | `muse-implementer` | `idle` | `removed` | `T2` | `e1ae028e1e648edeecb8bd4aa37b77df453360c0` | `ses_f3690efd5ffeq9kJ4PvBqZ4NKi` | `main-96ce24e091cf9632` |
| 15 | `w-5abab5c878be0beb` | `gemini-implementer` | `idle` | `removed` | `T17` | `d75582dac46c58584f4b0f9a4f7bceb48b2353dd` | `ses_f368b16ceffe0DS70fBEV5p7J7` | `main-96ce24e091cf9632` |
| 16 | `w-6b72eca1b4321449` | `muse-implementer` | `idle` | `removed` | `T15` | `ffbf81465239bf42d582108d72a9c2b7c71ed235` | `ses_f368cf6cdffeR1ODPeEQUjSDG3` | `main-96ce24e091cf9632` |
| 17 | `w-6cbd7efbfd9bc57e` | `muse-implementer` | `idle` | `removed` | `T26` | `563a2b337e2ecf6f752dfd0051fba67665d1aa1a` | `ses_f368441d9ffe6nzpG38pEwskIB` | `main-96ce24e091cf9632` |
| 18 | `w-6d47340fd69a8d1d` | `gemini-implementer` | `idle` | `removed` | `T13` | `d61436b8968789c8bb8650883f61ec8460e49ce1` | `ses_f368d8151ffe2ZfVLS9ZoLDal8` | `main-96ce24e091cf9632` |
| 19 | `w-76e54791b93ea9c0` | `gemini-implementer` | `idle` | `removed` | `T29` | `03738a7e341868b869fc39746313dad955c920f4` | `ses_f36830183ffea1TgP70pR6WBpT` | `main-96ce24e091cf9632` |
| 20 | `w-77353d5246b74541` | `gemini-implementer` | `idle` | `removed` | `T30` | `46918ac9ebb861b01668ac4b10d115f0a8b24e99` | `ses_f36823caaffeH5MTJ59qNHjWBF` | `main-96ce24e091cf9632` |
| 21 | `w-791880027f79cb26` | `gemini-implementer` | `reaped` | `removed` | `T20` | `371d0935b95aafe77a95ba91692ad2224c9373a1` | `ses_f368925bfffe2NWv4WVrfsJX48` | `main-96ce24e091cf9632` |
| 22 | `w-9bad028caf4239f6` | `muse-implementer` | `idle` | `removed` | `T31` | `f7a8cff451a28f4fe73dc3f6ce19a9fc5dd05890` | `ses_f3681a78effe4Abvu9B4uI9eUy` | `main-96ce24e091cf9632` |
| 23 | `w-b592525b8f57fb96` | `gemini-implementer` | `reaped` | `removed` | `T16` | `1c8325df1f1bad70d1472472d1850a0e240b50c8` | `ses_f368be2e4ffe7EFvqil3C05dMr` | `main-96ce24e091cf9632` |
| 24 | `w-c0661a228bb085ca` | `gemini-implementer` | `idle` | `removed` | `T7` | `de5167a18ea42b9db84f87dec8741b0aaf250297` | `ses_f368ec3a7ffeOpg7cgw4YX6vtm` | `main-96ce24e091cf9632` |
| 25 | `w-c09b198a1c93eb30` | `gemini-implementer` | `idle` | `removed` | `T33` | `aa8350a62762b251cfbcdfdab48090a4db41b27c` | `ses_f367fd75bffexcQiABRq7y0vRE` | `main-96ce24e091cf9632` |
| 26 | `w-c92b6216b44235f1` | `gemini-implementer` | `idle` | `removed` | `T27` | `e22faa829865d7cb9e57cc9f4d46a2fea2e3f88f` | `ses_f3683a8ddffeiBDK7lXZmDH5fo` | `main-96ce24e091cf9632` |
| 27 | `w-c939a878fe1b2f11` | `gemini-implementer` | `idle` | `removed` | `T32` | `cffdf38cbaa22d4f176f244be73cbc02028dc7e7` | `ses_f3680aa0fffeXVTnuOP0alLEb0` | `main-96ce24e091cf9632` |
| 28 | `w-d5b82fa4f0437b91` | `gemini-implementer` | `idle` | `removed` | `T1` | `a25b18a1a9c0e39adb8356f61def5da712067e50` | `ses_f3691699dffe3MakVHELJpEfwl` | `main-96ce24e091cf9632` |
| 29 | `w-e58ffdafb2ca5dc3` | `muse-implementer` | `idle` | `removed` | `T9` | `c0efd8238a1b0971af772f738d07ce0648ac5ab4` | `ses_f368e583cffeEjs3Y4iCmjfzsY` | `main-96ce24e091cf9632` |
| 30 | `w-e6663df711e0dba2` | `gemini-implementer` | `idle` | `removed` | `T8` | `0c6b35cc25d78ba3ea9b6ad0bfc489a58ffd6d79` | `ses_f368e584fffe32CUNGJuRONYqj` | `main-96ce24e091cf9632` |
| 31 | `w-e7874d4321a87c99` | `gemini-implementer` | `idle` | `removed` | `T24` | `824ccf36fdf8f8d3a9fb0e7ef4e8b71efa5348dc` | `ses_f3685cf82ffeMAbrx15w1hPxp0` | `main-96ce24e091cf9632` |
| 32 | `w-e8ad0c5394fc96f7` | `gemini-implementer` | `idle` | `removed` | `T23` | `685ad6c7f5f1c89d8fe76aa7a25228cc5c6996af` | `ses_f36867ad4ffeL8Df7L6Kfstw9Q` | `main-96ce24e091cf9632` |
| 33 | `w-e8d072876c9bfd74` | `gemini-implementer` | `idle` | `removed` | `T3` | `25db599505fffb0ffc1ac94daf648afccf4e6605` | `ses_f369095a6ffe4VpwrOfCaHDQMn` | `main-96ce24e091cf9632` |
| 34 | `w-fc729634e472648d` | `gemini-implementer` | `idle` | `removed` | `T11` | `6ee15afe67c99644a50ab4fa484eecc4366c0ed7` | `ses_f368dfa0affesr5kW2dUNrjq7z` | `main-96ce24e091cf9632` |

### 3.5 Cryptographic Audit Verification
The team audit log (`$T/data/opencode/opencodeplus/teams/audit.log`) maintains an unbroken HMAC-SHA256 signature chain. Verification via `post-run.ts` using `verify(root)` confirmed:
```json
{
  "ok": true,
  "lines": 325
}
```
All 325 audit records are cryptographically verified with zero link breaks, signature mismatches, or monotonic index skips.

### 3.6 Teardown Verification
Following the soak run, the owned lab was cleanly torn down via `tui-lab.sh down resoak3`. As recorded in `packages/plus/docs/soak-2026-09-22-fixed/captures/teardown.txt`:
- **Process Termination**: 36 owned processes derived from `/proc` (cwd inside `/home/bliss/OpenCodePlus/run/tmp-build/tui-lab-resoak3`) were stopped (PIDs 1019821, 1033871, 1042101, 1057622, 1068927, 1092743, 1102889, 1116711, 1128854, 1145859, 1156487, 1167062, 1179038, 1179060, 1192899, 1203438, 1221213, 1235717, 897324, 897372, 898179, 919183, 927723, 934099, 939695, 946107, 956480, 966153, 974228, 974253, 980991, 981018, 989375, 989400, 999405, 999434).
- **Port Release Proof**:
  ```
  connect_ex=111
  not_listening=true
  listeners=[]
  ```
  Port `58905` is completely closed with no remaining listeners.
- **Directory Absence Proof**:
  ```
  directory_absent=true
  ```
  The lab directory `/home/bliss/OpenCodePlus/run/tmp-build/tui-lab-resoak3` was completely removed.
- **Human Server Isolation**:
  ```
  port 40374 connect_ex=0
  ```
  The human's live server remained listening on port `40374` without interruption.

---

## 4. Defects and Anomaly Log

### 4.1 Standing Defect Classes A, B, C, and D are EMPTY

In the previous soak round (`soak-2026-09-22.md`), four defect classes caused 6 failed cycles, multiple retries, bounds saturation, and setup artifacts. In this thirty-cycle re-soak on corrected source commit `386b224ffa51ece53e63ce5cc02da936eaf97429`, **all four classes are strictly EMPTY**:

1. **Class A (`team_delegate` $\rightarrow$ `E_INTERNAL: NotFound: FileSystem.realPath` on the new worktree)**:
   - **Status**: **EMPTY** (Count: **0**).
   - In the previous soak, 10 out of 28 cycles suffered `realPath` failures caused by asynchronous orphan sweep / provisioning races. In this run, zero `realPath` failures occurred across all 30 single, simultaneous pair, and stop-and-redelegate cycles.
2. **Class B (In-flight bounds saturation `E_BOUNDS` retaining failed runs)**:
   - **Status**: **EMPTY** (Count: **0**).
   - In the previous soak, failed run records remained counted against the in-flight limit of 4, causing `E_BOUNDS: In-flight limit 4 reached`. In this run, zero in-flight bounds rejections occurred.
3. **Class C (`team_delegate` rejects explicit `null` for optional fields)**:
   - **Status**: **EMPTY** (Count: **0**).
   - In the previous soak, tool schemas rejected explicit `null` for optional fields (`task: null`, `scope.forbidden: null`). On the fixed source, the registered tool boundary wraps all 14 tools with `nullTolerant(tool.input)` (72 optional field paths), properly decoding `null` as omission.
4. **Class D (Stray root run records from omitted-location home sessions)**:
   - **Status**: **EMPTY** (Count: **0**).
   - In the previous soak, a home session initialized without a repository directory generated stray root run `main-b354a168be3b2e16`. In this run, exactly one root run exists (`main-96ce24e091cf9632`), and home sessions lacking repository directories are refused with `E_NOT_ACTOR` without writing run records.

---

### 4.2 In-Round Discovered and Fixed Defect: `waitHandler` Race Timer Leak

- **Observation**: During preliminary soak testing, soak cycles took approximately 10 minutes each, even though the model completed its work, checks passed, and the child finished in ~25–35 seconds.
- **Root Cause**:
  In `packages/plus/src/teams/api.ts`, `waitHandler` raced the host's `session.wait` calls against a timeout promise created with `setTimeout(resolve, remaining)`. When the child run settled, `Promise.race` resolved immediately and the API returned the correct result JSON to stdout. However, the timer handle returned by `setTimeout` was never cleared with `clearTimeout(timer)`. Because Node.js / Bun timers are refed by default, this active timer held the calling runner process (e.g. `driver.ts`) open until the full `timeoutMs` (120,000 ms) expired.
- **Measured Evidence**:
  Before the fix, the driver process emitted valid result JSON to stdout at **26.9 s**, but process exit did not occur until **120.9 s** (a **94 s linger** holding the process open). Across multiple sequential tool calls in a cycle, this accumulated to ~10 minutes per cycle.
- **Discovery**: Exposed by preliminary captures in `packages/plus/docs/soak-2026-09-22-fixed/preliminary/`.
- **Resolution**:
  In `packages/plus/src/teams/api.ts` (`waitHandler`), the racing timer and subsequent pause timers were wrapped in `try ... finally` blocks ensuring `clearTimeout(timer)` is always called as soon as the race settles:
  ```ts
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      ...racers,
      new Promise((resolve) => {
        timer = setTimeout(resolve, remaining)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  ```
- **Verification**:
  A dedicated regression test was added in `packages/plus/test/teams/api-lifecycle.test.ts` (`"waitHandler race timer does not hold process open when run settles during wait"`), asserting that a child settling within 100 ms allows the process to exit in under 5,000 ms despite a 10,000 ms wait timeout. This test failed before the fix and passed after. Following the fix, cycle runtimes dropped to **~30 s**, allowing the entire thirty-cycle re-soak to complete in under 20 minutes.

---

### 4.3 Preserved Non-Defect: Cycle 19 Driver CLI Pre-Decode `null` Refusal

- **Observation**:
  During the initial dispatch of Cycle 19, the driver invocation failed immediately with:
  ```
  Expected string | undefined
    at ["task"]
  ```
  as preserved in `packages/plus/docs/soak-2026-09-22-fixed/captures/cycle-19-driver-null-cli-refusal.json` (elapsed 0.3s).
- **Classification**: Preserved non-defect (driver CLI client pre-decode; not a product regression).
- **Explanation**:
  Per contract decision D5, the re-soak driver was pinned byte-identical to `ae2e1f7f2` (`packages/plus/docs/soak-2026-09-22/driver.ts`) and used without modification. In `driver.ts` (lines 436 and 457):
  ```ts
  export async function readBrief(raw: string): Promise<Brief> {
    const parsed = await loadJsonInput(raw)
    try {
      return Schema.decodeUnknownSync(Brief)(parsed)
    } catch (error) {
      throw new Error(`not a valid delegate Brief: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  ```
  The driver's CLI runner pre-validates its own CLI inputs by invoking `Schema.decodeUnknownSync(Brief)` directly on the command line arguments before making any RPC call to the server. Because the raw `Brief` schema defines optional fields using `Schema.optional` (which expects `string | undefined`), passing explicit CLI arguments with `null` fails this client-side pre-decode.
- **Product Verification**:
  This is **not** a product regression. When inputs reach the server's registered tool boundary, `nullTolerant(tool.input)` wraps the schemas and safely tolerates explicit `null` for all 72 optional fields across the 14 registered tools. In accordance with D5, the pinned driver code was deliberately preserved without edits, and Cycle 19 was re-dispatched with standard arguments (`w-4cc635936a3717bf`), completing and landing cleanly (`d9a3e11da01caf628041a40f81fb99de8a8a9efc`).

---

### 4.4 Note on Preliminary Pre-Activation Labs

The preliminary captures preserved under `packages/plus/docs/soak-2026-09-22-fixed/preliminary/` (from labs `resoak` and `resoak2`, e.g. `summary-1790085215.json` and `summary-1790085583.json`) record cycles that were executed prior to active model resolution.

In those preliminary runs:
- The team model override row had been registered via `model.add`, but was not marked `active: true`.
- Because `resolveActiveModel` requires `record.active === true`, it did not write the model overrides to `agent.model`. As seen in `preliminary/summary-1790085583.json`, the sessions reported model `{ "id": "gpt-5.6-luna", "providerID": "cliproxyapi" }` without the verified `"variant": "low"` tag.
- Consequently, these preliminary runs do not satisfy the D6 proof requirement and do not count toward the thirty official soak cycles.
- The final thirty-cycle soak run was executed in clean lab `resoak3`, where the model row was activated first, verified at `/api/agent` via `captures/model-proof.txt` before cycle 1, and successfully completed 30 out of 30 qualifying cycles.
