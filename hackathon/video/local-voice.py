import json,os
from pathlib import Path
import soundfile as sf
import onnxruntime as ort
from kokoro_onnx import Kokoro
scenes=[(x['title'],x['script']) for x in json.loads(Path('scenes.json').read_text())]
opts=ort.SessionOptions();opts.intra_op_num_threads=4;opts.inter_op_num_threads=1
session=ort.InferenceSession('../models/kokoro.onnx',sess_options=opts,providers=['CPUExecutionProvider'])
k=Kokoro.from_session(session,'../models/voices.bin')
out=[]
for i,(title,script) in enumerate(scenes):
 audio,sr=k.create(script,voice='bf_emma',speed=1.06,lang='en-gb')
 sf.write(f'public/voice-{i}.wav',audio,sr)
 dur=len(audio)/sr
 out.append({'title':title,'script':script,'audio':f'voice-{i}.wav','duration':dur,'seconds':round(dur+1.7,2),'bounds':[]})
 Path('scenes.json').write_text(json.dumps(out,indent=2))
 print(i,round(dur,1),flush=True)
print('TOTAL',sum(x['seconds'] for x in out))
