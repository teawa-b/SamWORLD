import React from 'react';
import {interpolate,spring,useCurrentFrame} from 'remotion';
const FPS=30;const META='#0866FF';const cl={extrapolateLeft:'clamp',extrapolateRight:'clamp'} as const;
const CARD='#1f2024',CARD_ON='#141c2b',TXT='#f3f3f1',SUB='#a3a39e';
const at=[.3,2.8,5.4,8.5,12.4,14.2,17.4,20.6];
const Phone=()=> <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="2" width="12" height="20" rx="2.5"/><circle cx="12" cy="18" r=".8" fill="#fff"/></svg>;
const Cube=()=> <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round"><path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/></svg>;
const Walk=()=> <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 9a3 3 0 013-3h14a3 3 0 013 3v4a3 3 0 01-3 3h-3l-2-3h-4l-2 3H5a3 3 0 01-3-3z"/></svg>;
const Card=({on,cur,title,sub,meta,icon,w,h,dark}:{on:boolean;cur:boolean;title:string;sub:string;meta?:boolean;icon?:React.ReactNode;w:number;h:number;dark?:boolean})=>{
 const f=useCurrentFrame();const glow=cur?.6+.4*Math.sin(f/6):0;
 return <div style={{width:w,height:h,borderRadius:22,background:dark?'#06110d':on?CARD_ON:CARD,border:`1.5px solid ${cur?META:on?META+'66':'#2c2d31'}`,boxShadow:cur?`0 0 ${24+16*glow}px ${META}88`:'none',opacity:on?1:.42,transform:`scale(${cur?1.04:1})`,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',textAlign:'center',padding:'0 14px',boxSizing:'border-box',gap:6}}>
  {icon}{meta&&<span style={{background:META,color:'#fff',fontSize:10,fontWeight:800,letterSpacing:1.5,padding:'2px 8px',borderRadius:20}}>META</span>}
  <div style={{fontSize:22,fontWeight:750,color:TXT,letterSpacing:-.3,lineHeight:1.1}}>{title}</div>
  <div style={{fontSize:13.5,color:SUB,lineHeight:1.35}}>{sub}</div></div>};
const Arrow=({on}:{on:boolean})=>{const f=useCurrentFrame();return <div style={{width:30,display:'flex',alignItems:'center',justifyContent:'center',color:on?'#9cc0ff':'#555',fontSize:24,opacity:on?1:.5,transform:`translateX(${on?Math.sin(f/8)*2:0}px)`}}>→</div>};
export const Pipeline=({len}:{len:number})=>{
 const f=useCurrentFrame();const t=f/FPS;const step=at.filter(a=>t>=a).length-1;
 const on=(i:number)=>step>=i;const cur=(i:number)=>step===i;
 const a=spring({frame:f,fps:FPS,config:{damping:18}});
 const H=430,top=175;
 return <div style={{position:'absolute',inset:0}}>
  <div style={{position:'absolute',left:60,top:42,opacity:a}}><div style={{fontSize:15,letterSpacing:3,color:META,fontWeight:700,marginBottom:10}}>THE SAMWORLD PIPELINE</div><div style={{fontSize:46,fontWeight:800,letterSpacing:-2,color:TXT}}>Built on Meta's AI.</div></div>
  <div style={{position:'absolute',left:40,right:40,top,height:H,display:'flex',alignItems:'center',justifyContent:'center'}}>
   <Card on={on(0)} cur={cur(0)} w={150} h={210} icon={<Phone/>} title="Phone video" sub="17 s clip · 25 frames"/>
   <Arrow on={on(1)}/>
   <Card on={on(1)} cur={cur(1)} w={168} h={210} meta title="MapAnything" sub="Metric 3D reconstruction · Modal GPU"/>
   <Arrow on={on(2)}/>
   <div style={{display:'flex',flexDirection:'column',gap:14,position:'relative'}}>
    <div style={{position:'absolute',top:-62,left:0,right:0,display:'flex',justifyContent:'center',opacity:on(3)?1:.35}}><div style={{fontSize:13,color:'#ffd9a8',background:'#2a1d10',border:'1px solid #ff8a3d66',borderRadius:20,padding:'6px 12px',whiteSpace:'nowrap'}}>✎ “a haunted Victorian library” ↓</div></div>
    <Card on={on(2)} cur={cur(2)} w={200} h={150} meta title="SAM 3.1" sub="Segments every object across views"/>
    <Card on={on(3)} cur={cur(3)} w={200} h={150} meta title="Muse Spark" sub="Names objects, reads the room, plans the new world"/>
   </div>
   <Arrow on={on(4)}/>
   <div style={{display:'flex',flexDirection:'column',gap:14}}>
    <Card on={on(4)} cur={cur(4)} w={200} h={150} meta title="Muse Image" sub="Paints walls, floor, ceiling · restyles objects"/>
    <Card on={on(5)} cur={cur(5)} w={200} h={150} meta title="SAM 3D Objects" sub="Turns object images into textured 3D meshes"/>
   </div>
   <Arrow on={on(6)}/>
   <Card on={on(6)} cur={cur(6)} w={172} h={250} dark icon={<Cube/>} meta title="3D world" sub="Room shell · Photo walls · Placed objects · Immersive Web SDK"/>
   <Arrow on={on(7)}/>
   <Card on={on(7)} cur={cur(7)} w={150} h={210} icon={<Walk/>} title="Walk inside" sub="Browser · Quest · Prompt a new location"/>
  </div>
 </div>};
