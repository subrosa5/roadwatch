# Model and runtime provenance

Model: fiacecson20/cctv-ai-fire-smoke, revision 343990e42d99a5d27e9f35fc7c80880dc5f43f45.
https://huggingface.co/fiacecson20/cctv-ai-fire-smoke

The original model card declares MIT for its weights and CC-BY 4.0 for the source dataset. The ONNX metadata declares AGPL-3.0, and the card also identifies its Ultralytics base as AGPL-3.0. These notices are preserved; Roadwatch makes no claim to relicense the model. See the upstream repository and https://github.com/ultralytics/ultralytics/blob/main/LICENSE for the applicable notices and source. Binary weights are not included in this ZIP; the entry point downloads the exact revision and verifies SHA-256.

The model is an experimental baseline for fire and smoke, not collision detection. Its author notes a small smoke validation set. No Iowa accuracy, calibrated probability or emergency response guarantee is claimed.

OpenCV, NumPy, Requests, python-dotenv and imageio-ffmpeg retain their upstream licenses. The imageio-ffmpeg wheel includes a platform FFmpeg executable; its build configuration and license notices remain applicable. No system package installation or root permission is required by the startup script itself.
