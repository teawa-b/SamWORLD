import json
from pathlib import Path
import soundfile as sf
from kokoro_onnx import Kokoro
scenes=json.loads(Path('scenes.json').read_text())
k=Kokoro('../models/kokoro.onnx','../models/voices.bin')
for i,s in enumerate(scenes):
    audio,sr=k.create(s['script'],voice='af_heart',speed=1.05,lang='en-us')
    sf.write(f'public/voice-{i}.wav',audio,sr)
    d=len(audio)/sr
    s['audio']=f'voice-{i}.wav'; s['duration']=d; s['seconds']=round(d+1.4,2)
    print(i,round(d,1),flush=True)
Path('scenes.json').write_text(json.dumps(scenes,indent=1))
print('TOTAL',sum(x['seconds'] for x in scenes))
