importScripts('./vendor/lame.min.js');

self.onmessage=({data:{left,right,sampleRate}})=>{
 try{
  const encoder=new lamejs.Mp3Encoder(2,sampleRate,192);
  const chunks=[];
  const block=1152;
  for(let start=0;start<left.length;start+=block){
   const count=Math.min(block,left.length-start);
   const l=new Int16Array(count),r=new Int16Array(count);
   for(let i=0;i<count;i++){
    l[i]=Math.round(Math.max(-1,Math.min(1,left[start+i]))*32767);
    r[i]=Math.round(Math.max(-1,Math.min(1,right[start+i]))*32767);
   }
   const chunk=encoder.encodeBuffer(l,r);
   if(chunk.length)chunks.push(chunk);
  }
  chunks.push(encoder.flush());
  self.postMessage({blob:new Blob(chunks,{type:'audio/mpeg'})});
 }catch(error){self.postMessage({error:error.message})}
};
