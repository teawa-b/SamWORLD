# SamWORLD hackathon video

A 1280 × 720, 30 fps, approximately 2 minute 16 second animated explainer made in Remotion. The narration uses Kokoro ONNX locally, voice `bf_emma`. The room visuals are authored SVG illustrations, not recorded product output. This is stated on every chapter.

## Render

Install with `npm ci`, then run:

```
npx remotion render index.tsx SamWorld SamWORLD_Hackathon.mp4
```

The renderer may download Chrome. A local browser executable can be supplied with `--browser-executable=/absolute/path/to/chrome`.

## Narration

The completed narration WAVs are included. To regenerate them locally, install `kokoro-onnx` and `soundfile`; download the model and voices from the official `thewh1teagle/kokoro-onnx` GitHub release `model-files-v1.0` into `../models/kokoro.onnx` and `../models/voices.bin`, then run `python local-voice.py`.

Official downloads:
- https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx
- https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin

## Scope and verification

The application repository was inspected on 5 November 2026. Its live `/health` reported Muse Spark 1.3, SAM 3.1, SAM 3D via fal, and a configured scan worker. Muse Wonder is an optional escalation adapter, not active in that health report. Muse Image restyling code is present. The legacy `redesign` capability is false; this is separate from the new room-restyle route.

The cloud browser could not create a WebGL context. The video therefore does not claim live interaction, measured reconstruction accuracy, generation speed, or an on-headset test. A real product recording would strengthen the submission.

No identifiable animation framework named “Hypegrid” was found. This draft uses Remotion and custom frame-driven animation; it does not claim to use Hypegrid or HyperFrames.

## Credits

- SamWORLD logo: existing project asset supplied in `teawa-b/ViewIn`.
- Video code and room illustrations: authored for this submission.
- Local voice model: Kokoro-82M, via kokoro-onnx; retain upstream licences for redistributed model weights. Model weights are not included.
