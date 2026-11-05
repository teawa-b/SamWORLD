import React,{useEffect,useRef,useState} from 'react';
import {continueRender,delayRender,interpolate,staticFile,useCurrentFrame} from 'remotion';
let cache:Float32Array|null=null;
const cl={extrapolateLeft:'clamp',extrapolateRight:'clamp'} as const;
export const Inside=({len,w=1280,h=720}:{len:number;w?:number;h?:number})=>{
 const f=useCurrentFrame();const ref=useRef<HTMLCanvasElement>(null);const [data,setData]=useState<Float32Array|null>(cache);const [handle]=useState(()=>cache?null:delayRender('cloud'));
 useEffect(()=>{if(cache)return;fetch(staticFile('inside.bin')).then(r=>r.arrayBuffer()).then(b=>{cache=new Float32Array(b);setData(cache);if(handle!==null)continueRender(handle)})},[handle]);
 useEffect(()=>{if(!data)return;const ctx=ref.current!.getContext('2d')!;
  const t=f/len;const ease=t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2;
  const cz=interpolate(ease,[0,1],[-3.0,1.4]);const cx=.25+Math.sin(f/50)*.08;const cy=-.55+Math.sin(f/9)*.012;
  const yaw=Math.sin(f/70)*.32+interpolate(f,[len*.45,len*.55,len*.65],[0,.55,0],cl);const pitch=-.05+Math.sin(f/90)*.04;
  const sweep=interpolate(f,[len*.12,len*.62],[-3.2,4.5],cl);
  const cyw=Math.cos(yaw),syw=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);const fo=w*.55;
  const n=data.length/9;const xs=new Float32Array(n),ys=new Float32Array(n),zs=new Float32Array(n),ord:number[]=[];
  for(let i=0;i<n;i++){const o=i*9;let x=data[o]-cx,y=data[o+1]-cy,z=data[o+2]-cz;const x1=x*cyw-z*syw,z1=x*syw+z*cyw;const y2=y*cp-z1*sp,z2=y*sp+z1*cp;if(z2<.12||z2>9)continue;const u=w/2+x1/z2*fo,v=h/2+y2/z2*fo;if(u<-20||u>w+20||v<-20||v>h+20)continue;xs[i]=u;ys[i]=v;zs[i]=z2;ord.push(i)}
  ord.sort((a,b)=>zs[b]-zs[a]);
  const g=ctx.createLinearGradient(0,0,0,h);g.addColorStop(0,'#07080b');g.addColorStop(1,'#0d0f14');ctx.fillStyle=g;ctx.fillRect(0,0,w,h);
  for(const i of ord){const o=i*9;const m=Math.max(0,Math.min(1,(sweep-data[o+2])/.6));const z=zs[i];const fog=Math.max(.25,1-z/9);
   let r=data[o+3]+(data[o+6]-data[o+3])*m,gg=data[o+4]+(data[o+7]-data[o+4])*m,b=data[o+5]+(data[o+8]-data[o+5])*m;
   const edge=Math.abs(sweep-data[o+2])<.12?1:0;if(edge){r=1;gg=.72;b=.38}
   ctx.fillStyle=`rgb(${r*255*fog|0},${gg*255*fog|0},${b*255*fog|0})`;const s=Math.min(7,1.5+4.5/z);ctx.fillRect(xs[i]-s/2,ys[i]-s/2,s,s)}
  const vg=ctx.createRadialGradient(w/2,h/2,h*.3,w/2,h/2,h*.9);vg.addColorStop(0,'#0000');vg.addColorStop(1,'#000c');ctx.fillStyle=vg;ctx.fillRect(0,0,w,h);
 },[f,data,len,w,h]);
 return <canvas ref={ref} width={w} height={h} style={{position:'absolute',inset:0}}/>};
