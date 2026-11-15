import {DRUM_TYPES,MODELED_INSTRUMENTS,clamp,isTrackAudible,isBassInstrument,trackTriggerPitch,noteOffset,stepOffset} from './core.js';
import {drumPCM,pitchedPCM} from './sounds.js';
export const SAMPLED_TYPES=['bass','pbass','piano','pluck','aguitar','eguitar','fuzzguitar','harpsichord','koto'];
// Internal articulation, independent of saved legacy decay controls.
export function articulation(track){let type=track.type;if(MODELED_INSTRUMENTS[type])return MODELED_INSTRUMENTS[type].envelope;if(DRUM_TYPES.includes(type))return {attack:.001,decay:0,sustain:1,release:.025,oneShot:true};if(SAMPLED_TYPES.includes(type))return {attack:.002,decay:0,sustain:1,release:{piano:.14,bass:.065,pbass:.075,fuzzguitar:.12,harpsichord:.045,koto:.16}[type]||.1};if(type==='organ')return {attack:.003,decay:0,sustain:1,release:.065};if(type==='strings')return {attack:.045,decay:.12,sustain:.8,release:.26};if(type==='flute')return {attack:.018,decay:.08,sustain:.85,release:.12};if(type==='epiano')return {attack:.003,decay:3.5,sustain:0,release:.18};if(type==='vibes')return {attack:.002,decay:4.5,sustain:0,release:.3};return {attack:track.preset==='pad'?.055:.003,decay:.18,sustain:.72,release:track.preset==='pad'?.35:.12}}
export function amplitudeAt(elapsed,env,peak){if(elapsed<=0)return 0;if(elapsed<env.attack)return peak*elapsed/env.attack;if(!env.decay)return peak;return peak*(1+(env.sustain-1)*Math.min(1,(elapsed-env.attack)/env.decay))}
export const filterCutoff=amount=>16000*(220/16000)**amount;
// A fixed soft-clipping curve keeps the maximum output bounded as drive increases.
const overdriveCurve=Float32Array.from({length:1025},(_,index)=>Math.tanh(2.4*(index/512-1))/2.4);
export class StudioAudio{
 constructor(){this.ctx=null;this.voices=new Set();this.samples=new Map();this.channels=new Map();this.getBpm=()=>112;this.getTracks=()=>[];this.isAudible=t=>!t.mute;this.ready=Promise.resolve()}
 setup(volume=.7,offlineContext=null){if(!this.ctx){this.offline=!!offlineContext;this.ctx=offlineContext||new AudioContext({latencyHint:'interactive'});let c=this.ctx;this.master=c.createGain();this.master.gain.value=volume;let limiter=c.createDynamicsCompressor();limiter.threshold.value=-6;limiter.knee.value=3;limiter.ratio.value=12;limiter.attack.value=.003;limiter.release.value=.1;this.master.connect(limiter);limiter.connect(c.destination);this.impulse=c.createBuffer(2,c.sampleRate*.9,c.sampleRate);for(let ch=0;ch<2;ch++){let d=this.impulse.getChannelData(ch);for(let i=0;i<d.length;i++)d[i]=(Math.random()*2-1)*(1-i/d.length)**3}this.makeAir();this.resetReverb();this.ready=this.prepareTracks(this.getTracks())}}
 async prime(volume=.7){this.setup(volume);await this.ready}
 async init(volume=.7){this.setup(volume);let resumed=this.ctx.state==='running'?Promise.resolve():this.ctx.resume();await resumed;await this.ready}
 makeAir(){if(this.airBuffer)return;let c=this.ctx,b=c.createBuffer(1,c.sampleRate,c.sampleRate),d=b.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;this.airBuffer=b}
 resetReverb(){if(!this.ctx)return;this.reverb?.disconnect();this.reverb=this.ctx.createConvolver();this.reverb.buffer=this.impulse;this.reverb.connect(this.master)}
 buffer(type,pitch,kit='tr808'){let key=DRUM_TYPES.includes(type)?kit+':'+type:type+':'+pitch;if(!this.samples.has(key)){let pcm=DRUM_TYPES.includes(type)?drumPCM(kit,type):pitchedPCM(type,pitch),b=this.ctx.createBuffer(1,pcm.length,22050);b.copyToChannel(pcm,0);this.samples.set(key,b);if(this.samples.size>140)this.samples.delete(this.samples.keys().next().value)}return this.samples.get(key)}
 async prepareTrack(track){if(!this.ctx)return;this.channel(track);if(DRUM_TYPES.includes(track.type)){this.buffer(track.type,60,track.kit);return}let type=SAMPLED_TYPES.includes(track.type)?track.type:track.type==='synth'&&track.engine==='pluck'?'pluck':null;if(!type)return;this.buffer(type,60);for(let pitch of [48,72,36,84]){await new Promise(resolve=>setTimeout(resolve,0));this.buffer(type,pitch)}}
 async prepareTracks(tracks){for(let track of tracks)this.channel(track);let unique=new Map();for(let t of tracks)unique.set(DRUM_TYPES.includes(t.type)?t.kit+':'+t.type:t.type==='synth'?t.type+':'+t.engine:t.type,t);for(let track of unique.values())await this.prepareTrack(track)}
 sampleFor(type,pitch,kit){if(DRUM_TYPES.includes(type))return {buffer:this.buffer(type,60,kit),rate:2**((pitch-60)/12)};let root=clamp(Math.round(pitch/12)*12,0,120),b=this.samples.get(type+':'+root);if(!b){let available=[...this.samples.keys()].filter(k=>k.startsWith(type+':')).map(k=>+k.split(':')[1]);root=available.length?available.sort((a,b)=>Math.abs(a-pitch)-Math.abs(b-pitch))[0]:60;b=this.samples.get(type+':'+root)||this.buffer(type,root)}return {buffer:b,rate:2**((pitch-root)/12)}}
 volume(v){if(this.ctx)this.master.gain.setTargetAtTime(v,this.ctx.currentTime,.01)}
 channel(t){if(!this.channels.has(t)){let c=this.ctx,input=c.createGain(),reverbSend=c.createGain(),delaySend=c.createGain(),delayNode=c.createDelay(1),feedback=c.createGain();input.gain.value=t.volume;input.connect(this.master);input.connect(reverbSend);reverbSend.connect(this.reverb);input.connect(delaySend);delaySend.connect(delayNode);delayNode.connect(this.master);delayNode.connect(feedback);feedback.connect(delayNode);feedback.gain.value=.28;reverbSend.gain.value=t.reverb*.55;delaySend.gain.value=t.delay*.48;delayNode.delayTime.value=t.delayTime;const channel={input,reverbSend,delaySend,delayNode,feedback};this.channels.set(t,channel);this.updateInserts(t,channel)}return this.channels.get(t)}
 setTrackVolume(t){const channel=this.channels.get(t);channel?.input.gain.setTargetAtTime(t.volume,this.ctx.currentTime,.008)}
 updateInserts(track,channel){
  const c=this.ctx;
  const useDrive=track.overdrive>0,useFilter=track.filter>0,useCompressor=track.compressor>0;
  if(useDrive!==!!channel.drive||useFilter!==!!channel.filter||useCompressor!==!!channel.compressor){
   channel.input.disconnect();
   channel.drive?.disconnect();
   channel.clipper?.disconnect();
   channel.filter?.disconnect();
   channel.compressor?.disconnect();
   if(!useDrive){
    delete channel.drive;
    delete channel.clipper;
   }else if(!channel.drive){
    channel.drive=c.createGain();
    channel.drive.gain.value=1+track.overdrive*8;
    channel.clipper=c.createWaveShaper();
    channel.clipper.curve=overdriveCurve;
    channel.clipper.oversample='2x';
   }
   if(!useFilter)delete channel.filter;
   else if(!channel.filter){
    channel.filter=c.createBiquadFilter();
    channel.filter.type='lowpass';
    channel.filter.Q.value=.707;
    channel.filter.frequency.value=filterCutoff(track.filter);
   }
   if(!useCompressor)delete channel.compressor;
   else if(!channel.compressor){
    channel.compressor=c.createDynamicsCompressor();
    channel.compressor.ratio.value=4;
    channel.compressor.knee.value=12;
    channel.compressor.attack.value=.008;
    channel.compressor.release.value=.14;
    channel.compressor.threshold.value=-48*track.compressor;
   }
   let source=channel.input;
   for(const insert of [channel.drive,channel.clipper,channel.filter,channel.compressor])if(insert){
    source.connect(insert);
    source=insert;
   }
   source.connect(this.master);
   source.connect(channel.reverbSend);
   source.connect(channel.delaySend);
  }
  channel.drive?.gain.setTargetAtTime(1+track.overdrive*8,c.currentTime,.025);
  channel.filter?.frequency.setTargetAtTime(filterCutoff(track.filter),c.currentTime,.025);
  channel.compressor?.threshold.setTargetAtTime(-48*track.compressor,c.currentTime,.025);
 }
 updateTrack(t){let b=this.channels.get(t);if(!b)return;let now=this.ctx.currentTime;b.reverbSend.gain.setTargetAtTime(t.reverb*.55,now,.02);b.delaySend.gain.setTargetAtTime(t.delay*.48,now,.02);b.delayNode.delayTime.setTargetAtTime(t.delayTime,now,.04);this.updateInserts(t,b)}
 refreshMix(){for(let v of [...this.voices])if(v.track&&!this.isAudible(v.track))v.kill();let changed=false;for(let [t,b]of this.channels)if(!this.isAudible(t)){Object.values(b).forEach(n=>n.disconnect());this.channels.delete(t);changed=true}if(changed){this.resetReverb();for(let b of this.channels.values()){b.reverbSend.disconnect();b.reverbSend.connect(this.reverb)}}}
 stop(){for(let v of [...this.voices])v.kill();for(let b of this.channels.values())Object.values(b).forEach(n=>n.disconnect());this.channels.clear();if(this.ctx&&this.impulse)this.resetReverb()}
 click(time,accent=false,volume=.5){if(volume<=0)return;let c=this.ctx,o=c.createOscillator(),g=c.createGain();o.frequency.value=accent?1400:1000;o.connect(g);g.connect(this.master);g.gain.setValueAtTime(.4*volume,time);g.gain.exponentialRampToValueAtTime(.0001,time+.045);o.start(time);o.stop(time+.05);const cleanup=()=>{o.disconnect();g.disconnect();this.voices.delete(v)};let v={kill:()=>{try{o.stop()}catch{}cleanup()}};this.voices.add(v);o.onended=cleanup}
 play(track,pitch,time,duration=.2,velocity=.8,live=false,expression){if(!this.isAudible(track))return null;let c=this.ctx;if(!c)return null;if(!this.offline&&c.state==='suspended')c.resume().catch(()=>{});if(!this.offline&&this.voices.size>=64)[...this.voices].find(v=>v.track)?.kill();time=Math.max(time,c.currentTime);pitch+=track.pitch??0;let env=articulation(track),sources=[],nodes=[],pitchTargets=[],finished=false,released=false,sourceDuration=0;let g=c.createGain(),filter=c.createBiquadFilter();nodes.push(g,filter);filter.type='lowpass';filter.frequency.value=track.type==='synth'?track.tone:isBassInstrument(track.type)?3200:track.type==='strings'?3400:11000;filter.connect(g);g.connect(this.channel(track).input);let f=440*2**((pitch-69)/12),peak=velocity*.45;
 const trackPitch=source=>{if((live||expression)&&!DRUM_TYPES.includes(track.type)&&source.detune)pitchTargets.push([source.detune,source.detune.value])};
 const osc=(wave,freq,level=1,detune=0)=>{let o=c.createOscillator(),mix=c.createGain();o.type=wave;o.frequency.value=freq;o.detune.value=detune;trackPitch(o);mix.gain.value=level;o.connect(mix);mix.connect(filter);sources.push(o);nodes.push(mix);return o};
 const sampled=type=>{let sample=this.sampleFor(type,pitch,track.kit||'tr808'),source=c.createBufferSource();source.buffer=sample.buffer;source.playbackRate.value=sample.rate;trackPitch(source);source.connect(filter);sourceDuration=sample.buffer.duration/sample.rate;sources.push(source)};
 if(DRUM_TYPES.includes(track.type)){sampled(track.type);peak*=1.4}else if(SAMPLED_TYPES.includes(track.type))sampled(track.type);else if(MODELED_INSTRUMENTS[track.type]){for(const [ratio,level,detune] of MODELED_INSTRUMENTS[track.type].partials)osc('sine',f*ratio,level,detune)}else if(track.type==='epiano'||(track.type==='synth'&&track.engine==='fm')){let carrier=osc('sine',f,.85),mod=c.createOscillator(),index=c.createGain();mod.frequency.value=f*(track.type==='epiano'?2:3);index.gain.setValueAtTime(f*(track.type==='epiano'?.45+velocity*1.4:1.4),time);index.gain.exponentialRampToValueAtTime(f*.04,time+.35);mod.connect(index);index.connect(carrier.frequency);trackPitch(mod);sources.push(mod);nodes.push(index)}else if(track.type==='vibes'){osc('sine',f,.8);osc('sine',f*4,.22);osc('sine',f*10,.035);let trem=c.createOscillator(),depth=c.createGain(),tremGain=c.createGain();tremGain.gain.value=.8;filter.disconnect();filter.connect(tremGain);tremGain.connect(g);trem.frequency.value=5;depth.gain.value=.18;trem.connect(depth);depth.connect(tremGain.gain);sources.push(trem);nodes.push(depth,tremGain)}else if(track.type==='flute'){osc('sine',f,.7);osc('sine',f*2,.14);osc('sine',f*3,.035);this.makeAir();let breath=c.createBufferSource(),air=c.createGain(),bp=c.createBiquadFilter();breath.buffer=this.airBuffer;breath.loop=true;air.gain.value=.035;bp.type='bandpass';bp.frequency.value=f*2;breath.connect(bp);bp.connect(air);air.connect(filter);sources.push(breath);nodes.push(air,bp)}else if(track.type==='organ'){for(let [ratio,level]of [[.5,.17],[1,.55],[2,.26],[3,.18],[4,.08],[6,.035]])osc('sine',f*ratio,level)}else if(track.type==='strings'){osc('sawtooth',f,.2,-9);osc('sawtooth',f,.2,9);osc('triangle',f*.5,.2);let lfo=c.createOscillator(),depth=c.createGain();lfo.frequency.value=5.2;depth.gain.value=3;lfo.connect(depth);sources.slice(0,2).forEach(o=>depth.connect(o.detune));sources.push(lfo);nodes.push(depth)}else if(track.engine==='pluck')sampled('pluck');else if(track.engine==='wavetable'){let real=new Float32Array(12),imag=new Float32Array(12);[1,.35,.19,.1,.05,.03].forEach((v,i)=>imag[i+1]=v);let o=c.createOscillator();o.setPeriodicWave(c.createPeriodicWave(real,imag));o.frequency.value=f;trackPitch(o);o.connect(filter);sources.push(o)}else{osc(track.wave,f,.38,-5);osc(track.wave,f,.38,5);osc('sine',f*.5,.12)}
 // The note-on timeline is complete before sources start. A scheduled note-off never cancels its attack.
 g.gain.setValueAtTime(0,time);let off=env.oneShot?null:live?null:time+Math.max(.005,duration),attackEnd=time+env.attack,decayEnd=attackEnd+env.decay;
 if(off!==null&&off<attackEnd)g.gain.linearRampToValueAtTime(amplitudeAt(off-time,env,peak),off);else{g.gain.linearRampToValueAtTime(peak,attackEnd);if(env.decay){let endpoint=off===null?decayEnd:Math.min(off,decayEnd);if(endpoint>attackEnd)g.gain.linearRampToValueAtTime(amplitudeAt(endpoint-time,env,peak),endpoint)}}
 let vibrato, vibratoDepth;
 const express=({bend=0,mod=0}={},at=c.currentTime)=>{
  if(finished||!pitchTargets.length)return;
  const now=Math.max(time,c.currentTime,at);
  for(const [param,base] of pitchTargets)param.setTargetAtTime(base+bend*200,now,.006);
  if(mod>0&&!vibrato){
   vibrato=c.createOscillator();
   vibratoDepth=c.createGain();
   vibrato.frequency.value=5;
   vibratoDepth.gain.value=0;
   vibrato.connect(vibratoDepth);
   for(const [param] of pitchTargets)vibratoDepth.connect(param);
   vibrato.start(now);
  }
  vibratoDepth?.gain.setTargetAtTime(mod*45,now,.02);
 };
 let cleanup=()=>{if(finished)return;finished=true;voice.noteEnd=Math.min(voice.noteEnd,c.currentTime);if(vibrato){vibrato.stop();vibrato.disconnect();vibratoDepth.disconnect()}for(let o of sources){try{o.stop()}catch{}o.disconnect()}nodes.forEach(n=>n.disconnect());this.voices.delete(voice)};
 const releaseTime=Math.max(.04,env.release);
 const fadeOut=at=>{
  // Approach silence smoothly, then reach exactly zero before disconnecting the voice.
  g.gain.setTargetAtTime(0,at,releaseTime/9);
  g.gain.setValueAtTime(0,at+releaseTime);
  return at+releaseTime+.01;
 };
 const liveRelease=()=>{
  if(finished||released||env.oneShot)return;
  released=true;
  const now=Math.max(time,c.currentTime);
  voice.noteEnd=now;
  g.gain.cancelAndHoldAtTime(now);
  const end=fadeOut(now);
  for(const source of sources){try{source.stop(end)}catch{}}
 };
 let voice={track,noteEnd:off??Infinity,kill:cleanup,release:liveRelease,express};this.voices.add(voice);sources[0].onended=cleanup;
 // Sampled voices can end on their own. Pitch bend can change their real playback duration.
 let end;
 if(off!==null){
  g.gain.setValueAtTime(amplitudeAt(off-time,env,peak),off);
  end=fadeOut(off);
 }else if(!sourceDuration){
  if(env.sustain===0)end=decayEnd+.02;
  else{
   end=time+30;
   g.gain.setTargetAtTime(0,end-.05,.05/9);
   g.gain.setValueAtTime(0,end-.01);
  }
 }
 if(expression)express(expression);
 for(const source of sources){
  source.start(time);
  if(end!==undefined)source.stop(end);
 }
 this.onNote?.(track,pitch,time,velocity,voice);
 return voice;
 }
}

export function playPatternStep(audio,tracks,pattern,bar,step,time){
 const stepDuration=60/bar.tempo/4;
 const offset=position=>noteOffset(position,bar.tempo,bar.swing);
 tracks.forEach((track,index)=>{
  const part=pattern.parts[index];
  if(part.steps[step])audio.play(track,trackTriggerPitch(track.type),time,stepDuration*.8,part.velocities?.[step]??.8);
  for(const note of part.notes){
   if(Math.floor(note.step)!==step)continue;
   const start=offset(note.step);
   const duration=Math.max(.03,offset(note.step+note.length)-start);
   const points=note.expression;
   const voice=audio.play(track,note.pitch,bar.time+start,duration,note.velocity??.8,false,points?.length?{}:undefined);
   for(const point of points??[]){
    if(point.offset<=note.length)voice?.express(point,bar.time+offset(note.step+point.offset));
   }
  }
 });
}

export async function renderSong(project){
 const sampleRate=44100,barDuration=240/project.bpm;
 const patterns=new Map(project.patterns.map(pattern=>[pattern.id,pattern]));
 const context=new OfflineAudioContext(2,Math.ceil((project.song.length*barDuration+1.5)*sampleRate),sampleRate);
 const audio=new StudioAudio();
 audio.getTracks=()=>project.tracks;
 audio.isAudible=track=>isTrackAudible(track,project.tracks);
 audio.setup(project.master,context);
 await audio.ready;
 project.song.forEach((id,index)=>{
  const pattern=patterns.get(id);
  const bar={time:index*barDuration,tempo:project.bpm,swing:project.swing};
  for(let step=0;step<16;step++)playPatternStep(audio,project.tracks,pattern,bar,step,bar.time+stepOffset(step,bar.tempo,bar.swing));
 });
 return context.startRendering();
}
