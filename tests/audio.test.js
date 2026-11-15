import test from 'node:test';
import assert from 'node:assert/strict';
import {StudioAudio,articulation,amplitudeAt} from '../dist/audio.js';
import {makeTrack,INSTRUMENT_GROUPS} from '../dist/core.js';
class Param{constructor(value=0){this.value=value;this.events=[]}setValueAtTime(v,t){this.events.push(['set',v,t])}linearRampToValueAtTime(v,t){this.events.push(['linear',v,t])}exponentialRampToValueAtTime(v,t){this.events.push(['exp',v,t])}setTargetAtTime(v,t){this.events.push(['target',v,t])}cancelAndHoldAtTime(t){this.events.push(['hold',null,t])}}
function fakeContext(){let nodes=[];const node=kind=>{let n={kind,connections:[],gain:new Param(),frequency:new Param(),detune:new Param(),Q:new Param(),ratio:new Param(),knee:new Param(),attack:new Param(),release:new Param(),threshold:new Param(),delayTime:new Param(),playbackRate:new Param(1),stops:[],connect(x){this.connections.push(x)},disconnect(){this.connections=[]},start(t){this.started=t},stop(t){this.stops.push(t)},setPeriodicWave(){}};nodes.push(n);return n};return {nodes,state:'running',currentTime:10,sampleRate:8000,createBuffer:(channels,length,rate)=>{let data=new Float32Array(length);return {duration:length/rate,getChannelData:()=>data,copyToChannel:x=>data.set(x)}},createGain:()=>node('gain'),createBiquadFilter:()=>node('filter'),createOscillator:()=>node('oscillator'),createConstantSource:()=>node('timer'),createBufferSource:()=>node('sample'),createConvolver:()=>node('reverb'),createDelay:()=>node('delay'),createDynamicsCompressor:()=>node('compressor'),createWaveShaper:()=>node('waveshaper'),createPeriodicWave:()=>({})}}
function studio(){let c=fakeContext(),a=new StudioAudio();a.ctx=c;a.master=c.createGain();a.impulse={};a.resetReverb();a.buffer=()=>({duration:2.6});return {a,c}}
test('a short scheduled note has an attack before its note-off and never cancels note-on automation',()=>{let {a,c}=studio(),t=makeTrack('Pad','synth',0);t.preset='pad';a.play(t,60,10,.012,.9,false);let envelope=c.nodes.find(n=>n.gain.events.some(e=>e[0]==='set'&&e[1]===0&&e[2]===10));assert.ok(envelope.gain.events.some(e=>e[0]==='linear'&&e[1]>0&&e[2]===10.012));assert.ok(!envelope.gain.events.some(e=>e[0]==='hold'));assert.ok(c.nodes.filter(n=>n.kind==='oscillator').every(n=>n.started===10))});
test('held organ notes sustain beyond a bar and release without creating or retriggering a source',()=>{let {a,c}=studio(),t=makeTrack('Organ','organ',0);let v=a.play(t,60,10,.2,.8,true),sources=c.nodes.filter(n=>n.kind==='oscillator');assert.ok(sources.every(n=>n.stops[0]===40));let count=c.nodes.length;c.currentTime=10.5;v.release();assert.equal(c.nodes.length,count);assert.ok(sources.every(n=>n.stops.at(-1)<10.6));assert.ok(c.nodes.some(n=>n.gain.events.some(e=>e[0]==='hold'&&e[2]===10.5)));assert.equal(articulation(t).sustain,1)});
test('plucked and piano sounds use their natural samples rather than saved envelope overrides',()=>{for(let type of ['piano','bass','aguitar','eguitar','koto','harpsichord']){let t=makeTrack(type,type,0);Object.assign(t,{attack:1,decay:3,sustain:0,release:3});let env=articulation(t);assert.equal(env.attack,.002);assert.equal(env.sustain,1);assert.ok(env.release<=.2);assert.ok(amplitudeAt(.01,env,1)>.99)}});
test('all melodic instruments start sources on note-on before a live note-off exists',()=>{for(let type of Object.values(INSTRUMENT_GROUPS).flat()){let {a,c}=studio(),t=makeTrack(type,type,0);let v=a.play(t,60,10,.3,.9,true);assert.ok(v,type);assert.ok(c.nodes.filter(n=>n.kind==='sample'||n.kind==='oscillator').every(n=>n.started===10),type);let before=c.nodes.length;c.currentTime=10.4;v.release();assert.equal(c.nodes.length,before,type);a.stop();assert.equal(a.voices.size,0,type)}});
test('prepared sample zones are reused for live notes with no sound generation in the input path',()=>{let {a,c}=studio(),t=makeTrack('Piano','piano',0);a.samples.set('piano:60',{duration:2.6});a.buffer=()=>{throw Error('Live input generated a sample')};a.play(t,67,10,.3,.8,true);let sample=c.nodes.find(n=>n.kind==='sample');assert.ok(Math.abs(sample.playbackRate.value-2**(7/12))<1e-10);assert.equal(sample.started,10)});
test('effect returns are shared per track rather than built for every key press',()=>{let {a,c}=studio(),t=makeTrack('Rhodes','epiano',0);t.reverb=.4;t.delay=.3;a.play(t,60,10,.3,.8,true);a.play(t,64,10,.3,.8,true);assert.equal(a.channels.size,1);assert.equal(c.nodes.filter(n=>n.kind==='reverb').length,1);assert.equal(c.nodes.filter(n=>n.kind==='delay').length,1);a.isAudible=()=>false;a.refreshMix();assert.equal(a.voices.size,0);assert.equal(a.channels.size,0)});
test('live pitch bend and vibrato change held melodic notes without retriggering',()=>{
 const {a,c}=studio(),track=makeTrack('Piano','piano',0);
 const voice=a.play(track,60,10,.3,.8,true,{bend:-1,mod:0});
 const sample=c.nodes.find(node=>node.kind==='sample');
 assert.deepEqual(sample.detune.events.at(-1),['target',-200,10]);
 assert.equal(sample.started,10);
 c.currentTime=10.5;
 voice.express({bend:1,mod:1});
 assert.deepEqual(sample.detune.events.at(-1),['target',200,10.5]);
 const vibrato=c.nodes.find(node=>node.kind==='oscillator');
 assert.equal(vibrato.frequency.value,5);
 assert.deepEqual(vibrato.connections[0].connections,[sample.detune]);
 voice.express({bend:0,mod:0});
 assert.deepEqual(vibrato.connections[0].gain.events.at(-1),['target',0,10.5]);
 voice.kill();
 assert.ok(vibrato.stops.length);
 assert.equal(vibrato.connections.length,0);
});
test('the live mixer adjusts a held track without replacing its voice',()=>{
 const {a,c}=studio(),track=makeTrack('Organ','organ',4);
 track.volume=0;
 const voice=a.play(track,60,10,.3,.8,true);
 const mixer=a.channels.get(track).input.gain;
 assert.equal(mixer.value,0);
 track.volume=.58;
 c.currentTime=10.2;
 a.setTrackVolume(track);
 assert.deepEqual(mixer.events.at(-1),['target',.58,10.2]);
 assert.ok(a.voices.has(voice));
});
test('emergency stop clears held voices, scheduled clicks and effect tails',()=>{
 const {a,c}=studio(),track=makeTrack('Trumpet','trumpet',4);
 track.delay=.7;
 track.reverb=.7;
 const voice=a.play(track,60,10,.3,.8,true,{mod:.5});
 a.click(11);
 const channel=a.channels.get(track),oldReverb=a.reverb;
 assert.ok(a.voices.has(voice));
 assert.equal(a.voices.size,2);
 a.stop();
 assert.equal(a.voices.size,0);
 assert.equal(a.channels.size,0);
 assert.ok(Object.values(channel).every(node=>node.connections.length===0));
 assert.equal(oldReverb.connections.length,0);
 assert.notEqual(a.reverb,oldReverb);
 assert.ok(a.play(track,64,c.currentTime,.3,.8,true));
});
test('sequenced note expression schedules bend and vibrato at future audio times',()=>{
 const {a,c}=studio(),track=makeTrack('Guitar','eguitar',7);
 const voice=a.play(track,60,10.1,.5,.8,false,{});
 voice.express({bend:.5,mod:.6},10.25);
 voice.express({bend:0,mod:0},10.4);
 const sample=c.nodes.find(node=>node.kind==='sample');
 assert.deepEqual(sample.detune.events.slice(-2),[['target',100,10.25],['target',0,10.4]]);
 const vibrato=c.nodes.find(node=>node.kind==='oscillator');
 assert.equal(vibrato.started,10.25);
 assert.deepEqual(vibrato.connections[0].gain.events,[['target',27,10.25],['target',0,10.4]]);
});
test('track pitch transposes drums and melodic notes before expression is applied',()=>{
 const {a,c}=studio();
 const drum=makeTrack('Kick','kick',0);
 drum.pitch=12;
 a.play(drum,60,10);
 assert.equal(c.nodes.find(node=>node.kind==='sample').playbackRate.value,2);
 const organ=makeTrack('Organ','organ',4);
 organ.pitch=-12;
 const voice=a.play(organ,69,10,.3,.8,true);
 voice.express({bend:.5});
 const fundamental=c.nodes.find(node=>node.kind==='oscillator'&&node.frequency.value===220);
 assert.ok(fundamental);
 assert.deepEqual(fundamental.detune.events.at(-1),['target',100,10]);
});
test('track inserts feed the mix and effect sends, and zero bypasses them',()=>{
 const {a}=studio(),track=makeTrack('Kick','kick',0);
 const bus=a.channel(track);
 assert.deepEqual(bus.input.connections,[a.master,bus.reverbSend,bus.delaySend]);
 track.overdrive=.5;
 track.filter=.5;
 track.compressor=.75;
 a.updateTrack(track);
 assert.deepEqual(bus.input.connections,[bus.drive]);
 assert.deepEqual(bus.drive.connections,[bus.clipper]);
 assert.deepEqual(bus.clipper.connections,[bus.filter]);
 assert.equal(bus.clipper.curve[512],0);
 assert.ok(bus.clipper.curve[1024]<.5);
 const clipper=bus.clipper;
 track.overdrive=.75;
 a.updateTrack(track);
 assert.equal(bus.clipper,clipper);
 assert.deepEqual(bus.drive.gain.events.at(-1),['target',7,10]);
 assert.deepEqual(bus.filter.connections,[bus.compressor]);
 assert.deepEqual(bus.compressor.connections,[a.master,bus.reverbSend,bus.delaySend]);
 assert.equal(bus.filter.type,'lowpass');
 assert.equal(bus.compressor.threshold.value,-36);
 track.overdrive=track.filter=track.compressor=0;
 a.updateTrack(track);
 assert.deepEqual(bus.input.connections,[a.master,bus.reverbSend,bus.delaySend]);
 assert.equal(bus.clipper,undefined);
 assert.equal(bus.filter,undefined);
 assert.equal(bus.compressor,undefined);
});

test('scheduled and released notes fade to zero before their sources stop',()=>{
 for(const live of [false,true]){
  const {a,c}=studio(),track=makeTrack('Organ','organ',0);
  const voice=a.play(track,60,10,.25,.8,live);
  if(live){c.currentTime=10.25;voice.release()}
  const envelope=c.nodes.find(node=>node.gain.events.some(event=>event[0]==='set'&&event[1]===0&&event[2]===10));
  const [fade,silence]=envelope.gain.events.slice(-2);
  assert.deepEqual(fade,['target',0,10.25]);
  assert.deepEqual(silence,['set',0,10.25+articulation(track).release]);
  assert.ok(c.nodes.filter(node=>node.kind==='oscillator').every(node=>node.stops.at(-1)>silence[2]));
 }
});

test('held samples can finish at their natural endpoint when pitch bends change playback speed',()=>{
 const {a,c}=studio(),track=makeTrack('Guitar','eguitar',0);
 a.play(track,60,10,.2,.8,true,{bend:-1});
 const sample=c.nodes.find(node=>node.kind==='sample');
 assert.deepEqual(sample.stops,[]);
 assert.deepEqual(sample.detune.events.at(-1),['target',-200,10]);
});
test('visual note timing follows scheduled ends, live release and drum sample completion',()=>{
 const {a,c}=studio(),organ=makeTrack('Organ','organ',4),drum=makeTrack('Kick','kick',0);
 let event;
 a.onNote=(track,pitch,time,velocity,voice)=>{event={time,voice}};
 const scheduled=a.play(organ,60,10.1,.5);
 assert.deepEqual(event,{time:10.1,voice:scheduled});
 assert.equal(scheduled.noteEnd,10.6);
 const held=a.play(organ,60,10,.2,.8,true);
 assert.equal(held.noteEnd,Infinity);
 c.currentTime=10.75;
 held.release();
 assert.equal(held.noteEnd,10.75);
 const oneShot=a.play(drum,60,10.75,.05,.8,true);
 oneShot.release();
 assert.equal(oneShot.noteEnd,Infinity);
 c.currentTime=11.25;
 c.nodes.find(node=>node.kind==='sample').onended();
 assert.equal(oneShot.noteEnd,11.25);
});
