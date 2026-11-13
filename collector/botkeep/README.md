# Roadwatch · one-camera Botkeep pilot

This package is prepared for Python 3.12 on the advertised Free v2 allocation (512 MiB RAM / 0.5 shared vCore / 1 GiB disk). It has not yet been deployed to a Botkeep account. It does not require Docker or an apt/root install. FFmpeg comes from the pinned imageio-ffmpeg wheel.

Default start command: `python main.py`.

Default mode: `ROADWATCH_MODE=preflight`. It downloads one pinned 12 MB ONNX model, verifies its SHA-256, obtains one real camera JPEG through FFmpeg, runs six inference samples, reports memory/CPU and exits. This mode sends no observations to the private backend and needs no backend credentials. Exiting after preflight is expected; this is not a running monitor.

## First launch in Botkeep

1. Sign in to your Botkeep account and select the free Python profile. Confirm the displayed allocation and zero price. No payment method is required by the advertised offer; if the actual flow requires one, stop this route.
2. Upload the generated `roadwatch-botkeep.zip` using its ZIP import. The files, including `requirements.txt` and `main.py`, must be at the selected project root. This avoids granting private GitHub repository access during the compatibility test.
3. Install `requirements.txt` through the profile's supported dependency setup. Choose Python 3.12 if offered and confirm the `python main.py` start command. The startup code loads Botkeep's managed `.env` without replacing existing environment variables.
4. Keep `ROADWATCH_MODE=preflight`. Start once, then inspect the JSON output and `data/preflight.json`. Require `camera_network_test=true` and `resource_gate_passed=true`. Confirm there are no package/import/subprocess/network errors. This verifies compatibility, not incident accuracy or long-term availability.
5. Before monitoring, the owner must enable and approve `iowa-cbtv51` in the **server's** camera configuration and publish/synchronize that configuration. This has deliberately not been done while no cloud worker is verified. Changing only the collector JSON cannot bypass the backend gate.
6. Put `INGEST_TOKEN` and `SITES_SERVICE_TOKEN` in the host's private runtime Environment, never in the ZIP, source repository, ordinary logs or support messages. Both are needed for the current owner-private Sites backend. Existing credentials are configured through owner-controlled settings; this archive does not contain them.
7. Set `ROADWATCH_MODE=run` and start. Startup repeats preflight before beginning the collector. Verify a fresh heartbeat appears on the private front, a real JPEG can be read back and the runtime stays alive with the browser closed. An empty incident journal is expected when no event has actually been detected.

Botkeep docs: https://botkeep.cloud/docs/python and https://botkeep.cloud/docs/zip . Its panel is not connected to the coding agent; account sign-in and ZIP import remain external steps.

## Publication and resource bounds

One camera: CBTV51, 480×270 HLS from Iowa DOT. Model input: 320×320, fire/smoke only. Source coordinates and attribution remain in the main Roadwatch project. The model's score is not a calibrated probability. Collision detection is not implemented by this model.

The collector samples one distinct frame every five seconds. Intermediate inference stays local. During quiet operation, a heartbeat and matching JPEG are published once every 15 minutes: 96 observations/day. Two distinct incident frames within six seconds are required. Tentative incident frames are held until confirmation, so an initial heartbeat cannot overwrite the first confirmation frame. Persistent local cooldown suppresses repeated pairs within two minutes. Daily admission is at most 400 publication attempts and 5 clip uploads, reserving space below the backend's 500-record cap. An ambiguous request consumes a local reservation. Backend limits remain authoritative if ephemeral host files are lost.

The process has a 30-segment FFmpeg ring bounded by configured segment count (30 × about 2 seconds; source keyframes can lengthen segments). The compressed-data estimate of one minute is around 1 MB at the previously observed average bitrate; total memory includes the decoder/model. Clips cover available pre/post segments; pre-roll is unavailable until the buffer has filled and is not guaranteed across restarts. H.264 clips are remuxed with codec copy instead of re-encoding/upscaling, reducing CPU and preserving source quality. Stop or reduce the workload if host resource limits are exceeded.

Runtime directory `data/` contains the downloaded model, ring files, publication ledger, CPU ledger and preflight report. Do not upload this directory as source. If the ledger is malformed, startup fails rather than resetting its quota. Disk/CPU/memory usage must be measured on the actual host. The development benchmark is not a Botkeep performance claim.

The server currently expires observations after one day and clips after seven days when its retention endpoint is called. Automatic cleanup is not enabled; the storage cap stops additional evidence if cleanup has not run. This package does not claim to complete retention scheduling, browser-closed push delivery or full 24/7 operation until those are separately verified.

## Build from the private repository

`python3 tools/build-botkeep.py /absolute/path/roadwatch-botkeep.zip`

The builder includes eight explicitly named source/configuration files, including this README and third-party notices. It excludes `.env`, tokens, Git metadata, model binaries, recordings, node_modules and runtime data.

Development-only local fixture override: `ROADWATCH_PREFLIGHT_VIDEO=/path/to/local.mp4`. A fixture probe is marked `camera_network_test=false` and cannot start monitoring in run mode.
