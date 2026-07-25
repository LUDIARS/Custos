# Unity capture publisher P0

## Scope

- Add the Custos Unity Bridge P0 flow that captures GameView PNGs and sends them to a resolved Concordia session.
- Keep the capture under the OS temp directory, with one retry and bounded cleanup.
- Add the `ICaptureSink` seam and the sole P0 sink, `ConcordiaSessionSink`.

## Explicitly excluded

- P1 editor control endpoints, P2 WebUI/SceneView/WebRTC, P3 Inspector, and P4 `unityctl`.

## Verification

- EditMode tests cover session selection, temp path generation, cleanup selection, and Concordia JSON construction.
- Unity compilation is not run here because Unity 6000.x is unavailable.
