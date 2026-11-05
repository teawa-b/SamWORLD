import json
from pathlib import Path
import soundfile as sf
from kokoro_onnx import Kokoro
sc=json.loads(Path('scenes2.json').read_text());k=Kokoro('../models/kokoro.onnx','../models/voices.bin')
for s in sc:
    a,sr=k.create(s['script'],voice='am_michael',speed=1.08,lang='en-us');f=f"v2-{s['id']}.wav";sf.write('public/'+f,a,sr)
    s['audio']=f;s['seconds']=round(len(a)/sr+1.2,2);print(s['id'],s['seconds'],flush=True)
Path('scenes2.json').write_text(json.dumps(sc,indent=1))
