// Original, procedurally rendered sample banks. No external recordings or downloads.
import {KITS} from './core.js';

function taperSampleEnd(samples,sampleRate){
  const fadeLength=Math.min(Math.round(sampleRate*.025),samples.length-1);
  for(let offset=0;offset<fadeLength;offset++){
    const gain=.5-.5*Math.cos(Math.PI*offset/fadeLength);
    samples[samples.length-1-offset]*=gain;
  }
  return samples;
}
// Inharmonic modes and a broad noise burst give crashes a longer wash than open hats.
const crashVoicings={
  tr808:{decay:.46,noise:.58,brightness:.76},
  rock:{decay:.69,noise:.95,brightness:.68},
  hiphop:{decay:.37,noise:.66,brightness:.42},
  breakbeat:{decay:.49,noise:.84,brightness:.56},
  lofi:{decay:.52,noise:.72,brightness:.23}
};
function crashPCM(kit,sampleRate){
  const {decay,noise,brightness}=crashVoicings[kit]||crashVoicings.tr808;
  const {tone,grit}=KITS[kit]||KITS.tr808;
  const data=new Float32Array(Math.ceil(decay*4.8*sampleRate));
  const modes=[487,863,1291,1733,2591,3457,4139]
    .map(frequency=>2*Math.PI*frequency*tone/sampleRate)
    .filter(phaseStep=>phaseStep<Math.PI);
  let seed=58359,low=0,shimmer=0;
  for(let i=0;i<data.length;i++){
    const time=i/sampleRate;
    seed=(1664525*seed+1013904223)>>>0;
    const white=seed/2147483648-1;
    low+=.14*(white-low);
    shimmer+=brightness*(white-low-shimmer);
    let metal=0;
    for(let mode=0;mode<modes.length;mode++){
      metal+=Math.sin(modes[mode]*i+mode)*Math.exp(-time*(1+mode*.32)/decay)/(mode+3);
    }
    const strike=shimmer*noise*(.82*Math.exp(-time/.028)+.54*Math.exp(-time/decay));
    data[i]=Math.tanh((strike+metal*.49)*(1+grit))*.75;
  }
  return taperSampleEnd(data,sampleRate);
}
export function drumPCM(kit,type,sampleRate=22050){if(type==='crash')return crashPCM(kit,sampleRate);let cfg=KITS[kit]||KITS.tr808,duration={kick:.8,snare:.38,open:.55,closed:.10,clap:.32,tom:.55}[type],data=new Float32Array(Math.ceil(duration*sampleRate)),seed=1234567,phase=0,last=0,hp=0,lp=0;const noise=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/2147483648-1};for(let i=0;i<data.length;i++){let t=i/sampleRate,n=noise(),x=0;let rc=kit==='rock',br=kit==='breakbeat',lo=kit==='lofi',hh=kit==='hiphop';if(type==='kick'){let base=(rc?58:br?68:hh?43:49)*cfg.tone;phase+=2*Math.PI*(base+125*Math.exp(-t/(rc?.013:.024)))/sampleRate;let body=Math.sin(phase)*Math.exp(-t/(hh?.19:rc?.12:.22));x=body+.2*Math.sin(phase*2.03)*Math.exp(-t/.05)+n*(rc?.38:.16)*Math.exp(-t/.007);if(hh||lo)x=Math.tanh(x*1.6)*.8}else if(type==='snare'){let high=n-last;last=n;let body=(Math.sin(2*Math.PI*184*cfg.tone*t)+.45*Math.sin(2*Math.PI*329*t))*Math.exp(-t/.045);x=body*.43+high*(rc?.49:br?.58:.42)*Math.exp(-t/(br?.065:rc?.11:.085));x+=n*.15*Math.exp(-t/.004)}else if(type==='open'||type==='closed'){let metal=0;for(let f of [205,304,369,522,540,800])metal+=(Math.sin(2*Math.PI*f*cfg.tone*t)>0?1:-1)/6;let white=metal*.48+n*(rc?.8:.42);hp=.68*(hp+white-last);last=white;x=hp*Math.exp(-t/(type==='open'?(rc?.12:.16):.019))*.58}else if(type==='clap'){let pulses=Math.exp(-t/.008)+(t>.013?Math.exp(-(t-.013)/.009):0)+(t>.028?Math.exp(-(t-.028)/.06):0);x=(n-last)*pulses*.5;last=n}else{phase+=2*Math.PI*(125+100*Math.exp(-t/.02))/sampleRate;x=Math.sin(phase)*Math.exp(-t/.13)+n*.04*Math.exp(-t/.02)}if(br)x=Math.tanh(x*1.45)*.8;if(lo){lp+=.24*(x-lp);x=Math.round(lp*45)/45}data[i]=Math.max(-1,Math.min(1,x))*.8}return taperSampleEnd(data,sampleRate)}
export function pitchedPCM(type,pitch,sampleRate=22050){let f=440*2**((pitch-69)/12),duration=2.6,data=new Float32Array(Math.ceil(sampleRate*duration)),seed=7791;let random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/2147483648-1};let plucked=['bass','pbass','pluck','aguitar','eguitar','fuzzguitar','koto'].includes(type);if(plucked){let n=Math.max(4,Math.floor(sampleRate/f)),ring=new Float32Array(n),color=type==='bass'?.996:type==='koto'?.9925:type==='fuzzguitar'?.999:type==='eguitar'?.998:.995;for(let i=0;i<n;i++)ring[i]=random()*(type==='koto'?Math.sin(Math.PI*i/n):1);let index=0,body=0;for(let i=0;i<data.length;i++){let next=(index+1)%n,value=ring[index];ring[index]=(value+ring[next])*.5*color;index=next;let t=i/sampleRate;body+=.06*(value-body);let x=value*.66;if(type==='bass')x=body*.8+Math.sin(2*Math.PI*f*t)*Math.exp(-t/.55)*.32;else if(type==='pbass'){
  const phase=2*Math.PI*f*t;
  const pickup=body*.62+Math.sin(phase)*.36*Math.exp(-t/.85)
    +Math.sin(2*phase)*.15*Math.exp(-t/.38)+Math.sin(3*phase)*.08*Math.exp(-t/.19);
  x=Math.tanh(pickup*1.45)*.72;
 }else if(type==='fuzzguitar'){
  const sustain=Math.sin(2*Math.PI*f*t)*.22*Math.exp(-t/.85);
  const signal=value*.72+sustain;
  x=(Math.tanh(signal*(signal>=0?12:8))*.59+body*.16)*Math.exp(-t/1.8);
 }else if(type==='aguitar')x+=Math.sin(2*Math.PI*f*2*t)*Math.exp(-t/.18)*.15;else if(type==='eguitar')x=Math.tanh((value+.15*Math.sin(2*Math.PI*f*t)*Math.exp(-t/.5))*2.7)*.55;else if(type==='koto')x+=Math.sin(2*Math.PI*f*2.015*t)*Math.exp(-t/.25)*.24;data[i]=x*Math.min(1,t/.003)}}else{for(let i=0;i<data.length;i++){let t=i/sampleRate,x=0;for(let h=1;h<=(type==='harpsichord'?13:9);h++){let bright=type==='harpsichord',amplitude=1/(h**(bright?1.04:1.55)),decay=Math.exp(-t*(bright?2+h*.18:1.6+h*.48));x+=Math.sin(2*Math.PI*f*h*Math.sqrt(1+(bright?.00001:.00008)*h*h)*t)*amplitude*decay}x+=random()*(type==='harpsichord'?.07:.045)*Math.exp(-t/.008);data[i]=x*(type==='harpsichord'?.32:.42)*Math.min(1,t/.004)}}return taperSampleEnd(data,sampleRate)}
