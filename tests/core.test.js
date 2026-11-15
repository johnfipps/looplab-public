import test from 'node:test';
import assert from 'node:assert/strict';
import {freshProject,normalize,stepOffset,nearestStep,midiEventTime,midiRecordPosition,midiNoteLength,writeMidiHit,moveNote,resizeNote,emptyPattern,copy,isMiniLabInput,miniLabMixerTarget,recordNoteExpression} from '../dist/core.js';
test('legacy projects migrate without losing notes or steps',()=>{let old={version:1,title:'Old groove',bpm:123,tracks:freshProject().tracks.map(t=>({...t,steps:Array(16).fill(false),notes:[]}))};old.tracks[0].steps[4]=true;old.tracks[4].notes=[{pitch:60,step:3,length:4}];let p=normalize(old);assert.equal(p.patterns[0].parts[0].steps[4],true);assert.equal(p.patterns[0].parts[4].notes[0].length,4);assert.equal(p.bpm,123);assert.deepEqual(p.song,['p1'])});
test('song order and independent duplicated pattern edits survive round-trip',()=>{let p=freshProject(),b=copy(p.patterns[0]);b.id='p2';b.name='Chorus';p.patterns.push(b);b.parts[0].steps[0]=true;p.song=['p1','p2','p2','p1'];let loaded=normalize(JSON.parse(JSON.stringify(p)));assert.equal(loaded.patterns[0].parts[0].steps[0],false);assert.equal(loaded.patterns[1].parts[0].steps[0],true);assert.deepEqual(loaded.song,p.song)});
test('swing keeps quarter beats and bar length fixed, delays odd steps, and remains monotonic',()=>{for(let bpm of [40,112,240])for(let swing of [0,.5,1]){let prev=-1;for(let s=0;s<=16;s++){let t=stepOffset(s,bpm,swing);assert.ok(t>prev);if(s%4===0)assert.equal(t,s*60/bpm/4);prev=t}assert.equal(stepOffset(16,bpm,swing),240/bpm)}assert.ok(stepOffset(1,120,1)>stepOffset(1,120,0))});
test('MIDI quantization follows swung note positions',()=>{for(let s=0;s<16;s++)assert.equal(nearestStep(stepOffset(s,112,.8)+.001,112,.8),s)});
test('note moves and resizing stay within bar and pitch bounds',()=>{let n={pitch:60,step:10,length:4};assert.deepEqual(moveNote(n,15,100),{pitch:84,step:12,length:4});assert.equal(resizeNote(n,100).length,6);assert.equal(resizeNote(n,-1).length,1);assert.equal(n.step,10)});
test('malformed projects fail and invalid song references are removed',()=>{assert.throws(()=>normalize({tracks:[]}));let p=freshProject();p.song=['missing'];assert.deepEqual(normalize(p).song,['p1']);p.patterns.push(emptyPattern('p1','Duplicate'));assert.throws(()=>normalize(p),/Duplicate/) });
test('custom track identities and mixer settings survive project round-trip',()=>{let p=freshProject();p.tracks[4].name='Deep purple';p.tracks[4].customName=true;p.tracks[4].color='#8345da';p.metronomeVolume=.23;p.midiQuantize=false;let loaded=normalize(JSON.parse(JSON.stringify(p)));assert.equal(loaded.tracks[4].name,'Deep purple');assert.equal(loaded.tracks[4].color,'#8345da');assert.equal(loaded.tracks[4].customName,true);assert.equal(loaded.metronomeVolume,.23);assert.equal(loaded.midiQuantize,false);p.tracks[4].color='invalid';assert.equal(normalize(p).tracks[4].color,freshProject().tracks[4].color)});
test('unquantized MIDI timing survives save and swing conversion',async()=>{let {gridPosition,noteOffset}=await import('../dist/core.js');for(let bpm of [40,112,240])for(let swing of [0,.6,1])for(let position of [.12,1.37,7.8,15.94]){let seconds=noteOffset(position,bpm,swing);assert.ok(Math.abs(gridPosition(seconds,bpm,swing)-position)<1e-10)}let p=freshProject();p.patterns[0].parts[4].notes=[{pitch:60,step:2.38,length:3.71,velocity:.65}];let loaded=normalize(JSON.parse(JSON.stringify(p)));assert.equal(loaded.patterns[0].parts[4].notes[0].step,2.38);assert.equal(loaded.patterns[0].parts[4].notes[0].length,3.71)});
test('pattern colors advance through the spectrum without resetting after deletion or reload',async()=>{let {spectrumColor,takePatternColor}=await import('../dist/core.js');let p=freshProject();assert.equal(p.patterns[0].color,spectrumColor(0));let second=takePatternColor(p),third=takePatternColor(p);assert.equal(second,spectrumColor(1));assert.equal(third,spectrumColor(2));p.patterns[0].color='#345678';let loaded=normalize(JSON.parse(JSON.stringify(p)));assert.equal(loaded.patterns[0].color,'#345678');assert.equal(takePatternColor(loaded),spectrumColor(3));assert.equal(new Set(Array.from({length:12},(_,i)=>spectrumColor(i))).size,12);assert.equal(spectrumColor(12),spectrumColor(0))});
test('older projects get spectrum colors and retain all pattern content',async()=>{let {spectrumColor}=await import('../dist/core.js');let p=freshProject();delete p.nextPatternColor;delete p.patterns[0].color;p.patterns[0].parts[0].steps[7]=true;let b=copy(p.patterns[0]);b.id='p2';p.patterns.push(b);let loaded=normalize(p);assert.equal(loaded.patterns[0].color,spectrumColor(0));assert.equal(loaded.patterns[1].color,spectrumColor(1));assert.equal(loaded.nextPatternColor,2);assert.equal(loaded.patterns[1].parts[0].steps[7],true)});
test('all instruments have a default decay and editable ADSR/FX settings survive loading',async()=>{let {INSTRUMENTS,makeTrack}=await import('../dist/core.js');for(let type of Object.keys(INSTRUMENTS)){let t=makeTrack(type,type,0);assert.ok(t.decay>0);assert.ok(t.sustain>=0&&t.sustain<1);assert.ok(t.attack>0&&t.release>0)}let p=freshProject();Object.assign(p.tracks[3],{attack:.04,decay:.9,sustain:.24,release:.6,reverb:.3,delay:.4,delayTime:.47});let t=normalize(JSON.parse(JSON.stringify(p))).tracks[3];for(let k of ['attack','decay','sustain','release','reverb','delay','delayTime'])assert.equal(t[k],p.tracks[3][k]);delete p.tracks[0].decay;assert.ok(normalize(p).tracks[0].decay>0)});
test('envelope rises to peak then decays to sustain instead of jumping on short notes',async()=>{let {envelopeLevel}=await import('../dist/core.js');let e={attack:.1,decay:.4,sustain:.2};assert.equal(envelopeLevel(0,e),0);assert.equal(envelopeLevel(.05,e),.5);assert.equal(envelopeLevel(.1,e),1);assert.ok(Math.abs(envelopeLevel(.3,e)-.6)<1e-10);assert.ok(Math.abs(envelopeLevel(.8,e)-.2)<1e-10)});
test('HippoHoppo preserves the source groove and gives the demo its own intro and turnaround',async()=>{
  const {demoProject}=await import('../dist/core.js');
  const {hippoHoppo}=await import('../dist/demo-song.js');
  const source=normalize(hippoHoppo);
  const demo=demoProject();
  assert.equal(demo.title,'HippoHoppo');
  assert.equal(demo.mode,'song');
  assert.equal(demo.bpm,94);
  assert.equal(demo.swing,.36);
  assert.equal(demo.song.length,16);
  assert.deepEqual(demo.song.slice(1,-1),source.song.slice(1,-1));
  assert.equal(demo.song[0],'koto-intro');
  assert.equal(demo.song.at(-1),'turnaround');
  for(const original of source.patterns){
    const edited=demo.patterns.find(pattern=>pattern.id===original.id);
    assert.deepEqual(edited.parts.map(part=>part.notes),original.parts.map(part=>part.notes));
    assert.deepEqual(edited.parts.map(part=>part.steps),original.parts.map(part=>part.steps));
  }
  const intro=demo.patterns.find(pattern=>pattern.id===demo.song[0]);
  assert.equal(intro.parts[1].steps.some(Boolean),false);
  assert.ok(intro.parts[5].notes.length);
  const ending=demo.patterns.find(pattern=>pattern.id===demo.song.at(-1));
  assert.deepEqual(ending.parts[0].velocities.slice(12),[.62,.70,.82,.94]);
  assert.ok(ending.parts[6].notes.at(-1).expression.some(point=>point.mod>0));
  assert.deepEqual(normalize(demo),demo);
  demo.patterns[1].parts[5].notes[0].pitch=60;
  assert.notEqual(demoProject().patterns[1].parts[5].notes[0].pitch,60);
});
test('solo and mute combine correctly, including multiple solos',async()=>{let {isTrackAudible}=await import('../dist/core.js'),p=freshProject();assert.ok(p.tracks.every(t=>isTrackAudible(t,p.tracks)));p.tracks[1].solo=true;assert.deepEqual(p.tracks.map(t=>isTrackAudible(t,p.tracks)),[false,true,false,false,false,false,false,false]);p.tracks[3].solo=true;assert.equal(isTrackAudible(p.tracks[3],p.tracks),true);p.tracks[1].mute=true;assert.equal(isTrackAudible(p.tracks[1],p.tracks),false);assert.equal(normalize(p).tracks[3].solo,true)});
test('kit changes populate first four sounds and individual overrides persist',async()=>{let {applyDrumKit,currentKit}=await import('../dist/core.js'),p=freshProject();p.tracks[0].name='Custom kick';p.tracks[0].customName=true;applyDrumKit(p,'rock');assert.equal(currentKit(p),'rock');assert.equal(p.tracks[0].name,'Custom kick');assert.deepEqual(p.tracks.slice(0,4).map(t=>t.type),['kick','snare','closed','crash']);p.tracks[1].kit='amen';assert.equal(currentKit(p),'mixed');let loaded=normalize(JSON.parse(JSON.stringify(p)));assert.equal(loaded.tracks[1].kit,'breakbeat');assert.equal(loaded.tracks[0].kit,'rock');assert.equal(loaded.tracks[4].type,'bass')});
test('Track 4 defaults to a crash while saved open hi-hats still load',()=>{
  const p=freshProject();
  assert.equal(p.tracks[3].type,'crash');
  Object.assign(p.tracks[3],{type:'open',name:'Open hi-hat'});
  const loaded=normalize(p);
  assert.equal(loaded.tracks[3].type,'open');
  assert.equal(loaded.tracks[3].name,'Open hi-hat');
});
test('every kit has a distinct crash with a longer tail than its open hi-hat',async()=>{
  const {KITS}=await import('../dist/core.js');
  const {drumPCM}=await import('../dist/sounds.js');
  const sampleRate=8000;
  const crashes=Object.keys(KITS).map(kit=>{
    const crash=drumPCM(kit,'crash',sampleRate);
    const hat=drumPCM(kit,'open',sampleRate);
    assert.ok(crash.length>hat.length);
    assert.ok(crash.subarray(hat.length).some(sample=>Math.abs(sample)>.015));
    return crash.slice(0,100).join(',');
  });
  assert.equal(new Set(crashes).size,5);
});
test('rendered drum kits are distinct, finite, and decay to silence',async()=>{let {drumPCM}=await import('../dist/sounds.js'),{KITS,DRUM_TYPES}=await import('../dist/core.js');let signatures=[];for(let kit of Object.keys(KITS)){let sig=0;for(let type of DRUM_TYPES){let data=drumPCM(kit,type,8000);assert.ok(data.every(Number.isFinite));assert.ok(data.some(v=>Math.abs(v)>.05));let energy=(a,b)=>data.slice(a,b).reduce((s,v)=>s+v*v,0)/(b-a);assert.ok(energy(0,Math.min(400,data.length/2))>energy(data.length-100,data.length));sig+=data.slice(0,100).reduce((s,v,i)=>s+v*(i+1),0)}signatures.push(sig)}assert.equal(new Set(signatures).size,5)});
test('instrument menu contains exactly twenty melodic sounds and migrates legacy plucks',async()=>{let {INSTRUMENT_GROUPS,INSTRUMENTS}=await import('../dist/core.js');let types=Object.values(INSTRUMENT_GROUPS).flat();assert.equal(types.length,20);assert.equal(new Set(types).size,20);for(let type of ['piano','epiano','aguitar','eguitar','fuzzguitar','bass','pbass','harpsichord','koto'])assert.ok(types.includes(type));assert.ok(types.every(k=>INSTRUMENTS[k]));let p=freshProject();p.tracks[4].type='pluck';p.tracks[4].name='Plucked keys';assert.equal(normalize(p).tracks[4].type,'aguitar')});
test('MiniLab channel 10 pads route independently of selected keyboard instrument',async()=>{let {routeMidiNote,defaultDrumMidi,drumMidiPreset}=await import('../dist/core.js'),p=freshProject(),m=defaultDrumMidi();for(let i=0;i<4;i++){assert.deepEqual(routeMidiNote(m,10,36+i,6,p.tracks),{track:i,pitch:60,pad:true});assert.equal(routeMidiNote(m,10,40+i,6,p.tracks).track,i+4)}assert.deepEqual(routeMidiNote(m,1,36,6,p.tracks),{track:6,pitch:36,pad:false});assert.equal(routeMidiNote(m,10,90,6,p.tracks),null);let gm=drumMidiPreset('gm');assert.equal(routeMidiNote(gm,10,38,6,p.tracks).track,1);assert.equal(routeMidiNote(gm,10,42,6,p.tracks).track,2);assert.equal(routeMidiNote(gm,10,46,6,p.tracks).track,3);m.enabled=false;assert.equal(routeMidiNote(m,10,36,6,p.tracks).track,6)});
test('custom pad learning swaps duplicate notes and persists routing with recorded velocity',async()=>{let {learnDrumNote,defaultDrumMidi}=await import('../dist/core.js'),p=freshProject(),m=defaultDrumMidi();learnDrumNote(m,0,38,9);assert.deepEqual(m.notes,[38,37,36,39,40,41,42,43]);assert.equal(m.channel,9);p.drumMidi=m;p.patterns[0].parts[0].steps[3]=true;p.patterns[0].parts[0].velocities[3]=.42;let loaded=normalize(JSON.parse(JSON.stringify(p)));assert.deepEqual(loaded.drumMidi,m);assert.equal(loaded.patterns[0].parts[0].velocities[3],.42);assert.equal(loaded.patterns[0].parts[0].steps[3],true)});
test('new string instruments produce distinct, bounded modeled samples',async()=>{let {pitchedPCM}=await import('../dist/sounds.js'),hashes=[];for(let type of ['aguitar','eguitar','fuzzguitar','bass','pbass','harpsichord','koto']){let samples=pitchedPCM(type,60,8000);assert.ok(samples.every(v=>Number.isFinite(v)&&Math.abs(v)<2));assert.ok(samples.some(v=>Math.abs(v)>.03));hashes.push(samples.slice(0,300).reduce((sum,x,i)=>sum+x*(i+1),0))}assert.equal(new Set(hashes).size,hashes.length)});

test('saved four-pad MiniLab mappings expand while custom and GM mappings keep their assignments', async () => {
  const {normalizeDrumMidi} = await import('../dist/core.js');
  const saved = {enabled: true, channel: 10, notes: [36, 37, 38, 39]};
  assert.deepEqual(normalizeDrumMidi({...saved, preset: 'minilab'}).notes,
    [36, 37, 38, 39, 40, 41, 42, 43]);
  assert.deepEqual(normalizeDrumMidi({...saved, preset: 'custom'}).notes, saved.notes);
  const gm = {...saved, preset: 'gm', notes: [36, 38, 46, 42]};
  assert.deepEqual(normalizeDrumMidi(gm), gm);
});
test('MiniLab knobs mix all eight tracks and only fader four controls the master',()=>{
 for(const layout of [[74,71,76,77,93,18,19,16],[86,87,89,90,110,111,116,117]]){
  assert.deepEqual(layout.map(miniLabMixerTarget),[0,1,2,3,4,5,6,7]);
 }
 for(const cc of [17,31])assert.equal(miniLabMixerTarget(cc),'master');
 for(const cc of [82,83,85,14,15,30,1,64])assert.equal(miniLabMixerTarget(cc),null);
});
test('MiniLab input detection accepts the note port and excludes auxiliary ports',()=>{
 for(const name of ['MiniLab 3 MIDI','MiniLab3','Arturia MiniLab 3 MIDI 1'])assert.ok(isMiniLabInput(name),name);
 for(const name of ['MiniLab 3 MCU/HUI','MiniLab 3 DIN Thru','MiniLab 3 ALV','MIDIIN3 (MiniLab 3)','Other MIDI'])assert.ok(!isMiniLabInput(name),name);
});
test('note expression survives project round-trip and follows note moves and trims',()=>{
 const project=freshProject(),note={pitch:60,step:2,length:4,velocity:.6};
 recordNoteExpression(note,0,{bend:0,mod:.4});
 recordNoteExpression(note,.5,{bend:.8,mod:.4});
 recordNoteExpression(note,1.5,{bend:0,mod:.9});
 recordNoteExpression(note,1.52,{bend:0,mod:0});
 project.patterns[0].parts[4].notes.push(note);
 const saved=normalize(JSON.parse(JSON.stringify(project))).patterns[0].parts[4].notes[0];
 assert.deepEqual(saved.expression,[{offset:0,bend:0,mod:.4},{offset:.5,bend:.8,mod:.4},{offset:1.52,bend:0,mod:0}]);
 assert.deepEqual(moveNote(saved,8,64).expression,saved.expression);
 assert.deepEqual(resizeNote(saved,1).expression,saved.expression.slice(0,2));
});

test('MIDI timing uses the incoming event timestamp, even if its handler runs late',()=>{
 const context={currentTime:4.1,getOutputTimestamp:()=>({contextTime:4,performanceTime:2000})};
 assert.equal(midiEventTime(context,1980,2040),3.98);
 delete context.getOutputTimestamp;
 assert.equal(midiEventTime(context,2000,2050),4.05);
 assert.equal(midiEventTime(context,0,2050),4.1);
});

test('MIDI recording gives the first downbeat a pickup window and resolves swung bar boundaries',()=>{
 const first={time:5,tempo:120,swing:.4,early:.055};
 const next={time:7,tempo:120,swing:.4};
 const bars=[first,next];
 for(const quantized of [true,false]){
  assert.equal(midiRecordPosition(bars,4.91,quantized),null);
  assert.deepEqual(midiRecordPosition(bars,4.955,quantized),{bar:first,step:0});
  assert.deepEqual(midiRecordPosition(bars,6.98,quantized),{bar:next,step:0});
  const finalHit=midiRecordPosition(bars,6.92,quantized);
  assert.equal(finalHit.bar,first);
  assert.equal(Math.floor(finalHit.step),15);
 }
 assert.equal(midiRecordPosition(bars,6.962,true).bar,next);
 assert.equal(midiRecordPosition(bars,6.962,false).bar,first);
 assert.equal(midiRecordPosition(bars,7.04,true).step,0);
 assert.ok(midiRecordPosition(bars,7.04,false).step>0);
});

test('same-step MIDI repeats retain separate keyboard and pad hits with raw velocity',()=>{
 for(const pad of [true,false]){
  const bar={time:2,tempo:120,swing:0};
  const part=emptyPattern('midi','MIDI').parts[0];
  const pitch=pad?60:64;
  for(const [delay,value] of [[0,24],[.024,100],[.045,123]]){
   const time=bar.time+delay;
   const position=midiRecordPosition([bar],time,true);
   writeMidiHit(part,{...position,time,pitch,velocity:value/127,pad,quantized:true});
  }
  const notes=part.notes;
  assert.equal(notes.length,pad?2:3);
  assert.deepEqual(pad?[part.velocities[0],...notes.map(n=>n.velocity)]:notes.map(n=>n.velocity),[24/127,100/127,123/127]);
  assert.ok(notes.at(-1).step>notes[0].step&&notes.at(-1).step<1);
  assert.ok(midiNoteLength(bar,0,.028)<1);
 }
});
