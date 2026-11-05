# SamWORLD — Shroozy

Track: Build Your World.

- Theme: Build for Your World.
- Developer: Tiwa Bakre.
- Source repository: https://github.com/teawa-b/SamWORLD.
- Live app: https://frontend-production-9b6d.up.railway.app/
- Video: video/SamWORLD_Hackathon.mp4, ~1:53, 1280 × 720, H.264 + AAC. Remotion, narration by Kokoro-82M TTS (voice af_heart).

## Project description

SamWORLD turns a room you already know into a world you can explore. Film a short walk around your room, upload the video or photos, then type a world: a haunted Victorian library, an underwater coral cave, or a retro arcade. The application reconstructs the space, identifies its furniture, and uses the prompt to restyle surfaces and objects while keeping their relationship to the original room.

Built by Tiwa Bakre at Shroozy, the project brings AI world creation to people who do not use 3D modelling tools. Instead of starting with a blank scene, you start with your own surroundings. The goal is a creative space you can explore on a screen and, through the Meta Immersive Web SDK/WebXR integration, step inside on Quest.

The implementation combines Meta MapAnything reconstruction, Muse reasoning, SAM 3.1 segmentation, Muse Wonder planning, Muse Image texture and object restyling, and SAM 3D object reconstruction. The backend stores scans and restyles, caches expensive results, tracks progress per element, and applies bounded concurrency and model-call budgets. The viewer supports the original scan, reconstructed room surfaces, object selection, and progressive restyling.

This is a hackathon prototype: reconstruction quality depends on capture coverage, missing geometry may be estimated, and generation can take time. The video is an illustrated workflow rather than a live screen recording.

## Meta products

- MapAnything: geometry, camera poses and depth from video frames; GPU worker deployed on Modal.
- Muse Spark: room understanding and structured restyling plans.
- Muse Wonder: turns the typed world into a structured plan for every surface and object.
- SAM 3.1: segmentation of objects in captured frames, subsequently lifted into the room geometry.
- Muse Image: surface textures and object image restyling.
- SAM 3D Objects: selected image crops into 3D assets. Hosted on my own Modal GPU worker (worker-3d/).
- Meta Immersive Web SDK / WebXR: spatial viewer integration for Quest.

## Why Meta models matter

SamWORLD needs models that connect what a camera sees with what a person imagines. Meta's models separate the work: MapAnything supplies spatial evidence; Muse turns a creative request into a structured plan; SAM 3.1 isolates objects; Muse Image creates a new appearance; and SAM 3D brings selected objects back into three dimensions. The original room provides the spatial anchor for the generated world.

Together these components support a workflow from ordinary phone footage to a personalised, explorable environment, with the familiar layout of the user's own room. Meta's Immersive Web SDK connects the browser experience to Quest. Open-weight reconstruction models also support custom GPU deployment on Modal.

## Partner feedback (139 characters)

Modal makes custom GPU reconstruction deployable behind an API. Cold starts and model setup need planning; caching helps avoid repeat work.

