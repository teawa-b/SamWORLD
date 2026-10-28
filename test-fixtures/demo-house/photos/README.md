# Listing photos

Drop licensed / permission-granted room photos here (`.jpg`, `.jpeg`, `.png`, `.webp`).
They are picked up on the next import of the demo property and, when
`MODEL_API_KEY` is set, sent to Muse Spark for room matching and to SAM 3.1 for
segmentation. Without photos the pipeline marks every room as "no photo
evidence" and uses hand-authored placement suggestions.

Optional: name a file `<roomId>__anything.jpg` (e.g. `L0-living__sofa.jpg`) to
pre-assign it to a room; Muse matching still runs and its answer is shown
alongside.
