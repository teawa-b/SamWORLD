import React,{useEffect,useRef,useState} from 'react';
import {continueRender,delayRender,interpolate,staticFile,useCurrentFrame} from 'remotion';
import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import room from './room.json';
const cl={extrapolateLeft:'clamp',extrapolateRight:'clamp'} as const;
const L=room.shell.size.width,D=room.shell.size.depth,H=room.shell.size.height;
const vert=`varying vec3 vW;varying vec2 vUv;void main(){vUv=uv;vec4 w=modelMatrix*vec4(position,1.);vW=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}`;
const frag=`uniform sampler2D A;uniform sampler2D B;uniform float tile;uniform int axis;uniform float sweep;uniform vec3 cam;uniform float flick;varying vec3 vW;varying vec2 vUv;
void main(){vec2 ub=axis==0?vec2(vW.x,vW.y):axis==1?vec2(vW.z,vW.y):vec2(vW.x,vW.z);vec3 a=texture2D(A,vUv).rgb;vec3 b=texture2D(B,ub/tile).rgb;
float d=length(vW-cam);vec3 warm=vec3(1.,.72,.42);float li=(1.35*flick)/(1.+d*d*.18);vec3 hb=b*warm*li+b*.08;hb=mix(hb,vec3(.078,.055,.04),clamp((d-3.2)/7.,0.,.7));
float m=smoothstep(sweep-.25,sweep+.25,vW.x);float e=1.-smoothstep(0.,.18,abs(vW.x-sweep));vec3 c=mix(a,hb,m)+vec3(1.,.6,.25)*e*1.2;gl_FragColor=vec4(c,1.);}`;
const dfrag=`uniform sampler2D B;uniform float sweep;uniform vec3 cam;uniform float flick;varying vec3 vW;varying vec2 vUv;void main(){vec3 b=texture2D(B,vUv).rgb;float d=length(vW-cam);vec3 warm=vec3(1.,.72,.42);float li=(2.1*flick)/(1.+d*d*.12);vec3 hb=b*warm*li+b*.18;hb=mix(hb,vec3(.078,.055,.04),clamp((d-3.2)/7.,0.,.7));float m=smoothstep(sweep-.25,sweep+.25,vW.x);float e=1.-smoothstep(0.,.18,abs(vW.x-sweep));gl_FragColor=vec4(hb+vec3(1.,.6,.25)*e*1.2*m,m);}`;
type Built={r:THREE.WebGLRenderer;s:THREE.Scene;c:THREE.PerspectiveCamera;mats:THREE.ShaderMaterial[];candle:THREE.PointLight;swaps:{x:number;a:THREE.Object3D;b:THREE.Object3D}[]};
let built:Built|null=null;
async function build(w:number,h:number,canvas:HTMLCanvasElement):Promise<Built>{
 const tl=new THREE.TextureLoader();const load=(u:string)=>tl.loadAsync(staticFile(u));
 const [c0,f0,w0,w1,w2,w3,tw,tf,tc]=await Promise.all(['room/ceiling.jpg','room/floor.jpg','room/wall-0.jpg','room/wall-1.jpg','room/wall-2.jpg','room/wall-3.jpg','tex-walls.jpg','tex-floor.jpg','tex-ceiling.jpg'].map(load));
 for(const t of [tw,tf,tc]){t.wrapS=t.wrapT=THREE.RepeatWrapping;t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=8}
 for(const t of [c0,f0,w0,w1,w2,w3])t.colorSpace=THREE.SRGBColorSpace;
 const r=new THREE.WebGLRenderer({canvas,antialias:true,preserveDrawingBuffer:true});r.setSize(w,h,false);r.outputColorSpace=THREE.SRGBColorSpace;
 const s=new THREE.Scene();s.background=new THREE.Color('#0b0806');const c=new THREE.PerspectiveCamera(72,w/h,.05,40);
 const mats:THREE.ShaderMaterial[]=[];
 const plane=(A:THREE.Texture,B:THREE.Texture,tile:number,axis:number,pw:number,ph:number,pos:[number,number,number],rot:[number,number,number])=>{const m=new THREE.ShaderMaterial({vertexShader:vert,fragmentShader:frag,side:THREE.DoubleSide,uniforms:{A:{value:A},B:{value:B},tile:{value:tile},axis:{value:axis},sweep:{value:9},cam:{value:new THREE.Vector3()},flick:{value:1}}});mats.push(m);const g=new THREE.Mesh(new THREE.PlaneGeometry(pw,ph),m);g.position.set(...pos);g.rotation.set(...rot);s.add(g)};
 plane(w0,tw,2,0,L,H,[0,H/2,-D/2],[0,0,0]);
 plane(w2,tw,2,0,L,H,[0,H/2,D/2],[0,Math.PI,0]);
 plane(w1,tw,2,1,D,H,[L/2,H/2,0],[0,-Math.PI/2,0]);
 plane(w3,tw,2,1,D,H,[-L/2,H/2,0],[0,Math.PI/2,0]);
 plane(f0,tf,2,2,L,D,[0,0,0],[-Math.PI/2,0,0]);
 plane(c0,tc,2.5,2,L,D,[0,H,0],[Math.PI/2,0,0]);
 s.add(new THREE.AmbientLight('#ffffff',1.1));const candle=new THREE.PointLight('#ffb45e',3,6,1.5);s.add(candle);
 const gl=new GLTFLoader();const swaps:{x:number;a:THREE.Object3D;b:THREE.Object3D}[]=[];
 const fit=async(file:string,o:any,warm=false)=>{const g=await gl.loadAsync(staticFile('room/'+file));const obj=g.scene;obj.traverse((n:any)=>{if(n.isMesh){const m=n.material;const map=m.map;if(map)map.colorSpace=THREE.SRGBColorSpace;n.material=new THREE.MeshBasicMaterial({map,color:warm?'#ffc890':'#ffffff',side:THREE.DoubleSide})}});const bb=new THREE.Box3().setFromObject(obj);const sz=bb.getSize(new THREE.Vector3());const ctr=bb.getCenter(new THREE.Vector3());const holder=new THREE.Group();obj.position.sub(ctr);holder.add(obj);holder.scale.setScalar(Math.max(o.box.size[0],o.box.size[2])/Math.max(sz.x,sz.y,sz.z));holder.position.set(o.box.centre[0],Math.max(o.box.size[1]/2,.03),o.box.centre[2]);holder.rotation.y=o.box.yaw||0;s.add(holder);return holder};
 for(const o of room.objects as any[]){
  if(o.kind==='surface'){const tex=await load('room/'+o.hlImage);tex.colorSpace=THREE.SRGBColorSpace;const cx=o.box.centre[0],cz=o.box.centre[2];const wd=Math.min(1.1,Math.max(.9,o.box.size[0],o.box.size[2])),ht=Math.min(Math.max(o.box.size[1],2.0),H-.08);
   const opts=[[Math.abs(cz+D/2),0],[Math.abs(cz-D/2),2],[Math.abs(cx-L/2),1],[Math.abs(cx+L/2),3]].sort((a,b)=>a[0]-b[0]);const wall=opts[0][1];
   const m=new THREE.ShaderMaterial({vertexShader:vert,fragmentShader:dfrag,transparent:true,side:THREE.DoubleSide,uniforms:{B:{value:tex},sweep:{value:9},cam:{value:new THREE.Vector3()},flick:{value:1}}});mats.push(m);
   const mesh=new THREE.Mesh(new THREE.PlaneGeometry(wd,ht),m);const e=.015;
   if(wall===0){mesh.position.set(cx,ht/2,-D/2+e)}else if(wall===2){mesh.position.set(cx,ht/2,D/2-e);mesh.rotation.y=Math.PI}else if(wall===1){mesh.position.set(L/2-e,ht/2,Math.max(-D/2+wd/2,Math.min(D/2-wd/2,cz)));mesh.rotation.y=-Math.PI/2}else{mesh.position.set(-L/2+e,ht/2,Math.max(-D/2+wd/2,Math.min(D/2-wd/2,cz)));mesh.rotation.y=Math.PI/2}
   s.add(mesh);continue}
  try{const a=o.model?await fit(o.model,o):new THREE.Group();const b=o.hlModel?await fit(o.hlModel,o,true):a;if(b!==a)b.visible=false;swaps.push({x:o.box.centre[0],a,b})}catch(e){console.log('glb fail',e)}}
 return {r,s,c,mats,candle,swaps};
}
export const Room3D=({len,w=1280,h=720,mode='restyle'}:{len:number;w?:number;h?:number;mode?:'filmed'|'restyle'})=>{
 const f=useCurrentFrame();const ref=useRef<HTMLCanvasElement>(null);const [ready,setReady]=useState(false);const [hd]=useState(()=>delayRender('room3d',{timeoutInMilliseconds:120000}));
 useEffect(()=>{built=null;build(w,h,ref.current!).then(b=>{built=b;setReady(true);continueRender(hd)})},[]);
 useEffect(()=>{if(!ready||!built)return;const b=built;const t=f/len;const sm=(a0:number,b0:number)=>{const u=Math.max(0,Math.min(1,(t-a0)/(b0-a0)));return u*u*(3-2*u)};
  const x=mode==='filmed'?-1.2+2.6*sm(0,1):3.0-4.6*sm(0,.55)+1.6*sm(.72,1);const y=1.58+Math.sin(f/8)*.015;const z=.08+Math.sin(f/45)*.1*(1-sm(.55,.72));
  const yaw=mode==='filmed'?Math.PI+Math.sin(f/45)*.55:Math.sin(f/55)*.22*(1-sm(.5,.6))+Math.PI*sm(.56,.74)+Math.sin(f/40)*.25*sm(.74,1);const pitch=mode==='filmed'?-.22+Math.sin(f/70)*.06:-.07+Math.sin(f/80)*.04;
  b.c.position.set(x,y,z);b.c.lookAt(x-Math.cos(yaw)*Math.cos(pitch),y+Math.sin(pitch),z+Math.sin(yaw)*Math.cos(pitch));
  const sweep=mode==='filmed'?9:interpolate(f,[len*.08,len*.55],[3.6,-3.7],cl);const flick=.9+.1*Math.sin(f*.9)+.06*Math.sin(f*2.3);
  for(const w of b.swaps){const on=sweep<w.x;if(w.a!==w.b){w.a.visible=!on;w.b.visible=on}}
  for(const m of b.mats){m.uniforms.sweep.value=sweep;(m.uniforms.cam.value as THREE.Vector3).set(x,y,z);m.uniforms.flick.value=flick}
  b.candle.position.set(x,y,z);b.candle.intensity=sweep<x?3*flick:0;b.r.render(b.s,b.c)},[f,ready,len,mode]);
 return <canvas ref={ref} width={w} height={h} style={{position:'absolute',inset:0,width:w,height:h}}/>};
