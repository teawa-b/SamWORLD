import React from 'react';
import {AbsoluteFill,Audio,Composition,Img,Sequence,interpolate,registerRoot,spring,staticFile,useCurrentFrame,useVideoConfig} from 'remotion';
import scenes from './scenes.json';
const C={ink:'#22232a',paper:'#f5f1e9',orange:'#eb7834',muted:'#797970',line:'#d8d3c8',green:'#395c4d'};
const frames=scenes.map(s=>Math.ceil(s.seconds*30));
const total=frames.reduce((a,b)=>a+b,0);
const clamp={extrapolateLeft:'clamp',extrapolateRight:'clamp'} as const;
type V=[number,number,number];
const Room=({mode=0,phase=1,scan=false,labels=false,zoom=1}:{mode?:number;phase?:number;scan?:boolean;labels?:boolean;zoom?:number})=>{
 const f=useCurrentFrame();const yaw=-.58+Math.sin(f/180)*.09;
 const p=([x,y,z]:V)=>{let a=(x-2.4)*Math.cos(yaw)+(z-2)*Math.sin(yaw),b=-(x-2.4)*Math.sin(yaw)+(z-2)*Math.cos(yaw);return [335+a*80*zoom,330+b*32*zoom-y*86*zoom]};
 const face=(points:V[],fill:string,key:string,stroke='#373b3840')=><polygon key={key} points={points.map(q=>p(q).join(',')).join(' ')} fill={fill} stroke={stroke} strokeWidth={1}/>;
 const box=(x:number,y:number,z:number,w:number,h:number,d:number,col:string,key:string)=>{
  const corners:V[]=[[x,y,z],[x+w,y,z],[x+w,y+h,z],[x,y+h,z],[x,y,z+d],[x+w,y,z+d],[x+w,y+h,z+d],[x,y+h,z+d]];
  return <g key={key}>{face([corners[4],corners[5],corners[6],corners[7]],col,key+'a')}{face([corners[1],corners[5],corners[6],corners[2]],col,key+'b')}{face([corners[3],corners[2],corners[6],corners[7]],col,key+'c')}{face([corners[0],corners[1],corners[2],corners[3]],col,key+'d')}</g>
 };
 const library=mode===1,water=mode===2;
 const wall=library?'#415a4b':water?'#397b82':'#ded9cb';const floor=library?'#a3744a':water?'#b7cfc1':'#c8b799';
 let elements:React.ReactNode[]=[];
 elements.push(face([[0,0,0],[4.8,0,0],[4.8,0,4],[0,0,4]],floor,'floor'));
 for(let i=0;i<17;i++)elements.push(face([[i*.3,.002,0],[i*.3,.002,4]],'#aa9785','line'+i,'#715b4325'));
 elements.push(face([[0,0,0],[4.8,0,0],[4.8,2.7,0],[0,2.7,0]],wall,'back'));
 elements.push(face([[0,0,0],[0,0,4],[0,2.7,4],[0,2.7,0]],wall,'left'));
 elements.push(box(.3,.05,.15,1.35,2.1,.35,library?'#724b31':'#aa9274','shelf'));
 for(let j=0;j<4;j++){
  elements.push(box(.35,.28+j*.47,.13,1.25,.055,.4,library?'#c89e67':'#dcc9aa','shelfbar'+j));
  for(let k=0;k<7;k++)elements.push(box(.41+k*.15,.36+j*.47,.15,.1,.25+((j+k)%3)*.045,.23,["#7c7956","#ac713d","#826158","#415953"][(k+j)%4],'book'+j+'-'+k));
 }
 elements.push(box(2.7,0,.55,1.7,.4,.9,library?'#274538':water?'#538e8c':'#9dada8','sofa-base'));
 elements.push(box(2.65,.37,.53,1.8,.55,.18,library?'#304b39':water?'#438b8c':'#acb7b0','sofa-back'));
 elements.push(box(2.65,.37,.53,.16,.35,.95,library?'#304b39':'#9faeaa','sofa-arm1'));
 elements.push(box(4.29,.37,.53,.16,.35,.95,library?'#304b39':'#9faeaa','sofa-arm2'));
 elements.push(box(2.5,.0,2.1,1.5,.07,1.1,library?'#9e6c43':water?'#61a69a':'#b8afa1','rug'));
 elements.push(box(2.82,.08,2.25,.92,.42,.58,library?'#623c27':'#b09b7f','table'));
 elements.push(box(2.75,.5,2.2,1.07,.06,.7,library?'#a4764a':'#d5b68a','tabletop'));
 elements.push(face([[2.3,1.1,.015],[3.6,1.1,.015],[3.6,2.2,.015],[2.3,2.2,.015]],library?'#d5ae71':water?'#78c2c3':'#e8edf0','window','#f2e6d4'));
 elements.push(face([[2.95,1.1,.01],[2.95,2.2,.01]],'none','windowline','#f2e6d4'));
 if(library)for(let i=0;i<7;i++)elements.push(face([[0,.2+i*.34,.01],[4.8,.2+i*.34,.01]],'none','trim'+i,'#b79b6033'));
 const label=(text:string,q:V)=>{const [x,y]=p(q);return <g key={text}><rect x={x-8} y={y-28} width={text.length*7.8+22} height={28} rx={14} fill={C.ink}/><text x={x+3} y={y-10} fill="white" fontSize="13" fontFamily="Arial">{text}</text></g>};
 return <svg width="100%" height="100%" viewBox="0 0 670 450"><defs><filter id="shadow"><feGaussianBlur stdDeviation="12"/></filter><clipPath id="roomReveal"><rect width={670*phase} height="450"/></clipPath></defs><ellipse cx="335" cy="380" rx="210" ry="26" fill="#292820" opacity=".12" filter="url(#shadow)"/><g clipPath="url(#roomReveal)" opacity={scan?.25:1}>{elements}</g>{scan&&<g>{Array.from({length:720},(_,i)=>{const x=(Math.sin(i*12.998)*43758.5453)%1;let q:V=[Math.abs(x)*4.8,Math.abs(Math.sin(i*3.7))*2.7,(i%3===0?0:Math.abs(Math.sin(i*1.81))*4)];const [a,b]=p(q);return <circle key={i} cx={a} cy={b} r={1.1} fill={i%6===0?C.orange:C.green} opacity={.25+Math.abs(Math.sin(i+f/25))*.5}/>})}</g>}{labels&&<>{label('bookshelf',[.6,2.4,.4])}{label('sofa',[3.4,1.3,1])}{label('table',[3,.8,2.7])}</>}</svg>
};
const Badge=({children,dark=false}:{children:React.ReactNode;dark?:boolean})=><span style={{display:'inline-flex',padding:'8px 13px',borderRadius:20,border:'1px solid '+(dark?'#ffffff30':C.line),fontSize:14,letterSpacing:1,textTransform:'uppercase',color:dark?'#e4dfd4':C.muted}}>{children}</span>;
const Card=({title,sub,i=0}:{title:string;sub:string;i?:number})=>{const f=useCurrentFrame();const a=spring({frame:f-i*7,fps:30,config:{damping:22}});return <div style={{padding:24,background:'#ffffffa0',border:'1px solid '+C.line,borderRadius:20,transform:`translateY(${(1-a)*35}px)`,opacity:a}}><div style={{fontSize:13,color:C.orange,marginBottom:15,fontWeight:700}}>0{i+1}</div><div style={{fontSize:26,fontWeight:650,letterSpacing:-.8}}>{title}</div><div style={{fontSize:17,color:C.muted,marginTop:12,lineHeight:1.45}}>{sub}</div></div>};
const Shot=({index}:{index:number})=>{
 const f=useCurrentFrame(); const s=scenes[index]; const a=spring({frame:f,fps:30,config:{damping:24}}); const end=frames[index]; const opacity=interpolate(f,[0,12,end-12,end],[0,1,1,0],clamp);
 const sentence=s.script.split(/(?<=[.!?])\s+/);const words=sentence.map(x=>x.split(' ').length);const current=Math.min(sentence.length-1,Math.floor(f/(Math.max(1,end-51))*sentence.length));
 const section=['THE IDEA','THE STARTING POINT','UNDERSTAND THE ROOM','THE CREATIVE MOMENT','MAKE IT SPATIAL','UNDER THE HOOD','THE EXPERIENCE','THE AMBITION'][index];
 return <AbsoluteFill style={{background:C.paper,color:C.ink,fontFamily:'Arial, sans-serif',opacity}}>
  <div style={{position:'absolute',inset:0,backgroundImage:'linear-gradient(#504d4408 1px,transparent 1px),linear-gradient(90deg,#504d4408 1px,transparent 1px)',backgroundSize:'44px 44px',maskImage:'linear-gradient(90deg,transparent,#000)'}}/>
  <div style={{position:'absolute',top:22,left:38,right:38,display:'flex',justifyContent:'space-between',alignItems:'center'}}><Img src={staticFile('brand.png')} style={{width:163,height:52,objectFit:'contain',mixBlendMode:'multiply'}}/><div style={{fontSize:12,letterSpacing:2,color:C.muted}}>SHROOZY / META AI HACKATHON</div><Badge>{section}</Badge></div>
  <div style={{position:'absolute',left:48,top:110,right:48,transform:`translateY(${(1-a)*25}px)`}}>
   {index===0?<><div style={{fontSize:14,letterSpacing:3,color:C.orange,marginBottom:28}}>BUILD FOR YOUR WORLD</div><div style={{fontSize:90,fontWeight:750,letterSpacing:-5,lineHeight:.97,width:610}}>Your room.<br/><span style={{color:C.orange}}>Any world.</span></div><div style={{fontSize:22,color:C.muted,marginTop:28,width:370,lineHeight:1.5}}>A familiar space.<br/>A different reality.</div><div style={{position:'absolute',right:-55,top:6,width:720,height:440,transform:`translateY(${Math.sin(f/45)*6}px)`}}><Room mode={f>170?1:0}/></div></>:
   index===1?<><h1 style={{fontSize:46,letterSpacing:-2,margin:'0 0 24px'}}>Start with your surroundings.</h1><div style={{display:'flex',gap:28}}><div style={{width:620,height:365,background:'#e7e1d5',borderRadius:24,position:'relative',overflow:'hidden'}}><Room/><div style={{position:'absolute',left:22,top:20}}><Badge>Room capture</Badge></div><div style={{position:'absolute',right:24,bottom:24,width:14,height:14,background:C.orange,borderRadius:50,opacity:Math.sin(f/10)>.1?1:.35}}/></div><div style={{flex:1,display:'grid',gap:17,alignContent:'center'}}><Card i={0} title="Film a short video" sub="Walk around the room. Capture its surfaces and furniture."/><Card i={1} title="Or upload photos" sub="Start with ordinary images. No 3D modelling tools."/></div></div></>:
   index===2?<><h1 style={{fontSize:46,letterSpacing:-2,margin:0}}>A room becomes a space.</h1><div style={{position:'absolute',left:-45,top:60,width:770,height:405}}><Room scan={f<210} labels={f>=210}/></div><div style={{position:'absolute',right:0,top:95,width:405,display:'grid',gap:16}}><Card i={0} title="MapAnything" sub="Geometry · camera poses · depth"/><Card i={1} title="Muse + SAM 3.1" sub="Understand objects and where they belong"/></div></>:
   index===3?<><h1 style={{fontSize:46,letterSpacing:-2,margin:0}}>Type a world.</h1><div style={{position:'absolute',left:0,top:82,width:430}}><div style={{fontSize:16,color:C.muted,marginBottom:16}}>What should your room become?</div><div style={{fontSize:31,fontWeight:600,lineHeight:1.3,padding:25,borderRadius:20,background:'white',border:'1px solid '+C.line,minHeight:130}}>{'A haunted Victorian library'.slice(0,Math.floor(f/2))}<span style={{color:C.orange,opacity:f%30<18?1:0}}>|</span></div><div style={{marginTop:24,fontSize:18,color:C.green,lineHeight:1.5}}>A plan for each surface.<br/>A new appearance for each object.<br/>Your room as the spatial anchor.</div></div><div style={{position:'absolute',right:-30,top:50,width:730,height:420}}><Room mode={f>150?1:0} phase={f>150?interpolate(f,[150,210],[0,1],clamp):1}/></div></>:
   index===4?<><h1 style={{fontSize:46,letterSpacing:-2,margin:0}}>From pixels to objects.</h1><div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:20,marginTop:45}}><Card i={0} title="Muse Image" sub="Generate materials and restyle object crops."/><Card i={1} title="SAM 3D" sub="Turn selected images into 3D assets."/><Card i={2} title="Place & reveal" sub="Bring each result back into the room."/></div><div style={{display:'flex',gap:14,marginTop:32,alignItems:'center'}}>{['Walls','Floor','Ceiling','Furniture'].map((v,i)=><div key={v} style={{flex:1,borderRadius:14,background:i*65<f?'#395c4d':'#e6e0d5',color:i*65<f?'white':C.muted,padding:24,fontSize:24,transition:'none'}}>{i*65<f?'✓ ':''}{v}</div>)}</div></>:
   index===5?<><h1 style={{fontSize:46,letterSpacing:-2,margin:0}}>Built as a real pipeline.</h1><div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:18,marginTop:32}}><Card i={0} title="Saved scans & restyles" sub="Reuse captures and cache expensive results."/><Card i={1} title="Bounded queues" sub="Separate image generation and 3D reconstruction."/><Card i={2} title="GPU reconstruction" sub="MapAnything worker deployment on Modal."/><Card i={3} title="Provider adapters" sub="SAM 3D: Modal endpoint or fal. Current deployment: fal."/></div></>:
   index===6?<><h1 style={{fontSize:46,letterSpacing:-2,margin:0}}>Explore. Reimagine. Repeat.</h1><div style={{position:'absolute',left:-45,top:60,width:810,height:410}}><Room mode={f>300?2:1} zoom={1+Math.sin(f/120)*.05}/></div><div style={{position:'absolute',right:5,top:108,width:355}}><div style={{fontSize:30,letterSpacing:-1,lineHeight:1.4}}>From an overview<br/>to being inside.</div><div style={{marginTop:30,fontSize:18,lineHeight:1.7,color:C.muted}}>Three.js spatial viewer<br/>Meta Immersive Web SDK<br/>WebXR integration for Quest</div><div style={{marginTop:30}}><Badge>Same scan. New prompt.</Badge></div></div></>:
   <><div style={{display:'flex',justifyContent:'center',marginTop:4}}><Img src={staticFile('brand.png')} style={{width:425,height:135,objectFit:'contain',mixBlendMode:'multiply'}}/></div><div style={{textAlign:'center',fontSize:55,fontWeight:700,letterSpacing:-2,lineHeight:1.1,marginTop:25}}>Make creating a world<br/>feel as natural as <span style={{color:C.orange}}>describing one.</span></div><div style={{display:'flex',justifyContent:'center',gap:15,marginTop:30}}><Badge>Tiwa Bakre / Shroozy</Badge><Badge>Build for Your World</Badge></div><div style={{textAlign:'center',marginTop:24,fontSize:17,color:C.muted}}>Hackathon prototype · Capture quality and generation affect results</div></>}
  </div>
  <div style={{position:'absolute',bottom:106,left:48,right:48,borderTop:'1px solid '+C.line,paddingTop:11,display:'flex',justifyContent:'space-between',fontSize:11,letterSpacing:1.1,color:C.muted}}><span>ILLUSTRATED WORKFLOW • NOT LIVE SCREEN CAPTURE</span><span>{String(index+1).padStart(2,'0')} / 08</span></div>
  <div style={{position:'absolute',bottom:24,left:80,right:80,fontSize:22,lineHeight:1.35,textAlign:'center',height:64,display:'flex',alignItems:'center',justifyContent:'center',color:'#4e5049'}}>{sentence[current]}</div>
  <div style={{position:'absolute',bottom:0,left:0,height:3,width:`${100*f/end}%`,background:C.orange}}/>
  <Audio src={staticFile(s.audio)}/>
 </AbsoluteFill>
};
const Film=()=>{let start=0;return <AbsoluteFill>{scenes.map((s,i)=>{const x=start;start+=frames[i];return <Sequence key={i} from={x} durationInFrames={frames[i]}><Shot index={i}/></Sequence>})}</AbsoluteFill>};
registerRoot(()=> <Composition id="SamWorld" component={Film} durationInFrames={total} fps={30} width={1280} height={720}/>);
